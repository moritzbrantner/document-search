import { fileURLToPath, URL } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss(), htmlImportProxyPlugin()],
  optimizeDeps: {
    exclude: ["@moritzbrantner/text-core-wasm", "@moritzbrantner/text-index-wasm"],
  },
  server: {
    fs: {
      allow: [
        fileURLToPath(new URL(".", import.meta.url)),
        fileURLToPath(new URL("../nlp-stack/packages", import.meta.url)),
      ],
    },
  },
});

const HTML_IMPORT_TIMEOUT_MS = 15_000;
const MAX_HTML_IMPORT_BYTES = 10 * 1024 * 1024;

function htmlImportProxyPlugin(): Plugin {
  return {
    name: "document-search-html-import-proxy",
    configureServer(server) {
      server.middlewares.use("/api/import-html", (request, response) => {
        void handleHtmlImportRequest(request, response);
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use("/api/import-html", (request, response) => {
        void handleHtmlImportRequest(request, response);
      });
    },
  };
}

async function handleHtmlImportRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method !== "GET") {
    sendJson(response, 405, { error: "Only GET requests are supported." });
    return;
  }

  const importUrl = readImportUrl(request);
  if (!importUrl) {
    sendJson(response, 400, { error: "Provide an http or https URL." });
    return;
  }

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), HTML_IMPORT_TIMEOUT_MS);

  try {
    const upstream = await fetch(importUrl, {
      headers: {
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
        "User-Agent": "document-search-local-importer/1.0",
      },
      signal: abortController.signal,
    });

    if (!upstream.ok) {
      sendJson(response, 502, {
        error: `The site returned ${upstream.status} ${upstream.statusText}.`,
      });
      return;
    }

    const contentLength = Number(upstream.headers.get("content-length") ?? 0);
    if (contentLength > MAX_HTML_IMPORT_BYTES) {
      sendJson(response, 413, { error: "The HTML response is too large to import." });
      return;
    }

    const html = await upstream.text();
    if (new TextEncoder().encode(html).byteLength > MAX_HTML_IMPORT_BYTES) {
      sendJson(response, 413, { error: "The HTML response is too large to import." });
      return;
    }

    sendJson(response, 200, { html, url: upstream.url || importUrl });
  } catch (error: unknown) {
    const message =
      error instanceof Error && error.name === "AbortError"
        ? "Timed out while fetching the URL."
        : errorMessage(error);
    sendJson(response, 502, { error: message });
  } finally {
    clearTimeout(timeout);
  }
}

function readImportUrl(request: IncomingMessage): string | undefined {
  const requestUrl = new URL(request.url ?? "", "http://localhost/api/import-html");
  const value = requestUrl.searchParams.get("url")?.trim();
  if (!value) {
    return undefined;
  }

  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
