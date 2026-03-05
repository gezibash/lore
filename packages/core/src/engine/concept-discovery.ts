import type { Database } from "bun:sqlite";
import { getConcepts, insertConcept, insertEdge } from "@/db/index.ts";
import { insertConceptVersion } from "@/db/concepts.ts";
import { assignChunkToConcept } from "@/db/chunks.ts";
import { recomputeGraph } from "./graph.ts";
import type { Generator } from "./generator.ts";
import { readChunk } from "@/storage/index.ts";
import { getChunk } from "@/db/index.ts";

export async function discoverConcepts(db: Database, generator: Generator): Promise<void> {
  // Recompute graph: clustering, lore_residual, edges, cache, manifest
  const result = recomputeGraph(db);
  if (!result) return; // Need at least 2 chunks to cluster

  const { membersByCluster, chunkIds, embeddings, chunkCluster, A_hybrid, graphVersion } = result;

  // Get existing concepts (with freshly-updated cluster assignments from recomputeGraph)
  const existingConcepts = getConcepts(db);

  // For clusters with no existing concept match, create a new concept.
  // This handles orphan chunks that aren't owned by any concept yet.
  const coveredClusters = new Set<number>();
  for (const existing of existingConcepts) {
    if (existing.active_chunk_id && chunkCluster.has(existing.active_chunk_id)) {
      coveredClusters.add(chunkCluster.get(existing.active_chunk_id)!);
    }
  }

  const clusterConcepts = new Map<number, string>(); // cluster -> representative concept id

  // Identify orphan clusters and name them in parallel
  type OrphanCluster = { clusterIdx: number; members: number[]; contents: string[] };
  const orphans: OrphanCluster[] = [];

  for (const [clusterIdx, members] of membersByCluster) {
    // Find an existing concept in this cluster to use as representative for edges
    let representative: string | null = null;
    for (const existing of existingConcepts) {
      if (existing.active_chunk_id && chunkCluster.get(existing.active_chunk_id) === clusterIdx) {
        representative = existing.id;
        break;
      }
    }

    if (representative) {
      clusterConcepts.set(clusterIdx, representative);
    } else if (!coveredClusters.has(clusterIdx)) {
      // Orphan cluster — collect content for naming
      const contents: string[] = [];
      for (const memberIdx of members.slice(0, 3)) {
        const chunkId = chunkIds[memberIdx]!;
        const chunkRow = getChunk(db, chunkId);
        if (chunkRow) {
          const parsed = await readChunk(chunkRow.file_path);
          contents.push(parsed.content.slice(0, 500));
        }
      }
      orphans.push({ clusterIdx, members: [...members], contents });
    }
  }

  // Name all orphan clusters in parallel
  const orphanNames = await Promise.all(
    orphans.map((o) =>
      o.contents.length > 0
        ? generator.nameCluster(o.contents)
        : Promise.resolve(`cluster-${o.clusterIdx}`),
    ),
  );

  // Create concepts for orphan clusters
  for (let idx = 0; idx < orphans.length; idx++) {
    const { clusterIdx, members } = orphans[idx]!;
    const name = orphanNames[idx]!;

    const concept = insertConcept(db, name, { cluster: clusterIdx });
    const representative = concept.id;

    // Find most representative chunk (closest to centroid)
    const memberEmbeddings = members.map((i) => embeddings[i]!);
    const dim = memberEmbeddings[0]!.length;
    const centroid = new Float32Array(dim);
    for (const emb of memberEmbeddings) {
      for (let i = 0; i < dim; i++) centroid[i] = centroid[i]! + emb[i]!;
    }
    for (let i = 0; i < dim; i++) centroid[i] = centroid[i]! / memberEmbeddings.length;

    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < memberEmbeddings.length; i++) {
      const emb = memberEmbeddings[i]!;
      let dist = 0;
      for (let d = 0; d < dim; d++) {
        const diff = emb[d]! - centroid[d]!;
        dist += diff * diff;
      }
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }

    const activeChunkId = chunkIds[members[bestIdx]!]!;
    insertConceptVersion(db, concept.id, { cluster: clusterIdx, active_chunk_id: activeChunkId });

    // Assign orphan chunks to new concept
    for (const memberIdx of members) {
      assignChunkToConcept(db, chunkIds[memberIdx]!, concept.id);
    }

    clusterConcepts.set(clusterIdx, representative);
  }

  // Build edges between orphan clusters and all other clusters
  // (recomputeGraph already built edges between existing-concept clusters)
  if (orphans.length > 0) {
    const orphanClusterSet = new Set(orphans.map((o) => o.clusterIdx));
    for (const [cluster1, conceptId1] of clusterConcepts) {
      for (const [cluster2, conceptId2] of clusterConcepts) {
        if (cluster1 >= cluster2) continue;
        // Only build if at least one side is an orphan cluster
        if (!orphanClusterSet.has(cluster1) && !orphanClusterSet.has(cluster2)) continue;

        const members1 = membersByCluster.get(cluster1)!;
        const members2 = membersByCluster.get(cluster2)!;

        let sumSim = 0;
        let count = 0;
        for (const i of members1) {
          for (const j of members2) {
            sumSim += A_hybrid.get(i, j);
            count++;
          }
        }
        const alpha = count > 0 ? sumSim / count : 0;
        if (alpha > 0.1) {
          insertEdge(db, conceptId1, conceptId2, alpha, graphVersion);
        }
      }
    }
  }
}
