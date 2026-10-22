import { FORMAT_VERSION, validateAnnotations } from './model.js';

export const LAYER_ID = 'htmlmemo-annotation-layer';
export const DATA_ID = 'htmlmemo-data';
export const LOCAL_CSP = "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline' data:; font-src data:; media-src data:; script-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'";
export const SCRIPT_CSP = "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline' data:; font-src data:; media-src data: blob:; script-src 'unsafe-inline' 'unsafe-eval' data: blob: https: http:; worker-src data: blob:; connect-src data: blob:; form-action 'none'; base-uri 'none'";
export const BOOK_DATA_MISSING = '이 파일에는 책의 목차 제목만 남아 있고 본문 데이터 또는 실행 코드가 빠져 있습니다. 완전한 원본 HTML 파일을 가져와 주세요. 기존 문서와 주석은 보관함에 유지됩니다.';
export function inspectBookDocument(doc) {
  const data = doc.getElementById('book-manifest');
  let manifest;
  try { manifest = JSON.parse(data?.textContent || 'null'); } catch { /* Report damaged book data below. */ }
  if (manifest?.format !== 'memosuite-book-html-v1' && !(doc.getElementById('reader-tree') && doc.getElementById('reader-content'))) return null;
  const executable = [...doc.querySelectorAll('script')].some(script =>
    (!script.type || /^(?:module|(?:text|application)\/javascript)$/i.test(script.type)) &&
    (script.getAttribute('src') || script.textContent.trim()));
  const complete = manifest?.format === 'memosuite-book-html-v1' &&
    Array.isArray(manifest.volumes) && manifest.volumes.length > 0 &&
    manifest.volumes.every((volume, index) => Array.isArray(volume?.sections) && volume.sections.length > 0 &&
      doc.getElementById('book-volume-' + index)?.textContent.trim()) && executable;
  return {complete: !!complete, message: complete ? '' : BOOK_DATA_MISSING};
}

// A live book DOM contains only the current section, and its renderer releases
// image payloads after decoding them. Export the immutable source bytes instead.
// Only the small head is read; the book's compressed bodies/images stay Blobs.
export async function serializeBookSource(source, metadata) {
  if (!(source instanceof Blob)) throw new Error('보관한 책 원본을 찾지 못했습니다.');
  const decoder = new TextDecoder('utf-8', {ignoreBOM:true});
  let header = '', read = 0, end = -1;
  while (read < source.size && end < 0) {
    const next = Math.min(source.size, read + 65536);
    header += decoder.decode(await source.slice(read, next).arrayBuffer(), {stream: next < source.size});
    read = next;
    end = header.search(/<\/head\s*>|<body\b/i);
    if (end < 0 && read >= 16 * 1024 * 1024) throw new Error('책 원본의 HTML 헤더를 읽지 못했습니다. 완전한 원본 파일을 가져와 주세요.');
  }
  if (end < 0) throw new Error('책 원본의 HTML 헤더가 손상되었습니다. 완전한 원본 파일을 가져와 주세요.');
  const encoder = new TextEncoder(), parts = [];
  let offset = 0;
  const head = header.slice(0, end);
  // HTMLMemo metadata is always an inert JSON script in the head. Keep every
  // other source byte, including nonce attributes, styles and book payloads.
  for (const match of head.matchAll(/<script\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>[\s\S]*?<\/script\s*>/gi)) {
    const tag = new DOMParser().parseFromString('<html><head>' + match[0] + '</head><body></body></html>', 'text/html').querySelector('script');
    if (tag?.id !== DATA_ID) continue;
    const start = encoder.encode(head.slice(0, match.index)).length;
    const finish = start + encoder.encode(match[0]).length;
    parts.push(source.slice(offset, start)); offset = finish;
  }
  const boundary = encoder.encode(head).length;
  parts.push(source.slice(offset, boundary));
  const doc = new DOMParser().parseFromString('<html><head></head><body></body></html>', 'text/html');
  parts.push(metadataElement(doc, metadata).outerHTML, source.slice(boundary));
  return new Blob(parts, {type:'text/html;charset=utf-8'});
}
export function cleanAnnotations(doc) {
  doc.getElementById(LAYER_ID)?.remove();
  doc.getElementById(DATA_ID)?.remove();
  doc.getElementById('htmlmemo-annotation-style')?.remove();
  // Older HTMLMemo builds temporarily added a control and a collapsed-state
  // attribute to the document's own table of contents.  Those editor-only
  // artifacts must never hide the source document's sidebar after reopening.
  doc.getElementById('htmlmemo-toc-toggle-style')?.remove();
  doc.querySelectorAll('[data-htmlmemo-toc-toggle]').forEach(element => element.remove());
  doc.querySelectorAll('[data-htmlmemo-toc-collapsed]').forEach(element => element.removeAttribute('data-htmlmemo-toc-collapsed'));
  let unwrapped = false;
  for (const selector of ['[data-htmlmemo-mark]', '[data-htmlmemo-search]']) {
    for (const mark of [...doc.querySelectorAll(selector)].reverse()) { mark.replaceWith(...mark.childNodes); unwrapped = true; }
  }
  // Normalization walks the entire tree. It is needed only after unwrapping
  // marks, not when opening an unannotated book containing millions of nodes.
  if (unwrapped) doc.body?.normalize();
}
function clearReaderSidebarArtifacts(root) {
  // Several short-lived reader builds added controls and layout overrides to
  // the source document itself.  Clear only those namespaced artifacts when
  // opening or exporting a file, leaving the document's real TOC untouched.
  root.querySelector?.('#htmlmemo-toc-toggle-style')?.remove();
  root.querySelector?.('#htmlmemo-sidebar-style')?.remove();
  root.querySelector?.('#htmlmemo-toc-resize-style')?.remove();
  root.querySelector?.('#htmlmemo-doc-sidebar-style')?.remove();
  // Restore relocated native search controls before removing the editor panel.
  for(const part of root.querySelectorAll?.('[data-htmlmemo-book-search-part]')||[]){
    const key=part.getAttribute('data-htmlmemo-book-search-part'),slot=[...root.querySelectorAll('[data-htmlmemo-book-search-slot]')].find(node=>node.getAttribute('data-htmlmemo-book-search-slot')===key);
    if(slot)slot.replaceWith(part);else part.closest('[data-htmlmemo-native-sidebar]')?.append(part);
    part.removeAttribute('data-htmlmemo-book-search-part');
  }
  for(const slot of root.querySelectorAll?.('[data-htmlmemo-book-search-slot]')||[])slot.remove();
  for(const panel of root.querySelectorAll?.('[data-htmlmemo-doc-sidebar-ui]')||[])panel.remove();
  for(const title of root.querySelectorAll?.('[data-htmlmemo-redundant-toc-title]')||[])title.removeAttribute('data-htmlmemo-redundant-toc-title');
  for(const sidebar of root.querySelectorAll?.('[data-htmlmemo-native-sidebar],[data-htmlmemo-sidebar-view]')||[]){sidebar.removeAttribute('data-htmlmemo-native-sidebar');sidebar.removeAttribute('data-htmlmemo-sidebar-view');}
  for (const element of root.querySelectorAll?.('[data-htmlmemo-toc-toggle],[data-htmlmemo-toc-resizer]') || []) element.remove();
  const nodes = [root, ...(root.querySelectorAll?.('[data-htmlmemo-toc-active],[data-htmlmemo-toc-main],[data-htmlmemo-toc-collapsed],[data-htmlmemo-sidebar-folded],[data-htmlmemo-sidebar-grid],[data-htmlmemo-sidebar-grid-item],[data-htmlmemo-sidebar-flex],[data-htmlmemo-toc-sidebar],[data-htmlmemo-toc-item],[data-htmlmemo-toc-strip],[data-htmlmemo-toc-item-strip],[data-htmlmemo-toc-resizer-bound],[data-htmlmemo-toc-resizer-bound-left],[data-htmlmemo-toc-resizing],[data-htmlmemo-topbar-active],[data-htmlmemo-doc-topbar],[data-htmlmemo-doc-topbar-item],[data-htmlmemo-topbar-grid],[data-htmlmemo-topbar-pad],[data-htmlmemo-topbar-offset],[data-htmlmemo-scroll-host],[style*="--htmlmemo-toc-grid-columns"],[style*="--htmlmemo-toc-width"],[style*="--htmlmemo-topbar-grid-rows"]') || [])];
  for (const element of nodes) {
    if (!element?.removeAttribute) continue;
    if (element.hasAttribute?.('data-htmlmemo-toc-resizer-bound-left')) {
      const prevLeft = element.getAttribute('data-htmlmemo-toc-resizer-bound-left');
      if (prevLeft) element.style?.setProperty('left', prevLeft);
      else element.style?.removeProperty('left');
    }
    for (const attr of ['data-htmlmemo-toc-active','data-htmlmemo-toc-main','data-htmlmemo-toc-collapsed','data-htmlmemo-sidebar-folded','data-htmlmemo-sidebar-grid','data-htmlmemo-sidebar-grid-item','data-htmlmemo-sidebar-flex','data-htmlmemo-toc-sidebar','data-htmlmemo-toc-item','data-htmlmemo-toc-strip','data-htmlmemo-toc-item-strip','data-htmlmemo-toc-resizer-bound','data-htmlmemo-toc-resizer-bound-left','data-htmlmemo-toc-resizing','data-htmlmemo-topbar-active','data-htmlmemo-doc-topbar','data-htmlmemo-doc-topbar-item','data-htmlmemo-topbar-grid','data-htmlmemo-topbar-pad','data-htmlmemo-topbar-offset','data-htmlmemo-scroll-host']) element.removeAttribute(attr);
    const inline = element.getAttribute('style') || '';
    if (/--htmlmemo-(?:toc-(?:grid-columns|width)|topbar-grid-rows)\s*:/i.test(inline)) {
      element.style?.removeProperty('--htmlmemo-toc-grid-columns');
      element.style?.removeProperty('--htmlmemo-toc-width');
      element.style?.removeProperty('--htmlmemo-topbar-grid-rows');
    }
    if (element.hasAttribute?.('style') && !element.getAttribute('style')?.trim()) element.removeAttribute('style');
  }
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
    if (tag === 'form') { element.removeAttribute('action'); if (!allowScripts) element.setAttribute('inert', ''); }
    if (tag === 'template') yield* sanitizeTree(element.content, source, depth,allowScripts);
  }
}
export function parseHTML(html, defaults = {}, options = {}) {
  const work = prepareHTML(html, defaults, options);
  let step; do { step = work.next(); } while (!step.done);
  return step.value;
}
export async function prepareLoadedHTML(doc, defaults = {}, isCancelled = () => false, {serialize = true} = {}) {
  const work = prepareHTML(null, defaults, {document:doc,includeMetadata:true,allowScripts:defaults.execution?.allowScripts,serialize});
  try {
    for (;;) {
      if (isCancelled()) throw new DOMException('문서 열기가 취소되었습니다.','AbortError');
      const start = performance.now();
      for (let count=0;count<4000;count++) {
        const step=work.next();if(step.done)return step.value;
        if((count&255)===255&&performance.now()-start>=8)break;
      }
      // Yield between bounded batches so the app stays responsive while opening.
      await new Promise(resolve=>setTimeout(resolve,0));
    }
  } finally { work.return(); }
}
function* prepareHTML(html, defaults, {includeMetadata = false, document: loadedDocument = null, allowScripts = undefined, serialize = true} = {}) {
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
  const book = inspectBookDocument(doc);
  if (book?.complete && !allowScripts) throw new Error('이 책은 화면 캡처로 보관하면 본문과 목차가 사라집니다. 완전한 원본 HTML 파일을 가져와 주세요.');
  clearReaderSidebarArtifacts(doc);
  cleanAnnotations(doc);
  yield* sanitizeTree(doc, source,0,allowScripts);
  for(const meta of doc.head.querySelectorAll('meta[charset],meta[http-equiv]'))if(meta.hasAttribute('charset')||/^content-type$/i.test(meta.getAttribute('http-equiv')))meta.remove();
  const charset=doc.createElement('meta');charset.setAttribute('charset','utf-8');doc.head.prepend(charset);
  const csp = doc.createElement('meta'); csp.httpEquiv = 'Content-Security-Policy';
  csp.content = allowScripts ? SCRIPT_CSP : LOCAL_CSP;
  doc.head.prepend(csp);
  let n = 0;
  doc.body.setAttribute('data-htmlmemo-anchor', 'body');
  // Exported files can already contain targets created by the document's
  // scripts. Renumbering them disconnects their saved relative coordinates.
  const reservedAnchors = new Set();
  for (const element of doc.body.querySelectorAll('[data-htmlmemo-anchor]')) {
    yield;
    const key = element.getAttribute('data-htmlmemo-anchor');
    if (/^(?:n|js)\d+$/.test(key)) reservedAnchors.add(key);
  }
  const assignedAnchors = new Set(['body']);
  for (const element of doc.body.querySelectorAll('*')) {
    yield;
    if (['style','meta','link','template'].includes(element.localName)) continue;
    const key = element.getAttribute('data-htmlmemo-anchor');
    if (reservedAnchors.has(key) && !assignedAnchors.has(key)) assignedAnchors.add(key);
    else {
      while (reservedAnchors.has('n' + n)) n++;
      const next = 'n' + n++;
      element.setAttribute('data-htmlmemo-anchor', next);assignedAnchors.add(next);
    }
  }
  const viewport = embedded.viewport || defaults.viewport || {width: 1100, height: 800};
  const view=embedded.view||{};
  const bookmarks=Array.isArray(embedded.bookmarks)?embedded.bookmarks.filter(b=>b&&typeof b.id==='string'&&typeof b.title==='string'&&Number.isFinite(b.top)&&Number.isFinite(b.left)).slice(0,10000):[];
  const metadata = {
    version: FORMAT_VERSION, title: String(embedded.title || doc.title || defaults.title || 'HTML 문서').slice(0,1000),
    source, capturedAt: embedded.capturedAt || Date.now(), viewport: {width: Math.min(4096, Math.max(320, Number(viewport.width) || 1100)), height: Number(viewport.height) || 800},
    execution:{allowScripts:!!allowScripts}, annotations: embedded.annotations || [], view: {scrollTop:Math.max(0,Number(view.scrollTop)||0),scrollLeft:Math.max(0,Number(view.scrollLeft)||0),zoom:Number.isFinite(view.zoom)?Math.min(8,Math.max(.2,view.zoom)):null,autoFit:view.autoFit==null?!Number.isFinite(view.zoom):view.autoFit!==false,...(Number.isFinite(view.tocWidth)?{tocWidth:Math.min(640,Math.max(8,Math.round(Number(view.tocWidth))))}:{})}, bookmarks,
    warnings: [...new Set([...(Array.isArray(embedded.warnings) ? embedded.warnings : defaults.warnings || []), ...(book && !book.complete ? [BOOK_DATA_MISSING] : [])])].filter(w=>typeof w==='string').slice(0,5000),
  };
  const nativeScroll = !!allowScripts || !!loadedDocument || html.length >= 4 * 1024 * 1024 || n >= 20000;
  // Native-scrolling local documents retain their own viewport rules. This is
  // required for document-owned sticky navigation and sidebars to keep the
  // same layout they have when opened directly in Chrome.
  if (!nativeScroll) {
    const freezeCSS=css=>css.replace(/(?<![\w.-])(-?\d*\.?\d+)(dvh|svh|lvh|vh)\b/g,(_,amount)=>`${Number(amount)*metadata.viewport.height/100}px`);
    for(const style of doc.querySelectorAll('style')){yield;style.textContent=freezeCSS(style.textContent);}
    for(const element of doc.querySelectorAll('[style]')){yield;element.setAttribute('style',freezeCSS(element.getAttribute('style')));}
  }
  if (includeMetadata) doc.head.append(metadataElement(doc, metadata));
  return {html: serialize ? '<!doctype html>\n' + doc.documentElement.outerHTML : null, metadata,
    nativeScroll};
}
function metadataElement(doc, metadata) {
  const script = doc.createElement('script'); script.id = DATA_ID; script.type = 'application/json';
  script.textContent = JSON.stringify({...metadata, version: FORMAT_VERSION, modifiedAt: Date.now()}).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return script;
}
export function serializeHTML(doc, metadata) {
  const book = inspectBookDocument(doc);
  if (book && !book.complete) throw new Error(BOOK_DATA_MISSING);
  const clone = doc.documentElement.cloneNode(true);
  clone.querySelector('#' + DATA_ID)?.remove();
  for (const mark of [...clone.querySelectorAll('[data-htmlmemo-search]')].reverse()) mark.replaceWith(...mark.childNodes);
  clone.querySelectorAll('[data-htmlmemo-preview], [data-htmlmemo-selected]').forEach(element => element.remove());
  // Reader-only sidebar controls and their grid/flex overrides must never
  // alter the source document's own TOC after it is saved and reopened.
  clearReaderSidebarArtifacts(clone);
  // Interactive editor-only styles should never change the standalone file.
  clone.querySelector('#htmlmemo-editor-style')?.remove();
  clone.querySelector('head').append(metadataElement(doc, metadata));
  return '<!doctype html>\n' + clone.outerHTML;
}
export function textIndex(doc,root=doc.body) {
  const nodes = []; let text = '';
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
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
// The section a packed book (memosuite-book-html-v1) is showing, or '' for ordinary pages.
export const currentSection = doc => doc?.getElementById?.('reader-content')?.dataset?.section || '';
// Drawings are stored relative to an element. Its text identifies it again after reloads and
// in later editions of the same book.
export function drawingTargetQuote(doc, element) {
  if (element === doc.body || element === doc.documentElement) return '';
  const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let text = '', count = 0;
  while (count++ < 1000 && text.length < 320 && walker.nextNode()) {
    if (!walker.currentNode.parentElement?.closest('script,style,svg,template,[data-htmlmemo-ui]')) text += walker.currentNode.textContent.slice(0, 320 - text.length);
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, 160);
}
export function describeDrawingTarget(doc, element) {
  const root = element.parentElement?.closest('[id]') || doc.body;
  const path = [];let node = element;
  while (node !== root && node?.parentElement && path.length < 64) {
    path.unshift([...node.parentElement.children].indexOf(node));node = node.parentElement;
  }
  return {tag:element.localName,id:element.id || '',rootId:root.id || '',path:node === root ? path : [],
    quote:drawingTargetQuote(doc, element),section:element.closest('#reader-content')?.dataset.section || ''};
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
export function wrapOffsets(doc, start, end, attributes, style = '', index = textIndex(doc)) {
  // Keep a shared text index valid as ranges split nodes. Restoring N highlights
  // must not walk and concatenate the entire book twice for every highlight.
  let lo=0,hi=index.nodes.length;
  while(lo<hi){const mid=(lo+hi)>>>1;if(index.nodes[mid].end<=start)lo=mid+1;else hi=mid;}
  const matches=[];
  for(let i=lo;i<index.nodes.length && index.nodes[i].start<end;i++)matches.push({item:index.nodes[i],i});
  for(const {item,i} of matches.reverse()){
    const from=Math.max(0,start-item.start),to=Math.min(item.node.length,end-item.start);
    const suffix=to<item.node.length?item.node.splitText(to):null;
    const selected=from>0?item.node.splitText(from):item.node;
    const mark=doc.createElement('span');for(const [name,value] of Object.entries(attributes))mark.setAttribute(name,value);
    mark.style.cssText=style;selected.replaceWith(mark);mark.append(selected);
    const parts=[];
    if(from>0)parts.push({node:item.node,start:item.start,end:item.start+from});
    parts.push({node:selected,start:item.start+from,end:item.start+to});
    if(suffix)parts.push({node:suffix,start:item.start+to,end:item.end});
    index.nodes.splice(i,1,...parts);
  }
}
