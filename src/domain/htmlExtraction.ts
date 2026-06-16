import { computeTextStats } from "./textSegmentation";
import type { ExtractedDocument, ExtractedParagraph, HtmlDocumentInput } from "./types";

const BLOCK_TAGS = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "li",
  "blockquote",
  "figcaption",
  "td",
  "th",
  "pre",
]);

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const REMOVED_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
]);

export function extractHtmlDocument(input: HtmlDocumentInput): ExtractedDocument {
  const id = input.id ?? createDocumentId(input);
  const parsed = parseHtml(input.html);
  const title =
    normalizeWhitespace(input.title ?? "") ||
    parsed.title ||
    parsed.firstH1 ||
    input.sourceUri ||
    id;

  const paragraphs = parsed.blocks.map<ExtractedParagraph>((block, ordinal) => ({
    id: `${id}:p${ordinal}`,
    documentId: id,
    ordinal,
    text: block.text,
    sourceSelector: block.selector,
    headingPath: block.headingPath,
  }));
  const text = paragraphs.map((paragraph) => paragraph.text).join("\n\n");

  return {
    id,
    title,
    sourceUri: input.sourceUri,
    html: input.html,
    text,
    paragraphs,
    importedAt: input.importedAt,
    stats: computeTextStats(text),
  };
}

interface ParsedBlock {
  text: string;
  selector?: string;
  headingPath: string[];
}

interface ParsedHtml {
  title: string;
  firstH1: string;
  blocks: ParsedBlock[];
}

function parseHtml(html: string): ParsedHtml {
  if (typeof DOMParser !== "undefined") {
    return parseWithDomParser(html);
  }
  return parseWithFallbackTree(html);
}

function parseWithDomParser(html: string): ParsedHtml {
  const document = new DOMParser().parseFromString(html, "text/html");
  for (const selector of REMOVED_TAGS) {
    document.querySelectorAll(selector).forEach((node) => node.remove());
  }

  const title = normalizeWhitespace(document.querySelector("title")?.textContent ?? "");
  const firstH1 = normalizeWhitespace(document.querySelector("h1")?.textContent ?? "");
  const blocks: ParsedBlock[] = [];
  const headingPath: string[] = [];
  const root = document.body ?? document.documentElement;

  for (const element of Array.from(root.querySelectorAll(Array.from(BLOCK_TAGS).join(",")))) {
    const tagName = element.tagName.toLowerCase();
    if (!isLeafBlockElement(element)) {
      continue;
    }

    const text = normalizeWhitespace(element.textContent ?? "");
    if (!text) {
      continue;
    }

    if (HEADING_TAGS.has(tagName)) {
      updateHeadingPath(headingPath, tagName, text);
    }

    blocks.push({
      text,
      selector: createSelector(element),
      headingPath: HEADING_TAGS.has(tagName) ? [...headingPath] : [...headingPath],
    });
  }

  return { title, firstH1, blocks };
}

function isLeafBlockElement(element: Element): boolean {
  return !Array.from(element.children).some((child) => {
    const tagName = child.tagName.toLowerCase();
    return BLOCK_TAGS.has(tagName) || child.querySelector(Array.from(BLOCK_TAGS).join(","));
  });
}

function createSelector(element: Element): string {
  const parts: string[] = [];
  let current: Element | null = element;

  while (current && current.tagName.toLowerCase() !== "body" && parts.length < 4) {
    const tagName = current.tagName.toLowerCase();
    const siblings = current.parentElement
      ? Array.from(current.parentElement.children).filter(
          (child) => child.tagName === current?.tagName,
        )
      : [];
    const suffix = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : "";
    parts.unshift(`${tagName}${suffix}`);
    current = current.parentElement;
  }

  return parts.join(" > ");
}

interface TreeNode {
  tagName: string;
  children: TreeNode[];
  text: string;
}

function parseWithFallbackTree(html: string): ParsedHtml {
  const root: TreeNode = { tagName: "root", children: [], text: "" };
  const stack: TreeNode[] = [root];
  const tokens = html.match(/<!--[\s\S]*?-->|<!doctype[\s\S]*?>|<\/?[a-zA-Z][^>]*>|[^<]+/gi) ?? [];
  let ignoredDepth = 0;

  for (const token of tokens) {
    if (token.startsWith("<!--") || /^<!doctype/i.test(token)) {
      continue;
    }

    if (token.startsWith("</")) {
      const tagName = tagNameFromToken(token);
      if (REMOVED_TAGS.has(tagName) && ignoredDepth > 0) {
        ignoredDepth -= 1;
      }
      if (ignoredDepth === 0) {
        closeTag(stack, tagName);
      }
      continue;
    }

    if (token.startsWith("<")) {
      const tagName = tagNameFromToken(token);
      if (!tagName) {
        continue;
      }
      if (REMOVED_TAGS.has(tagName)) {
        ignoredDepth += 1;
        continue;
      }
      if (ignoredDepth > 0 || token.endsWith("/>")) {
        continue;
      }
      const node: TreeNode = { tagName, children: [], text: "" };
      stack.at(-1)?.children.push(node);
      stack.push(node);
      continue;
    }

    if (ignoredDepth === 0) {
      const text = decodeHtmlEntities(token);
      if (text) {
        const current = stack.at(-1);
        if (current) {
          current.text += text;
        }
      }
    }
  }

  const title = normalizeWhitespace(findFirstText(root, "title"));
  const firstH1 = normalizeWhitespace(findFirstText(root, "h1"));
  const blocks: ParsedBlock[] = [];
  const headingPath: string[] = [];

  walkFallbackBlocks(root, headingPath, blocks);
  return { title, firstH1, blocks };
}

function closeTag(stack: TreeNode[], tagName: string): void {
  for (let index = stack.length - 1; index > 0; index -= 1) {
    if (stack[index]?.tagName === tagName) {
      stack.splice(index);
      return;
    }
  }
}

function walkFallbackBlocks(node: TreeNode, headingPath: string[], blocks: ParsedBlock[]): void {
  if (BLOCK_TAGS.has(node.tagName) && !hasDescendantBlock(node)) {
    const text = normalizeWhitespace(collectText(node));
    if (text) {
      if (HEADING_TAGS.has(node.tagName)) {
        updateHeadingPath(headingPath, node.tagName, text);
      }
      blocks.push({
        text,
        selector: node.tagName,
        headingPath: [...headingPath],
      });
    }
    return;
  }

  for (const child of node.children) {
    walkFallbackBlocks(child, headingPath, blocks);
  }
}

function hasDescendantBlock(node: TreeNode): boolean {
  return node.children.some((child) => BLOCK_TAGS.has(child.tagName) || hasDescendantBlock(child));
}

function collectText(node: TreeNode): string {
  return `${node.text} ${node.children.map(collectText).join(" ")}`;
}

function findFirstText(node: TreeNode, tagName: string): string {
  if (node.tagName === tagName) {
    return collectText(node);
  }
  for (const child of node.children) {
    const value = findFirstText(child, tagName);
    if (value) {
      return value;
    }
  }
  return "";
}

function tagNameFromToken(token: string): string {
  return (
    token
      .replace(/^<\/?\s*/, "")
      .match(/^[^\s>/]+/)?.[0]
      ?.toLowerCase() ?? ""
  );
}

function updateHeadingPath(headingPath: string[], tagName: string, text: string): void {
  const level = Number(tagName.slice(1));
  headingPath.splice(level - 1);
  headingPath[level - 1] = text;
}

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

function createDocumentId(input: HtmlDocumentInput): string {
  const source = `${input.sourceUri ?? ""}:${input.importedAt}:${input.html.length}`;
  let hash = 0;
  for (let index = 0; index < source.length; index += 1) {
    hash = (hash * 31 + source.charCodeAt(index)) >>> 0;
  }
  return `doc-${hash.toString(36)}`;
}
