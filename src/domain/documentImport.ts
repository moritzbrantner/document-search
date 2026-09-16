import type { HtmlDocumentInput } from "./types";

export const SUPPORTED_DOCUMENT_ACCEPT =
  ".html,.htm,.md,.markdown,.txt,text/html,text/markdown,text/plain";

export type UploadedDocumentFormat = "html" | "markdown" | "text";

export interface UploadedDocumentSource {
  name: string;
  mimeType?: string;
  content: string;
  importedAt: string;
}

export function isSupportedDocument(name: string, mimeType = ""): boolean {
  return inferDocumentFormat(name, mimeType) !== undefined;
}

export function parseUploadedDocument(source: UploadedDocumentSource): HtmlDocumentInput {
  const format = inferDocumentFormat(source.name, source.mimeType);
  if (!format) {
    throw new Error(`Unsupported document type: ${source.name}`);
  }

  return {
    title: titleFromFileName(source.name),
    sourceUri: source.name,
    html: normalizeDocumentToHtml(source.content, format),
    importedAt: source.importedAt,
  };
}

function inferDocumentFormat(name: string, mimeType: string): UploadedDocumentFormat | undefined {
  const lowerName = name.toLowerCase();
  const normalizedMimeType = mimeType.toLowerCase().split(";", 1)[0]?.trim() ?? "";

  if (normalizedMimeType === "text/html" || /\.html?$/.test(lowerName)) {
    return "html";
  }
  if (
    normalizedMimeType === "text/markdown" ||
    normalizedMimeType === "text/x-markdown" ||
    /\.(md|markdown)$/.test(lowerName)
  ) {
    return "markdown";
  }
  if (normalizedMimeType === "text/plain" || /\.txt$/.test(lowerName)) {
    return "text";
  }
  return undefined;
}

function titleFromFileName(name: string): string {
  return name.replace(/\.(html?|md|markdown|txt)$/i, "").trim() || name;
}

function normalizeDocumentToHtml(content: string, format: UploadedDocumentFormat): string {
  if (format === "html") {
    return content;
  }
  if (format === "markdown") {
    return markdownToHtml(content);
  }
  return plainTextToHtml(content);
}

function plainTextToHtml(text: string): string {
  return splitParagraphs(text)
    .map((paragraph) => `<p>${escapeHtml(paragraph.replace(/\s*\n\s*/g, " "))}</p>`)
    .join("\n");
}

function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const html: string[] = [];
  let paragraphLines: string[] = [];
  let unorderedItems: string[] = [];
  let orderedItems: string[] = [];
  let codeLines: string[] = [];
  let inCodeBlock = false;

  const flushParagraph = () => {
    if (paragraphLines.length === 0) {
      return;
    }
    html.push(`<p>${escapeHtml(stripInlineMarkdown(paragraphLines.join(" ")))}</p>`);
    paragraphLines = [];
  };
  const flushUnorderedList = () => {
    if (unorderedItems.length === 0) {
      return;
    }
    html.push(`<ul>${unorderedItems.map((item) => `<li>${item}</li>`).join("")}</ul>`);
    unorderedItems = [];
  };
  const flushOrderedList = () => {
    if (orderedItems.length === 0) {
      return;
    }
    html.push(`<ol>${orderedItems.map((item) => `<li>${item}</li>`).join("")}</ol>`);
    orderedItems = [];
  };
  const flushTextBlocks = () => {
    flushParagraph();
    flushUnorderedList();
    flushOrderedList();
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (inCodeBlock) {
        html.push(`<pre>${escapeHtml(codeLines.join("\n"))}</pre>`);
        codeLines = [];
        inCodeBlock = false;
      } else {
        flushTextBlocks();
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushTextBlocks();
      const level = heading[1]?.length ?? 1;
      html.push(`<h${level}>${escapeHtml(stripInlineMarkdown(heading[2] ?? ""))}</h${level}>`);
      continue;
    }

    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    if (unordered) {
      flushParagraph();
      flushOrderedList();
      unorderedItems.push(escapeHtml(stripInlineMarkdown(unordered[1] ?? "")));
      continue;
    }

    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ordered) {
      flushParagraph();
      flushUnorderedList();
      orderedItems.push(escapeHtml(stripInlineMarkdown(ordered[1] ?? "")));
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flushTextBlocks();
      html.push(`<blockquote>${escapeHtml(stripInlineMarkdown(quote[1] ?? ""))}</blockquote>`);
      continue;
    }

    if (!line.trim()) {
      flushTextBlocks();
      continue;
    }

    flushUnorderedList();
    flushOrderedList();
    paragraphLines.push(line.trim());
  }

  if (inCodeBlock) {
    html.push(`<pre>${escapeHtml(codeLines.join("\n"))}</pre>`);
  }
  flushTextBlocks();
  return html.join("\n");
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\*\*(\S(?:[^*\n]*?\S)?)\*\*/g, "$1")
    .replace(/(^|[^A-Za-z0-9])__(\S(?:[^_\n]*?\S)?)__(?=$|[^A-Za-z0-9])/g, "$1$2")
    .replace(/~~(\S(?:[^~\n]*?\S)?)~~/g, "$1")
    .replace(/\*(\S(?:[^*\n]*?\S)?)\*/g, "$1")
    .replace(/(^|[^A-Za-z0-9])_(\S(?:[^_\n]*?\S)?)_(?=$|[^A-Za-z0-9])/g, "$1$2")
    .trim();
}

function splitParagraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
