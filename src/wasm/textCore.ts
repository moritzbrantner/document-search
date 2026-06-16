import {
  analyzeTextDocument as analyze,
  segmentTextDocument as segment,
  type SegmentedTextDocument,
  type TextDocumentAnalysis,
} from "@moritzbrantner/text-core-wasm";

export function analyzeTextDocument(text: string): TextDocumentAnalysis {
  return analyze(text, { includePunctuation: false, includeTokens: true });
}

export function segmentTextDocument(text: string): SegmentedTextDocument {
  return segment(text, true, false, true);
}

export function textStatsFromAnalysis(analysis: TextDocumentAnalysis) {
  return {
    words: analysis.stats.tokens,
    sentences: analysis.stats.sentences,
    paragraphs: analysis.stats.paragraphs,
    uniqueWords: analysis.stats.uniqueTokens,
  };
}
