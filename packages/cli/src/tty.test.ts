import { expect, test } from "bun:test";
import { setJsonOutput } from "./output.ts";
import { createDraft, createSpinner, isInteractiveOutputEnabled } from "./tty.ts";

function withPatchedStdout<T>(opts: { isTTY: boolean }, run: (writes: string[]) => T): T {
  const writes: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalIsTTY = process.stdout.isTTY;

  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  Object.defineProperty(process.stdout, "isTTY", {
    value: opts.isTTY,
    configurable: true,
  });

  try {
    return run(writes);
  } finally {
    process.stdout.write = originalWrite;
    Object.defineProperty(process.stdout, "isTTY", {
      value: originalIsTTY,
      configurable: true,
    });
  }
}

test("interactive output is disabled in json mode even on a TTY", () => {
  withPatchedStdout({ isTTY: true }, () => {
    setJsonOutput(true);
    expect(isInteractiveOutputEnabled()).toBe(false);
    setJsonOutput(false);
  });
});

test("spinner does not render transient output when not interactive", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };

  try {
    const writes = withPatchedStdout({ isTTY: false }, (captured) => {
      const spinner = createSpinner("Working...").start();
      spinner.succeed("Done");
      return captured;
    });

    expect(writes.join("")).not.toContain("Working...");
    expect(logs.join("")).toContain("Done");
  } finally {
    console.log = originalLog;
  }
});

test("draft writes transient updates when interactive", () => {
  const writes = withPatchedStdout({ isTTY: true }, (captured) => {
    setJsonOutput(false);
    const draft = createDraft();
    const line = draft.addLine("phase 1");
    line.update("phase 2");
    draft.clear();
    return captured;
  });

  expect(writes.join("")).toContain("phase 1");
  expect(writes.join("")).toContain("phase 2");
});
