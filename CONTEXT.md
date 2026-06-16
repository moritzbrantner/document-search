# Document Search

Document Search manages a local browser-owned corpus of imported HTML documents so the user can search and inspect extracted text.

## Language

**Corpus**:
The user's local working set of extracted HTML documents available for search.
_Avoid_: Library, Collection, Index, Database

**Duplicate rule**:
The user-adjustable rule that decides when an imported document represents a document already present in the corpus.
_Avoid_: Identity rule, Import matching

**Same page**:
A duplicate rule that identifies documents by normalized source URI, including URLs, manual source identifiers, and uploaded file names.

**Same content**:
A duplicate rule that identifies documents by normalized extracted searchable text, ignoring markup-only differences.
