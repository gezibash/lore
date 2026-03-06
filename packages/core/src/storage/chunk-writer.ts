import { ulid } from "ulid";
import { writeFile, readFile, unlink } from "fs/promises";
import { serializeChunk, updateFrontmatterField } from "./frontmatter.ts";
import { stateChunkFile, journalChunkFile, sourceChunkFile, docsDir, docChunkFile, ensureDir, mainDir, journalDir, sourceDir } from "./paths.ts";
import type {
  StateChunkFrontmatter,
  JournalChunkFrontmatter,
  SourceChunkFrontmatter,
  DocChunkFrontmatter,
  JournalStatus,
  SymbolKind,
  SupportedLanguage,
  FileRef,
} from "@/types/index.ts";

export interface WriteStateChunkOpts {
  lorePath: string;
  concept: string;
  conceptId: string;
  narrativeOrigin: string;
  version: number;
  supersedes?: string | null;
  cluster?: number | null;
  content: string;
}

export async function writeStateChunk(
  opts: WriteStateChunkOpts,
): Promise<{ id: string; filePath: string }> {
  const id = ulid();
  const filePath = stateChunkFile(opts.lorePath, id);
  await ensureDir(mainDir(opts.lorePath));

  const frontmatter: Record<string, unknown> = {
    fl_id: id,
    fl_type: "chunk",
    fl_concept: opts.concept,
    fl_concept_id: opts.conceptId,
    fl_supersedes: opts.supersedes ?? null,
    fl_superseded_by: null,
    fl_narrative_origin: opts.narrativeOrigin,
    fl_version: opts.version,
    fl_created_at: new Date().toISOString(),
    fl_residual: null,
    fl_staleness: null,
    fl_cluster: opts.cluster ?? null,
    fl_embedding_model: "pending",
    fl_embedded_at: null,
    fl_lifecycle_status: "active",
    fl_archived_at: null,
    fl_lifecycle_reason: null,
    fl_merged_into_concept_id: null,
  };

  await writeFile(
    filePath,
    serializeChunk(frontmatter as unknown as StateChunkFrontmatter, opts.content),
  );
  return { id, filePath };
}

export interface WriteJournalChunkOpts {
  lorePath: string;
  narrativeName: string;
  prev?: string | null;
  status?: JournalStatus | null;
  topics?: string[];
  convergence?: number | null;
  theta?: number | null;
  magnitude?: number | null;
  content: string;
  intent?: string;
  conceptDesignations?: string[] | null;
  conceptRefs?: string[] | null;
  symbolRefs?: string[] | null;
  refs?: FileRef[] | null;
}

export async function writeJournalChunk(
  opts: WriteJournalChunkOpts,
): Promise<{ id: string; filePath: string }> {
  const id = ulid();
  const filePath = journalChunkFile(opts.lorePath, opts.narrativeName, id);
  await ensureDir(journalDir(opts.lorePath, opts.narrativeName));

  const frontmatter: Record<string, unknown> = {
    fl_id: id,
    fl_type: "journal",
    fl_narrative: opts.narrativeName,
    fl_prev: opts.prev ?? null,
    fl_status: opts.status ?? null,
    fl_topics: opts.topics ?? [],
    fl_convergence: opts.convergence ?? null,
    fl_theta: opts.theta ?? null,
    fl_magnitude: opts.magnitude ?? null,
    fl_created_at: new Date().toISOString(),
    fl_embedding_model: "pending",
  };

  if (opts.intent) {
    frontmatter.fl_intent = opts.intent;
  }
  if (opts.conceptDesignations?.length) {
    frontmatter.fl_concept_designations = opts.conceptDesignations;
  }
  if (opts.conceptRefs?.length) {
    frontmatter.fl_concept_refs = opts.conceptRefs;
  }
  if (opts.symbolRefs?.length) {
    frontmatter.fl_symbol_refs = opts.symbolRefs;
  }
  if (opts.refs?.length) {
    frontmatter.fl_refs = opts.refs;
  }

  await writeFile(
    filePath,
    serializeChunk(frontmatter as unknown as JournalChunkFrontmatter, opts.content),
  );
  return { id, filePath };
}

export interface WriteSourceChunkOpts {
  lorePath: string;
  sourceFile: string;
  lineStart: number;
  lineEnd: number;
  symbol: string;
  kind: SymbolKind;
  language: SupportedLanguage;
  bodyHash: string | null;
  body: string;
}

export async function writeSourceChunk(
  opts: WriteSourceChunkOpts,
): Promise<{ id: string; filePath: string }> {
  const id = ulid();
  const filePath = sourceChunkFile(opts.lorePath, id);
  await ensureDir(sourceDir(opts.lorePath));

  const frontmatter: SourceChunkFrontmatter = {
    fl_id: id,
    fl_type: "source",
    fl_source_file: opts.sourceFile,
    fl_line_start: opts.lineStart,
    fl_line_end: opts.lineEnd,
    fl_symbol: opts.symbol,
    fl_kind: opts.kind,
    fl_language: opts.language,
    fl_body_hash: opts.bodyHash,
    fl_created_at: new Date().toISOString(),
  };

  await writeFile(filePath, serializeChunk(frontmatter as unknown as StateChunkFrontmatter, opts.body));
  return { id, filePath };
}

export async function deleteSourceChunkFile(filePath: string): Promise<boolean> {
  try {
    await unlink(filePath);
    return true;
  } catch {
    return false;
  }
}

export interface WriteDocChunkOpts {
  lorePath: string;
  docPath: string;    // relative path from codePath root
  bodyHash: string;
  content: string;
}

export async function writeDocChunk(
  opts: WriteDocChunkOpts,
): Promise<{ id: string; filePath: string }> {
  const id = ulid();
  const filePath = docChunkFile(opts.lorePath, id);
  await ensureDir(docsDir(opts.lorePath));

  const frontmatter: DocChunkFrontmatter = {
    fl_id: id,
    fl_type: "doc",
    fl_doc_path: opts.docPath,
    fl_body_hash: opts.bodyHash,
    fl_created_at: new Date().toISOString(),
  };

  await writeFile(filePath, serializeChunk(frontmatter as unknown as StateChunkFrontmatter, opts.content));
  return { id, filePath };
}

export async function markSuperseded(filePath: string, supersededById: string): Promise<void> {
  const raw = await readFile(filePath, "utf-8");
  const updated = updateFrontmatterField(raw, {
    fl_superseded_by: supersededById,
  });
  await writeFile(filePath, updated);
}

export async function updateChunkFrontmatter(
  filePath: string,
  updates: Record<string, unknown>,
): Promise<void> {
  const raw = await readFile(filePath, "utf-8");
  const updated = updateFrontmatterField(raw, updates);
  await writeFile(filePath, updated);
}
