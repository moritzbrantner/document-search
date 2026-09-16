import { expect, test } from "bun:test";
import { shouldMarkDemoCorpusInitializedOnUpgrade } from "../storage/indexedDbStore";

test("existing databases are marked initialized during the demo metadata upgrade", () => {
  expect(shouldMarkDemoCorpusInitializedOnUpgrade(0)).toBe(false);
  expect(shouldMarkDemoCorpusInitializedOnUpgrade(1)).toBe(true);
  expect(shouldMarkDemoCorpusInitializedOnUpgrade(2)).toBe(true);
});
