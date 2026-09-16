import type { CorpusSnapshot, ExtractedDocument } from "../domain/types";

const DB_NAME = "document-search";
const DB_VERSION = 2;
const DOCUMENT_STORE = "documents";
const METADATA_STORE = "metadata";
const DEMO_CORPUS_INITIALIZED_KEY = "demo-corpus-initialized";
const BLOCKED_UPGRADE_MESSAGE =
  "Local corpus upgrade is blocked by another open Document Search tab. Close other tabs and reload.";

export async function listDocuments(): Promise<ExtractedDocument[]> {
  return useDatabase((database) =>
    requestToPromise(
      database.transaction(DOCUMENT_STORE, "readonly").objectStore(DOCUMENT_STORE).getAll(),
    ),
  );
}

export async function putDocument(document: ExtractedDocument): Promise<void> {
  await useDatabase(async (database) => {
    const transaction = database.transaction(DOCUMENT_STORE, "readwrite");
    transaction.objectStore(DOCUMENT_STORE).put(document);
    await transactionDone(transaction);
  });
}

export async function deleteDocument(id: string): Promise<void> {
  await useDatabase(async (database) => {
    const transaction = database.transaction(DOCUMENT_STORE, "readwrite");
    transaction.objectStore(DOCUMENT_STORE).delete(id);
    await transactionDone(transaction);
  });
}

export async function clearCorpus(): Promise<void> {
  await useDatabase(async (database) => {
    const transaction = database.transaction(DOCUMENT_STORE, "readwrite");
    transaction.objectStore(DOCUMENT_STORE).clear();
    await transactionDone(transaction);
  });
}

export async function replaceCorpus(snapshot: CorpusSnapshot): Promise<void> {
  await useDatabase(async (database) => {
    const transaction = database.transaction(DOCUMENT_STORE, "readwrite");
    const store = transaction.objectStore(DOCUMENT_STORE);
    store.clear();
    for (const document of snapshot.documents) {
      store.put(document);
    }
    await transactionDone(transaction);
  });
}

export async function initializeSeedCorpusOnce(
  seedDocuments: ExtractedDocument[],
): Promise<boolean> {
  return useDatabase(
    (database) =>
      new Promise<boolean>((resolve, reject) => {
        const transaction = database.transaction(
          [DOCUMENT_STORE, METADATA_STORE],
          "readwrite",
        );
        const documentStore = transaction.objectStore(DOCUMENT_STORE);
        const metadataStore = transaction.objectStore(METADATA_STORE);
        let seeded = false;

        transaction.oncomplete = () => resolve(seeded);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);

        const initializedRequest = metadataStore.get(DEMO_CORPUS_INITIALIZED_KEY);
        initializedRequest.onsuccess = () => {
          if (initializedRequest.result === true) {
            return;
          }

          const documentsRequest = documentStore.getAll();
          documentsRequest.onsuccess = () => {
            try {
              seeded = shouldSeedCorpus(documentsRequest.result, seedDocuments);
              if (seeded) {
                for (const document of seedDocuments) {
                  documentStore.put(document);
                }
              }
              metadataStore.put(true, DEMO_CORPUS_INITIALIZED_KEY);
            } catch {
              transaction.abort();
            }
          };
        };
      }),
  );
}

export function shouldSeedCorpus(
  existingDocuments: Array<Pick<ExtractedDocument, "id">>,
  seedDocuments: Array<Pick<ExtractedDocument, "id">>,
): boolean {
  const seedDocumentIds = new Set(seedDocuments.map((document) => document.id));
  return (
    existingDocuments.length === 0 ||
    existingDocuments.every((document) => seedDocumentIds.has(document.id))
  );
}

export function shouldMarkDemoCorpusInitializedOnUpgrade(oldVersion: number): boolean {
  return oldVersion > 0;
}

async function useDatabase<T>(operation: (database: IDBDatabase) => Promise<T>): Promise<T> {
  const database = await openDatabase();
  try {
    return await operation(database);
  } finally {
    database.close();
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    let blocked = false;

    request.onupgradeneeded = (event) => {
      const database = request.result;
      if (!database.objectStoreNames.contains(DOCUMENT_STORE)) {
        database.createObjectStore(DOCUMENT_STORE, { keyPath: "id" });
      }

      const metadataStore = database.objectStoreNames.contains(METADATA_STORE)
        ? request.transaction?.objectStore(METADATA_STORE)
        : database.createObjectStore(METADATA_STORE);

      if (metadataStore && shouldMarkDemoCorpusInitializedOnUpgrade(event.oldVersion)) {
        metadataStore.put(true, DEMO_CORPUS_INITIALIZED_KEY);
      }
    };
    request.onblocked = () => {
      blocked = true;
      reject(new Error(BLOCKED_UPGRADE_MESSAGE));
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      if (blocked) {
        database.close();
        return;
      }
      resolve(database);
    };
    request.onerror = () => reject(request.error);
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}
