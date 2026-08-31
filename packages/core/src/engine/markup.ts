/**
 * HTML and XML text extraction: enough to make markup documents retrievable,
 * deliberately not a converter.
 *
 * Ingested raw, a markup file is one chunk of angle brackets — a 529KB
 * regulation became a single chunk whose only readable part was the XML
 * preamble, and every question about it scored zero. We emit markdown instead,
 * so the heading-aware doc chunker treats markup exactly like .md: headings
 * become sections, sections become chunks.
 *
 * Heading levels come from HTML h1-h6 where present. For XML there is no
 * universal heading element, so structural title elements are recognised by
 * name (TITLE, TI, TI.ART, HEADING, SUBJECT, ...) — a heuristic that degrades
 * to plain paragraphs when a schema is unknown, which is still vastly better
 * than raw tags.
 */

const VOID_OR_INLINE = new Set([
  "a",
  "b",
  "i",
  "em",
  "strong",
  "span",
  "code",
  "small",
  "sub",
  "sup",
  "abbr",
  "cite",
  "q",
  "u",
  "s",
  "mark",
  "br",
  "wbr",
  "img",
  "time",
]);

const HTML_HEADING = /^h([1-6])$/i;

/** XML element names that conventionally carry a structural title. */
const XML_TITLE_TAGS =
  /^(ti|ti\.art|ti\.cha|ti\.sec|title|sti|sti\.art|subtitle|heading|head|subject|name|caption)$/i;

/**
 * XML elements that are formatting or labels, not structure. Treating these as
 * block boundaries tore text apart: an amount rendered as
 * `<FT TYPE="NUMBER">20000000</FT> EUR` split the number from its currency, and
 * a `<NO.PARAG>1.</NO.PARAG>` label separated from the paragraph it numbers.
 */
const XML_INLINE_TAGS =
  /^(ft|hi|date|ref|no\.p|no\.parag|no\.doc\.c|quot\.start|quot\.end|expl|inl\.element|italic|bold|sup|sub)$/i;

/** Elements whose content is never prose. */
const DROP_TAGS = new Set(["script", "style", "head", "meta", "link", "noscript", "svg"]);

/**
 * HTML void elements. They have no closing tag, and HTML5 writes them without
 * the closing slash. Read as open tags, `<meta charset>` and `<link rel>` each
 * opened a drop region that `</head>` could not close: the scanner then dropped
 * the whole body and every plain HTML document extracted to null. XML always
 * writes the closing slash, so this list applies to HTML only.
 */
const HTML_VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}

interface Block {
  level: number;
  text: string;
}

/**
 * Walk the tag stream, accumulating text per block-level element. A tiny
 * scanner rather than a DOM: these documents reach hundreds of KB and only the
 * text and its heading structure matter.
 */
function extractBlocks(markup: string, kind: "html" | "xml"): Block[] {
  const blocks: Block[] = [];
  let buffer: string[] = [];
  let headingLevel = 0;
  // A stack, not a counter with one remembered name: `<style>` inside `<head>`
  // made the two disagree, and the region never closed.
  const dropStack: string[] = [];

  const flush = () => {
    const text = decodeEntities(buffer.join(" ")).replace(/\s+/g, " ").trim();
    buffer = [];
    if (text) blocks.push({ level: headingLevel, text });
    headingLevel = 0;
  };

  const tagRe = /<!--[\s\S]*?-->|<[?!][^>]*>|<\/?([A-Za-z][\w.:-]*)[^>]*?(\/?)>/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = tagRe.exec(markup)) !== null) {
    const between = markup.slice(cursor, match.index);
    cursor = tagRe.lastIndex;
    if (dropStack.length === 0 && between.trim()) buffer.push(between);

    const raw = match[0];
    const name = (match[1] ?? "").toLowerCase();
    if (!name) continue; // comment, doctype or processing instruction
    const isClose = raw.startsWith("</");
    const selfClosing = match[2] === "/" || (kind === "html" && HTML_VOID.has(name));

    if (DROP_TAGS.has(name)) {
      if (isClose) {
        // Close the innermost region with this name, and every region opened
        // inside it. An unclosed inner tag then cannot hold the region open.
        const opened = dropStack.lastIndexOf(name);
        if (opened >= 0) dropStack.length = opened;
      } else if (!selfClosing) {
        dropStack.push(name);
      }
      continue;
    }
    if (dropStack.length > 0 || VOID_OR_INLINE.has(name)) continue;
    if (kind === "xml" && XML_INLINE_TAGS.test(name)) continue;

    // Block boundary: emit what we have, then note if the new block is a heading.
    flush();
    if (!isClose && !selfClosing) {
      const html = HTML_HEADING.exec(name);
      if (kind === "html" && html) headingLevel = Number(html[1]);
      else if (kind === "xml" && XML_TITLE_TAGS.test(name)) headingLevel = 2;
    }
  }

  const tail = markup.slice(cursor);
  if (dropStack.length === 0 && tail.trim()) buffer.push(tail);
  flush();
  return blocks;
}

/**
 * Extract markup as markdown-ish text. Returns null when nothing readable was
 * found, so callers skip the file rather than ingest a wall of tags.
 */
export function extractMarkupMarkdown(source: string, kind: "html" | "xml"): string | null {
  const blocks = extractBlocks(source, kind);
  const out: string[] = [];
  for (const block of blocks) {
    // Consecutive title elements (XML: number then subject) merge into one heading.
    const previous = out[out.length - 1];
    if (block.level > 0 && previous?.startsWith("#")) {
      out[out.length - 1] = `${previous} — ${block.text}`;
      continue;
    }
    out.push(
      block.level > 0 ? `${"#".repeat(Math.min(6, block.level))} ${block.text}` : block.text,
    );
  }
  const text = out.join("\n\n").trim();
  return text.length > 0 ? text : null;
}
