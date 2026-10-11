import { createReadStream } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import type { ProviderConversationRef } from "@forge/protocol";

/** Leave header creation to SessionManager.open, before the core's first canonical append. */
export async function preparePiSessionJournal(sessionFile: string, conversation?: ProviderConversationRef): Promise<void> {
  if (!conversation) {
    await mkdir(dirname(sessionFile), { recursive: true });
    const file = await open(sessionFile, "a");
    await file.close();
    return;
  }

  // A durable locator must already exist. Never create a missing journal or rotate it away.
  const stream = createReadStream(sessionFile, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    const first = await lines[Symbol.asyncIterator]().next();
    const header = first.done ? undefined : JSON.parse(first.value) as { type?: string; id?: string };
    if (header?.type !== "session" || header.id !== conversation.nativeId) {
      throw new Error("Pi conversation locator does not match the existing native journal.");
    }
  } catch (error) {
    throw new Error("Unable to resume the Pi conversation journal for the requested locator.", { cause: error });
  } finally {
    lines.close();
    stream.destroy();
  }
}
