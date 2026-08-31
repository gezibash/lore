import { expect, test } from "bun:test";
import { extractMarkupMarkdown } from "./markup.ts";

const BODY = `<body><h1>Hello</h1><p>Body text here.</p></body></html>`;

test("HTML void tags in the head do not swallow the document", () => {
  const withMeta = `<html><head><meta charset="UTF-8"><link rel="icon" href="i.png"><title>T</title></head>${BODY}`;
  expect(extractMarkupMarkdown(withMeta, "html")).toBe("# Hello\n\nBody text here.");
});

test("a self-closed head and a head-less document keep extracting", () => {
  const selfClosed = `<html><head><meta charset="UTF-8"/><title>T</title></head>${BODY}`;
  const noHead = `<html>${BODY}`;
  expect(extractMarkupMarkdown(selfClosed, "html")).toBe("# Hello\n\nBody text here.");
  expect(extractMarkupMarkdown(noHead, "html")).toBe("# Hello\n\nBody text here.");
});

test("a drop tag nested in another drop tag closes both", () => {
  const nested = `<html><head><style>p{color:red}</style><script>var x=1;</script></head>${BODY}`;
  expect(extractMarkupMarkdown(nested, "html")).toBe("# Hello\n\nBody text here.");
});

test("drop tags still remove their content", () => {
  const source = `<html><head><style>p{color:red}</style></head><body><script>alert("no")</script><p>Kept text.</p></body></html>`;
  expect(extractMarkupMarkdown(source, "html")).toBe("Kept text.");
});

test("XML keeps paired drop tags, which the void list must not break", () => {
  const source = `<doc><meta><author>Hidden</author></meta><title>T</title><p>Visible text.</p></doc>`;
  expect(extractMarkupMarkdown(source, "xml")).toBe("## T\n\nVisible text.");
});

test("HTML inline tags keep the source spacing around them", () => {
  const source =
    '<p>Last <strong>paragraph</strong>. See <a href="x">the guide</a>, or <em>ask</em>!</p>';
  expect(extractMarkupMarkdown(source, "html")).toBe("Last paragraph. See the guide, or ask!");
});

test("an inline tag with no surrounding space does not fuse two words", () => {
  const source = "<p><span>Alpha</span> <span>Beta</span><br>Gamma</p>";
  expect(extractMarkupMarkdown(source, "html")).toBe("Alpha Beta Gamma");
});

test("XML inline labels keep the space that holds them off their text", () => {
  const source = "<P><NO.PARAG>1.</NO.PARAG>The paragraph text.</P>";
  expect(extractMarkupMarkdown(source, "xml")).toBe("1. The paragraph text.");
});

test("an XML amount keeps its currency", () => {
  const source = '<P><FT TYPE="NUMBER">20000000</FT> EUR</P>';
  expect(extractMarkupMarkdown(source, "xml")).toBe("20000000 EUR");
});
