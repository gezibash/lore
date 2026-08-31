import type { WorkerClient } from "@lore/worker";
import { describeSchemaIssue, formatBytes } from "@lore/worker";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";

function pad(str: string, width: number): string {
  return str.padEnd(width);
}

export async function systemMigrateCommand(client: WorkerClient): Promise<void> {
  const { applied } = await client.migrate();
  if (applied === 0) {
    console.log(`${DIM}0 migrations applied — database is up to date${RESET}`);
  } else {
    console.log(`${GREEN}${applied} migration${applied === 1 ? "" : "s"} applied${RESET}`);
  }
}

export async function systemMigrateStatusCommand(client: WorkerClient): Promise<void> {
  const { applied, pending } = await client.migrateStatus();

  console.log(`${BOLD}Applied migrations${RESET}`);
  if (applied.length === 0) {
    console.log(`  ${DIM}(none)${RESET}`);
  } else {
    console.log(`  ${DIM}${pad("NAME", 30)}APPLIED AT${RESET}`);
    for (const m of applied) {
      console.log(`  ${CYAN}${pad(m.name, 30)}${RESET}${DIM}${m.applied_at}${RESET}`);
    }
  }

  if (pending.length > 0) {
    console.log(`\n${BOLD}${YELLOW}Pending migrations${RESET}`);
    for (const name of pending) {
      console.log(`  ${YELLOW}${name}${RESET}`);
    }
  }
}

export async function systemRepairCommand(client: WorkerClient, check?: boolean): Promise<void> {
  const result = await client.repair({ check });

  console.log(`${BOLD}Repair summary${RESET}`);
  console.log(`  ${DIM}mode:${RESET} ${result.mode}`);
  console.log(
    `  ${DIM}canonical migrations:${RESET} ${result.canonical_target.migration_names.length}`,
  );
  console.log(
    `  ${DIM}canonical digest:${RESET} ${result.canonical_target.migration_digest.slice(0, 12)}`,
  );
  console.log(`  ${DIM}migrations applied:${RESET} ${result.migrations_applied}`);
  console.log(`  ${DIM}migrations reconciled:${RESET} ${result.migrations_reconciled}`);
  console.log(`  ${DIM}issues found:${RESET} ${result.issues_found.length}`);
  console.log(`  ${DIM}fixed:${RESET} ${result.fixed.length}`);
  console.log(`  ${DIM}remaining:${RESET} ${result.remaining.length}`);

  if (result.fixed.length > 0) {
    console.log(`\n${BOLD}${GREEN}Fixed${RESET}`);
    for (const issue of result.fixed) {
      console.log(`  ${GREEN}•${RESET} ${describeSchemaIssue(issue)}`);
    }
  }

  if (result.remaining.length > 0) {
    console.log(`\n${BOLD}${YELLOW}Remaining issues${RESET}`);
    for (const issue of result.remaining) {
      console.log(`  ${YELLOW}•${RESET} ${describeSchemaIssue(issue)}`);
    }
    throw new Error(
      result.mode === "check" ? "Schema drift detected" : "Repair completed with unresolved issues",
    );
  }

  if (result.mode === "check") {
    console.log(`\n${GREEN}No schema drift detected.${RESET}`);
    return;
  }

  if (
    result.fixed.length === 0 &&
    result.migrations_applied === 0 &&
    result.migrations_reconciled === 0
  ) {
    console.log(`\n${DIM}No repair actions were necessary.${RESET}`);
  } else {
    console.log(`\n${GREEN}Schema repair completed successfully.${RESET}`);
    console.log(`${DIM}If data outputs still look stale, run: lore mind rebuild${RESET}`);
  }
}

export async function systemPruneCommand(client: WorkerClient, check?: boolean): Promise<void> {
  const result = await client.pruneOrphans({ check });

  console.log(`${BOLD}Orphaned rows${RESET}`);
  console.log(`  ${DIM}mode:${RESET} ${result.mode}`);
  for (const [table, count] of Object.entries(result.orphans)) {
    const color = count > 0 ? YELLOW : DIM;
    console.log(`  ${DIM}${pad(table, 20)}${RESET}${color}${count}${RESET}`);
  }
  console.log(`  ${DIM}${pad("total", 20)}${RESET}${result.total}`);

  // The search index is the second store a delete leaves behind. Lance keeps
  // every version of a table it rewrites, so it is reported beside the rows.
  const lanceReclaimed = result.lance_bytes_before - result.lance_bytes_after;
  console.log(`\n${BOLD}Search index${RESET}`);
  console.log(`  ${DIM}${pad("on disk", 20)}${RESET}${formatBytes(result.lance_bytes_before)}`);
  const supersededColor = result.lance_superseded_bytes > 0 ? YELLOW : DIM;
  console.log(
    `  ${DIM}${pad("superseded", 20)}${RESET}` +
      `${supersededColor}${formatBytes(result.lance_superseded_bytes)}${RESET}`,
  );

  if (result.mode === "apply" && lanceReclaimed > 0) {
    console.log(
      `  ${DIM}${pad("reclaimed", 20)}${RESET}${GREEN}${formatBytes(lanceReclaimed)}${RESET}`,
    );
  }

  if (result.total === 0) {
    console.log(`\n${GREEN}No orphaned rows.${RESET}`);
    return;
  }

  if (result.mode === "check") {
    console.log(`\n${YELLOW}Run 'lore sys prune' to delete them.${RESET}`);
    return;
  }

  const reclaimed = result.db_bytes_before - result.db_bytes_after;
  console.log(
    `\n${GREEN}${result.total} row${result.total === 1 ? "" : "s"} deleted${RESET} ` +
      `${DIM}(${formatBytes(result.db_bytes_before)} → ${formatBytes(result.db_bytes_after)}, ` +
      `${formatBytes(reclaimed)} reclaimed)${RESET}`,
  );
}

export async function systemVacuumCommand(client: WorkerClient): Promise<void> {
  const result = await client.vacuum();

  console.log(`${BOLD}Vacuum summary${RESET}`);
  console.log(`  ${DIM}before:${RESET} ${formatBytes(result.file_bytes_before)}`);
  console.log(`  ${DIM}after:${RESET} ${formatBytes(result.file_bytes_after)}`);
  console.log(`  ${DIM}reclaimed:${RESET} ${formatBytes(result.reclaimed_bytes)}`);

  if (result.reclaimed_bytes === 0) {
    console.log(`\n${DIM}The file held no free pages worth reclaiming.${RESET}`);
    return;
  }
  console.log(`\n${GREEN}Reclaimed ${formatBytes(result.reclaimed_bytes)}.${RESET}`);
}
