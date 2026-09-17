import { useState } from "react";
import type { ExtractedDocument, SearchFilterState, SearchRequestState } from "../domain/types";

const EMPTY_FILTERS: SearchFilterState = {
  titleContains: "",
  sourceContains: "",
  importedFrom: "",
  importedTo: "",
  documentIds: [],
};

interface SearchPanelProps {
  disabled: boolean;
  documents: ExtractedDocument[];
  request: SearchRequestState;
  onSearch: (request: SearchRequestState) => Promise<void>;
}

export function SearchPanel({ disabled, documents, request, onSearch }: SearchPanelProps) {
  const [draft, setDraft] = useState(request);
  const filters = draft.filters ?? EMPTY_FILTERS;

  function patchDraft(patch: Partial<SearchRequestState>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  function patchFilters(patch: Partial<SearchFilterState>) {
    patchDraft({ filters: { ...filters, ...patch } });
  }

  return (
    <form
      className="search-form"
      onSubmit={(event) => {
        event.preventDefault();
        void onSearch(draft);
      }}
    >
      <div className="search-row">
        <input
          value={draft.query}
          onChange={(event) => patchDraft({ query: event.target.value })}
          placeholder='Search words, concepts, or "exact phrases"'
          disabled={disabled}
        />
        <button type="submit" disabled={disabled || !draft.query.trim()}>
          Search
        </button>
      </div>
      <div className="control-row">
        <label>
          Mode
          <select
            value={draft.mode}
            onChange={(event) => {
              const mode = event.target.value as SearchRequestState["mode"];
              patchDraft({ mode, fuzzy: mode === "lexical" ? draft.fuzzy : false });
            }}
            disabled={disabled}
          >
            <option value="hybrid">Hybrid</option>
            <option value="lexical">Lexical</option>
            <option value="semantic">Semantic</option>
          </select>
        </label>
        <label>
          Top K
          <input
            type="number"
            min={1}
            max={50}
            value={draft.topK}
            onChange={(event) => patchDraft({ topK: Number(event.target.value) })}
            disabled={disabled}
          />
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={draft.requireQuotedPhrases}
            onChange={(event) => patchDraft({ requireQuotedPhrases: event.target.checked })}
            disabled={disabled}
          />
          Exact quoted phrases
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={draft.fuzzy ?? false}
            onChange={(event) =>
              patchDraft({
                fuzzy: event.target.checked,
                ...(event.target.checked ? { mode: "lexical" } : {}),
              })
            }
            disabled={disabled}
          />
          Typo-tolerant
        </label>
      </div>
      <details className="search-filters">
        <summary>Filters</summary>
        <div className="filter-grid">
          <label>
            Title contains
            <input
              value={filters.titleContains}
              onChange={(event) => patchFilters({ titleContains: event.target.value })}
              disabled={disabled}
            />
          </label>
          <label>
            Source contains
            <input
              value={filters.sourceContains}
              onChange={(event) => patchFilters({ sourceContains: event.target.value })}
              disabled={disabled}
            />
          </label>
          <label>
            Imported from (UTC)
            <input
              type="date"
              value={filters.importedFrom}
              onChange={(event) => patchFilters({ importedFrom: event.target.value })}
              disabled={disabled}
            />
          </label>
          <label>
            Imported through (UTC)
            <input
              type="date"
              value={filters.importedTo}
              onChange={(event) => patchFilters({ importedTo: event.target.value })}
              disabled={disabled}
            />
          </label>
          <label className="document-filter">
            Documents
            <select
              multiple
              value={filters.documentIds}
              onChange={(event) =>
                patchFilters({
                  documentIds: Array.from(
                    event.target.selectedOptions,
                    (option) => option.value,
                  ),
                })
              }
              disabled={disabled}
              aria-describedby="document-filter-help"
            >
              {documents.map((document) => (
                <option key={document.id} value={document.id}>
                  {document.title}
                </option>
              ))}
            </select>
            <span className="control-help" id="document-filter-help">
              Leave empty to search every document.
            </span>
          </label>
        </div>
      </details>
    </form>
  );
}
