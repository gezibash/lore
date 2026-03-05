import { describe, expect, test } from "bun:test";
import { computeLineDiff, isDiffTooLarge } from "./line-diff.ts";

describe("computeLineDiff", () => {
  test("identical texts produce no hunks", () => {
    const text = "line 1\nline 2\nline 3";
    expect(computeLineDiff(text, text)).toEqual([]);
  });

  test("simple addition", () => {
    const old = "line 1\nline 2\nline 3";
    const new_ = "line 1\nline 2\nnew line\nline 3";
    const hunks = computeLineDiff(old, new_);
    expect(hunks.length).toBe(1);
    const addLines = hunks[0]!.lines.filter((l) => l.type === "add");
    expect(addLines.length).toBe(1);
    expect(addLines[0]!.text).toBe("new line");
  });

  test("simple removal", () => {
    const old = "line 1\nline 2\nline 3";
    const new_ = "line 1\nline 3";
    const hunks = computeLineDiff(old, new_);
    expect(hunks.length).toBe(1);
    const removeLines = hunks[0]!.lines.filter((l) => l.type === "remove");
    expect(removeLines.length).toBe(1);
    expect(removeLines[0]!.text).toBe("line 2");
  });

  test("modification (remove + add)", () => {
    const old = "line 1\nold line\nline 3";
    const new_ = "line 1\nnew line\nline 3";
    const hunks = computeLineDiff(old, new_);
    expect(hunks.length).toBe(1);
    const types = hunks[0]!.lines.map((l) => l.type);
    expect(types).toContain("add");
    expect(types).toContain("remove");
  });

  test("respects context lines", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const old = lines.join("\n");
    const newLines = [...lines];
    newLines[10] = "changed line 11";
    const new_ = newLines.join("\n");

    const hunks = computeLineDiff(old, new_, 2);
    expect(hunks.length).toBe(1);
    // Should have context around the change, not all 20 lines
    expect(hunks[0]!.lines.length).toBeLessThan(10);
  });

  test("multiple separate changes produce multiple hunks", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const old = lines.join("\n");
    const newLines = [...lines];
    newLines[2] = "changed line 3";
    newLines[17] = "changed line 18";
    const new_ = newLines.join("\n");

    const hunks = computeLineDiff(old, new_, 1);
    expect(hunks.length).toBe(2);
  });

  test("empty old text (all additions)", () => {
    const hunks = computeLineDiff("", "line 1\nline 2");
    expect(hunks.length).toBe(1);
    const addLines = hunks[0]!.lines.filter((l) => l.type === "add");
    expect(addLines.length).toBeGreaterThan(0);
  });

  test("empty new text (all removals)", () => {
    const hunks = computeLineDiff("line 1\nline 2", "");
    expect(hunks.length).toBe(1);
    const removeLines = hunks[0]!.lines.filter((l) => l.type === "remove");
    expect(removeLines.length).toBeGreaterThan(0);
  });
});

describe("isDiffTooLarge", () => {
  test("small texts are not too large", () => {
    expect(isDiffTooLarge("a\nb\nc", "a\nb\nc\nd")).toBe(false);
  });

  test("large texts are flagged", () => {
    const big = Array.from({ length: 501 }, (_, i) => `line ${i}`).join("\n");
    expect(isDiffTooLarge(big, "small")).toBe(true);
    expect(isDiffTooLarge("small", big)).toBe(true);
  });
});
