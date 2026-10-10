import { readFile } from "node:fs/promises";

import { expect, type Locator, type Page, test } from "@playwright/test";

// Every test gets a fresh browser context, so IndexedDB starts empty exactly like a first visit.

const DEMO_TITLES = [
  "Local-first search architecture",
  "Urban tree canopy and summer heat",
  "Sourdough fermentation notes",
  "Compiler optimization pass design",
  "Coastal wetland restoration field brief",
];

const IMPORTED_MARKDOWN = {
  name: "beekeeping-journal.md",
  title: "beekeeping-journal",
  body: [
    "# Beekeeping journal",
    "",
    "The apiary inspection found a queenless colony beside the lavender hedge.",
    "",
    "Varroa counts stayed low after the oxalic acid treatment in late autumn.",
    "",
  ].join("\n"),
};

function corpusDocuments(page: Page): Locator {
  // Each corpus row carries exactly one delete button named after its document title.
  return page.getByRole("button", { name: /^Delete / });
}

function searchRegion(page: Page): Locator {
  return page.getByRole("region", { name: "Search" });
}

function resultHeadings(page: Page): Locator {
  return searchRegion(page).getByRole("heading", { level: 3 });
}

function resultCard(page: Page, title: string): Locator {
  return searchRegion(page)
    .getByRole("button")
    .filter({ has: page.getByRole("heading", { level: 3, name: title }) });
}

async function openFreshApp(page: Page): Promise<void> {
  await page.goto("./");
  await expect(page.getByRole("heading", { level: 1, name: "Document Search" })).toBeVisible();
  await expect(corpusDocuments(page)).toHaveCount(DEMO_TITLES.length);
}

async function search(page: Page, query: string, mode: "Hybrid" | "Lexical" = "Lexical") {
  const region = searchRegion(page);
  await region.getByRole("combobox", { name: "Mode" }).selectOption({ label: mode });
  await region.getByRole("textbox", { name: /Search words/ }).fill(query);
  await region.getByRole("button", { name: "Search", exact: true }).click();
}

async function uploadMarkdown(page: Page): Promise<void> {
  await page.getByLabel("Upload documents").setInputFiles({
    name: IMPORTED_MARKDOWN.name,
    mimeType: "text/markdown",
    buffer: Buffer.from(IMPORTED_MARKDOWN.body, "utf8"),
  });
  await expect(page.getByText("Imported 1 document(s).", { exact: true }).first()).toBeVisible();
}

test("a fresh browser is seeded with the five deterministic demo documents", async ({ page }) => {
  await openFreshApp(page);

  for (const title of DEMO_TITLES) {
    await expect(page.getByRole("button", { name: `Delete ${title}` })).toBeVisible();
  }
  const summary = page.getByRole("region", { name: "Corpus summary and inspector" });
  await expect(summary.getByRole("definition").first()).toHaveText(String(DEMO_TITLES.length));
});

test("searching the demo corpus returns the matching paragraph", async ({ page }) => {
  await openFreshApp(page);

  await search(page, "nursery habitat");

  const wetland = resultCard(page, "Coastal wetland restoration field brief");
  await expect(wetland).toBeVisible();
  await expect(resultHeadings(page).first()).toHaveText("Coastal wetland restoration field brief");
  await expect(wetland).toContainText("demo://wetland-restoration.html");
  // The heading is paragraph 1, so the tidal-wetland paragraph is paragraph 2 (chunk :1).
  await expect(wetland).toContainText("paragraph 2");
  await expect(wetland).toContainText("demo-wetland-restoration:1");
  await expect(wetland).toContainText("nursery habitat");
  // Paragraph-level evidence: the snippet is the tidal-wetland paragraph, not the whole document.
  await expect(wetland).not.toContainText("Adaptive monitoring");

  await search(page, "sourdough starter inoculation");
  await expect(resultHeadings(page).first()).toHaveText("Sourdough fermentation notes");
});

test("an uploaded Markdown document joins the corpus and becomes searchable", async ({ page }) => {
  await openFreshApp(page);

  await search(page, "varroa");
  await expect(searchRegion(page).getByText("No results to show.")).toBeVisible();

  await uploadMarkdown(page);
  await expect(corpusDocuments(page)).toHaveCount(DEMO_TITLES.length + 1);
  await expect(
    page.getByRole("button", { name: `Delete ${IMPORTED_MARKDOWN.title}` }),
  ).toBeVisible();

  await search(page, "varroa oxalic");
  const imported = resultCard(page, IMPORTED_MARKDOWN.title);
  await expect(imported).toBeVisible();
  await expect(resultHeadings(page).first()).toHaveText(IMPORTED_MARKDOWN.title);
  await expect(imported).toContainText(IMPORTED_MARKDOWN.name);
  await expect(imported).toContainText("oxalic acid treatment");
});

test("plain-text and HTML uploads are imported together and searchable", async ({ page }) => {
  await openFreshApp(page);

  await page.getByLabel("Upload documents").setInputFiles([
    {
      name: "tide-tables.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(
        "Spring tides peak shortly after the new moon.\n\nNeap tides follow the quarter moons.\n",
        "utf8",
      ),
    },
    {
      name: "glacier-survey.html",
      mimeType: "text/html",
      buffer: Buffer.from(
        "<article><h1>Glacier survey</h1><p>Moraine boulders mark the former terminus of the glacier.</p></article>",
        "utf8",
      ),
    },
  ]);
  await expect(page.getByText("Imported 2 document(s).", { exact: true }).first()).toBeVisible();
  await expect(corpusDocuments(page)).toHaveCount(DEMO_TITLES.length + 2);

  await search(page, "neap tides");
  await expect(resultHeadings(page).first()).toHaveText("tide-tables");
  await search(page, "moraine boulders");
  await expect(resultHeadings(page).first()).toHaveText("glacier-survey");
});

test("an imported document survives a reload via IndexedDB", async ({ page }) => {
  await openFreshApp(page);
  await uploadMarkdown(page);
  await expect(corpusDocuments(page)).toHaveCount(DEMO_TITLES.length + 1);

  await page.reload();

  await expect(page.getByText(`Restored ${DEMO_TITLES.length + 1} document(s).`)).toBeVisible();
  await expect(corpusDocuments(page)).toHaveCount(DEMO_TITLES.length + 1);
  await expect(
    page.getByRole("button", { name: `Delete ${IMPORTED_MARKDOWN.title}` }),
  ).toBeVisible();

  await search(page, "queenless colony");
  await expect(resultHeadings(page).first()).toHaveText(IMPORTED_MARKDOWN.title);
});

test("export JSON, clear and import JSON restores the corpus", async ({ page }, testInfo) => {
  await openFreshApp(page);
  await uploadMarkdown(page);
  const expectedCount = DEMO_TITLES.length + 1;

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export JSON" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^document-search-corpus-\d{4}-\d{2}-\d{2}\.json$/);
  const snapshotPath = testInfo.outputPath("snapshot.json");
  await download.saveAs(snapshotPath);
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as {
    documents: Array<{ title: string }>;
  };
  expect(snapshot.documents.map((document) => document.title).sort()).toEqual(
    [...DEMO_TITLES, IMPORTED_MARKDOWN.title].sort(),
  );

  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(page.getByText("Corpus cleared.")).toBeVisible();
  await expect(corpusDocuments(page)).toHaveCount(0);

  // A cleared corpus stays cleared across reloads; the demo seed only runs on first visit.
  await page.reload();
  await expect(page.getByText("Corpus is empty.")).toBeVisible();
  await expect(corpusDocuments(page)).toHaveCount(0);

  await page.getByLabel("Import JSON").setInputFiles(snapshotPath);
  await expect(
    page.getByText(`Imported snapshot with ${expectedCount} document(s).`),
  ).toBeVisible();
  await expect(corpusDocuments(page)).toHaveCount(expectedCount);

  await page.reload();
  await expect(corpusDocuments(page)).toHaveCount(expectedCount);
  await search(page, "varroa oxalic");
  await expect(resultHeadings(page).first()).toHaveText(IMPORTED_MARKDOWN.title);
  await search(page, "nursery habitat");
  await expect(resultHeadings(page).first()).toHaveText("Coastal wetland restoration field brief");
});
