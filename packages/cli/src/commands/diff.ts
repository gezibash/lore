import type { WorkerClient } from "@lore/worker";
import { timeAgo, computeLineDiff, isDiffTooLarge } from "@lore/worker";
import { emit } from "../output.ts";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";

export async function diffCommand(client: WorkerClient, target: string): Promise<void> {
  // Commit range: main~2..main
  const rangeMatch = target.match(/^(.+)\.\.(.+)$/);
  if (rangeMatch) {
    const [, fromRef, toRef] = rangeMatch;
    const diff = await client.diffCommits(fromRef!, toRef!, { includeContent: true });

    const lines: string[] = [];
    lines.push(`${BOLD}Tree diff: ${fromRef} → ${toRef}${RESET}\n`);

    if (diff.narrative) {
      lines.push(`${BOLD}Narrative:${RESET} ${CYAN}${diff.narrative.name}${RESET} — ${diff.narrative.intent}`);
      lines.push(`${DIM}${diff.narrative.entryCount} journal entries${RESET}\n`);
    }

    if (diff.lifecycleEvents && diff.lifecycleEvents.length > 0) {
      lines.push(`${BOLD}Lifecycle Events:${RESET}`);
      for (const evt of diff.lifecycleEvents) {
        lines.push(
          `  ${YELLOW}${evt.type}:${RESET} ${evt.description} ${DIM}(${timeAgo(evt.committedAt)})${RESET}`,
        );
      }
      lines.push("");
    }

    if (diff.added.length > 0) {
      for (const a of diff.added) {
        lines.push(`${GREEN}+ ${a.conceptName}${RESET}`);
        if (a.newContent) {
          const preview = a.newContent.split("\n").slice(0, 10);
          for (const line of preview) {
            lines.push(`  ${GREEN}+${line}${RESET}`);
          }
          if (a.newContent.split("\n").length > 10) {
            lines.push(`  ${DIM}...${RESET}`);
          }
        } else if (a.contentPreview) {
          lines.push(
            `  ${DIM}${a.contentPreview.slice(0, 120)}${a.contentPreview.length > 120 ? "..." : ""}${RESET}`,
          );
        }
      }
    }
    if (diff.removed.length > 0) {
      for (const r of diff.removed) {
        lines.push(`${RED}- ${r.conceptName}${RESET}`);
      }
    }
    if (diff.modified.length > 0) {
      for (const m of diff.modified) {
        const delta =
          m.lengthDelta != null
            ? ` ${DIM}(${m.lengthDelta >= 0 ? "+" : ""}${m.lengthDelta} chars)${RESET}`
            : "";
        lines.push(`${CYAN}~ ${m.conceptName}${RESET}${delta}`);
        if (m.oldContent != null && m.newContent != null) {
          if (m.oldContent === m.newContent) {
            lines.push(`  ${DIM}No content changes${RESET}`);
          } else if (isDiffTooLarge(m.oldContent, m.newContent)) {
            lines.push(`  ${DIM}Content too large for inline diff${RESET}`);
            if (m.contentPreview) {
              lines.push(
                `  ${DIM}${m.contentPreview.slice(0, 120)}${m.contentPreview.length > 120 ? "..." : ""}${RESET}`,
              );
            }
          } else {
            const hunks = computeLineDiff(m.oldContent, m.newContent);
            for (const hunk of hunks) {
              lines.push(`  ${CYAN}@@ old:${hunk.oldStart} new:${hunk.newStart} @@${RESET}`);
              for (const line of hunk.lines) {
                if (line.type === "add") {
                  lines.push(`  ${GREEN}+${line.text}${RESET}`);
                } else if (line.type === "remove") {
                  lines.push(`  ${RED}-${line.text}${RESET}`);
                } else {
                  lines.push(`  ${DIM} ${line.text}${RESET}`);
                }
              }
            }
          }
        } else if (m.contentPreview) {
          lines.push(
            `  ${DIM}${m.contentPreview.slice(0, 120)}${m.contentPreview.length > 120 ? "..." : ""}${RESET}`,
          );
        }
      }
    }

    if (
      diff.added.length === 0 &&
      diff.removed.length === 0 &&
      diff.modified.length === 0 &&
      (!diff.lifecycleEvents || diff.lifecycleEvents.length === 0)
    ) {
      lines.push(`${DIM}No changes${RESET}`);
    }

    emit({ kind: "commit-range", fromRef, toRef, diff }, () => lines.join("\n"));
    return;
  }

  // Narrative dry-run: show what close would produce
  const { narrative, plan } = await client.dryRunClose(target);

  const lines: string[] = [];
  lines.push(`${BOLD}Dry-run preview for narrative '${narrative.name}'${RESET}`);
  lines.push(`${DIM}${narrative.entry_count} journal entries analyzed${RESET}\n`);

  if (plan.updates.length > 0) {
    lines.push(`${BOLD}Updates:${RESET}`);
    for (const u of plan.updates) {
      lines.push(`  ${CYAN}~ ${u.conceptName}${RESET}`);
      lines.push(`    ${DIM}${u.newContent.slice(0, 120)}...${RESET}`);
    }
  }

  if (plan.creates.length > 0) {
    lines.push(`${BOLD}New concepts:${RESET}`);
    for (const c of plan.creates) {
      lines.push(`  ${GREEN}+ ${c.conceptName}${RESET}`);
      lines.push(`    ${DIM}${c.content.slice(0, 120)}...${RESET}`);
    }
  }

  if (plan.updates.length === 0 && plan.creates.length === 0) {
    lines.push(`${DIM}No changes to integrate${RESET}`);
  }

  emit({ kind: "dry-run", target, narrative, plan }, () => lines.join("\n"));
}
