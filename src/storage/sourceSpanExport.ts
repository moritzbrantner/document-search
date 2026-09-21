import type {
  ExtractedDocument,
  SourceRecordV1,
  SourceSpanBatchV1,
  SourceSpanRecordV1,
} from "../domain/types";

const textEncoder = new TextEncoder();

export async function createSourceSpanBatch(
  documents: ExtractedDocument[],
  producerRevision: string,
): Promise<SourceSpanBatchV1> {
  if (!producerRevision.trim()) {
    throw new Error("A producer revision is required for source-span export.");
  }

  const sources: SourceRecordV1[] = [];
  const spans: SourceSpanRecordV1[] = [];

  for (const document of documents) {
    const sourceHash = await sha256(document.text);
    const documentSpans: SourceSpanRecordV1[] = [];
    let searchFrom = 0;

    for (const paragraph of [...document.paragraphs].sort((left, right) => left.ordinal - right.ordinal)) {
      const utf16Start = document.text.indexOf(paragraph.text, searchFrom);
      if (utf16Start < 0) {
        throw new Error(
          `Cannot locate paragraph ${paragraph.id} inside document ${document.id}; refusing to emit ambiguous provenance.`,
        );
      }
      const utf16End = utf16Start + paragraph.text.length;
      const byteStart = utf8Length(document.text.slice(0, utf16Start));
      const byteEnd = byteStart + utf8Length(paragraph.text);

      documentSpans.push({
        id: paragraph.id,
        sourceId: document.id,
        sequence: paragraph.ordinal,
        text: paragraph.text,
        contentHash: await sha256(paragraph.text),
        locator: {
          kind: "text",
          byteStart,
          byteEnd,
          paragraphOrdinal: paragraph.ordinal,
          ...(paragraph.sourceSelector ? { sourceSelector: paragraph.sourceSelector } : {}),
          headingPath: paragraph.headingPath,
        },
        metadata: {},
      });
      searchFrom = utf16End;
    }

    const revision = await sha256(
      JSON.stringify({
        contentHash: sourceHash,
        spans: documentSpans.map((span) => ({
          id: span.id,
          sequence: span.sequence,
          contentHash: span.contentHash,
          locator: span.locator,
        })),
      }),
    );

    sources.push({
      id: document.id,
      kind: "document",
      revision,
      ...(document.sourceUri ? { uri: document.sourceUri } : {}),
      title: document.title,
      creators: [],
      contentHash: sourceHash,
      metadata: {
        importedAt: document.importedAt,
      },
    });
    spans.push(...documentSpans);
  }

  return {
    schema: "source_span_interchange",
    schemaVersion: 1,
    producer: {
      name: "document-search",
      revision: producerRevision,
    },
    sources,
    spans,
  };
}

export async function serializeSourceSpanBatch(
  documents: ExtractedDocument[],
  producerRevision: string,
): Promise<string> {
  return JSON.stringify(await createSourceSpanBatch(documents, producerRevision), null, 2);
}

function utf8Length(value: string): number {
  return textEncoder.encode(value).byteLength;
}

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", textEncoder.encode(value));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
