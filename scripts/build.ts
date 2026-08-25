/**
 * Build a distributable lore.
 *
 * `bun build --compile` produces one executable, but two native pieces cannot
 * travel inside it. sqlite-vec finds its loadable extension by walking up from
 * its own package directory, which does not exist inside a compiled bundle,
 * and the SQLite that Bun embeds is built without extension loading at all.
 * Both are copied into `dist/lib/`, where connection.ts looks first.
 */
import { mkdirSync, copyFileSync, existsSync, readdirSync, statSync, rmSync } from "fs";
import { dirname, join } from "path";
import { getLoadablePath } from "sqlite-vec";

const ROOT = dirname(import.meta.dir);
const DIST = join(ROOT, "dist");
const LIB = join(DIST, "lib");

const SQLITE_CANDIDATES = [
  "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
  "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
];

function mb(path: string): string {
  return `${(statSync(path).size / 1024 / 1024).toFixed(1)} MB`;
}

rmSync(DIST, { recursive: true, force: true });
mkdirSync(LIB, { recursive: true });

const binary = join(DIST, "lore");
await Bun.$`bun build --compile --minify --outfile ${binary} ${join(ROOT, "packages/cli/src/index.ts")}`.quiet();
console.log(`lore            ${mb(binary)}`);

// sqlite-vec keeps its extension in a per-platform package and knows how to
// find it; asking it beats reconstructing the platform naming here.
const suffix =
  process.platform === "darwin" ? "dylib" : process.platform === "win32" ? "dll" : "so";
const vec = getLoadablePath();
const vecOut = join(LIB, `vec0.${suffix}`);
copyFileSync(vec, vecOut);
console.log(`lib/vec0.${suffix}    ${mb(vecOut)}`);

if (process.platform === "darwin") {
  const sqlite = SQLITE_CANDIDATES.find((path) => existsSync(path));
  if (!sqlite) {
    // Without it the binary still runs, but only where Homebrew SQLite exists.
    console.warn("libsqlite3.dylib not found — binary will need Homebrew SQLite at runtime");
  } else {
    const out = join(LIB, "libsqlite3.dylib");
    copyFileSync(sqlite, out);
    console.log(`lib/libsqlite3.dylib  ${mb(out)}`);
  }
}

// Migrations are data files; the bundler has no reason to include them and
// migrator.ts falls back to this copy.
const migrationsSrc = join(ROOT, "packages/core/src/db/migrations");
const migrationsOut = join(DIST, "migrations");
mkdirSync(migrationsOut, { recursive: true });
let migrationCount = 0;
for (const entry of readdirSync(migrationsSrc)) {
  if (!entry.endsWith(".sql")) continue;
  copyFileSync(join(migrationsSrc, entry), join(migrationsOut, entry));
  migrationCount++;
}
console.log(`migrations/     ${migrationCount} files`);

console.log(`\ndist/ is self-contained. Run it from anywhere: ${binary}`);
