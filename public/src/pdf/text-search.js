// Adapted from PDFMemo overrides/pdfTextSearch.ts; presentation remains HTMLMemo-owned.
import { openEmbeddedPdfSearchIndex } from './embedded-search-index.js';
/** PDF text can split Korean syllables/words across items or lines. Treat layout
 * whitespace as insignificant, fold case and normalize ligatures/full-width text. */
export const normalizePdfQuery = (text) => text.normalize('NFKC').toLowerCase().replace(/[\s\u200b\u00ad]+/gu, '');
const simpleText = /^[\x00-\x7f\uac00-\ud7a3\u2000-\u206f\u3000-\u303f]*$/u;
const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
const segments = (raw) => segmenter ? segmenter.segment(raw)
    : Array.from(raw.matchAll(/\P{M}\p{M}*|\p{M}+/gu), match => ({ segment: match[0], index: match.index }));
function sourceText(content) {
    return content.items.filter(item => typeof item.str === 'string' && Array.isArray(item.transform))
        .map(item => item.str + (item.hasEOL ? '\n' : '')).join('');
}
// The common Korean/ASCII path has no cross-grapheme normalization changes.
// Keep the original grapheme semantics for decomposed/compatibility text.
function searchableText(raw) {
    if (simpleText.test(raw))
        return normalizePdfQuery(raw);
    let text = '';
    for (const { segment } of segments(raw))
        text += normalizePdfQuery(segment);
    return text;
}
function sourceOffsets(raw) {
    const starts = [], ends = [];
    let text = '';
    if (simpleText.test(raw)) {
        for (let at = 0; at < raw.length; at++) {
            const code = raw.charCodeAt(at);
            if (code === 32 || code >= 9 && code <= 13)
                continue;
            const normalized = code >= 65 && code <= 90 ? String.fromCharCode(code + 32)
                : code < 128 || code >= 0xac00 && code <= 0xd7a3 ? raw[at] : normalizePdfQuery(raw[at]);
            text += normalized;
            for (let i = 0; i < normalized.length; i++) {
                starts.push(at);
                ends.push(at + 1);
            }
        }
    }
    else
        for (const { segment, index } of segments(raw)) {
            const normalized = normalizePdfQuery(segment);
            text += normalized;
            for (let i = 0; i < normalized.length; i++) {
                starts.push(index);
                ends.push(index + segment.length);
            }
        }
    return { text, starts, ends };
}
export function indexPdfSearchPage(content, viewport) {
    const items = [];
    let raw = '';
    for (const item of content.items) {
        if (typeof item.str !== 'string' || !Array.isArray(item.transform))
            continue;
        const start = raw.length;
        raw += item.str;
        items.push({ item, start, end: raw.length });
        if (item.hasEOL)
            raw += '\n';
    }
    return { raw, ...sourceOffsets(raw), items, styles: content.styles || {}, viewport };
}
function textRect(item, style, viewport, from, to, measure) {
    const [a, b, c, d, e, f] = viewport.transform, [g, h, i, j, k, l] = item.transform;
    const tx = [a * g + c * h, b * g + d * h, a * i + c * j, b * i + d * j, a * k + c * l + e, b * k + d * l + f];
    let angle = Math.atan2(tx[1], tx[0]);
    if (style.vertical)
        angle += Math.PI / 2;
    const height = Math.hypot(tx[2], tx[3]);
    const length = (style.vertical ? item.height : item.width) * Math.hypot(a, b);
    if (!(length > 0 && height > 0 && viewport.width > 0 && viewport.height > 0))
        return null;
    let start = from / item.str.length, end = to / item.str.length;
    if (measure && !style.vertical) {
        const font = `${height}px ${style.fontFamily || 'sans-serif'}`, full = measure(item.str, font);
        if (full > 0) {
            start = measure(item.str.slice(0, from), font) / full;
            end = measure(item.str.slice(0, to), font) / full;
        }
    }
    if (item.dir === 'rtl')
        [start, end] = [1 - end, 1 - start];
    // Chrome's embedded book fonts can report NaN ascent/descent in PDF.js.
    // Nullish checks alone would propagate NaN and suppress every rectangle.
    const ascentRatio = Number.isFinite(style.ascent) ? style.ascent
        : Number.isFinite(style.descent) ? 1 + style.descent : .8;
    const ascent = height * ascentRatio;
    const sin = Math.sin(angle), cos = Math.cos(angle);
    const left = tx[4] + sin * ascent, top = tx[5] - cos * ascent;
    const points = [start, end].flatMap(t => [0, height].map(y => [left + cos * length * t - sin * y, top + sin * length * t + cos * y]));
    const x = Math.max(0, Math.min(...points.map(p => p[0])) / viewport.width);
    const y = Math.max(0, Math.min(...points.map(p => p[1])) / viewport.height);
    const right = Math.min(1, Math.max(...points.map(p => p[0])) / viewport.width);
    const bottom = Math.min(1, Math.max(...points.map(p => p[1])) / viewport.height);
    return right > x && bottom > y ? { x, y, w: right - x, h: bottom - y } : null;
}
export function findPdfPageMatches(index, query, page, limit = 2000, measure) {
    return findMatches(index, normalizePdfQuery(query), page, limit, (start, end) => matchRects(index, start, end, measure));
}
function matchRects(index, start, end, measure) {
    const rects = [];
    for (const run of index.items) {
        if (run.start >= end)
            break;
        if (run.end <= start || !run.item.str.trim())
            continue;
        const r = textRect(run.item, index.styles[run.item.fontName] || {}, index.viewport, Math.max(0, start - run.start), Math.min(run.item.str.length, end - run.start), measure);
        if (r)
            rects.push(r);
    }
    return rects;
}
function findMatches(index, needle, page, limit, rectangles) {
    const matches = [];
    if (!needle)
        return matches;
    let offset = 0;
    while (matches.length < limit) {
        const at = index.text.indexOf(needle, offset);
        if (at < 0)
            break;
        offset = at + needle.length;
        const start = index.starts[at], end = index.ends[offset - 1];
        matches.push({ id: `${page}:${start}`, page, start, end,
            before: (start > 36 ? '…' : '') + index.raw.slice(Math.max(0, start - 36), start).replace(/\s+/g, ' '),
            text: index.raw.slice(start, end).replace(/\s+/g, ' '),
            after: index.raw.slice(end, end + 64).replace(/\s+/g, ' ') + (end + 64 < index.raw.length ? '…' : ''), rects: rectangles(start, end) });
    }
    return matches;
}
/** Keep a bounded, compact document text index independently of the small
 * geometry LRU. No canvases, operator lists or persistent search history. */
export class PdfTextSearch {
    doc;
    options;
    cache = new Map();
    details = new Map();
    pending = new Map();
    characters = 0;
    detailCharacters = 0;
    generation = 0;
    restored;
    changed = false;
    storageFailed = false;
    embedded = null;
    constructor(doc, options = {}) {
        this.doc = doc;
        this.options = options;
    }
    remember(number, page) {
        const size = page.raw.length + page.text.length, budget = this.options.maxTextCharacters ?? 32_000_000;
        if (size > budget)
            return;
        const old = this.cache.get(number);
        if (old)
            this.characters -= old.raw.length + old.text.length;
        this.cache.delete(number);
        this.cache.set(number, page);
        this.characters += size;
        while (this.cache.size > 100_000 || this.characters > budget) {
            const key = this.cache.keys().next().value, old = this.cache.get(key);
            this.characters -= old.raw.length + old.text.length;
            this.cache.delete(key);
        }
    }
    restore() {
        const generation = this.generation;
        return this.restored ||= (async () => {
            const embedded = await openEmbeddedPdfSearchIndex(this.doc);
            if (generation !== this.generation) {
                embedded?.clear();
                return;
            }
            this.embedded = embedded;
            if (embedded)
                return; // Portable source takes priority; do not load a second full disk copy.
            try {
                const pages = await this.options.store?.load();
                if (generation !== this.generation)
                    return;
                for (const [number, page] of pages || []) {
                    if (Number.isInteger(number) && number > 0 && number <= this.doc.numPages &&
                        typeof page?.raw === 'string' && typeof page?.text === 'string')
                        this.remember(number, page);
                }
            }
            catch {
                this.storageFailed = true;
            } // Search remains available without disk caching.
        })();
    }
    async persist() {
        if (this.embedded || !this.options.store || !this.changed || this.storageFailed)
            return;
        this.changed = false;
        try {
            await this.options.store.save([...this.cache]);
        }
        catch {
            this.storageFailed = true;
        }
    }
    load(number, signal) {
        const detail = this.details.get(number);
        if (detail) {
            this.details.delete(number);
            this.details.set(number, detail);
            return Promise.resolve(detail);
        }
        const pending = this.pending.get(number);
        if (pending)
            return pending;
        const generation = this.generation;
        const loading = (async () => {
            const page = await this.doc.getPage(number), content = await page.getTextContent();
            const raw = sourceText(content), text = searchableText(raw);
            const data = { raw, text, content, viewport: page.getViewport({ scale: 1 }) };
            if (generation !== this.generation || signal?.aborted)
                return data;
            const previous = this.cache.get(number);
            this.remember(number, { raw, text });
            if (!previous || previous.raw !== raw || previous.text !== text)
                this.changed = true;
            const size = raw.length + text.length;
            if (size <= 200_000) {
                this.details.set(number, data);
                this.detailCharacters += size;
                while (this.details.size > 16 || this.detailCharacters > 200_000) {
                    const key = this.details.keys().next().value, old = this.details.get(key);
                    this.detailCharacters -= old.raw.length + old.text.length;
                    this.details.delete(key);
                }
            }
            return data;
        })();
        this.pending.set(number, loading);
        const remove = () => { if (this.pending.get(number) === loading)
            this.pending.delete(number); };
        void loading.then(remove, remove);
        return loading;
    }
    async page(number, signal) {
        const cached = this.cache.get(number);
        if (cached) {
            this.cache.delete(number);
            this.cache.set(number, cached);
            return cached;
        }
        if (this.embedded) {
            const generation = this.generation;
            try {
                const raw = await this.embedded.page(number);
                const page = { raw, text: searchableText(raw) };
                if (!signal.aborted && generation === this.generation)
                    this.remember(number, page);
                return page;
            }
            catch {
                // A corrupt chunk falls back to real PDF text, with later pages
                // also using extraction. Never turn an unread chunk into no hits.
                this.embedded?.clear();
                this.embedded = null;
            }
        }
        return this.load(number, signal);
    }
    /** Resolve geometry only for selected/displayed result pages. */
    async locate(matches, signal, measure) {
        if (!matches.length || signal.aborted)
            return [];
        const indexed = this.cache.get(matches[0].page);
        const data = await this.load(matches[0].page, signal);
        if (signal.aborted)
            return [];
        if ((indexed && indexed.raw !== data.raw) || matches.some(match => normalizePdfQuery(data.raw.slice(match.start, match.end)) !== normalizePdfQuery(match.text))) {
            // Some PDF editors preserve both trailer IDs. Validate the selected
            // page before drawing highlights and make the next search extract.
            this.embedded?.clear();
            this.embedded = null;
            this.cache.clear();
            this.characters = 0;
            throw new Error('Embedded PDF search text differs from the selected page');
        }
        const index = data.index ||= indexPdfSearchPage(data.content, data.viewport);
        return matches.map(match => ({ ...match, rects: matchRects(index, match.start, match.end, measure) }));
    }
    async run(query, startPage, signal, publish, options = {}) {
        const needle = normalizePdfQuery(query);
        if (!needle || signal.aborted)
            return;
        const total = this.doc.numPages, start = Math.max(1, Math.min(total, startPage || 1));
        const limit = options.limit || 2000, matches = [];
        let scanned = 0, errors = 0, textPages = 0, lastPublish = 0, lastYield = performance.now();
        const emit = (complete = false, limited = false) => {
            if (!signal.aborted)
                publish({ matches: [...matches].sort((a, b) => a.page - b.page || a.start - b.start), scanned, total, errors, textPages, complete, limited });
            lastPublish = Date.now();
        };
        emit();
        if (this.doc.getAttachments || this.options.store) {
            await this.restore();
            if (signal.aborted)
                return;
        }
        // One page first for immediate current-page results/cancellation, then a
        // small ordered pipeline to amortize PDF worker message latency.
        const ahead = new Map();
        const numberAt = (i) => (start - 1 + i) % total + 1;
        const preload = (i) => {
            if (!ahead.has(i))
                ahead.set(i, this.page(numberAt(i), signal).then(text => ({ text }), error => ({ error })));
        };
        const concurrency = Math.max(1, Math.min(4, this.options.concurrency || 4));
        for (let i = 0; i < total && !signal.aborted; i++) {
            const number = numberAt(i), oldCount = matches.length;
            try {
                preload(i);
                const result = await ahead.get(i);
                ahead.delete(i);
                if (signal.aborted)
                    return;
                if (result.error)
                    throw result.error;
                const page = result.text;
                if (page.text)
                    textPages++;
                if (page.text.includes(needle)) {
                    if (options.deferGeometry)
                        matches.push(...findMatches({ raw: page.raw, ...sourceOffsets(page.raw) }, needle, number, limit - matches.length, () => []));
                    else {
                        const data = await this.load(number, signal);
                        if (signal.aborted)
                            return;
                        const index = data.index ||= indexPdfSearchPage(data.content, data.viewport);
                        matches.push(...findPdfPageMatches(index, query, number, limit - matches.length, options.measure));
                    }
                }
            }
            catch {
                if (signal.aborted)
                    return;
                errors++;
            }
            scanned++;
            if (matches.length >= limit) {
                emit(true, true);
                await this.persist();
                return;
            }
            if ((!oldCount && matches.length) || Date.now() - lastPublish > 100)
                emit();
            // Time slices keep input responsive without a 4 ms browser timer
            // clamp on every page of a tens-of-thousands-page document.
            if (performance.now() - lastYield >= 8) {
                await (options.pause ? options.pause() : new Promise(resolve => setTimeout(resolve, 0)));
                lastYield = performance.now();
            }
            if (signal.aborted)
                return;
            for (let next = i + 1; next < Math.min(total, i + 1 + concurrency); next++)
                preload(next);
        }
        emit(true);
        await this.persist();
    }
    clear() { this.generation++; this.embedded?.clear(); this.embedded = null; this.cache.clear(); this.details.clear(); this.pending.clear(); this.restored = undefined; this.changed = false; this.characters = this.detailCharacters = 0; }
}
