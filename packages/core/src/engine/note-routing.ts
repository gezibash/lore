/**
 * Routing for `lore note`.
 *
 * `lore write` asks for a narrative and a concept on every entry. The
 * discipline pays at close, where the designations make the merge precise, but
 * the cost lands at capture, and capture is where an agent fails. Facing a
 * narrative name, an intent and a designation mid-task, it takes the cheap path
 * and writes nothing. A finding never captured costs more than one filed under
 * the wrong concept, because close-time synthesis can move prose and cannot
 * recover a note that was never written.
 *
 * So `note` asks for none of it and works the answers out here.
 */
import type { Database } from "bun:sqlite";
import { getActiveConcepts } from "@/db/concepts.ts";
import { getOpenNarratives } from "@/db/narratives.ts";
import { LoreError, type LoreConfig, type NarrativeRow } from "@/types/index.ts";
import { getCreateUpdateTargets } from "./journal-routing.ts";
import { hybridSearch } from "./search.ts";
import type { EmbedderLike } from "./search.ts";

/** The narrative that holds a note when no single narrative is open. */
export const INBOX_NARRATIVE = "inbox";

export const INBOX_INTENT = "Unfiled notes, captured with `lore note`";

export type NarrativeChoice =
  | { kind: "open"; narrative: NarrativeRow }
  | { kind: "inbox"; reason: "none-open" | "many-open" };

/**
 * Which narrative a note joins.
 *
 * One open narrative is the session the note belongs to. With none open, or
 * with several and no way to tell which, the note goes to a standing inbox
 * rather than failing. An inbox entry is triaged at close; a refused note is
 * gone.
 */
export function chooseNarrative(db: Database): NarrativeChoice {
  const open = getOpenNarratives(db).filter((narrative) => narrative.name !== INBOX_NARRATIVE);
  if (open.length === 1) return { kind: "open", narrative: open[0]! };
  return { kind: "inbox", reason: open.length === 0 ? "none-open" : "many-open" };
}

export type ConceptRouting =
  /** The narrative already decides, so no search is needed. */
  | { kind: "inherit" }
  | { kind: "routed"; concept: string; candidates: number }
  | { kind: "only"; concept: string };

/**
 * Which concept a note is designated against.
 *
 * A narrative that declares targets bounds the choice to them, because
 * journal-routing rejects any designation outside the declared set. A
 * narrative without targets can name any active concept.
 *
 * The note text picks the winner by the same retrieval the mind answers with,
 * so a note lands where a reader looking for it would search. This runs at
 * capture rather than at close: it costs one embedding, it keeps the stored
 * entry the same shape as one from `lore write`, and it needs no second pass
 * to become useful.
 */
export async function routeConcept(
  db: Database,
  embedder: EmbedderLike,
  config: LoreConfig,
  narrative: NarrativeRow,
  text: string,
): Promise<ConceptRouting> {
  const targets = getCreateUpdateTargets(narrative);
  // One target is the narrative's own answer. journal-routing already infers
  // it, so leaving it alone keeps one rule in one place and spends nothing.
  if (targets.length === 1) return { kind: "inherit" };

  const candidates =
    targets.length > 0
      ? targets.map((target) => target.concept)
      : getActiveConcepts(db).map((concept) => concept.name);

  if (candidates.length === 0) {
    throw new LoreError(
      "NOTE_NO_CONCEPTS",
      "This lore has no concept to file a note against. Pass --concept <name> to start one.",
    );
  }
  if (candidates.length === 1) return { kind: "only", concept: candidates[0]! };

  const allowed = new Set(candidates);
  const { results } = await hybridSearch(db, embedder, text, config, {
    sourceType: "chunk",
    limit: Math.max(10, Math.min(candidates.length, 50)),
    textModel: config.ai.embedding.model,
  });

  for (const result of results) {
    if (result.concept && allowed.has(result.concept)) {
      return { kind: "routed", concept: result.concept, candidates: candidates.length };
    }
  }

  // Retrieval reached nothing inside the allowed set. Guessing here would file
  // the note under a concept it does not describe, and a wrong designation is
  // read later as a statement about that concept.
  throw new LoreError(
    "NOTE_UNROUTABLE",
    targets.length > 0
      ? `No declared target of '${narrative.name}' matches this note. Pass --concept with one of: ${candidates.join(", ")}.`
      : "No concept matches this note closely enough. Pass --concept <name>.",
  );
}
