import Exa from "exa-js";
import type { LoreConfig } from "@/types/index.ts";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  source: "exa" | "context7";
}

export async function webSearch(query: string, config: LoreConfig): Promise<WebSearchResult[]> {
  const results: WebSearchResult[] = [];
  const promises: Promise<void>[] = [];

  if (config.ai.search?.exa_api_key) {
    promises.push(
      exaSearch(query, config.ai.search.exa_api_key).then((r) => {
        results.push(...r);
      }),
    );
  }

  if (config.ai.search?.context7_api_key) {
    promises.push(
      context7Search(query, config.ai.search.context7_api_key).then((r) => {
        results.push(...r);
      }),
    );
  }

  await Promise.allSettled(promises);
  return results;
}

async function exaSearch(query: string, apiKey: string): Promise<WebSearchResult[]> {
  const exa = new Exa(apiKey);
  const response = await exa.searchAndContents(query, {
    text: true,
    numResults: 3,
  });
  return response.results.map((r) => ({
    title: r.title ?? "",
    url: r.url,
    snippet: (r.text ?? "").slice(0, 500),
    source: "exa" as const,
  }));
}

async function context7Search(query: string, apiKey: string): Promise<WebSearchResult[]> {
  // Step 1: resolve library ID from query terms
  const resolveRes = await fetch("https://context7.com/api/v1/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query, limit: 1 }),
  });
  if (!resolveRes.ok) return [];
  const resolved = (await resolveRes.json()) as Array<{
    id: string;
    title: string;
  }>;
  if (!resolved.length) return [];

  const libraryId = resolved[0]!.id;

  // Step 2: query docs for this library
  const docsRes = await fetch("https://context7.com/api/v1/query", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ libraryId, query, tokens: 3000 }),
  });
  if (!docsRes.ok) return [];
  const docs = (await docsRes.json()) as Array<{
    title: string;
    url: string;
    content: string;
  }>;

  return docs.slice(0, 3).map((d) => ({
    title: d.title ?? "",
    url: d.url ?? "",
    snippet: (d.content ?? "").slice(0, 500),
    source: "context7" as const,
  }));
}
