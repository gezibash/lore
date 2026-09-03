/**
 * Update check and self upgrade.
 *
 * The check never delays a command. It reads a cache file and prints at most
 * one line. When the cache is old, it starts a detached child that refreshes
 * the cache for the next run.
 *
 * The upgrade runs install.sh from the tag it installs. That script already
 * handles the parts that matter: it verifies the checksum, and it keeps the
 * binary, lib/ and migrations/ together. A release is a directory, not one
 * file, so a single file swap would remove the native libraries.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loreInvoke, loreInvokeArgv } from "./self-invoke.ts";

const REPO = "gezibash/lore";
const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

const CACHE_PATH = join(homedir(), ".lore", "update-check.json");

type UpdateCache = { checked_at: number; latest: string };

/** The user turns the check off with this variable. */
export function updateCheckDisabled(): boolean {
  const value = process.env.LORE_NO_UPDATE_CHECK;
  return value !== undefined && value !== "" && value !== "0" && value !== "false";
}

function readCache(): UpdateCache | null {
  try {
    const raw = JSON.parse(readFileSync(CACHE_PATH, "utf-8")) as Partial<UpdateCache>;
    if (typeof raw.checked_at !== "number" || typeof raw.latest !== "string") return null;
    return { checked_at: raw.checked_at, latest: raw.latest };
  } catch {
    return null;
  }
}

function writeCache(cache: UpdateCache): void {
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(cache));
  } catch {
    // A cache that cannot be written costs one API call on the next run.
  }
}

/** Strip a leading v and drop any build metadata. */
function normalize(version: string): string {
  return version.trim().replace(/^v/, "").split("+")[0]!;
}

/**
 * Compare two semantic versions. Returns true when `candidate` is newer.
 * A prerelease loses against the same release, which keeps a stable build
 * from offering a downgrade.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = normalize(candidate);
  const b = normalize(current);
  const [aCore, aPre] = a.split("-", 2) as [string, string | undefined];
  const [bCore, bPre] = b.split("-", 2) as [string, string | undefined];
  const an = aCore.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const bn = bCore.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = an[i] ?? 0;
    const y = bn[i] ?? 0;
    if (x !== y) return x > y;
  }
  if (aPre && !bPre) return false;
  if (!aPre && bPre) return true;
  if (aPre && bPre) return aPre > bPre;
  return false;
}

/** Ask GitHub for the latest release tag. Returns null when the call fails. */
export async function fetchLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch(LATEST_RELEASE_API, {
      headers: { accept: "application/vnd.github+json", "user-agent": "lore-update-check" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { tag_name?: unknown };
    return typeof body.tag_name === "string" ? normalize(body.tag_name) : null;
  } catch {
    return null;
  }
}

/** Refresh the cache. The hidden `sys update-check` command calls this. */
export async function refreshUpdateCache(): Promise<string | null> {
  const latest = await fetchLatestVersion();
  if (!latest) return null;
  writeCache({ checked_at: Date.now(), latest });
  return latest;
}

/** The child that refreshes the update cache. Same self-detection as the hook. */
export function updateCheckSpawnArgs(
  execPath = process.execPath,
  argv1 = process.argv[1],
): { command: string; args: string[] } {
  const [command, ...args] = loreInvokeArgv(
    ["sys", "update-check", "--refresh"],
    loreInvoke(execPath, argv1),
  );
  return { command: command as string, args };
}

/** Start a detached child that refreshes the cache, then forget about it. */
function startBackgroundRefresh(): void {
  try {
    const { command, args } = updateCheckSpawnArgs();
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, LORE_NO_UPDATE_CHECK: "1" },
    });
    child.unref();
  } catch {
    // A refresh that cannot start leaves the old cache in place.
  }
}

/**
 * The notice for this run, or null.
 *
 * This reads the cache only. It starts a background refresh when the cache is
 * old, so the command it runs inside never waits for the network.
 */
export function updateNotice(currentVersion: string): string | null {
  if (updateCheckDisabled()) return null;

  const cache = readCache();
  if (!cache || Date.now() - cache.checked_at > CHECK_INTERVAL_MS) {
    startBackgroundRefresh();
  }
  if (!cache) return null;
  if (!isNewerVersion(cache.latest, currentVersion)) return null;

  return `Update available: ${normalize(currentVersion)} → ${cache.latest}. Run 'lore upgrade'.`;
}

/** The prefix the running binary is installed under, or null when unknown. */
export function installPrefix(execPath: string): string | null {
  // install.sh writes <prefix>/lib/lore/lore.
  const libDir = dirname(execPath);
  const lib = dirname(libDir);
  const prefix = dirname(lib);
  return libDir.endsWith("/lore") && lib.endsWith("/lib") ? prefix : null;
}

export type UpgradeResult =
  | { ok: true; version: string }
  | { ok: false; reason: string; alreadyLatest?: boolean };

/**
 * Install the latest release over this one.
 *
 * The script comes from the same tag as the build it installs, so the two
 * always agree.
 */
export async function runUpgrade(
  currentVersion: string,
  opts: { execPath?: string; log?: (line: string) => void } = {},
): Promise<UpgradeResult> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const execPath = opts.execPath ?? process.execPath;

  const prefix = installPrefix(execPath);
  if (!prefix) {
    return {
      ok: false,
      reason: "This lore does not come from a release. Use git to update a source checkout.",
    };
  }

  const latest = await fetchLatestVersion();
  if (!latest) return { ok: false, reason: "Could not reach GitHub to read the latest release." };

  writeCache({ checked_at: Date.now(), latest });

  if (!isNewerVersion(latest, currentVersion)) {
    return {
      ok: false,
      reason: `Already on the latest release (${normalize(currentVersion)}).`,
      alreadyLatest: true,
    };
  }

  log(`Upgrading ${normalize(currentVersion)} → ${latest}`);

  const scriptUrl = `https://raw.githubusercontent.com/${REPO}/v${latest}/install.sh`;
  let script: string;
  try {
    const res = await fetch(scriptUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return { ok: false, reason: `Could not read install.sh for v${latest}.` };
    script = await res.text();
  } catch {
    return { ok: false, reason: `Could not read install.sh for v${latest}.` };
  }

  const scriptPath = join(tmpdir(), `lore-install-${process.pid}.sh`);
  try {
    writeFileSync(scriptPath, script, { mode: 0o700 });
    const result = spawnSync("sh", [scriptPath], {
      stdio: "inherit",
      env: { ...process.env, LORE_PREFIX: prefix, LORE_VERSION: `v${latest}` },
    });
    if (result.status !== 0) return { ok: false, reason: "install.sh failed." };
  } finally {
    if (existsSync(scriptPath)) rmSync(scriptPath, { force: true });
  }

  return { ok: true, version: latest };
}
