import type { CorpusSnapshot, ExtractedDocument } from "../domain/types";

const DB_NAME = "document-search";
const DB_VERSION = 1;
const DOCUMENT_STORE = "documents";

export async function listDocuments(): Promise<ExtractedDocument[]> {
  const database = await openDatabase();
  return requestToPromise(
    database.transaction(DOCUMENT_STORE, "readonly").objectStore(DOCUMENT_STORE).getAll(),
  );
}

export async function putDocument(document: ExtractedDocument): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(DOCUMENT_STORE, "readwrite");
  transaction.objectStore(DOCUMENT_STORE).put(document);
  await transactionDone(transaction);
}

export async function deleteDocument(id: string): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(DOCUMENT_STORE, "readwrite");
  transaction.objectStore(DOCUMENT_STORE).delete(id);
  await transactionDone(transaction);
}

export async function clearCorpus(): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(DOCUMENT_STORE, "readwrite");
  transaction.objectStore(DOCUMENT_STORE).clear();
  await transactionDone(transaction);
}

export async function replaceCorpus(snapshot: CorpusSnapshot): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(DOCUMENT_STORE, "readwrite");
  const store = transaction.objectStore(DOCUMENT_STORE);
  store.clear();
  for (const document of snapshot.documents) {
    store.put(document);
  }
  await transactionDone(transaction);
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(DOCUMENT_STORE)) {
        database.createObjectStore(DOCUMENT_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
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
