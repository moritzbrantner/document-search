/** The imported content exactly as uploaded, before normalization to HTML. */
export interface OriginalDocumentContent {
  content: string;
  mediaType: "text/html" | "text/markdown" | "text/plain";
}

export interface HtmlDocumentInput {
  id?: string;
  title?: string;
  sourceUri?: string;
  html: string;
  importedAt: string;
  original?: OriginalDocumentContent;
}

/** Identity of the extraction library and configuration that derived a document's text. */
export interface ExtractorIdentity {
  name: string;
  version: string;
  configuration: Record<string, string | number | boolean>;
}

/** The binary original a document's text was extracted from (absent for text imports). */
export interface DocumentAsset {
  mediaType: "application/pdf";
  /** SHA-256 of the exact original bytes. */
  sha256: string;
  byteLength: number;
  /** Physical page count, including pages without text. */
  pageCount: number;
}

export interface ExtractedParagraph {
  id: string;
  documentId: string;
  ordinal: number;
  text: string;
  sourceSelector?: string;
  headingPath: string[];
  /** 1-based physical page of a paged original (PDF); absent for text imports. */
  page?: number;
}

export interface ExtractedDocument {
  id: string;
  title: string;
  sourceUri?: string;
  html: string;
  text: string;
  paragraphs: ExtractedParagraph[];
  importedAt: string;
  /** Absent for documents stored before originals were retained. */
  original?: OriginalDocumentContent;
  /** Binary original (PDF); its text is a derived representation. Absent for text imports. */
  asset?: DocumentAsset;
  /** Extractor that derived the text from `asset`; absent for text imports. */
  extractor?: ExtractorIdentity;
  stats: {
    words: number;
    sentences: number;
    paragraphs: number;
    uniqueWords: number;
  };
}

export interface CorpusSnapshot {
  schemaVersion: 1;
  documents: ExtractedDocument[];
  exportedAt: string;
}

export interface SourceSpanBatchV1 {
  schema: "source_span_interchange";
  schemaVersion: 1;
  producer: SourceProducerV1;
  sources: SourceRecordV1[];
  spans: SourceSpanRecordV1[];
}

export interface SourceProducerV1 {
  name: string;
  revision: string;
}

export interface SourceRecordV1 {
  id: string;
  kind: string;
  revision: string;
  uri?: string;
  title?: string;
  creators: string[];
  language?: string;
  contentHash: string;
  metadata: Record<string, unknown>;
}

export interface SourceSpanRecordV1 {
  id: string;
  sourceId: string;
  sequence: number;
  text: string;
  contentHash: string;
  language?: string;
  locator: SourceLocatorV1;
  metadata: Record<string, unknown>;
}

export type SourceLocatorV1 =
  | {
      kind: "text";
      byteStart: number;
      byteEnd: number;
      paragraphOrdinal?: number;
      page?: number;
      section?: string;
      sourceSelector?: string;
      headingPath: string[];
    }
  | {
      kind: "timed";
      segmentIndex: number;
      startSeconds?: number;
      endSeconds?: number;
    };

export type DuplicateRule = "same-page" | "same-content" | "same-page-or-content";

export interface ImportPreferences {
  duplicateRule: DuplicateRule;
}

export interface SearchFilterState {
  titleContains: string;
  sourceContains: string;
  importedFrom: string;
  importedTo: string;
  documentIds: string[];
}

export interface SearchRequestState {
  query: string;
  topK: number;
  mode: "hybrid" | "lexical" | "semantic";
  requireQuotedPhrases: boolean;
  fuzzy?: boolean;
  filters?: SearchFilterState;
}

export interface FuzzyTermMatchView {
  queryTerm: string;
  matchedTerm: string;
  editDistance: number;
  similarity: number;
}

export interface SearchResultView {
  documentId: string;
  documentTitle: string;
  chunkId: string;
  score: number;
  snippet: string;
  paragraphOrdinal?: number;
  /** 1-based physical page of the hit's paragraph; absent for text imports. */
  page?: number;
  exactPhraseMatches: string[];
  fuzzyMatches: FuzzyTermMatchView[];
}

export interface CorpusStats {
  documents: number;
  words: number;
  sentences: number;
  paragraphs: number;
  uniqueWords: number;
  topTerms: Array<{ term: string; count: number }>;
}
