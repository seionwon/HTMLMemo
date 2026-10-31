// Adapted from PDFMemo search-cache.ts; presentation remains LibreMemo-owned.
let database;
function db() {
    return database ||= new Promise((resolve, reject) => {
        const request = indexedDB.open('HTMLMemo-PDF-search-text-v1', 1);
        request.onupgradeneeded = () => {
            request.result.createObjectStore('documents', { keyPath: 'id' });
            request.result.createObjectStore('metadata', { keyPath: 'id' }).createIndex('used', 'used');
        };
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('Search cache unavailable'));
        request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    });
}
export function createSearchTextCache(file, pageCount) {
    const revision = `${file.modified}:${file.length}:${pageCount}:normalization-1`;
    return {
        async load() {
            const database = await db();
            return new Promise((resolve, reject) => {
                const transaction = database.transaction(['documents', 'metadata'], 'readwrite'), store = transaction.objectStore('documents');
                const metadata = transaction.objectStore('metadata');
                const request = store.get(file.id);
                let pages;
                request.onsuccess = () => {
                    const cached = request.result;
                    if (cached?.revision === revision && Array.isArray(cached.pages)) {
                        pages = cached.pages;
                        metadata.put({ id: file.id, characters: cached.characters, used: Date.now() });
                    }
                    else if (cached) {
                        store.delete(file.id);
                        metadata.delete(file.id);
                    }
                };
                transaction.oncomplete = () => resolve(pages);
                transaction.onerror = transaction.onabort = () => reject(transaction.error);
            });
        },
        async save(pages) {
            const database = await db();
            const characters = pages.reduce((sum, [, page]) => sum + page.raw.length + page.text.length, 0);
            if (characters > 32_000_000)
                return;
            return new Promise((resolve, reject) => {
                const transaction = database.transaction(['documents', 'metadata'], 'readwrite'), store = transaction.objectStore('documents');
                const metadata = transaction.objectStore('metadata');
                store.put({ id: file.id, revision, pages, characters });
                metadata.put({ id: file.id, characters, used: Date.now() });
                // Keep at most three recently searched files / 64M characters
                // on disk. This deletes derived text only, never PDF files.
                const records = [];
                const cursor = metadata.index('used').openCursor(undefined, 'prev');
                let kept = 1, size = characters;
                cursor.onsuccess = () => {
                    const value = cursor.result;
                    if (!value) {
                        for (const record of records) {
                            store.delete(record.id);
                            metadata.delete(record.id);
                        }
                        return;
                    }
                    const record = value.value;
                    if (record.id === file.id) {
                        value.continue();
                        return;
                    }
                    if (kept >= 3 || size + record.characters > 64_000_000)
                        records.push(record);
                    else {
                        kept++;
                        size += record.characters;
                    }
                    value.continue();
                };
                transaction.oncomplete = () => resolve();
                transaction.onerror = transaction.onabort = () => reject(transaction.error);
            });
        },
    };
}
