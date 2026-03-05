import type { Database } from "bun:sqlite";
import { getCallSitesByCaller, getCallSitesForCallee } from "@/db/call-sites.ts";

function buildNameVariants(symbol: string): string[] {
  const variants = new Set<string>();
  const value = symbol.trim();
  if (!value) return [];
  variants.add(value);

  // Qualified names often look like Class.method / ns::fn / module#fn.
  // call_sites rows may store only the local identifier.
  const local = value.split(/[:.#]/).at(-1)?.trim();
  if (local) variants.add(local);
  return [...variants];
}

function mergeUnique<T extends { file_path: string; line: number; caller_name?: string | null; callee_name?: string | null }>(
  rows: T[],
): T[] {
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const row of rows) {
    const key = `${row.file_path}:${row.line}:${row.caller_name ?? ""}:${row.callee_name ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(row);
  }
  return merged;
}

function getCallSitesByCallerVariants(
  db: Database,
  callerName: string,
  limit: number,
) {
  const rows = buildNameVariants(callerName).flatMap((name) => getCallSitesByCaller(db, name, { limit }));
  return mergeUnique(rows).slice(0, limit);
}

function getCallSitesForCalleeVariants(
  db: Database,
  calleeName: string,
  limit: number,
) {
  const rows = buildNameVariants(calleeName).flatMap((name) => getCallSitesForCallee(db, name, { limit }));
  return mergeUnique(rows).slice(0, limit);
}

/**
 * Build a bidirectional call graph adjacency starting from seed symbol names via BFS.
 * Outgoing edges (caller→callee) get weight 1.0; reverse edges get weight 0.5.
 * Stops after `hops` BFS steps to keep the graph local.
 */
export function buildCallGraphAdjacency(
  db: Database,
  seedSymbols: string[],
  hops: number = 2,
): Map<string, Array<{ target: string; weight: number }>> {
  const adjacency = new Map<string, Array<{ target: string; weight: number }>>();
  // Per-node sets track which targets have been added — O(1) duplicate check.
  const adjacencyTargets = new Map<string, Set<string>>();
  const visited = new Set<string>(seedSymbols);
  let frontier = [...seedSymbols];

  const addEdge = (from: string, to: string, weight: number) => {
    if (!adjacency.has(from)) {
      adjacency.set(from, []);
      adjacencyTargets.set(from, new Set());
    }
    const targets = adjacencyTargets.get(from)!;
    if (!targets.has(to)) {
      targets.add(to);
      adjacency.get(from)!.push({ target: to, weight });
    }
  };

  for (let hop = 0; hop < hops && frontier.length > 0; hop++) {
    const nextFrontier: string[] = [];

    for (const name of frontier) {
      // Outgoing: what does this symbol call
      const callees = getCallSitesByCallerVariants(db, name, 20);
      for (const c of callees) {
        if (!c.callee_name) continue;
        addEdge(name, c.callee_name, 1.0);
        addEdge(c.callee_name, name, 0.5); // reverse with lower weight
        if (!visited.has(c.callee_name)) {
          visited.add(c.callee_name);
          nextFrontier.push(c.callee_name);
        }
      }

      // Incoming: what calls this symbol
      const callers = getCallSitesForCalleeVariants(db, name, 20);
      for (const c of callers) {
        if (!c.caller_name) continue;
        addEdge(c.caller_name, name, 1.0);
        addEdge(name, c.caller_name, 0.5); // reverse with lower weight
        if (!visited.has(c.caller_name)) {
          visited.add(c.caller_name);
          nextFrontier.push(c.caller_name);
        }
      }
    }

    frontier = nextFrontier;
  }

  return adjacency;
}

/**
 * Personalized PageRank: computes a relevance score for every node in the graph
 * relative to a set of seed nodes. High alpha = strong restart bias toward seeds.
 *
 * Seeds start with score 1/|seeds| each. Each iteration:
 * 1. Restart: seeds receive alpha/|seeds|
 * 2. Walk: each node transfers (1-alpha) * score proportionally along its edges
 */
export function personalizedPageRank(
  adjacency: Map<string, Array<{ target: string; weight: number }>>,
  seeds: string[],
  alpha: number = 0.15,
  iterations: number = 10,
): Map<string, number> {
  if (seeds.length === 0) return new Map();

  const scores = new Map<string, number>();
  for (const s of seeds) scores.set(s, 1 / seeds.length);

  for (let iter = 0; iter < iterations; iter++) {
    const newScores = new Map<string, number>();

    // Restart component: seeds attract probability mass
    for (const s of seeds) {
      newScores.set(s, (newScores.get(s) ?? 0) + alpha / seeds.length);
    }

    // Walk component: distribute score along edges
    for (const [node, score] of scores) {
      const neighbors = adjacency.get(node) ?? [];
      const totalWeight = neighbors.reduce((s, n) => s + n.weight, 0);
      if (totalWeight === 0) continue;
      for (const { target, weight } of neighbors) {
        const transfer = (1 - alpha) * score * (weight / totalWeight);
        newScores.set(target, (newScores.get(target) ?? 0) + transfer);
      }
    }

    scores.clear();
    for (const [k, v] of newScores) scores.set(k, v);
  }

  return scores;
}
