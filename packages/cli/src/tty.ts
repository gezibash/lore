import readline from "node:readline";
import { isJsonOutput } from "./output.ts";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

function stdout(): NodeJS.WriteStream {
  return process.stdout;
}

export function isInteractiveOutputEnabled(): boolean {
  return !isJsonOutput() && stdout().isTTY && process.env.CI !== "true";
}

function clearCurrentLine(): void {
  readline.clearLine(stdout(), 0);
  readline.cursorTo(stdout(), 0);
}

type DraftLine = {
  update(text: string): void;
};

export function createDraft(): {
  addLine(text: string): DraftLine;
  clear(): void;
  stop(): void;
} {
  let activeLine = "";
  let hasRendered = false;
  const interactive = isInteractiveOutputEnabled();

  const render = (): void => {
    if (!interactive) return;
    clearCurrentLine();
    stdout().write(activeLine);
    hasRendered = true;
  };

  return {
    addLine(text: string): DraftLine {
      activeLine = text;
      render();
      return {
        update(nextText: string): void {
          activeLine = nextText;
          render();
        },
      };
    },
    clear(): void {
      if (!interactive || !hasRendered) return;
      clearCurrentLine();
      hasRendered = false;
    },
    stop(): void {},
  };
}

export function createSpinner(text: string): {
  start(): ReturnType<typeof createSpinner>;
  clear(): void;
  succeed(message: string): void;
  fail(message: string): void;
} {
  let currentText = text;
  let timer: ReturnType<typeof setInterval> | null = null;
  let frameIndex = 0;
  let rendered = false;
  const interactive = isInteractiveOutputEnabled();

  const render = (): void => {
    if (!interactive) return;
    clearCurrentLine();
    stdout().write(`${SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length] ?? "-"} ${currentText}`);
    frameIndex += 1;
    rendered = true;
  };

  const stop = (): void => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (interactive && rendered) {
      clearCurrentLine();
      rendered = false;
    }
  };

  const api = {
    start() {
      if (interactive && !timer) {
        render();
        timer = setInterval(render, 80);
      }
      return api;
    },
    clear(): void {
      stop();
    },
    succeed(message: string): void {
      stop();
      console.log(message);
    },
    fail(message: string): void {
      stop();
      console.error(message);
    },
  };

  return api;
}

type ProgressEntry = {
  total: number;
  current: number;
  label: string;
  finalMessage: string | null;
  failed: boolean;
};

const progressEntries: ProgressEntry[] = [];
let renderedProgressLines = 0;

function finalizeProgressRenderIfComplete(): void {
  if (!progressEntries.every((entry) => entry.finalMessage)) return;
  if (isInteractiveOutputEnabled() && progressEntries.length > 0) {
    stdout().write("\n");
  }
  progressEntries.length = 0;
  renderedProgressLines = 0;
}

function renderProgressEntries(): void {
  if (!isInteractiveOutputEnabled() || progressEntries.length === 0) return;

  readline.cursorTo(stdout(), 0);
  for (let index = 1; index < renderedProgressLines; index += 1) {
    readline.moveCursor(stdout(), 0, -1);
  }
  readline.cursorTo(stdout(), 0);

  progressEntries.forEach((entry, index) => {
    clearCurrentLine();
    if (entry.finalMessage) {
      stdout().write(entry.finalMessage);
    } else {
      const percent = entry.total > 0 ? Math.min(1, entry.current / entry.total) : 0;
      const filled = Math.round(percent * 16);
      const bar = `${"=".repeat(filled)}${" ".repeat(Math.max(0, 16 - filled))}`;
      stdout().write(`${entry.label} [${bar}] ${entry.current}/${entry.total}`);
    }
    if (index < progressEntries.length - 1) {
      stdout().write("\n");
    }
  });

  renderedProgressLines = progressEntries.length;
}

export function createProgressBar(label: string, opts: { total: number }): {
  update(current: number, nextLabel?: string): void;
  complete(message: string): void;
  fail(message: string): void;
} {
  const entry: ProgressEntry = {
    total: opts.total,
    current: 0,
    label,
    finalMessage: null,
    failed: false,
  };
  progressEntries.push(entry);
  renderProgressEntries();

  return {
    update(current: number, nextLabel?: string): void {
      entry.current = current;
      if (nextLabel) entry.label = nextLabel;
      renderProgressEntries();
    },
    complete(message: string): void {
      entry.finalMessage = message;
      renderProgressEntries();
      finalizeProgressRenderIfComplete();
    },
    fail(message: string): void {
      entry.failed = true;
      entry.finalMessage = message;
      renderProgressEntries();
      finalizeProgressRenderIfComplete();
    },
  };
}
