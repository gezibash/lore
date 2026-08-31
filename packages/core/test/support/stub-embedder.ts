/**
 * A stub embedding server for the test run.
 *
 * The default config points embedding at Ollama on localhost. A developer
 * machine usually runs Ollama, so the tests embedded for real and passed in
 * milliseconds. A build machine runs none, the call failed, and the AI SDK
 * retried with backoff for about 6 seconds on every open() call.
 *
 * This server answers the embed call instead. The tests then behave the same
 * on both machines, and no test depends on a model being installed.
 *
 * createTestLoreRoot() writes the address into the config it generates.
 */
const DIM = 4096;

/** A deterministic unit vector. The value follows the text, so two different
 *  texts do not collide, and one text always embeds the same way. */
function vectorFor(text: string): number[] {
  let seed = 0;
  for (let i = 0; i < text.length; i++) seed = (seed * 31 + text.charCodeAt(i)) >>> 0;
  const out = new Array<number>(DIM);
  let norm = 0;
  for (let i = 0; i < DIM; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    const v = (seed / 0xffffffff) * 2 - 1;
    out[i] = v;
    norm += v * v;
  }
  const length = Math.sqrt(norm) || 1;
  for (let i = 0; i < DIM; i++) out[i] = out[i]! / length;
  return out;
}

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    let input: unknown = "";
    try {
      const body = (await req.json()) as { input?: unknown; prompt?: unknown };
      input = body.input ?? body.prompt ?? "";
    } catch {
      // A body that does not parse still gets an embedding.
    }
    const texts = Array.isArray(input) ? input.map(String) : [String(input)];
    return Response.json({
      model: "stub-embedding",
      embeddings: texts.map(vectorFor),
      prompt_eval_count: 1,
    });
  },
});

process.env.LORE_TEST_EMBED_URL = `http://127.0.0.1:${server.port}`;
