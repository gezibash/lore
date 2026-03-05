/**
 * Minimal line-level diff using LCS (longest common subsequence).
 * No external dependencies. Produces unified-style hunks.
 */

export interface DiffLine {
  type: "context" | "add" | "remove";
  text: string;
}

export interface DiffHunk {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

const MAX_LINES = 500;

/**
 * Compute line-level diff between two texts.
 * Returns hunks with context lines (default 3).
 * If either text exceeds MAX_LINES, returns empty array (caller should fall back to summary).
 */
export function computeLineDiff(
  oldText: string,
  newText: string,
  contextLines: number = 3,
): DiffHunk[] {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  if (oldLines.length > MAX_LINES || newLines.length > MAX_LINES) {
    return [];
  }

  const lcs = computeLCS(oldLines, newLines);
  const rawDiff = buildRawDiff(oldLines, newLines, lcs);
  return groupIntoHunks(rawDiff, contextLines);
}

/**
 * Returns true if the diff is too large for inline display.
 */
export function isDiffTooLarge(oldText: string, newText: string): boolean {
  const oldCount = oldText.split("\n").length;
  const newCount = newText.split("\n").length;
  return oldCount > MAX_LINES || newCount > MAX_LINES;
}

// ─── LCS ──────────────────────────────────────────────

function computeLCS(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  // dp[i][j] = length of LCS of a[0..i-1] and b[0..j-1]
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array.from({ length: n + 1 }, () => 0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }

  return dp;
}

interface RawDiffLine {
  type: "context" | "add" | "remove";
  text: string;
  oldLineNo: number; // 1-based, 0 if not applicable
  newLineNo: number; // 1-based, 0 if not applicable
}

function buildRawDiff(oldLines: string[], newLines: string[], dp: number[][]): RawDiffLine[] {
  const result: RawDiffLine[] = [];
  let i = oldLines.length;
  let j = newLines.length;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.push({ type: "context", text: oldLines[i - 1]!, oldLineNo: i, newLineNo: j });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      result.push({ type: "add", text: newLines[j - 1]!, oldLineNo: 0, newLineNo: j });
      j--;
    } else {
      result.push({ type: "remove", text: oldLines[i - 1]!, oldLineNo: i, newLineNo: 0 });
      i--;
    }
  }

  result.reverse();
  return result;
}

function groupIntoHunks(rawDiff: RawDiffLine[], contextLines: number): DiffHunk[] {
  // Find change ranges (indices into rawDiff that are add/remove)
  const changeIndices: number[] = [];
  for (let i = 0; i < rawDiff.length; i++) {
    if (rawDiff[i]!.type !== "context") {
      changeIndices.push(i);
    }
  }

  if (changeIndices.length === 0) return [];

  // Group changes into hunks with context
  const hunks: DiffHunk[] = [];
  let hunkStart = Math.max(0, changeIndices[0]! - contextLines);
  let hunkEnd = Math.min(rawDiff.length - 1, changeIndices[0]! + contextLines);

  for (let ci = 1; ci < changeIndices.length; ci++) {
    const nextStart = Math.max(0, changeIndices[ci]! - contextLines);
    const nextEnd = Math.min(rawDiff.length - 1, changeIndices[ci]! + contextLines);

    if (nextStart <= hunkEnd + 1) {
      // Merge with current hunk
      hunkEnd = nextEnd;
    } else {
      // Emit current hunk and start new
      hunks.push(buildHunk(rawDiff, hunkStart, hunkEnd));
      hunkStart = nextStart;
      hunkEnd = nextEnd;
    }
  }

  // Emit final hunk
  hunks.push(buildHunk(rawDiff, hunkStart, hunkEnd));
  return hunks;
}

function buildHunk(rawDiff: RawDiffLine[], start: number, end: number): DiffHunk {
  let oldStart = 0;
  let newStart = 0;

  // Find the first line number for old/new
  for (let i = start; i <= end; i++) {
    const line = rawDiff[i]!;
    if (oldStart === 0 && line.oldLineNo > 0) oldStart = line.oldLineNo;
    if (newStart === 0 && line.newLineNo > 0) newStart = line.newLineNo;
    if (oldStart > 0 && newStart > 0) break;
  }

  // If we still don't have a start, use 1
  if (oldStart === 0) oldStart = 1;
  if (newStart === 0) newStart = 1;

  const lines: DiffLine[] = [];
  for (let i = start; i <= end; i++) {
    const line = rawDiff[i]!;
    lines.push({ type: line.type, text: line.text });
  }

  return { oldStart, newStart, lines };
}
