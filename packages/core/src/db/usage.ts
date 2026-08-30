import type { Database } from "bun:sqlite";
import { ulid } from "ulid";

type UsageKind = "generation" | "embedding";

export interface UsageEvent {
  kind: UsageKind;
  /** The reasoning scope the call ran under, or "generate" when it had none. */
  operation: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
}

/** Called once per AI call. Never throws; recording must not break the work. */
export type UsageReporter = (event: UsageEvent) => void;

export interface UsageTotals {
  kind: UsageKind;
  operation: string;
  provider: string;
  model: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
}

/**
 * Record one call.
 *
 * Recording must never break the work that earned it, so a failure here is
 * swallowed: a missing row costs a line in a report, a thrown error costs the
 * close that was mid-flight.
 */
export function recordUsage(db: Database, event: UsageEvent): void {
  try {
    db.query(
      `INSERT INTO usage_events
         (id, kind, operation, provider, model, input_tokens, output_tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      ulid(),
      event.kind,
      event.operation,
      event.provider,
      event.model,
      Math.max(0, Math.round(event.input_tokens)),
      Math.max(0, Math.round(event.output_tokens)),
      new Date().toISOString(),
    );
  } catch {
    // Usage is a report, not a result.
  }
}

/** Totals grouped by model and operation, newest window first. */
export function usageTotals(db: Database, since?: string): UsageTotals[] {
  const where = since ? "WHERE created_at >= ?" : "";
  const params = since ? [since] : [];
  return db
    .query<UsageTotals, string[]>(
      `SELECT kind, operation, provider, model,
              COUNT(*) AS calls,
              SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens
         FROM usage_events
         ${where}
        GROUP BY kind, operation, provider, model
        ORDER BY SUM(input_tokens + output_tokens) DESC`,
    )
    .all(...params);
}

export function usageEventCount(db: Database, since?: string): number {
  const where = since ? "WHERE created_at >= ?" : "";
  const params = since ? [since] : [];
  const row = db
    .query<{ n: number }, string[]>(`SELECT COUNT(*) AS n FROM usage_events ${where}`)
    .get(...params);
  return row?.n ?? 0;
}

/** Oldest recorded call, so a report can say what window it actually covers. */
export function usageFirstSeen(db: Database): string | null {
  const row = db
    .query<{ first: string | null }, []>("SELECT MIN(created_at) AS first FROM usage_events")
    .get();
  return row?.first ?? null;
}

export interface UsageLine extends UsageTotals {
  /** Priced at report time. Undefined when the model's price is unknown. */
  cost_usd?: number;
}

export interface LoreUsageReport {
  lore: string;
  code_path: string;
  /** Oldest recorded call, so a total can say what window it covers. */
  first_seen: string | null;
  lines: UsageLine[];
}
