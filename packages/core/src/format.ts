const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "narrow" });

export function timeAgo(timestamp: string): string {
  const seconds = Math.floor((new Date(timestamp).getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return rtf.format(seconds, "second");
  if (abs < 3600) return rtf.format(Math.trunc(seconds / 60), "minute");
  if (abs < 86400) return rtf.format(Math.trunc(seconds / 3600), "hour");
  if (abs < 2592000) return rtf.format(Math.trunc(seconds / 86400), "day");
  if (abs < 31536000) return rtf.format(Math.trunc(seconds / 2592000), "month");
  return rtf.format(Math.trunc(seconds / 31536000), "year");
}

/** Render a byte count for a person. Disk figures reach the gigabytes, and a
 *  raw byte count at that size is unreadable. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

// ─── Lake freshness ───────────────────────────────────────

export type StaleSeverity = "none" | "low" | "medium" | "high";

const SEVERITY_RANK: Record<StaleSeverity, number> = { none: 0, low: 1, medium: 2, high: 3 };

/** The higher of two lane grades. */
export function worstSeverity(a: StaleSeverity, b: StaleSeverity): StaleSeverity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

/**
 * Grade one lane. `total` counts the files on disk that the lane indexes, so
 * `stale` is a subset of it and the ratio stays at or below 1.
 */
export function staleSeverity(
  stale: number,
  total: number,
): { level: StaleSeverity; ratio: number } {
  if (stale <= 0) return { level: "none", ratio: 0 };
  // A lake from an older producer can miss a count. A missing count reads 0.
  const files = Number.isFinite(total) ? total : 0;
  const ratio = files > 0 ? Math.min(1, stale / files) : 0;
  if (ratio >= 0.2 || stale >= 20) return { level: "high", ratio };
  if (ratio >= 0.05 || stale >= 5) return { level: "medium", ratio };
  return { level: "low", ratio };
}

export interface LakeFreshness {
  code: { level: StaleSeverity; ratio: number };
  doc: { level: StaleSeverity; ratio: number };
  /** The worse of the two lanes. One clean lane must not lift the pair a band. */
  worst: StaleSeverity;
}

/** Grade both lanes of a lake, and the pair. Every renderer reads this one grade. */
export function lakeFreshness(lake: {
  discovered_source_files: number;
  stale_source_files: number;
  discovered_doc_files: number;
  stale_doc_files: number;
}): LakeFreshness {
  const code = staleSeverity(lake.stale_source_files, lake.discovered_source_files);
  const doc = staleSeverity(lake.stale_doc_files, lake.discovered_doc_files);
  return { code, doc, worst: worstSeverity(code.level, doc.level) };
}

/** Render a lane ratio. A ratio under 1% reads `<1%`, never `0%`. */
export function stalePercent(ratio: number): string {
  if (ratio > 0 && ratio < 0.01) return "<1%";
  return `${(ratio * 100).toFixed(0)}%`;
}

/** Render a count in at most four characters. A missing count reads `?`. */
export function compactCount(value: number): string {
  if (!Number.isFinite(value)) return "?";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}
