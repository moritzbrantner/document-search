// Minimal WARC 1.1 writer and reader for explicit web captures (Bun/Node only).
//
// One capture is written as one uncompressed WARC file: a `warcinfo` record naming the capture
// producer, then a `request`/`response` pair per HTTP exchange of the redirect chain. A final
// response whose payload an earlier capture already archived is written as a `revisit` record
// (identical-payload-digest profile) without the payload bytes.
//
// Digests are labelled `sha256:<lowercase hex>`, matching the corpus payload hashes.
import { createHash } from "node:crypto";

export const WARC_VERSION = "WARC/1.1";
export const REVISIT_PROFILE = "http://netpreserve.org/warc/1.1/revisit/identical-payload-digest";
const CRLF = "\r\n";
const textEncoder = new TextEncoder();

export type HeaderList = readonly (readonly [string, string])[];

export interface WarcRecord {
  /** WARC named fields in file order (`WARC-Type`, `WARC-Record-ID`, ...). */
  headers: HeaderList;
  /** The record block exactly as stored. */
  block: Uint8Array;
}

/** Serializes one WARC record; `Content-Length` is computed from the block. */
export function serializeWarcRecord(headers: HeaderList, block: Uint8Array): Uint8Array {
  const lines = [WARC_VERSION];
  for (const [name, value] of headers) {
    if (name.toLowerCase() === "content-length") continue;
    assertFieldText(name, value);
    lines.push(`${name}: ${value}`);
  }
  lines.push(`Content-Length: ${block.byteLength}`);
  const head = textEncoder.encode(`${lines.join(CRLF)}${CRLF}${CRLF}`);
  const tail = textEncoder.encode(`${CRLF}${CRLF}`);
  return concatBytes([head, block, tail]);
}

/** Parses an uncompressed WARC file into its records; fails closed on malformed input. */
export function parseWarc(bytes: Uint8Array): WarcRecord[] {
  const records: WarcRecord[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    const headEnd = indexOfSequence(bytes, HEADER_END, offset);
    if (headEnd < 0) throw new Error(`WARC record at byte ${offset} has no header terminator.`);
    const lines = new TextDecoder("utf-8", { fatal: true })
      .decode(bytes.subarray(offset, headEnd))
      .split(CRLF);
    if (lines[0] !== WARC_VERSION) {
      throw new Error(`WARC record at byte ${offset} is not ${WARC_VERSION}.`);
    }
    const headers: [string, string][] = lines.slice(1).map((line) => {
      const colon = line.indexOf(":");
      if (colon <= 0) throw new Error(`Malformed WARC header line "${line}".`);
      return [line.slice(0, colon), line.slice(colon + 1).trim()];
    });
    const length = Number(headerValue(headers, "Content-Length"));
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new Error(`WARC record at byte ${offset} has no valid Content-Length.`);
    }
    const blockStart = headEnd + HEADER_END.byteLength;
    const blockEnd = blockStart + length;
    if (
      blockEnd + 4 > bytes.byteLength ||
      bytes[blockEnd] !== 13 ||
      bytes[blockEnd + 1] !== 10 ||
      bytes[blockEnd + 2] !== 13 ||
      bytes[blockEnd + 3] !== 10
    ) {
      throw new Error(`WARC record at byte ${offset} is truncated.`);
    }
    records.push({ headers, block: bytes.slice(blockStart, blockEnd) });
    offset = blockEnd + 4;
  }
  return records;
}

/** The first value of a header (case-insensitive), as in HTTP and WARC named fields. */
export function headerValue(headers: HeaderList, name: string): string | undefined {
  const wanted = name.toLowerCase();
  return headers.find(([key]) => key.toLowerCase() === wanted)?.[1];
}

/** The HTTP/1.1 header block (start line, fields, blank line) of a request or response. */
export function httpHeaderBlock(startLine: string, headers: HeaderList): Uint8Array {
  const lines = [startLine];
  for (const [name, value] of headers) {
    assertFieldText(name, value);
    lines.push(`${name}: ${value}`);
  }
  return textEncoder.encode(`${lines.join(CRLF)}${CRLF}${CRLF}`);
}

/** Splits an `application/http` record block into its header block and entity body. */
export function splitHttpBlock(block: Uint8Array): {
  startLine: string;
  headers: [string, string][];
  body: Uint8Array;
} {
  const headEnd = indexOfSequence(block, HEADER_END, 0);
  if (headEnd < 0) throw new Error("HTTP block has no header terminator.");
  const [startLine = "", ...lines] = new TextDecoder("latin1")
    .decode(block.subarray(0, headEnd))
    .split(CRLF);
  return {
    startLine,
    headers: lines.map((line) => {
      const colon = line.indexOf(":");
      return [line.slice(0, colon), line.slice(colon + 1).trim()];
    }),
    body: block.slice(headEnd + HEADER_END.byteLength),
  };
}

export function labelledSha256(bytes: Uint8Array): string {
  return `sha256:${sha256Hex(bytes)}`;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A deterministic `urn:uuid:` record id (RFC 9562 version 8) derived from its parts. */
export function deterministicRecordId(...parts: string[]): string {
  const digest = createHash("sha256").update(parts.join("\0")).digest();
  digest[6] = (digest[6]! & 0x0f) | 0x80;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `<urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}>`;
}

/** WARC-Date: ISO 8601 UTC; millisecond precision is kept when present (WARC 1.1). */
export function warcDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid WARC date "${iso}".`);
  return date.toISOString().replace(".000Z", "Z");
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

const HEADER_END = textEncoder.encode(`${CRLF}${CRLF}`);

function indexOfSequence(bytes: Uint8Array, sequence: Uint8Array, from: number): number {
  outer: for (let index = from; index <= bytes.byteLength - sequence.byteLength; index += 1) {
    for (let offset = 0; offset < sequence.byteLength; offset += 1) {
      if (bytes[index + offset] !== sequence[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

function assertFieldText(name: string, value: string): void {
  if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) {
    throw new Error(`Header ${JSON.stringify(name)} contains a line break.`);
  }
}
