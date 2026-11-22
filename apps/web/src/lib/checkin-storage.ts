export interface OfflineTicketEntry {
  ticketIdHash: string;
  status: 'ISSUED' | 'USED' | 'REVOKED';
}

export interface OfflineManifest {
  eventId: string;
  eventEndAt: string;
  publicKeys: {
    currentKid: string;
    keys: Array<{ kid: string; publicKey: string }>;
  };
  data: OfflineTicketEntry[];
}

export interface QueuedOfflineScan {
  key: string;
  eventId: string;
  ticketIdHash: string;
  deviceId: string;
  scannedAt: string;
}

const DATABASE_NAME = 'uneventful-checkin';
const DATABASE_VERSION = 1;
const MANIFEST_STORE = 'manifests';
const SCAN_STORE = 'scans';

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('Offline check-in storage is unavailable in this browser.'));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(MANIFEST_STORE)) {
        database.createObjectStore(MANIFEST_STORE, { keyPath: 'eventId' });
      }
      if (!database.objectStoreNames.contains(SCAN_STORE)) {
        const store = database.createObjectStore(SCAN_STORE, { keyPath: 'key' });
        store.createIndex('eventId', 'eventId', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Offline check-in storage could not be opened.'));
    request.onblocked = () => reject(new Error('Offline check-in storage is busy in another tab.'));
  });
}

async function transact<T>(
  storeNames: string[],
  mode: IDBTransactionMode,
  run: (transaction: IDBTransaction) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(storeNames, mode);
      const request = run(transaction);
      let result: T;
      request.onsuccess = () => {
        result = request.result;
      };
      request.onerror = () => reject(new Error('Offline check-in storage operation failed.'));
      transaction.onabort = () => reject(new Error('Offline check-in storage transaction failed.'));
      transaction.onerror = () => reject(new Error('Offline check-in storage transaction failed.'));
      transaction.oncomplete = () => resolve(result);
    });
  } finally {
    database.close();
  }
}

export async function saveOfflineManifest(manifest: OfflineManifest): Promise<void> {
  await transact([MANIFEST_STORE], 'readwrite', (transaction) =>
    transaction.objectStore(MANIFEST_STORE).put(manifest),
  );
}

export async function loadOfflineManifest(eventId: string): Promise<OfflineManifest | undefined> {
  return transact([MANIFEST_STORE], 'readonly', (transaction) =>
    transaction.objectStore(MANIFEST_STORE).get(eventId),
  );
}

export async function queueOfflineScan(scan: Omit<QueuedOfflineScan, 'key'>): Promise<void> {
  const key = `${scan.eventId}:${scan.ticketIdHash}`;
  await transact([SCAN_STORE], 'readwrite', (transaction) =>
    transaction.objectStore(SCAN_STORE).put({ ...scan, key }),
  );
}

export async function listOfflineScans(eventId: string): Promise<QueuedOfflineScan[]> {
  const database = await openDatabase();
  try {
    return await new Promise<QueuedOfflineScan[]>((resolve, reject) => {
      const transaction = database.transaction([SCAN_STORE], 'readonly');
      const request = transaction
        .objectStore(SCAN_STORE)
        .index('eventId')
        .getAll(IDBKeyRange.only(eventId));
      request.onsuccess = () => resolve(request.result as QueuedOfflineScan[]);
      request.onerror = () => reject(new Error('Offline check-in queue could not be read.'));
      transaction.onabort = () => reject(new Error('Offline check-in queue transaction failed.'));
    });
  } finally {
    database.close();
  }
}

export async function clearQueuedScans(eventId: string): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([SCAN_STORE], 'readwrite');
      const store = transaction.objectStore(SCAN_STORE);
      const request = store.index('eventId').openKeyCursor(IDBKeyRange.only(eventId));
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          store.delete(cursor.primaryKey);
          cursor.continue();
        }
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new Error('Offline check-in queue could not be cleared.'));
      transaction.onabort = () =>
        reject(new Error('Offline check-in queue cleanup was interrupted.'));
    });
  } finally {
    database.close();
  }
}

export async function clearEventCheckinData(eventId: string): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([MANIFEST_STORE, SCAN_STORE], 'readwrite');
      transaction.objectStore(MANIFEST_STORE).delete(eventId);
      const scans = transaction.objectStore(SCAN_STORE);
      const request = scans.index('eventId').openKeyCursor(IDBKeyRange.only(eventId));
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          scans.delete(cursor.primaryKey);
          cursor.continue();
        }
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new Error('Offline check-in data could not be cleared.'));
      transaction.onabort = () => reject(new Error('Offline check-in cleanup was interrupted.'));
    });
  } finally {
    database.close();
  }
}

export async function clearAllCheckinData(): Promise<void> {
  if (typeof indexedDB === 'undefined') {
    return;
  }
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([MANIFEST_STORE, SCAN_STORE], 'readwrite');
      transaction.objectStore(MANIFEST_STORE).clear();
      transaction.objectStore(SCAN_STORE).clear();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new Error('Offline check-in data could not be cleared.'));
      transaction.onabort = () => reject(new Error('Offline check-in cleanup was interrupted.'));
    });
  } finally {
    database.close();
  }
}
