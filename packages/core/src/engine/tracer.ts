/**
 * Lightweight tracing using the Web Performance API (performance.mark/measure).
 * Zero dependencies — built into Bun/Node/browsers.
 *
 * Usage:
 *   const span = tracer.span("embed-batch");
 *   await doWork();
 *   span.end();
 *   tracer.summary();  // prints tree
 */

interface SpanRecord {
  name: string;
  parent: string | null;
  startMark: string;
  endMark: string | null;
  duration: number | null;
  children: SpanRecord[];
}

export class Tracer {
  private spans: SpanRecord[] = [];
  private stack: SpanRecord[] = [];
  private counter = 0;
  private enabled: boolean;

  constructor(enabled = true) {
    this.enabled = enabled;
  }

  span(name: string): { end: () => void } {
    if (!this.enabled) return { end: () => {} };

    const id = this.counter++;
    const startMark = `fl:${name}:${id}:start`;
    const endMark = `fl:${name}:${id}:end`;

    performance.mark(startMark);

    const parent = this.stack.length > 0 ? this.stack[this.stack.length - 1]! : null;
    const record: SpanRecord = {
      name,
      parent: parent?.name ?? null,
      startMark,
      endMark,
      duration: null,
      children: [],
    };

    if (parent) {
      parent.children.push(record);
    } else {
      this.spans.push(record);
    }

    this.stack.push(record);

    return {
      end: () => {
        performance.mark(endMark);
        const measure = performance.measure(`fl:${name}:${id}`, startMark, endMark);
        record.endMark = endMark;
        record.duration = measure.duration;
        const idx = this.stack.indexOf(record);
        if (idx !== -1) this.stack.splice(idx, 1);
      },
    };
  }

  summary(): string {
    const lines: string[] = [];
    const printTree = (records: SpanRecord[], depth: number) => {
      for (const r of records) {
        const indent = "  ".repeat(depth);
        const ms = r.duration != null ? `${r.duration.toFixed(0)}ms` : "?";
        lines.push(`${indent}${r.name} ${ms}`);
        if (r.children.length > 0) {
          printTree(r.children, depth + 1);
        }
      }
    };
    printTree(this.spans, 0);
    return lines.join("\n");
  }

  reset(): void {
    this.spans = [];
    this.stack = [];
    this.counter = 0;
    performance.clearMarks();
    performance.clearMeasures();
  }
}

/** Global tracer instance — disabled by default, enable via LORE_TRACE=1 */
export const tracer = new Tracer(typeof process !== "undefined" && process.env.LORE_TRACE === "1");

// ── Ask pipeline trace ────────────────────────────────────────────────────────
import { writeFileSync } from "fs";
import { join } from "path";

/**
 * JSONL trace logger for the ask() pipeline.
 * Activated when LORE_ASK_TRACE=1 is set in the environment.
 * Writes one JSON object per line to <lorePath>/ask-trace.ndjson (overwritten on each call).
 *
 * Usage:
 *   const t = new AskTracer(lorePath);
 *   t.log("lane.text", { candidates: 42, top10: [...] });
 *   t.flush();
 */
export class AskTracer {
  private readonly events: object[] = [];
  readonly outputPath: string;
  private readonly startMs: number;

  constructor(lorePath: string, id: string) {
    this.outputPath = join(lorePath, `ask-trace-${id}.ndjson`);
    this.startMs = Date.now();
  }

  log(stage: string, data: Record<string, unknown>): void {
    this.events.push({
      ts: new Date().toISOString(),
      elapsed_ms: Date.now() - this.startMs,
      stage,
      ...data,
    });
  }

  flush(): void {
    const content = this.events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    writeFileSync(this.outputPath, content, "utf8");
  }
}
