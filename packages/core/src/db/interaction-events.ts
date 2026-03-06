import type { Database } from "bun:sqlite";
import { ulid } from "ulid";
import type { NorthStarScorecard, QueryNextActionKind } from "@/types/index.ts";

export type InteractionEventType =
  | "ask"
  | "recall"
  | "show"
  | "trail"
  | "open_narrative"
  | "close_narrative"
  | "score";

export interface InteractionEventRow {
  id: string;
  result_id: string | null;
  event_type: InteractionEventType;
  subject: string | null;
  meta_json: string | null;
  created_at: string;
}

interface AskEventMeta {
  primary_action?: QueryNextActionKind;
  stale_warning?: boolean;
}

interface ScoreEventMeta {
  score?: number;
}

function safeParseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  const left = sorted[middle - 1];
  const right = sorted[middle];
  if (left == null || right == null) return null;
  return (left + right) / 2;
}

export function insertInteractionEvent(
  db: Database,
  opts: {
    resultId?: string | null;
    eventType: InteractionEventType;
    subject?: string | null;
    meta?: Record<string, unknown> | null;
    createdAt?: string;
  },
): string {
  const id = ulid();
  db.run(
    `INSERT INTO interaction_events (id, result_id, event_type, subject, meta_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      id,
      opts.resultId ?? null,
      opts.eventType,
      opts.subject ?? null,
      opts.meta ? JSON.stringify(opts.meta) : null,
      opts.createdAt ?? new Date().toISOString(),
    ],
  );
  return id;
}

export function listInteractionEventsSince(
  db: Database,
  sinceIso: string,
): InteractionEventRow[] {
  return db
    .query<InteractionEventRow, [string]>(
      `SELECT id, result_id, event_type, subject, meta_json, created_at
       FROM interaction_events
       WHERE created_at >= ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(sinceIso);
}

export function computeNorthStarScorecard(
  db: Database,
  opts?: { windowDays?: number },
): NorthStarScorecard {
  const windowDays = Math.max(1, opts?.windowDays ?? 30);
  const sinceIso = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const events = listInteractionEventsSince(db, sinceIso);

  const asks = events.filter((event) => event.event_type === "ask");
  const byResult = new Map<string, InteractionEventRow[]>();
  for (const event of events) {
    if (!event.result_id) continue;
    const bucket = byResult.get(event.result_id);
    if (bucket) bucket.push(event);
    else byResult.set(event.result_id, [event]);
  }

  let actionabilityHits = 0;
  let reuseHits = 0;
  let clarityHits = 0;
  let clarityDenominator = 0;
  let staleHits = 0;
  let staleDenominator = 0;
  const guidedActionLatencies: number[] = [];

  for (const ask of asks) {
    if (!ask.result_id) continue;
    const askTime = new Date(ask.created_at).getTime();
    const askMeta = safeParseJson<AskEventMeta>(ask.meta_json);
    const linked = (byResult.get(ask.result_id) ?? []).filter((event) => event.id !== ask.id);
    const followUps = linked.filter((event) => {
      const eventTime = new Date(event.created_at).getTime();
      if (!Number.isFinite(eventTime) || eventTime < askTime) return false;
      return (
        event.event_type === "recall" ||
        event.event_type === "show" ||
        event.event_type === "trail" ||
        event.event_type === "open_narrative"
      );
    });
    const firstFollowUp = followUps.find((event) => {
      return new Date(event.created_at).getTime() - askTime <= 10 * 60 * 1000;
    });
    if (firstFollowUp) {
      actionabilityHits += 1;
      guidedActionLatencies.push((new Date(firstFollowUp.created_at).getTime() - askTime) / 1000);
      if (askMeta?.primary_action && firstFollowUp.event_type === askMeta.primary_action) {
        clarityHits += 1;
      }
      clarityDenominator += 1;
    }

    const reused = followUps.some((event) => {
      const deltaMs = new Date(event.created_at).getTime() - askTime;
      return (
        deltaMs <= 30 * 60 * 1000 &&
        (event.event_type === "recall" || event.event_type === "trail")
      );
    });
    if (reused) reuseHits += 1;

    if (askMeta?.stale_warning) {
      staleDenominator += 1;
      if (firstFollowUp) staleHits += 1;
    }
  }

  const scores = db
    .query<{ score: number }, [string]>(
      `SELECT score
       FROM query_cache
       WHERE score IS NOT NULL AND scored_at IS NOT NULL AND scored_at >= ?`,
    )
    .all(sinceIso)
    .map((row) => row.score)
    .filter((value): value is number => Number.isFinite(value));
  const averageScore =
    scores.length > 0 ? scores.reduce((sum, value) => sum + value, 0) / scores.length : null;

  const opens = events.filter((event) => event.event_type === "open_narrative");
  const closes = events.filter((event) => event.event_type === "close_narrative");
  let maintenanceHits = 0;
  for (const open of opens) {
    const openTime = new Date(open.created_at).getTime();
    const matchedClose = closes.find((close) => {
      if (!open.subject || !close.subject) return false;
      if (close.subject !== open.subject) return false;
      return new Date(close.created_at).getTime() >= openTime;
    });
    if (matchedClose) maintenanceHits += 1;
  }

  const noteParts: string[] = [];
  if (asks.length < 5) noteParts.push(`early ask sample (${asks.length})`);
  if (scores.length < 3) noteParts.push(`limited score sample (${scores.length})`);
  if (opens.length < 3) noteParts.push(`light narrative sample (${opens.length})`);

  return {
    window_days: windowDays,
    asks_observed: asks.length,
    scored_answers: scores.length,
    narratives_opened: opens.length,
    narratives_closed: closes.length,
    first_answer_actionability: {
      value: asks.length > 0 ? actionabilityHits / asks.length : null,
      numerator: actionabilityHits,
      denominator: asks.length,
      target: 0.7,
    },
    time_to_first_guided_action: {
      median_seconds: median(guidedActionLatencies),
      sample_size: guidedActionLatencies.length,
      target_seconds: 300,
      proxy: "Proxy for time to first correct file until file-open telemetry exists.",
    },
    investigation_reuse: {
      value: asks.length > 0 ? reuseHits / asks.length : null,
      numerator: reuseHits,
      denominator: asks.length,
      target: 0.6,
    },
    next_action_clarity: {
      value: clarityDenominator > 0 ? clarityHits / clarityDenominator : null,
      numerator: clarityHits,
      denominator: clarityDenominator,
    },
    stale_answer_follow_through: {
      value: staleDenominator > 0 ? staleHits / staleDenominator : null,
      numerator: staleHits,
      denominator: staleDenominator,
    },
    provenance_trust: {
      average_score: averageScore,
      sample_size: scores.length,
      target: 4.2,
    },
    maintenance_loop_completion: {
      value: opens.length > 0 ? maintenanceHits / opens.length : null,
      numerator: maintenanceHits,
      denominator: opens.length,
      target: 0.6,
    },
    note: noteParts.length > 0 ? noteParts.join("; ") : undefined,
  };
}

export function getLatestScoreEvent(
  db: Database,
  resultId: string,
): { score: number; created_at: string } | null {
  const row = db
    .query<{ meta_json: string | null; created_at: string }, [string]>(
      `SELECT meta_json, created_at
       FROM interaction_events
       WHERE result_id = ? AND event_type = 'score'
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    )
    .get(resultId);
  if (!row) return null;
  const meta = safeParseJson<ScoreEventMeta>(row.meta_json);
  if (!meta?.score || !Number.isFinite(meta.score)) return null;
  return { score: meta.score, created_at: row.created_at };
}
