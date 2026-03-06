export { parseChunk, serializeChunk, updateFrontmatterField } from "./frontmatter.ts";
export {
  mainDir,
  narrativeDir,
  journalDir,
  stateChunkFile,
  journalChunkFile,
  sourceDir,
  sourceChunkFile,
  ensureDir,
  listChunkFiles,
  listNarrativeDirs,
} from "./paths.ts";
export {
  writeStateChunk,
  writeJournalChunk,
  writeSourceChunk,
  deleteSourceChunkFile,
  markSuperseded,
  updateChunkFrontmatter,
} from "./chunk-writer.ts";
export type {
  WriteStateChunkOpts,
  WriteJournalChunkOpts,
  WriteSourceChunkOpts,
} from "./chunk-writer.ts";
export {
  readChunk,
  readAllMainChunks,
  readAllJournalChunks,
  scanLore,
  chunkIdFromPath,
} from "./chunk-reader.ts";
export type { LoreScan } from "./chunk-reader.ts";
export {
  writeEmbeddingFile,
  readEmbeddingFile,
  embeddingFilePath,
  deleteEmbeddingFile,
} from "./embedding-io.ts";
export type { EmbeddingFile } from "./embedding-io.ts";
