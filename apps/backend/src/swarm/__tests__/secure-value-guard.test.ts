import { Buffer } from "node:buffer";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  SECURE_OUTPUT_QUARANTINE,
  SecureValueGuard,
  SecureValueGuardError,
} from "../secure-sessions/redaction/secure-value-guard.js";

const SELECTIVE_VALUE = Buffer.from("A9!xy_Z-42+/Qm", "utf8");
const MARKER = Buffer.from(SECURE_OUTPUT_QUARANTINE, "utf8");

function collect(
  guard: SecureValueGuard,
  chunks: readonly Uint8Array[],
): Buffer {
  const stream = guard.createStream();
  const output: Uint8Array[] = [];
  for (let index = 0; index < chunks.length - 1; index += 1) {
    output.push(stream.write(chunks[index] ?? Buffer.alloc(0)));
  }
  output.push(stream.end(chunks.at(-1) ?? Buffer.alloc(0)));
  return Buffer.concat(output.map((part) => Buffer.from(part)));
}

function twoChunks(input: Uint8Array, split: number): Uint8Array[] {
  return [input.subarray(0, split), input.subarray(split)];
}

function expectGuardError(
  operation: () => unknown,
  code: SecureValueGuardError["code"],
): void {
  try {
    operation();
    throw new Error("Expected operation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(SecureValueGuardError);
    expect((error as SecureValueGuardError).code).toBe(code);
  }
}

describe("SecureValueGuard byte streams", () => {
  it("quarantines a value split across stdout and stderr in emission order", () => {
    const guard = new SecureValueGuard([SELECTIVE_VALUE]);
    const guardOutput = guard.createOutputGuard<"stdout" | "stderr">();
    const midpoint = Math.floor(SELECTIVE_VALUE.byteLength / 2);
    const output = [
      guardOutput({
        stream: "stdout",
        bytes: Buffer.concat([
          Buffer.from("safe/", "utf8"),
          SELECTIVE_VALUE.subarray(0, midpoint),
        ]),
        final: false,
      }),
      guardOutput({
        stream: "stderr",
        bytes: SELECTIVE_VALUE.subarray(midpoint),
        final: false,
      }),
      guardOutput({
        stream: "stdout",
        bytes: Buffer.alloc(0),
        final: true,
      }),
      guardOutput({
        stream: "stderr",
        bytes: Buffer.alloc(0),
        final: true,
      }),
    ];

    expect(Buffer.concat(output.map(Buffer.from))).toEqual(
      Buffer.concat([Buffer.from("safe/", "utf8"), MARKER]),
    );
    expect(guardOutput.didQuarantine()).toBe(true);
  });
});

describe("SecureValueGuard variants", () => {
  it("detects bounded standard encodings", () => {
    const text = 'A9!/"π?Z_x-42';
    const value = Buffer.from(text, "utf8");
    const guard = new SecureValueGuard([value]);
    const base64 = value.toString("base64");
    const base64Url = value.toString("base64url");
    const variants = new Set([
      base64,
      base64.replace(/=+$/u, ""),
      base64Url,
      base64Url.padEnd(Math.ceil(base64Url.length / 4) * 4, "="),
      value.toString("hex"),
      value.toString("hex").toUpperCase(),
      encodeURIComponent(text),
      encodeURIComponent(text).replaceAll("%20", "+"),
      encodeURIComponent(text).replace(/%[0-9A-F]{2}/gu, (match) =>
        match.toLowerCase()),
      JSON.stringify(text).slice(1, -1),
      'A9!/\\"\\u03c0?Z_x-42',
    ]);

    for (const variant of variants) {
      const bytes = Buffer.from(variant, "utf8");
      for (let split = 0; split <= bytes.byteLength; split += 1) {
        expect(collect(guard, twoChunks(bytes, split))).toEqual(MARKER);
      }
    }
  });
});

describe("SecureValueGuard one-shot sanitization", () => {
  it("quarantines an entire structure for a value in a nested string or key", () => {
    const guard = new SecureValueGuard([SELECTIVE_VALUE]);
    expect(
      guard.sanitizeStructured({
        safe: ["prefix", { nested: `before${SELECTIVE_VALUE.toString("utf8")}after` }],
      }),
    ).toBe(SECURE_OUTPUT_QUARANTINE);
    expect(
      guard.sanitizeStructured({
        [`key-${SELECTIVE_VALUE.toString("utf8")}`]: "safe",
      }),
    ).toBe(SECURE_OUTPUT_QUARANTINE);
  });
});

describe("SecureValueGuard registration and lifecycle policy", () => {
  it("blocks serialization and fails closed after disposal", () => {
    const guard = new SecureValueGuard([SELECTIVE_VALUE]);
    const stream = guard.createStream();

    expectGuardError(
      () => JSON.stringify(guard),
      "SECURE_VALUE_SERIALIZATION_BLOCKED",
    );
    expect(inspect(guard)).toBe("[SecureValueGuard]");
    expect(inspect(stream)).toBe("[SecureValueStreamGuard]");

    guard.dispose();
    expectGuardError(
      () => guard.sanitizeString("safe"),
      "SECURE_VALUE_GUARD_DISPOSED",
    );
    expectGuardError(
      () => stream.write(Buffer.from("safe", "utf8")),
      "SECURE_VALUE_STREAM_CLOSED",
    );
  });
});
