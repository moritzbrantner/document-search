import { useState } from "react";
import type { CorpusSnapshot } from "../domain/types";

interface CorpusToolbarProps {
  disabled: boolean;
  snapshotPreview: CorpusSnapshot;
  onClear: () => Promise<void>;
  onExport: () => void;
  onImportSnapshot: (json: string) => Promise<void>;
}

export function CorpusToolbar({
  disabled,
  snapshotPreview,
  onClear,
  onExport,
  onImportSnapshot,
}: CorpusToolbarProps) {
  const [operationStatus, setOperationStatus] = useState("");
  const [operationError, setOperationError] = useState("");
  const [isImporting, setIsImporting] = useState(false);

  async function importFile(files: FileList | null) {
    const file = files?.[0];
    if (!file) {
      return;
    }
    setIsImporting(true);
    setOperationError("");
    setOperationStatus("Uploading JSON snapshot...");
    try {
      const json = await file.text();
      setOperationStatus("Importing JSON snapshot...");
      await onImportSnapshot(json);
      setOperationStatus("Imported JSON snapshot.");
    } catch (error: unknown) {
      setOperationError(errorMessage(error));
      setOperationStatus("");
    } finally {
      setIsImporting(false);
    }
  }

  function exportFile() {
    setOperationError("");
    setOperationStatus("Downloading JSON snapshot...");
    try {
      onExport();
      setOperationStatus("Downloaded JSON snapshot.");
    } catch (error: unknown) {
      setOperationError(errorMessage(error));
      setOperationStatus("");
    }
  }

  return (
    <>
      <div className="toolbar" aria-label="Corpus actions">
        <button type="button" onClick={exportFile} disabled={disabled || isImporting}>
          Export JSON
        </button>
        <label className="file-button">
          {isImporting ? "Importing..." : "Import JSON"}
          <input
            type="file"
            accept="application/json,.json"
            disabled={isImporting}
            onChange={(event) => void importFile(event.target.files)}
          />
        </label>
        <button type="button" onClick={() => void onClear()} disabled={disabled || isImporting}>
          Clear
        </button>
        <span className="snapshot-meta">v{snapshotPreview.schemaVersion}</span>
      </div>
      {operationStatus ? <p className="inline-status toolbar-status">{operationStatus}</p> : null}
      {operationError ? (
        <p className="inline-error toolbar-status" role="alert">
          {operationError}
        </p>
      ) : null}
    </>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
