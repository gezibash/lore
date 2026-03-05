import type { TextChunk } from "@/types/index.ts";
import type { LoreConfig } from "@/types/index.ts";

// Approximate token count: ~4 chars per token
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

interface HeadingNode {
  level: number;
  text: string;
  startLine: number;
}

/**
 * Heading-aware markdown chunker ported from QMD.
 * Splits on headings with squared-distance decay scoring.
 * Protects code fences from being split.
 */
export function chunkMarkdown(text: string, config: LoreConfig): TextChunk[] {
  const targetTokens = config.chunking.target_tokens;
  const overlapFraction = config.chunking.overlap;

  const lines = text.split("\n");
  if (lines.length === 0) return [];

  // Find all headings and code fences
  const headings: HeadingNode[] = [];
  const fenceRanges: Array<{ start: number; end: number }> = [];
  let inFence = false;
  let fenceStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.match(/^```/)) {
      if (inFence) {
        fenceRanges.push({ start: fenceStart, end: i });
        inFence = false;
      } else {
        inFence = true;
        fenceStart = i;
      }
      continue;
    }

    if (!inFence) {
      const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
      if (headingMatch) {
        headings.push({
          level: headingMatch[1]!.length,
          text: headingMatch[2]!.trim(),
          startLine: i,
        });
      }
    }
  }

  // Close unclosed fence
  if (inFence) {
    fenceRanges.push({ start: fenceStart, end: lines.length - 1 });
  }

  function isInFence(lineNum: number): boolean {
    return fenceRanges.some((r) => lineNum >= r.start && lineNum <= r.end);
  }

  // Find split points — heading lines not inside code fences
  // Score them by heading level using squared distance decay
  const splitPoints: Array<{ line: number; score: number; heading: HeadingNode }> = [];
  for (const h of headings) {
    if (!isInFence(h.startLine)) {
      // Higher level headings (h1=1) get higher score (more likely split point)
      const score = (7 - h.level) ** 2;
      splitPoints.push({ line: h.startLine, score, heading: h });
    }
  }

  // Build sections between split points
  const sections: Array<{
    startLine: number;
    endLine: number;
    headings: string[];
  }> = [];

  const breakpoints = [0, ...splitPoints.map((sp) => sp.line), lines.length];
  for (let i = 0; i < breakpoints.length - 1; i++) {
    const start = breakpoints[i]!;
    const end = breakpoints[i + 1]!;
    const activeHeadings = headings.filter((h) => h.startLine <= start).map((h) => h.text);
    sections.push({ startLine: start, endLine: end, headings: activeHeadings });
  }

  // Merge small sections and split large ones
  const chunks: TextChunk[] = [];
  let currentLines: string[] = [];
  let currentHeadings: string[] = [];

  for (const section of sections) {
    const sectionLines = lines.slice(section.startLine, section.endLine);
    const sectionText = sectionLines.join("\n");
    const sectionTokens = estimateTokens(sectionText);

    if (
      currentLines.length > 0 &&
      estimateTokens(currentLines.join("\n")) + sectionTokens > targetTokens
    ) {
      // Flush current chunk
      const content = currentLines.join("\n").trim();
      if (content.length > 0) {
        chunks.push({
          content,
          headings: [...currentHeadings],
          tokenCount: estimateTokens(content),
        });
      }

      // Overlap: keep last N% of lines
      const overlapLines = Math.floor(currentLines.length * overlapFraction);
      currentLines = currentLines.slice(-overlapLines);
      currentHeadings = [...section.headings];
    }

    currentLines.push(...sectionLines);
    if (section.headings.length > 0) {
      currentHeadings = [...section.headings];
    }
  }

  // Flush remaining
  const remaining = currentLines.join("\n").trim();
  if (remaining.length > 0) {
    chunks.push({
      content: remaining,
      headings: currentHeadings,
      tokenCount: estimateTokens(remaining),
    });
  }

  return chunks;
}
