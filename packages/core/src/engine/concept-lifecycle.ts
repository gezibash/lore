import type { Database } from "bun:sqlite";
import type { ConceptBindingSummary, ConceptRow, NarrativeTarget } from "@/types/index.ts";
import { LoreError } from "@/types/index.ts";
import {
  getActiveConcepts,
  getChunk,
  getChunkCount,
  getConceptsByNameCaseInsensitive,
  getEmbeddingForChunk,
  getHeadCommit,
  getJournalChunksForConcept,
  getManifest,
  insertChunk,
  insertCommit,
  insertCommitTree,
  insertConcept,
  insertConceptVersion,
  insertEmbedding,
  insertFtsContent,
  getActiveConceptCount,
  isConceptNameTaken,
  upsertManifest,
} from "@/db/index.ts";
import {
  embeddingFilePath,
  markSuperseded,
  updateChunkFrontmatter,
  writeEmbeddingFile,
  writeStateChunk,
} from "@/storage/index.ts";
import { getBindingSummariesForConcept } from "@/db/concept-symbols.ts";
import { readChunk } from "@/storage/chunk-reader.ts";
import { measureGroundResiduals } from "./ground-residual.ts";
import { createGenesisCommit } from "./narrative-lifecycle.ts";
import type { Embedder } from "./embedder.ts";
import { synthesizeConceptBody } from "./generator.ts";
import type { Generator } from "./generator.ts";
import { discoverConcepts } from "./concept-discovery.ts";
import { mapConcurrent } from "./async.ts";
import { cosineDistance, computeDebtTrend } from "./residuals.ts";
import { computeExpectedDebt } from "./measurement.ts";

/**
 * Concept lifecycle operations (rename / archive / restore / merge / split /
 * patch) plus the shared DB/storage helpers they rest on.
 *
 * One implementation serves both entry points: the public LoreEngine methods
 * (`conceptRename` & co.) and the narrative-close lifecycle-target handler.
 * Before this module the two were near-identical copies that had already
 * started drifting.
 *
 * Models are handed over lazily (`getEmbedder` / `getGenerator`): pure
 * DB-and-file operations like rename and archive must not instantiate an
 * embedder or generator — and must not fail when no provider is reachable.
 */

export interface LifecycleResult {
  action: "rename" | "archive" | "restore" | "merge" | "split" | "patch" | "rebuild";
  commit_id: string | null;
  summary: string;
  affected: string[];
  preview?: boolean;
  proposal?: {
    source?: string;
    target?: string;
    merged_content?: string;
    splits?: Array<{ name: string; content: string }>;
  };
}

export interface LifecycleDeps {
  db: Database;
  lorePath: string;
  embeddingModel: string;
  /** The codebase, for reading the bodies a concept is bound to. Null leaves
   *  the ground residual unmeasured. */
  codePath: string | null;
  /** The code embedding model's name, for the ground residual. */
  codeModel: string | null;
  /** Resolved on first use — only operations that need it pay for it. */
  getEmbedder(): Promise<Embedder>;
  /** Resolved on first use — only operations that need it pay for it. */
  getCodeEmbedder(): Promise<Embedder | null>;
  /** Resolved on first use — only operations that need it pay for it. */
  getGenerator(): Promise<Generator>;
}

function isActiveConcept(concept: ConceptRow): boolean {
  return concept.lifecycle_status == null || concept.lifecycle_status === "active";
}

export function resolveConceptByNameCi(
  db: Database,
  name: string,
  opts?: { activeOnly?: boolean },
): ConceptRow {
  const matches = getConceptsByNameCaseInsensitive(db, name);
  if (matches.length === 0) {
    throw new LoreError("CONCEPT_NOT_FOUND", `Concept '${name}' not found`);
  }

  const exact = matches.filter((m) => m.name === name);
  const concept = exact.length === 1 ? exact[0]! : matches.length === 1 ? matches[0]! : null;
  if (!concept) {
    throw new LoreError("CONCEPT_NAME_CONFLICT", `Concept name '${name}' is ambiguous`);
  }

  if (opts?.activeOnly && !isActiveConcept(concept)) {
    throw new LoreError("CONCEPT_INVALID_STATE", `Concept '${concept.name}' is not active`);
  }

  return concept;
}

function assertConceptNameAvailable(
  db: Database,
  name: string,
  opts?: { excludeId?: string },
): void {
  if (!isConceptNameTaken(db, name, { excludeId: opts?.excludeId })) return;
  throw new LoreError("CONCEPT_NAME_CONFLICT", `Concept name '${name}' already exists`);
}

function ensureHeadCommit(db: Database) {
  let head = getHeadCommit(db);
  if (!head) {
    head = createGenesisCommit(db);
  }
  return head;
}

function snapshotCurrentTree(db: Database, message: string) {
  const head = ensureHeadCommit(db);
  const activeConcepts = getActiveConcepts(db);
  const treeEntries = activeConcepts
    .filter((c) => c.active_chunk_id)
    .map((c) => ({ conceptId: c.id, chunkId: c.active_chunk_id!, conceptName: c.name }));
  const commit = insertCommit(db, null, head.id, null, message);
  insertCommitTree(db, commit.id, treeEntries);
  return commit;
}

function updateManifestForLifecycle(db: Database, debtBefore: number): { debtAfter: number } {
  const concepts = getActiveConcepts(db);
  const debtAfter = computeExpectedDebt(db, concepts).debt ?? 0;
  upsertManifest(db, {
    chunk_count: getChunkCount(db),
    concept_count: getActiveConceptCount(db),
    debt: debtAfter,
    debt_trend: computeDebtTrend(debtAfter, debtBefore),
    last_integrated: new Date().toISOString(),
  });
  return { debtAfter };
}

async function updateActiveChunkMetadata(
  db: Database,
  concept: ConceptRow,
  updates: Record<string, unknown>,
): Promise<void> {
  if (!concept.active_chunk_id) return;
  const chunk = getChunk(db, concept.active_chunk_id);
  if (!chunk) return;
  await updateChunkFrontmatter(chunk.file_path, updates);
}

async function readConceptContent(db: Database, concept: ConceptRow): Promise<string> {
  if (!concept.active_chunk_id) return "";
  const chunk = getChunk(db, concept.active_chunk_id);
  if (!chunk) return "";
  const parsed = await readChunk(chunk.file_path);
  return parsed.content;
}

export async function appendStateChunkForConcept(
  db: Database,
  lorePath: string,
  concept: ConceptRow,
  content: string,
  narrativeOrigin: string,
  embedder: Embedder,
  embeddingModel: string,
  opts?: { supersedesId?: string | null },
): Promise<{ chunkId: string; residual: number }> {
  const supersedesId =
    opts?.supersedesId !== undefined ? opts.supersedesId : concept.active_chunk_id;

  let nextVersion = 1;
  if (supersedesId) {
    const currentChunk = getChunk(db, supersedesId);
    if (currentChunk) {
      const parsed = await readChunk(currentChunk.file_path);
      const currentVersion =
        "fl_version" in parsed.frontmatter
          ? ((parsed.frontmatter as { fl_version: number }).fl_version ?? 0)
          : 0;
      nextVersion = currentVersion + 1;
    }
  }

  // Embed before any state moves. The embedding call is network I/O; it must
  // not sit between the dependent DB writes below, or a failure mid-sequence
  // leaves chunks, FTS and concept versions disagreeing about what exists.
  const embedding = await embedder.embed(content);

  let residual = 0;
  if (supersedesId) {
    const oldEmb = getEmbeddingForChunk(db, supersedesId);
    if (oldEmb) {
      const oldVec = new Float32Array(oldEmb.embedding.buffer);
      residual = cosineDistance(oldVec, embedding);
    }
  }

  const { id, filePath } = await writeStateChunk({
    lorePath,
    concept: concept.name,
    conceptId: concept.id,
    narrativeOrigin,
    version: nextVersion,
    supersedes: supersedesId ?? null,
    content,
  });

  // One transaction for every dependent write: the new chunk row, its FTS
  // entry, its embedding and the concept version that points at it exist
  // together or not at all.
  db.run("BEGIN IMMEDIATE TRANSACTION");
  try {
    insertChunk(db, {
      id,
      filePath,
      flType: "chunk",
      conceptId: concept.id,
      narrativeId: null,
      supersedesId: supersedesId ?? null,
      createdAt: new Date().toISOString(),
    });
    insertFtsContent(db, content, id);
    insertEmbedding(db, id, embedding, embeddingModel);

    insertConceptVersion(db, concept.id, {
      active_chunk_id: id,
      residual,
      staleness: 0,
      lifecycle_status: "active",
      archived_at: null,
      lifecycle_reason: null,
      merged_into_concept_id: null,
    });
    db.run("COMMIT");
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  }

  // File mirrors happen after commit and are best-effort: the DB row is
  // authoritative, so a crash here leaves stale metadata on disk, never a
  // half-applied state change. markSuperseded after commit means a rollback
  // can no longer leave the old chunk marked superseded in the file while
  // the DB still considers it active.
  if (supersedesId) {
    const oldChunk = getChunk(db, supersedesId);
    if (oldChunk) {
      await markSuperseded(oldChunk.file_path, id);
    }
  }
  await writeEmbeddingFile(embeddingFilePath(filePath), embeddingModel, embedding);
  try {
    await updateChunkFrontmatter(filePath, {
      fl_embedding_model: embeddingModel,
      fl_embedded_at: new Date().toISOString(),
      fl_residual: residual,
      fl_staleness: 0,
      fl_lifecycle_status: "active",
      fl_archived_at: null,
      fl_lifecycle_reason: null,
      fl_merged_into_concept_id: null,
    });
  } catch {
    // Frontmatter mirror is advisory only.
  }

  return { chunkId: id, residual };
}

// ─── Lifecycle Operations ────────────────────────────────

export async function renameConcept(
  deps: LifecycleDeps,
  from: string,
  to: string,
): Promise<LifecycleResult> {
  const { db } = deps;
  const debtBefore = getManifest(db)?.debt ?? 0;

  const concept = resolveConceptByNameCi(db, from, { activeOnly: true });
  assertConceptNameAvailable(db, to, { excludeId: concept.id });
  insertConceptVersion(db, concept.id, { name: to });
  await updateActiveChunkMetadata(db, concept, { fl_concept: to });

  const commit = snapshotCurrentTree(db, `lifecycle: rename ${concept.name} -> ${to}`);
  updateManifestForLifecycle(db, debtBefore);

  return {
    action: "rename",
    commit_id: commit.id,
    summary: `Renamed concept '${concept.name}' to '${to}'.`,
    affected: [concept.name, to],
  };
}

export async function archiveConcept(
  deps: LifecycleDeps,
  name: string,
  reason?: string,
): Promise<LifecycleResult> {
  const { db } = deps;
  const concept = resolveConceptByNameCi(db, name, { activeOnly: true });
  const debtBefore = getManifest(db)?.debt ?? 0;
  const now = new Date().toISOString();

  insertConceptVersion(db, concept.id, {
    active_chunk_id: null,
    lifecycle_status: "archived",
    archived_at: now,
    lifecycle_reason: reason ?? "archived",
    merged_into_concept_id: null,
  });
  await updateActiveChunkMetadata(db, concept, {
    fl_lifecycle_status: "archived",
    fl_archived_at: now,
    fl_lifecycle_reason: reason ?? "archived",
    fl_merged_into_concept_id: null,
  });

  const commit = snapshotCurrentTree(db, `lifecycle: archive ${concept.name}`);
  updateManifestForLifecycle(db, debtBefore);

  return {
    action: "archive",
    commit_id: commit.id,
    summary: `Archived concept '${concept.name}'.`,
    affected: [concept.name],
  };
}

export async function restoreConcept(deps: LifecycleDeps, name: string): Promise<LifecycleResult> {
  const { db } = deps;
  const concept = resolveConceptByNameCi(db, name);
  if (isActiveConcept(concept)) {
    throw new LoreError("CONCEPT_INVALID_STATE", `Concept '${concept.name}' is already active`);
  }
  assertConceptNameAvailable(db, concept.name, { excludeId: concept.id });
  const debtBefore = getManifest(db)?.debt ?? 0;

  const latestChunk = db
    .query<{ id: string }, [string]>(
      `SELECT id FROM chunks
       WHERE concept_id = ? AND fl_type = 'chunk'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(concept.id);
  if (!latestChunk?.id) {
    throw new LoreError(
      "CONCEPT_INVALID_STATE",
      `Concept '${concept.name}' has no state chunks to restore`,
    );
  }

  insertConceptVersion(db, concept.id, {
    active_chunk_id: latestChunk.id,
    lifecycle_status: "active",
    archived_at: null,
    lifecycle_reason: null,
    merged_into_concept_id: null,
  });

  const restoredChunk = getChunk(db, latestChunk.id);
  if (restoredChunk) {
    await updateChunkFrontmatter(restoredChunk.file_path, {
      fl_lifecycle_status: "active",
      fl_archived_at: null,
      fl_lifecycle_reason: null,
      fl_merged_into_concept_id: null,
    });
  }

  await discoverConcepts(db, await deps.getGenerator());
  const commit = snapshotCurrentTree(db, `lifecycle: restore ${concept.name}`);
  updateManifestForLifecycle(db, debtBefore);

  return {
    action: "restore",
    commit_id: commit.id,
    summary: `Restored concept '${concept.name}'.`,
    affected: [concept.name],
  };
}

export async function mergeConcept(
  deps: LifecycleDeps,
  sourceName: string,
  targetName: string,
  opts?: { reason?: string; preview?: boolean },
): Promise<LifecycleResult> {
  const { db } = deps;
  const source = resolveConceptByNameCi(db, sourceName, { activeOnly: true });
  const target = resolveConceptByNameCi(db, targetName, { activeOnly: true });
  if (source.id === target.id) {
    throw new LoreError("CONCEPT_INVALID_STATE", "Source and target must be different concepts");
  }

  const sourceContent = await readConceptContent(db, source);
  const targetContent = await readConceptContent(db, target);
  const mergedContent = await (
    await deps.getGenerator()
  ).generateIntegration(
    [`Merge findings from concept "${source.name}" into "${target.name}".\n\n${sourceContent}`],
    targetContent ? [targetContent] : [],
    target.name,
  );

  if (opts?.preview) {
    return {
      action: "merge",
      commit_id: null,
      preview: true,
      summary: `Preview merge '${source.name}' -> '${target.name}'.`,
      affected: [source.name, target.name],
      proposal: {
        source: source.name,
        target: target.name,
        merged_content: mergedContent,
      },
    };
  }

  const debtBefore = getManifest(db)?.debt ?? 0;
  await appendStateChunkForConcept(
    db,
    deps.lorePath,
    target,
    mergedContent,
    `lifecycle-merge:${source.name}`,
    await deps.getEmbedder(),
    deps.embeddingModel,
    { supersedesId: target.active_chunk_id },
  );

  const now = new Date().toISOString();
  insertConceptVersion(db, source.id, {
    active_chunk_id: null,
    lifecycle_status: "merged",
    archived_at: now,
    lifecycle_reason: opts?.reason ?? `merged into ${target.name}`,
    merged_into_concept_id: target.id,
  });
  await updateActiveChunkMetadata(db, source, {
    fl_lifecycle_status: "merged",
    fl_archived_at: now,
    fl_lifecycle_reason: opts?.reason ?? `merged into ${target.name}`,
    fl_merged_into_concept_id: target.id,
  });

  await discoverConcepts(db, await deps.getGenerator());
  const commit = snapshotCurrentTree(db, `lifecycle: merge ${source.name} -> ${target.name}`);
  updateManifestForLifecycle(db, debtBefore);

  return {
    action: "merge",
    commit_id: commit.id,
    summary: `Merged '${source.name}' into '${target.name}'.`,
    affected: [source.name, target.name],
  };
}

export async function splitConcept(
  deps: LifecycleDeps,
  name: string,
  opts?: { parts?: number; preview?: boolean },
): Promise<LifecycleResult> {
  const { db } = deps;
  const source = resolveConceptByNameCi(db, name, { activeOnly: true });
  const parts = Math.max(2, opts?.parts ?? 2);
  const sourceContent = await readConceptContent(db, source);
  const proposals = await (
    await deps.getGenerator()
  ).proposeSplit(source.name, sourceContent, parts);

  const uniqueProposalNames = new Set<string>();
  for (const proposal of proposals) {
    if (uniqueProposalNames.has(proposal.name.toLowerCase())) {
      throw new LoreError(
        "CONCEPT_NAME_CONFLICT",
        `Split generated duplicate concept name '${proposal.name}'`,
      );
    }
    uniqueProposalNames.add(proposal.name.toLowerCase());
    assertConceptNameAvailable(db, proposal.name);
  }

  if (opts?.preview) {
    return {
      action: "split",
      commit_id: null,
      preview: true,
      summary: `Preview split '${source.name}' into ${proposals.length} concepts.`,
      affected: [source.name],
      proposal: {
        source: source.name,
        splits: proposals,
      },
    };
  }

  const debtBefore = getManifest(db)?.debt ?? 0;
  const embedder = await deps.getEmbedder();
  const created: string[] = [];
  for (const proposal of proposals) {
    const concept = insertConcept(db, proposal.name);
    await appendStateChunkForConcept(
      db,
      deps.lorePath,
      concept,
      proposal.content,
      `lifecycle-split:${source.name}`,
      embedder,
      deps.embeddingModel,
      { supersedesId: null },
    );
    created.push(proposal.name);
  }

  const now = new Date().toISOString();
  insertConceptVersion(db, source.id, {
    active_chunk_id: null,
    lifecycle_status: "archived",
    archived_at: now,
    lifecycle_reason: `split into ${created.join(", ")}`,
    merged_into_concept_id: null,
  });
  await updateActiveChunkMetadata(db, source, {
    fl_lifecycle_status: "archived",
    fl_archived_at: now,
    fl_lifecycle_reason: `split into ${created.join(", ")}`,
    fl_merged_into_concept_id: null,
  });

  await discoverConcepts(db, await deps.getGenerator());
  const commit = snapshotCurrentTree(
    db,
    `lifecycle: split ${source.name} -> ${created.length} concepts`,
  );
  updateManifestForLifecycle(db, debtBefore);

  return {
    action: "split",
    commit_id: commit.id,
    summary: `Split '${source.name}' into ${created.length} concepts.`,
    affected: [source.name, ...created],
  };
}

export async function patchConcept(
  deps: LifecycleDeps,
  name: string,
  text: string,
  opts?: { topics?: string[]; direct?: boolean },
): Promise<LifecycleResult> {
  const { db } = deps;
  const concept = resolveConceptByNameCi(db, name, { activeOnly: true });

  const currentContent = await readConceptContent(db, concept);

  let newContent: string;
  if (opts?.direct) {
    newContent = text.trim();
  } else {
    const topicsSuffix =
      opts?.topics && opts.topics.length > 0 ? `\n\nRelated topics: ${opts.topics.join(", ")}` : "";
    newContent = await (
      await deps.getGenerator()
    ).generateIntegration(
      [text + topicsSuffix],
      currentContent ? [currentContent] : [],
      concept.name,
    );
  }

  if (newContent.trim() === currentContent.trim()) {
    return {
      action: "patch",
      commit_id: null,
      summary: `No patch changes produced for '${concept.name}'.`,
      affected: [concept.name],
    };
  }

  const debtBefore = getManifest(db)?.debt ?? 0;
  await appendStateChunkForConcept(
    db,
    deps.lorePath,
    concept,
    newContent,
    `lifecycle-patch:${concept.name}`,
    await deps.getEmbedder(),
    deps.embeddingModel,
    { supersedesId: concept.active_chunk_id },
  );

  await discoverConcepts(db, await deps.getGenerator());
  const commit = snapshotCurrentTree(db, `lifecycle: patch ${concept.name}`);
  updateManifestForLifecycle(db, debtBefore);

  return {
    action: "patch",
    commit_id: commit.id,
    summary: `Patched concept '${concept.name}'.`,
    affected: [concept.name],
  };
}

function formatBindingInventory(bindings: ConceptBindingSummary[]): string {
  const lines = bindings.map(
    (binding) =>
      `- ${binding.symbol_qualified_name ?? binding.symbol_name} (${binding.symbol_kind}) in ${binding.file_path}:${binding.line_start}`,
  );
  return `Bound code for this concept:\n${lines.join("\n")}`;
}

/**
 * Rewrite a concept body from its inputs: the journal entries designated to it
 * and the code it is bound to. The current body is an output, not an input, so
 * a wrong sentence in it disappears. The old body stays in the version history.
 */
export async function rebuildConcept(deps: LifecycleDeps, name: string): Promise<LifecycleResult> {
  const { db } = deps;
  const concept = resolveConceptByNameCi(db, name, { activeOnly: true });

  const journalChunks = getJournalChunksForConcept(db, {
    conceptId: concept.id,
    conceptName: concept.name,
  });
  if (journalChunks.length === 0) {
    throw new LoreError(
      "CONCEPT_INVALID_STATE",
      `Concept '${concept.name}' has no journal entries to rebuild from. Write entries against it, then rebuild.`,
      { concept: concept.name },
    );
  }

  const entries = await mapConcurrent(journalChunks, 8, async (chunk) => {
    const parsed = await readChunk(chunk.file_path);
    return parsed.content;
  });
  const inputs = entries.filter((entry) => entry.trim().length > 0);

  const bindings = getBindingSummariesForConcept(db, concept.id);
  if (bindings.length > 0) {
    inputs.push(formatBindingInventory(bindings));
  }

  const generator = await deps.getGenerator();
  // `replace` writes the whole body from the inputs. The guard keeps the
  // current body when the generator returns nothing.
  const newContent = await synthesizeConceptBody(concept.name, () =>
    generator.generateIntegration(inputs, [], concept.name, "replace"),
  );

  const currentContent = await readConceptContent(db, concept);
  if (newContent.trim() === currentContent.trim()) {
    return {
      action: "rebuild",
      commit_id: null,
      summary: `Rebuild produced the same body for '${concept.name}'.`,
      affected: [concept.name],
    };
  }

  const debtBefore = getManifest(db)?.debt ?? 0;
  await appendStateChunkForConcept(
    db,
    deps.lorePath,
    concept,
    newContent,
    `lifecycle-rebuild:${concept.name}`,
    await deps.getEmbedder(),
    deps.embeddingModel,
    { supersedesId: concept.active_chunk_id },
  );

  // The ground residual measures the prose against the code it is bound to.
  // A rebuild replaces both — it writes a new body from the current bindings —
  // so leaving the stored number alone makes `lore status` report the distance
  // of a body that no longer exists. Close measures it here; a rebuild did not,
  // and the value survived a cleanup of 44 bindings unchanged to sixteen
  // decimal places.
  const measured = await measureGroundResiduals(db, {
    codePath: deps.codePath,
    targets: [{ conceptId: concept.id, content: newContent, textEmbedding: null }],
    embedder: await deps.getEmbedder(),
    codeEmbedder: await deps.getCodeEmbedder(),
    codeModel: deps.codeModel,
  });
  const groundResidual = measured.get(concept.id) ?? null;
  if (groundResidual != null) {
    insertConceptVersion(db, concept.id, { ground_residual: groundResidual });
  }

  await discoverConcepts(db, generator);
  const commit = snapshotCurrentTree(db, `lifecycle: rebuild ${concept.name}`);
  updateManifestForLifecycle(db, debtBefore);

  return {
    action: "rebuild",
    commit_id: commit.id,
    summary: `Rebuilt '${concept.name}' from ${journalChunks.length} journal entries and ${bindings.length} bindings.`,
    affected: [concept.name],
  };
}

/**
 * Apply one narrative-close lifecycle target. Returns null for targets that
 * are not lifecycle operations (`create`, `update`) — matching the previous
 * handler, which silently ignored them.
 */
export async function applyLifecycleTarget(
  deps: LifecycleDeps,
  target: NarrativeTarget,
): Promise<LifecycleResult | null> {
  switch (target.op) {
    case "rename":
      return renameConcept(deps, target.from, target.to);
    case "archive":
      return archiveConcept(deps, target.concept, target.reason);
    case "restore":
      return restoreConcept(deps, target.concept);
    case "merge":
      return mergeConcept(deps, target.source, target.into, { reason: target.reason });
    case "split":
      return splitConcept(deps, target.concept, { parts: target.parts });
    default:
      return null;
  }
}
