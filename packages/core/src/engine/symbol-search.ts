import type { Database } from "bun:sqlite";
import type { SymbolSearchResult } from "@/types/index.ts";
import { getCallSitesForCallee, getCallSitesByCaller } from "@/db/call-sites.ts";

interface CallGraphNode {
  name: string;
  file: string;
  line: number;
  snippet: string | null;
}

interface CallGraph {
  callers: CallGraphNode[];
  callees: CallGraphNode[];
}

/**
 * Collect callers (upstream) and callees (downstream) for a symbol.
 * BFS up to the specified degrees, topK per node.
 * Level 1: includes snippet. Level 2+: name + file only (no snippet).
 */
export function collectCallGraph(
  db: Database,
  symbolQualifiedName: string,
  opts?: { upDegrees?: number; downDegrees?: number; topK?: number },
): CallGraph {
  const upDegrees = opts?.upDegrees ?? 2;
  const downDegrees = opts?.downDegrees ?? 2;
  const topK = opts?.topK ?? 5;

  const callers: CallGraphNode[] = [];
  const callees: CallGraphNode[] = [];

  // BFS upstream (callers)
  {
    const visited = new Set<string>([symbolQualifiedName]);
    let frontier = [symbolQualifiedName];
    for (let depth = 0; depth < upDegrees && frontier.length > 0; depth++) {
      const nextFrontier: string[] = [];
      for (const name of frontier) {
        const hits = getCallSitesForCallee(db, name, { limit: topK });
        for (const hit of hits) {
          if (!hit.caller_name) continue;
          const node: CallGraphNode = {
            name: hit.caller_name,
            file: hit.file_path,
            line: hit.line,
            snippet: depth === 0 ? hit.snippet : null,
          };
          callers.push(node);
          if (!visited.has(hit.caller_name)) {
            visited.add(hit.caller_name);
            nextFrontier.push(hit.caller_name);
          }
        }
      }
      frontier = nextFrontier;
    }
  }

  // BFS downstream (callees)
  {
    const visited = new Set<string>([symbolQualifiedName]);
    let frontier = [symbolQualifiedName];
    for (let depth = 0; depth < downDegrees && frontier.length > 0; depth++) {
      const nextFrontier: string[] = [];
      for (const name of frontier) {
        const hits = getCallSitesByCaller(db, name, { limit: topK });
        for (const hit of hits) {
          const node: CallGraphNode = {
            name: hit.callee_name,
            file: hit.file_path,
            line: hit.line,
            snippet: depth === 0 ? hit.snippet : null,
          };
          callees.push(node);
          if (!visited.has(hit.callee_name)) {
            visited.add(hit.callee_name);
            nextFrontier.push(hit.callee_name);
          }
        }
      }
      frontier = nextFrontier;
    }
  }

  return { callers, callees };
}

/**
 * Enrich the top N symbol results with body + call graph.
 * Errors per-symbol are non-fatal (fields left undefined).
 */
export async function enrichSymbolResults(
  db: Database,
  symbols: SymbolSearchResult[],
  _codePath?: string,
  maxSymbols: number = 5,
): Promise<SymbolSearchResult[]> {
  const toEnrich = symbols.slice(0, maxSymbols);
  const rest = symbols.slice(maxSymbols);

  const enriched = toEnrich.map((s) => {
    try {
      const call_graph = collectCallGraph(db, s.qualified_name);
      return { ...s, call_graph };
    } catch {
      return s;
    }
  });

  return [...enriched, ...rest];
}
