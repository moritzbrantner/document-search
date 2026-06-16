import { analyzeTextDocument, segmentTextDocument, textStatsFromAnalysis } from "../wasm/textCore";

export { analyzeTextDocument, segmentTextDocument };

export function computeTextStats(text: string) {
  return textStatsFromAnalysis(analyzeTextDocument(text));
}

export function normalizeSearchableText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}
