import { computeTextStats } from "./textSegmentation";
import type {
  DocumentAsset,
  ExtractedDocument,
  ExtractedParagraph,
  ExtractorIdentity,
} from "./types";

/** Text of one physical page of a paged original, already split into paragraphs. */
export interface ExtractedPage {
  /** 1-based physical page number. */
  page: number;
  paragraphs: string[];
}

export interface PagedDocumentInput {
  id: string;
  title: string;
  sourceUri: string;
  importedAt: string;
  pages: readonly ExtractedPage[];
  asset: DocumentAsset;
  extractor: ExtractorIdentity;
}

/**
 * Builds the shared corpus model for text extracted from a paged binary original (PDF).
 *
 * Paragraph ordinals ascend with the physical page, and every paragraph lies on exactly one
 * page, so a hit on a paragraph maps to one page. Empty pages keep their number but contribute
 * no paragraph. `text` is the paragraphs joined by "\n\n", the same invariant as HTML
 * extraction; there is no HTML for a binary original, so `html` stays empty.
 */
export function extractPagedDocument(input: PagedDocumentInput): ExtractedDocument {
  const paragraphs: ExtractedParagraph[] = [];
  const pages = [...input.pages].sort((left, right) => left.page - right.page);
  for (const { page, paragraphs: texts } of pages) {
    for (const raw of texts) {
      const text = normalizePageText(raw);
      if (!text) continue;
      const ordinal = paragraphs.length;
      paragraphs.push({
        id: `${input.id}:p${ordinal}`,
        documentId: input.id,
        ordinal,
        text,
        headingPath: [],
        page,
      });
    }
  }
  const text = paragraphs.map((paragraph) => paragraph.text).join("\n\n");
  return {
    id: input.id,
    title: normalizePageText(input.title) || input.sourceUri,
    sourceUri: input.sourceUri,
    html: "",
    text,
    paragraphs,
    importedAt: input.importedAt,
    asset: input.asset,
    extractor: input.extractor,
    stats: computeTextStats(text),
  };
}

/** NFC with every whitespace run collapsed to one space and trimmed. */
export function normalizePageText(text: string): string {
  return text.normalize("NFC").replace(/\s+/gu, " ").trim();
}
