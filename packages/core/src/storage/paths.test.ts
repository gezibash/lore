import { test, expect } from "bun:test";
import { writeFileSync, mkdirSync } from "fs";
import { basename, join } from "path";
import { createTempDir, removeDir } from "../../test/support/db.ts";
import {
  mainDir,
  deltaDir,
  journalDir,
  stateChunkFile,
  journalChunkFile,
  listChunkFiles,
  listDeltaDirs,
} from "./paths.ts";

test("path helpers compose expected directories and files", () => {
  const root = "/tmp/lore-mind";
  expect(mainDir(root)).toBe(join(root, "main"));
  expect(deltaDir(root, "alpha")).toBe(join(root, "delta", "alpha"));
  expect(journalDir(root, "alpha")).toBe(join(root, "delta", "alpha", "journal"));
  expect(stateChunkFile(root, "abc")).toBe(join(root, "main", "abc.md"));
  expect(journalChunkFile(root, "delta", "id")).toBe(
    join(root, "delta", "delta", "journal", "id.md"),
  );
});

test("listChunkFiles filters and sorts markdown", async () => {
  const root = createTempDir();

  const base = join(root, "main");
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, "b.md"), "x");
  writeFileSync(join(base, "a.md"), "x");
  writeFileSync(join(base, "notes.txt"), "x");

  const files = await listChunkFiles(base);
  expect(files.map((f) => basename(f))).toEqual(["a.md", "b.md"]);

  removeDir(root);
});

test("listDeltaDirs returns delta directories only", async () => {
  const root = createTempDir();

  const deltaRoot = join(root, "delta");
  mkdirSync(join(deltaRoot, "one"), { recursive: true });
  mkdirSync(join(deltaRoot, "two"), { recursive: true });
  writeFileSync(join(deltaRoot, "file.md"), "x");

  const dirs = await listDeltaDirs(root);
  expect(dirs.sort()).toEqual(["one", "two"]);

  removeDir(root);
});
