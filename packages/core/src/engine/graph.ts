import type { Database } from "bun:sqlite";
import { Matrix, EigenvalueDecomposition } from "ml-matrix";
import { ulid } from "ulid";
import { getAllEmbeddings } from "@/db/embeddings.ts";
import {
  getConcepts,
  getActiveConcepts,
  insertConceptVersion,
  getActiveConceptCount,
} from "@/db/concepts.ts";
import { getConceptRelations } from "@/db/concept-relations.ts";
import { insertEdge } from "@/db/edges.ts";
import { upsertLaplacianCache } from "@/db/laplacian.ts";
import { getManifest, upsertManifest } from "@/db/manifest.ts";
import { getChunkCount } from "@/db/chunks.ts";
import { computeTotalDebt, computeComponentDebt, computeDebtTrend } from "./residuals.ts";
import type { ConceptRow } from "@/types/index.ts";

/**
 * Compute pairwise cosine similarity from embedding blobs.
 * Input: array of Float32Array embeddings.
 * Output: n×n similarity matrix.
 */
export function pairwiseCosineSimilarity(embeddings: Float32Array[]): Matrix {
  const n = embeddings.length;
  const sim = Matrix.zeros(n, n);

  // Pre-compute norms
  const norms = embeddings.map((e) => {
    let sum = 0;
    for (let i = 0; i < e.length; i++) sum += e[i]! * e[i]!;
    return Math.sqrt(sum);
  });

  for (let i = 0; i < n; i++) {
    sim.set(i, i, 1.0);
    for (let j = i + 1; j < n; j++) {
      let dot = 0;
      const a = embeddings[i]!;
      const b = embeddings[j]!;
      for (let k = 0; k < a.length; k++) dot += a[k]! * b[k]!;
      const cos = norms[i]! > 0 && norms[j]! > 0 ? dot / (norms[i]! * norms[j]!) : 0;
      sim.set(i, j, cos);
      sim.set(j, i, cos);
    }
  }

  return sim;
}

/**
 * Build an n×n relation matrix R from typed edge entries.
 * Symmetrized: R[i][j] = R[j][i] = max weight across duplicate pairs.
 * Self-loops are skipped.
 */
export function buildRelationMatrix(
  n: number,
  entries: Array<{ fromIdx: number; toIdx: number; weight: number }>,
): Matrix {
  const R = Matrix.zeros(n, n);
  for (const { fromIdx, toIdx, weight } of entries) {
    if (fromIdx === toIdx) continue;
    if (fromIdx < 0 || fromIdx >= n || toIdx < 0 || toIdx >= n) continue;
    const current = R.get(fromIdx, toIdx);
    const w = Math.max(current, weight);
    R.set(fromIdx, toIdx, w);
    R.set(toIdx, fromIdx, w);
  }
  return R;
}

/** Embedding similarity weight in the hybrid adjacency blend. */
export const RELATION_BLEND_ALPHA = 0.8;

/**
 * Blend embedding-similarity adjacency A with relation matrix R.
 * Returns: alpha * A + (1 - alpha) * R
 * Both matrices must have the same dimensions.
 */
export function blendAdjacency(A: Matrix, R: Matrix, alpha: number): Matrix {
  const n = A.rows;
  const result = Matrix.zeros(n, n);
  const beta = 1 - alpha;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      result.set(i, j, alpha * A.get(i, j) + beta * R.get(i, j));
    }
  }
  return result;
}

/**
 * Build the graph Laplacian L = D - A where A is the similarity matrix
 * and D is the degree matrix.
 */
export function buildLaplacian(A: Matrix): Matrix {
  const n = A.rows;
  const L = Matrix.zeros(n, n);

  for (let i = 0; i < n; i++) {
    let degree = 0;
    for (let j = 0; j < n; j++) {
      if (i !== j) {
        const w = Math.max(0, A.get(i, j)); // clip negative similarities
        L.set(i, j, -w);
        degree += w;
      }
    }
    L.set(i, i, degree);
  }

  return L;
}

/**
 * Extract a sub-matrix of A indexed by the given row/column indices.
 * Used to compute per-cluster Fiedler values from the global adjacency.
 */
function buildSubMatrix(A: Matrix, indices: number[]): Matrix {
  const n = indices.length;
  const sub = Matrix.zeros(n, n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      sub.set(i, j, A.get(indices[i]!, indices[j]!));
    }
  }
  return sub;
}

export interface FiedlerResult {
  fiedlerValue: number;
  fiedlerVector: number[];
  eigenvalues: Float64Array;
  eigenvectors: Matrix;
  /** Eigenvalue indices sorted ascending by eigenvalue */
  sortedIndices: number[];
}

/**
 * Compute eigendecomposition of the Laplacian.
 * The Fiedler value is the second-smallest eigenvalue (algebraic connectivity).
 * The Fiedler vector is the corresponding eigenvector — used for spectral clustering.
 */
export function computeFiedler(L: Matrix): FiedlerResult {
  const eig = new EigenvalueDecomposition(L);
  const realEigenvalues = eig.realEigenvalues;
  const eigenvectorMatrix = eig.eigenvectorMatrix;

  // Sort by eigenvalue
  const indexed = realEigenvalues.map((val, idx) => ({ val, idx }));
  indexed.sort((a, b) => a.val - b.val);

  const sortedIndices = indexed.map((x) => x.idx);

  // Fiedler = second smallest eigenvalue
  const fiedlerIdx = indexed.length >= 2 ? indexed[1]!.idx : 0;
  const fiedlerValue = indexed.length >= 2 ? indexed[1]!.val : 0;
  const fiedlerVector: number[] = [];
  for (let i = 0; i < eigenvectorMatrix.rows; i++) {
    fiedlerVector.push(eigenvectorMatrix.get(i, fiedlerIdx));
  }

  return {
    fiedlerValue,
    fiedlerVector,
    eigenvalues: Float64Array.from(realEigenvalues),
    eigenvectors: eigenvectorMatrix,
    sortedIndices,
  };
}

export interface ClusterResult {
  labels: number[];
  clusterCount: number;
  membersByCluster: Map<number, number[]>;
}

/**
 * K-means++ initialization: pick k centroids with probability proportional
 * to squared distance from nearest existing centroid.
 */
function kMeansPlusPlusInit(points: number[][], k: number): number[][] {
  const n = points.length;
  const dim = points[0]!.length;
  const centroids: number[][] = [];

  // Pick first centroid randomly
  centroids.push(points[Math.floor(Math.random() * n)]!.slice());

  for (let c = 1; c < k; c++) {
    // Compute squared distance from each point to nearest centroid
    const dists = new Float64Array(n);
    let totalDist = 0;
    for (let i = 0; i < n; i++) {
      let minDist = Infinity;
      for (const centroid of centroids) {
        let d = 0;
        for (let j = 0; j < dim; j++) {
          const diff = points[i]![j]! - centroid[j]!;
          d += diff * diff;
        }
        if (d < minDist) minDist = d;
      }
      dists[i] = minDist;
      totalDist += minDist;
    }

    // Pick next centroid with probability proportional to distance
    let r = Math.random() * totalDist;
    for (let i = 0; i < n; i++) {
      r -= dists[i]!;
      if (r <= 0) {
        centroids.push(points[i]!.slice());
        break;
      }
    }
    // Edge case: if we didn't pick (floating point), pick last
    if (centroids.length === c) {
      centroids.push(points[n - 1]!.slice());
    }
  }

  return centroids;
}

/**
 * K-means clustering with k-means++ initialization.
 * Returns labels array (0..k-1) for each point.
 */
export function kMeans(points: number[][], k: number, maxIter = 50): number[] {
  const n = points.length;
  const dim = points[0]!.length;

  if (k >= n) {
    return Array.from({ length: n }, (_, i) => i);
  }

  const centroids = kMeansPlusPlusInit(points, k);
  let labels = Array.from({ length: n }, () => 0);

  for (let iter = 0; iter < maxIter; iter++) {
    // Assign each point to nearest centroid
    const newLabels = Array.from({ length: n }, () => 0);
    for (let i = 0; i < n; i++) {
      let bestDist = Infinity;
      let bestLabel = 0;
      for (let c = 0; c < k; c++) {
        let d = 0;
        for (let j = 0; j < dim; j++) {
          const diff = points[i]![j]! - centroids[c]![j]!;
          d += diff * diff;
        }
        if (d < bestDist) {
          bestDist = d;
          bestLabel = c;
        }
      }
      newLabels[i] = bestLabel;
    }

    // Check convergence
    let changed = false;
    for (let i = 0; i < n; i++) {
      if (newLabels[i] !== labels[i]) {
        changed = true;
        break;
      }
    }
    labels = newLabels;
    if (!changed) break;

    // Recompute centroids
    const counts = Array.from({ length: k }, () => 0);
    for (let c = 0; c < k; c++) {
      for (let j = 0; j < dim; j++) {
        centroids[c]![j] = 0;
      }
    }
    for (let i = 0; i < n; i++) {
      const c = labels[i]!;
      counts[c]!++;
      for (let j = 0; j < dim; j++) {
        centroids[c]![j]! += points[i]![j]!;
      }
    }
    for (let c = 0; c < k; c++) {
      if (counts[c]! > 0) {
        for (let j = 0; j < dim; j++) {
          centroids[c]![j]! /= counts[c]!;
        }
      }
    }
  }

  return labels;
}

/**
 * K-way spectral clustering using eigengap heuristic and k-means.
 * Falls back to 2-way Fiedler bisection when eigengap is trivial.
 */
export function spectralClustering(L: Matrix, maxClusters?: number): ClusterResult {
  const n = L.rows;
  if (n <= 1) {
    return {
      labels: Array(n).fill(0) as number[],
      clusterCount: 1,
      membersByCluster: new Map([[0, n === 1 ? [0] : []]]),
    };
  }

  const fiedler = computeFiedler(L);
  const { sortedIndices, eigenvectors } = fiedler;

  // Sorted eigenvalues in ascending order
  const sortedEigenvalues = sortedIndices.map((idx) => fiedler.eigenvalues[idx]!);

  // --- Eigengap heuristic to determine k ---
  const upperBound = maxClusters ?? Math.floor(n / 2);
  const kMax = Math.min(Math.max(2, upperBound), n);

  let bestGap = -1;
  let bestK = 2;
  // Look at gaps between eigenvalue i and i+1, for i = 1..kMax-1
  // (skip gap at 0 since first eigenvalue is always ~0 for connected graphs)
  for (let i = 1; i < kMax && i < n - 1; i++) {
    const gap = sortedEigenvalues[i + 1]! - sortedEigenvalues[i]!;
    if (gap > bestGap) {
      bestGap = gap;
      bestK = i + 1;
    }
  }

  // If largest gap is trivially small, fall back to k=2
  if (bestGap < 0.1) {
    bestK = 2;
  }

  const k = Math.max(2, Math.min(bestK, kMax));

  // --- Build n×k spectral embedding from first k eigenvectors ---
  const embedding: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row: number[] = [];
    for (let j = 0; j < k; j++) {
      row.push(eigenvectors.get(i, sortedIndices[j]!));
    }
    // Row-normalize to unit length
    let norm = 0;
    for (let j = 0; j < k; j++) norm += row[j]! * row[j]!;
    norm = Math.sqrt(norm);
    if (norm > 1e-10) {
      for (let j = 0; j < k; j++) row[j]! /= norm;
    }
    embedding.push(row);
  }

  // --- K-means on spectral embedding ---
  const labels = kMeans(embedding, k);

  // --- Build membersByCluster ---
  const membersByCluster = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const label = labels[i]!;
    if (!membersByCluster.has(label)) {
      membersByCluster.set(label, []);
    }
    membersByCluster.get(label)!.push(i);
  }

  // Renumber clusters to be contiguous 0..clusterCount-1
  const clusterIds = [...membersByCluster.keys()].sort((a, b) => a - b);
  const renumbered = new Map<number, number[]>();
  const renumberMap = new Map<number, number>();
  clusterIds.forEach((id, idx) => {
    renumberMap.set(id, idx);
    renumbered.set(idx, membersByCluster.get(id)!);
  });
  const renumberedLabels = labels.map((l) => renumberMap.get(l)!);

  return {
    labels: renumberedLabels,
    clusterCount: renumbered.size,
    membersByCluster: renumbered,
  };
}

// ─── Recompute Graph ──────────────────────────────────────

export interface RecomputeGraphResult {
  membersByCluster: Map<number, number[]>;
  chunkIds: string[];
  embeddings: Float32Array[];
  chunkCluster: Map<string, number>;
  chunkIdToIndex: Map<string, number>;
  A_hybrid: Matrix;
  graphVersion: string;
}

/**
 * Recompute the concept graph from stored embeddings and curated relations.
 * Updates cluster assignments, lore_residual, edges, Laplacian cache, and manifest.
 * Pure DB operation — no LLM calls, no disk reads.
 * Returns intermediate data for callers that need it (e.g. orphan cluster detection),
 * or null if there aren't enough embeddings to compute.
 */
export function recomputeGraph(db: Database): RecomputeGraphResult | null {
  const rows = getAllEmbeddings(db, "chunk");
  if (rows.length < 2) return null;

  const embeddings = rows.map((r) => new Float32Array(r.embedding.buffer));
  const chunkIds = rows.map((r) => r.chunk_id);

  // Build similarity matrix
  const A = pairwiseCosineSimilarity(embeddings);

  // Blend curated relations into the adjacency matrix
  const chunkIdToIndex = new Map<string, number>(chunkIds.map((id, i) => [id, i]));
  const activeConcepts = getActiveConcepts(db);
  const conceptToIdx = new Map<string, number>();
  for (const c of activeConcepts) {
    if (c.active_chunk_id) {
      const idx = chunkIdToIndex.get(c.active_chunk_id);
      if (idx !== undefined) conceptToIdx.set(c.id, idx);
    }
  }
  const relRows = getConceptRelations(db);
  const relEntries = relRows.flatMap((r) => {
    const fromIdx = conceptToIdx.get(r.from_concept_id);
    const toIdx = conceptToIdx.get(r.to_concept_id);
    if (fromIdx === undefined || toIdx === undefined) return [];
    return [{ fromIdx, toIdx, weight: r.weight }];
  });
  const n = embeddings.length;
  const R = buildRelationMatrix(n, relEntries);
  const A_hybrid = blendAdjacency(A, R, RELATION_BLEND_ALPHA);

  // Graph Laplacian + spectral clustering + Fiedler
  const L = buildLaplacian(A_hybrid);
  const { membersByCluster } = spectralClustering(L);
  const fiedler = computeFiedler(L);

  const graphVersion = ulid();

  // Build chunk → cluster lookup
  const chunkCluster = new Map<string, number>();
  for (const [clusterIdx, members] of membersByCluster) {
    for (const memberIdx of members) {
      chunkCluster.set(chunkIds[memberIdx]!, clusterIdx);
    }
  }

  // Update concept cluster assignments
  const existingConcepts = getConcepts(db);
  for (const concept of existingConcepts) {
    if (concept.active_chunk_id && chunkCluster.has(concept.active_chunk_id)) {
      const cluster = chunkCluster.get(concept.active_chunk_id)!;
      if (concept.cluster !== cluster) {
        insertConceptVersion(db, concept.id, { cluster });
      }
    }
  }

  // Compute lore_residual per concept = 1 − mean similarity to cluster peers
  {
    const clusterConceptChunks = new Map<number, Array<{ conceptId: string; chunkIdx: number }>>();
    for (const existing of existingConcepts) {
      if (!existing.active_chunk_id) continue;
      const chunkIdx = chunkIdToIndex.get(existing.active_chunk_id);
      if (chunkIdx === undefined) continue;
      const cluster = chunkCluster.get(existing.active_chunk_id);
      if (cluster === undefined) continue;
      let list = clusterConceptChunks.get(cluster);
      if (!list) {
        list = [];
        clusterConceptChunks.set(cluster, list);
      }
      list.push({ conceptId: existing.id, chunkIdx });
    }

    for (const [, members] of clusterConceptChunks) {
      for (const { conceptId, chunkIdx } of members) {
        const peers = members.filter((m) => m.conceptId !== conceptId);
        if (peers.length === 0) continue;
        const meanSim =
          peers.reduce((s, p) => s + A_hybrid.get(chunkIdx, p.chunkIdx), 0) / peers.length;
        const loreResidual = 1 - meanSim;
        const current = existingConcepts.find((c) => c.id === conceptId);
        const groundResidual = current?.ground_residual ?? current?.churn ?? 0;
        const residual = Math.max(groundResidual, loreResidual);
        insertConceptVersion(db, conceptId, { lore_residual: loreResidual, residual });
      }
    }
  }

  // Build edges between cluster representative concepts
  const clusterConcepts = new Map<number, string>();
  for (const concept of existingConcepts) {
    if (concept.active_chunk_id && chunkCluster.has(concept.active_chunk_id)) {
      const cluster = chunkCluster.get(concept.active_chunk_id)!;
      if (!clusterConcepts.has(cluster)) {
        clusterConcepts.set(cluster, concept.id);
      }
    }
  }

  for (const [cluster1, conceptId1] of clusterConcepts) {
    for (const [cluster2, conceptId2] of clusterConcepts) {
      if (cluster1 >= cluster2) continue;
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

  // Cache Laplacian eigendecomposition
  upsertLaplacianCache(
    db,
    graphVersion,
    fiedler.fiedlerValue,
    fiedler.eigenvalues,
    Float64Array.from(fiedler.eigenvectors.to1DArray()),
  );

  // Per-cluster Fiedler values: extract each cluster's sub-Laplacian and compute local connectivity.
  // This prevents a well-connected cluster from discounting debt in an isolated cluster.
  const clusterFiedlerValues = new Map<number, number>();
  for (const [clusterIdx, members] of membersByCluster) {
    if (members.length < 2) {
      // Single-node cluster: fully disconnected, Fiedler = 0
      clusterFiedlerValues.set(clusterIdx, 0);
      continue;
    }
    try {
      const subA = buildSubMatrix(A_hybrid, members);
      const subL = buildLaplacian(subA);
      const subFiedler = computeFiedler(subL);
      clusterFiedlerValues.set(clusterIdx, Math.max(0, subFiedler.fiedlerValue));
    } catch {
      // Sub-decomposition failed (e.g. numerical issues): fall back to global Fiedler
      clusterFiedlerValues.set(clusterIdx, fiedler.fiedlerValue);
    }
  }

  // Recompute and persist debt with fresh residuals and per-component fiedler
  const previousDebt = getManifest(db)?.debt ?? 0;
  const freshConcepts = getActiveConcepts(db);

  // Build per-cluster concept lists for component-level debt computation
  const conceptsByCluster = new Map<number, ConceptRow[]>();
  const unclusteredConcepts: ConceptRow[] = [];
  for (const concept of freshConcepts) {
    if (concept.active_chunk_id) {
      const clusterIdx = chunkCluster.get(concept.active_chunk_id);
      if (clusterIdx !== undefined) {
        if (!conceptsByCluster.has(clusterIdx)) conceptsByCluster.set(clusterIdx, []);
        conceptsByCluster.get(clusterIdx)!.push(concept);
        continue;
      }
    }
    unclusteredConcepts.push(concept);
  }
  const componentData: Array<{ concepts: ConceptRow[]; fiedlerValue: number }> = [];
  for (const [clusterIdx, concepts] of conceptsByCluster) {
    componentData.push({ concepts, fiedlerValue: clusterFiedlerValues.get(clusterIdx) ?? 0 });
  }
  if (unclusteredConcepts.length > 0) {
    componentData.push({ concepts: unclusteredConcepts, fiedlerValue: 0 });
  }
  const newDebt = componentData.length > 0
    ? computeComponentDebt(componentData)
    : computeTotalDebt(freshConcepts, fiedler.fiedlerValue);

  // Update manifest with fresh graph data + debt
  upsertManifest(db, {
    concept_graph_version: graphVersion,
    fiedler_value: fiedler.fiedlerValue,
    debt: newDebt,
    debt_trend: computeDebtTrend(newDebt, previousDebt),
    chunk_count: getChunkCount(db),
    concept_count: getActiveConceptCount(db),
    graph_stale: 0,
  });

  return {
    membersByCluster,
    chunkIds,
    embeddings,
    chunkCluster,
    chunkIdToIndex,
    A_hybrid,
    graphVersion,
  };
}
