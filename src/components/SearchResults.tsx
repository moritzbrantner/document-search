import type { ExtractedDocument, SearchResultView } from "../domain/types";

interface SearchResultsProps {
  documents: ExtractedDocument[];
  results: SearchResultView[];
  onSelectResult: (result: SearchResultView) => void;
}

export function SearchResults({ documents, results, onSelectResult }: SearchResultsProps) {
  return (
    <div className="results-region">
      <div className="section-heading">
        <h2>Results</h2>
        <span>{results.length}</span>
      </div>
      {documents.length === 0 ? (
        <div className="empty-row">Import HTML documents to search.</div>
      ) : results.length === 0 ? (
        <div className="empty-row">No results to show.</div>
      ) : (
        <div className="result-list">
          {results.map((result) => {
            const document = documents.find((candidate) => candidate.id === result.documentId);
            return (
              <article
                className="result-row"
                key={result.chunkId}
                onClick={() => onSelectResult(result)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelectResult(result);
                  }
                }}
                role="button"
                tabIndex={0}
              >
                <h3 className="result-title">{result.documentTitle}</h3>
                <div className="result-meta">
                  <span>{document?.sourceUri || result.documentId}</span>
                  <span>score {result.score.toFixed(3)}</span>
                  {result.paragraphOrdinal !== undefined ? (
                    <span>paragraph {result.paragraphOrdinal + 1}</span>
                  ) : null}
                  <span>{result.chunkId}</span>
                </div>
                <p>{result.snippet}</p>
                {result.exactPhraseMatches.length > 0 || result.fuzzyMatches.length > 0 ? (
                  <div className="term-list">
                    {result.exactPhraseMatches.map((phrase) => (
                      <span className="term-chip is-match" key={`phrase:${phrase}`}>
                        {phrase}
                      </span>
                    ))}
                    {result.fuzzyMatches.map((match) => (
                      <span
                        className="term-chip is-match"
                        key={`fuzzy:${match.queryTerm}:${match.matchedTerm}`}
                      >
                        {match.queryTerm} → {match.matchedTerm}
                      </span>
                    ))}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
