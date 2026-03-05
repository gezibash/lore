import type { Database } from "bun:sqlite";
import {
  getJournalChunksForNarrative,
  getChunk,
  getActiveConcepts,
  getEmbeddingForChunk,
} from "@/db/index.ts";
import { readChunk } from "@/storage/index.ts";
import { hybridSearch } from "./search.ts";
import type { Generator } from "./generator.ts";
import type { Embedder } from "./embedder.ts";
import type { ConceptRow, LoreConfig, NarrativeTarget, MergeStrategy } from "@/types/index.ts";
import { tracer } from "./tracer.ts";

export interface IntegrationPlan {
  updates: Array<{
    conceptId: string;
    conceptName: string;
    existingChunkId: string | null;
    newContent: string;
    sourceEntryIndices: number[];
  }>;
  creates: Array<{
    conceptName: string;
    content: string;
    sourceEntryIndices: number[];
  }>;
}

/**
 * Analyze journal entries from a delta and produce integration plan.
 * Uses hybrid search to narrow concept candidates, then LLM topic
 * segmentation to route entries to existing concepts or create new ones.
 *
 * When `targets` contains `create` or `update` ops, candidate concepts are
 * restricted to the declared target names. If there is exactly one declared
 * target, segmentTopics is skipped entirely.
 */
export async function analyzeJournal(
  db: Database,
  narrativeId: string,
  generator: Generator,
  embedder: Embedder,
  config: LoreConfig,
  targets?: NarrativeTarget[],
  mergeStrategy?: MergeStrategy,
): Promise<IntegrationPlan> {
  const journalChunks = getJournalChunksForNarrative(db, narrativeId);
  if (journalChunks.length === 0) {
    return { updates: [], creates: [] };
  }

  // Read all journal content and parse stored topic hints
  const journalContents: string[] = [];
  const topicHints: string[][] = [];
  for (const chunk of journalChunks) {
    const parsed = await readChunk(chunk.file_path);
    journalContents.push(parsed.content);
    // Topics stored as JSON string on ChunkRow
    const hints: string[] = chunk.topics ? JSON.parse(chunk.topics) : [];
    topicHints.push(hints);
  }

  // Get existing concepts (names only — defer content loading)
  const concepts = getActiveConcepts(db);
  const conceptsByName = new Map<string, ConceptRow>();
  for (const concept of concepts) {
    conceptsByName.set(concept.name, concept);
  }
  const conceptNames = new Set(concepts.map((c) => c.name));

  // Look up pre-computed embeddings for journal chunks (batch-embedded at close time)
  const journalEmbeddings: (Float32Array | undefined)[] = journalChunks.map((chunk) => {
    const embRow = getEmbeddingForChunk(db, chunk.id);
    return embRow ? new Float32Array(embRow.embedding.buffer) : undefined;
  });

  // Search-based candidate narrowing: for each journal entry,
  // run hybridSearch to find relevant concepts — pass pre-computed embeddings to skip re-embedding
  const searchSpan = tracer.span("hybrid-search");
  const candidateSet = new Set<string>();
  const searchResults = await Promise.all(
    journalContents.map((content, i) =>
      hybridSearch(db, embedder, content, config, {
        sourceType: "chunk",
        limit: 5,
        queryEmbedding: journalEmbeddings[i],
        textModel: config.ai.embedding.model,
      }),
    ),
  );
  searchSpan.end();
  for (let i = 0; i < journalContents.length; i++) {
    for (const r of searchResults[i]!.results) {
      if (r.concept) candidateSet.add(r.concept);
    }
    for (const hint of topicHints[i]!) {
      if (conceptNames.has(hint)) candidateSet.add(hint);
    }
  }

  // Declared create/update targets override candidate narrowing
  const declaredTargets = (targets ?? []).filter(
    (t): t is Extract<NarrativeTarget, { op: "create" | "update" }> =>
      t.op === "create" || t.op === "update",
  );

  let narrowedConcepts: string[];
  let groups: Array<{ concept: string; entries: number[] }>;

  if (declaredTargets.length > 0) {
    // Lock candidates to declared targets only
    narrowedConcepts = declaredTargets.map((t) => t.concept);

    if (declaredTargets.length === 1) {
      // Single target: route all entries to it — no LLM segmentation needed
      const singleTarget = declaredTargets[0]!.concept;
      const segmentSpan = tracer.span("segment-topics-skipped");
      groups = [{ concept: singleTarget, entries: journalContents.map((_, i) => i) }];
      segmentSpan.end();
    } else {
      // Multiple declared targets: segment within restricted candidate list
      const segmentSpan = tracer.span("segment-topics");
      groups = await generator.segmentTopics(journalContents, narrowedConcepts, topicHints);
      segmentSpan.end();
    }
  } else {
    // No declared targets: fall back to search-based narrowing
    narrowedConcepts =
      candidateSet.size > 0 ? Array.from(candidateSet) : concepts.map((c) => c.name);

    const segmentSpan = tracer.span("segment-topics");
    groups = await generator.segmentTopics(journalContents, narrowedConcepts, topicHints);
    segmentSpan.end();
  }

  // Determine which concepts are actually referenced by the segmentation
  const referencedConcepts = new Set(groups.map((g) => g.concept));

  // Lazy-load concept content only for concepts that appear in segmentation results.
  // Also resolve the latest state chunk ID — active_chunk_id may be null if
  // discoverConcepts cleared it, so fall back to the most recent chunk in DB.
  const conceptContents = new Map<string, string>();
  const resolvedChunkIds = new Map<string, string | null>(); // concept name → chunk id
  for (const name of referencedConcepts) {
    const concept = conceptsByName.get(name);
    if (!concept) continue;
    let chunkId = concept.active_chunk_id;
    if (!chunkId) {
      // Fallback: find the latest state chunk for this concept
      const latestChunk = db
        .query<{ id: string }, [string]>(
          `SELECT id FROM chunks WHERE concept_id = ? AND fl_type = 'chunk' ORDER BY created_at DESC LIMIT 1`,
        )
        .get(concept.id);
      chunkId = latestChunk?.id ?? null;
    }
    resolvedChunkIds.set(name, chunkId);
    if (chunkId) {
      const chunkRow = getChunk(db, chunkId);
      if (chunkRow) {
        const parsed = await readChunk(chunkRow.file_path);
        conceptContents.set(name, parsed.content);
      }
    }
  }

  // Generate integrations in parallel — each group is independent
  const genSpan = tracer.span("generate-integrations");
  const integrationResults = await Promise.all(
    groups.map(async (group) => {
      const groupEntries = group.entries.map((i) => journalContents[i]!);
      const existing = conceptsByName.get(group.concept);

      if (existing) {
        const existingContent = conceptContents.get(group.concept);
        const existingState = existingContent ? [existingContent] : [];
        const newContent = await generator.generateIntegration(
          groupEntries,
          existingState,
          group.concept,
          mergeStrategy,
        );
        const existingChunkId = resolvedChunkIds.get(group.concept) ?? existing.active_chunk_id;
        if (!existingContent || newContent.trim() !== existingContent.trim()) {
          return {
            type: "update" as const,
            conceptId: existing.id,
            conceptName: existing.name,
            existingChunkId,
            newContent,
            sourceEntryIndices: group.entries,
          };
        }
        return null;
      } else {
        const content = await generator.generateIntegration(groupEntries, [], group.concept);
        return {
          type: "create" as const,
          conceptName: group.concept,
          content,
          sourceEntryIndices: group.entries,
        };
      }
    }),
  );

  genSpan.end();

  const updates: IntegrationPlan["updates"] = [];
  const creates: IntegrationPlan["creates"] = [];
  for (const result of integrationResults) {
    if (!result) continue;
    if (result.type === "update") {
      updates.push({
        conceptId: result.conceptId,
        conceptName: result.conceptName,
        existingChunkId: result.existingChunkId,
        newContent: result.newContent,
        sourceEntryIndices: result.sourceEntryIndices,
      });
    } else {
      creates.push({
        conceptName: result.conceptName,
        content: result.content,
        sourceEntryIndices: result.sourceEntryIndices,
      });
    }
  }

  return { updates, creates };
}
