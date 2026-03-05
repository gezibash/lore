import type { Database } from "bun:sqlite";
import { ulid } from "ulid";
import { scanLore, readEmbeddingFile, embeddingFilePath } from "@/storage/index.ts";
import { insertChunk } from "./chunks.ts";
import { insertFtsContent, deleteAllFts } from "./fts.ts";
import { insertEmbedding, deleteAllEmbeddings } from "./embeddings.ts";
import { deleteSnapshotsForNarratives } from "./snapshots.ts";
import { deleteAllResidualHistory } from "./residuals.ts";
import { upsertManifest } from "./manifest.ts";
import { insertConceptRaw } from "./concepts.ts";
import { insertNarrativeRaw } from "./narratives.ts";
import { createGenesisCommit } from "@/engine/narrative-lifecycle.ts";
import { recomputeGraph } from "@/engine/graph.ts";
import type {
  LoreConfig,
  ConceptLifecycleStatus,
  StateChunkFrontmatter,
  JournalChunkFrontmatter,
  ParsedChunk,
} from "@/types/index.ts";

export interface RebuildResult {
  stateChunkCount: number;
  journalChunkCount: number;
  conceptCount: number;
  narrativeCount: number;
  embeddingCount: number;
  staleEmbeddingCount: number;
}

export async function rebuildFromDisk(
  db: Database,
  lorePath: string,
  config?: LoreConfig,
): Promise<RebuildResult> {
  const scan = await scanLore(lorePath);

  // ─── Full reset ────────────────────────────────────────
  db.run("DELETE FROM commit_tree");
  db.run("DELETE FROM commits");
  deleteSnapshotsForNarratives(db);
  deleteAllResidualHistory(db);
  db.run("DELETE FROM laplacian_cache");
  db.run("DELETE FROM concept_edges");
  db.run("DELETE FROM concept_health_signals");
  db.run("DELETE FROM concept_tags");
  deleteAllEmbeddings(db);
  deleteAllFts(db);
  db.run("DELETE FROM chunk_refs");
  db.run("DELETE FROM chunk_concept_map");
  db.run("DELETE FROM chunks");
  db.run("DELETE FROM concepts");
  db.run("DELETE FROM narratives");
  db.run("DELETE FROM manifest");

  // ─── Phase A: Reconstruct concepts from state chunks ───
  // Group state chunks by fl_concept_id, find active chunk per concept
  const conceptGroups = new Map<string, ParsedChunk<StateChunkFrontmatter>[]>();
  for (const chunk of scan.stateChunks) {
    const conceptId = chunk.frontmatter.fl_concept_id;
    let group = conceptGroups.get(conceptId);
    if (!group) {
      group = [];
      conceptGroups.set(conceptId, group);
    }
    group.push(chunk);
  }

  let conceptCount = 0;
  let activeConceptCount = 0;
  for (const [conceptId, chunks] of conceptGroups) {
    // Active chunk = the one not superseded
    const active =
      chunks.find((c) => c.frontmatter.fl_superseded_by === null) ?? chunks[chunks.length - 1]!;
    const fm = active.frontmatter;
    const lifecycleStatus = (fm.fl_lifecycle_status ?? "active") as ConceptLifecycleStatus;
    if (lifecycleStatus === "active") activeConceptCount++;

    insertConceptRaw(db, conceptId, fm.fl_concept, {
      activeChunkId: lifecycleStatus === "active" ? fm.fl_id : null,
      residual: fm.fl_residual,
      staleness: fm.fl_staleness,
      cluster: fm.fl_cluster,
      lifecycleStatus,
      archivedAt: fm.fl_archived_at ?? null,
      lifecycleReason: fm.fl_lifecycle_reason ?? null,
      mergedIntoConceptId: fm.fl_merged_into_concept_id ?? null,
    });
    conceptCount++;
  }

  // ─── Insert state chunks with concept linkage ──────────
  for (const chunk of scan.stateChunks) {
    const fm = chunk.frontmatter;
    insertChunk(db, {
      id: fm.fl_id,
      filePath: chunk.filePath,
      flType: "chunk",
      conceptId: fm.fl_concept_id,
      supersedesId: fm.fl_supersedes,
      createdAt: fm.fl_created_at,
    });
    insertFtsContent(db, chunk.content, fm.fl_id);
  }

  // ─── Phase B: Reconstruct narratives from journal chunks ───
  let journalChunkCount = 0;
  let narrativeCount = 0;

  for (const [narrativeName, chunks] of scan.journalChunks) {
    // Sort by created_at to find earliest
    const sorted = [...chunks].sort((a, b) =>
      a.frontmatter.fl_created_at.localeCompare(b.frontmatter.fl_created_at),
    );
    const first = sorted[0]!;
    const last = sorted[sorted.length - 1]!;

    // Generate a stable narrative ID from the earliest chunk's timestamp
    const seedTime = Date.parse(first.frontmatter.fl_created_at);
    const narrativeId = ulid(seedTime);

    // Check if there are state chunks with this narrative origin
    const hasStateOutput = scan.stateChunks.some(
      (c) => c.frontmatter.fl_narrative_origin === narrativeName,
    );
    const status = hasStateOutput ? "closed" : "open";

    // Extract intent from first journal chunk's fl_intent, or placeholder
    const intent =
      (first.frontmatter as JournalChunkFrontmatter & { fl_intent?: string }).fl_intent ??
      "(recovered from disk)";

    // Compute metrics from last chunk
    const closedAt = status === "closed" ? last.frontmatter.fl_created_at : null;

    insertNarrativeRaw(db, narrativeId, narrativeName, {
      intent,
      status,
      entryCount: sorted.length,
      openedAt: first.frontmatter.fl_created_at,
      closedAt,
      theta: last.frontmatter.fl_theta,
      convergence: last.frontmatter.fl_convergence,
      magnitude: last.frontmatter.fl_magnitude,
    });
    narrativeCount++;

    // Insert journal chunks with narrative linkage
    for (const chunk of sorted) {
      const fm = chunk.frontmatter;
      insertChunk(db, {
        id: fm.fl_id,
        filePath: chunk.filePath,
        flType: "journal",
        narrativeId,
        status: fm.fl_status,
        topics: fm.fl_topics,
        convergence: fm.fl_convergence,
        theta: fm.fl_theta,
        magnitude: fm.fl_magnitude,
        createdAt: fm.fl_created_at,
      });
      insertFtsContent(db, chunk.content, fm.fl_id);
      journalChunkCount++;
    }
  }

  // ─── Phase C: Restore embeddings from .emb sidecars ──
  let embeddingCount = 0;
  let staleEmbeddingCount = 0;
  const currentModel = config?.ai.embedding.model;

  // Collect all chunk file paths for embedding restoration
  const allChunkPaths: Array<{ chunkId: string; filePath: string }> = [];
  for (const chunk of scan.stateChunks) {
    allChunkPaths.push({ chunkId: chunk.frontmatter.fl_id, filePath: chunk.filePath });
  }
  for (const [, chunks] of scan.journalChunks) {
    for (const chunk of chunks) {
      allChunkPaths.push({ chunkId: chunk.frontmatter.fl_id, filePath: chunk.filePath });
    }
  }

  for (const { chunkId, filePath } of allChunkPaths) {
    const embPath = embeddingFilePath(filePath);
    const embFile = await readEmbeddingFile(embPath);
    if (!embFile) continue;

    if (currentModel && embFile.model !== currentModel) {
      staleEmbeddingCount++;
      continue;
    }

    insertEmbedding(db, chunkId, embFile.embedding, embFile.model);
    embeddingCount++;
  }

  // ─── Phase D: Recompute graph from restored embeddings ──
  if (embeddingCount >= 2) {
    recomputeGraph(db);
  }

  // ─── Update manifest ──────────────────────────────────
  upsertManifest(db, {
    chunk_count: scan.stateChunks.length,
    concept_count: activeConceptCount,
  });

  // ─── Genesis commit (now has concept→chunk data) ──────
  createGenesisCommit(db);

  return {
    stateChunkCount: scan.stateChunks.length,
    journalChunkCount,
    conceptCount,
    narrativeCount,
    embeddingCount,
    staleEmbeddingCount,
  };
}
