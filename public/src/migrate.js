// 「새 판으로 주석/북마크 옮기기」 — find each annotation and bookmark in a new edition of the
// same document. A book keeps being edited: sentences are reworded, sections move, some are
// removed. An annotation follows its text (or the paragraph it was drawn on) to wherever that text
// now is, survives small rewording, and is dropped only when its text is gone from the new edition.
import { TEXT_TOOLS } from './model.js';
import { textIndex, rangeFromOffsets, describeDrawingTarget, drawingTargetQuote, bookmarkAnchorTarget, LOCAL_CSP } from './document.js';
import { IsolatedRuntime,needsIsolatedRuntime } from './isolated-runtime.js';
import {bookmarkTextAnchor,bookmarkTextLocation,findBookmarkText} from './bookmark-location.js';

const CONTEXT = 40;
// Below these, a changed text is treated as a different text rather than an edited one.
const TEXT_MATCH = .7, ELEMENT_MATCH = .6, MIN_FUZZY = 6;

export function bookManifest(doc) {
  try {
    const manifest = JSON.parse(doc?.getElementById?.('book-manifest')?.textContent || 'null');
    return ['book-html-v1', 'memosuite-book-html-v1'].includes(manifest?.format) && Array.isArray(manifest.volumes) ? manifest : null;
  } catch { return null; }
}

// ── Book bodies: each volume is a base64 ZIP holding sections.json (one markdown text per section).
const base64Bytes = text => {
  const binary = atob(text.replace(/\s+/g, '')), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};
async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
export async function unzipEntry(bytes, name) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('책 본문 압축을 읽지 못했습니다.');
  const decoder = new TextDecoder();
  let p = view.getUint32(end + 16, true);
  for (let i = 0, count = view.getUint16(end + 10, true); i < count && view.getUint32(p, true) === 0x02014b50; i++) {
    const method = view.getUint16(p + 10, true), size = view.getUint32(p + 20, true), nameLength = view.getUint16(p + 28, true);
    const skip = nameLength + view.getUint16(p + 30, true) + view.getUint16(p + 32, true), local = view.getUint32(p + 42, true);
    if (decoder.decode(bytes.subarray(p + 46, p + 46 + nameLength)) === name) {
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true), data = bytes.subarray(start, start + size);
      if (method === 0) return data;
      if (method === 8) return inflateRaw(data);
      throw new Error('지원하지 않는 책 본문 압축 방식입니다.');
    }
    p += 46 + skip;
  }
  return null;
}
export async function bookSectionTexts(doc, volume) {
  const payload = doc.getElementById('book-volume-' + volume)?.textContent;
  if (!payload) return null;
  const bytes = await unzipEntry(base64Bytes(payload), 'sections.json');
  return bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null;
}
// Markdown and the rendered page differ in markup only; this is enough to tell which sections
// contain a quote before rendering them.
const plain = text => String(text || '').replace(/\]\([^)]*\)/g, '').replace(/[*_`~#>|[\]\\]/g, '').replace(/\s+/g, ' ').trim();

// ── Text matching
export function similarity(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  let prev = Array.from({length: b.length + 1}, (_, i) => i), cur = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    [prev, cur] = [cur, prev];
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}
// Best approximate occurrence of pattern anywhere inside text (semi-global edit distance).
function align(pattern, text) {
  const m = pattern.length;
  let prev = new Int32Array(m + 1), cur = new Int32Array(m + 1), prevStart = new Int32Array(m + 1), curStart = new Int32Array(m + 1);
  for (let i = 0; i <= m; i++) prev[i] = i;
  let best = {distance: m, start: 0, end: 0};
  for (let j = 1; j <= text.length; j++) {
    cur[0] = 0; curStart[0] = j;
    for (let i = 1; i <= m; i++) {
      const replace = prev[i - 1] + (pattern[i - 1] === text[j - 1] ? 0 : 1), extra = prev[i] + 1, missing = cur[i - 1] + 1;
      if (replace <= extra && replace <= missing) { cur[i] = replace; curStart[i] = prevStart[i - 1]; }
      else if (missing <= extra) { cur[i] = missing; curStart[i] = curStart[i - 1]; }
      else { cur[i] = extra; curStart[i] = prevStart[i]; }
    }
    if (cur[m] < best.distance) best = {distance: cur[m], start: curStart[m], end: j};
    [prev, cur] = [cur, prev]; [prevStart, curStart] = [curStart, prevStart];
  }
  return best;
}
function sharedLength(a, b, fromEnd) {
  let n = 0;
  if (fromEnd) while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  else while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}
function contextScore(text, start, end, anchor) {
  const prefix = anchor.prefix || '', suffix = anchor.suffix || '';
  if (!prefix && !suffix) return 0;
  return (sharedLength(text.slice(Math.max(0, start - prefix.length), start), prefix, true) +
    sharedLength(text.slice(end, end + suffix.length), suffix, false)) / (prefix.length + suffix.length);
}
// Where anchor.quote now is in text[from, to): the exact text (best surrounding context first),
// or else the closest edited version of it. Returns null when it is no longer there.
export function locateQuote(text, anchor, from = 0, to = text.length) {
  const quote = anchor?.quote || '', m = quote.length;
  if (!m) return null;
  let best = null;
  for (let found = text.indexOf(quote, from); found !== -1 && found + m <= to; found = text.indexOf(quote, found + 1)) {
    const context = contextScore(text, found, found + m, anchor);
    if (!best || context > best.context) best = {start: found, end: found + m, similarity: 1, context};
  }
  if (best || m < MIN_FUZZY) return best;
  if (m > 600) {
    // Long passages: find the opening and the closing separately, then take the span between.
    const head = locateQuote(text, {quote: quote.slice(0, 300), prefix: anchor.prefix}, from, to);
    const tail = head && locateQuote(text, {quote: quote.slice(-300), suffix: anchor.suffix}, head.start, to);
    if (!head || !tail || tail.end - head.start < m * .5 || tail.end - head.start > m * 1.5) return null;
    return {start: head.start, end: tail.end, similarity: Math.min(head.similarity, tail.similarity), context: (head.context + tail.context) / 2};
  }
  const k = Math.max(4, Math.min(12, Math.floor(m / 4))), starts = new Map(), bucket = Math.max(8, Math.floor(m / 2));
  const seed = (piece, offset) => {
    if (piece.length < 4) return;
    for (let found = text.indexOf(piece, from), n = 0; found !== -1 && found < to && n < 200; found = text.indexOf(piece, found + 1), n++) {
      const start = found - offset, key = Math.round(start / bucket);
      if (!starts.has(key)) starts.set(key, start);
    }
  };
  for (const at of new Set([0, (m - k) >> 2, (m - k) >> 1, (3 * (m - k)) >> 2, m - k])) seed(quote.slice(at, at + k), at);
  const before = (anchor.prefix || '').slice(-12), after = (anchor.suffix || '').slice(0, 12);
  if (before) seed(before, -before.length);
  if (after) seed(after, m);
  for (const start of [...starts.values()].slice(0, 80)) {
    const left = Math.max(from, start - Math.ceil(m / 2)), right = Math.min(to, start + m + Math.ceil(m / 2));
    if (right <= left) continue;
    const hit = align(quote, text.slice(left, right)), score = 1 - hit.distance / m;
    if (score < TEXT_MATCH || hit.end <= hit.start) continue;
    const candidate = {start: left + hit.start, end: left + hit.end, similarity: score};
    candidate.context = contextScore(text, candidate.start, candidate.end, anchor);
    if (!best || candidate.similarity + candidate.context * .1 > best.similarity + best.context * .1) best = candidate;
  }
  return best;
}
// The element a drawing was made on: same tag, closest text, then closest position.
export function locateElement(doc, root, target) {
  const pathDistance = element => {
    const path = describeDrawingTarget(doc, element).path;
    let distance = Math.abs(path.length - target.path.length);
    for (let i = 0; i < Math.min(path.length, target.path.length); i++) distance += Math.abs(path[i] - target.path[i]);
    return distance;
  };
  if (target.id) {
    const element = doc.getElementById(target.id);
    if (element?.localName === target.tag && root.contains(element)) return {element, similarity: target.quote ? similarity(drawingTargetQuote(doc, element), target.quote) : 1};
  }
  let best = null;
  for (const element of root.querySelectorAll(target.tag)) {
    if (element.closest('[data-htmlmemo-ui]')) continue;
    const text = drawingTargetQuote(doc, element);
    let score;
    if (!target.quote) score = !text && pathDistance(element) === 0 ? 1 : 0;
    else if (text === target.quote) score = 1;
    else if (!text || Math.abs(text.length - target.quote.length) > Math.max(text.length, target.quote.length) * .5) continue;
    else score = similarity(text, target.quote);
    if (score < ELEMENT_MATCH) continue;
    if (!best || score > best.similarity || (score === best.similarity && pathDistance(element) < best.distance)) best = {element, similarity: score, distance: pathDistance(element)};
  }
  return best && {element: best.element, similarity: best.similarity};
}
const INLINE = ['span','a','b','strong','em','i','small','mark','code','sub','sup','u','s','abbr','kbd'];
function blockOf(doc, node) {
  let element = node?.nodeType === 1 ? node : node?.parentElement;
  while (element && element !== doc.body && INLINE.includes(element.localName)) element = element.parentElement;
  return element || doc.body;
}
export function locateBookmarkText(text,mark,from=0,to=text.length) {
  const exact=findBookmarkText(text,mark,from,to);if(exact)return exact;
  const anchor=bookmarkTextAnchor(mark);if(!anchor||anchor.quote.length<24)return null;
  const hit=locateQuote(text,anchor,from,to);if(!hit||hit.similarity<.85)return null;
  const score=found=>found.similarity+found.context*.1;
  for(const [start,end] of [[from,hit.start],[hit.end,to]]){
    if(end-start<anchor.quote.length*.85)continue;
    const other=locateQuote(text,anchor,start,end);if(other&&score(other)>=score(hit)-.02)return {ambiguous:true};
  }
  const focus=anchor.quote.slice(mark.textPoint,mark.textPoint+24),pointHit=locateQuote(text,{quote:focus},hit.start,hit.end);
  const point=pointHit?.similarity===1?pointHit.start:hit.start+Math.min(hit.end-hit.start-1,Math.round(mark.textPoint*(hit.end-hit.start)/anchor.quote.length));
  return {...hit,point};
}

// ── Opening the new edition off-screen, with its own scripts (books render a section per hash).
export async function openEditionProbe(snapshot, {timeout = 60000} = {}) {
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-same-origin'); frame.setAttribute('aria-hidden', 'true'); frame.tabIndex = -1;
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1280px;height:900px;border:0;visibility:hidden;pointer-events:none';
  const source = snapshot.file || new Blob([String(snapshot.html || '')], {type:'text/html;charset=utf-8'});
  const url = URL.createObjectURL(new Blob(['<!doctype html><head><meta http-equiv="Content-Security-Policy" content="'+LOCAL_CSP+'">',source],{type:'text/html;charset=utf-8'}));
  let runtime;const dispose = () => { runtime?.dispose();frame.remove(); URL.revokeObjectURL(url); };
  const until = (test, message) => new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => { try { if (test()) return resolve(); } catch (error) { if (error?.section) return reject(error); } if (Date.now() - started > timeout) reject(new Error(message)); else setTimeout(check, 40); };
    check();
  });
  try {
    await new Promise((resolve, reject) => { frame.onload = resolve; frame.onerror = () => reject(new Error('새 판 문서를 열지 못했습니다.')); frame.src = url; document.body.append(frame); });
    const doc = frame.contentDocument;
    if (!doc?.body) throw new Error('새 판 문서를 열지 못했습니다.');
    if(snapshot.allowScripts!==false&&needsIsolatedRuntime(doc)){runtime=new IsolatedRuntime({host:document.body,doc,source});await runtime.start();}
    const book = bookManifest(doc), content = () => doc.getElementById('reader-content');
    const status = () => doc.getElementById('reader-status')?.textContent.trim() || '';
    const settled = key => content()?.dataset.section === key && !status();
    const failed = book?.labels?.failed;
    if (book) await until(() => doc.documentElement.dataset.readerReady === 'true', '새 판 책의 본문을 준비하지 못했습니다.');
    return {doc, dispose, async show(key) {
      if (!book || !key || settled(key)) return;
      frame.contentWindow.location.hash = '#' + encodeURIComponent(key);
      const title = book.volumes.flatMap(v => v.sections).find(s => s.key === key)?.title || key;
      await until(() => { if (failed && status() === failed) throw Object.assign(new Error(`새 판의 「${title}」 장을 열지 못했습니다.`), {section: key}); return settled(key); },
        `새 판의 「${title}」 장을 열지 못했습니다.`);
    }};
  } catch (error) { dispose(); throw error; }
}

// ── The move itself. `probe` is the opened new edition: {doc, show(sectionKey)}.
export async function migrateAnnotations({annotations = [], bookmarks = [], oldDoc = null, probe, onProgress = () => {}}) {
  const oldBook = bookManifest(oldDoc), newBook = bookManifest(probe.doc);
  const oldSections = new Map((oldBook?.volumes || []).flatMap(v => v.sections.map(s => [s.key, {...s, book: v.book}])));
  const newSections = (newBook?.volumes || []).flatMap(v => v.sections.map(s => ({...s, book: v.book})));
  const newKeys = new Set(newSections.map(s => s.key));
  const mapKey = key => {
    if (!key) return '';
    const old = oldSections.get(key);
    if (!old) return newKeys.has(key) ? key : '';
    const sameBook=newSections.find(s => s.book === old.book && s.id === old.id);
    const sameId=newSections.filter(s => s.id === old.id);
    return (sameBook || (sameId.length===1 ? sameId[0] : null))?.key || '';
  };
  const placed = new Map(), failedSections = new Map(), work = [
    ...annotations.map(annotation => ({annotation, tried: new Set(),text: annotation.textAnchor || null, target: annotation.anchorTarget || null})),
    ...bookmarks.map(annotation => ({annotation,bookmark:true,tried:new Set(),text:bookmarkTextAnchor(annotation),target:bookmarkAnchorTarget(annotation)}))];
  let index = null, range = [0, 0], current = null;
  const view = async key => {
    if (current === key && index) return;
    await probe.show(key);
    const root = (key && probe.doc.getElementById('reader-content')) || probe.doc.body;
    index = textIndex(probe.doc); current = key;
    const inside = index.nodes.filter(n => root.contains(n.node));
    range = inside.length ? [inside[0].start, inside.at(-1).end] : [0, 0];
    return root;
  };
  const place = (item, key, approximate=false) => {
    const {annotation} = item, doc = probe.doc, root = (key && doc.getElementById('reader-content')) || doc.body;
    if(item.bookmark){
      const textHit=item.text&&!approximate?locateBookmarkText(index.text,annotation,range[0],range[1]):null;
      if(item.text&&!approximate&&(!textHit||textHit.ambiguous))return false;
      let hit=textHit?{element:blockOf(doc,index.nodes.find(n=>n.start<=textHit.point&&n.end>textHit.point)?.node),similarity:textHit.similarity}:item.target&&!approximate?locateElement(doc,root,item.target):null;
      // Reused element IDs alone cannot prove that a bookmark's text survived.
      if(hit?.similarity<ELEMENT_MATCH)hit=null;
      if(!hit&&!approximate&&item.target){
        const quoteHit=locateQuote(index.text,{quote:item.target.quote},range[0],range[1]);
        const element=quoteHit&&blockOf(doc,index.nodes.find(n=>n.start<=quoteHit.start&&n.end>quoteHit.start)?.node);
        if(element&&element!==doc.body)hit={element,similarity:quoteHit.similarity};
      }
      if(!hit&&!approximate)return false;
      const next=structuredClone(annotation);delete next.heading;delete next.anchorTarget;delete next.anchorOffset;delete next.textAnchor;delete next.textPoint;delete next.textOffsetY;delete next.locationVersion;
      if(key)next.section=key;else delete next.section;
      next.top=0;next.left=0;next.editionPosition=approximate?'section':'text';
      if(textHit){
        const nodes=index.nodes.filter(n=>hit.element.contains(n.node));
        Object.assign(next,bookmarkTextLocation(index,textHit.point,key||'',annotation.textOffsetY,{from:nodes[0]?.start??range[0],to:nodes.at(-1)?.end??range[1]}));
      }
      if(hit){next.anchorTarget=describeDrawingTarget(doc,hit.element);if(!bookmarkAnchorTarget(next)){delete next.anchorTarget;if(!textHit)return false;}next.anchorOffset=Number.isFinite(annotation.anchorOffset)?Math.max(0,Math.min(1,annotation.anchorOffset)):0;}
      placed.set(item,{annotation:next,status:approximate?'approximate':hit.similarity===1?'same':'changed',section:key});return true;
    }
    const textHit = item.text ? locateQuote(index.text, item.text, range[0], range[1]) : null;
    let element = null, elementScore = 1;
    if (!TEXT_TOOLS.includes(annotation.type)) {
      const hit = item.target ? locateElement(doc, root, item.target) : null;
      if (hit) { element = hit.element; elementScore = hit.similarity; }
      else if (textHit) element = blockOf(doc, rangeFromOffsets(doc, textHit.start, textHit.end, index)?.startContainer);
      if (!element || element === doc.body) return false;
    } else if (!textHit) return false;
    const next = structuredClone(annotation);
    if (textHit) next.textAnchor = {start: textHit.start, end: textHit.end, quote: index.text.slice(textHit.start, textHit.end),
      prefix: index.text.slice(Math.max(0, textHit.start - CONTEXT), textHit.start), suffix: index.text.slice(textHit.end, textHit.end + CONTEXT), ...(key ? {section: key} : {})};
    else delete next.textAnchor;
    if (element) { next.anchor = 'body'; next.anchorTarget = describeDrawingTarget(doc, element); }
    const same = (!item.text || textHit?.similarity === 1) && elementScore === 1;
    placed.set(item, {annotation: next, status: same ? 'same' : 'changed', section: key});
    return true;
  };
  const movable = work.filter(item => item.text || item.target || item.bookmark&&mapKey(item.annotation.section));
  if (!newBook) {
    onProgress(0, 1); await view(null);
    for (const item of movable) place(item, null);
    onProgress(1, 1);
  } else {
    // First the section each annotation came from (sections keep their ids across editions), then
    // the sections whose text contains it — for moved sections and for annotations made before
    // HTMLMemo recorded sections.
    const order = new Map(newSections.map((s, i) => [s.key, i]));
    const run = async (plan, label, approximate=false) => {
      const keys = [...plan.keys()].sort((a, b) => order.get(a) - order.get(b));
      for (const [i, key] of keys.entries()) {
        onProgress(i, keys.length, label);
        if(failedSections.has(key)){for(const item of plan.get(key))item.unchecked=true;continue;}
        try { await view(key); } catch (error) {
          // One section that will not render must not stop the move. Its annotations are reported
          // as unchecked instead of deleted.
          failedSections.set(key, error?.message || String(error)); index = null; current = null;
          for (const item of plan.get(key)) item.unchecked = true;
          continue;
        }
        for (const item of plan.get(key)) if (!placed.has(item)) { item.tried.add(key); place(item, key,approximate); }
      }
    };
    const first = new Map();
    for (const item of movable) {
      const key = mapKey(item.bookmark?item.annotation.section:item.text?.section || item.target?.section || '');
      if (key) first.set(key, [...(first.get(key) || []), item]);
    }
    await run(first, 'section');
    const rest = movable.filter(item => !placed.has(item)&&(item.text?.quote||item.target?.quote));
    if (rest.length) {
      const bodies = [];
      for (const [volume, entry] of newBook.volumes.entries()) {
        const texts = await bookSectionTexts(probe.doc, volume) || [];
        entry.sections.forEach((section, i) => bodies.push({key: section.key, text: plain(texts[i] || '') + ' ' + plain(section.title)}));
      }
      const second = new Map();
      for (const item of rest) {
        const quote = plain(item.text?.quote || item.target?.quote || '');
        if (!quote) continue;
        const pieces = quote.length <= 24 ? [quote] : [...new Set([quote.slice(0, 16), quote.slice((quote.length >> 1) - 8, (quote.length >> 1) + 8), quote.slice(-16)])];
        const ranked = bodies.map(body => ({key: body.key, hits: pieces.filter(piece => body.text.includes(piece)).length}))
          .filter(entry => entry.hits && !item.tried.has(entry.key)).sort((a, b) => b.hits - a.hits).slice(0, 3);
        for (const {key} of ranked) second.set(key, [...(second.get(key) || []), item]);
      }
      await run(second, 'search');
    }
    // Coordinate-only bookmarks, or bookmarks whose paragraph disappeared, still identify
    // a chapter. Keep that useful location, explicitly marked as approximate, never old pixels.
    const fallback=new Map();
    for(const item of work.filter(item=>item.bookmark&&!placed.has(item))){
      const key=mapKey(item.annotation.section);if(key)fallback.set(key,[...(fallback.get(key)||[]),item]);
    }
    await run(fallback,'section',true);
  }
  const emptyReport=()=>({same:0,changed:0,deleted:[],unplaceable:[],unchecked:[],failedSections:[...failedSections.values()]});
  const report=emptyReport(),bookmarkReport={...emptyReport(),approximate:0};
  const moved = [],movedBookmarks=[];
  for (const item of work) {
    const result=placed.get(item),counts=item.bookmark?bookmarkReport:report;
    if (result) { (item.bookmark?movedBookmarks:moved).push(result.annotation); counts[result.status]++; }
    else if (item.unchecked) counts.unchecked.push(item.annotation);
    else if (item.text || item.target || item.bookmark&&item.annotation.section) counts.deleted.push(item.annotation);
    else counts.unplaceable.push(item.annotation);
  }
  return {annotations:moved,bookmarks:movedBookmarks,report,bookmarkReport,oldSections};
}
