/**
 * How this process re-invokes itself.
 *
 * A compiled binary is its own entry: `process.execPath` is lore, and
 * `process.argv[1]` is the virtual path `/$bunfs/root/lore`. A source run is
 * bun plus the CLI script in argv[1]. Tests and other bun entrypoints are
 * neither — they must not be written into a hook or spawned as lore.
 */
import { realpathSync } from "node:fs";

export interface LoreInvoke {
  command: string;
  args: string[];
}

/** Quote a value for POSIX sh. Safe tokens stay bare so a pasted hook line
 *  still reads as `lore ingest --queue`. */
export function shellQuote(value: string): string {
  if (value.length > 0 && !/[^A-Za-z0-9_./:=+-]/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The argv this process should use to run a lore subcommand.
 *
 * `argv1` is treated as the CLI script only when it is a real file that
 * names the CLI entry. A compiled binary, a test file, and a missing path
 * all fall through to `execPath` plus the subcommand.
 */
export function loreInvoke(execPath = process.execPath, argv1 = process.argv[1]): LoreInvoke {
  if (execPath.endsWith("/lore") || execPath.endsWith("\\lore")) {
    return { command: execPath, args: [] };
  }
  if (argv1 && isCliEntryScript(argv1)) {
    return { command: execPath, args: [argv1] };
  }
  return { command: "lore", args: [] };
}

export function loreInvokeArgv(subcommand: string[], invoke = loreInvoke()): string[] {
  return [invoke.command, ...invoke.args, ...subcommand];
}

function isCliEntryScript(argv1: string): boolean {
  try {
    realpathSync(argv1);
  } catch {
    return false;
  }
  return argv1.endsWith("/cli/src/index.ts");
}
