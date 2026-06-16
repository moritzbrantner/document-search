import { useId, useState } from "react";
import { isDuplicateSourceUri } from "../domain/duplicateRules";
import type { DuplicateRule, ExtractedDocument, HtmlDocumentInput } from "../domain/types";

interface DocumentImportPanelProps {
  duplicateRule: DuplicateRule;
  documents: ExtractedDocument[];
  selectedDocumentId?: string;
  onDuplicateRuleChange: (rule: DuplicateRule) => void;
  onImport: (inputs: HtmlDocumentInput[]) => Promise<ImportResult>;
  onSelectDocument: (id: string) => void;
  onDeleteDocument: (id: string) => Promise<void>;
}

interface ImportResult {
  imported: number;
  skipped: number;
}

type ImportOperation = "paste" | "url" | "file" | undefined;

export function DocumentImportPanel({
  duplicateRule,
  documents,
  selectedDocumentId,
  onDuplicateRuleChange,
  onImport,
  onSelectDocument,
  onDeleteDocument,
}: DocumentImportPanelProps) {
  const titleId = useId();
  const uriId = useId();
  const urlId = useId();
  const htmlId = useId();
  const duplicateRuleId = useId();
  const [title, setTitle] = useState("");
  const [sourceUri, setSourceUri] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [html, setHtml] = useState("");
  const [importOperation, setImportOperation] = useState<ImportOperation>();
  const [operationStatus, setOperationStatus] = useState("");
  const [importError, setImportError] = useState("");
  const isImporting = Boolean(importOperation);

  async function importPastedHtml() {
    if (!html.trim()) {
      return;
    }
    setImportOperation("paste");
    setOperationStatus("Importing pasted HTML...");
    setImportError("");
    try {
      const result = await onImport([
        {
          title: title.trim() || undefined,
          sourceUri: sourceUri.trim() || undefined,
          html,
          importedAt: new Date().toISOString(),
        },
      ]);
      setOperationStatus(importResultMessage(result));
      if (result.imported > 0) {
        setTitle("");
        setSourceUri("");
        setHtml("");
      }
    } catch (error: unknown) {
      setImportError(errorMessage(error));
      setOperationStatus("");
    } finally {
      setImportOperation(undefined);
    }
  }

  async function importUrl() {
    const url = normalizeImportUrl(sourceUrl);
    if (!url) {
      return;
    }
    if (isDuplicateSourceUri(url, documents, duplicateRule)) {
      setImportError("That URL is already in the corpus.");
      setOperationStatus("");
      return;
    }
    setImportOperation("url");
    setOperationStatus("Downloading HTML from URL...");
    setImportError("");
    try {
      const payload = await fetchHtmlFromUrl(url);
      setOperationStatus("Importing downloaded HTML...");
      const result = await onImport([
        {
          title: title.trim() || undefined,
          sourceUri: payload.url ?? url,
          html: payload.html,
          importedAt: new Date().toISOString(),
        },
      ]);
      setOperationStatus(importResultMessage(result));
      if (result.imported > 0) {
        setTitle("");
        setSourceUri("");
        setSourceUrl("");
        setHtml("");
      }
    } catch (error: unknown) {
      setImportError(errorMessage(error));
      setOperationStatus("");
    } finally {
      setImportOperation(undefined);
    }
  }

  async function importFiles(files: FileList | null) {
    if (!files?.length) {
      return;
    }
    setImportOperation("file");
    setOperationStatus(`Uploading ${files.length} HTML file(s)...`);
    setImportError("");
    try {
      const inputs = await Promise.all(
        Array.from(files)
          .filter((file) => /\.html?$/i.test(file.name))
          .map(async (file) => ({
            title: file.name.replace(/\.html?$/i, ""),
            sourceUri: file.name,
            html: await file.text(),
            importedAt: new Date().toISOString(),
          })),
      );
      if (inputs.length > 0) {
        setOperationStatus("Importing uploaded HTML...");
        const result = await onImport(inputs);
        setOperationStatus(importResultMessage(result));
      } else {
        setOperationStatus("No HTML files selected.");
      }
    } catch (error: unknown) {
      setImportError(errorMessage(error));
      setOperationStatus("");
    } finally {
      setImportOperation(undefined);
    }
  }

  return (
    <>
      <div className="section-heading">
        <h2>Import</h2>
      </div>

      <div className="field-stack">
        <label htmlFor={titleId}>Title</label>
        <input
          id={titleId}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Optional title"
        />
      </div>
      <div className="field-stack">
        <label htmlFor={uriId}>Source URI</label>
        <input
          id={uriId}
          value={sourceUri}
          onChange={(event) => setSourceUri(event.target.value)}
          placeholder="Optional file name or URL"
        />
      </div>
      <div className="field-stack">
        <label htmlFor={urlId}>URL</label>
        <div className="url-import-row">
          <input
            id={urlId}
            value={sourceUrl}
            onChange={(event) => setSourceUrl(event.target.value)}
            placeholder="https://example.com/article"
            type="url"
          />
          <button
            type="button"
            onClick={importUrl}
            disabled={isImporting || !normalizeImportUrl(sourceUrl)}
          >
            {importOperation === "url" ? "Importing..." : "Import URL"}
          </button>
        </div>
      </div>
      <div className="field-stack">
        <label htmlFor={htmlId}>HTML</label>
        <textarea
          id={htmlId}
          value={html}
          onChange={(event) => setHtml(event.target.value)}
          rows={9}
          placeholder="<article>...</article>"
        />
      </div>
      <div className="field-stack">
        <label htmlFor={duplicateRuleId}>Duplicate rule</label>
        <select
          id={duplicateRuleId}
          value={duplicateRule}
          onChange={(event) => onDuplicateRuleChange(event.target.value as DuplicateRule)}
          disabled={isImporting}
        >
          <option value="same-page">Same page</option>
          <option value="same-content">Same content</option>
          <option value="same-page-or-content">Same page or content</option>
        </select>
      </div>
      <div className="button-row">
        <button type="button" onClick={importPastedHtml} disabled={isImporting || !html.trim()}>
          {importOperation === "paste" ? "Importing..." : "Import paste"}
        </button>
        <label className="file-button">
          {importOperation === "file" ? "Uploading..." : "Upload HTML"}
          <input
            type="file"
            accept=".html,.htm,text/html"
            multiple
            disabled={isImporting}
            onChange={(event) => void importFiles(event.target.files)}
          />
        </label>
      </div>
      {operationStatus ? <p className="inline-status">{operationStatus}</p> : null}
      {importError ? (
        <p className="inline-error" role="alert">
          {importError}
        </p>
      ) : null}

      <div className="section-heading document-list-heading">
        <h2>Corpus</h2>
        <span>{documents.length}</span>
      </div>
      <div className="document-list">
        {documents.length === 0 ? (
          <div className="empty-row">Paste HTML or upload .html files.</div>
        ) : (
          documents.map((document) => (
            <div
              className={`document-row ${selectedDocumentId === document.id ? "is-selected" : ""}`}
              key={document.id}
            >
              <button
                type="button"
                className="document-select"
                onClick={() => onSelectDocument(document.id)}
              >
                <strong>{document.title}</strong>
                <span>{document.sourceUri || document.id}</span>
                <small>
                  {document.stats.words.toLocaleString()} words,{" "}
                  {document.stats.paragraphs.toLocaleString()} paragraphs
                </small>
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={`Delete ${document.title}`}
                onClick={() => void onDeleteDocument(document.id)}
              >
                x
              </button>
            </div>
          ))
        )}
      </div>
    </>
  );
}

function normalizeImportUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withProtocol);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function importResultMessage(result: ImportResult): string {
  if (result.imported === 0 && result.skipped > 0) {
    return result.skipped === 1
      ? "Skipped duplicate document."
      : `Skipped ${result.skipped} duplicate document(s).`;
  }
  if (result.skipped > 0) {
    return `Imported ${result.imported} document(s); skipped ${result.skipped} duplicate(s).`;
  }
  return `Imported ${result.imported} document(s).`;
}

async function fetchHtmlFromUrl(url: string): Promise<{ html: string; url?: string }> {
  try {
    return await fetchHtmlThroughProxy(url);
  } catch (proxyError) {
    try {
      return await fetchHtmlDirectly(url);
    } catch (directError) {
      throw new Error(
        `${errorMessage(proxyError)} Direct browser fetch also failed: ${errorMessage(directError)}`,
        {
          cause: directError,
        },
      );
    }
  }
}

async function fetchHtmlThroughProxy(url: string): Promise<{ html: string; url?: string }> {
  const response = await fetch(`/api/import-html?url=${encodeURIComponent(url)}`, {
    headers: { Accept: "application/json" },
  });
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error("The local HTML import endpoint is unavailable.");
  }

  const payload = (await response.json()) as { html?: string; url?: string; error?: string };
  if (!response.ok || !payload.html) {
    throw new Error(payload.error ?? "Could not fetch HTML from that URL.");
  }
  return { html: payload.html, url: payload.url };
}

async function fetchHtmlDirectly(url: string): Promise<{ html: string; url?: string }> {
  const response = await fetch(url, {
    headers: { Accept: "text/html,application/xhtml+xml" },
  });
  if (!response.ok) {
    throw new Error(`The site returned ${response.status} ${response.statusText}.`);
  }

  return { html: await response.text(), url: response.url || url };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
