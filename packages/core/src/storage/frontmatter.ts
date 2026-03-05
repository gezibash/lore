import matter from "gray-matter";
import type { ChunkFrontmatter } from "@/types/index.ts";

export function parseChunk<T extends ChunkFrontmatter = ChunkFrontmatter>(
  raw: string,
): { frontmatter: T; content: string } {
  const { data, content } = matter(raw);
  return { frontmatter: data as T, content: content.trim() };
}

export function serializeChunk(frontmatter: ChunkFrontmatter, content: string): string {
  return matter.stringify(content, frontmatter);
}

export function updateFrontmatterField(raw: string, updates: Record<string, unknown>): string {
  const { data, content } = matter(raw);
  Object.assign(data, updates);
  return matter.stringify(content, data);
}
