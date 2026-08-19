/**
 * Persistent `codex app-server` JSON-RPC client (stdio JSONL, "jsonrpc" header
 * omitted on the wire, per the app-server protocol).
 *
 * One resident child replaces a `codex exec` process boot per generation:
 * ephemeral thread/start is near-instant once the server is up, concurrent
 * turns multiplex over one connection, and the models cache is read once
 * instead of raced by parallel processes. The daemon keeps this child for its
 * lifetime; one-shot CLI runs pay a single spawn, same as exec did.
 */

const SLIM_FEATURES = [
  "shell_tool",
  "unified_exec",
  "apps",
  "multi_agent",
  "shell_snapshot",
  "personality",
  "hooks",
  "remote_plugin",
];

const REQUEST_TIMEOUT_MS = 60_000;
const TURN_TIMEOUT_MS = 180_000;

interface TurnOutcome {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

class CodexAppServer {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private pending = new Map<number, Pending>();
  private turnDone = new Map<string, Pending>();
  private agentText = new Map<string, string>();
  private usageByThread = new Map<string, { input?: number; output?: number }>();
  private rid = 0;
  private startPromise: Promise<void> | null = null;

  constructor(private readonly binPath: string) {}

  private async ensureStarted(): Promise<void> {
    if (this.proc && this.proc.exitCode === null) return;
    // Serialize concurrent first calls onto one spawn.
    this.startPromise ??= this.start().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async start(): Promise<void> {
    const args = [
      this.binPath,
      "app-server",
      ...SLIM_FEATURES.flatMap((feature) => ["--disable", feature]),
    ];
    const proc = Bun.spawn(args, { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    this.proc = proc;
    this.pending.clear();
    this.turnDone.clear();
    this.agentText.clear();
    this.usageByThread.clear();
    void this.readLoop(proc);
    await this.request("initialize", {
      clientInfo: { name: "lore", version: "1.0" },
    });
  }

  private async readLoop(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line.trim().startsWith("{")) continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        this.dispatch(msg);
      }
    }
    // transport died — fail in-flight work so callers can retry on a respawn
    const closed = new Error("codex app-server transport closed");
    for (const waiter of [...this.pending.values(), ...this.turnDone.values()]) {
      waiter.reject(closed);
    }
    this.pending.clear();
    this.turnDone.clear();
  }

  private dispatch(msg: Record<string, unknown>): void {
    if (typeof msg.id === "number" && ("result" in msg || "error" in msg)) {
      const waiter = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (!waiter) return;
      if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error).slice(0, 400)));
      else waiter.resolve(msg.result);
      return;
    }
    const method = msg.method as string | undefined;
    const params = (msg.params ?? {}) as Record<string, unknown>;
    const threadId = (params.threadId as string) ?? "";
    if (method === "item/completed") {
      const item = (params.item ?? {}) as { type?: string; text?: string };
      if (item.type === "agentMessage" && item.text) {
        this.agentText.set(threadId, item.text);
      }
    } else if (method === "thread/tokenUsage/updated") {
      const usage = (params.tokenUsage ?? params.usage ?? {}) as Record<string, unknown>;
      const input = (usage.input_tokens ?? usage.inputTokens) as number | undefined;
      const output = (usage.output_tokens ?? usage.outputTokens) as number | undefined;
      this.usageByThread.set(threadId, { input, output });
    } else if (method === "turn/completed") {
      const turn = (params.turn ?? {}) as {
        items?: Array<{ type?: string; text?: string }>;
        error?: unknown;
      };
      for (const item of turn.items ?? []) {
        if (item.type === "agentMessage" && item.text) {
          this.agentText.set(threadId, item.text);
        }
      }
      const waiter = this.turnDone.get(threadId);
      this.turnDone.delete(threadId);
      if (!waiter) return;
      if (turn.error) {
        waiter.reject(new Error(JSON.stringify(turn.error).slice(0, 400)));
      } else {
        waiter.resolve(undefined);
      }
    }
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const proc = this.proc;
    if (!proc || proc.exitCode !== null) {
      return Promise.reject(new Error("codex app-server is not running"));
    }
    this.rid += 1;
    const id = this.rid;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      const settle =
        <T>(fn: (v: T) => void) =>
        (value: T) => {
          clearTimeout(timer);
          fn(value);
        };
      this.pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
    });
    const sink = proc.stdin as { write: (s: string) => void; flush: () => void };
    sink.write(`${JSON.stringify({ id, method, params })}\n`);
    sink.flush();
    return promise;
  }

  async complete(
    prompt: string,
    opts: {
      model: string;
      reasoningEffort?: string;
      serviceTier?: string;
      abortSignal?: AbortSignal;
    },
  ): Promise<TurnOutcome> {
    await this.ensureStarted();
    const thread = (await this.request("thread/start", {
      ephemeral: true,
      model: opts.model,
      sandbox: "read-only",
      ...(opts.serviceTier ? { serviceTier: opts.serviceTier } : {}),
    })) as { thread: { id: string } };
    const threadId = thread.thread.id;

    const turnPromise = new Promise<void>((resolve, reject) => {
      this.turnDone.set(threadId, { resolve: () => resolve(), reject });
      setTimeout(() => {
        if (this.turnDone.delete(threadId)) {
          reject(new Error("codex app-server turn timed out"));
        }
      }, TURN_TIMEOUT_MS);
    });

    const onAbort = () => {
      void this.request("turn/interrupt", { threadId }).catch(() => {});
    };
    opts.abortSignal?.addEventListener("abort", onAbort, { once: true });
    try {
      await this.request("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt }],
        ...(opts.reasoningEffort ? { effort: opts.reasoningEffort } : {}),
      });
      await turnPromise;
    } finally {
      opts.abortSignal?.removeEventListener("abort", onAbort);
    }

    const text = this.agentText.get(threadId) ?? "";
    this.agentText.delete(threadId);
    const usage = this.usageByThread.get(threadId);
    this.usageByThread.delete(threadId);
    if (!text) throw new Error("codex app-server turn produced no agent message");
    return { text, inputTokens: usage?.input, outputTokens: usage?.output };
  }

  kill(): void {
    this.proc?.kill();
    this.proc = null;
  }
}

const serversByBin = new Map<string, CodexAppServer>();

export function codexAppServerFor(binPath: string): CodexAppServer {
  let server = serversByBin.get(binPath);
  if (!server) {
    server = new CodexAppServer(binPath);
    serversByBin.set(binPath, server);
  }
  return server;
}

export type { CodexAppServer, TurnOutcome };
