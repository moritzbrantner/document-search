import { useMemo, useState } from "react";
import { segmentTextDocument } from "../domain/textSegmentation";
import type { ExtractedDocument } from "../domain/types";

interface DocumentInspectorProps {
  document?: ExtractedDocument;
}

export function DocumentInspector({ document }: DocumentInspectorProps) {
  const [showRawHtml, setShowRawHtml] = useState(false);
  const segments = useMemo(
    () => (document ? segmentTextDocument(document.text) : undefined),
    [document],
  );

  if (!document) {
    return (
      <div className="inspector">
        <div className="section-heading">
          <h2>Inspector</h2>
        </div>
        <div className="empty-row">Select a document.</div>
      </div>
    );
  }

  return (
    <div className="inspector">
      <div className="section-heading">
        <h2>Inspector</h2>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={showRawHtml}
            onChange={(event) => setShowRawHtml(event.target.checked)}
          />
          Raw HTML
        </label>
      </div>
      <div className="document-header">
        <h3>{document.title}</h3>
        <span>{document.sourceUri || document.id}</span>
        <small>
          {segments?.sentences.length.toLocaleString()} sentences,{" "}
          {segments?.tokens.length.toLocaleString()} tokens
        </small>
      </div>
      {showRawHtml ? (
        <pre className="raw-html">{document.html}</pre>
      ) : (
        <div className="paragraph-list">
          {document.paragraphs.map((paragraph) => (
            <article className="paragraph-row" key={paragraph.id}>
              <div className="result-meta">
                <span>#{paragraph.ordinal + 1}</span>
                {paragraph.headingPath.length > 0 ? (
                  <span>{paragraph.headingPath.join(" / ")}</span>
                ) : null}
                {paragraph.sourceSelector ? <span>{paragraph.sourceSelector}</span> : null}
              </div>
              <p>{paragraph.text}</p>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
