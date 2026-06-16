import { runTextIndexOperation } from "../wasm/textIndex";
import { findExactPhraseMatches, parsePhraseQuery, resultContainsAllPhrases } from "./phraseQuery";
import type { ExtractedDocument, SearchRequestState, SearchResultView } from "./types";

interface RawSearchResult {
  chunkId?: string;
  documentId?: string;
  score?: number;
  snippet?: string;
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

  const candidateLimits =
    phrases.length > 0 ? [request.topK, request.topK * 4, request.topK * 12] : [request.topK];

  for (const candidateLimit of candidateLimits) {
    const candidates = await runSearch(
      documents,
      normalizedSearchText,
      request.mode,
      candidateLimit,
    );
    const filtered = candidates
      .map((candidate) => toSearchResultView(candidate, documents, phrases))
      .filter((candidate) => resultContainsAllPhrases(candidate, phrases));

    if (filtered.length >= request.topK || candidateLimit === candidateLimits.at(-1)) {
      return filtered.slice(0, request.topK);
    }
  }

  return [];
}

async function runSearch(
  documents: ExtractedDocument[],
  query: string,
  mode: SearchRequestState["mode"],
  topK: number,
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
    exactPhraseMatches: findExactPhraseMatches(snippet, phrases),
  };
}
