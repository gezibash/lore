import type { WorkerClient } from "@lore/worker";
import { emit, isJsonOutput } from "../output.ts";
import { confirmOrAbort } from "../tty.ts";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";

function pad(str: string, width: number): string {
  return str.padEnd(width);
}

export async function mindsListCommand(client: WorkerClient): Promise<void> {
  const loreMinds = await client.listLoreMinds();
  emit(loreMinds, (rows) => {
    if (rows.length === 0) {
      return `${DIM}No lores registered yet. Run 'lore init'.${RESET}`;
    }
    const lines: string[] = [];
    lines.push(`${DIM}${pad("NAME", 20)}${pad("CODE PATH", 40)}LORE PATH${RESET}`);
    for (const loreMind of rows) {
      lines.push(
        `${CYAN}${pad(loreMind.name, 20)}${RESET}${pad(loreMind.code_path, 40)}${DIM}${loreMind.lore_path}${RESET}`,
      );
    }
    return lines.join("\n");
  });
}

export async function mindsRemoveCommand(
  client: WorkerClient,
  name: string,
  force: boolean = false,
): Promise<void> {
  const loreMinds = await client.listLoreMinds();
  const loreMind = loreMinds.find((lore) => lore.name === name);
  if (!loreMind) {
    throw new Error(`No lore registered with name '${name}'`);
  }

  if (!force && !isJsonOutput()) {
    console.log(`${BOLD}Will remove:${RESET}`);
    console.log(`  Name:          ${CYAN}${loreMind.name}${RESET}`);
    console.log(`  Code path:     ${loreMind.code_path}`);
    console.log(`  Lore data: ${loreMind.lore_path}`);
    console.log(`\n${RED}This will delete all Lore data for this lore.${RESET}`);
  }

  const confirmed = await confirmOrAbort({
    prompt: "Continue? [y/N] ",
    accept: (answer) => answer.toLowerCase() === "y",
    force,
    forceHint: "Pass --force to remove a lore when stdin is not a TTY.",
  });
  if (!confirmed) {
    emit({ aborted: true }, () => "Aborted.");
    return;
  }

  await client.removeLoreMind(name, true);
  emit({ removed: name }, () => `${GREEN}✓${RESET} Removed lore '${name}'`);
}

export async function mindResetCommand(
  client: WorkerClient,
  force: boolean = false,
): Promise<void> {
  if (!force && !isJsonOutput()) {
    console.log(
      `${RED}${BOLD}This will wipe all Lore data (DB, concepts, narratives) for the current lore.${RESET}`,
    );
    console.log(`${DIM}The lore stays registered — only lore data is deleted.${RESET}`);
  }

  const confirmed = await confirmOrAbort({
    prompt: "\nType 'reset' to confirm: ",
    accept: (answer) => answer === "reset",
    force,
    forceHint: "Pass --force to reset a lore when stdin is not a TTY.",
  });
  if (!confirmed) {
    emit({ aborted: true }, () => "Aborted.");
    return;
  }

  const { name } = await client.resetLoreMind();
  emit({ reset: name }, () => `${GREEN}✓${RESET} Reset lore '${name}' — all data wiped`);
}
