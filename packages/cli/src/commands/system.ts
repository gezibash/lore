import type { WorkerClient } from "@lore/worker";
import { describeSchemaIssue } from "@lore/worker";

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
  const { applied } = client.migrate();
  if (applied === 0) {
    console.log(`${DIM}0 migrations applied — database is up to date${RESET}`);
  } else {
    console.log(`${GREEN}${applied} migration${applied === 1 ? "" : "s"} applied${RESET}`);
  }
}

export async function systemMigrateStatusCommand(client: WorkerClient): Promise<void> {
  const { applied, pending } = client.migrateStatus();

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
  const result = client.repair({ check });

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
