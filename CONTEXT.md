# Document Search

Document Search manages a local corpus of imported HTML, Markdown and plain-text documents so the user can search and inspect extracted text. The corpus lives in the browser (IndexedDB) or, for large local folders, in a managed corpus directory on disk (filesystem corpus mode); both hold the same document records.

## Language

**Corpus**:
The user's local working set of imported HTML, Markdown and plain-text documents, with their extracted text, available for search.
_Avoid_: Library, Collection, Index, Database

**Duplicate rule**:
The user-adjustable rule that decides when an imported document represents a document already present in the corpus.
_Avoid_: Identity rule, Import matching

**Same page**:
A duplicate rule that identifies documents by normalized source URI, including URLs, manual source identifiers, and uploaded file names.

**Same content**:
A duplicate rule that identifies documents by normalized extracted searchable text, ignoring markup-only differences.

**Path alias**:
In filesystem corpus mode, the source record of one scanned file path. Each path alias has its own document, even when several paths hold identical bytes.
_Avoid_: File entry, Duplicate

**Payload**:
The raw bytes of a scanned file, stored once per SHA-256 hash in the corpus directory and referenced by every path alias holding those bytes.
_Avoid_: Blob, Attachment
