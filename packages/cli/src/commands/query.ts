import type { WorkerClient } from "@lore/worker";
import { createDraft } from "boune";
import { formatAskCli } from "../formatters.ts";
import { emit, isJsonOutput } from "../output.ts";

export async function queryCommand(
  client: WorkerClient,
  text: string,
  opts?: {
    search?: boolean;
    brief?: boolean;
    sources?: boolean;
    mode?: "arch" | "code";
  },
): Promise<void> {
  const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
  let draft: ReturnType<typeof createDraft> | null = null;
  let line: ReturnType<ReturnType<typeof createDraft>["addLine"]> | null = null;
  let currentMessage = "preparing models";
  let phaseStartedAtMs = Date.now();
  let ticker: ReturnType<typeof setInterval> | null = null;
  let frameIndex = 0;
  const interactive = !isJsonOutput() && process.stdout.isTTY && process.env.CI !== "true";

  const formatElapsed = (elapsedMs: number): string => `${(elapsedMs / 1000).toFixed(1)}s`;
  const renderProgress = (): void => {
    if (!line) return;
    const frame = FRAMES[frameIndex % FRAMES.length]!;
    frameIndex += 1;
    line.update(`${frame} ${currentMessage} ${formatElapsed(Date.now() - phaseStartedAtMs)}`);
  };

  if (interactive) {
    draft = createDraft();
    line = draft.addLine(`${FRAMES[0]} ${currentMessage} ${formatElapsed(0)}`);
    ticker = setInterval(() => {
      renderProgress();
    }, 120);
  }

  const updateSpinner = (message: string): void => {
    if (message === currentMessage) return;
    currentMessage = message;
    phaseStartedAtMs = Date.now();
    frameIndex = 0;
    renderProgress();
  };

  const stopSpinner = (): void => {
    if (ticker) {
      clearInterval(ticker);
      ticker = null;
    }
    if (!draft) return;
    draft.clear();
    draft.stop();
    draft = null;
    line = null;
  };

  try {
    const result = await client.query(text, {
      search: opts?.search,
      brief: opts?.brief,
      mode: opts?.mode,
      onProgress: updateSpinner,
    });
    stopSpinner();
    emit(result, (value) => formatAskCli(value, { includeSources: opts?.sources }));
  } catch (error) {
    stopSpinner();
    throw error;
  }
}
