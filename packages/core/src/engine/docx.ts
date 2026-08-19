import { inflateRawSync } from "node:zlib";

/**
 * Minimal DOCX text extractor: enough to make Word documents retrievable,
 * deliberately not a converter.
 *
 * A .docx is a ZIP holding word/document.xml (WordprocessingML). We pull
 * paragraph text and heading level, and emit markdown — so the existing
 * heading-aware doc chunker treats Word files exactly like .md. Tables and
 * lists degrade to plain paragraphs, which retrieval is fine with; if fidelity
 * ever matters more than reach, mammoth is the upgrade path.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}

/** Read one named entry out of a ZIP buffer. Stored and deflated only — the
 *  two methods Word and every exporter actually emit. */
function readZipEntry(buf: Buffer, wanted: string): Buffer | null {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66_000; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) return null;

  const entryCount = buf.readUInt16LE(eocd + 10);
  let cursor = buf.readUInt32LE(eocd + 16);
  let found: ZipEntry | null = null;

  for (let i = 0; i < entryCount; i++) {
    if (cursor + 46 > buf.length || buf.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) break;
    const nameLength = buf.readUInt16LE(cursor + 28);
    const extraLength = buf.readUInt16LE(cursor + 30);
    const commentLength = buf.readUInt16LE(cursor + 32);
    const name = buf.toString("utf-8", cursor + 46, cursor + 46 + nameLength);
    if (name === wanted) {
      found = {
        name,
        method: buf.readUInt16LE(cursor + 10),
        compressedSize: buf.readUInt32LE(cursor + 20),
        localHeaderOffset: buf.readUInt32LE(cursor + 42),
      };
      break;
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (!found) return null;

  // Local header repeats the name/extra lengths, which may differ from central.
  const local = found.localHeaderOffset;
  const localNameLength = buf.readUInt16LE(local + 26);
  const localExtraLength = buf.readUInt16LE(local + 28);
  const start = local + 30 + localNameLength + localExtraLength;
  const data = buf.subarray(start, start + found.compressedSize);
  if (found.method === 0) return data;
  if (found.method === 8) return inflateRawSync(data);
  return null;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, "&");
}

/** Heading level for a paragraph, or 0. Named styles first (Word, pandoc);
 *  then size+bold, which is how exporters like macOS textutil encode headings. */
function headingLevel(paragraphXml: string): number {
  const style = /w:pStyle\s+w:val="([^"]+)"/.exec(paragraphXml);
  if (style) {
    const named = /^heading\s*(\d)/i.exec(style[1]!.replace(/[-_]/g, " "));
    if (named) return Math.min(4, Number(named[1]));
    if (/^title$/i.test(style[1]!)) return 1;
  }
  const bold = /<w:b\s*\/>|<w:b\s+[^>]*\/>/.test(paragraphXml);
  const size = /<w:sz\s+w:val="(\d+)"/.exec(paragraphXml);
  if (bold && size) {
    const halfPoints = Number(size[1]);
    if (halfPoints >= 44) return 1;
    if (halfPoints >= 32) return 2;
    if (halfPoints >= 26) return 3;
  }
  return 0;
}

/** Extract a .docx as markdown-ish text. Returns null when the file is not a
 *  readable Word package, so callers can skip it rather than ingest garbage. */
export function extractDocxMarkdown(fileBytes: Uint8Array): string | null {
  let documentXml: Buffer | null;
  try {
    documentXml = readZipEntry(Buffer.from(fileBytes), "word/document.xml");
  } catch {
    return null;
  }
  if (!documentXml) return null;

  const xml = documentXml.toString("utf-8");
  const body = /<w:body>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? xml;
  const blocks: string[] = [];

  for (const match of body.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)) {
    const paragraph = match[1] ?? "";
    const text = decodeXmlEntities(
      [...paragraph.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => m[1] ?? "").join(""),
    )
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    // Text that is already markdown (exported from .md) keeps its own heading.
    if (/^#{1,6}\s/.test(text)) {
      blocks.push(text);
      continue;
    }
    const level = headingLevel(paragraph);
    blocks.push(level > 0 ? `${"#".repeat(level)} ${text}` : text);
  }

  const out = blocks.join("\n\n").trim();
  return out.length > 0 ? out : null;
}
