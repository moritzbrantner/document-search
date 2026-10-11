import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

test("browser DOMParser exports dense skipped-level headings", async ({ page }, testInfo) => {
  await page.goto("./");
  await expect(page.getByRole("heading", { level: 1, name: "Document Search" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Delete / })).toHaveCount(5);

  const examples = [
    {
      name: "first-h2.html",
      html: "<h2>A</h2><p>x</p>",
      firstHeading: "A",
      paths: [["A"], ["A"]],
    },
    {
      name: "skipped-levels.html",
      html: "<h1>T</h1><h3>B</h3><p>y</p><h2>C</h2><p>z</p>",
      firstHeading: "T",
      paths: [["T"], ["T", "B"], ["T", "B"], ["T", "C"], ["T", "C"]],
    },
  ];

  await page.getByLabel("Upload documents").setInputFiles(
    examples.map(({ name, html }) => ({
      name,
      mimeType: "text/html",
      buffer: Buffer.from(html, "utf8"),
    })),
  );
  await expect(page.getByText("Imported 2 document(s).", { exact: true }).first()).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export JSON" }).click();
  const download = await downloadPromise;
  const snapshotPath = testInfo.outputPath("heading-path-snapshot.json");
  await download.saveAs(snapshotPath);
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as {
    documents: Array<{
      paragraphs: Array<{ text: string; headingPath: unknown }>;
    }>;
  };

  for (const { firstHeading, paths } of examples) {
    const document = snapshot.documents.find((entry) => entry.paragraphs[0]?.text === firstHeading);
    expect(document).toBeDefined();
    expect(document?.paragraphs.map((paragraph) => paragraph.headingPath)).toEqual(paths);
    for (const paragraph of document?.paragraphs ?? []) {
      expect(Array.isArray(paragraph.headingPath)).toBe(true);
      if (Array.isArray(paragraph.headingPath)) {
        expect(Object.keys(paragraph.headingPath)).toHaveLength(paragraph.headingPath.length);
        expect(paragraph.headingPath.every((heading) => typeof heading === "string")).toBe(true);
      }
    }
  }
});
