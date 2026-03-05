import { expect, test } from "bun:test";
import {
  addLoreMind,
  getProviderConfig,
  listProviderConfigs,
  loadRegistry,
  removeLoreMind,
  updateProviderConfig,
} from "./registry.ts";
import { createTempDir, removeDir } from "../../test/support/db.ts";

test("provider credential helpers set, list, and unset credentials", () => {
  const root = createTempDir("lore-registry-");
  try {
    let reg = loadRegistry(root);
    expect(reg.providers).toBeUndefined();

    reg = updateProviderConfig(root, reg, "openrouter", {
      api_key: "sk-test",
      base_url: "https://openrouter.ai/api/v1",
    });
    expect(getProviderConfig(reg, "openrouter")).toEqual({
      api_key: "sk-test",
      base_url: "https://openrouter.ai/api/v1",
    });
    expect(listProviderConfigs(reg)).toEqual([
      {
        provider: "openrouter",
        config: {
          api_key: "sk-test",
          base_url: "https://openrouter.ai/api/v1",
        },
      },
    ]);

    reg = updateProviderConfig(root, reg, "openrouter", undefined);
    expect(getProviderConfig(reg, "openrouter")).toBeUndefined();
    expect(reg.providers).toBeUndefined();
  } finally {
    removeDir(root);
  }
});

test("lore mind add and remove preserve provider credential stanzas", () => {
  const root = createTempDir("lore-registry-");
  try {
    let reg = loadRegistry(root);
    reg = updateProviderConfig(root, reg, "openrouter", {
      api_key: "sk-shared",
    });

    reg = addLoreMind(root, reg, "demo", "/tmp/code", "/tmp/lore");
    expect(getProviderConfig(reg, "openrouter")).toEqual({
      api_key: "sk-shared",
    });

    reg = removeLoreMind(root, reg, "demo");
    expect(getProviderConfig(reg, "openrouter")).toEqual({
      api_key: "sk-shared",
    });
  } finally {
    removeDir(root);
  }
});
