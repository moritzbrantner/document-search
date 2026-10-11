// Regression tests for the PR #35 review of the filesystem corpus mode (#21):
// overlapping scan roots, alias-move accounting and the index digest.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { openFilesystemCorpus, type FilesystemCorpus } from "../filesystem/corpusStore";

const T1 = "2026-10-11T08:00:00.000Z";
const T2 = "2026-10-12T08:00:00.000Z";
const T3 = "2026-10-13T08:00:00.000Z";

const tempDirs: string[] = [];
const corpora: FilesystemCorpus[] = [];

afterEach(() => {
  for (const corpus of corpora.splice(0)) corpus.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `document-search-fs-review-${label}-`));
  tempDirs.push(dir);
  return dir;
}

async function open(): Promise<FilesystemCorpus> {
  const corpus = await openFilesystemCorpus(tempDir("corpus"));
  corpora.push(corpus);
  return corpus;
}

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** `<outer>/inner/note.md` plus `<outer>/top.md`; `inner` is a scan root nested in `outer`. */
function overlappingRoots(): { outer: string; inner: string; note: string; top: string } {
  const outer = tempDir("outer");
  const inner = join(outer, "inner");
  const note = join(inner, "note.md");
  const top = join(outer, "top.md");
  writeFile(note, "# Note\n\nA note about puffins.\n");
  writeFile(top, "# Top\n\nA note about gannets.\n");
  return { outer, inner, note, top };
}

describe("overlapping scan roots", () => {
  for (const [label, firstRoot, rescanRoot] of [
    ["outer then inner, rescan outer", "outer", "outer"],
    ["outer then inner, rescan inner", "outer", "inner"],
    ["inner then outer, rescan outer", "inner", "outer"],
    ["inner then outer, rescan inner", "inner", "inner"],
  ] as const) {
    test(`a deleted file is removed whichever root is rescanned (${label})`, async () => {
      const roots = overlappingRoots();
      const corpus = await open();
      const secondRoot = firstRoot === "outer" ? "inner" : "outer";
      await corpus.ingestFolder(roots[firstRoot], { importedAt: T1 });
      await corpus.ingestFolder(roots[secondRoot], { importedAt: T1 });

      rmSync(roots.note);
      const report = await corpus.ingestFolder(roots[rescanRoot], { importedAt: T2 });

      expect(report.removed).toBe(1);
      expect(await corpus.resolveSource(roots.note)).toBeUndefined();
      expect((await corpus.listDocuments()).map((document) => document.title)).not.toContain(
        "note",
      );
      expect(await corpus.resolveSource(roots.top)).toBeDefined();
    });
  }

  test("rescanning a root that still contains the file keeps it", async () => {
    const roots = overlappingRoots();
    const corpus = await open();
    await corpus.ingestFolder(roots.outer, { importedAt: T1 });
    await corpus.ingestFolder(roots.inner, { importedAt: T1 });

    rmSync(roots.top);
    const report = await corpus.ingestFolder(roots.outer, { importedAt: T2 });
    expect(report).toMatchObject({ files: 1, removed: 1, unchanged: 1 });
    expect(await corpus.resolveSource(roots.note)).toBeDefined();
    expect(await corpus.resolveSource(roots.top)).toBeUndefined();
  });

  test("a source reports its most specific root regardless of scan order", async () => {
    const roots = overlappingRoots();
    const outerFirst = await open();
    await outerFirst.ingestFolder(roots.outer, { importedAt: T1 });
    await outerFirst.ingestFolder(roots.inner, { importedAt: T1 });
    const innerFirst = await open();
    await innerFirst.ingestFolder(roots.inner, { importedAt: T1 });
    await innerFirst.ingestFolder(roots.outer, { importedAt: T1 });
    // Rescanning the outer root does not take the association back.
    await outerFirst.ingestFolder(roots.outer, { importedAt: T2 });

    const note = await outerFirst.resolveSource(roots.note);
    expect(note).toMatchObject({ root: resolve(roots.inner), relativePath: "note.md" });
    expect(await innerFirst.listSources()).toEqual(await outerFirst.listSources());
  });

  test("a file reached through another root counts as unchanged, not updated", async () => {
    const roots = overlappingRoots();
    const corpus = await open();
    await corpus.ingestFolder(roots.outer, { importedAt: T1 });

    const report = await corpus.ingestFolder(roots.inner, { importedAt: T2 });
    expect(report).toEqual({
      root: resolve(roots.inner),
      files: 1,
      added: 0,
      updated: 0,
      unchanged: 1,
      removed: 0,
      unsupported: 0,
    });
    const [document] = (await corpus.listDocuments()).filter((entry) => entry.title === "note");
    expect(document?.importedAt).toBe(T1);
  });
});

describe("index digest", () => {
  test("content A -> B -> A leaves an index built for the first A stale", async () => {
    const root = tempDir("root");
    const path = join(root, "note.md");
    const corpus = await open();
    writeFile(path, "# Note\n\nVersion A.\n");
    await corpus.ingestFolder(root, { importedAt: T1 });
    await corpus.rebuildSearchIndex();
    expect((await corpus.indexStatus()).state).toBe("current");

    writeFile(path, "# Note\n\nVersion B.\n");
    await corpus.ingestFolder(root, { importedAt: T2 });
    writeFile(path, "# Note\n\nVersion A.\n");
    await corpus.ingestFolder(root, { importedAt: T3 });

    // The stored record now carries T3, so the index built from the T1 record is stale.
    expect((await corpus.listDocuments())[0]?.importedAt).toBe(T3);
    expect((await corpus.indexStatus()).state).toBe("stale");
    await corpus.rebuildSearchIndex();
    expect((await corpus.indexStatus()).state).toBe("current");
  });
});
