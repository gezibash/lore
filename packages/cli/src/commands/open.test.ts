import { expect, test } from "bun:test";
import type { WorkerClient } from "@lore/worker";
import { openCommand } from "./open.ts";

test("openCommand rejects unsupported dangling close action", async () => {
  const client = {
    open: async () => {
      throw new Error("should not reach worker open");
    },
  } as unknown as WorkerClient;

  await expect(
    openCommand(client, "auth-debug", "Investigate auth regression", "old:close"),
  ).rejects.toThrow("Close is a separate command");
});
