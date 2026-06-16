import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { CorpusOverview } from "./components/CorpusOverview";
import { CorpusToolbar } from "./components/CorpusToolbar";
import { DocumentPreviewModal } from "./components/DocumentPreviewModal";
import { DocumentImportPanel } from "./components/DocumentImportPanel";
import { DocumentInspector } from "./components/DocumentInspector";
import { SearchPanel } from "./components/SearchPanel";
import { SearchResults } from "./components/SearchResults";
import { computeCorpusStats } from "./domain/corpusStats";
import { dedupeDocumentsByRule, isDuplicateDocument } from "./domain/duplicateRules";
import { extractHtmlDocument } from "./domain/htmlExtraction";
import { searchCorpus } from "./domain/search";
import type {
  DuplicateRule,
  ExtractedDocument,
  HtmlDocumentInput,
  SearchRequestState,
  SearchResultView,
} from "./domain/types";
import {
  createCorpusSnapshot,
  parseCorpusSnapshot,
  serializeCorpusSnapshot,
} from "./storage/exportImport";
import {
  clearCorpus,
  deleteDocument,
  listDocuments,
  putDocument,
  replaceCorpus,
} from "./storage/indexedDbStore";
import { loadDuplicateRule, saveDuplicateRule } from "./storage/preferences";

const DEFAULT_SEARCH_REQUEST: SearchRequestState = {
  query: "",
  topK: 10,
  mode: "hybrid",
  requireQuotedPhrases: true,
};
const DOCUMENTS_QUERY_KEY = ["documents"] as const;
const EMPTY_DOCUMENTS: ExtractedDocument[] = [];

interface ImportResult {
  imported: number;
  skipped: number;
}

function App() {
  const [selectedDocumentId, setSelectedDocumentId] = useState<string>();
  const [previewResult, setPreviewResult] = useState<SearchResultView>();
  const [searchRequest, setSearchRequest] = useState<SearchRequestState>(DEFAULT_SEARCH_REQUEST);
  const [duplicateRule, setDuplicateRuleState] = useState<DuplicateRule>(() => loadDuplicateRule());
  const [status, setStatus] = useState<string>();
  const queryClient = useQueryClient();
  const documentsQuery = useQuery({
    queryKey: DOCUMENTS_QUERY_KEY,
    queryFn: async () => sortDocuments(await listDocuments()),
  });
  const documents = documentsQuery.data ?? EMPTY_DOCUMENTS;
  const activeSelectedDocumentId = documents.some((document) => document.id === selectedDocumentId)
    ? selectedDocumentId
    : documents[0]?.id;
  const selectedDocument = documents.find((document) => document.id === activeSelectedDocumentId);
  const previewDocument = documents.find((document) => document.id === previewResult?.documentId);
  const corpusStats = useMemo(() => computeCorpusStats(documents), [documents]);
  const corpusStatus = getCorpusStatus(documentsQuery, documents, status);

  const searchMutation = useMutation({
    mutationFn: (request: SearchRequestState) => searchCorpus(documents, request),
    onMutate: (request) => {
      setSearchRequest(request);
      setStatus("Searching...");
    },
    onSuccess: (nextResults) => {
      setStatus(
        nextResults.length === 0 ? "No matching chunks." : `Found ${nextResults.length} chunk(s).`,
      );
    },
    onError: (error) => {
      setStatus(errorMessage(error));
    },
  });
  const visibleResults = useMemo(
    () =>
      (searchMutation.data ?? []).filter((result) =>
        documents.some((document) => document.id === result.documentId),
      ),
    [documents, searchMutation.data],
  );

  const setDuplicateRule = useCallback((nextRule: DuplicateRule) => {
    setDuplicateRuleState(nextRule);
    saveDuplicateRule(nextRule);
  }, []);

  const importDocumentsMutation = useMutation({
    mutationFn: async (inputs: HtmlDocumentInput[]) => {
      const extracted = inputs.map(extractHtmlDocument);
      const accepted: ExtractedDocument[] = [];
      let skipped = 0;

      for (const document of extracted) {
        if (isDuplicateDocument(document, [...documents, ...accepted], duplicateRule)) {
          skipped += 1;
          continue;
        }
        accepted.push(document);
      }

      for (const document of accepted) {
        await putDocument(document);
      }
      return { accepted, imported: accepted.length, skipped };
    },
    onSuccess: ({ accepted, imported, skipped }) => {
      if (accepted.length > 0) {
        queryClient.setQueryData<ExtractedDocument[]>(DOCUMENTS_QUERY_KEY, (current = []) => {
          const merged = new Map(current.map((document) => [document.id, document]));
          for (const document of accepted) {
            merged.set(document.id, document);
          }
          return sortDocuments(Array.from(merged.values()));
        });
        setSelectedDocumentId(accepted[0]?.id);
      }
      setStatus(importStatusMessage(imported, skipped));
    },
  });

  const upsertDocuments = useCallback(
    async (inputs: HtmlDocumentInput[]): Promise<ImportResult> => {
      const result = await importDocumentsMutation.mutateAsync(inputs);
      return { imported: result.imported, skipped: result.skipped };
    },
    [importDocumentsMutation],
  );

  const deleteDocumentMutation = useMutation({
    mutationFn: deleteDocument,
    onSuccess: (_result, id) => {
      queryClient.setQueryData<ExtractedDocument[]>(DOCUMENTS_QUERY_KEY, (current = []) =>
        current.filter((document) => document.id !== id),
      );
      searchMutation.reset();
      setPreviewResult(undefined);
      setStatus("Document removed.");
    },
  });

  const removeDocument = useCallback(
    async (id: string) => {
      await deleteDocumentMutation.mutateAsync(id);
    },
    [deleteDocumentMutation],
  );

  const runSearch = useCallback(
    async (request: SearchRequestState) => {
      await searchMutation.mutateAsync(request);
    },
    [searchMutation],
  );

  const exportCorpus = useCallback(() => {
    const json = serializeCorpusSnapshot(documents);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `document-search-corpus-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setStatus("Corpus exported.");
  }, [documents]);

  const importSnapshotMutation = useMutation({
    mutationFn: async (json: string) => {
      const snapshot = parseCorpusSnapshot(json);
      const uniqueDocuments = dedupeDocumentsByRule(snapshot.documents, duplicateRule);
      await replaceCorpus({ ...snapshot, documents: uniqueDocuments });
      return {
        skipped: snapshot.documents.length - uniqueDocuments.length,
        sortedDocuments: sortDocuments(uniqueDocuments),
      };
    },
    onMutate: () => {
      setStatus("Importing corpus snapshot...");
    },
    onSuccess: ({ skipped, sortedDocuments }) => {
      queryClient.setQueryData(DOCUMENTS_QUERY_KEY, sortedDocuments);
      setSelectedDocumentId(sortedDocuments[0]?.id);
      searchMutation.reset();
      setPreviewResult(undefined);
      setStatus(
        skipped === 0
          ? `Imported snapshot with ${sortedDocuments.length} document(s).`
          : `Imported snapshot with ${sortedDocuments.length} document(s); skipped ${skipped} duplicate(s).`,
      );
    },
  });

  const importSnapshot = useCallback(
    async (json: string) => {
      await importSnapshotMutation.mutateAsync(json);
    },
    [importSnapshotMutation],
  );

  const clearCorpusMutation = useMutation({
    mutationFn: clearCorpus,
    onSuccess: () => {
      queryClient.setQueryData(DOCUMENTS_QUERY_KEY, []);
      setSelectedDocumentId(undefined);
      searchMutation.reset();
      setPreviewResult(undefined);
      setStatus("Corpus cleared.");
    },
  });

  const clearAll = useCallback(async () => {
    await clearCorpusMutation.mutateAsync();
  }, [clearCorpusMutation]);

  return (
    <main className="app-shell">
      <section className="panel panel-left" aria-label="Import and corpus">
        <DocumentImportPanel
          duplicateRule={duplicateRule}
          documents={documents}
          selectedDocumentId={activeSelectedDocumentId}
          onDuplicateRuleChange={setDuplicateRule}
          onImport={upsertDocuments}
          onSelectDocument={setSelectedDocumentId}
          onDeleteDocument={removeDocument}
        />
      </section>

      <section className="panel panel-center" aria-label="Search">
        <div className="topbar">
          <div>
            <h1>Document Search</h1>
            <p>{corpusStatus}</p>
          </div>
          <CorpusToolbar
            disabled={documents.length === 0}
            onClear={clearAll}
            onExport={exportCorpus}
            onImportSnapshot={importSnapshot}
            snapshotPreview={createCorpusSnapshot(documents)}
          />
        </div>
        <SearchPanel
          disabled={documents.length === 0 || searchMutation.isPending}
          request={searchRequest}
          onSearch={runSearch}
        />
        <SearchResults
          documents={documents}
          results={visibleResults}
          onSelectResult={(result) => {
            setSelectedDocumentId(result.documentId);
            setPreviewResult(result);
          }}
        />
      </section>

      <section className="panel panel-right" aria-label="Corpus summary and inspector">
        <CorpusOverview stats={corpusStats} />
        <DocumentInspector document={selectedDocument} />
      </section>
      {previewResult && previewDocument ? (
        <DocumentPreviewModal
          document={previewDocument}
          query={searchRequest.query}
          result={previewResult}
          onClose={() => setPreviewResult(undefined)}
        />
      ) : null}
    </main>
  );
}

function sortDocuments(documents: ExtractedDocument[]): ExtractedDocument[] {
  return [...documents].sort((left, right) => right.importedAt.localeCompare(left.importedAt));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getCorpusStatus(
  documentsQuery: UseQueryResult<ExtractedDocument[], Error>,
  documents: ExtractedDocument[],
  status?: string,
): string {
  if (documentsQuery.isPending) {
    return "Loading local corpus...";
  }
  if (documentsQuery.isError) {
    return errorMessage(documentsQuery.error);
  }
  return (
    status ??
    (documents.length === 0 ? "Corpus is empty." : `Restored ${documents.length} document(s).`)
  );
}

export default App;

function importStatusMessage(imported: number, skipped: number): string {
  if (imported === 0 && skipped > 0) {
    return skipped === 1
      ? "Skipped duplicate document."
      : `Skipped ${skipped} duplicate document(s).`;
  }
  if (skipped > 0) {
    return `Imported ${imported} document(s); skipped ${skipped} duplicate(s).`;
  }
  return `Imported ${imported} document(s).`;
}
