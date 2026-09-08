import { normalizeSearchableText } from "./textSegmentation";

export interface ParsedPhraseQuery {
  searchText: string;
  quotedPhrases: string[];
}

export function parsePhraseQuery(query: string): ParsedPhraseQuery {
  const phrases: string[] = [];
  let searchText = "";
  let cursor = 0;

  while (cursor < query.length) {
    const open = query.indexOf('"', cursor);
    if (open === -1) {
      searchText += query.slice(cursor);
      break;
    }

    const close = query.indexOf('"', open + 1);
    if (close === -1) {
      searchText += query.slice(cursor);
      break;
    }

    searchText += `${query.slice(cursor, open)} `;
    const phrase = query.slice(open + 1, close).trim();
    if (phrase) {
      phrases.push(normalizePhrase(phrase));
      searchText += `${phrase} `;
    }
    cursor = close + 1;
  }

  return {
    searchText: searchText.replace(/\s+/g, " ").trim(),
    quotedPhrases: phrases,
  };
}

export function normalizePhrase(value: string): string {
  return normalizeSearchableText(value);
}

export function findExactPhraseMatches(text: string, phrases: string[]): string[] {
  const normalizedText = normalizeSearchableText(text);
  return phrases.filter((phrase) => normalizedText.includes(normalizePhrase(phrase)));
}
