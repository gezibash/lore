import { readFile } from "fs/promises";
import { basename } from "path";
import { parseChunk } from "./frontmatter.ts";
import { mainDir, journalDir, listChunkFiles, listDeltaDirs } from "./paths.ts";
import type {
  ParsedChunk,
  StateChunkFrontmatter,
  JournalChunkFrontmatter,
  ChunkFrontmatter,
} from "@/types/index.ts";

export async function readChunk<T extends ChunkFrontmatter = ChunkFrontmatter>(
  filePath: string,
): Promise<ParsedChunk<T>> {
  const raw = await readFile(filePath, "utf-8");
  const { frontmatter, content } = parseChunk<T>(raw);
  return { frontmatter, content, filePath };
}

export async function readAllMainChunks(
  lorePath: string,
): Promise<ParsedChunk<StateChunkFrontmatter>[]> {
  const files = await listChunkFiles(mainDir(lorePath));
  const chunks: ParsedChunk<StateChunkFrontmatter>[] = [];
  for (const file of files) {
    chunks.push(await readChunk<StateChunkFrontmatter>(file));
  }
  return chunks;
}

export async function readAllJournalChunks(
  lorePath: string,
  deltaName: string,
): Promise<ParsedChunk<JournalChunkFrontmatter>[]> {
  const files = await listChunkFiles(journalDir(lorePath, deltaName));
  const chunks: ParsedChunk<JournalChunkFrontmatter>[] = [];
  for (const file of files) {
    chunks.push(await readChunk<JournalChunkFrontmatter>(file));
  }
  return chunks;
}

export interface LoreScan {
  stateChunks: ParsedChunk<StateChunkFrontmatter>[];
  journalChunks: Map<string, ParsedChunk<JournalChunkFrontmatter>[]>;
}

export async function scanLore(lorePath: string): Promise<LoreScan> {
  const stateChunks = await readAllMainChunks(lorePath);
  const journalChunks = new Map<string, ParsedChunk<JournalChunkFrontmatter>[]>();

  const deltaNames = await listDeltaDirs(lorePath);
  for (const name of deltaNames) {
    const chunks = await readAllJournalChunks(lorePath, name);
    if (chunks.length > 0) {
      journalChunks.set(name, chunks);
    }
  }

  return { stateChunks, journalChunks };
}

export function chunkIdFromPath(filePath: string): string {
  return basename(filePath, ".md");
}
