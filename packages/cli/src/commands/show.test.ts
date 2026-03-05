import { expect, test } from "bun:test";
import { parseShowTarget } from "./show.ts";

test("parseShowTarget accepts concept@ref syntax", () => {
  expect(parseShowTarget("auth-model@main~3")).toEqual({
    concept: "auth-model",
    ref: "main~3",
  });
});

test("parseShowTarget leaves plain concept names untouched", () => {
  expect(parseShowTarget("auth-model")).toEqual({ concept: "auth-model" });
});
