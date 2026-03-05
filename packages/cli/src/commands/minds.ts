import type { WorkerClient } from "@lore/worker";
import { formatError } from "../formatters.ts";

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
  const loreMinds = client.listLoreMinds();

  if (loreMinds.length === 0) {
    console.log(`${DIM}No lores registered yet. Run 'lore init'.${RESET}`);
    return;
  }

  const lines: string[] = [];
  lines.push(`${DIM}${pad("NAME", 20)}${pad("CODE PATH", 40)}LORE PATH${RESET}`);
  for (const loreMind of loreMinds) {
    lines.push(
      `${CYAN}${pad(loreMind.name, 20)}${RESET}${pad(loreMind.code_path, 40)}${DIM}${loreMind.lore_path}${RESET}`,
    );
  }
  console.log(lines.join("\n"));
}

export async function mindsRemoveCommand(
  client: WorkerClient,
  name: string,
  force: boolean = false,
): Promise<void> {
  const loreMinds = client.listLoreMinds();
  const loreMind = loreMinds.find((lore) => lore.name === name);
  if (!loreMind) {
    console.log(formatError(`No lore registered with name '${name}'`));
    process.exit(1);
  }

  if (!force) {
    console.log(`${BOLD}Will remove:${RESET}`);
    console.log(`  Name:          ${CYAN}${loreMind.name}${RESET}`);
    console.log(`  Code path:     ${loreMind.code_path}`);
    console.log(`  Lore data: ${loreMind.lore_path}`);
    console.log(`\n${RED}This will delete all Lore data for this lore.${RESET}`);

    process.stdout.write("Continue? [y/N] ");
    const answer = await new Promise<string>((resolve) => {
      process.stdin.setEncoding("utf-8");
      process.stdin.once("data", (data) => resolve(String(data).trim()));
    });
    if (answer.toLowerCase() !== "y") {
      console.log("Aborted.");
      return;
    }
  }

  client.removeLoreMind(name, true);
  console.log(`${GREEN}✓${RESET} Removed lore '${name}'`);
}

export async function mindResetCommand(
  client: WorkerClient,
  force: boolean = false,
): Promise<void> {
  if (!force) {
    console.log(
      `${RED}${BOLD}This will wipe all Lore data (DB, concepts, deltas) for the current lore mind.${RESET}`,
    );
    console.log(`${DIM}The lore mind will stay registered — only lore data is deleted.${RESET}`);

    process.stdout.write("\nType 'reset' to confirm: ");
    const answer = await new Promise<string>((resolve) => {
      process.stdin.setEncoding("utf-8");
      process.stdin.once("data", (data) => resolve(String(data).trim()));
    });
    if (answer !== "reset") {
      console.log("Aborted.");
      return;
    }
  }

  const { name } = client.resetLoreMind();
  console.log(`${GREEN}✓${RESET} Reset lore mind '${name}' — all data wiped`);
}
