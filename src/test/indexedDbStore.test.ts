import { expect, test } from "bun:test";
import {
  shouldMarkDemoCorpusInitializedOnUpgrade,
  shouldSeedCorpus,
} from "../storage/indexedDbStore";

const SEED_DOCUMENTS = [{ id: "demo-a" }, { id: "demo-b" }, { id: "demo-c" }];

test("existing databases are marked initialized during the demo metadata upgrade", () => {
  expect(shouldMarkDemoCorpusInitializedOnUpgrade(0)).toBe(false);
  expect(shouldMarkDemoCorpusInitializedOnUpgrade(1)).toBe(true);
  expect(shouldMarkDemoCorpusInitializedOnUpgrade(2)).toBe(true);
});

test("seed eligibility allows fresh and interrupted seed-only corpora", () => {
  expect(shouldSeedCorpus([], SEED_DOCUMENTS)).toBe(true);
  expect(shouldSeedCorpus([{ id: "demo-a" }], SEED_DOCUMENTS)).toBe(true);
  expect(shouldSeedCorpus(SEED_DOCUMENTS, SEED_DOCUMENTS)).toBe(true);
  expect(shouldSeedCorpus([{ id: "user-document" }], SEED_DOCUMENTS)).toBe(false);
  expect(shouldSeedCorpus([{ id: "demo-a" }, { id: "user-document" }], SEED_DOCUMENTS)).toBe(false);
});
