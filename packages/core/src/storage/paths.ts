import { join } from "path";
import { mkdir, readdir } from "fs/promises";

export function mainDir(lorePath: string): string {
  return join(lorePath, "main");
}

export function deltaDir(lorePath: string, deltaName: string): string {
  return join(lorePath, "delta", deltaName);
}

export function journalDir(lorePath: string, deltaName: string): string {
  return join(lorePath, "delta", deltaName, "journal");
}

export function stateChunkFile(lorePath: string, id: string): string {
  return join(mainDir(lorePath), `${id}.md`);
}

export function journalChunkFile(lorePath: string, deltaName: string, id: string): string {
  return join(journalDir(lorePath, deltaName), `${id}.md`);
}

export function sourceDir(lorePath: string): string {
  return join(lorePath, "src");
}

export function sourceChunkFile(lorePath: string, id: string): string {
  return join(sourceDir(lorePath), `${id}.md`);
}

export function docsDir(lorePath: string): string {
  return join(lorePath, "docs");
}

export function docChunkFile(lorePath: string, id: string): string {
  return join(docsDir(lorePath), `${id}.md`);
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function listChunkFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

export async function listDeltaDirs(lorePath: string): Promise<string[]> {
  const deltaRoot = join(lorePath, "delta");
  try {
    const entries = await readdir(deltaRoot, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}
