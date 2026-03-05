import { test, expect } from "bun:test";
import { parseChunk, serializeChunk, updateFrontmatterField } from "./frontmatter.ts";
import type { ChunkFrontmatter } from "@/types/index.ts";

test("parseChunk trims parsed content", () => {
  const raw = "---\nfl_id: abc\n---\n  spaced content  \n\n";
  const parsed = parseChunk(raw);
  expect(parsed.content).toBe("spaced content");
  expect(parsed.frontmatter.fl_id).toBe("abc");
});

test("serialize and parse preserves frontmatter and content", () => {
  const fm = {
    fl_id: "id-1",
    fl_type: "journal",
    fl_narrative: "delta-1",
    fl_prev: null,
    fl_status: null,
    fl_topics: ["x", "y"],
    fl_convergence: null,
    fl_theta: null,
    fl_magnitude: null,
    fl_created_at: new Date().toISOString(),
    fl_embedding_model: "model",
  } as ChunkFrontmatter;

  const roundtrip = serializeChunk(fm, "payload");
  const parsed = parseChunk(roundtrip);

  expect(parsed.frontmatter.fl_id).toBe(fm.fl_id);
  expect(parsed.content).toBe("payload");
  expect((parsed.frontmatter as any).fl_narrative).toBe("delta-1");
});

test("updateFrontmatterField updates and preserves content", () => {
  const raw = "---\na: 1\n---\nbody";
  const updated = updateFrontmatterField(raw, { b: 2 });
  const parsed = parseChunk(updated);
  expect(parsed.frontmatter).toMatchObject({ a: 1, b: 2 });
  expect(parsed.content).toBe("body");
});
