import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { setGlobalConfigValue } from "./index.ts";

test("a global write keeps every other key, including the api key", () => {
  const root = mkdtempSync(join(tmpdir(), "lore-global-"));
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "config.json"),
    JSON.stringify({
      ai: {
        generation: { provider: "openrouter", model: "old/model", api_key: "sk-keep-me" },
        embedding: { model: "qwen3-embedding:8b" },
      },
      chunking: { target_tokens: 900 },
    }),
  );

  setGlobalConfigValue(root, "ai.generation.model", "z-ai/glm-5.3-flash");

  const after = JSON.parse(readFileSync(join(root, "config.json"), "utf-8"));
  expect(after.ai.generation.model).toBe("z-ai/glm-5.3-flash");
  expect(after.ai.generation.api_key).toBe("sk-keep-me");
  expect(after.ai.generation.provider).toBe("openrouter");
  expect(after.ai.embedding.model).toBe("qwen3-embedding:8b");
  expect(after.chunking.target_tokens).toBe(900);
});

test("a global write creates the file when none exists", () => {
  const root = mkdtempSync(join(tmpdir(), "lore-global-"));
  setGlobalConfigValue(root, "ai.generation.provider", "gateway");
  const after = JSON.parse(readFileSync(join(root, "config.json"), "utf-8"));
  expect(after).toEqual({ ai: { generation: { provider: "gateway" } } });
});
