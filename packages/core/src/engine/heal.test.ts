import { expect, test } from "bun:test";
import { createHash } from "crypto";
import { join } from "path";
import { resolveConfig } from "@/config/index.ts";
import { insertConceptRaw } from "@/db/concepts.ts";
import { insertChunk } from "@/db/chunks.ts";
import { insertEmbedding } from "@/db/embeddings.ts";
import { getConcept } from "@/db/index.ts";
import { writeStateChunk } from "@/storage/index.ts";
import { writeTextFile } from "../../test/support/files.ts";
import { createTestDb, createTempDir, removeDir } from "../../test/support/db.ts";
import { healConcept, planHealConcept } from "./heal.ts";

/**
 * Heal is an evidence-producing action: it verifies each drifted binding
 * against the symbol's current body and re-verifies only the ones the
 * verifier accepts; e_embed is re-measured; R(c) is whatever falls out. The
 * old heal wrote staleness/residual down by formula — nothing here may move
 * without a reason the report can name.
 */
test("heal re-verifies only verifier-accepted drifted bindings and re-measures R(c)", async () => {
  const db = createTestDb();
  const codePath = createTempDir("lore-heal-code-");
  const lorePath = createTempDir("lore-heal-lore-");
  try {
    const config = resolveConfig();
    const source = [
      "export function login() {", // sym-a: lines 1-2
      "  return token();",
      "}",
      "export function logout() {", // sym-b: lines 4-5
      "  clear();",
      "}",
    ].join("\n");
    writeTextFile(join(codePath, "src/auth.ts"), source);
    // Same content hash as on disk → rescan is a no-op and the fixture stands.
    const contentHash = createHash("sha256").update(source).digest("hex");
    db.run(
      `INSERT INTO source_files (id, file_path, language, content_hash, size_bytes, symbol_count, scanned_at)
       VALUES ('sf-1', 'src/auth.ts', 'typescript', ?, ?, 2, '2026-01-01')`,
      [contentHash, source.length],
    );
    for (const [id, name, start, end] of [
      ["sym-a", "login", 1, 2],
      ["sym-b", "logout", 4, 5],
    ] as const) {
      db.run(
        `INSERT INTO symbols (id, source_file_id, name, qualified_name, kind, line_start, line_end, body_hash, scanned_at)
         VALUES (?, 'sf-1', ?, ?, 'function', ?, ?, ?, '2026-01-01')`,
        [id, name, name, start, end, `new-${id}`],
      );
    }

    const conceptId = "c-auth";
    insertConceptRaw(db, conceptId, "auth-flow", { activeChunkId: null });
    const chunk = await writeStateChunk({
      lorePath,
      concept: "auth-flow",
      conceptId,
      narrativeOrigin: "n-0",
      version: 1,
      content: "login issues a token; logout clears it.",
    });
    insertChunk(db, {
      id: chunk.id,
      filePath: chunk.filePath,
      flType: "chunk",
      conceptId,
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    db.run("UPDATE concepts SET active_chunk_id = ? WHERE id = ?", [chunk.id, conceptId]);
    insertEmbedding(db, chunk.id, new Float32Array([1, 0, 0]), config.ai.embedding.model);

    // Both bindings drifted: bound at old hashes, symbols now at new ones.
    for (const sym of ["sym-a", "sym-b"]) {
      db.run(
        `INSERT INTO concept_symbols (id, concept_id, symbol_id, binding_type, confidence, bound_body_hash, bound_body, created_at, updated_at)
         VALUES (?, ?, ?, 'ref', 1.0, ?, 'old body', '2026-01-01', '2026-01-01')`,
        [`cs-${sym}`, conceptId, sym, `old-${sym}`],
      );
    }

    const before = getConcept(db, conceptId)!;
    const plan = planHealConcept(db, before, config.thresholds.staleness_days);
    expect(plan.from_residual).toBe(1); // 2/2 drifted
    expect(plan.bindings_still_drifted).toBe(2);
    expect(plan.e_embed_measured).toBe(false);

    const verified: string[] = [];
    const outcome = await healConcept(
      {
        db,
        config,
        codePath,
        // Text lane: every body embeds to the same vector as the prose → e_embed 0.
        embedder: {
          embed: async () => new Float32Array([1, 0, 0]),
          embedBatch: async (texts: string[]) => texts.map(() => new Float32Array([1, 0, 0])),
        } as never,
        codeEmbedder: null,
        generator: {
          verifyBindingStillAccurate: async (input: { symbolName: string }) => {
            verified.push(input.symbolName);
            return input.symbolName === "login"
              ? { accurate: true, reason: "token issuance unchanged" }
              : { accurate: false, reason: "logout no longer clears the session" };
          },
        } as never,
      },
      conceptId,
    );

    expect(outcome).not.toBeNull();
    expect(verified.sort()).toEqual(["login", "logout"]); // every drifted binding was checked
    expect(outcome!.bindings_verified).toBe(1);
    expect(outcome!.bindings_still_drifted).toBe(1);
    expect(outcome!.still_drifted_reasons).toEqual(["logout: logout no longer clears the session"]);
    expect(outcome!.e_embed).toBeCloseTo(0);
    expect(outcome!.from_residual).toBe(1);
    expect(outcome!.to_residual).toBeCloseTo(0.5); // e_drift 1/2, e_embed 0
    expect(outcome!.to_staleness).toBeCloseTo(0.5); // σ = e_drift for bound concepts

    const rows = db
      .query<{ symbol_id: string; bound_body_hash: string }, [string]>(
        "SELECT symbol_id, bound_body_hash FROM concept_symbols WHERE concept_id = ? ORDER BY symbol_id",
      )
      .all(conceptId);
    expect(rows).toEqual([
      { symbol_id: "sym-a", bound_body_hash: "new-sym-a" }, // re-verified
      { symbol_id: "sym-b", bound_body_hash: "old-sym-b" }, // still drifted, untouched
    ]);

    const after = getConcept(db, conceptId)!;
    expect(after.ground_residual).toBeCloseTo(0);
    expect(after.residual).toBeCloseTo(0.5); // the R(c) cache
  } finally {
    removeDir(codePath);
    removeDir(lorePath);
  }
});
