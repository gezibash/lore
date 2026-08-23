import { resolve as resolvePath } from "path";

/**
 * Read source lines from disk at query time.
 * Returns the content between lineStart and lineEnd (1-indexed, inclusive), or null on error.
 */
export async function readSymbolContent(
  codePath: string,
  filePath: string,
  lineStart: number,
  lineEnd: number,
): Promise<string | null> {
  const absolutePath = filePath.startsWith("/") ? filePath : resolvePath(codePath, filePath);
  try {
    const text = await Bun.file(absolutePath).text();
    const lines = text.split("\n");
    const from = Math.max(0, lineStart - 1);
    const to = Math.min(lines.length - 1, lineEnd - 1);
    return lines.slice(from, to + 1).join("\n");
  } catch {
    return null;
  }
}

/**
 * Get the current HEAD commit SHA for a git workspace.
 */
export async function getHeadSha(codePath: string): Promise<string | null> {
  try {
    const result = await Bun.$`git -C ${codePath} rev-parse HEAD`.quiet();
    return result.stdout.toString().trim() || null;
  } catch {
    return null;
  }
}
