import { normalizeSearchableText } from "./textSegmentation";
import type { DuplicateRule, ExtractedDocument } from "./types";

export const DEFAULT_DUPLICATE_RULE: DuplicateRule = "same-page";

const DUPLICATE_RULES = new Set<DuplicateRule>([
  "same-page",
  "same-content",
  "same-page-or-content",
]);

const TRACKING_PARAMS = new Set(["fbclid", "gclid", "dclid", "msclkid", "mc_cid", "mc_eid"]);

export function isDuplicateRule(value: unknown): value is DuplicateRule {
  return typeof value === "string" && DUPLICATE_RULES.has(value as DuplicateRule);
}

export function duplicateRuleUsesSource(rule: DuplicateRule): boolean {
  return rule === "same-page" || rule === "same-page-or-content";
}

export function isDuplicateDocument(
  candidate: ExtractedDocument,
  existingDocuments: ExtractedDocument[],
  duplicateRule: DuplicateRule,
): boolean {
  const existingKeys = createDocumentKeySet(existingDocuments, duplicateRule);
  return getDocumentDuplicateKeys(candidate, duplicateRule).some((key) => existingKeys.has(key));
}

export function dedupeDocumentsByRule(
  documents: ExtractedDocument[],
  duplicateRule: DuplicateRule,
): ExtractedDocument[] {
  const keys = new Set<string>();
  const uniqueDocuments: ExtractedDocument[] = [];

  for (const document of documents) {
    const duplicateKeys = getDocumentDuplicateKeys(document, duplicateRule);
    if (duplicateKeys.some((key) => keys.has(key))) {
      continue;
    }
    for (const key of duplicateKeys) {
      keys.add(key);
    }
    uniqueDocuments.push(document);
  }

  return uniqueDocuments;
}

export function isDuplicateSourceUri(
  sourceUri: string,
  existingDocuments: ExtractedDocument[],
  duplicateRule: DuplicateRule,
): boolean {
  if (!duplicateRuleUsesSource(duplicateRule)) {
    return false;
  }
  const sourceKey = normalizeSourceKey(sourceUri);
  return Boolean(
    sourceKey &&
    existingDocuments.some((document) => normalizeSourceKey(document.sourceUri) === sourceKey),
  );
}

export function normalizeSourceKey(sourceUri?: string): string | undefined {
  const trimmed = sourceUri?.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    if (!/^https?:\/\//i.test(trimmed)) {
      throw new Error("Not an absolute URL.");
    }
    const url = new URL(trimmed);
    if (url.protocol === "http:" || url.protocol === "https:") {
      url.hash = "";
      url.username = "";
      url.password = "";
      url.hostname = url.hostname.toLowerCase();
      if (
        (url.protocol === "http:" && url.port === "80") ||
        (url.protocol === "https:" && url.port === "443")
      ) {
        url.port = "";
      }
      removeTrackingParams(url);
      url.searchParams.sort();
      return `source:${url.toString()}`;
    }
  } catch {
    // Fall through to file-name and custom URI comparison.
  }

  return `source:${trimmed.replace(/\s+/g, " ").toLowerCase()}`;
}

export function normalizeContentKey(text: string): string | undefined {
  const normalized = normalizeSearchableText(text);
  return normalized ? `content:${hashString(normalized)}` : undefined;
}

function createDocumentKeySet(
  documents: ExtractedDocument[],
  duplicateRule: DuplicateRule,
): Set<string> {
  const keys = new Set<string>();
  for (const document of documents) {
    for (const key of getDocumentDuplicateKeys(document, duplicateRule)) {
      keys.add(key);
    }
  }
  return keys;
}

function getDocumentDuplicateKeys(
  document: ExtractedDocument,
  duplicateRule: DuplicateRule,
): string[] {
  const keys: Array<string | undefined> = [];

  if (duplicateRule === "same-page" || duplicateRule === "same-page-or-content") {
    keys.push(normalizeSourceKey(document.sourceUri));
  }
  if (duplicateRule === "same-content" || duplicateRule === "same-page-or-content") {
    keys.push(normalizeContentKey(document.text));
  }

  return keys.filter((key): key is string => Boolean(key));
}

function removeTrackingParams(url: URL): void {
  for (const key of Array.from(url.searchParams.keys())) {
    const normalized = key.toLowerCase();
    if (normalized.startsWith("utm_") || TRACKING_PARAMS.has(normalized)) {
      url.searchParams.delete(key);
    }
  }
}

function hashString(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}
