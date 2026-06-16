import { normalizeSearchableText } from "./textSegmentation";
import type { CorpusStats, ExtractedDocument } from "./types";

const STOP_TERMS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "to",
  "with",
]);

export function computeCorpusStats(documents: ExtractedDocument[]): CorpusStats {
  const termCounts = new Map<string, number>();
  const uniqueTerms = new Set<string>();

  for (const document of documents) {
    for (const word of extractTerms(document.text)) {
      uniqueTerms.add(word);
      if (!STOP_TERMS.has(word)) {
        termCounts.set(word, (termCounts.get(word) ?? 0) + 1);
      }
    }
  }

  return {
    documents: documents.length,
    words: documents.reduce((sum, document) => sum + document.stats.words, 0),
    sentences: documents.reduce((sum, document) => sum + document.stats.sentences, 0),
    paragraphs: documents.reduce((sum, document) => sum + document.stats.paragraphs, 0),
    uniqueWords: uniqueTerms.size,
    topTerms: Array.from(termCounts.entries())
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 12)
      .map(([term, count]) => ({ term, count })),
  };
}

function extractTerms(text: string): string[] {
  return normalizeSearchableText(text).match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? [];
}
