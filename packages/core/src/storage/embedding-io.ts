export interface EmbeddingFile {
  model: string;
  dim: number;
  embedding: Float32Array;
}

/**
 * Derive the .emb sidecar path from a .md chunk path.
 * foo/01J123.md -> foo/01J123.emb
 */
export function embeddingFilePath(chunkFilePath: string): string {
  return chunkFilePath.replace(/\.md$/, ".emb");
}

/**
 * Write an embedding sidecar file with self-describing binary header.
 *
 * Format:
 *   [2 bytes] header_len (uint16 LE) — length of JSON header
 *   [header_len bytes] JSON header: { "model": "...", "dim": N }
 *   [dim * 4 bytes] raw Float32Array (little-endian)
 */
export async function writeEmbeddingFile(
  filePath: string,
  model: string,
  embedding: Float32Array,
): Promise<void> {
  const header = JSON.stringify({ model, dim: embedding.length });
  const headerBytes = new TextEncoder().encode(header);

  const buf = new Uint8Array(2 + headerBytes.length + embedding.byteLength);
  const view = new DataView(buf.buffer);

  // Header length (uint16 LE)
  view.setUint16(0, headerBytes.length, true);

  // JSON header
  buf.set(headerBytes, 2);

  // Raw embedding bytes
  buf.set(
    new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength),
    2 + headerBytes.length,
  );

  await Bun.write(filePath, buf);
}

/**
 * Read an embedding sidecar file. Returns null if file doesn't exist.
 */
export async function readEmbeddingFile(filePath: string): Promise<EmbeddingFile | null> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) return null;

  const buf = new Uint8Array(await file.arrayBuffer());
  if (buf.length < 2) return null;

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const headerLen = view.getUint16(0, true);

  if (buf.length < 2 + headerLen) return null;

  const headerJson = new TextDecoder().decode(buf.slice(2, 2 + headerLen));
  const header = JSON.parse(headerJson) as { model: string; dim: number };

  const embeddingStart = 2 + headerLen;
  const expectedBytes = header.dim * 4;
  if (buf.length < embeddingStart + expectedBytes) return null;

  // Copy to aligned buffer for Float32Array
  const embBuf = new ArrayBuffer(expectedBytes);
  new Uint8Array(embBuf).set(buf.slice(embeddingStart, embeddingStart + expectedBytes));
  const embedding = new Float32Array(embBuf);

  return { model: header.model, dim: header.dim, embedding };
}

/**
 * Delete an .emb sidecar file if it exists.
 */
export async function deleteEmbeddingFile(filePath: string): Promise<boolean> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) return false;
  const { unlink } = await import("fs/promises");
  await unlink(filePath);
  return true;
}
