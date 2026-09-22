export interface HtmlDocumentInput {
  id?: string;
  title?: string;
  sourceUri?: string;
  html: string;
  importedAt: string;
}

export interface ExtractedParagraph {
  id: string;
  documentId: string;
  ordinal: number;
  text: string;
  sourceSelector?: string;
  headingPath: string[];
}

export interface ExtractedDocument {
  id: string;
  title: string;
  sourceUri?: string;
  html: string;
  text: string;
  paragraphs: ExtractedParagraph[];
  importedAt: string;
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
