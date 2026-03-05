import { test, expect } from "bun:test";
import { chunkMarkdown } from "./chunker.ts";
import { defaultConfig } from "@/config/index.ts";

test("chunkMarkdown preserves headings outside code fences only", () => {
  const text = [
    "# Intro",
    "This is base context.",
    "",
    "This line should stay with Intro.",
    "",
    "```",
    "# Inside Fence",
    "const x = 1;",
    "```",
    "",
    "# Chapter",
    "Chapter body is concise.",
    "",
  ].join("\n");

  const chunks = chunkMarkdown(text, {
    ...defaultConfig,
    chunking: { ...defaultConfig.chunking, target_tokens: 1000, overlap: 0.2 },
  });

  expect(chunks.length).toBeGreaterThan(0);
  const allHeadings = chunks.flatMap((chunk) => chunk.headings);

  expect(allHeadings).toContain("Intro");
  expect(allHeadings).toContain("Chapter");
  expect(allHeadings.some((heading) => heading.includes("Inside Fence"))).toBe(false);
});

test("chunkMarkdown overlaps trailing lines when splitting", () => {
  const text = `# Intro\na\nb\n# Mid\nc\nd\n# End\ne\nf`;
  const chunks = chunkMarkdown(text, {
    ...defaultConfig,
    chunking: { ...defaultConfig.chunking, target_tokens: 2, overlap: 0.5 },
  });

  expect(chunks.length).toBeGreaterThanOrEqual(2);
  const joined = chunks.map((c) => c.content);
  expect(joined[1]).toContain("b");
});

test("chunkMarkdown handles empty input", () => {
  const chunks = chunkMarkdown("", {
    ...defaultConfig,
    chunking: { target_tokens: 10, overlap: 0.2 },
  });
  expect(chunks).toEqual([]);
});
