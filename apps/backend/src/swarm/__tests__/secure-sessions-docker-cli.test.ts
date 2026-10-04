

import { afterEach, describe, expect, it, vi } from "vitest";
import { DockerCli } from "../secure-sessions/execution/docker-cli.js";

describe("DockerCli", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    "ssh://builder@example.test",
  ])("rejects non-local Docker endpoint %s", async (dockerHost) => {
    const invocations: string[][] = [];
    const cli = new DockerCli({
      command: process.execPath,
      environment: { DOCKER_HOST: dockerHost },
      platform: "linux",
      onInvocation: ({ args }) => invocations.push([...args]),
    });

    await expect(cli.pinLocalEndpoint()).resolves.toBe(false);
    expect(invocations).toEqual([]);
  });

  it("pins an accepted Unix endpoint into later Docker argv", async () => {
    const invocations: string[][] = [];
    const endpoint = "unix:///tmp/forge-test-docker.sock";
    const cli = new DockerCli({
      command: process.execPath,
      environment: { DOCKER_HOST: endpoint },
      platform: "linux",
      onInvocation: ({ args }) => invocations.push([...args]),
    });

    await expect(cli.pinLocalEndpoint()).resolves.toBe(true);
    await cli.run(["-e", "process.exit(0)"]);
    expect(invocations).toEqual([
      ["--host", endpoint, "-e", "process.exit(0)"],
    ]);
  });

  it.each([
    "npipe:////./pipe/dockerDesktopLinuxEngine",
  ])(
    "pins an accepted local Docker Desktop named pipe on Windows: %s",
    async (endpoint) => {
      const invocations: string[][] = [];
      const cli = new DockerCli({
        command: process.execPath,
        environment: { DOCKER_HOST: endpoint },
        platform: "win32",
        onInvocation: ({ args }) => invocations.push([...args]),
      });

      await expect(cli.pinLocalEndpoint()).resolves.toBe(true);
      await cli.run(["-e", "process.exit(0)"]);
      expect(invocations).toEqual([
        ["--host", endpoint, "-e", "process.exit(0)"],
      ]);
    },
  );

  it.each([
    "npipe:////./pipe/dockerDesktopWindowsEngine",
  ])(
    "rejects an unrecognized Windows Docker endpoint: %s",
    async (endpoint) => {
      const invocations: string[][] = [];
      const cli = new DockerCli({
        command: process.execPath,
        environment: { DOCKER_HOST: endpoint },
        platform: "win32",
        onInvocation: ({ args }) => invocations.push([...args]),
      });

      await expect(cli.pinLocalEndpoint()).resolves.toBe(false);
      expect(invocations).toEqual([]);
    },
  );
});
