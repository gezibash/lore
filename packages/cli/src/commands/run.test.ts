import { expect, test, describe } from "bun:test";
import { parseKeyValue, parseMetrics, parseOutcome, parseParams } from "./run.ts";

describe("run argument parsing", () => {
  test("the first = splits, so a value may hold one", () => {
    expect(parseKeyValue("lr=0.003")).toEqual(["lr", "0.003"]);
    expect(parseKeyValue("cmd=a=b")).toEqual(["cmd", "a=b"]);
  });

  test("a pair with no key is refused", () => {
    expect(() => parseKeyValue("=value")).toThrow(/key=value/);
    expect(() => parseKeyValue("novalue")).toThrow(/key=value/);
  });

  test("params keep their text", () => {
    // A parameter's type belongs to the tool that read it, not to lore.
    expect(parseParams(["lr=0.003", "seed=7", "mode=fast"])).toEqual({
      lr: "0.003",
      seed: "7",
      mode: "fast",
    });
  });

  test("metrics must be numbers", () => {
    expect(parseMetrics(["auc=0.812", "loss=1e-3"])).toEqual({ auc: 0.812, loss: 0.001 });
    // A metric that is not a number cannot be compared against the run before
    // it, which is the only reason to record it.
    expect(() => parseMetrics(["auc=high"])).toThrow(/must be a number/);
  });

  test("outcome takes only the three the schema allows", () => {
    expect(parseOutcome(undefined)).toBeUndefined();
    expect(parseOutcome("failure")).toBe("failure");
    expect(() => parseOutcome("ok")).toThrow(/success, failure or aborted/);
  });
});
