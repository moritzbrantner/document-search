import { DEFAULT_DUPLICATE_RULE, isDuplicateRule } from "../domain/duplicateRules";
import type { DuplicateRule } from "../domain/types";

const DUPLICATE_RULE_STORAGE_KEY = "document-search:duplicate-rule";

export function loadDuplicateRule(): DuplicateRule {
  if (typeof localStorage === "undefined") {
    return DEFAULT_DUPLICATE_RULE;
  }

  try {
    return parseDuplicateRulePreference(localStorage.getItem(DUPLICATE_RULE_STORAGE_KEY));
  } catch {
    return DEFAULT_DUPLICATE_RULE;
  }
}

export function saveDuplicateRule(rule: DuplicateRule): void {
  if (typeof localStorage === "undefined") {
    return;
  }

  try {
    localStorage.setItem(DUPLICATE_RULE_STORAGE_KEY, rule);
  } catch {
    // Ignore storage failures; the in-memory setting still applies.
  }
}

export function parseDuplicateRulePreference(value: string | null): DuplicateRule {
  return isDuplicateRule(value) ? value : DEFAULT_DUPLICATE_RULE;
}
