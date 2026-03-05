import { expect, test } from "bun:test";
import { LoreEngine } from "./index.ts";
import { createTempDir, removeDir } from "../../test/support/db.ts";

test("cloneLoreMindConfig copies the entire source config stanza into the current lore mind", async () => {
  const loreRoot = createTempDir("lore-root-");
  const sourcePath = createTempDir("lore-src-");
  const targetPath = createTempDir("lore-dst-");

  const engine = new LoreEngine({ lore_root: loreRoot });
  try {
    await engine.register(sourcePath, "source");
    await engine.register(targetPath, "target");

    engine.setLoreMindConfig("ai.generation.model", "qwen3:14b", { codePath: sourcePath });
    engine.setLoreMindConfig("thresholds.dangling_days", 9, { codePath: sourcePath });
    engine.setLoreMindConfig("rrf.k", 11, { codePath: targetPath });

    const sourceConfigBefore = engine.getLoreMindConfig({ codePath: sourcePath }).config;
    expect(sourceConfigBefore).toBeDefined();
    expect((sourceConfigBefore as { rrf?: { k?: number } }).rrf?.k).toBeUndefined();

    const result = engine.cloneLoreMindConfig("source", { codePath: targetPath });
    expect(result).toEqual({
      source: "source",
      target: "target",
      hasConfig: true,
    });

    const targetConfigAfter = engine.getLoreMindConfig({ codePath: targetPath }).config;
    expect(targetConfigAfter).toEqual(sourceConfigBefore);
  } finally {
    engine.shutdown();
    removeDir(loreRoot);
    removeDir(sourcePath);
    removeDir(targetPath);
  }
});

test("cloneLoreMindConfig clears current lore mind overrides when source lore mind has no config stanza", async () => {
  const loreRoot = createTempDir("lore-root-");
  const sourcePath = createTempDir("lore-src-");
  const targetPath = createTempDir("lore-dst-");

  const engine = new LoreEngine({ lore_root: loreRoot });
  try {
    await engine.register(sourcePath, "source");
    await engine.register(targetPath, "target");

    engine.setLoreMindConfig("ai.generation.model", "qwen3:14b", { codePath: targetPath });
    expect(engine.getLoreMindConfig({ codePath: targetPath }).config).toBeDefined();

    const result = engine.cloneLoreMindConfig("source", { codePath: targetPath });
    expect(result).toEqual({
      source: "source",
      target: "target",
      hasConfig: false,
    });

    const targetAfter = engine.getLoreMindConfig({ codePath: targetPath }).config;
    expect(targetAfter).toBeUndefined();
  } finally {
    engine.shutdown();
    removeDir(loreRoot);
    removeDir(sourcePath);
    removeDir(targetPath);
  }
});
