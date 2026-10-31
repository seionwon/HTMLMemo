// Adapted from PDFMemo overrides/pdfEmbeddedSearchIndex.ts; presentation remains HTMLMemo-owned.
/** Portable, optional search text. The PDF remains an ordinary readable PDF.
 * v1: magic + uint32 BE JSON header length + header + independently gzipped
 * page-text chunks. No scripts, URLs, queries or device-specific geometry. */
export const PDF_SEARCH_INDEX_NAME = 'MemoSuite-search-index-v1.msi';
export const PDF_SEARCH_INDEX_MAGIC = 'MemoSuiteSearchIndex:1\n';
const MAX_ATTACHMENT = 64 * 1024 * 1024, MAX_HEADER = 256 * 1024, MAX_CHUNK = 4 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });
const hex = (bytes) => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
/** Reject unfamiliar/stale/unbounded data. A failure only disables this optional
 * accelerator; the caller still has normal PDF text extraction available. */
export async function openEmbeddedPdfSearchIndex(doc) {
    if (!doc.getAttachments || typeof DecompressionStream !== 'function' || !globalThis.crypto?.subtle)
        return null;
    try {
        // Ordinary PDFs may contain very large unrelated attachments. Check a
        // small producer marker before asking PDF.js to read embedded files.
        if (doc.getMetadata && (await doc.getMetadata())?.info?.Custom?.MemoSuiteSearchIndexVersion !== '1')
            return null;
        const attachments = await doc.getAttachments();
        const data = attachments?.[PDF_SEARCH_INDEX_NAME]?.content;
        if (!(data instanceof Uint8Array) || data.byteLength > MAX_ATTACHMENT || data.byteLength < PDF_SEARCH_INDEX_MAGIC.length + 4)
            return null;
        const prefix = PDF_SEARCH_INDEX_MAGIC.length;
        if (decoder.decode(data.subarray(0, prefix)) !== PDF_SEARCH_INDEX_MAGIC)
            return null;
        const length = new DataView(data.buffer, data.byteOffset + prefix, 4).getUint32(0);
        const body = prefix + 4 + length;
        if (!length || length > MAX_HEADER || body > data.length)
            return null;
        const header = JSON.parse(decoder.decode(data.subarray(prefix + 4, body)));
        if (header.version !== 1 || header.normalization !== 1 || header.pages !== doc.numPages ||
            !Number.isSafeInteger(header.pages) || header.pages < 1 || header.pages > 100_000 ||
            !/^[0-9a-f]{32}$/.test(header.fingerprint) || doc.fingerprints?.[0] !== header.fingerprint ||
            doc.fingerprints?.[1] && doc.fingerprints[1] !== header.fingerprint ||
            !Array.isArray(header.chunks) || !header.chunks.length || header.chunks.length > 2048)
            return null;
        let next = 1, offset = 0;
        for (const chunk of header.chunks) {
            if (!chunk || chunk.first !== next || chunk.offset !== offset ||
                !Number.isSafeInteger(chunk.count) || chunk.count < 1 || chunk.count > 256 ||
                !Number.isSafeInteger(chunk.length) || chunk.length < 1 ||
                !Number.isSafeInteger(chunk.bytes) || chunk.bytes < 1 || chunk.bytes > MAX_CHUNK ||
                !/^[0-9a-f]{64}$/.test(chunk.sha256))
                return null;
            next += chunk.count;
            offset += chunk.length;
        }
        if (next !== header.pages + 1 || offset !== data.length - body)
            return null;
        const cached = new Map(), pending = new Map();
        let generation = 0;
        const load = async (number) => {
            const found = cached.get(number);
            if (found) {
                cached.delete(number);
                cached.set(number, found);
                return found;
            }
            const old = pending.get(number);
            if (old)
                return old;
            const revision = generation;
            const task = (async () => {
                const chunk = header.chunks[number];
                const compressed = data.subarray(body + chunk.offset, body + chunk.offset + chunk.length);
                const digest = await crypto.subtle.digest('SHA-256', compressed);
                if (hex(digest) !== chunk.sha256)
                    throw new Error('PDF search chunk checksum differs');
                const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
                const parts = [];
                let size = 0;
                try {
                    for (;;) {
                        const { value, done } = await stream.read();
                        if (done)
                            break;
                        size += value.byteLength;
                        if (size > chunk.bytes || size > MAX_CHUNK)
                            throw new Error('PDF search chunk is too large');
                        parts.push(value);
                    }
                }
                catch (error) {
                    await stream.cancel().catch(() => { });
                    throw error;
                }
                if (size !== chunk.bytes)
                    throw new Error('PDF search chunk length differs');
                const decoded = new Uint8Array(size);
                let at = 0;
                for (const part of parts) {
                    decoded.set(part, at);
                    at += part.length;
                }
                const texts = JSON.parse(decoder.decode(decoded));
                if (!Array.isArray(texts) || texts.length !== chunk.count || texts.some(text => typeof text !== 'string' || text.length > 1_000_000))
                    throw new Error('Invalid PDF search page text');
                if (revision === generation) {
                    cached.set(number, texts);
                    // At most two decompressed chunks. Large documents never
                    // need a second full text copy in mobile memory.
                    while (cached.size > 2)
                        cached.delete(cached.keys().next().value);
                }
                return texts;
            })();
            pending.set(number, task);
            const remove = () => { if (pending.get(number) === task)
                pending.delete(number); };
            void task.then(remove, remove);
            return task;
        };
        return {
            async page(number) {
                if (!Number.isSafeInteger(number) || number < 1 || number > header.pages)
                    throw new Error('PDF search page outside document');
                // Small manifest, binary search; no 50,000-entry lookup table.
                let low = 0, high = header.chunks.length - 1;
                while (low < high) {
                    const middle = (low + high + 1) >>> 1;
                    if (header.chunks[middle].first <= number)
                        low = middle;
                    else
                        high = middle - 1;
                }
                return (await load(low))[number - header.chunks[low].first];
            },
            clear() { generation++; cached.clear(); pending.clear(); },
        };
    }
    catch {
        return null;
    }
}
