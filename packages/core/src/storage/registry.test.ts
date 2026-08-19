import { expect, test } from "bun:test";
import {
  addLoreMind,
  findLoreMindByCodePath,
  findLoreMindByExactPath,
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

test("findLoreMindByCodePath returns the exact root match when present", () => {
  const reg = {
    lore_minds: {
      lore: {
        code_path: "/tmp/project",
        lore_path: "/tmp/.lore/project",
        registered_at: "2026-03-07T00:00:00.000Z",
      },
    },
  };

  expect(findLoreMindByCodePath(reg, "/tmp/project")).toEqual({
    name: "lore",
    entry: reg.lore_minds.lore,
  });
});

test("findLoreMindByCodePath resolves a child directory to the registered parent", () => {
  const reg = {
    lore_minds: {
      lore: {
        code_path: "/tmp/project",
        lore_path: "/tmp/.lore/project",
        registered_at: "2026-03-07T00:00:00.000Z",
      },
    },
  };

  expect(findLoreMindByCodePath(reg, "/tmp/project/skills/lore")).toEqual({
    name: "lore",
    entry: reg.lore_minds.lore,
  });
});

test("findLoreMindByCodePath prefers the nearest registered parent for nested lores", () => {
  const reg = {
    lore_minds: {
      parent: {
        code_path: "/tmp/project",
        lore_path: "/tmp/.lore/project",
        registered_at: "2026-03-07T00:00:00.000Z",
      },
      child: {
        code_path: "/tmp/project/packages/core",
        lore_path: "/tmp/.lore/project-core",
        registered_at: "2026-03-07T00:00:00.000Z",
      },
    },
  };

  expect(findLoreMindByCodePath(reg, "/tmp/project/packages/core/src")).toEqual({
    name: "child",
    entry: reg.lore_minds.child,
  });
});

test("findLoreMindByExactPath does not resolve a child to its registered parent", () => {
  const reg = {
    lore_minds: {
      parent: {
        code_path: "/tmp/project",
        lore_path: "/tmp/.lore/project",
        registered_at: "2026-08-19T00:00:00.000Z",
      },
    },
  };

  // ancestor matching is right for resolving a cwd...
  expect(findLoreMindByCodePath(reg, "/tmp/project/fixture/nested")).not.toBeNull();
  // ...and wrong for deciding whether a path is already registered
  expect(findLoreMindByExactPath(reg, "/tmp/project/fixture/nested")).toBeNull();
  expect(findLoreMindByExactPath(reg, "/tmp/project")).toEqual({
    name: "parent",
    entry: reg.lore_minds.parent,
  });
});
