import { runTextIndexOperation } from "../wasm/textIndex";
import { findExactPhraseMatches, parsePhraseQuery } from "./phraseQuery";
import { normalizeSearchableText } from "./textSegmentation";
import type {
  ExtractedDocument,
  FuzzyTermMatchView,
  SearchFilterState,
  SearchRequestState,
  SearchResultView,
} from "./types";

const FUZZY_SEARCH_OPTIONS = {
  maxEditDistance: 1,
  minTermLength: 4,
  maxExpansionsPerTerm: 3,
  maxQueryVariants: 16,
  maxVocabularyTerms: 20_000,
  fuzzyWeight: 0.8,
} as const;

interface RawSearchResult {
  chunkId?: string;
  documentId?: string;
  score?: number;
  snippet?: string;
  matchedPhrases?: string[];
  fuzzyMatches?: FuzzyTermMatchView[];
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

  const documentIds = resolveSearchDocumentIds(documents, request.filters);
  if (documentIds?.length === 0) {
    return [];
  }

  const candidates = await runSearch(
    documents,
    normalizedSearchText,
    request.mode,
    request.topK,
    phrases,
    request.fuzzy === true && request.mode === "lexical",
    documentIds,
  );

  return candidates
    .map((candidate) => toSearchResultView(candidate, documents, phrases))
    .slice(0, request.topK);
}

export function resolveSearchDocumentIds(
  documents: ExtractedDocument[],
  filters?: SearchFilterState,
): string[] | undefined {
  if (!filters || !hasActiveFilters(filters)) {
    return undefined;
  }

  const selectedIds = new Set(filters.documentIds);
  const titleNeedle = normalizeSearchableText(filters.titleContains);
  const sourceNeedle = normalizeSearchableText(filters.sourceContains);
  const invalidDateRange =
    filters.importedFrom !== "" &&
    filters.importedTo !== "" &&
    filters.importedFrom > filters.importedTo;
  if (invalidDateRange) {
    return [];
  }

  return documents
    .filter((document) => {
      if (selectedIds.size > 0 && !selectedIds.has(document.id)) {
        return false;
      }
      if (titleNeedle && !normalizeSearchableText(document.title).includes(titleNeedle)) {
        return false;
      }
      if (
        sourceNeedle &&
        !normalizeSearchableText(document.sourceUri ?? "").includes(sourceNeedle)
      ) {
        return false;
      }
      const importedDate = document.importedAt.slice(0, 10);
      if (filters.importedFrom && importedDate < filters.importedFrom) {
        return false;
      }
      if (filters.importedTo && importedDate > filters.importedTo) {
        return false;
      }
      return true;
    })
    .map((document) => document.id);
}

function hasActiveFilters(filters: SearchFilterState): boolean {
  return (
    filters.titleContains.trim() !== "" ||
    filters.sourceContains.trim() !== "" ||
    filters.importedFrom !== "" ||
    filters.importedTo !== "" ||
    filters.documentIds.length > 0
  );
}

async function runSearch(
  documents: ExtractedDocument[],
  query: string,
  mode: SearchRequestState["mode"],
  topK: number,
  requiredPhrases: string[],
  fuzzy: boolean,
  documentIds?: string[],
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
        filter: {
          documentIds: documentIds ?? [],
        },
        ...(fuzzy ? { fuzzy: FUZZY_SEARCH_OPTIONS } : {}),
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
    fuzzyMatches: raw.fuzzyMatches ?? [],
  };
}
