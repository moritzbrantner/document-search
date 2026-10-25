// Embedded PDF text for the filesystem corpus (Bun only), through Mozilla PDF.js (`pdfjs-dist`).
//
// Supported behavior:
// - Text that is embedded in the PDF (text-showing operators with a usable font encoding).
//   Scanned or image-only PDFs have no embedded text and get the `no-text` outcome; OCR is
//   future work. Rendering, layout and table reconstruction are out of scope.
// - Pages are physical pages in page-tree order, numbered from 1, including pages without
//   text. Printed page labels are not used.
// - Within a page, text items are taken in content-stream order and grouped into lines (a new
//   line at an end-of-line mark or a baseline change of more than half the font size). A line
//   joins the previous paragraph unless the baseline gap exceeds PARAGRAPH_GAP_FACTOR times
//   the font size or the text moves back up the page (a new column). Paragraph text is NFC
//   with whitespace runs collapsed; a paragraph never spans two pages.
// - Encrypted files that open with the empty user password are extracted; files that need a
//   password get `encrypted`. Files PDF.js cannot parse get `malformed`.
// - Limits: files above `maxBytes` are not opened, and documents with more than `maxPages`
//   physical pages are not extracted (`limit-exceeded`). Extraction runs in-process; these
//   two limits bound its work.
import { getDocument, VerbosityLevel, version } from "pdfjs-dist/legacy/build/pdf.mjs";

import type { ExtractorIdentity } from "../domain/types";
import type { ParserAdapter, ParserResult } from "./corpusStore";

export interface PdfTextAdapterOptions {
  /** Files larger than this many bytes get `limit-exceeded` without being opened. */
  maxBytes?: number;
  /** PDFs with more physical pages get `limit-exceeded`. */
  maxPages?: number;
}

export const PDF_TEXT_ADAPTER_ID = "pdf-text";

/** Default limits: 64 MiB and 2,000 physical pages. */
export const PDF_TEXT_DEFAULT_LIMITS: { maxBytes: number; maxPages: number } = Object.freeze({
  maxBytes: 64 * 1024 * 1024,
  maxPages: 2000,
});

/** Version of the line/paragraph grouping below; part of the extractor configuration. */
const TEXT_LAYOUT = "document-search/pdf-lines@1";
const PARAGRAPH_GAP_FACTOR = 1.8;
const EXTRACTION_LIBRARY = "pdfjs-dist";

export function createPdfTextAdapter(options: PdfTextAdapterOptions = {}): ParserAdapter & {
  extractor: ExtractorIdentity;
} {
  const maxBytes = positiveInteger(options.maxBytes, PDF_TEXT_DEFAULT_LIMITS.maxBytes, "maxBytes");
  const maxPages = positiveInteger(options.maxPages, PDF_TEXT_DEFAULT_LIMITS.maxPages, "maxPages");
  const extractor: ExtractorIdentity = {
    name: EXTRACTION_LIBRARY,
    version,
    configuration: {
      maxBytes,
      maxPages,
      paragraphGapFactor: PARAGRAPH_GAP_FACTOR,
      textLayout: TEXT_LAYOUT,
    },
  };
  return {
    id: PDF_TEXT_ADAPTER_ID,
    extractor,
    supports: (relativePath) => relativePath.toLowerCase().endsWith(".pdf"),
    parse: ({ bytes }) => extractPdfText(bytes, { maxBytes, maxPages }),
  };
}

async function extractPdfText(
  bytes: Uint8Array,
  limits: { maxBytes: number; maxPages: number },
): Promise<ParserResult> {
  if (bytes.byteLength > limits.maxBytes) {
    return outcome(
      "limit-exceeded",
      `The file has ${bytes.byteLength} bytes; the configured limit is ${limits.maxBytes}.`,
    );
  }

  // PDF.js may take ownership of the buffer it is given: pass a copy.
  const task = getDocument({
    data: bytes.slice(),
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    isOffscreenCanvasSupported: false,
    verbosity: VerbosityLevel.ERRORS,
  });
  try {
    let document: Awaited<typeof task.promise>;
    try {
      document = await task.promise;
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name === "PasswordException") {
        return outcome("encrypted", "The PDF is encrypted and needs a password to open.");
      }
      return outcome("malformed", `The PDF could not be parsed: ${errorMessage(error)}`);
    }

    const pageCount = document.numPages;
    if (pageCount > limits.maxPages) {
      return outcome(
        "limit-exceeded",
        `The PDF has ${pageCount} pages; the configured limit is ${limits.maxPages}.`,
      );
    }

    const pages: { page: number; paragraphs: string[] }[] = [];
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      let items: unknown[];
      try {
        const page = await document.getPage(pageNumber);
        items = (await page.getTextContent()).items;
        page.cleanup();
      } catch (error) {
        return outcome("malformed", `Page ${pageNumber} could not be read: ${errorMessage(error)}`);
      }
      const paragraphs = paragraphsOf(items);
      if (paragraphs.length > 0) pages.push({ page: pageNumber, paragraphs });
    }
    if (pages.length === 0) {
      return outcome(
        "no-text",
        `None of the ${pageCount} pages has embedded text (scanned or image-only PDFs need OCR, which is not supported).`,
      );
    }

    let title: string | null = null;
    try {
      const info = (await document.getMetadata()).info as { Title?: unknown } | undefined;
      if (typeof info?.Title === "string" && info.Title.trim()) title = info.Title;
    } catch {
      // A broken information dictionary only loses the title.
    }
    return { kind: "pages", mediaType: "application/pdf", title, pageCount, pages };
  } finally {
    await task.destroy();
  }
}

interface TextLine {
  text: string;
  y: number;
  size: number;
}

/** Groups PDF.js text items of one page into paragraphs (see the module comment). */
function paragraphsOf(items: readonly unknown[]): string[] {
  const lines: TextLine[] = [];
  let current: TextLine | undefined;
  const finish = () => {
    if (current && current.text.trim()) lines.push(current);
    current = undefined;
  };
  for (const item of items) {
    if (!isTextItem(item)) continue;
    const y = item.transform[5] ?? 0;
    const size = Math.hypot(item.transform[2] ?? 0, item.transform[3] ?? 0) || item.height || 1;
    if (current && Math.abs(y - current.y) > Math.max(size, current.size) / 2) finish();
    if (current) {
      current.text += item.str;
      current.size = Math.max(current.size, size);
    } else {
      current = { text: item.str, y, size };
    }
    if (item.hasEOL) finish();
  }
  finish();

  const paragraphs: string[] = [];
  let previous: TextLine | undefined;
  for (const line of lines) {
    const gap = previous ? previous.y - line.y : 0;
    const size = previous ? Math.max(previous.size, line.size) : line.size;
    const text = line.text.normalize("NFC").replace(/\s+/gu, " ").trim();
    if (!text) continue;
    if (previous && gap >= 0 && gap <= PARAGRAPH_GAP_FACTOR * size) {
      paragraphs[paragraphs.length - 1] += ` ${text}`;
    } else {
      paragraphs.push(text);
    }
    previous = line;
  }
  return paragraphs;
}

function isTextItem(
  item: unknown,
): item is { str: string; transform: number[]; height: number; hasEOL: boolean } {
  return (
    typeof item === "object" &&
    item !== null &&
    typeof (item as { str?: unknown }).str === "string" &&
    Array.isArray((item as { transform?: unknown }).transform)
  );
}

function outcome(
  status: "no-text" | "encrypted" | "malformed" | "limit-exceeded",
  detail: string,
): ParserResult {
  return { kind: "outcome", status, detail };
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`PDF text adapter option ${name} must be a positive integer, got ${value}.`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
