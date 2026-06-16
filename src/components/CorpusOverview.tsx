import type { CorpusStats } from "../domain/types";

interface CorpusOverviewProps {
  stats: CorpusStats;
}

export function CorpusOverview({ stats }: CorpusOverviewProps) {
  return (
    <div className="summary-block">
      <div className="section-heading">
        <h2>Summary</h2>
      </div>
      <dl className="stats-grid">
        <Stat label="Documents" value={stats.documents} />
        <Stat label="Words" value={stats.words} />
        <Stat label="Sentences" value={stats.sentences} />
        <Stat label="Paragraphs" value={stats.paragraphs} />
        <Stat label="Unique words" value={stats.uniqueWords} />
      </dl>
      <div className="term-list" aria-label="Top terms">
        {stats.topTerms.length === 0 ? (
          <span className="muted">No terms yet.</span>
        ) : (
          stats.topTerms.map((term) => (
            <span key={term.term} className="term-chip">
              {term.term} <b>{term.count}</b>
            </span>
          ))
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value.toLocaleString()}</dd>
    </div>
  );
}
