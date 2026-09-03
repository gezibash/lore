import { statSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { getDocLaneStats, getJournalEntryCount, getSourceChunkCount } from "@/db/chunks.ts";
import { getLastScannedAt, getSourceFileCount } from "@/db/source-files.ts";
import { lakeFreshness } from "@/format.ts";
import type { QueryIndexFreshness, StatusResult } from "@/types/index.ts";
import { discoverFiles } from "./file-discovery.ts";
import { discoverTextFiles } from "./file-discovery-text.ts";

export type LakeStats = NonNullable<StatusResult["lake"]>;

/** Walk the tree and grade how far the index is behind the files on disk. */
export function collectLakeStats(db: Database, codePath: string): LakeStats {
  const lastCodeIndexedAt = getLastScannedAt(db);
  const lastCodeMs = lastCodeIndexedAt ? new Date(lastCodeIndexedAt).getTime() : 0;
  const docLane = getDocLaneStats(db);
  const lastDocIndexedAt = docLane.last_indexed_at;
  const lastDocMs = lastDocIndexedAt ? new Date(lastDocIndexedAt).getTime() : 0;

  const sourceFiles = discoverFiles(codePath);
  let staleSourceFiles = 0;
  for (const file of sourceFiles) {
    try {
      if (statSync(file.absolutePath).mtimeMs > lastCodeMs) staleSourceFiles++;
    } catch {
      // file disappeared — skip
    }
  }

  const docFiles = discoverTextFiles(codePath);
  let staleDocFiles = 0;
  for (const file of docFiles) {
    try {
      if (statSync(file.absolutePath).mtimeMs > lastDocMs) staleDocFiles++;
    } catch {
      // file disappeared — skip
    }
  }

  // The stale counts walk the disk, so the disk counts are their
  // denominators. A lake count would make the ratio pass 100% as soon as
  // the tree holds a file the last index run did not see.
  return {
    source_chunks: getSourceChunkCount(db),
    source_files: getSourceFileCount(db),
    doc_chunks: docLane.chunks,
    doc_files: docLane.files,
    journal_entries: getJournalEntryCount(db),
    last_code_indexed_at: lastCodeIndexedAt,
    last_doc_indexed_at: lastDocIndexedAt,
    discovered_source_files: sourceFiles.length,
    stale_source_files: staleSourceFiles,
    discovered_doc_files: docFiles.length,
    stale_doc_files: staleDocFiles,
  };
}

export function indexFreshnessFromLake(lake: LakeStats): QueryIndexFreshness {
  const fresh = lakeFreshness(lake);
  return {
    worst: fresh.worst,
    stale_files: lake.stale_source_files + lake.stale_doc_files,
    stale_source_files: lake.stale_source_files,
    stale_doc_files: lake.stale_doc_files,
  };
}
