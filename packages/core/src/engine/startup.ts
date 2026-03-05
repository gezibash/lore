import type { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { getManifest, getOpenNarratives } from "@/db/index.ts";
import { mainDir, journalDir } from "@/storage/index.ts";

interface EmbedderHealthLike {
  healthCheck: () => Promise<boolean>;
}

export interface HealthReport {
  dbOk: boolean;
  aiOk: boolean;
  lore_minds: Array<{
    name: string;
    loreExists: boolean;
    manifestOk: boolean;
    openNarratives: number;
  }>;
}

export async function healthCheck(
  db: Database,
  embedder: EmbedderHealthLike,
): Promise<HealthReport> {
  const aiOk = await embedder.healthCheck();

  const manifest = getManifest(db);
  const openNarrativesList = getOpenNarratives(db);

  return {
    dbOk: true,
    aiOk,
    lore_minds: [
      {
        name: "current",
        loreExists: true,
        manifestOk: manifest != null,
        openNarratives: openNarrativesList.length,
      },
    ],
  };
}

export async function verifyIntegrity(
  db: Database,
  lorePath: string,
): Promise<{ ok: boolean; issues: string[] }> {
  const issues: string[] = [];

  // Verify main dir exists
  if (!existsSync(mainDir(lorePath))) {
    issues.push("main/ directory missing");
  }

  // Verify open narratives have journal dirs
  const openNarratives = getOpenNarratives(db);
  for (const narrative of openNarratives) {
    const jDir = journalDir(lorePath, narrative.name);
    if (!existsSync(jDir)) {
      issues.push(`Journal directory missing for narrative '${narrative.name}'`);
    }
  }

  return { ok: issues.length === 0, issues };
}
