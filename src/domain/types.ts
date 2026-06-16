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

export type DuplicateRule = "same-page" | "same-content" | "same-page-or-content";

export interface ImportPreferences {
  duplicateRule: DuplicateRule;
}

export interface SearchRequestState {
  query: string;
  topK: number;
  mode: "hybrid" | "lexical" | "semantic";
  requireQuotedPhrases: boolean;
}

export interface SearchResultView {
  documentId: string;
  documentTitle: string;
  chunkId: string;
  score: number;
  snippet: string;
  paragraphOrdinal?: number;
  exactPhraseMatches: string[];
}

export interface CorpusStats {
  documents: number;
  words: number;
  sentences: number;
  paragraphs: number;
  uniqueWords: number;
  topTerms: Array<{ term: string; count: number }>;
}
