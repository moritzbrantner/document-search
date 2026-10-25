// Explicit HTTP(S) capture of web pages for the filesystem corpus (Bun/Node only).
//
// Capturing is a separate, explicit command: ordinary corpus search never fetches anything.
// Each requested URL is fetched with `GET`, following redirects manually so every hop of the
// redirect chain is recorded. Response bodies are kept exactly as received (no automatic
// content decoding), so the stored payload hash identifies the exact entity bytes.
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

import { headerValue, type HeaderList } from "./warc";

export const WEB_CAPTURE_PRODUCER = "document-search/web-capture";
export const WEB_CAPTURE_VERSION = "1.0.0";
export const WEB_CAPTURE_USER_AGENT = `${WEB_CAPTURE_PRODUCER}/${WEB_CAPTURE_VERSION} (+https://github.com/moritzbrantner/document-search)`;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface HttpCaptureOptions {
  /** Maximum redirect hops before the capture fails; default 10. */
  maxRedirects?: number;
  /** Maximum entity-body size per response; default 64 MiB. */
  maxBodyBytes?: number;
  /** Per-request timeout; default 30 s. */
  timeoutMs?: number;
  /** Clock for retrieval timestamps (ISO 8601); default `new Date().toISOString()`. */
  now?: () => string;
}

export interface HttpExchange {
  request: {
    method: "GET";
    url: string;
    /** Request-target and header fields exactly as sent. */
    target: string;
    headers: [string, string][];
  };
  response: {
    httpVersion: string;
    status: number;
    reason: string;
    /** Header fields in received order and case. */
    headers: [string, string][];
    /** Entity body exactly as received (transfer coding removed, content coding kept). */
    body: Uint8Array;
    /** Peer IP address, when known. */
    ipAddress: string | null;
  };
  /** ISO timestamp of the moment the request was sent. */
  retrievedAt: string;
}

export interface HttpCaptureResult {
  requestedUrl: string;
  finalUrl: string;
  /** Every request/response of the redirect chain; the last one is the final response. */
  exchanges: HttpExchange[];
}

/** Fetches `url` (http/https only), recording each redirect hop. */
export async function captureHttp(
  url: string,
  options: HttpCaptureOptions = {},
): Promise<HttpCaptureResult> {
  const maxRedirects = options.maxRedirects ?? 10;
  const now = options.now ?? (() => new Date().toISOString());
  const requestedUrl = parseHttpUrl(url).href;
  const exchanges: HttpExchange[] = [];
  let current = requestedUrl;
  for (;;) {
    const exchange = await fetchOnce(current, {
      maxBodyBytes: options.maxBodyBytes ?? 64 * 1024 * 1024,
      timeoutMs: options.timeoutMs ?? 30_000,
      retrievedAt: now(),
    });
    exchanges.push(exchange);
    const location = headerValue(exchange.response.headers, "location");
    if (!REDIRECT_STATUSES.has(exchange.response.status) || location === undefined) {
      return { requestedUrl, finalUrl: current, exchanges };
    }
    if (exchanges.length > maxRedirects) {
      throw new Error(`Too many redirects (more than ${maxRedirects}) from ${requestedUrl}.`);
    }
    current = parseHttpUrl(new URL(location, current).href).href;
  }
}

export function parseHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Not an absolute URL: "${value}".`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Only http and https URLs can be captured, got "${value}".`);
  }
  url.hash = "";
  return url;
}

export interface ParsedContentType {
  /** Lowercase `type/subtype`, or null without a Content-Type header. */
  mediaType: string | null;
  /** Lowercase charset parameter, or null. */
  charset: string | null;
}

export function parseContentType(value: string | undefined): ParsedContentType {
  if (value === undefined) return { mediaType: null, charset: null };
  const [type = "", ...parameters] = value.split(";");
  const charset = parameters
    .map((parameter) => parameter.trim().match(/^charset\s*=\s*"?([^";]+)"?$/i)?.[1])
    .find((match) => match !== undefined);
  return {
    mediaType: type.trim().toLowerCase() || null,
    charset: charset ? charset.trim().toLowerCase() : null,
  };
}

/** Removes the response's content coding (gzip, deflate, br) for text extraction. */
export function decodeContentCoding(body: Uint8Array, headers: HeaderList): Uint8Array {
  const codings = (headerValue(headers, "content-encoding") ?? "")
    .split(",")
    .map((coding) => coding.trim().toLowerCase())
    .filter((coding) => coding !== "" && coding !== "identity")
    .reverse();
  let decoded = body;
  for (const coding of codings) {
    if (coding === "gzip" || coding === "x-gzip") decoded = new Uint8Array(gunzipSync(decoded));
    else if (coding === "deflate") decoded = new Uint8Array(inflateSync(decoded));
    else if (coding === "br") decoded = new Uint8Array(brotliDecompressSync(decoded));
    else throw new Error(`Unsupported Content-Encoding "${coding}".`);
  }
  return decoded;
}

function fetchOnce(
  url: string,
  options: { maxBodyBytes: number; timeoutMs: number; retrievedAt: string },
): Promise<HttpExchange> {
  const target = new URL(url);
  const path = `${target.pathname}${target.search}`;
  const headers: [string, string][] = [
    ["Host", target.host],
    ["User-Agent", WEB_CAPTURE_USER_AGENT],
    ["Accept", "text/html,application/xhtml+xml,text/plain,text/markdown;q=0.9,*/*;q=0.8"],
    ["Accept-Encoding", "identity"],
    ["Connection", "close"],
  ];
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise<HttpExchange>((resolve, reject) => {
    const request = send(
      {
        protocol: target.protocol,
        hostname: target.hostname.replace(/^\[|\]$/g, ""),
        port: target.port || undefined,
        method: "GET",
        path,
        headers: Object.fromEntries(headers),
        timeout: options.timeoutMs,
      },
      (response: IncomingMessage) => {
        const chunks: Uint8Array[] = [];
        let received = 0;
        response.on("data", (chunk: Uint8Array) => {
          received += chunk.byteLength;
          if (received > options.maxBodyBytes) {
            request.destroy(
              new Error(`Response from ${url} exceeds ${options.maxBodyBytes} bytes.`),
            );
            return;
          }
          chunks.push(new Uint8Array(chunk));
        });
        response.on("error", reject);
        response.on("end", () => {
          const body = new Uint8Array(received);
          let offset = 0;
          for (const chunk of chunks) {
            body.set(chunk, offset);
            offset += chunk.byteLength;
          }
          resolve({
            request: { method: "GET", url, target: path, headers },
            response: {
              httpVersion: response.httpVersion,
              status: response.statusCode ?? 0,
              reason: response.statusMessage ?? "",
              headers: pairs(response.rawHeaders),
              body,
              ipAddress: response.socket?.remoteAddress ?? null,
            },
            retrievedAt: options.retrievedAt,
          });
        });
      },
    );
    request.on("timeout", () =>
      request.destroy(new Error(`Request to ${url} timed out after ${options.timeoutMs} ms.`)),
    );
    request.on("error", reject);
    request.end();
  });
}

function pairs(raw: readonly string[]): [string, string][] {
  const result: [string, string][] = [];
  for (let index = 0; index + 1 < raw.length; index += 2) {
    result.push([raw[index]!, raw[index + 1]!]);
  }
  return result;
}
