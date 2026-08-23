import { expect, test } from "bun:test";
import { renderNarrativeWithCitations } from "./format-helpers.ts";

const cite = (file: string, line: number, term: string) => ({
  file,
  line,
  snippet: "",
  term,
});

test("a term is cited only where it appears as a whole word", () => {
  // The real failure: a concept named `call` is bound to daemon-client.ts:152,
  // and "automatically" contains "call", so a sentence about KPI direction
  // flags was cited to the daemon RPC client.
  const narrative = "Readings attach automatically to the sole open narrative.";
  expect(renderNarrativeWithCitations(narrative, [cite("daemon-client.ts", 152, "call")])).toBe(
    narrative,
  );

  const real = "The call site resolves the lore mind.";
  expect(renderNarrativeWithCitations(real, [cite("daemon-client.ts", 152, "call")])).toBe(
    `${real}  [daemon-client.ts:152]`,
  );
});

test("terms that begin or end with punctuation still match, unlike \\b", () => {
  const narrative = "Pass --direction up when creating the KPI.";
  expect(renderNarrativeWithCitations(narrative, [cite("cli.ts", 12, "--direction")])).toBe(
    `${narrative}  [cli.ts:12]`,
  );
  // Guard the underlying reason this needed lookarounds rather than \b.
  expect(/\b--direction\b/.test(narrative)).toBe(false);
});

test("a term containing regex metacharacters is matched literally", () => {
  const narrative = "See docs/knowledge-model.md for the axes.";
  expect(
    renderNarrativeWithCitations(narrative, [
      cite("docs/knowledge-model.md", 1, "docs/knowledge-model.md"),
    ]),
  ).toBe(`${narrative}  [docs/knowledge-model.md:1]`);
  // `.` must not act as a wildcard: this line would match `READMEXmd`.
  expect(
    renderNarrativeWithCitations("The READMEXmd file.", [cite("README.md", 1, "README.md")]),
  ).toBe("The READMEXmd file.");
});

test("exactness mode marks one line instead of stapling the same triple to three", () => {
  const narrative = ["Repair is generic.", "Migrations are discovered.", "Nothing to update."].join(
    "\n",
  );
  const citations = [
    cite("repair.ts", 420, "unmatched-a"),
    cite("repair.ts", 281, "unmatched-b"),
    cite("repair.ts", 243, "unmatched-c"),
  ];
  const out = renderNarrativeWithCitations(narrative, citations, { exactness: true });
  const lines = out.split("\n");
  expect(lines[0]).toBe("Repair is generic.  [repair.ts:420] [repair.ts:281] [repair.ts:243]");
  // The other lines must stay uncited — they were never matched to anything.
  expect(lines[1]).toBe("Migrations are discovered.");
  expect(lines[2]).toBe("Nothing to update.");
});

test("exactness mode defers to per-term matches when any line earns one", () => {
  const narrative = ["The migrate helper applies pending files.", "Unrelated prose."].join("\n");
  const citations = [cite("migrator.ts", 56, "migrate"), cite("repair.ts", 420, "unmatched")];
  const lines = renderNarrativeWithCitations(narrative, citations, { exactness: true }).split("\n");
  expect(lines[0]).toBe("The migrate helper applies pending files.  [migrator.ts:56]");
  expect(lines[1]).toBe("Unrelated prose.");
});

test("lines the model already cited are left alone, and locations never repeat", () => {
  const narrative = ["The migrate helper [migrator.ts:19-24].", "The migrate helper again."].join(
    "\n",
  );
  const lines = renderNarrativeWithCitations(narrative, [
    cite("migrator.ts", 56, "migrate"),
    cite("migrator.ts", 56, "migrate"),
  ]).split("\n");
  expect(lines[0]).toBe("The migrate helper [migrator.ts:19-24].");
  expect(lines[1]).toBe("The migrate helper again.  [migrator.ts:56]");
});
