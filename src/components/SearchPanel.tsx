import { useState } from "react";
import type { SearchRequestState } from "../domain/types";

interface SearchPanelProps {
  disabled: boolean;
  request: SearchRequestState;
  onSearch: (request: SearchRequestState) => Promise<void>;
}

export function SearchPanel({ disabled, request, onSearch }: SearchPanelProps) {
  const [draft, setDraft] = useState(request);

  function patchDraft(patch: Partial<SearchRequestState>) {
    setDraft((current) => ({ ...current, ...patch }));
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
    </form>
  );
}
