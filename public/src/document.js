import { FORMAT_VERSION, validateAnnotations } from './model.js';

export const LAYER_ID = 'htmlmemo-annotation-layer';
export const DATA_ID = 'htmlmemo-data';
export const LOCAL_CSP = "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline' data:; font-src data:; media-src data:; script-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'";
export const SCRIPT_CSP = "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline' data:; font-src data:; media-src data: blob:; script-src 'unsafe-inline' 'unsafe-eval' data: blob: https: http:; worker-src data: blob:; connect-src data: blob:; form-action 'none'; base-uri 'none'";
export function cleanAnnotations(doc) {
  doc.getElementById(LAYER_ID)?.remove();
  doc.getElementById(DATA_ID)?.remove();
  doc.getElementById('htmlmemo-annotation-style')?.remove();
  let unwrapped = false;
  for (const selector of ['[data-htmlmemo-mark]', '[data-htmlmemo-search]']) {
    for (const mark of [...doc.querySelectorAll(selector)].reverse()) { mark.replaceWith(...mark.childNodes); unwrapped = true; }
  }
  // Normalization walks the entire tree. It is needed only after unwrapping
  // marks, not when opening an unannotated book containing millions of nodes.
  if (unwrapped) doc.body?.normalize();
}
function* sanitizeTree(root, source, depth = 0, allowScripts = false) {
  for (const element of root.querySelectorAll('*')) {
    yield;
    const tag = element.localName;
    if ((!allowScripts && tag === 'script') || ['object','embed','frame','frameset','base'].includes(tag)) { element.remove(); continue; }
    if (tag === 'iframe') {
      const html=element.getAttribute('srcdoc');
      if(!html||depth>=3){element.remove();continue;}
      const nested=new DOMParser().parseFromString(html,'text/html');yield* sanitizeTree(nested,source,depth+1,allowScripts);
      element.setAttribute('srcdoc',nested.documentElement.outerHTML);element.setAttribute('sandbox',allowScripts?'allow-scripts':'');element.removeAttribute('src');element.removeAttribute('allow');
    }
    if (tag === 'meta' && /^(refresh|content-security-policy)$/i.test(element.getAttribute('http-equiv') || '')) { element.remove(); continue; }
    for (const attr of [...element.attributes]) {
      if (!allowScripts && /^on/i.test(attr.name) || ['autofocus','ping','formaction'].includes(attr.name) || attr.name==='srcdoc'&&tag!=='iframe') element.removeAttribute(attr.name);
      if (['href','src','xlink:href','action'].includes(attr.name)) {
        const value = attr.value.trim().replace(/[\u0000-\u0020]/g, '');
        if ((!allowScripts && /^javascript:/i.test(value) || /^vbscript:/i.test(value)) || /^(?:data:text\/html|data:image\/svg\+xml)/i.test(value) && !['img','image'].includes(tag)) element.removeAttribute(attr.name);
        else if (tag === 'a' && attr.name === 'href' && !value.startsWith('#') && source && !(allowScripts && /^javascript:/i.test(value))) {
          try { const resolved = new URL(attr.value, source); if (['http:','https:','mailto:','tel:'].includes(resolved.protocol)) element.setAttribute('href', resolved.href); else element.removeAttribute('href'); } catch { element.removeAttribute('href'); }
        }
      }
    }
    element.removeAttribute('contenteditable');
    if (tag === 'form') { element.removeAttribute('action'); element.setAttribute('inert', ''); }
    if (tag === 'template') yield* sanitizeTree(element.content, source, depth,allowScripts);
  }
}
export function parseHTML(html, defaults = {}, options = {}) {
  const work = prepareHTML(html, defaults, options);
  let step; do { step = work.next(); } while (!step.done);
  return step.value;
}
export async function prepareLoadedHTML(doc, defaults = {}, isCancelled = () => false) {
  const work = prepareHTML(null, defaults, {document:doc,includeMetadata:true,allowScripts:defaults.execution?.allowScripts===true});
  try {
    for (;;) {
      if (isCancelled()) throw new DOMException('문서 열기가 취소되었습니다.','AbortError');
      const start = performance.now();
      for (let count=0;count<1000;count++) {
        const step=work.next();if(step.done)return step.value;
        if(performance.now()-start>=8)break;
      }
      // Yield between bounded batches so the native document can paint/scroll.
      await new Promise(resolve=>setTimeout(resolve,0));
    }
  } finally { work.return(); }
}
function* prepareHTML(html, defaults, {includeMetadata = false, document: loadedDocument = null, allowScripts = undefined} = {}) {
  if (!loadedDocument && (typeof html !== 'string' || !html.trim())) throw new Error('HTML 파일이 비어 있습니다.');
  const doc = loadedDocument || new DOMParser().parseFromString(html, 'text/html');
  let embedded = {};
  const data = doc.getElementById(DATA_ID);
  if (data) {
    try { embedded = JSON.parse(data.textContent); } catch { throw new Error('HTMLMemo 주석 데이터가 손상되었습니다. 원본 파일을 확인해주세요.'); }
    if (embedded.version !== FORMAT_VERSION) throw new Error('이 파일의 HTMLMemo 버전을 지원하지 않습니다.');
    embedded.annotations = validateAnnotations(embedded.annotations);
  }
  let source = embedded.source || defaults.source || '';
  try { const url=new URL(source); source=['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.href:''; } catch { source=''; }
  allowScripts = (allowScripts ?? defaults.execution?.allowScripts ?? embedded.execution?.allowScripts ?? false) === true;
  cleanAnnotations(doc);
  yield* sanitizeTree(doc, source,0,allowScripts);
  for(const meta of doc.head.querySelectorAll('meta[charset],meta[http-equiv]'))if(meta.hasAttribute('charset')||/^content-type$/i.test(meta.getAttribute('http-equiv')))meta.remove();
  const charset=doc.createElement('meta');charset.setAttribute('charset','utf-8');doc.head.prepend(charset);
  const csp = doc.createElement('meta'); csp.httpEquiv = 'Content-Security-Policy';
  csp.content = allowScripts ? SCRIPT_CSP : LOCAL_CSP;
  doc.head.prepend(csp);
  let n = 0;
  doc.body.setAttribute('data-htmlmemo-anchor', 'body');
  for (const element of doc.body.querySelectorAll('*')) {
    yield;
    if (!['style','meta','link','template'].includes(element.localName)) element.setAttribute('data-htmlmemo-anchor', 'n' + n++);
  }
  const viewport = embedded.viewport || defaults.viewport || {width: 1100, height: 800};
  const view=embedded.view||{};
  const bookmarks=Array.isArray(embedded.bookmarks)?embedded.bookmarks.filter(b=>b&&typeof b.id==='string'&&typeof b.title==='string'&&Number.isFinite(b.top)&&Number.isFinite(b.left)).slice(0,10000):[];
  const metadata = {
    version: FORMAT_VERSION, title: String(embedded.title || doc.title || defaults.title || 'HTML 문서').slice(0,1000),
    source, capturedAt: embedded.capturedAt || Date.now(), viewport: {width: Math.min(4096, Math.max(320, Number(viewport.width) || 1100)), height: Number(viewport.height) || 800},
    execution:{allowScripts:!!allowScripts}, annotations: embedded.annotations || [], view: {scrollTop:Math.max(0,Number(view.scrollTop)||0),scrollLeft:Math.max(0,Number(view.scrollLeft)||0),zoom:Number.isFinite(view.zoom)?Math.min(8,Math.max(.2,view.zoom)):null}, bookmarks,
    warnings: (Array.isArray(embedded.warnings) ? embedded.warnings : defaults.warnings || []).filter(w=>typeof w==='string').slice(0,5000),
  };
  const nativeScroll = !!allowScripts || !!loadedDocument || html.length >= 4 * 1024 * 1024 || n >= 20000;
  // Only the older full-height iframe needs viewport units frozen. A native
  // scrolling iframe must retain the file's own responsive layout.
  if (!nativeScroll) {
    const freezeCSS=css=>css.replace(/(?<![\w.-])(-?\d*\.?\d+)(dvh|svh|lvh|vh)\b/g,(_,amount)=>`${Number(amount)*metadata.viewport.height/100}px`);
    for(const style of doc.querySelectorAll('style')){yield;style.textContent=freezeCSS(style.textContent);}
    for(const element of doc.querySelectorAll('[style]')){yield;element.setAttribute('style',freezeCSS(element.getAttribute('style')));}
  }
  if (includeMetadata) doc.head.append(metadataElement(doc, metadata));
  return {html: '<!doctype html>\n' + doc.documentElement.outerHTML, metadata,
    nativeScroll};
}
function metadataElement(doc, metadata) {
  const script = doc.createElement('script'); script.id = DATA_ID; script.type = 'application/json';
  script.textContent = JSON.stringify({...metadata, version: FORMAT_VERSION, modifiedAt: Date.now()}).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return script;
}
export function serializeHTML(doc, metadata) {
  const clone = doc.documentElement.cloneNode(true);
  clone.querySelector('#' + DATA_ID)?.remove();
  for (const mark of [...clone.querySelectorAll('[data-htmlmemo-search]')].reverse()) mark.replaceWith(...mark.childNodes);
  clone.querySelectorAll('[data-htmlmemo-preview], [data-htmlmemo-selected]').forEach(element => element.remove());
  clone.querySelectorAll('#htmlmemo-toc-toggle-style, [data-htmlmemo-toc-toggle]').forEach(element => element.remove());
  clone.querySelectorAll('[data-htmlmemo-toc-collapsed]').forEach(element => element.removeAttribute('data-htmlmemo-toc-collapsed'));
  // Interactive editor-only styles should never change the standalone file.
  clone.querySelector('#htmlmemo-editor-style')?.remove();
  clone.querySelector('head').append(metadataElement(doc, metadata));
  return '<!doctype html>\n' + clone.outerHTML;
}
export function textIndex(doc) {
  const nodes = []; let text = '';
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.textContent || node.parentElement?.closest('script,style,noscript,svg,textarea,template,[data-htmlmemo-ui]')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  while (walker.nextNode()) { const node = walker.currentNode; nodes.push({node, start: text.length, end: text.length + node.textContent.length}); text += node.textContent; }
  return {nodes, text};
}
export function rangeFromOffsets(doc, start, end, index = textIndex(doc)) {
  const first = index.nodes.find(n => n.end > start); const last = [...index.nodes].reverse().find(n => n.start < end);
  if (!first || !last || start < 0 || end > index.text.length || end <= start) return null;
  const range = doc.createRange(); range.setStart(first.node, start - first.start); range.setEnd(last.node, end - last.start); return range;
}
export function selectionAnchor(doc, range) {
  const index = textIndex(doc); let start; let end;
  // Compare boundary points instead of Range.toString: CSS-hidden and excluded
  // nodes must use the same indexing policy as later annotation restoration.
  for (const n of index.nodes) {
    if (!range.intersectsNode(n.node)) continue;
    const from = range.startContainer === n.node ? range.startOffset : 0;
    const to = range.endContainer === n.node ? range.endOffset : n.node.length;
    if (to > from) { if (start === undefined) start = n.start + from; end = n.start + to; }
  }
  if (start === undefined || end <= start) return null;
  return {start, end, quote: index.text.slice(start, end), prefix: index.text.slice(Math.max(0, start - 40), start), suffix: index.text.slice(end, end + 40)};
}
export function resolveTextAnchor(index, anchor) {
  if (index.text.slice(anchor.start, anchor.end) === anchor.quote) return {start: anchor.start, end: anchor.end};
  let found = index.text.indexOf(anchor.quote);
  while (found !== -1) {
    if ((!anchor.prefix || index.text.slice(Math.max(0, found - anchor.prefix.length), found) === anchor.prefix) && (!anchor.suffix || index.text.slice(found + anchor.quote.length, found + anchor.quote.length + anchor.suffix.length) === anchor.suffix)) return {start: found, end: found + anchor.quote.length};
    found = index.text.indexOf(anchor.quote, found + 1);
  }
  return null;
}
export function wrapOffsets(doc, start, end, attributes, style = '') {
  const {nodes} = textIndex(doc);
  for (const item of nodes.filter(n => n.end > start && n.start < end).reverse()) {
    const from = Math.max(0, start - item.start); const to = Math.min(item.node.length, end - item.start);
    if (to < item.node.length) item.node.splitText(to);
    const selected = from > 0 ? item.node.splitText(from) : item.node;
    const mark = doc.createElement('span'); for (const [name, value] of Object.entries(attributes)) mark.setAttribute(name, value);
    mark.style.cssText = style; selected.replaceWith(mark); mark.append(selected);
  }
}
