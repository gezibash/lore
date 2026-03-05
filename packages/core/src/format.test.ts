import { test, expect } from "bun:test";
import { timeAgo } from "./format.ts";

test("timeAgo reports recent time units", () => {
  const now = Date.now();

  expect(timeAgo(new Date(now - 30 * 1000).toISOString()).includes("ago")).toBe(true);
  expect(timeAgo(new Date(now + 30 * 1000).toISOString()).includes("in")).toBe(true);
});

test("timeAgo handles day/month/year scales", () => {
  const now = Date.now();

  expect(timeAgo(new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString()).includes("d")).toBe(true);
  expect(timeAgo(new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString()).includes("mo")).toBe(true);
  expect(timeAgo(new Date(now - 370 * 24 * 60 * 60 * 1000).toISOString()).includes("y")).toBe(true);
});
