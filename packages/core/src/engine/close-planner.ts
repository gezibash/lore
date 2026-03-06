import type { Database } from "bun:sqlite";
import { getActiveConceptByName, getChunk, getJournalChunksForNarrative } from "@/db/index.ts";
import { readChunk } from "@/storage/index.ts";
import type { MergeStrategy, NarrativeRow } from "@/types/index.ts";
import type { Generator } from "./generator.ts";
import { mapConcurrent } from "./async.ts";
import { getCreateUpdateTargets, loadJournalConceptDesignations } from "./journal-routing.ts";

export interface PlannedConceptUpdate {
  conceptId: string;
  conceptName: string;
  existingChunkId: string | null;
  newContent: string;
  sourceEntryIndices: number[];
  strategy: "patch" | "rewrite";
}

export interface PlannedConceptCreate {
  conceptName: string;
  content: string;
  sourceEntryIndices: number[];
}

export interface ExplicitClosePlan {
  updates: PlannedConceptUpdate[];
  creates: PlannedConceptCreate[];
  unresolvedEntries: Array<{
    chunk_id: string;
    created_at: string;
    reason: string;
  }>;
}

interface ContentBlock {
  id: string;
  index: number;
  content: string;
  preview: string;
  tokens: Set<string>;
}

type PatchOp =
  | { op: "replace"; block_id: string; content: string }
  | { op: "delete"; block_id: string }
  | { op: "insert_after"; block_id: string; content: string }
  | { op: "append"; content: string };

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_]+/g)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3),
  );
}

function blockPreview(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 72);
}

function splitContentIntoBlocks(content: string): ContentBlock[] {
  return content
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block, index) => ({
      id: `b${index + 1}`,
      index,
      content: block,
      preview: blockPreview(block),
      tokens: tokenize(block),
    }));
}

function scoreBlocks(blocks: ContentBlock[], journalEntries: readonly string[]): ContentBlock[] {
  const journalTokens = tokenize(journalEntries.join("\n\n"));
  const scored = blocks
    .map((block) => {
      let overlap = 0;
      for (const token of block.tokens) {
        if (journalTokens.has(token)) overlap++;
      }
      const score = journalTokens.size > 0 ? overlap / journalTokens.size : 0;
      return { block, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.block.index - b.block.index);

  if (scored.length === 0) return [];

  const selectedIndexes = new Set<number>();
  for (const entry of scored.slice(0, 4)) {
    selectedIndexes.add(entry.block.index);
    selectedIndexes.add(Math.max(0, entry.block.index - 1));
    selectedIndexes.add(Math.min(blocks.length - 1, entry.block.index + 1));
  }

  return [...selectedIndexes]
    .sort((a, b) => a - b)
    .map((index) => blocks[index]!)
    .filter(Boolean);
}

function renderOutline(blocks: readonly ContentBlock[]): string {
  return blocks.map((block) => `- ${block.id}: ${block.preview}`).join("\n");
}

function renderScopedBlocks(blocks: readonly ContentBlock[]): string {
  return blocks.map((block) => `### ${block.id}\n${block.content}`).join("\n\n");
}

function parsePatchOps(raw: string): PatchOp[] | null {
  try {
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return null;
    const ops: PatchOp[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") return null;
      if (item.op === "replace") {
        if (typeof item.block_id !== "string" || typeof item.content !== "string") return null;
        ops.push({ op: "replace", block_id: item.block_id, content: item.content.trim() });
        continue;
      }
      if (item.op === "delete") {
        if (typeof item.block_id !== "string") return null;
        ops.push({ op: "delete", block_id: item.block_id });
        continue;
      }
      if (item.op === "insert_after") {
        if (typeof item.block_id !== "string" || typeof item.content !== "string") return null;
        ops.push({ op: "insert_after", block_id: item.block_id, content: item.content.trim() });
        continue;
      }
      if (item.op === "append") {
        if (typeof item.content !== "string") return null;
        ops.push({ op: "append", content: item.content.trim() });
        continue;
      }
      return null;
    }
    return ops;
  } catch {
    return null;
  }
}

function applyPatchOps(
  existingBlocks: readonly ContentBlock[],
  ops: readonly PatchOp[],
): string | null {
  const blocks = existingBlocks.map((block) => ({ ...block }));
  let syntheticIndex = 0;

  for (const op of ops) {
    if (op.op === "append") {
      if (!op.content.trim()) continue;
      blocks.push({
        id: `__append_${++syntheticIndex}`,
        index: blocks.length,
        content: op.content.trim(),
        preview: blockPreview(op.content),
        tokens: tokenize(op.content),
      });
      continue;
    }

    const index = blocks.findIndex((block) => block.id === op.block_id);
    if (index === -1) return null;

    if (op.op === "delete") {
      blocks.splice(index, 1);
      continue;
    }

    if (op.op === "replace") {
      if (!op.content.trim()) return null;
      blocks[index] = {
        ...blocks[index]!,
        content: op.content.trim(),
        preview: blockPreview(op.content),
        tokens: tokenize(op.content),
      };
      continue;
    }

    if (!op.content.trim()) continue;
    blocks.splice(index + 1, 0, {
      id: `__insert_${++syntheticIndex}`,
      index: index + 1,
      content: op.content.trim(),
      preview: blockPreview(op.content),
      tokens: tokenize(op.content),
    });
  }

  const content = blocks
    .map((block) => block.content.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
  return content.length > 0 ? content : null;
}

async function generatePatchUpdate(
  generator: Generator,
  journalEntries: readonly string[],
  conceptName: string,
  existingContent: string,
  mergeStrategy: MergeStrategy | undefined,
): Promise<{ content: string; strategy: "patch" | "rewrite" }> {
  if ((mergeStrategy ?? "replace") === "correct") {
    return {
      content: await generator.generateIntegration(
        [...journalEntries],
        [existingContent],
        conceptName,
        mergeStrategy,
      ),
      strategy: "rewrite",
    };
  }

  const blocks = splitContentIntoBlocks(existingContent);
  if (blocks.length === 0) {
    return {
      content: await generator.generateIntegration(
        [...journalEntries],
        [existingContent],
        conceptName,
        mergeStrategy,
      ),
      strategy: "rewrite",
    };
  }

  const scopedBlocks = scoreBlocks(blocks, journalEntries);
  if (scopedBlocks.length === 0) {
    return {
      content: await generator.generateIntegration(
        [...journalEntries],
        [existingContent],
        conceptName,
        mergeStrategy,
      ),
      strategy: "rewrite",
    };
  }

  const allowedBlockIds = new Set(scopedBlocks.map((block) => block.id));
  const system = `You update a concept by emitting JSON patch ops against stable content blocks.
Return ONLY a JSON array. Each array element must be one of:
{"op":"replace","block_id":"b1","content":"updated block text"}
{"op":"delete","block_id":"b1"}
{"op":"insert_after","block_id":"b1","content":"new block text"}
{"op":"append","content":"new trailing block text"}

Rules:
- Only touch block IDs listed in SCOPED BLOCKS.
- Omit untouched blocks entirely; they stay verbatim.
- Use replace for edits, delete only for explicit retractions, insert_after for nearby additions, append only for trailing new sections.
- Keep the update narrow and grounded in the journal entries.
- Output valid JSON only.`;
  const prompt = [
    `Concept: ${conceptName}`,
    `Merge strategy: ${mergeStrategy ?? "replace"}`,
    "",
    "FULL OUTLINE",
    renderOutline(blocks),
    "",
    "SCOPED BLOCKS",
    renderScopedBlocks(scopedBlocks),
    "",
    "JOURNAL ENTRIES",
    journalEntries.map((entry, index) => `[${index}] ${entry}`).join("\n\n"),
  ].join("\n");

  const raw = await generator.generate(system, prompt, { scope: "generate_integration" });
  const ops = parsePatchOps(raw);
  if (!ops || ops.length === 0) {
    return {
      content: await generator.generateIntegration(
        [...journalEntries],
        [existingContent],
        conceptName,
        mergeStrategy,
      ),
      strategy: "rewrite",
    };
  }

  for (const op of ops) {
    if (op.op === "append") continue;
    if (!allowedBlockIds.has(op.block_id)) {
      return {
        content: await generator.generateIntegration(
          [...journalEntries],
          [existingContent],
          conceptName,
          mergeStrategy,
        ),
        strategy: "rewrite",
      };
    }
  }

  const patched = applyPatchOps(blocks, ops);
  if (!patched) {
    return {
      content: await generator.generateIntegration(
        [...journalEntries],
        [existingContent],
        conceptName,
        mergeStrategy,
      ),
      strategy: "rewrite",
    };
  }

  return { content: patched, strategy: "patch" };
}

export async function buildExplicitClosePlan(
  db: Database,
  narrative: NarrativeRow,
  generator: Generator,
  mergeStrategy?: MergeStrategy,
): Promise<ExplicitClosePlan> {
  const journalChunks = getJournalChunksForNarrative(db, narrative.id);
  if (journalChunks.length === 0) {
    return { updates: [], creates: [], unresolvedEntries: [] };
  }

  const loadedEntries = await mapConcurrent(
    journalChunks.map((chunk, index) => ({ chunk, index })),
    8,
    async ({ chunk, index }) => {
      const parsed = await readChunk(chunk.file_path);
      const designations = loadJournalConceptDesignations(db, chunk);
      return {
        chunk,
        index,
        content: parsed.content,
        designations,
      };
    },
  );

  const unresolvedEntries = loadedEntries
    .filter((entry) => entry.designations.length === 0)
    .map((entry) => ({
      chunk_id: entry.chunk.id,
      created_at: entry.chunk.created_at,
      reason: "missing concept designation",
    }));
  if (unresolvedEntries.length > 0) {
    return { updates: [], creates: [], unresolvedEntries };
  }

  const declaredTargets = getCreateUpdateTargets(narrative);
  const declaredTargetNames = new Set(declaredTargets.map((target) => target.concept));
  const groups = new Map<string, { entries: string[]; indices: number[] }>();
  for (const entry of loadedEntries) {
    for (const conceptName of entry.designations) {
      if (declaredTargetNames.size > 0 && !declaredTargetNames.has(conceptName)) {
        unresolvedEntries.push({
          chunk_id: entry.chunk.id,
          created_at: entry.chunk.created_at,
          reason: `designation '${conceptName}' is outside the declared narrative targets`,
        });
        continue;
      }
      const group = groups.get(conceptName);
      if (group) {
        group.entries.push(entry.content);
        group.indices.push(entry.index);
      } else {
        groups.set(conceptName, { entries: [entry.content], indices: [entry.index] });
      }
    }
  }
  if (unresolvedEntries.length > 0) {
    return { updates: [], creates: [], unresolvedEntries };
  }

  const planned = await mapConcurrent(
    [...groups.entries()],
    4,
    async ([conceptName, group]): Promise<
      | { kind: "update"; value: PlannedConceptUpdate }
      | { kind: "create"; value: PlannedConceptCreate }
      | { kind: "unresolved"; value: ExplicitClosePlan["unresolvedEntries"][number] }
    > => {
      const activeConcept = getActiveConceptByName(db, conceptName);
      if (activeConcept) {
        const chunkRow = activeConcept.active_chunk_id
          ? getChunk(db, activeConcept.active_chunk_id)
          : null;
        const existingContent = chunkRow ? (await readChunk(chunkRow.file_path)).content : "";
        const update = await generatePatchUpdate(
          generator,
          group.entries,
          conceptName,
          existingContent,
          mergeStrategy,
        );
        return {
          kind: "update",
          value: {
            conceptId: activeConcept.id,
            conceptName,
            existingChunkId: activeConcept.active_chunk_id,
            newContent: update.content,
            sourceEntryIndices: group.indices,
            strategy: update.strategy,
          },
        };
      }

      const declaredCreate = declaredTargets.find(
        (target) => target.op === "create" && target.concept === conceptName,
      );
      if (!declaredCreate) {
        return {
          kind: "unresolved",
          value: {
            chunk_id: loadedEntries[group.indices[0]!]!.chunk.id,
            created_at: loadedEntries[group.indices[0]!]!.chunk.created_at,
            reason: `designation '${conceptName}' is not an active concept and is not declared as a create target`,
          },
        };
      }

      return {
        kind: "create",
        value: {
          conceptName,
          content: await generator.generateIntegration(
            group.entries,
            [],
            conceptName,
            mergeStrategy,
          ),
          sourceEntryIndices: group.indices,
        },
      };
    },
  );

  const updates: PlannedConceptUpdate[] = [];
  const creates: PlannedConceptCreate[] = [];
  for (const item of planned) {
    if (item.kind === "update") updates.push(item.value);
    else if (item.kind === "create") creates.push(item.value);
    else unresolvedEntries.push(item.value);
  }

  return { updates, creates, unresolvedEntries };
}
