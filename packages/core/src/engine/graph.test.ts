import { test, expect } from "bun:test";
import { Matrix } from "ml-matrix";
import {
  buildLaplacian,
  spectralClustering,
  kMeans,
  pairwiseCosineSimilarity,
  computeFiedler,
  buildRelationMatrix,
  blendAdjacency,
  RELATION_BLEND_ALPHA,
} from "./graph.ts";

/**
 * Build a block-diagonal similarity matrix for `groups` disconnected clusters.
 * Within each group, all pairs have similarity 1. Between groups, similarity 0.
 */
function blockDiagonalSimilarity(groupSizes: number[]): Matrix {
  const n = groupSizes.reduce((a, b) => a + b, 0);
  const sim = Matrix.zeros(n, n);
  let offset = 0;
  for (const size of groupSizes) {
    for (let i = 0; i < size; i++) {
      for (let j = 0; j < size; j++) {
        sim.set(offset + i, offset + j, 1);
      }
    }
    offset += size;
  }
  return sim;
}

test("pairwiseCosineSimilarity handles orthogonal and zero vectors", () => {
  const a = new Float32Array([1, 0, 0]);
  const b = new Float32Array([0, 1, 0]);
  const c = new Float32Array([0, 0, 0]);

  const sim = pairwiseCosineSimilarity([a, b, c]);

  expect(sim.get(0, 0)).toBe(1);
  expect(sim.get(0, 1)).toBe(0);
  expect(sim.get(1, 0)).toBe(0);
  expect(sim.get(0, 2)).toBe(0);
  expect(sim.get(2, 2)).toBe(1);
});

test("buildLaplacian produces expected degrees and signs", () => {
  const A = new Matrix([
    [0, 0.5, 0],
    [0.5, 0, 0.5],
    [0, 0.5, 0],
  ]);

  const L = buildLaplacian(A);

  expect(L.get(0, 0)).toBeCloseTo(0.5);
  expect(L.get(1, 1)).toBeCloseTo(1);
  expect(L.get(2, 2)).toBeCloseTo(0.5);
  expect(L.get(0, 1)).toBeCloseTo(-0.5);
  expect(L.get(1, 2)).toBeCloseTo(-0.5);
});

test("kMeans returns identity labels when k >= n", () => {
  const labels = kMeans(
    [
      [0, 0],
      [1, 1],
      [2, 2],
    ],
    3,
  );
  expect(labels).toEqual([0, 1, 2]);
});

test("spectralClustering falls back to two clusters when eigengap is trivial", () => {
  const sim = new Matrix([
    [1, 0.8, 0.7],
    [0.8, 1, 0.75],
    [0.7, 0.75, 1],
  ]);
  const L = buildLaplacian(sim);
  const result = spectralClustering(L);

  expect(result.clusterCount).toBe(2);
  expect(result.labels).toHaveLength(3);
  expect(result.membersByCluster.size).toBe(2);
});

test("computeFiedler returns eigenvalues and sorted indices", () => {
  const L = new Matrix([
    [1, -1],
    [-1, 1],
  ]);
  const fiedler = computeFiedler(L);

  expect(fiedler.fiedlerValue).toBeLessThanOrEqual(2);
  expect(fiedler.fiedlerVector).toHaveLength(2);
  expect(fiedler.sortedIndices.length).toBe(2);
  expect(fiedler.eigenvalues.length).toBe(2);
});

test("spectralClustering finds 3 clusters from block-diagonal Laplacian", () => {
  const sim = blockDiagonalSimilarity([4, 3, 3]);
  const L = buildLaplacian(sim);
  const result = spectralClustering(L);

  expect(result.clusterCount).toBe(3);
  expect(result.membersByCluster.size).toBe(3);

  // Each cluster should contain exactly one of the original groups
  const clusters = [...result.membersByCluster.values()].sort((a, b) => a[0]! - b[0]!);
  expect(clusters[0]!.sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  expect(clusters[1]!.sort((a, b) => a - b)).toEqual([4, 5, 6]);
  expect(clusters[2]!.sort((a, b) => a - b)).toEqual([7, 8, 9]);
});

test("spectralClustering finds 2 clusters from 2 disconnected groups", () => {
  const sim = blockDiagonalSimilarity([5, 5]);
  const L = buildLaplacian(sim);
  const result = spectralClustering(L);

  expect(result.clusterCount).toBe(2);
  const clusters = [...result.membersByCluster.values()].sort((a, b) => a[0]! - b[0]!);
  expect(clusters[0]!.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  expect(clusters[1]!.sort((a, b) => a - b)).toEqual([5, 6, 7, 8, 9]);
});

test("spectralClustering handles single node", () => {
  const L = Matrix.zeros(1, 1);
  const result = spectralClustering(L);
  expect(result.clusterCount).toBe(1);
  expect(result.labels).toEqual([0]);
});

test("buildRelationMatrix produces symmetric matrix with correct weights", () => {
  const R = buildRelationMatrix(4, [
    { fromIdx: 0, toIdx: 1, weight: 0.9 },
    { fromIdx: 2, toIdx: 3, weight: 0.5 },
  ]);

  expect(R.get(0, 1)).toBeCloseTo(0.9);
  expect(R.get(1, 0)).toBeCloseTo(0.9); // symmetrized
  expect(R.get(2, 3)).toBeCloseTo(0.5);
  expect(R.get(3, 2)).toBeCloseTo(0.5);
  expect(R.get(0, 2)).toBe(0); // no relation
  expect(R.get(0, 0)).toBe(0); // no diagonal
});

test("buildRelationMatrix skips self-loops", () => {
  const R = buildRelationMatrix(3, [{ fromIdx: 1, toIdx: 1, weight: 1.0 }]);
  expect(R.get(1, 1)).toBe(0);
});

test("buildRelationMatrix takes max weight for duplicate pairs", () => {
  const R = buildRelationMatrix(3, [
    { fromIdx: 0, toIdx: 1, weight: 0.3 },
    { fromIdx: 0, toIdx: 1, weight: 0.7 },
  ]);
  expect(R.get(0, 1)).toBeCloseTo(0.7);
  expect(R.get(1, 0)).toBeCloseTo(0.7);
});

test("blendAdjacency combines A and R with correct weights", () => {
  const A = new Matrix([
    [1, 0.2],
    [0.2, 1],
  ]);
  const R = new Matrix([
    [0, 1.0],
    [1.0, 0],
  ]);
  const alpha = 0.8;
  const result = blendAdjacency(A, R, alpha);

  // diagonal: 0.8*1 + 0.2*0 = 0.8
  expect(result.get(0, 0)).toBeCloseTo(0.8);
  // off-diagonal: 0.8*0.2 + 0.2*1.0 = 0.16 + 0.2 = 0.36
  expect(result.get(0, 1)).toBeCloseTo(0.36);
  expect(result.get(1, 0)).toBeCloseTo(0.36);
});

test("blendAdjacency with zero R reduces to A", () => {
  const A = new Matrix([
    [1, 0.5],
    [0.5, 1],
  ]);
  const R = Matrix.zeros(2, 2);
  const result = blendAdjacency(A, R, RELATION_BLEND_ALPHA);

  expect(result.get(0, 0)).toBeCloseTo(A.get(0, 0) * RELATION_BLEND_ALPHA);
  expect(result.get(0, 1)).toBeCloseTo(A.get(0, 1) * RELATION_BLEND_ALPHA);
});

test("kMeans separates well-separated clusters", () => {
  // Two tight clusters far apart
  const points = [
    [0, 0],
    [0.1, 0],
    [0, 0.1],
    [10, 10],
    [10.1, 10],
    [10, 10.1],
  ];
  const labels = kMeans(points, 2);

  // Points 0-2 should share a label, points 3-5 should share a different label
  expect(labels[0]).toBe(labels[1]);
  expect(labels[0]).toBe(labels[2]);
  expect(labels[3]).toBe(labels[4]);
  expect(labels[3]).toBe(labels[5]);
  expect(labels[0]).not.toBe(labels[3]);
});
