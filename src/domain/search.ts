import { runTextIndexOperation } from "../wasm/textIndex";
import { findExactPhraseMatches, parsePhraseQuery } from "./phraseQuery";
import type { ExtractedDocument, SearchRequestState, SearchResultView } from "./types";

interface RawSearchResult {
  chunkId?: string;
  documentId?: string;
  score?: number;
  snippet?: string;
  matchedPhrases?: string[];
  chunk?: {
    id?: string;
    documentId?: string;
    ordinal?: number;
    text?: string;
  };
}

export async function searchCorpus(
  documents: ExtractedDocument[],
  request: SearchRequestState,
): Promise<SearchResultView[]> {
  const parsed = parsePhraseQuery(request.query);
  const phrases = request.requireQuotedPhrases ? parsed.quotedPhrases : [];
  const normalizedSearchText = parsed.searchText || request.query.replace(/"/g, " ").trim();

  if (!normalizedSearchText || documents.length === 0) {
    return [];
  }

  const candidates = await runSearch(
    documents,
    normalizedSearchText,
    request.mode,
    request.topK,
    phrases,
  );

  return candidates
    .map((candidate) => toSearchResultView(candidate, documents, phrases))
    .slice(0, request.topK);
}

async function runSearch(
  documents: ExtractedDocument[],
  query: string,
  mode: SearchRequestState["mode"],
  topK: number,
  requiredPhrases: string[],
): Promise<RawSearchResult[]> {
  const response = await runTextIndexOperation({
    operation: "index.search",
    input: {
      backend: "memory",
      documents: documents.map((document) => ({
        id: document.id,
        title: document.title,
        body: document.text,
        language: "en",
        metadata: {
          attributes: {
            sourceKind: "html",
            sourceUri: document.sourceUri ?? "",
            importedAt: document.importedAt,
            paragraphCount: String(document.paragraphs.length),
          },
        },
      })),
      query: {
        text: query,
        mode,
        topK,
        requiredPhrases,
        explain: true,
      },
      options: {
        chunkingStrategy: "paragraph",
        chunkTokens: 256,
        chunkOverlapTokens: 0,
        storeRawText: true,
        commit: false,
      },
      dimensions: 128,
    },
  });

  const value = response.value as {
    result?: { results?: RawSearchResult[] };
    results?: RawSearchResult[];
  };
  return value.result?.results ?? value.results ?? [];
}

function toSearchResultView(
  raw: RawSearchResult,
  documents: ExtractedDocument[],
  phrases: string[],
): SearchResultView {
  const documentId = raw.documentId ?? raw.chunk?.documentId ?? "";
  const document = documents.find((candidate) => candidate.id === documentId);
  const snippet = raw.snippet ?? raw.chunk?.text ?? "";
  const paragraphOrdinal = raw.chunk?.ordinal;

  return {
    documentId,
    documentTitle: document?.title ?? documentId,
    chunkId: raw.chunkId ?? raw.chunk?.id ?? "",
    score: raw.score ?? 0,
    snippet,
    paragraphOrdinal,
    exactPhraseMatches: raw.matchedPhrases ?? findExactPhraseMatches(snippet, phrases),
  };
}
