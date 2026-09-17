import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { parsePhraseQuery } from "../domain/phraseQuery";
import { normalizeSearchableText } from "../domain/textSegmentation";
import type { ExtractedDocument, ExtractedParagraph, SearchResultView } from "../domain/types";

interface DocumentPreviewModalProps {
  document: ExtractedDocument;
  query: string;
  result: SearchResultView;
  onClose: () => void;
}

export function DocumentPreviewModal({
  document,
  query,
  result,
  onClose,
}: DocumentPreviewModalProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const paragraphRefs = useRef<Record<number, HTMLElement | null>>({});
  const focusedParagraph = useMemo(
    () => resolveFocusedParagraph(document, result),
    [document, result],
  );
  const highlightTerms = useMemo(() => createHighlightTerms(query, result), [query, result]);

  useEffect(() => {
    dialogRef.current?.focus();

    const previousOverflow = globalThis.document.body.style.overflow;
    globalThis.document.body.style.overflow = "hidden";

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    globalThis.document.addEventListener("keydown", handleKeyDown);
    return () => {
      globalThis.document.removeEventListener("keydown", handleKeyDown);
      globalThis.document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  useEffect(() => {
    if (focusedParagraph) {
      window.requestAnimationFrame(() => {
        paragraphRefs.current[focusedParagraph.ordinal]?.scrollIntoView({
          block: "center",
          inline: "nearest",
        });
      });
    }
  }, [focusedParagraph]);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        aria-labelledby="document-preview-title"
        aria-modal="true"
        className="document-preview-modal"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="modal-header">
          <div>
            <h2 id="document-preview-title">{document.title}</h2>
            <div className="result-meta">
              <span>{document.sourceUri || document.id}</span>
              {focusedParagraph ? <span>paragraph {focusedParagraph.ordinal + 1}</span> : null}
              <span>score {result.score.toFixed(3)}</span>
            </div>
          </div>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="document-preview-frame">
          <div className="document-preview-page">
            {document.paragraphs.map((paragraph) => {
              const isFocused = paragraph.ordinal === focusedParagraph?.ordinal;
              return (
                <article
                  className={isFocused ? "preview-paragraph is-focused" : "preview-paragraph"}
                  key={paragraph.id}
                  ref={(element) => {
                    paragraphRefs.current[paragraph.ordinal] = element;
                  }}
                >
                  <div className="result-meta">
                    <span>#{paragraph.ordinal + 1}</span>
                    {paragraph.headingPath.length > 0 ? (
                      <span>{paragraph.headingPath.join(" / ")}</span>
                    ) : null}
                  </div>
                  <p>{highlightText(paragraph.text, highlightTerms)}</p>
                </article>
              );
            })}
          </div>
        </div>
      </section>
    </div>
  );
}

function resolveFocusedParagraph(
  document: ExtractedDocument,
  result: SearchResultView,
): ExtractedParagraph | undefined {
  const ordinalMatch = document.paragraphs.find(
    (paragraph) => paragraph.ordinal === result.paragraphOrdinal,
  );
  if (ordinalMatch) {
    return ordinalMatch;
  }

  const normalizedSnippet = normalizeSearchableText(result.snippet);
  if (!normalizedSnippet) {
    return document.paragraphs[0];
  }

  return (
    document.paragraphs.find((paragraph) =>
      normalizeSearchableText(paragraph.text).includes(normalizedSnippet),
    ) ?? findMostOverlappingParagraph(document.paragraphs, normalizedSnippet)
  );
}

function findMostOverlappingParagraph(
  paragraphs: ExtractedParagraph[],
  normalizedSnippet: string,
): ExtractedParagraph | undefined {
  const snippetTerms = new Set(normalizedSnippet.match(/[a-z0-9]+/g) ?? []);
  let bestParagraph: ExtractedParagraph | undefined;
  let bestScore = 0;

  for (const paragraph of paragraphs) {
    const paragraphTerms = new Set(
      normalizeSearchableText(paragraph.text).match(/[a-z0-9]+/g) ?? [],
    );
    const score = Array.from(snippetTerms).filter((term) => paragraphTerms.has(term)).length;
    if (score > bestScore) {
      bestParagraph = paragraph;
      bestScore = score;
    }
  }

  return bestParagraph ?? paragraphs[0];
}

function createHighlightTerms(query: string, result: SearchResultView): string[] {
  const parsed = parsePhraseQuery(query);
  const queryTerms = (parsed.searchText || query).replace(/"/g, " ").match(/[a-z0-9]+/gi) ?? [];
  const candidates = [
    ...result.exactPhraseMatches,
    ...result.fuzzyMatches.map((match) => match.matchedTerm),
    ...parsed.quotedPhrases,
    ...queryTerms,
  ];
  const unique = new Map<string, string>();

  for (const candidate of candidates) {
    const trimmed = candidate.replace(/\s+/g, " ").trim();
    if (trimmed.length < 2) {
      continue;
    }
    unique.set(trimmed.toLowerCase(), trimmed);
  }

  return Array.from(unique.values()).sort((left, right) => right.length - left.length);
}

function highlightText(text: string, terms: string[]): ReactNode {
  if (terms.length === 0) {
    return text;
  }

  const regex = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "gi");
  return text
    .split(regex)
    .map((segment, index) =>
      index % 2 === 1 ? <mark key={`${segment}-${index}`}>{segment}</mark> : segment,
    );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
