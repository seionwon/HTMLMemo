import { createReadAloud } from './read-aloud.js';
import { SearchIndexCache } from './search-index.js';
import { IsolatedRuntime,needsIsolatedRuntime } from './isolated-runtime.js';
import { clamp, uid, icon } from './utils.js';
import { History, TEXT_TOOLS, DRAW_TOOLS, FILL_TOOLS } from './model.js';
import { LAYER_ID, LOCAL_CSP, parseHTML, savedMainFrame, prepareLoadedHTML, cleanAnnotations, textIndex, selectionAnchor, resolveTextAnchor, wrapOffsets, rangeFromOffsets, sentenceOffsets, serializeHTML, inspectBookDocument, drawingTargetQuote, describeDrawingTarget, currentSection } from './document.js';

const NS = 'http://www.w3.org/2000/svg';
const TOC_WIDTH_KEY = 'htmlmemo-doc-toc-width-v1', TOC_EXPANDED_WIDTH_KEY = 'htmlmemo-doc-toc-expanded-width-v1', TOC_MIN = 8, TOC_STRIP_SNAP = 48, TOC_MAX = 640, TOC_DEFAULT = 260;
const svg = (doc, tag, attrs = {}) => { const node = doc.createElementNS(NS, tag); for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value)); return node; };
export class Reader {
  constructor(host, parsed, callbacks) {
    this.host = host; this.metadata = parsed.metadata; this.callbacks = callbacks; this.history = new History(this.metadata.annotations);
    this.tool = 'select'; this.color = '#edcf67'; this.highlightColor = '#edcf67'; this.width = 3; this.opacity = .35; this.rectFill = false; this.penTTL = 0; this.zoom = 1;
    this.nativeScroll = !!parsed.nativeScroll;
    this.selection = null; this.selectedId = null; this.linkHistory = []; this.searchResults = []; this.searchPosition = -1; this.autoFit = this.metadata.view.autoFit !== false;
    this.middleScroll = null; this.tocResize = null; this.tocDrag = null;
    this.preparing = true;
    this.viewport = document.createElement('div'); this.viewport.className = 'reader-viewport';
    this.viewport.setAttribute('aria-busy', 'true');
    this.viewport.classList.toggle('reader-native-scroll', this.nativeScroll);
    this.sizer = document.createElement('div'); this.sizer.className = 'reader-sizer';
    this.frame = document.createElement('iframe'); this.frame.className = 'document-frame'; this.frame.title = this.metadata.title;
    // Keep streamed source, saved overlays and intermediate coordinates off-screen
    // while preserving the iframe's layout and the document's own scripts.
    this.frame.style.visibility = 'hidden'; this.frame.style.pointerEvents = 'none';
    this.frame.setAttribute('aria-hidden', 'true');
    // Local documents explicitly enable scripts; captures retain static mode.
    // Forms, popups and top-level navigation remain sandboxed.
    this.frame.setAttribute('sandbox', 'allow-same-origin'); this.frame.referrerPolicy = 'no-referrer';
    this.naturalWidth = this.metadata.viewport.width; this.frame.style.height = '100%'; this.frame.style.width = this.naturalWidth + 'px';
    this.sizer.append(this.frame); this.viewport.append(this.sizer); host.append(this.viewport);
    this.loading = document.createElement('div'); this.loading.className = 'reader-loading';
    this.loading.setAttribute('role', 'status'); this.loading.textContent = '문서를 준비하는 중…'; host.append(this.loading);
    if (this.nativeScroll) this.applyZoom();
    this.ready = new Promise((resolve, reject) => {
      this.frame.addEventListener('load', async () => {
        try {
          this.doc = this.frame.contentDocument;
          if (!this.doc?.body) throw new Error('HTML 문서를 표시하지 못했습니다.');
          if(this.metadata.execution?.allowScripts&&needsIsolatedRuntime(this.doc)){
            this.runtime=new IsolatedRuntime({host:this.host,doc:this.doc,source:parsed.file||new Blob([parsed.html],{type:'text/html;charset=utf-8'}),storage:this.metadata.view.sourceStorage,onStorage:entries=>{this.metadata.view.sourceStorage=entries;(this.callbacks.onSourceSettings||this.callbacks.onPosition)?.();},onNavigate:hash=>{void this.navigateSourceHash(hash);},onScroll:target=>this.navigateSourceTarget(target),onError:error=>this.callbacks.onError?.(error)});
            await this.runtime.start();
          }
          await this.adoptSavedMainFrame();
          this.bookIntegrity = inspectBookDocument(this.doc);
          await this.waitForBookContent();
          if (this.disposed) { resolve(this); return; }
          const needsPrepare = Boolean(parsed.file || !this.doc.body.hasAttribute('data-htmlmemo-anchor'));
          this.bind({deferDynamicObserver: needsPrepare});
          if (needsPrepare) {
            // Let the app paint its loading state before preparation. Reuse the
            // streamed DOM instead of decoding and copying the entire book.
            if (parsed.file) {
              await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
              if (this.disposed) { resolve(this); return; }
            }
            const blockNavigation = event => {
              if (event.type !== 'click' && event.key !== 'Enter') return;
              const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
              const link = target?.closest?.('a[href]');
              if (link) {
                const href = (link.getAttribute('href') || '').trim();
                if (href && !href.startsWith('#') && !/^javascript:/i.test(href)) event.preventDefault();
              } else if (target?.closest?.('form')) event.preventDefault();
            };
            this.doc.addEventListener('click',blockNavigation,true);this.doc.addEventListener('keydown',blockNavigation,true);
            const prepared = await prepareLoadedHTML(this.doc, this.metadata, () => this.disposed, {serialize:false,freshAnnotations:!!parsed.freshAnnotations});
            this.doc.removeEventListener('click',blockNavigation,true);this.doc.removeEventListener('keydown',blockNavigation,true);
            const openingScroll = {top:this.doc.defaultView.scrollY,left:this.doc.defaultView.scrollX};
            this.metadata = parsed.savedMetadata ? {...prepared.metadata,...parsed.metadata} : prepared.metadata; this.history = new History(this.metadata.annotations);
            if(this.runtime)this.metadata.view.sourceStorage=this.runtime.storage;
            this.autoFit = this.metadata.view.autoFit !== false;
            this.initialHTML = prepared.html;
            this.naturalWidth = this.metadata.viewport.width;
            this.frame.style.width = this.naturalWidth + 'px';
            this.openingScroll = openingScroll;
          }
          this.bind();
          this.zoom = clamp(this.autoFit ? this.fitZoom() : (this.metadata.view.zoom || this.fitZoom()), .2, 8); this.applyZoom();
          if (this.doc.fonts?.status === 'loading') await this.doc.fonts.ready;
          if (this.disposed) { resolve(this); return; }
          this.initialBookSection=currentSection(this.doc);
          this.preparing = false; this.measure(); this.render();
          await new Promise(done => requestAnimationFrame(done));
          if (this.disposed) { resolve(this); return; }
          this.restoreOpeningPosition();
          this.measure(); this.renderDrawingLayer();
          // Scroll restoration and source ResizeObservers settle before the
          // first visible frame, so annotations do not flash at the page top.
          await new Promise(done => requestAnimationFrame(done));
          if (this.disposed) { resolve(this); return; }
          this.measure(); this.renderDrawingLayer();
          this.setupDocumentSidebar();
          this.setupReadingControls();
          this.frame.style.visibility = 'visible'; this.frame.style.pointerEvents = '';
          this.frame.removeAttribute('aria-hidden'); this.viewport.setAttribute('aria-busy', 'false');this.loading.remove();
          this.callbacks.onView?.(); resolve(this);
        } catch (error) { reject(error); }
      }, {once:true});
    });
    const displaySource=new Blob(['<!doctype html><head><meta http-equiv="Content-Security-Policy" content="'+LOCAL_CSP+'">',parsed.file||parsed.html],{type:'text/html;charset=utf-8'});
    if (this.nativeScroll) {
      this.documentURL = URL.createObjectURL(displaySource);
      this.frame.src = this.documentURL;
    } else this.frame.srcdoc = '<!doctype html><head><meta http-equiv="Content-Security-Policy" content="'+LOCAL_CSP+'">'+parsed.html;
  }
  async adoptSavedMainFrame() {
    for(let depth=0;depth<3;depth++){
      const frame=savedMainFrame(this.doc);if(!frame)return;
      // Legacy saved copies used an opaque subframe. Sanitize it before giving
      // the app DOM access; never grant scripts and same-origin together.
      const tokens=(frame.getAttribute('sandbox')||'').split(/\s+/),reload=!tokens.includes('allow-same-origin')||tokens.includes('allow-scripts');
      const ready=()=>frame.contentDocument?.body&&frame.contentDocument.URL==='about:srcdoc'&&frame.contentDocument.readyState==='complete';
      if(reload||!ready())await new Promise((resolve,reject)=>{
        let timer;const finish=error=>{clearTimeout(timer);frame.removeEventListener('load',loaded);this.cancelFrameOpen=null;error?reject(error):resolve();};
        const loaded=()=>{if(ready())finish();};this.cancelFrameOpen=()=>finish(new DOMException('문서 열기가 취소되었습니다.','AbortError'));
        frame.addEventListener('load',loaded);timer=setTimeout(()=>finish(Error('저장된 본문 프레임을 열지 못했습니다.')),15000);
        frame.loading='eager';
        if(reload){const prepared=parseHTML(frame.getAttribute('srcdoc'),{source:this.metadata.source},{allowScripts:false,includeMetadata:true});frame.setAttribute('sandbox','allow-same-origin');frame.removeAttribute('src');frame.setAttribute('srcdoc',prepared.html);}
        else if(ready())finish();
      });
      for(const node of [this.doc.documentElement,this.doc.body])for(const [key,value] of Object.entries({margin:'0',padding:'0',width:'100%',height:'100%',overflow:'hidden'}))node.style.setProperty(key,value,'important');
      for(const [key,value] of Object.entries({position:'fixed',inset:'0',width:'100%',height:'100%',border:'0',margin:'0',padding:'0',display:'block'}))frame.style.setProperty(key,value,'important');
      this.doc=frame.contentDocument;this.nativeScroll=true;
    }
  }
  waitForBookContent() {
    if (!this.bookIntegrity?.complete) return Promise.resolve();
    const content = this.doc.getElementById('reader-content');
    if (!content) return Promise.resolve();
    // An exported "ready" flag can outlive the DOM that a book script is
    // rebuilding. It is not proof that the first section actually exists.
    const ready = () => content.childElementCount > 0 &&
      this.doc.documentElement.dataset.readerReady !== 'false' && !this.doc.getElementById('reader-status')?.textContent.trim();
    if (ready()) return Promise.resolve();
    // Packed books finish their first section after the iframe load event.
    // Assigning anchors before that point makes IDs depend on decode timing.
    return new Promise((resolve, reject) => {
      const finish = error => { observer.disconnect();clearTimeout(timer);this.cancelOpeningWait=null;error ? reject(error) : resolve(); };
      const observer = new this.doc.defaultView.MutationObserver(() => { if (this.disposed || ready()) finish(); });
      const timer = setTimeout(() => finish(new Error('책 본문 준비를 완료하지 못했습니다. 다시 열어 주세요.')), 30000);
      this.cancelOpeningWait = () => finish();
      observer.observe(this.doc.documentElement,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['data-reader-ready']});
      if (this.disposed || ready()) finish();
    });
  }
  baseEditorStyle() {
    return 'html[data-htmlmemo-picking] [data-htmlmemo-mark],html[data-htmlmemo-picking] [data-htmlmemo-mark] *{cursor:pointer!important}html[data-htmlmemo-picking] [data-htmlmemo-hit]{pointer-events:stroke!important;cursor:pointer!important}html[data-htmlmemo-picking="select"] #htmlmemo-annotation-layer,html[data-htmlmemo-picking="select"] [data-htmlmemo-id],html[data-htmlmemo-picking="select"] [data-htmlmemo-hit]{touch-action:none!important}[data-htmlmemo-preview],[data-htmlmemo-preview] *{pointer-events:none!important}[data-htmlmemo-drag-source]{opacity:.25!important;pointer-events:none!important}html[data-htmlmemo-moving],html[data-htmlmemo-moving][data-htmlmemo-picking] *{cursor:grabbing!important;user-select:none!important;-webkit-user-select:none!important}' + this.layoutEditorStyle() + this.textMarkingStyle();
  }
  textMarkingStyle() {
    // Touch and pen mark text directly; mouse keeps native text selection.
    return 'html[data-htmlmemo-text-marking] body{touch-action:none!important}';
  }
  layoutEditorStyle() {
    // Keep the source book's responsive #reader-menu visibility; forcing flex
    // makes this drawer button reappear on desktop, where it has no effect.
    return `${this.nativeScroll ? '' : 'html{overflow:hidden!important;height:auto!important;min-height:0!important;scroll-behavior:auto!important}body{touch-action:pan-x pan-y;height:auto!important;min-height:0!important}'}html[data-htmlmemo-drawing] *{cursor:crosshair!important;user-select:none!important;touch-action:none!important}html[data-htmlmemo-drawing] aside,html[data-htmlmemo-drawing] aside *,html[data-htmlmemo-drawing] nav,html[data-htmlmemo-drawing] nav *,html[data-htmlmemo-drawing] header,html[data-htmlmemo-drawing] header *,html[data-htmlmemo-drawing] .toc,html[data-htmlmemo-drawing] .toc *,html[data-htmlmemo-drawing] #toc,html[data-htmlmemo-drawing] #toc *,html[data-htmlmemo-drawing] [data-htmlmemo-toc-sidebar],html[data-htmlmemo-drawing] [data-htmlmemo-toc-sidebar] *,html[data-htmlmemo-drawing] [data-htmlmemo-doc-topbar],html[data-htmlmemo-drawing] [data-htmlmemo-doc-topbar] *{cursor:auto!important;touch-action:auto!important}html[data-htmlmemo-drawing] aside a,html[data-htmlmemo-drawing] aside button,html[data-htmlmemo-drawing] aside summary,html[data-htmlmemo-drawing] nav a,html[data-htmlmemo-drawing] nav button,html[data-htmlmemo-drawing] nav summary,html[data-htmlmemo-drawing] .toc a,html[data-htmlmemo-drawing] .toc button,html[data-htmlmemo-drawing] .toc summary,html[data-htmlmemo-drawing] #toc a,html[data-htmlmemo-drawing] #toc button,html[data-htmlmemo-drawing] #toc summary,html[data-htmlmemo-drawing] [data-htmlmemo-toc-sidebar] a,html[data-htmlmemo-drawing] [data-htmlmemo-toc-sidebar] button,html[data-htmlmemo-drawing] [data-htmlmemo-toc-sidebar] summary,html[data-htmlmemo-drawing] [data-htmlmemo-doc-topbar] button,html[data-htmlmemo-drawing] [data-htmlmemo-doc-topbar] select{cursor:pointer!important}[data-htmlmemo-scroll-host]{position:relative!important}html[data-htmlmemo-toc-resizing],html[data-htmlmemo-toc-resizing] body{cursor:col-resize!important;user-select:none!important;-webkit-user-select:none!important}[data-htmlmemo-sidebar-grid]{grid-template-columns:var(--htmlmemo-toc-grid-columns)!important;transition:none!important}[data-htmlmemo-toc-sidebar],[data-htmlmemo-toc-item],[data-htmlmemo-sidebar-flex]{width:var(--htmlmemo-toc-width)!important;min-width:var(--htmlmemo-toc-width)!important;max-width:var(--htmlmemo-toc-width)!important;box-sizing:border-box!important;transition:none!important}[data-htmlmemo-sidebar-flex]{flex:0 0 var(--htmlmemo-toc-width)!important}[data-htmlmemo-toc-sidebar]{overflow-x:hidden!important}[data-htmlmemo-toc-item-strip]{width:8px!important;min-width:8px!important;max-width:8px!important;flex:0 0 8px!important;padding-left:0!important;padding-right:0!important;overflow:hidden!important;box-sizing:border-box!important}[data-htmlmemo-toc-strip]{width:8px!important;min-width:8px!important;max-width:8px!important;flex:0 0 8px!important;padding-left:0!important;padding-right:0!important;overflow:hidden!important;box-sizing:border-box!important;cursor:col-resize!important;user-select:none!important;pointer-events:auto!important}[data-htmlmemo-toc-strip]>:not([data-htmlmemo-toc-resizer]):not([data-htmlmemo-toc-resizer-bound]){opacity:0!important;visibility:hidden!important;pointer-events:none!important}[data-htmlmemo-toc-strip] [data-htmlmemo-toc-resizer],[data-htmlmemo-toc-strip] [data-htmlmemo-toc-resizer-bound]{left:0!important;width:8px!important;min-width:8px!important;opacity:1!important;visibility:visible!important;pointer-events:auto!important}[data-htmlmemo-toc-resizer],[data-htmlmemo-toc-resizer-bound]{cursor:col-resize!important;touch-action:none!important;user-select:none!important;-webkit-user-select:none!important;transition:none!important}[data-htmlmemo-topbar-grid]{grid-template-rows:var(--htmlmemo-topbar-grid-rows)!important}[data-htmlmemo-topbar-pad]{padding-top:24px!important}[data-htmlmemo-topbar-offset]{top:24px!important}[data-htmlmemo-doc-topbar],[data-htmlmemo-doc-topbar-item]{height:24px!important;min-height:24px!important;max-height:24px!important;padding-top:0!important;padding-bottom:0!important;margin-top:0!important;margin-bottom:0!important;box-sizing:border-box!important;align-items:center!important}[data-htmlmemo-doc-topbar] *{padding-top:0!important;padding-bottom:0!important;margin-top:0!important;margin-bottom:0!important;min-height:0!important;box-sizing:border-box!important}[data-htmlmemo-doc-topbar]>div,[data-htmlmemo-doc-topbar]>nav{height:100%!important;max-height:24px!important;align-items:center!important}[data-htmlmemo-doc-topbar] h1,[data-htmlmemo-doc-topbar] h2,[data-htmlmemo-doc-topbar] h3,[data-htmlmemo-doc-topbar] strong,[data-htmlmemo-doc-topbar] [class*="title"]{font-size:13px!important;line-height:22px!important;white-space:nowrap!important}[data-htmlmemo-doc-topbar] button,[data-htmlmemo-doc-topbar] [role="button"],[data-htmlmemo-doc-topbar] input{height:20px!important;min-height:20px!important;max-height:20px!important;padding-top:0!important;padding-bottom:0!important;font-size:12px!important;line-height:18px!important;border-radius:4px!important;align-items:center!important;justify-content:center!important}[data-htmlmemo-doc-topbar] select{height:20px!important;min-height:20px!important;max-height:20px!important;padding-top:0!important;padding-bottom:0!important;font-size:12px!important;line-height:18px!important;border-radius:4px!important}[data-htmlmemo-doc-topbar] button:not(#reader-menu),[data-htmlmemo-doc-topbar] [role="button"]:not(#reader-menu),[data-htmlmemo-doc-topbar] input:not(#reader-menu){display:inline-flex!important}[data-htmlmemo-doc-topbar] svg{width:14px!important;height:14px!important}`;
  }
  setupEditorTocVars(customVars = this.tocCustomVars, defaultWidth = this.tocDefaultWidth || TOC_DEFAULT) {
    const editorStyle = this.doc?.getElementById('htmlmemo-editor-style');
    if (!editorStyle) return;
    if (customVars) this.tocCustomVars = customVars;
    const names = this.tocCustomVars?.length ? this.tocCustomVars : ['--toc-width', '--sidebar-width', '--nav-width'];
    const mapVars = names.map(name => `${name}:var(--htmlmemo-toc-width)!important`).join(';');
    const freezeVars = [...names, '--htmlmemo-toc-width'].map(name => `${name}:${defaultWidth}px!important`).join(';');
    const topNames = this.topbarCustomVars?.length ? this.topbarCustomVars : ['--header-height', '--topbar-height', '--header-h', '--topbar-h', '--navbar-height', '--toolbar-height'];
    const topVars = topNames.map(name => `${name}:24px!important`).join(';');
    editorStyle.textContent = this.baseEditorStyle() + `html[data-htmlmemo-toc-active],html[data-htmlmemo-toc-active] body,[data-htmlmemo-sidebar-grid],[data-htmlmemo-toc-sidebar],[data-htmlmemo-toc-item],[data-htmlmemo-toc-resizer-bound]{${mapVars}}html[data-htmlmemo-toc-resizing] [data-htmlmemo-toc-main]>:not([role="separator"]):not([data-htmlmemo-toc-resizer-bound]){${freezeVars}}html[data-htmlmemo-topbar-active],html[data-htmlmemo-topbar-active] body,[data-htmlmemo-doc-topbar],[data-htmlmemo-doc-topbar-item]{${topVars}}`;
  }
  isTocSubContainerVisible(container, trigger = null, item = null) {
    if (!container) return false;
    if (container.hidden || container.getAttribute?.('aria-hidden') === 'true') return false;
    const inlineDisplay = container.style?.display;
    if (inlineDisplay === 'none' || container.style?.visibility === 'hidden' || container.style?.maxHeight === '0px' || container.style?.maxHeight === '0') return false;
    const cs = this.doc?.defaultView?.getComputedStyle?.(container);
    if (cs && (cs.display === 'none' || cs.visibility === 'hidden' || cs.maxHeight === '0px')) return false;
    const nodes = [container, trigger, item, container.previousElementSibling].filter(Boolean);
    for (const n of nodes) {
      if (n.classList?.contains('collapsed') || n.classList?.contains('closed') || n.classList?.contains('hidden') || n.classList?.contains('is-collapsed')) return false;
      if (n.getAttribute?.('aria-expanded') === 'false' || n.dataset?.open === 'false' || n.dataset?.expanded === 'false') return false;
    }
    for (const n of nodes) {
      if (n.classList?.contains('open') || n.classList?.contains('expanded') || n.classList?.contains('is-open')) return true;
      if (n.getAttribute?.('aria-expanded') === 'true' || n.dataset?.open === 'true' || n.dataset?.expanded === 'true') return true;
    }
    const headerNode = container.previousElementSibling || trigger;
    if (headerNode && !headerNode.contains?.(container) && !inlineDisplay) {
      const text = (headerNode.textContent || '').trim();
      if (/[▶▸]/.test(text) && !/[▼▾]/.test(text)) return false;
    }
    return true;
  }
  findTocSubContainer(target) {
    const el = target?.nodeType === 1 ? target : target?.parentElement;
    if (!el || el.closest?.('[data-htmlmemo-ui]') || !this.isInsideTocOrTopbar(el) || this.topbarNode?.contains?.(el)) return null;
    if (el.closest?.('summary')) return null;
    const subSelector = 'ul, ol, [role="group"], .toc-children, .toc-sub, .toc-items, .toc-list, .sub-toc, .sub-list, .submenu, .tree-children, .children, .nav-children, .chapter-items, .section-items, [data-toc-children], [data-children]';
    const itemSelector = 'li, [role="treeitem"], .toc-item, .toc-group, .toc-section, .toc-node, .nav-item, .nav-group, .tree-node, .tree-item, [data-toc-group], [data-toc-item]';
    const triggerSelector = 'button, a, [role="button"], [aria-expanded], [aria-controls], [data-target], [data-toggle], .toc-header, .toc-title, .toc-toggle, .toc-cat, .group-header, .section-header, .folder';
    const item = el.closest?.(itemSelector);
    const trigger = el.closest?.(triggerSelector);
    for (const node of [trigger, el, item]) {
      if (!node?.getAttribute) continue;
      const ref = node.getAttribute('aria-controls') || node.getAttribute('data-target') || node.getAttribute('data-controls') || node.dataset?.target || node.dataset?.controls;
      if (ref) {
        const cleanId = ref.replace(/^#/, '');
        const controlled = this.doc.getElementById(cleanId) || (ref.startsWith('#') || ref.startsWith('.') ? this.doc.querySelector(ref) : null);
        if (controlled && controlled !== el && !controlled.contains?.(el) && this.isInsideTocOrTopbar(controlled)) return controlled;
      }
    }
    const link = el.closest?.('a[href]');
    if (link) {
      const href = (link.getAttribute('href') || '').trim();
      if (href.startsWith('#') && href.length > 1) {
        let id; try { id = decodeURIComponent(href.slice(1)); } catch { id = href.slice(1); }
        const hashTarget = id ? this.doc.getElementById(id) : null;
        if (hashTarget && hashTarget !== el && !hashTarget.contains?.(el) && this.isInsideTocOrTopbar(hashTarget) && hashTarget.matches?.('ul, ol, div, section, [role="group"]')) {
          return hashTarget;
        }
      }
    }
    if (item) {
      for (const child of item.children || []) {
        if (child === el || child.contains?.(el)) continue;
        if (child.matches?.(subSelector) || ((child.localName === 'div' || child.localName === 'section') && child.querySelector?.('a[href], button, [data-page], [data-target], li'))) {
          return child;
        }
      }
    }
    const row = trigger || el.closest?.('div, p, h1, h2, h3, h4, h5, h6, li, a, button');
    for (const start of [row, trigger, el]) {
      if (!start) continue;
      let cur = start;
      for (let depth = 0; depth < 2 && cur && this.isInsideTocOrTopbar(cur); depth++) {
        if (cur === this.tocResize?.sidebar || cur.hasAttribute?.('data-htmlmemo-toc-sidebar')) break;
        const next = cur.nextElementSibling;
        if (next && next !== el && !next.contains?.(el)) {
          const tag = next.localName || '';
          const curText = (cur.textContent || '').trim();
          const nextText = (next.textContent || '').trim();
          if (
            next.matches?.(subSelector) ||
            ((tag === 'div' || tag === 'section') && (
              !this.isTocSubContainerVisible(next, cur, item) ||
              next.classList?.contains('open') ||
              next.classList?.contains('expanded') ||
              next.classList?.contains('collapsed') ||
              next.classList?.contains('closed') ||
              (/[▶▸▼▾]/.test(curText) && !/^[▶▸▼▾]/.test(nextText) && next.querySelector?.('a, button, div, span, li'))
            ))
          ) {
            return next;
          }
        }
        if (cur === item || /^(?:li|ul|ol|nav|aside)$/i.test(cur.localName || '')) break;
        cur = cur.parentElement;
      }
    }
    return null;
  }
  captureTocClickState(target) {
    const el = target?.nodeType === 1 ? target : target?.parentElement;
    if (!el) return null;
    const summary = el.closest?.('summary');
    const details = summary ? (summary.parentElement?.localName === 'details' ? summary.parentElement : summary.closest?.('details')) : null;
    const container = details ? null : this.findTocSubContainer(el);
    return {
      details,
      detailsOpen: details ? Boolean(details.open || details.hasAttribute?.('open')) : null,
      container,
      containerVisible: container ? this.isTocSubContainerVisible(container, el) : null
    };
  }
  toggleTocSubContainer(target, container, forceOpen) {
    if (!container) return false;
    const el = target?.nodeType === 1 ? target : target?.parentElement;
    const item = el?.closest?.('li, [role="treeitem"], .toc-item, .toc-group, .toc-section, .toc-node, .nav-item, .nav-group, .tree-node, .tree-item, [data-toc-group], [data-toc-item]') || container.parentElement;
    const trigger = el?.closest?.('button, a, [role="button"], [aria-expanded], [aria-controls], [data-target], [data-toggle], .toc-header, .toc-title, .toc-toggle, .toc-cat, .group-header, .section-header, .folder, div, p, h1, h2, h3, h4, h5, h6') || el;
    const shouldOpen = typeof forceOpen === 'boolean' ? forceOpen : !this.isTocSubContainerVisible(container, trigger, item);
    if (shouldOpen) {
      container.hidden = false;
      container.removeAttribute?.('hidden');
      if (container.hasAttribute?.('aria-hidden')) container.setAttribute('aria-hidden', 'false');
      container.classList?.remove('collapsed', 'closed', 'hidden', 'is-collapsed');
      container.classList?.add('open', 'expanded', 'is-open');
      container.style?.setProperty?.('display', 'block', 'important');
      const cs = this.doc?.defaultView?.getComputedStyle?.(container);
      if (cs?.visibility === 'hidden' || container.style?.visibility === 'hidden') container.style?.setProperty?.('visibility', 'visible', 'important');
      if (cs?.maxHeight === '0px' || container.style?.maxHeight === '0px' || container.style?.maxHeight === '0') container.style?.setProperty?.('max-height', 'none', 'important');
      if (cs?.opacity === '0' || container.style?.opacity === '0') container.style?.setProperty?.('opacity', '1', 'important');
    } else {
      container.hidden = true;
      if (container.hasAttribute?.('aria-hidden')) container.setAttribute('aria-hidden', 'true');
      container.classList?.remove('open', 'expanded', 'is-open', 'active');
      container.classList?.add('collapsed', 'closed');
      container.style?.setProperty?.('display', 'none', 'important');
    }
    const headerNode = (container.previousElementSibling && !container.previousElementSibling.contains?.(container)) ? container.previousElementSibling : trigger;
    for (const node of [trigger, headerNode, item]) {
      if (!node || node === container || node === this.tocResize?.sidebar) continue;
      if (node.hasAttribute?.('aria-expanded') || node === trigger || node === headerNode) {
        node.setAttribute?.('aria-expanded', shouldOpen ? 'true' : 'false');
      }
      if (node.dataset && ('open' in node.dataset || 'expanded' in node.dataset || node === trigger || node === headerNode)) {
        node.dataset.open = shouldOpen ? 'true' : 'false';
      }
      node.classList?.toggle('open', shouldOpen);
      node.classList?.toggle('expanded', shouldOpen);
      node.classList?.toggle('is-open', shouldOpen);
      node.classList?.toggle('collapsed', !shouldOpen);
      node.classList?.toggle('closed', !shouldOpen);
    }
    if (headerNode && !headerNode.contains?.(container)) {
      const stack = [...(headerNode.childNodes || [])];
      while (stack.length) {
        const node = stack.shift();
        if (node.nodeType === 3) {
          const val = node.nodeValue || '';
          if (shouldOpen && /[▶▸]/.test(val)) {
            node.nodeValue = val.replace(/▶/g, '▼').replace(/▸/g, '▾');
            break;
          } else if (!shouldOpen && /[▼▾]/.test(val)) {
            node.nodeValue = val.replace(/▼/g, '▶').replace(/▾/g, '▸');
            break;
          }
        } else if (node.childNodes?.length && node !== container) {
          stack.unshift(...node.childNodes);
        }
      }
    }
    return true;
  }
  startDynamicObserver() {
    if (!this.metadata?.execution?.allowScripts || this.dynamicObserver) return;
    this.dynamicAnchor = 0;
    this.dynamicRoots = new Set([this.doc.body]);
    const MO = this.doc.defaultView?.MutationObserver || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
    if (MO) {
      this.dynamicObserver = new MO(records => {
        if (this.tocDrag) return;
        const editor = node => (node.nodeType===3?node.parentElement:node)?.closest?.('#'+LAYER_ID+',#htmlmemo-annotation-style,#htmlmemo-editor-style,[data-htmlmemo-ui],[data-htmlmemo-mark],[data-htmlmemo-search]');
        let changed=false;
        for(const record of records){
          if(editor(record.target))continue;
          const nodes=record.type==='characterData'?[record.target]:[...record.addedNodes,...record.removedNodes];
          if(nodes.some(node=>!editor(node))){
            changed=true;
            this.dynamicRoots.add(record.target.nodeType===1?record.target:record.target.parentElement);
          }
        }
        if(changed)this.scheduleDynamicRefresh();
      });
      this.observeDynamicDocument();
      this.scheduleDynamicRefresh();
    }
  }
  startFontObserver() {
    if (this.fontObserver) return;
    const win = this.doc.defaultView;
    if (!win?.MutationObserver || !win.requestAnimationFrame) return;
    // A source reader can change a root CSS variable while its fixed-size
    // body/scroller never resizes. Coalesce those changes without rescanning text.
    this.fontObserver = new win.MutationObserver(records => {
      if (this.disposed || this.preparing || this.tocDrag || this.fontFrame || !this.metadata.annotations.some(a => a.type === 'pen')) return;
      if (!records.some(record => !record.target.closest?.('#'+LAYER_ID+',#htmlmemo-editor-style,#htmlmemo-annotation-style,[data-htmlmemo-ui],[data-htmlmemo-mark],[data-htmlmemo-search]'))) return;
      this.fontFrame = win.requestAnimationFrame(() => {
        this.fontFrame = null;
        if (this.disposed || this.host?.hidden || this.tocDrag) return;
        this.measure(); this.renderDrawingLayer();
      });
    });
    this.fontObserver.observe(this.doc.documentElement, {subtree:true,attributes:true,attributeFilter:['style','class']});
  }
  bind({deferDynamicObserver = false} = {}) {
    let editorStyle = this.doc.getElementById('htmlmemo-editor-style');
    if (!editorStyle) {
      editorStyle = this.doc.createElement('style');
      editorStyle.id = 'htmlmemo-editor-style';
      editorStyle.textContent = this.baseEditorStyle();
      (this.doc.head || this.doc.documentElement).append(editorStyle);
    }
    this.doc.documentElement.toggleAttribute('data-htmlmemo-text-marking',TEXT_TOOLS.includes(this.tool));
    this.setupDocumentTocResize();
    if (this.bound) {
      if (!deferDynamicObserver) this.startDynamicObserver();
      return;
    }
    this.bound = true;
    this.startFontObserver();
    this.doc.addEventListener('wheel', event => this.forwardWheel(event), {capture:true,passive:false});
    this.doc.addEventListener('touchstart', event => this.startTouchScroll(event), {capture:true,passive:false});
    this.doc.addEventListener('touchmove', event => this.moveTouchScroll(event), {capture:true,passive:false});
    this.doc.addEventListener('touchend', event => this.endTouchScroll(event), true);
    this.doc.addEventListener('touchcancel', event => this.endTouchScroll(event), true);
    this.doc.addEventListener('pointerdown', event => { if(this.startTocResize(event))return; if(this.startMiddleScroll(event))return;this.stopMiddleScroll();this.callbacks.onSelectionDismiss?.(); this.pointerDown(event); }, true);
    this.doc.addEventListener('mousedown', event => { if(this.startTocResize(event))return;this.selectSentenceAtClick(event); }, true);
    this.doc.addEventListener('dragstart', event => { if(this.annotationDrag||this.tocDrag||this.isTocResizeTarget(event))event.preventDefault(); }, true);
    this.doc.addEventListener('pointermove', event => { if(this.tocDrag)return; if(this.moveMiddleScroll(event))return;this.pointerMove(event); }, true);
    this.doc.addEventListener('pointerup', event => { if(this.tocDrag)return; if(this.endMiddleScroll(event))return;this.pointerUp(event); }, true);
    this.doc.addEventListener('pointercancel', () => { this.cancelTextMarkGesture();this.cancelAnnotationDrag();this.stopMiddleScroll();this.cancelDrawingGesture();this.touchErase=null; });
    // Touch starts with implicit capture on the mark. Moving capture to the
    // document root also releases that mark; only losing our own capture cancels.
    this.doc.addEventListener('lostpointercapture', event => {if(event.target===this.doc.documentElement){if(this.annotationDrag?.pointerId===event.pointerId)this.cancelAnnotationDrag();if(this.textMarkGesture?.pointerId===event.pointerId)this.cancelTextMarkGesture();}});
    this.doc.defaultView?.addEventListener?.('blur',()=>{this.cancelTextMarkGesture();this.cancelAnnotationDrag();});
    this.doc.addEventListener('auxclick', event => {if(event.button===1&&!event.target.closest?.('a,button,input,textarea,select,[contenteditable]'))event.preventDefault();}, true);
    this.doc.addEventListener('selectionchange', () => this.captureTextSelection());
    this.doc.addEventListener('keydown', event => {if(event.key==='Escape'&&this.textMarkGesture){this.cancelTextMarkGesture();event.preventDefault();event.stopPropagation();return;}if(event.key==='Escape'&&this.annotationDrag){this.cancelAnnotationDrag();event.preventDefault();event.stopPropagation();return;}if(this.handleTocKeydown(event))return; if(event.key==='Escape'&&this.middleScroll){this.stopMiddleScroll();event.preventDefault();return;}this.callbacks.onKey?.(event);}, true);
    this.doc.addEventListener('dblclick', event => {if(this.handleTocDblClick(event))return; this.focusDocument(event);}, true);
    this.viewport.addEventListener('dblclick', event => this.focusDocument(event));
    this.viewport.addEventListener('scroll',()=>this.updateReadingControls(),{passive:true});
    this.doc.addEventListener('click', event => {
      if(this.suppressAnnotationClick&&event.detail!==0&&performance.now()<this.suppressAnnotationClick){this.suppressAnnotationClick=0;event.preventDefault();event.stopImmediatePropagation();return;}
      const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
      this.lastTocClickState = this.captureTocClickState(target);
      if (this.tocResizeJustEnded || this.isTocResizerNode(target)) { this.tocResizeJustEnded = false; event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation?.(); return; }
      const annotationId = this.annotationIdAt(target);
      if (annotationId && this.tool === 'select') { event.preventDefault(); event.stopPropagation(); this.selectedId = annotationId; this.callbacks.onSelect?.(this.selectedId); return; }
      if (this.tocStrip) {
        const btn = target?.closest?.('button,[role="button"]');
        if (btn && !this.tocResize?.sidebar?.contains?.(btn)) {
          const info = `${btn.id || ''} ${typeof btn.className === 'string' ? btn.className : ''} ${btn.getAttribute?.('title') || ''} ${btn.getAttribute?.('aria-label') || ''} ${btn.getAttribute?.('aria-controls') || ''} ${btn.textContent || ''}`;
          if (/목차|차례|\btoc\b|sidebar|사이드바/i.test(info)) {
            this.applyTocWidth(Math.max(TOC_STRIP_SNAP, this.tocExpandedWidth || this.tocDefaultWidth || TOC_DEFAULT), {persist: true, snapStrip: true});
            this.syncAfterTocResize();
          }
        }
      }
      const link = target?.closest?.('a[href]');
      if (!link) return;
      const href = (link.getAttribute('href') || '').trim();
      if (!href || href.startsWith('#') || (this.metadata.execution?.allowScripts && /^javascript:/i.test(href))) return;
      event.preventDefault();
      if (this.tool !== 'select' && !this.isInsideTocOrTopbar(link)) return;
      let hash = '';
      if (this.metadata.source) { try { const current = new URL(this.metadata.source); const dest = new URL(href); if (current.origin === dest.origin && current.pathname === dest.pathname && current.search === dest.search) hash = dest.hash; } catch { /* non-web links aren't opened by the app */ } }
      if (hash && hash.length > 1) this.jumpToHash(hash);
      else if (/^https?:/i.test(href)) this.callbacks.onLink?.(href);
    }, true);
    this.doc.addEventListener('click', event => {
      const stateBefore = this.lastTocClickState;
      this.lastTocClickState = null;
      const pagePrevented = event.defaultPrevented;
      const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
      if (!target) return;
      const summary = target.closest?.('summary');
      const details = summary ? (summary.parentElement?.localName === 'details' ? summary.parentElement : summary.closest?.('details')) : null;
      const link = target.closest?.('a[href]');
      const href = link ? (link.getAttribute('href') || '').trim() : '';
      const container = details ? null : ((stateBefore?.container?.isConnected ? stateBefore.container : null) || this.findTocSubContainer(target));
      if (link && !link.closest('[data-htmlmemo-ui]') && href.startsWith('#') && !pagePrevented) {
        if (href === '#') {
          if (!summary && !pagePrevented) event.preventDefault();
        } else {
          let id; try { id = decodeURIComponent(href.slice(1)); } catch { id = href.slice(1); }
          const hashTarget = id ? (this.doc.getElementById(id) || [...this.doc.querySelectorAll('a[name]')].find(a => a.name === id)) : null;
          if (hashTarget && hashTarget !== container) {
            event.preventDefault();
            if (this.tool === 'select' || this.isInsideTocOrTopbar(link)) this.jumpToHash(href);
          } else if (hashTarget === container && !pagePrevented) {
            event.preventDefault();
          }
        }
      }
      if (details && summary && !target.closest?.('input,select,textarea')) {
        const isOpenNow = Boolean(details.open || details.hasAttribute?.('open'));
        const wasOpen = stateBefore?.details === details ? stateBefore.detailsOpen : isOpenNow;
        if (!pagePrevented && isOpenNow === wasOpen) {
          event.preventDefault();
          const nextOpen = !wasOpen;
          details.open = nextOpen;
          details.toggleAttribute?.('open', nextOpen);
        } else {
          event.preventDefault();
          details.open = isOpenNow;
          details.toggleAttribute?.('open', isOpenNow);
        }
        if (details.open) {
          for (const child of details.children || []) {
            if (child !== summary && !this.isTocSubContainerVisible(child, summary, details)) {
              this.toggleTocSubContainer(summary, child, true);
            }
          }
        }
        return;
      }
      if (container) {
        const wasVisible = stateBefore && stateBefore.container === container ? stateBefore.containerVisible : this.isTocSubContainerVisible(container, target);
        const nowVisible = this.isTocSubContainerVisible(container, target);
        if (nowVisible === wasVisible) {
          this.toggleTocSubContainer(target, container, !wasVisible);
        }
      }
    }, false);
    (this.nativeScroll ? this.doc : this.viewport).addEventListener('scroll', event => {
      const target = event?.target;
      if (this.nativeScroll && target?.nodeType === 1 && target !== this.doc.documentElement && !this.isInsideTocOrTopbar(target) && !/^(?:pre|code|table|ul|ol|nav|aside)$/i.test(target.localName || '') && target.scrollTop > 0 && (!this.scrollHostEl || target === this.doc.body || target.contains?.(this.scrollHostEl)) && (target === this.doc.body || (target.clientWidth >= 160 && target.clientHeight >= 100))) {
        if (this.scrollHostEl !== target) { this.scrollHostEl = target; this.scrollHostChecked = true; this.renderDrawingLayer(); }
      }
      clearTimeout(this.positionTimer);
      this.positionTimer = setTimeout(() => {
        if (this.disposed) return;
        this.rememberPosition(); this.callbacks.onView?.();
      }, 250);
    }, {capture:true, passive:true});
    this.observedSizes = new WeakMap();
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(entries => {
        if (this.disposed || this.host?.hidden || this.tocDrag) return;
        let changed = false;
        for (const entry of entries) {
          const rect = entry?.contentRect;
          const size = rect && [Math.round(rect.width), Math.round(rect.height)].join(':');
          if (size && size !== this.observedSizes.get(entry.target)) {
            this.observedSizes.set(entry.target, size);
            changed = true;
          }
        }
        if (!changed) return;
        this.measure(); this.renderDrawingLayer();
      });
      this.resizeObserver.observe(this.doc.body);
      this.hostObserver = new ResizeObserver(() => {
        if(this.disposed || this.host?.hidden)return;
        const size=[this.viewport.clientWidth,this.viewport.clientHeight].join(':');
        if(size===this.hostSize)return;
        this.hostSize=size;
        this.resizeViewport();
      });
      if (this.viewport instanceof Element) this.hostObserver.observe(this.viewport);
    }
    this.doc.fonts?.ready?.then?.(() => { if (!this.disposed && !this.tocDrag) { this.measure(); this.renderDrawingLayer(); } });
    if (!deferDynamicObserver) this.startDynamicObserver();
  }
  storage() {
    try { return this.host?.ownerDocument?.defaultView?.localStorage || (typeof localStorage !== 'undefined' ? localStorage : null); } catch { return null; }
  }
  maxTocWidth() {
    if (this.tocDrag && Number.isFinite(this.tocDrag.maxWidth)) return this.tocDrag.maxWidth;
    const docWidth = this.doc?.documentElement?.clientWidth || this.naturalWidth || 1100;
    return Math.max(120, Math.min(TOC_MAX, docWidth - 180));
  }
  clampTocWidth(value, snapStrip = true) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return this.tocDefaultWidth || TOC_DEFAULT;
    if (numeric <= 24 || (snapStrip && numeric < TOC_STRIP_SNAP)) return TOC_MIN;
    return Math.max(TOC_MIN, Math.min(this.maxTocWidth(), Math.round(numeric)));
  }
  gridTrackTokens(value) {
    const tokens = []; let current = '', depth = 0;
    for (const ch of String(value || '').trim()) {
      if (ch === '(') { depth++; current += ch; }
      else if (ch === ')') { depth = Math.max(0, depth - 1); current += ch; }
      else if (/\s/.test(ch) && depth === 0) { if (current) { tokens.push(current); current = ''; } }
      else current += ch;
    }
    if (current) tokens.push(current);
    return tokens.length >= 2 && !tokens.includes('none') ? tokens : [];
  }
  gridTracks(value) {
    const values = String(value || '').trim().split(/\s+/).filter(Boolean);
    if (values.length < 2 || values.some(v => !/^\d+(?:\.\d+)?px$/i.test(v))) return [];
    return values.map(v => Number.parseFloat(v));
  }
  gridTrackIndex(parent, item, tracks, layout) {
    const box = parent?.getBoundingClientRect?.(), cell = item?.getBoundingClientRect?.();
    if (!box?.width || !cell?.width) return -1;
    const left = box.left + (Number.parseFloat(layout.borderLeftWidth) || 0) + (Number.parseFloat(layout.paddingLeft) || 0);
    const right = (box.right ?? box.left + box.width) - (Number.parseFloat(layout.borderRightWidth) || 0) - (Number.parseFloat(layout.paddingRight) || 0);
    const gap = Number.parseFloat(layout.columnGap || layout.gap) || 0, x = cell.left + cell.width / 2;
    const rtl = String(layout.direction || '').toLowerCase() === 'rtl';
    let cursor = rtl ? right : left;
    for (let index = 0; index < tracks.length; index++) {
      const start = rtl ? cursor - tracks[index] : cursor, end = rtl ? cursor : cursor + tracks[index];
      if (x >= start - 2 && x <= end + 2) return index;
      cursor = rtl ? start - gap : end + gap;
    }
    return -1;
  }
  gridItem(parent, node) {
    for (let item = node; item && item !== parent; item = item.parentElement) if (item.parentElement === parent) return item;
    return null;
  }
  documentMainTrack(parent, sidebarItem, tracks, layout, resizerItem = null) {
    const candidates = [];
    for (const item of parent.children || []) {
      if (!item || item === sidebarItem || item === resizerItem || sidebarItem.contains?.(item) || item.contains?.(sidebarItem)) continue;
      const index = this.gridTrackIndex(parent, item, tracks, layout);
      if (index < 0) continue;
      const box = item.getBoundingClientRect?.() || {width: 0, height: 0};
      const isMainEl = item.matches?.('main,[role="main"]') || !!item.querySelector?.('main,[role="main"]');
      const isContentEl = !isMainEl && (item.matches?.('article,#main,#content,.page,.content') || !!item.querySelector?.('article,#main,#content'));
      const main = isMainEl ? 3 : isContentEl ? 2 : 1;
      candidates.push({index, score: main * 1e9 + Math.max(0, box.width) * Math.max(0, box.height)});
    }
    if (candidates.length) return candidates.sort((a, b) => b.score - a.score)[0].index;
    return -1;
  }
  detectTocCSSVariables() {
    const vars = new Set(['--toc-width', '--sidebar-width', '--nav-width', '--toc-w', '--sidebar-w']);
    for (const style of this.doc?.querySelectorAll?.('style') || []) {
      if (style.id?.startsWith('htmlmemo-')) continue;
      const css = style.textContent || '';
      for (const match of css.matchAll(/--([a-z0-9_-]*(?:toc|sidebar|nav|aside)[a-z0-9_-]*(?:width|size|w|col)[a-z0-9_-]*)/gi)) vars.add('--' + match[1]);
      for (const match of css.matchAll(/grid-template-columns\s*:\s*var\(\s*(--[a-z0-9_-]+)/gi)) vars.add(match[1]);
    }
    return [...vars];
  }
  findDocumentTocParts() {
    if (!this.doc?.body) return null;
    const named = '.toc,#toc,.table-of-contents,#table-of-contents,.book-toc,#book-toc,.reader-toc,[data-toc],.toc-sidebar,#toc-sidebar,.toc-panel,#toc-panel,.toc-pane,#toc-pane';
    const label = value => /목차|차례|table of contents|\btoc\b|contents/i.test(String(value || ''));
    const isMain = node => !!node?.closest?.('main,article,[role="main"]');
    const nodeName = node => `${node?.id || ''} ${typeof node?.className === 'string' ? node.className : ''} ${node?.getAttribute?.('role') || ''} ${node?.getAttribute?.('data-toc') || ''} ${node?.getAttribute?.('title') || ''} ${node?.getAttribute?.('aria-label') || ''}`;
    const isResizerNode = node => {
      if (!node || node.nodeType !== 1 || ['hr', 'main', 'article'].includes(node.localName)) return false;
      if (node.getAttribute('aria-orientation') === 'horizontal') return false;
      const info = nodeName(node);
      if (/목차\s*폭|사이드바\s*폭|toc[-_\s]*resiz|sidebar[-_\s]*resiz|resizer|splitter|sash/i.test(info)) return true;
      return node.getAttribute('role') === 'separator';
    };
    const explicitResizers = [...this.doc.querySelectorAll('[role="separator"],[title*="목차"],[aria-label*="목차"],[title*="사이드바"],[aria-label*="사이드바"],.toc-resizer,#toc-resizer,.sidebar-resizer,#sidebar-resizer,[class*="resiz"],[id*="resiz"],[class*="split"],[id*="split"],[data-toc-resizer]')].filter(node => !isMain(node) && isResizerNode(node));
    const navigation = node => !!node?.querySelector?.('a[href],ol,ul,li,details,summary,button,[role="list"],[role="tree"],input[type="search"],input[placeholder*="검색"]');
    const namedNode = node => node?.matches?.(named) || /(?:^|[\s_-])(toc|contents?|목차)(?:$|[\s_-])/i.test(nodeName(node));
    const titled = node => {
      if (!node) return false;
      if (label(node.getAttribute?.('aria-label')) || label(node.getAttribute?.('data-title')) || label(node.getAttribute?.('title'))) return true;
      return [...(node.querySelectorAll?.('h1,h2,h3,h4,h5,h6,header,strong,div,span,[role="heading"],[data-toc-title],[data-title]') || [])].some(h => (h.childNodes?.length <= 3 && label(h.textContent)) || label(h.getAttribute?.('aria-label')));
    };
    let sidebar = null, resizer = null;
    for (const candidate of explicitResizers) {
      const ancestor = candidate.parentElement?.closest?.(named + ',aside,nav,[role="navigation"],[role="complementary"],#sidebar,.sidebar');
      if (ancestor && !isMain(ancestor) && !ancestor.querySelector?.('main,[role="main"],article,#main,#content') && (namedNode(ancestor) || titled(ancestor) || navigation(ancestor))) {
        sidebar = ancestor; resizer = candidate; break;
      }
      const prev = candidate.previousElementSibling;
      if (prev && !isMain(prev) && (namedNode(prev) || titled(prev) || navigation(prev))) {
        const inner = !namedNode(prev) && !['aside', 'nav'].includes(prev.localName) && prev.children?.length === 1 && (namedNode(prev.firstElementChild) || titled(prev.firstElementChild)) ? prev.firstElementChild : prev;
        sidebar = inner; resizer = candidate; break;
      }
    }
    if (!sidebar) {
      const candidates = [...this.doc.querySelectorAll(named + ',aside,nav,[role="navigation"],[role="complementary"],#sidebar,.sidebar')];
      sidebar = candidates.find(node => !isMain(node) && !isResizerNode(node) && navigation(node) && (namedNode(node) || titled(node))) || null;
    }
    if (!sidebar) {
      const headings = [...this.doc.querySelectorAll('h1,h2,h3,h4,h5,h6,header,strong,div,span,[role="heading"],[data-toc-title],[data-title],[aria-label]')].filter(node => {
        const text = (node.childNodes?.length <= 3 ? node.textContent : '') || '';
        return /^\s*(?:목차|차례|table of contents|contents)\s*$/i.test(text) || label(node.getAttribute?.('aria-label')) || label(node.getAttribute?.('data-title'));
      });
      for (const heading of headings) {
        for (let node = heading.parentElement, depth = 0; node && node !== this.doc.body && depth < 6; node = node.parentElement, depth++) {
          if (isMain(node) || node.querySelector?.('main,[role="main"]')) break;
          if (explicitResizers.some(r => node.contains(r) && r !== node && !heading.parentElement?.contains(r) && node.children.length >= 2)) break;
          if (navigation(node) && (namedNode(node) || ['aside', 'nav', 'section'].includes(node.localName) || node.parentElement === this.doc.body || node.nextElementSibling)) {
            sidebar = node; break;
          }
        }
        if (sidebar) break;
      }
    }
    if (!sidebar) return null;
    if (!resizer) {
      const internal = explicitResizers.find(r => sidebar.contains(r));
      if (internal) resizer = internal;
      else {
        for (let item = sidebar, depth = 0; item && item !== this.doc.body && depth < 4; item = item.parentElement, depth++) {
          const next = item.nextElementSibling;
          if (next && isResizerNode(next)) { resizer = next; break; }
        }
      }
    }
    return {sidebar, resizer};
  }
  analyzeTocLayout(sidebar, resizer) {
    let layoutParent = null, layoutKind = 'block', sidebarItem = sidebar, resizerItem = null, mainItem = null;
    let initialTokens = [], sidebarTrackIndex = -1, mainTrackIndex = -1;
    for (let item = sidebar, depth = 0; item?.parentElement && item !== this.doc.body && depth < 10; item = item.parentElement, depth++) {
      if (item.matches?.('main,[role="main"],article,#main,#content') || item.querySelector?.('main,[role="main"],article,#main,#content')) break;
      if (resizer && item !== sidebar && item.contains(resizer) && !sidebar.contains(resizer)) break;
      const parent = item.parentElement;
      const style = this.doc.defaultView?.getComputedStyle?.(parent);
      const display = style?.display || '';
      if (/grid/.test(display)) {
        const tokens = this.gridTrackTokens(style.gridTemplateColumns);
        if (tokens.length >= 2) {
          layoutParent = parent; layoutKind = 'grid'; sidebarItem = item;
          resizerItem = resizer ? this.gridItem(parent, resizer) : null;
          if (resizerItem === sidebarItem) resizerItem = null;
          initialTokens = tokens;
          const numericTracks = this.gridTracks(style.gridTemplateColumns);
          const rtl = String(style.direction || '').toLowerCase() === 'rtl';
          if (numericTracks.length === tokens.length) {
            sidebarTrackIndex = this.gridTrackIndex(parent, sidebarItem, numericTracks, style);
            mainTrackIndex = this.documentMainTrack(parent, sidebarItem, numericTracks, style, resizerItem);
          }
          if (sidebarTrackIndex < 0) sidebarTrackIndex = rtl ? tokens.length - 1 : 0;
          if (mainTrackIndex < 0 || mainTrackIndex === sidebarTrackIndex) mainTrackIndex = rtl ? 0 : tokens.length - 1;
          mainItem = [...parent.children].find(c => c !== sidebarItem && c !== resizerItem) || null;
          break;
        }
      }
      if (/flex/.test(display) && !/^column/i.test(style.flexDirection || '') && !layoutParent && parent.children.length >= 2) {
        layoutParent = parent; layoutKind = 'flex'; sidebarItem = item;
        resizerItem = resizer ? this.gridItem(parent, resizer) : null;
        if (resizerItem === sidebarItem) resizerItem = null;
        mainItem = [...parent.children].find(c => c !== sidebarItem && c !== resizerItem) || null;
        break;
      }
    }
    const chain = [];
    for (let node = sidebar; node && node !== layoutParent && node !== this.doc.body; node = node.parentElement) {
      chain.push(node);
      if (node === sidebarItem) break;
    }
    const rawMain = [...this.doc.querySelectorAll('main,[role="main"]')].filter(node => node !== sidebar && node !== sidebarItem && !node.contains(sidebar) && !sidebar.contains(node) && (!resizer || !node.contains(resizer)));
    const mainNodes = rawMain.length ? rawMain : (mainItem && (!resizer || !mainItem.contains(resizer)) ? [mainItem] : []);
    const sRect = (sidebarItem || sidebar).getBoundingClientRect?.();
    const rRect = resizer?.getBoundingClientRect?.();
    const resizerFollowsRightEdge = !!(resizer && sRect?.width > 0 && rRect && Math.abs((rRect.left + rRect.width / 2) - sRect.right) <= 24);
    const resizerEdgeOffset = resizerFollowsRightEdge ? Math.round(rRect.left - sRect.right) : 0;
    const rectWidth = sRect?.width || sidebar.getBoundingClientRect?.().width || 0;
    const styleWidth = Number.parseFloat(this.doc.defaultView?.getComputedStyle?.(sidebarItem)?.width) || Number.parseFloat(this.doc.defaultView?.getComputedStyle?.(sidebar)?.width) || (sidebarTrackIndex >= 0 ? Number.parseFloat(initialTokens[sidebarTrackIndex]) : 0) || 0;
    const defaultWidth = Math.round(rectWidth >= 48 ? rectWidth : styleWidth >= 48 ? styleWidth : TOC_DEFAULT);
    const customVars = this.detectTocCSSVariables();
    return {sidebar, resizer, layoutParent, layoutKind, sidebarItem, resizerItem, mainItem, chain, mainNodes, resizerFollowsRightEdge, resizerEdgeOffset, resizerLeftChecked: false, syncResizerLeft: false, initialTokens, sidebarTrackIndex, mainTrackIndex, defaultWidth, customVars};
  }
  detectTopbarCSSVariables() {
    const vars = new Set(['--header-height', '--topbar-height', '--header-h', '--topbar-h', '--navbar-height', '--toolbar-height', '--top-height', '--bar-height']);
    for (const style of this.doc?.querySelectorAll?.('style') || []) {
      if (style.id?.startsWith('htmlmemo-')) continue;
      const css = style.textContent || '';
      for (const match of css.matchAll(/--([a-z0-9_-]*(?:header|topbar|top-bar|navbar|nav-bar|appbar|toolbar|banner)[a-z0-9_-]*(?:height|size|h|offset)[a-z0-9_-]*)/gi)) vars.add('--' + match[1]);
      for (const match of css.matchAll(/calc\(\s*100(?:d|s|l)?vh\s*-\s*var\(\s*(--[a-z0-9_-]+)/gi)) {
        if (!/(?:width|left|right|toc-w|sidebar-w|htmlmemo)/i.test(match[1])) vars.add(match[1]);
      }
      for (const match of css.matchAll(/\btop\s*:\s*var\(\s*(--[a-z0-9_-]+)/gi)) {
        if (!/(?:width|left|right|toc-w|sidebar-w|htmlmemo)/i.test(match[1])) vars.add(match[1]);
      }
    }
    return [...vars];
  }
  findDocumentTopbar() {
    if (!this.doc?.body) return null;
    const sidebar = this.tocResize?.sidebar || null;
    const sidebarItem = this.tocResize?.sidebarItem || sidebar;
    const layoutParent = this.tocResize?.layoutParent || null;
    const isMainOrToc = node => {
      if (!node || node.nodeType !== 1) return true;
      if (node.closest?.('main,article,[role="main"],#' + LAYER_ID + ',[data-htmlmemo-ui]')) return true;
      if (node.querySelector?.('main,article,[role="main"]')) return true;
      if (sidebar && (node === sidebar || node === sidebarItem || sidebar.contains(node) || node.contains(sidebar))) return true;
      return false;
    };
    const explicitTopbar = '.topbar,#topbar,.top-bar,#top-bar,.book-header,#book-header,.reader-header,#reader-header,.doc-header,#doc-header,.app-header,#app-header,.navbar,#navbar,.nav-bar,#nav-bar,.toolbar,#toolbar,[role="toolbar"]';
    const hasControls = node => !!node?.querySelector?.('button,select,[role="button"],input[type="range"],input[type="search"]');
    const isBarGeometry = node => {
      const rect = node.getBoundingClientRect?.();
      if (!rect || (rect.width === 0 && rect.height === 0)) return true;
      return rect.height > 0 && rect.height <= 110 && rect.top <= 48;
    };
    const candidates = [
      ...this.doc.querySelectorAll(explicitTopbar + ',header,[role="banner"],.header,#header'),
      layoutParent?.previousElementSibling,
      sidebarItem?.previousElementSibling,
      this.doc.body.firstElementChild,
      this.doc.body.firstElementChild?.firstElementChild,
    ].filter(Boolean);
    const seen = new Set();
    for (const node of candidates) {
      if (seen.has(node)) continue;
      seen.add(node);
      if (isMainOrToc(node) || !isBarGeometry(node)) continue;
      if (node.matches?.(explicitTopbar) || hasControls(node)) return node;
      if (sidebar && node.matches?.('header,[role="banner"],.header,#header') && !node.querySelector?.('p')) return node;
    }
    return null;
  }
  setupDocumentTopbar() {
    if (this.disposed || !this.doc?.body) return null;
    const topbar = this.findDocumentTopbar();
    if (!topbar) { this.topbarNode = null; return null; }
    this.topbarNode = topbar;
    const cs = el => this.doc.defaultView?.getComputedStyle?.(el);
    const initialHeight = Math.round(topbar.getBoundingClientRect?.().height || Number.parseFloat(cs(topbar)?.height) || 0);
    this.topbarCustomVars = this.detectTopbarCSSVariables();
    this.doc.documentElement.setAttribute('data-htmlmemo-topbar-active', '');
    topbar.setAttribute('data-htmlmemo-doc-topbar', '');
    this.viewport?.style?.setProperty?.('padding-top', '0px');
    const topbarItem = topbar.parentElement && topbar.parentElement !== this.doc.body && topbar.parentElement.children?.length === 1 ? topbar.parentElement : topbar;
    if (topbarItem !== topbar) topbarItem.setAttribute('data-htmlmemo-doc-topbar-item', '');
    const rowParent = topbarItem.parentElement;
    if (rowParent && rowParent.children?.length >= 2 && rowParent.firstElementChild === topbarItem) {
      const parentStyle = cs(rowParent);
      if (/grid/.test(parentStyle?.display || '')) {
        const rowTokens = this.gridTrackTokens(parentStyle.gridTemplateRows);
        if (rowTokens.length === 2) {
          rowParent.setAttribute('data-htmlmemo-topbar-grid', '');
          rowParent.style?.setProperty?.('--htmlmemo-topbar-grid-rows', '24px minmax(0,1fr)');
        }
      }
    }
    this.setupEditorTocVars();
    if (initialHeight > 28) {
      const nearInitial = value => Math.abs((Number.parseFloat(value) || 0) - initialHeight) <= 4;
      for (const padTarget of [this.doc.body, this.tocResize?.layoutParent, rowParent].filter(Boolean)) {
        if (nearInitial(cs(padTarget)?.paddingTop)) padTarget.setAttribute('data-htmlmemo-topbar-pad', '');
      }
      for (const offsetTarget of [this.tocResize?.layoutParent, this.tocResize?.sidebarItem, this.tocResize?.sidebar, this.tocResize?.resizer].filter(Boolean)) {
        const st = cs(offsetTarget);
        if (/^(?:fixed|sticky|absolute)$/i.test(st?.position || '') && nearInitial(st?.top)) offsetTarget.setAttribute('data-htmlmemo-topbar-offset', '');
      }
    }
    return topbar;
  }
  setupReadingControls() {
    if(this.disposed||this.preparing||!this.host?.ownerDocument)return;
    const topbar=this.topbarNode?.isConnected?this.topbarNode:this.findDocumentTopbar();
    if(topbar&&topbar!==this.topbarNode)this.setupDocumentTopbar();
    // Imported HTML supplies content and layout, never a second TTS engine.
    const target=topbar?(topbar.querySelector('.controls,.toolbar-actions,.reader-actions')||topbar):this.host;
    const doc=target.ownerDocument;
    if(!this.readingControls||this.readingControls.ownerDocument!==doc){
      this.readingControls?.remove();this.speechControls?.remove();
      const group=label=>{
        const node=doc.createElement('div');node.className='htmlmemo-reading-controls';
        node.style.position='relative';node.style.zIndex='1';
        node.setAttribute('data-htmlmemo-ui','');node.setAttribute('data-htmlmemo-reading-controls','');
        node.setAttribute('role','toolbar');node.setAttribute('aria-label',label);return node;
      };
      const button=(action,label,text)=>{
        const node=doc.createElement('button');node.type='button';node.dataset.action=action;node.title=label;node.setAttribute('aria-label',label);node.textContent=text;
        node.onpointerdown=event=>{if(event.pointerType==='mouse')event.preventDefault();};
        node.onclick=()=>this.callbacks.onReadingAction?.(action,node);return node;
      };
      const controls=group('읽기 도구');
      this.zoomControl=button('zoom','확대 / 축소','');this.zoomControl.setAttribute('aria-haspopup','dialog');
      this.speechControl=button('speak','소리내어 읽기 (TTS 툴바)','');this.speechControl.innerHTML=icon('speaker',14);
      this.speechControls=group('소리내어 읽기');this.speechControls.append(this.speechControl);
      controls.append(this.zoomControl);
      this.readingControls=controls;
    }
    if(topbar){
      if(!doc.getElementById('htmlmemo-reading-controls-style')){
        const style=doc.createElement('style');style.id='htmlmemo-reading-controls-style';style.textContent=this.readingControlsStyle();doc.head.append(style);
      }
      if(this.readingControls.parentElement!==target)target.append(this.readingControls);
      // Keep source font buttons and their handlers intact. Insert immediately
      // before A−, even when the book nests its font controls in another group.
      const smaller=[...topbar.querySelectorAll('button,[role="button"]')].find(node=>!node.closest('[data-htmlmemo-ui]')&&(
        /^A[−–-]$/i.test(node.textContent.replace(/\s+/g,''))||/^(?:글자|글씨|폰트)\s*(?:작게|줄이기|축소)$/.test(node.getAttribute('aria-label')||node.title||'')
      ));
      const parent=smaller?.parentElement||target;
      const before=smaller||[...target.children].find(node=>!node.hasAttribute('data-htmlmemo-reading-controls'))||this.readingControls;
      if(this.speechControls.parentElement!==parent||this.speechControls.nextSibling!==before)parent.insertBefore(this.speechControls,before);
    }else{
      if(this.speechControl.parentElement!==this.readingControls)this.readingControls.prepend(this.speechControl);
      if(this.readingControls.parentElement!==this.host)this.host.prepend(this.readingControls);
    }
    const group=topbar&&target!==topbar?target:null;
    if(this.readingControlsGroup!==group){
      this.readingControlsGroup?.removeAttribute('data-htmlmemo-reading-controls-group');this.readingControlsGroup?.style.removeProperty('--htmlmemo-controls-shift');
      this.readingControlsGroup=group;group?.setAttribute('data-htmlmemo-reading-controls-group','');
    }
    this.host.classList.toggle('reader-controls-row',!topbar);
    this.updateReadingControls();
  }
  readingControlsStyle() {
    return '[data-htmlmemo-reading-controls-group]{translate:var(--htmlmemo-controls-shift,0px) 0px!important}[data-htmlmemo-reading-controls]{display:inline-flex!important;align-items:center!important;gap:3px!important;flex:0 0 auto!important;vertical-align:middle!important;margin-inline-start:4px!important}[data-htmlmemo-reading-controls] button{box-sizing:border-box!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;font:500 12px/18px system-ui!important;letter-spacing:0!important;white-space:nowrap!important;width:auto!important;min-width:40px!important;height:20px!important;padding:0 5px!important;border:1px solid currentColor!important;border-radius:4px!important;background:transparent!important;color:inherit!important;cursor:pointer!important}[data-htmlmemo-reading-controls] [data-action=speak]{width:24px!important;min-width:24px!important;padding:0!important}[data-htmlmemo-reading-controls] svg{display:block!important;width:14px!important;height:14px!important;pointer-events:none!important}[data-htmlmemo-reading-controls] button:hover{background:#80808020!important}[data-htmlmemo-reading-controls] button:focus-visible{outline:2px solid currentColor!important;outline-offset:1px!important}[data-htmlmemo-reading-controls] [hidden]{display:none!important}';
  }
  updateReadingControls() {
    if(this.zoomControl){const text=Math.round(this.zoom*100)+'%';if(this.zoomControl.textContent!==text)this.zoomControl.textContent=text;}
    if(!this.readingControls||this.readingControls.ownerDocument!==this.doc||!this.frame?.getBoundingClientRect||!this.viewport?.getBoundingClientRect)return;
    // Move a source action group together when it fits. Pinning just zoom can
    // put it over the book's previous/next buttons after horizontal panning.
    const view=this.viewport.getBoundingClientRect(),frame=this.frame.getBoundingClientRect();if(!view.width||!frame.width)return;
    const scale=frame.width/this.frame.offsetWidth,group=this.readingControlsGroup?.isConnected?this.readingControlsGroup:null;
    const grouped=!!group;
    const controls=grouped?group:this.readingControls;
    if(grouped){this.readingControls.style.removeProperty('--htmlmemo-controls-shift');this.readingControls.style.removeProperty('transform');}
    else group?.style.removeProperty('--htmlmemo-controls-shift');
    const rect=controls.getBoundingClientRect?.();if(!rect?.width)return;
    const previous=Number.parseFloat(controls.style.getPropertyValue('--htmlmemo-controls-shift'))||0;
    const min=(view.left+2-frame.left)/scale-rect.left+previous,max=(view.right-2-frame.left)/scale-rect.right+previous;
    // A group wider than the viewport keeps its normal horizontal pan. Moving
    // only its zoom button would cover source controls inside that same group.
    const shift=grouped&&rect.width*scale>view.width-4?0:Math.max(min,Math.min(0,max)),value=shift.toFixed(2)+'px';
    if(controls.style.getPropertyValue('--htmlmemo-controls-shift')!==value)controls.style.setProperty('--htmlmemo-controls-shift',value);
    if(!grouped)this.readingControls.style.transform='translateX(var(--htmlmemo-controls-shift))';
  }
  ensureDocumentTocResize() {
    if (this.disposed || !this.doc?.body) return null;
    if (this.tocResize?.sidebar?.isConnected && (!this.tocResize.resizer || this.tocResize.resizer.isConnected)) {
      if (!this.documentSidebarUI?.isConnected) this.setupDocumentSidebar();
      if (!this.topbarNode?.isConnected) this.setupDocumentTopbar();
      return this.tocResize;
    }
    if (this.tocChecked && !this.tocResize) return null;
    return this.setupDocumentTocResize();
  }
  setupDocumentTocResize() {
    if (this.disposed || !this.doc?.body) return null;
    this.tocChecked = true;
    this.tocApplied = false;
    const parts = this.findDocumentTocParts();
    if (!parts) { this.tocResize = null; this.setupDocumentTopbar(); return null; }
    const info = this.analyzeTocLayout(parts.sidebar, parts.resizer);
    this.tocResize = info;
    this.tocDefaultWidth = info.defaultWidth;
    this.setupEditorTocVars(info.customVars, info.defaultWidth);
    if (info.resizer) {
      info.resizer.setAttribute('data-htmlmemo-toc-resizer-bound', '');
      info.resizer.setAttribute('aria-valuemin', String(TOC_MIN));
      info.resizer.setAttribute('aria-valuemax', String(this.maxTocWidth()));
    }
    const store = this.storage();
    let savedExpanded = null, savedWidth = null;
    try { savedExpanded = store?.getItem(TOC_EXPANDED_WIDTH_KEY); savedWidth = store?.getItem(TOC_WIDTH_KEY); } catch { /* ignore */ }
    const parsedExpanded = savedExpanded !== null && savedExpanded !== '' ? Number(savedExpanded) : NaN;
    this.tocExpandedWidth = Number.isFinite(parsedExpanded) && parsedExpanded >= TOC_STRIP_SNAP ? this.clampTocWidth(parsedExpanded, true) : info.defaultWidth;
    const initialSaved = savedWidth !== null && savedWidth !== '' ? Number(savedWidth) : Number.isFinite(this.metadata?.view?.tocWidth) ? Number(this.metadata.view.tocWidth) : null;
    if (initialSaved !== null && Number.isFinite(initialSaved)) {
      this.applyTocWidth(initialSaved, {persist: false, snapStrip: true});
    } else {
      this.tocWidth = info.defaultWidth;
      this.tocStrip = false;
      if (info.resizer) info.resizer.setAttribute('aria-valuenow', String(this.tocWidth));
    }
    this.setupDocumentTopbar();
    this.setupDocumentSidebar();
    return info;
  }
  setupDocumentSidebar() {
    const sidebar=this.tocResize?.sidebar;
    if(this.preparing||this.disposed||!sidebar?.isConnected||!this.callbacks?.onSidebarView)return;
    if(this.documentSidebarUI?.isConnected&&sidebar.contains(this.documentSidebarUI))return;
    const panel=this.doc.createElement('section');panel.setAttribute('data-htmlmemo-ui','');panel.setAttribute('data-htmlmemo-doc-sidebar-ui','');
    // Keep the source TOC in place; the native search is parked separately below.
    // Exported books use .nav-head > strong, not necessarily a heading tag.
    // Do not mistake a chapter named "목차" or an editor tab for this label.
    const title=[...sidebar.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"],.nav-head > strong')].find(node=>node.textContent.trim()==='목차'&&!node.closest('[data-htmlmemo-ui],#reader-tree,details,summary,a,button'));
    title?.setAttribute('data-htmlmemo-redundant-toc-title','');
    sidebar.setAttribute('data-htmlmemo-native-sidebar','');sidebar.prepend(panel);this.documentSidebarUI=panel;
    panel.addEventListener('click',event=>{if(!event.target.closest('[data-htmlmemo-book-search]'))event.stopPropagation();});
    this.setupDocumentBookSearch();
    this.showDocumentSidebarView(this.documentSidebarMode||'outline');
  }
  showDocumentSidebarView(mode) {
    if(!['outline','search','annotations','bookmarks'].includes(mode)||!this.documentSidebarUI?.isConnected)return;
    const sidebar=this.tocResize.sidebar,previous=this.documentSidebarMode||'outline';
    this.setupDocumentBookSearch();
    const search=this.documentBookSearchHost;
    // Park the live source controls outside the region about to be re-rendered.
    if(search){search.hidden=true;this.documentSidebarUI.append(search);}
    if(mode!=='outline'&&this.tocStrip){
      this.applyTocWidth(Math.max(TOC_STRIP_SNAP,this.tocExpandedWidth||this.tocDefaultWidth||TOC_DEFAULT),{persist:true,snapStrip:true});
      this.syncAfterTocResize();
    }
    if(previous==='outline'&&mode!=='outline')this.documentTocScrollTop=sidebar.scrollTop;
    this.documentSidebarMode=mode;sidebar.setAttribute('data-htmlmemo-sidebar-view',mode);
    this.callbacks.onSidebarView(mode,this.documentSidebarUI,this);
    if(search){if(mode==='search'){this.documentSidebarUI.querySelector('.sidebar-content').prepend(search);search.hidden=false;}else this.documentSidebarUI.append(search);}
    this.syncDocumentBookSearchResults();
    if(mode==='outline'&&Number.isFinite(this.documentTocScrollTop))sidebar.scrollTop=this.documentTocScrollTop;
    else if(mode!==previous)sidebar.scrollTop=0;
  }
  refreshDocumentSidebar() {
    this.callbacks.onSidebarCounts?.(this.documentSidebarUI,this);
    if(['annotations','bookmarks'].includes(this.documentSidebarMode))this.showDocumentSidebarView(this.documentSidebarMode);
  }
  collapseDocumentToc() {
    const sidebar=this.tocResize?.sidebar;
    if(this.preparing||this.disposed||!sidebar?.isConnected)return;
    // Keep source nodes/listeners and the app panel; only fold source TOC branches.
    for(const group of sidebar.querySelectorAll('details')){
      if(group.closest('[data-htmlmemo-ui]'))continue;
      group.open=false;group.removeAttribute('open');
    }
    const folded=new Set();
    for(const trigger of sidebar.querySelectorAll('[aria-expanded],[aria-controls],[data-target],[data-controls],[data-toggle],.toc-header,.toc-title,.toc-toggle,.toc-cat,.group-header,.section-header,.folder')){
      let container;try{container=this.findTocSubContainer(trigger);}catch{continue;}
      if(!container||container===sidebar||container.closest('[data-htmlmemo-ui]')||(this.documentSidebarUI&&container.contains(this.documentSidebarUI))||folded.has(container))continue;
      folded.add(container);this.toggleTocSubContainer(trigger,container,false);
    }
  }
  setupDocumentBookSearch() {
    const sidebar=this.tocResize?.sidebar;if(this.documentBookSearchHost||!sidebar)return;
    const input=[...sidebar.querySelectorAll('input')].find(node=>!node.closest('[data-htmlmemo-ui]')&&/책\s*전체\s*검색/.test((node.getAttribute('placeholder')||'')+' '+(node.getAttribute('aria-label')||'')));
    if(!input)return;
    let unit=input;
    for(let parent=input.parentElement;parent&&parent!==sidebar;parent=parent.parentElement){
      const search=parent.matches('form,label,[role="search"]')||/search|find/i.test((parent.id||'')+' '+(parent.className||''));
      if(parent.querySelector('#reader-tree,[data-htmlmemo-doc-sidebar-ui]')||(!search&&parent.querySelector('details,summary,h1,h2,h3,.nav-head')))break;
      if(search)unit=parent;
    }
    const parts=[unit];
    for(let sibling=unit.nextElementSibling;sibling&&/search|find/i.test((sibling.id||'')+' '+(sibling.className||''))&&!sibling.matches('#reader-tree')&&!sibling.querySelector('#reader-tree');sibling=sibling.nextElementSibling)parts.push(sibling);
    const host=this.doc.createElement('div');host.setAttribute('data-htmlmemo-book-search','');host.className='sidebar-book-search';host.setAttribute('role','group');host.setAttribute('aria-label','책 전체 검색');host.hidden=true;
    parts.forEach((node,index)=>{
      const key=String(index),slot=this.doc.createElement('span');slot.setAttribute('data-htmlmemo-book-search-slot',key);slot.hidden=true;
      // Source UI text used to contribute to body offsets. Keep its original
      // text (not scripts/styles) in the hidden slot so existing anchors do not shift.
      slot.textContent=textIndex(this.doc,node).text;
      node.before(slot);node.setAttribute('data-htmlmemo-book-search-part',key);host.append(node);
    });
    this.documentBookSearchHost=host;
    this.documentBookSearchInput=input;
    // Packed readers render their actual search results in the original TOC.
    // Keep that live tree (including its handlers), not just the count beside
    // the input. It is returned to its original position for the outline view.
    const tree=sidebar.querySelector('#reader-tree');
    if(tree&&!host.contains(tree)){
      this.documentBookSearchTree=tree;
      const results=this.doc.createElement('section');results.className='sidebar-book-results';results.setAttribute('aria-label','책 전체 검색 결과');results.hidden=true;
      const hint=this.doc.createElement('p');hint.className='sidebar-book-search-hint';hint.textContent='검색 결과를 누르면 해당 장의 검색어로 이동합니다.';
      const navigation=this.doc.createElement('div');navigation.className='search-navigation';
      const status=this.doc.createElement('span');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
      navigation.append(status);
      for(const [direction,label,name] of [[-1,'이 장의 이전 검색어','back'],[1,'이 장의 다음 검색어','forward']]){
        const button=this.doc.createElement('button');button.type='button';button.className='icon-button';button.setAttribute('data-book-search-step',String(direction));button.setAttribute('aria-label',label);button.title=label;button.innerHTML=icon(name,14);button.disabled=true;
        button.onclick=()=>this.stepDocumentBookSearch(direction);navigation.append(button);
      }
      results.append(hint,navigation);host.append(results);this.documentBookSearchResults=results;this.documentBookSearchStatus=status;
      host.addEventListener('click',event=>{
        const target=event.target.closest?.('a[href],button[data-section],button[data-key]');
        if(!target||!tree.contains(target)||!input.value.trim())return;
        const section=this.documentBookSearchSection(target);if(!section)return;
        event.preventDefault();void this.jumpDocumentBookSearch(section,input.value.trim());
      },true);
      const observer=new this.doc.defaultView.MutationObserver(()=>this.syncDocumentBookSearchResults());
      observer.observe(tree,{subtree:true,childList:true,characterData:true});this.documentBookSearchObserver=observer;
    }
    host.addEventListener('input',event=>{if(event.target===input)this.syncDocumentBookSearchResults();});
    host.addEventListener('click',()=>this.syncDocumentBookSearchResults());
  }
  documentBookSearchSection(node) {
    let key=node.dataset.section||node.dataset.key||'',href=node.getAttribute('href')||'';
    if(href.startsWith('#')){try{key=decodeURIComponent(href.slice(1));}catch{return '';}}
    return this.annotationBookPaths().has(key)?key:'';
  }
  syncDocumentBookSearchResults() {
    const tree=this.documentBookSearchTree,results=this.documentBookSearchResults;if(!tree||!results)return;
    const query=this.documentBookSearchInput.value.trim(),active=this.documentSidebarMode==='search'&&!!query;
    if(query!==this.documentBookSearchQuery){
      this.documentBookSearchQuery=query;this.bookSearchJumpGeneration=(this.bookSearchJumpGeneration||0)+1;this.cancelBookSearchJump?.();this.bookSearchHit=null;this.clearDocumentBookSearchHighlight();
      this.documentBookSearchStatus.textContent='';
    }
    if(active&&!results.contains(tree)){
      const slot=this.doc.createElement('span');slot.hidden=true;slot.setAttribute('data-htmlmemo-book-search-slot','results');slot.textContent=textIndex(this.doc,tree).text;
      tree.before(slot);tree.setAttribute('data-htmlmemo-book-search-part','results');results.insertBefore(tree,results.lastElementChild);this.documentBookSearchTreeSlot=slot;
    }else if(!active&&this.documentBookSearchTreeSlot){
      this.documentBookSearchTreeSlot.replaceWith(tree);tree.removeAttribute('data-htmlmemo-book-search-part');this.documentBookSearchTreeSlot=null;
      for(const [group,wasOpen] of this.documentBookSearchGroups||[])if(group.isConnected){group.toggleAttribute('open',wasOpen);group.removeAttribute('data-htmlmemo-book-search-open');}
      this.documentBookSearchGroups=new Map();this.bookSearchJumpGeneration=(this.bookSearchJumpGeneration||0)+1;this.cancelBookSearchJump?.();
    }
    results.hidden=!active;
    if(active){
      this.documentBookSearchGroups ||= new Map();
      for(const group of this.documentBookSearchGroups.keys())if(!group.isConnected)this.documentBookSearchGroups.delete(group);
      for(const group of tree.querySelectorAll('details'))if(!this.documentBookSearchGroups.has(group)){const wasOpen=group.hasAttribute('open');this.documentBookSearchGroups.set(group,wasOpen);group.setAttribute('data-htmlmemo-book-search-open',String(wasOpen));group.setAttribute('open','');}
    }
    for(const button of results.querySelectorAll('[data-book-search-step]'))button.disabled=!this.bookSearchHit||this.bookSearchHit.count<2||this.bookSearchHit.section!==currentSection(this.doc);
  }
  clearDocumentBookSearchHighlight() {
    this.doc.defaultView.CSS?.highlights?.delete('htmlmemo-book-search');
    const clear=()=>{
      this.bookSearchMarks ||= [...this.doc.querySelectorAll('[data-htmlmemo-book-search-hit]')];
      for(const mark of this.bookSearchMarks)if(mark.isConnected)mark.replaceWith(...mark.childNodes);
      this.bookSearchMarks=[];
    };
    if(this.searchIndexCache)this.searchIndexCache.mutate(null,clear,false);else clear();
  }
  stepDocumentBookSearch(direction=0,{move=true}={}) {
    this.clearDocumentBookSearchHighlight();
    const hit=this.bookSearchHit,content=this.doc.getElementById('reader-content');
    if(!hit||hit.query!==this.documentBookSearchInput?.value.trim()||!content)return false;
    if(hit.section!==currentSection(this.doc)){this.documentBookSearchStatus.textContent='다른 검색 결과를 선택하세요.';this.syncDocumentBookSearchResults();return false;}
    const {index,results:matches}=this.searchCache().query(hit.query,content);
    hit.count=matches.length;
    if(!matches.length){this.documentBookSearchStatus.textContent='이 장의 제목·검색 정보는 일치하지만 본문에서 검색어를 찾지 못했습니다.';for(const button of this.documentBookSearchResults.querySelectorAll('[data-book-search-step]'))button.disabled=true;return false;}
    hit.position=(hit.position+direction+matches.length)%matches.length;
    const match=matches[hit.position],range=rangeFromOffsets(this.doc,match.start,match.end,index);if(!range)return false;
    const win=this.doc.defaultView;
    if(win.CSS?.highlights&&win.Highlight)win.CSS.highlights.set('htmlmemo-book-search',new win.Highlight(range));
    else this.bookSearchMarks=this.searchCache().mutate(index,()=>wrapOffsets(this.doc,match.start,match.end,{'data-htmlmemo-search':'','data-htmlmemo-book-search-hit':''},'background:#f0a85b80;outline:2px solid #df9057;border-radius:2px;color:inherit',index));
    if(move){const rect=range.getBoundingClientRect(),origin=this.layerOrigin();this.scrollTop=Math.max(0,(rect.top-origin.top+rect.height/2)*this.zoom-this.viewport.clientHeight/2);this.scrollLeft=Math.max(0,(rect.left-origin.left+rect.width/2)*this.zoom-this.viewport.clientWidth/2);}
    this.documentBookSearchStatus.textContent=`이 장에서 ${hit.position+1} / ${matches.length}${matches.length===3000?'+':''}`;
    for(const button of this.documentBookSearchResults.querySelectorAll('[data-book-search-step]'))button.disabled=matches.length<2;
    return true;
  }
  async jumpDocumentBookSearch(section,query) {
    this.syncDocumentBookSearchResults();
    this.cancelBookSearchJump?.();const generation=this.bookSearchJumpGeneration=(this.bookSearchJumpGeneration||0)+1;
    if(!query||!this.annotationBookPaths().has(section))return false;
    this.bookSearchHit=null;this.syncDocumentBookSearchResults();this.documentBookSearchStatus.textContent='검색어가 있는 장을 여는 중…';
    try{
      if(currentSection(this.doc)!==section){
        const loaded=await new Promise(resolve=>{
          let settled=false;
          const finish=value=>{if(settled)return;settled=true;observer.disconnect();clearTimeout(timer);this.cancelBookSearchJump=null;resolve(value);};
          const ready=()=>currentSection(this.doc)===section&&!this.doc.getElementById('reader-status')?.textContent.trim();
          const observer=new this.doc.defaultView.MutationObserver(()=>{if(ready())finish(true);});
          const timer=setTimeout(()=>finish(false),15000);this.cancelBookSearchJump=()=>finish(false);
          observer.observe(this.doc.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['data-section']});
          try{this.doc.defaultView.location.hash=encodeURIComponent(section);if(ready())finish(true);}catch{finish(false);}
        });
        if(this.disposed||generation!==this.bookSearchJumpGeneration||this.documentSidebarMode!=='search'||query!==this.documentBookSearchInput.value.trim())return false;
        if(!loaded)throw new Error('검색 결과의 장을 불러오지 못했습니다. 결과를 다시 선택해 주세요.');
        this.dynamicRoots?.add(this.doc.getElementById('reader-content'));await this.refreshDynamicDocument();
      }
      if(this.disposed||generation!==this.bookSearchJumpGeneration||this.documentSidebarMode!=='search'||query!==this.documentBookSearchInput.value.trim())return false;
      this.bookSearchHit={section,query,position:0};this.render();this.measure();
      const found=this.stepDocumentBookSearch();if(!found)this.jump(this.doc.getElementById('reader-content'));
      this.callbacks.onView?.();return true;
    }catch(error){if(!this.disposed&&generation===this.bookSearchJumpGeneration){this.documentBookSearchStatus.textContent=error.message;this.callbacks.onError?.(error);}return false;}
  }
  applyTocWidth(value, {persist = false, snapStrip = true} = {}) {
    const info = this.tocResize?.sidebar?.isConnected ? this.tocResize : this.ensureDocumentTocResize();
    if (!info?.sidebar?.isConnected) return TOC_DEFAULT;
    const width = this.clampTocWidth(value, snapStrip);
    const strip = width < TOC_STRIP_SNAP;
    if (!strip && (persist || width >= 96)) {
      this.tocExpandedWidth = width;
      if (persist) { try { this.storage()?.setItem(TOC_EXPANDED_WIDTH_KEY, String(width)); } catch { /* ignore */ } }
    }
    if (!persist && this.tocApplied && width === this.tocWidth && strip === this.tocStrip) return width;
    const prevStrip = !!this.tocStrip;
    if (strip && !prevStrip) this.tocScrollTop = info.sidebar.scrollTop || 0;
    this.tocWidth = width;
    this.tocResizedWidth = width;
    this.tocStrip = strip;
    const {sidebar, sidebarItem, resizer, layoutParent, layoutKind, chain, mainNodes, initialTokens, sidebarTrackIndex, mainTrackIndex} = info;
    if (!this.tocApplied) {
      this.tocApplied = true;
      this.doc.documentElement.setAttribute('data-htmlmemo-toc-active', '');
      sidebar.setAttribute('data-htmlmemo-toc-sidebar', '');
      for (const node of chain || []) if (node !== sidebar) node.setAttribute('data-htmlmemo-toc-item', '');
      for (const node of mainNodes || []) node.setAttribute('data-htmlmemo-toc-main', '');
      if (layoutKind === 'grid' && layoutParent && initialTokens.length >= 2 && sidebarTrackIndex >= 0) layoutParent.setAttribute('data-htmlmemo-sidebar-grid', '');
      else if (layoutKind === 'flex' && sidebarItem) sidebarItem.setAttribute('data-htmlmemo-sidebar-flex', '');
      if (resizer) resizer.setAttribute('data-htmlmemo-toc-resizer-bound', '');
    }
    const px = width + 'px';
    this.doc.documentElement.style?.setProperty?.('--htmlmemo-toc-width', px);
    this.doc.body.style?.setProperty?.('--htmlmemo-toc-width', px);
    if (layoutParent) layoutParent.style?.setProperty?.('--htmlmemo-toc-width', px);
    for (const node of chain || [sidebar]) node.style?.setProperty?.('--htmlmemo-toc-width', px);
    if (resizer) resizer.style?.setProperty?.('--htmlmemo-toc-width', px);
    if (sidebarItem && sidebarItem !== sidebar && (strip !== prevStrip || persist)) {
      for (const node of chain || []) if (node !== sidebar) node.toggleAttribute('data-htmlmemo-toc-item-strip', strip);
    }
    if (strip !== prevStrip || persist || sidebar.hasAttribute('data-htmlmemo-toc-strip') !== strip) {
      sidebar.toggleAttribute('data-htmlmemo-toc-strip', strip);
      sidebar.toggleAttribute('data-htmlmemo-toc-collapsed', strip);
    }
    if (layoutKind === 'grid' && layoutParent && initialTokens.length >= 2 && sidebarTrackIndex >= 0) {
      const columns = initialTokens.map((token, idx) => idx === sidebarTrackIndex ? px : idx === mainTrackIndex ? 'minmax(0,1fr)' : token).join(' ');
      layoutParent.style?.setProperty?.('--htmlmemo-toc-grid-columns', columns);
    }
    if (resizer && info.resizerFollowsRightEdge) {
      if (!info.resizerLeftChecked && Math.abs(width - info.defaultWidth) >= 2) {
        info.resizerLeftChecked = true;
        const sNow = (sidebarItem || sidebar).getBoundingClientRect?.();
        const rNow = resizer.getBoundingClientRect?.();
        if (sNow?.width > 0 && rNow && Math.abs((rNow.left + rNow.width / 2) - sNow.right) > 6) {
          info.syncResizerLeft = true;
          if (!resizer.hasAttribute('data-htmlmemo-toc-resizer-bound-left')) {
            resizer.setAttribute('data-htmlmemo-toc-resizer-bound-left', resizer.style?.getPropertyValue?.('left') || '');
          }
        }
      }
      if (info.syncResizerLeft) {
        const baseLeft = this.tocDrag ? this.tocDrag.sidebarLeft : ((sidebarItem || sidebar).getBoundingClientRect?.().left || 0);
        resizer.style?.setProperty?.('left', (baseLeft + width + info.resizerEdgeOffset) + 'px', 'important');
      }
    }
    if (!strip && prevStrip && this.tocScrollTop != null) info.sidebar.scrollTop = this.tocScrollTop;
    if (persist) {
      if (resizer) resizer.setAttribute('aria-valuenow', String(width));
      try { this.storage()?.setItem(TOC_WIDTH_KEY, String(width)); } catch { /* ignore */ }
      this.callbacks.onPreferenceChange?.();
      if (this.metadata?.view) this.metadata.view.tocWidth = width;
    }
    return width;
  }
  syncAfterTocResize() {
    if (!this.nativeScroll) this.measure();
    if (this.metadata?.annotations?.some(a => !TEXT_TOOLS.includes(a.type))) this.renderDrawingLayer();
  }
  resetTocWidth() {
    const info = this.ensureDocumentTocResize();
    if (!info?.sidebar?.isConnected) return;
    const target = this.tocDefaultWidth || info.defaultWidth || TOC_DEFAULT;
    this.applyTocWidth(target, {persist: true, snapStrip: true});
    this.syncAfterTocResize();
  }
  eventDocX(event) {
    if (!event || !Number.isFinite(event.clientX)) return NaN;
    const hostDoc = this.host?.ownerDocument;
    const fromHost = hostDoc && hostDoc !== this.doc && (event.view === hostDoc.defaultView || event.target?.ownerDocument === hostDoc);
    if (fromHost) {
      const rect = this.tocDrag?.frameRect || this.frame?.getBoundingClientRect?.();
      if (rect) return (event.clientX - rect.left) / (this.zoom || 1);
    }
    return event.clientX;
  }
  isInsideTocSidebar(node) {
    const el = node?.nodeType === 1 ? node : node?.parentElement;
    if (!el) return false;
    const sidebar = this.tocResize?.sidebar;
    const sidebarItem = this.tocResize?.sidebarItem;
    if (sidebar && (el === sidebar || sidebar.contains?.(el) || (sidebarItem && (el === sidebarItem || sidebarItem.contains?.(el))))) return true;
    return !!el.closest?.('[data-htmlmemo-toc-sidebar],[data-htmlmemo-toc-item],[data-htmlmemo-native-sidebar],[data-htmlmemo-doc-sidebar-ui],aside,nav,[role="navigation"],.toc,#toc,.sidebar,#sidebar');
  }
  isInsideTocOrTopbar(node) {
    const el = node?.nodeType === 1 ? node : node?.parentElement;
    if (!el) return false;
    if (this.isInsideTocSidebar(el)) return true;
    if (this.topbarNode && (el === this.topbarNode || this.topbarNode.contains?.(el))) return true;
    return !!el.closest?.('[data-htmlmemo-doc-topbar],[data-htmlmemo-doc-topbar-item]');
  }
  isInteractiveControl(node) {
    const el = node?.nodeType === 1 ? node : node?.parentElement;
    if (!el) return false;
    if (this.isInsideTocOrTopbar(el)) return true;
    return !!el.closest?.('summary,button,[role="button"],input,select,textarea,label,[data-htmlmemo-toc-resizer],[data-htmlmemo-toc-resizer-bound]');
  }
  isTocResizerNode(node) {
    const el = node?.nodeType === 1 ? node : node?.parentElement;
    if (!el) return false;
    const resizer = this.tocResize?.resizer;
    if (resizer && (el === resizer || resizer.contains?.(el))) return true;
    return !!el.closest?.('[data-htmlmemo-toc-resizer],[data-htmlmemo-toc-resizer-bound],.toc-resizer,#toc-resizer,[title*="목차 폭"],[aria-label*="목차 폭"]');
  }
  isTocResizeTarget(event) {
    const info = this.ensureDocumentTocResize();
    if (!info?.sidebar?.isConnected) return false;
    const {sidebar, sidebarItem} = info;
    const target = event?.target?.nodeType === 1 ? event.target : event?.target?.parentElement;
    if (this.isTocResizerNode(target)) return true;
    const isStrip = sidebar.hasAttribute('data-htmlmemo-toc-strip');
    if (isStrip && target && (target === sidebar || sidebar.contains?.(target) || (sidebarItem && (target === sidebarItem || sidebarItem.contains?.(target))))) return true;
    if (!isStrip && target && target !== sidebar && target !== sidebarItem) return false;
    const rect = (sidebarItem || sidebar).getBoundingClientRect?.();
    const clientX = this.eventDocX(event);
    return !!(rect && rect.width > 0 && Number.isFinite(clientX) && clientX >= rect.right - 10 && clientX <= rect.right + 12 && (!rect.height || event.clientY == null || (event.clientY >= rect.top - 4 && event.clientY <= rect.bottom + 4)));
  }
  startTocResize(event) {
    if (this.disposed || (event.button != null && event.button !== 0)) return false;
    if (!this.isTocResizeTarget(event)) return false;
    event.preventDefault?.();
    event.stopPropagation?.();
    event.stopImmediatePropagation?.();
    if (this.tocDrag) return true;
    const info = this.tocResize;
    const {sidebar, sidebarItem, resizer} = info;
    try { resizer?.focus?.({preventScroll: true}); } catch { /* ignore */ }
    const boxNode = sidebarItem || sidebar;
    const rect = boxNode.getBoundingClientRect?.();
    const sidebarLeft = rect?.left || 0;
    const maxWidth = this.maxTocWidth();
    const frameRect = this.host?.ownerDocument !== this.doc ? this.frame?.getBoundingClientRect?.() : null;
    const initialWidth = Number.isFinite(this.tocWidth) ? this.tocWidth : (rect?.width >= TOC_MIN ? Math.round(rect.width) : info.defaultWidth);
    const clientX = this.eventDocX(event);
    const startX = Number.isFinite(clientX) ? clientX : sidebarLeft + initialWidth;
    const offset = Math.abs(startX - (sidebarLeft + initialWidth)) <= 24 ? startX - (sidebarLeft + initialWidth) : 0;
    const captureTarget = resizer || sidebar;
    const usePointer = event.pointerId != null;
    const state = {pointerId: event.pointerId, usePointer, startX, sidebarLeft, maxWidth, frameRect, initialWidth, offset, moved: false, expandedDuringDrag: false, target: captureTarget};
    this.tocDrag = state;
    this.doc.documentElement.setAttribute('data-htmlmemo-toc-resizing', '');
    try { if (usePointer) captureTarget?.setPointerCapture?.(event.pointerId); } catch { /* ignore */ }
    const hostDoc = this.host?.ownerDocument, hostWin = hostDoc?.defaultView, docWin = this.doc.defaultView || this.doc;
    const targets = [docWin, hostWin && hostWin !== docWin ? hostWin : null].filter(Boolean);
    const cleanup = () => {
      this.tocDrag = null;
      this.doc?.documentElement?.removeAttribute('data-htmlmemo-toc-resizing');
      try { if (usePointer) state.target?.releasePointerCapture?.(state.pointerId); } catch { /* ignore */ }
      for (const t of targets) {
        if (usePointer) {
          t.removeEventListener?.('pointermove', move, true);
          t.removeEventListener?.('pointerup', end, true);
          t.removeEventListener?.('pointercancel', cancel, true);
        } else {
          t.removeEventListener?.('mousemove', move, true);
          t.removeEventListener?.('mouseup', end, true);
        }
      }
    };
    const move = e => {
      if (this.tocDrag !== state) return;
      if (usePointer && e.pointerId != null && e.pointerId !== state.pointerId) return;
      if (state.moved && e.buttons === 0) { end(e); return; }
      const x = this.eventDocX(e);
      const currentX = Number.isFinite(x) ? x : state.startX;
      if (Math.abs(currentX - state.startX) >= (state.initialWidth <= TOC_MIN ? 6 : 1)) state.moved = true;
      if (!state.moved) return;
      e.preventDefault?.();
      const nextW = this.applyTocWidth(currentX - state.sidebarLeft - state.offset, {persist: false, snapStrip: false});
      if (nextW >= TOC_STRIP_SNAP) state.expandedDuringDrag = true;
    };
    const end = e => {
      if (this.tocDrag !== state) return;
      if (usePointer && e?.pointerId != null && e.pointerId !== state.pointerId) return;
      cleanup();
      this.tocResizeJustEnded = true;
      setTimeout(() => { this.tocResizeJustEnded = false; }, 0);
      if (!state.moved) {
        if (state.initialWidth <= TOC_MIN) {
          const restored = Math.max(TOC_STRIP_SNAP, this.tocExpandedWidth || this.tocDefaultWidth || TOC_DEFAULT);
          this.applyTocWidth(restored, {persist: true, snapStrip: true});
          this.syncAfterTocResize();
        }
        return;
      }
      let next = this.tocWidth;
      if (state.initialWidth <= TOC_MIN && next < TOC_STRIP_SNAP && !state.expandedDuringDrag) {
        next = Math.max(TOC_STRIP_SNAP, this.tocExpandedWidth || this.tocDefaultWidth || TOC_DEFAULT);
      }
      this.applyTocWidth(next, {persist: true, snapStrip: true});
      this.syncAfterTocResize();
    };
    const cancel = e => {
      if (this.tocDrag !== state) return;
      if (usePointer && e?.pointerId != null && e.pointerId !== state.pointerId) return;
      cleanup();
      if (state.moved) {
        this.applyTocWidth(this.tocWidth, {persist: true, snapStrip: true});
        this.syncAfterTocResize();
      }
    };
    for (const t of targets) {
      if (usePointer) {
        t.addEventListener?.('pointermove', move, true);
        t.addEventListener?.('pointerup', end, true);
        t.addEventListener?.('pointercancel', cancel, true);
      } else {
        t.addEventListener?.('mousemove', move, true);
        t.addEventListener?.('mouseup', end, true);
      }
    }
    return true;
  }
  handleTocDblClick(event) {
    if (!this.isTocResizeTarget(event)) return false;
    event.preventDefault?.();
    event.stopPropagation?.();
    event.stopImmediatePropagation?.();
    this.resetTocWidth();
    return true;
  }
  handleTocKeydown(event) {
    if (!this.isTocResizerNode(event.target)) return false;
    const info = this.ensureDocumentTocResize();
    if (!info?.sidebar?.isConnected) return false;
    const current = Number.isFinite(this.tocWidth) ? this.tocWidth : info.defaultWidth;
    if (event.key === 'ArrowLeft') {
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation?.();
      this.applyTocWidth(current - 16, {persist: true, snapStrip: true});
      this.syncAfterTocResize(); return true;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation?.();
      const base = current < TOC_STRIP_SNAP ? Math.max(TOC_STRIP_SNAP, this.tocExpandedWidth || this.tocDefaultWidth || TOC_DEFAULT) : current + 16;
      this.applyTocWidth(base, {persist: true, snapStrip: true});
      this.syncAfterTocResize(); return true;
    }
    if (event.key === 'Home') {
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation?.();
      this.applyTocWidth(TOC_MIN, {persist: true, snapStrip: true});
      this.syncAfterTocResize(); return true;
    }
    if (event.key === 'End') {
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation?.();
      this.resetTocWidth(); return true;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation?.();
      const next = current <= TOC_MIN ? Math.max(TOC_STRIP_SNAP, this.tocExpandedWidth || this.tocDefaultWidth || TOC_DEFAULT) : TOC_MIN;
      this.applyTocWidth(next, {persist: true, snapStrip: true});
      this.syncAfterTocResize(); return true;
    }
    return false;
  }
  forwardWheel(event) {
    // The iframe is a separate event tree.  Move its actual scroll owner
    // directly so a wheel keeps working even when the source HTML cancels its
    // own wheel event or uses a custom root scroller.
    if (event.ctrlKey) return;
    const scale=event.deltaMode===1?16:event.deltaMode===2?this.viewport.clientHeight:1;
    const left=event.deltaX*scale,top=event.deltaY*scale;
    this.scrollDocumentBy(event.target,left,top);
    event.preventDefault();
  }
  scrollDocumentBy(target,left,top,{touch=false}={}) {
    for(let node=target;node?.nodeType===1;node=node.parentElement){
      if (node===this.doc.documentElement) break;
      if (node===this.doc.body && this.doc.scrollingElement===this.doc.documentElement) {
        const htmlStyle=this.doc.defaultView.getComputedStyle(this.doc.documentElement);
        if (!/hidden|clip/i.test(htmlStyle.overflowY) && this.doc.documentElement.scrollHeight>this.doc.documentElement.clientHeight+1) continue;
      }
      const style=this.doc.defaultView.getComputedStyle(node);
      const vertical=/auto|scroll|overlay/.test(style.overflowY)&&node.scrollHeight>node.clientHeight+1;
      const horizontal=/auto|scroll|overlay/.test(style.overflowX)&&node.scrollWidth>node.clientWidth+1;
      // Preserve normal scroll chaining. At the end of an inner panel, pass
      // the wheel on to the document root instead of swallowing it there.
      const canVertical=vertical&&(top<0&&node.scrollTop>0||top>0&&node.scrollTop<node.scrollHeight-node.clientHeight-1);
      const canHorizontal=horizontal&&(left<0&&node.scrollLeft>0||left>0&&node.scrollLeft<node.scrollWidth-node.clientWidth-1);
      if (canVertical || canHorizontal) {
        node.scrollBy?.({left,top,behavior:'instant'});
        if (!node.scrollBy) { node.scrollLeft+=left;node.scrollTop+=top; }
        return;
      }
    }
    if(this.nativeScroll) {
      const root=this.findAnnotationScrollHost()||this.doc.scrollingElement||this.doc.documentElement||this.doc.body;
      root.scrollBy?.({left,top,behavior:'instant'});
      if (!root.scrollBy) { root.scrollLeft+=left;root.scrollTop+=top; }
    } else this.viewport.scrollBy({left:left*(touch?this.zoom:1),top:top*(touch?this.zoom:1),behavior:'instant'});
  }
  cancelDrawingGesture() {
    if(!this.gesture)return;
    const gesture=this.gesture;this.gesture=null;
    this.preview?.remove();this.preview=null;
    try{gesture?.target?.releasePointerCapture?.(gesture.pointerId);}catch{/* A cancelled pointer may already have released capture. */}
  }
  touchScrollPoints(touches) {
    // In a static reader, scrolling its parent also moves the iframe beneath
    // the fingers. Include that offset so our own scroll cannot cancel the next delta.
    const bounds=this.frame?.getBoundingClientRect?.(),scale=this.zoom||1;
    return touches.map(t=>({id:t.identifier,x:t.clientX+(bounds?.left||0)/scale,y:t.clientY+(bounds?.top||0)/scale}));
  }
  startTouchScroll(event) {
    if(event.touches.length<2&&!this.touchScroll){if(this.textMarkGesture&&event.cancelable)event.preventDefault();return;}
    this.touchErase=null;
    if(!this.touchScroll){
      // touch-action is fixed when a gesture begins. Cancelling a pen stroke
      // cannot restore native panning halfway through that gesture.
      const target=event.touches[0]?.target||event.target;
      const manual=!this.nativeScroll||TEXT_TOOLS.includes(this.tool)||DRAW_TOOLS.includes(this.tool)||['note','text'].includes(this.tool)||!!this.annotationDrag||[event.target,...event.touches].some(t=>(t.target||t).closest?.('#'+LAYER_ID+',[data-htmlmemo-id],[data-htmlmemo-hit]'));
      this.touchScroll={target,manual};
      this.cancelTextMarkGesture();this.cancelAnnotationDrag();this.cancelDrawingGesture();this.stopMiddleScroll();
      this.callbacks.onSelectionDismiss?.();
    }
    const touches=[...event.touches].slice(0,2);
    this.touchScroll.points=touches.length===2?this.touchScrollPoints(touches):null;
    this.suppressAnnotationClick=performance.now()+500;
    if(this.touchScroll.manual&&event.cancelable)event.preventDefault();
  }
  moveTouchScroll(event) {
    const state=this.touchScroll;if(!state)return;
    if(state.manual){
      if(event.cancelable)event.preventDefault();
      event.stopPropagation();
      const previous=state.points,touches=[...event.touches];
      const matching=previous?.map(p=>touches.find(t=>t.identifier===p.id));
      if(matching?.every(Boolean)){
        const next=this.touchScrollPoints(matching);
        const left=previous.reduce((sum,p,i)=>sum+p.x-next[i].x,0)/2,top=previous.reduce((sum,p,i)=>sum+p.y-next[i].y,0)/2;
        this.scrollDocumentBy(state.target,left,top,{touch:true});
        state.points=next;
      }
    }
    this.suppressAnnotationClick=performance.now()+500;
  }
  endTouchScroll(event) {
    if(!this.touchScroll)return;
    this.suppressAnnotationClick=performance.now()+500;this.annotationDragEndedAt=performance.now();
    if(event.touches.length===0)this.touchScroll=null;
    else this.startTouchScroll(event);
  }
  startMiddleScroll(event) {
    if (event.button!==1) return false;
    if (event.target.closest?.('a,button,input,textarea,select,[contenteditable]')) return false;
    event.preventDefault();
    if (this.middleScroll) {this.stopMiddleScroll();return true;}
    const state={pointerId:event.pointerId,x:event.clientX,y:event.clientY,dx:0,dy:0,moved:false,frame:0,target:event.target};
    this.middleScroll=state;
    event.target.setPointerCapture?.(event.pointerId);
    const tick=()=>{
      if (this.middleScroll!==state || this.disposed) return;
      const speed=value=>Math.abs(value)<8?0:Math.sign(value)*Math.min(48,(Math.abs(value)-8)/4);
      const left=speed(state.dx),top=speed(state.dy);
      if (left||top) {
        if(this.nativeScroll){
          const host=this.findAnnotationScrollHost();
          if(host){host.scrollLeft+=left/this.zoom;host.scrollTop+=top/this.zoom;}
          else this.doc.defaultView.scrollBy(left/this.zoom,top/this.zoom);
        } else this.viewport.scrollBy(left,top);
      }
      state.frame=this.doc.defaultView.requestAnimationFrame(tick);
    };
    state.frame=this.doc.defaultView.requestAnimationFrame(tick);
    return true;
  }
  moveMiddleScroll(event) {
    const state=this.middleScroll;
    if(!state || event.pointerId!==state.pointerId)return false;
    event.preventDefault?.();
    state.dx=event.clientX-state.x;state.dy=event.clientY-state.y;
    if(Math.abs(state.dx)>8 || Math.abs(state.dy)>8)state.moved=true;
    return true;
  }
  endMiddleScroll(event) {
    const state=this.middleScroll;
    if(!state || event.button!==1 || event.pointerId!==state.pointerId)return false;
    event.preventDefault();
    // Press-and-drag stops on release; a plain middle click latches until the
    // next click or Escape, matching the familiar browser auto-scroll gesture.
    if(state.moved)this.stopMiddleScroll();
    return true;
  }
  stopMiddleScroll() {
    if(!this.middleScroll)return;
    this.doc?.defaultView?.cancelAnimationFrame(this.middleScroll.frame);
    this.middleScroll.target?.releasePointerCapture?.(this.middleScroll.pointerId);
    this.middleScroll=null;
  }
  observeDynamicDocument() {
    if (!this.disposed) this.dynamicObserver?.observe(this.doc.documentElement,{childList:true,subtree:true,characterData:true});
  }
  scheduleDynamicRefresh() {
    if (this.disposed) return;
    this.dynamicDirty = true;
    clearTimeout(this.dynamicTimer);
    if(this.host?.hidden)return;
    this.dynamicTimer = setTimeout(() => this.refreshDynamicDocument().catch(error=>this.callbacks.onError?.(error)),400);
  }
  async refreshDynamicDocument() {
    // Navigation must await an existing restoration job, not mistake "already
    // running" for "finished" on the first import of a large exported book.
    if(this.dynamicTask)return this.dynamicTask;
    this.dynamicTask=this.refreshDynamicDocumentNow();
    try{return await this.dynamicTask;}finally{this.dynamicTask=null;}
  }
  async refreshDynamicDocumentNow() {
    if (this.disposed || this.host?.hidden || this.dynamicRunning) return;
    if (this.tocDrag) { this.scheduleDynamicRefresh(); return; }
    this.dynamicRunning = true;this.dynamicDirty = false;
    try {
      this.setupReadingControls();
      const body = this.doc.body;if (!body) return;
      body.setAttribute('data-htmlmemo-anchor','body');
      let count=0,added=0,mainAdded=0,start=performance.now();
      const roots=[...(this.dynamicRoots || [body])].filter(root=>root?.isConnected);
      this.dynamicRoots?.clear();
      // A clock or a small generated paragraph must not rescan a 50,000-page book.
      const rootSet=new Set(roots);
      const unique=roots.filter(root=>{for(let parent=root.parentElement;parent;parent=parent.parentElement)if(rootSet.has(parent))return false;return true;});
      // Reserve IDs supplied by scripts before assigning any new IDs, including
      // when an already anchored paragraph arrives after the initial load.
      for (const root of unique) {
        for (const element of [root,...root.querySelectorAll('[data-htmlmemo-anchor^="js"]')]) {
          const key = element.getAttribute('data-htmlmemo-anchor');
          const index = /^js\d+$/.test(key) ? Number(key.slice(2)) : -1;
          if (Number.isSafeInteger(index) && index >= this.dynamicAnchor) this.dynamicAnchor = index + 1;
          if((++count&255)===0&&performance.now()-start>=10){await new Promise(resolve=>setTimeout(resolve,0));if(this.disposed)return;start=performance.now();}
        }
      }
      for(const root of unique){
        const inChrome = this.isInsideTocOrTopbar(root);
        const descendants = root.hasAttribute?.('data-htmlmemo-anchor')
          ? root.querySelectorAll(':not([data-htmlmemo-anchor])')
          : root.querySelectorAll('*');
        for(const element of [root,...descendants]){
          if (!element.closest('#'+LAYER_ID+', [data-htmlmemo-ui], [data-htmlmemo-mark], [data-htmlmemo-search]') && !['script','style','meta','link','template'].includes(element.localName) && !element.hasAttribute('data-htmlmemo-anchor')) {
            element.setAttribute('data-htmlmemo-anchor','js'+this.dynamicAnchor++);
            added++;
            if (!inChrome && !this.isInsideTocOrTopbar(element)) mainAdded++;
          }
          if((++count&255)===0&&performance.now()-start>=10){await new Promise(resolve=>setTimeout(resolve,0));if(this.disposed)return;start=performance.now();}
        }
      }
      this.tocChecked = false;
      this.ensureDocumentTocResize();
      if (added > 0) {
        this.initialHTML = null;
        this.measure();
        if (mainAdded > 0) this.render();
        this.callbacks.onView?.();
      }
      // Generated content may restore its own saved anchors, with no new IDs
      // to assign. Retry pending drawings without rebuilding all text marks.
      if (mainAdded === 0) this.renderDrawingLayer();
    } finally {
      this.dynamicRunning = false;
      if (this.dynamicDirty && !this.disposed) this.scheduleDynamicRefresh();
    }
  }
  textAtClick(event) {
    const doc=this.doc,target=event.target?.nodeType===1?event.target:event.target?.parentElement;
    if(!doc||target?.ownerDocument!==doc||!Number.isFinite(event.clientX)||!Number.isFinite(event.clientY))return null;
    const {clientX:x,clientY:y}=event;let node,offset;
    try{
      const caret=doc.caretPositionFromPoint?.(x,y),range=caret?null:doc.caretRangeFromPoint?.(x,y);
      node=caret?.offsetNode||range?.startContainer;offset=caret?.offset??range?.startOffset;
    }catch{/* Missing hit-testing must not turn a word selection into fullscreen. */}
    if(!node){return target.matches?.('p,span,strong,em,b,i,u,small,h1,h2,h3,h4,h5,h6,li,td,th,pre,code')?{unknown:true}:null;}
    if(node.nodeType!==3||!node.textContent.trim()||node.parentElement?.closest('script,style,noscript,svg,textarea,template,[data-htmlmemo-ui]'))return null;
    const range=doc.createRange();
    for(const at of [offset,offset-1]){
      if(at<0||at>=node.textContent.length)continue;
      range.setStart(node,at);range.setEnd(node,at+1);
      if(!range.getClientRects)return {unknown:true};
      for(const rect of range.getClientRects())if(rect.width>0&&rect.height>0&&x>=rect.left-.5&&x<=rect.right+.5&&y>=rect.top&&y<=rect.bottom)return {node,offset:at};
    }
    return null;
  }
  sentenceIndex(point) {
    const doc=this.doc,block=element=>!!element&&(element.matches('p,h1,h2,h3,h4,h5,h6,li,dt,dd,blockquote,figcaption,td,th,caption,pre')||/^(block|flow-root|list-item|table-cell|flex|grid)$/.test(doc.defaultView?.getComputedStyle?.(element)?.display||''));
    let root=point.node.parentElement;while(root!==doc.body&&root.parentElement&&!block(root))root=root.parentElement;
    let first=point.node;while(first.parentNode!==root)first=first.parentNode;
    let last=first;while(first.previousSibling&&!(first.previousSibling.nodeType===1&&block(first.previousSibling)))first=first.previousSibling;
    while(last.nextSibling&&!(last.nextSibling.nodeType===1&&block(last.nextSibling)))last=last.nextSibling;
    const index={text:'',nodes:[]};
    const collect=node=>{
      if(node.nodeType===3){const start=index.text.length;index.text+=node.textContent;index.nodes.push({node,start,end:index.text.length});return;}
      if(node.nodeType!==1||node.matches('script,style,noscript,svg,textarea,template,[data-htmlmemo-ui],[hidden],[aria-hidden="true"]'))return;
      const style=doc.defaultView?.getComputedStyle?.(node);if(style?.display==='none'||style?.visibility==='hidden')return;
      if(block(node)){index.text+='\u2029';return;} // Do not join separate block descendants into one sentence.
      if(node.localName==='br'){index.text+='\n';return;}
      for(const child of node.childNodes)collect(child);
    };
    for(let node=first;node;node=node.nextSibling){collect(node);if(node===last)break;}
    return index;
  }
  selectSentenceAtClick(event) {
    if(this.disposed||event.button!==0||event.detail!==3||this.tool!=='select'||this.isInsideTocOrTopbar(event.target)||event.target.closest?.('a,button,input,textarea,select,[contenteditable],[data-htmlmemo-id]'))return false;
    const point=this.textAtClick(event);if(!point?.node)return false;
    const index=this.sentenceIndex(point),entry=index.nodes.find(item=>item.node===point.node);if(!entry)return false;
    const bounds=sentenceOffsets(index.text,entry.start+point.offset,this.doc.documentElement.lang||undefined);if(!bounds)return false;
    const range=rangeFromOffsets(this.doc,bounds.start,bounds.end,index),selection=this.doc.getSelection();if(!range||!selection)return false;
    event.preventDefault();selection.removeAllRanges();selection.addRange(range);return true;
  }
  focusDocument(event) {
    if(this.annotationDrag||performance.now()-(this.annotationDragEndedAt||-Infinity)<500)return;
    if (this.disposed || event.button != null && event.button !== 0) return;
    if (this.isInsideTocSidebar(event.target)) return;
    if (event.target.closest?.('a,button,input,textarea,select,img,svg,canvas,video,audio,object,embed,iframe,[role="img"],[contenteditable],[data-htmlmemo-id],[role="separator"],[data-htmlmemo-toc-resizer],[data-htmlmemo-toc-resizer-bound],[data-htmlmemo-toc-strip]')||this.textAtClick(event)) return;
    event.preventDefault();
    this.callbacks.onDocumentFocus?.();
  }
  measure() {
    if (this.host?.hidden || !this.doc) return;
    const body = this.doc.body;
    if (this.nativeScroll) {
      // Keep the browsing viewport small. Expanding an iframe to a whole book
      // makes Chrome lay out/paint all its pages and can exceed CSS height limits.
      this.naturalHeight = Math.max(body.scrollHeight, this.doc.documentElement.scrollHeight, 200);
      this.applyZoom(); return;
    }
    // The iframe's own viewport height must not feed back into scrollHeight.
    // Body geometry and descendant bottoms capture both normal and positioned content.
    let height = Math.max(body.offsetHeight + body.offsetTop, body.getBoundingClientRect().bottom, 200);
    for (const child of body.children) if (child.id !== LAYER_ID) height = Math.max(height, child.getBoundingClientRect().bottom + this.doc.defaultView.scrollY);
    this.naturalHeight = Math.ceil(height + 24);
    this.frame.style.height = this.naturalHeight + 'px'; this.applyZoom();
  }
  setFocusLayout(focused) {
    if (this.disposed) return;
    if (focused) {
      if (!this.focusLayout) this.focusLayout = {zoom:this.zoom,autoFit:this.autoFit};
      this.setZoom(this.fitZoom(),true);
    } else if (this.focusLayout) {
      const previous=this.focusLayout;this.focusLayout=null;
      this.setZoom(previous.zoom,previous.autoFit);
    }
    this.measure();
  }
  restoreOpeningPosition() {
    // Saved offsets include the old display zoom. A sidebar or a different
    // window width must not turn them into a different place in the document.
    const view=this.metadata.view,savedZoom=Number(view.zoom)>0?Number(view.zoom):this.zoom;
    this.scrollTop=(this.openingScroll?.top || (Number(view.scrollTop)||0)/savedZoom)*this.zoom;
    this.scrollLeft=(this.openingScroll?.left || (Number(view.scrollLeft)||0)/savedZoom)*this.zoom;
  }
  resizeViewport() {
    if(this.host?.hidden || this.disposed)return;
    const top=this.scrollTop/this.zoom,left=this.scrollLeft/this.zoom;
    if(this.autoFit)this.zoom=this.fitZoom();
    if(this.nativeScroll || this.autoFit)this.applyZoom();
    this.scrollTop=top*this.zoom;this.scrollLeft=left*this.zoom;
  }
  fitZoom() { const focused=!!this.host.closest('.reader-focus'); return clamp(this.viewport.clientWidth / this.naturalWidth, .2, focused ? 8 : 2); }
  applyZoom() {
    const set=(style,key,value)=>{if(style[key]!==value)style[key]=value;};
    if(this.nativeScroll)set(this.frame.style,'height',Math.max(200,this.viewport.clientHeight/this.zoom)+'px');
    set(this.frame.style,'transform',`scale(${this.zoom})`);
    set(this.sizer.style,'width',this.naturalWidth*this.zoom+'px');
    set(this.sizer.style,'height',(this.nativeScroll?Math.max(200*this.zoom,this.viewport.clientHeight):(this.naturalHeight||800)*this.zoom)+'px');
    this.syncAnnotationPicking();
    this.updateReadingControls();
    this.readAloud?.refreshPaint?.();
  }
  rootScrollTop() { return this.doc?.defaultView?.scrollY || this.doc?.scrollingElement?.scrollTop || this.doc?.documentElement?.scrollTop || 0; }
  rootScrollLeft() { return this.doc?.defaultView?.scrollX || this.doc?.scrollingElement?.scrollLeft || this.doc?.documentElement?.scrollLeft || 0; }
  findAnnotationScrollHost() {
    if (!this.doc?.body || typeof this.doc.querySelectorAll !== 'function') return null;
    const win = this.doc.defaultView;
    const getStyle = el => win?.getComputedStyle?.(el) || el?.style || null;
    const prop = (st, camel, kebab) => st?.[camel] || st?.getPropertyValue?.(kebab) || '';
    const overflowY = (el, st = getStyle(el)) => prop(st, 'overflowY', 'overflow-y') || prop(st, 'overflow', 'overflow');
    const htmlStyle = getStyle(this.doc.documentElement);
    const bodyStyle = getStyle(this.doc.body);
    const rootLocked = /hidden|clip/i.test(overflowY(this.doc.documentElement, htmlStyle)) || /hidden|clip/i.test(overflowY(this.doc.body, bodyStyle)) || !!this.tocResize;
    const isScrollablePane = (node, allowUnfilled = false) => {
      if (!node || node.nodeType !== 1 || node === this.doc.body || node === this.doc.documentElement) return false;
      if (node.id === LAYER_ID || node.hasAttribute?.('data-htmlmemo-ui') || /^(?:aside|nav|header|footer|pre|code|table|ul|ol|dl|details|figure|blockquote)$/i.test(node.localName || '')) return false;
      if (this.isInsideTocOrTopbar(node)) return false;
      if (this.tocResize?.sidebar && (node.contains?.(this.tocResize.sidebar) || (this.tocResize.sidebarItem && node.contains?.(this.tocResize.sidebarItem)))) return false;
      if (this.topbarNode && node.contains?.(this.topbarNode)) return false;
      const st = getStyle(node);
      if (!st || prop(st, 'display', 'display') === 'none' || prop(st, 'visibility', 'visibility') === 'hidden') return false;
      if (!/auto|scroll|overlay/i.test(overflowY(node, st))) return false;
      if (!(node.scrollHeight > node.clientHeight + 1 || node.scrollTop > 0 || (allowUnfilled && rootLocked))) return false;
      const r = node.getBoundingClientRect?.();
      if (r && (r.width > 0 || r.height > 0) && (r.width < 160 || r.height < 80)) return false;
      return true;
    };
    if (this.scrollHostEl?.isConnected && this.scrollHostEl !== this.doc.body && this.scrollHostEl !== this.doc.documentElement) {
      if (isScrollablePane(this.scrollHostEl, true)) return this.scrollHostEl;
    }
    const candidates = new Set();
    const addCandidate = el => { if (el?.nodeType === 1 && el !== this.doc.body && el !== this.doc.documentElement) candidates.add(el); };
    if (this.tocResize?.mainNodes?.length) for (const el of this.tocResize.mainNodes) addCandidate(el);
    if (this.tocResize?.mainItem) addCandidate(this.tocResize.mainItem);
    for (const sel of ['[data-htmlmemo-toc-main]', 'main', '[role="main"]', '.wm-doc', '.book-content', '.doc-content', '.reader-content', '.markdown-body', '#content', '.content']) {
      for (const el of this.doc.querySelectorAll(sel)) addCandidate(el);
    }
    for (const el of [...candidates]) {
      for (const child of el.children || []) addCandidate(child);
    }
    for (const top of this.doc.body.children || []) {
      addCandidate(top);
      for (const child of top.children || []) {
        addCandidate(child);
        for (const grand of child.children || []) addCandidate(grand);
      }
    }
    for (const el of candidates) {
      if (isScrollablePane(el, true)) { this.scrollHostEl = el; return el; }
    }
    const htmlCanScroll = !/hidden|clip/i.test(overflowY(this.doc.documentElement, htmlStyle)) && (this.doc.documentElement.scrollHeight > this.doc.documentElement.clientHeight + 1 || (win?.scrollY || 0) > 0);
    if (!htmlCanScroll && (/auto|scroll|overlay/i.test(overflowY(this.doc.body, bodyStyle)) && (this.doc.body.scrollHeight > this.doc.body.clientHeight + 1 || this.doc.body.scrollTop > 0) || (this.doc.body.scrollTop > 0 && !(win?.scrollY > 0)))) {
      this.scrollHostEl = this.doc.body;
      return this.doc.body;
    }
    this.scrollHostEl = null;
    return null;
  }
  layerOrigin(scrollHost = this.findAnnotationScrollHost()) {
    if (scrollHost) {
      const r = scrollHost.getBoundingClientRect?.() || {left: 0, top: 0};
      const st = this.doc?.defaultView?.getComputedStyle?.(scrollHost) || scrollHost?.style;
      const borderLeft = scrollHost.clientLeft || Number.parseFloat(st?.borderLeftWidth || st?.getPropertyValue?.('border-left-width')) || 0;
      const borderTop = scrollHost.clientTop || Number.parseFloat(st?.borderTopWidth || st?.getPropertyValue?.('border-top-width')) || 0;
      return {
        left: r.left + borderLeft - (scrollHost.scrollLeft || 0),
        top: r.top + borderTop - (scrollHost.scrollTop || 0),
        scrollHost,
      };
    }
    return {
      left: -this.rootScrollLeft(),
      top: -this.rootScrollTop(),
      scrollHost: null,
    };
  }
  ensureAnnotationLayerHost() {
    const scrollHost = this.findAnnotationScrollHost();
    for (const prev of this.doc?.querySelectorAll?.('[data-htmlmemo-scroll-host]') || []) {
      if (prev !== scrollHost) prev.removeAttribute('data-htmlmemo-scroll-host');
    }
    if (scrollHost) {
      const st = this.doc.defaultView?.getComputedStyle?.(scrollHost) || scrollHost?.style;
      const pos = st?.position || st?.getPropertyValue?.('position');
      if (!pos || pos === 'static') scrollHost.setAttribute('data-htmlmemo-scroll-host', '');
      if (scrollHost !== this.doc.body && this.observedScrollHost !== scrollHost) {
        if (this.observedScrollHost) this.resizeObserver?.unobserve?.(this.observedScrollHost);
        this.observedScrollHost = scrollHost;
        this.resizeObserver?.observe?.(scrollHost);
      }
    }
    return scrollHost;
  }
  get scrollTop() {
    if (!this.nativeScroll) return this.viewport.scrollTop;
    const host = this.findAnnotationScrollHost();
    return ((host ? host.scrollTop : 0) || this.rootScrollTop()) * this.zoom;
  }
  set scrollTop(value) {
    if (this.nativeScroll) {
      const target = value / this.zoom;
      const host = this.findAnnotationScrollHost();
      if (host) host.scrollTop = target;
      else this.doc.defaultView.scrollTo(this.doc.defaultView.scrollX, target);
    } else this.viewport.scrollTop = value;
  }
  get scrollLeft() {
    if (!this.nativeScroll) return this.viewport.scrollLeft;
    const host = this.findAnnotationScrollHost();
    return this.viewport.scrollLeft + ((host ? host.scrollLeft : 0) || this.rootScrollLeft()) * this.zoom;
  }
  set scrollLeft(value) {
    if (this.nativeScroll) {
      const target = Math.max(0, value);
      this.viewport.scrollLeft = target;
      const rem = (target - this.viewport.scrollLeft) / this.zoom;
      const host = this.findAnnotationScrollHost();
      if (host) host.scrollLeft = rem;
      else this.doc.defaultView.scrollTo(rem, this.doc.defaultView.scrollY);
    } else this.viewport.scrollLeft = value;
  }
  setZoom(value, fit = false) {
    this.cancelAnnotationDrag();
    const centerX = (this.scrollLeft + this.viewport.clientWidth / 2) / this.zoom;
    const centerY = (this.scrollTop + this.viewport.clientHeight / 2) / this.zoom;
    this.autoFit = fit; this.zoom = clamp(fit ? this.fitZoom() : value, .2, 8); this.applyZoom();
    this.scrollLeft = centerX * this.zoom - this.viewport.clientWidth / 2; this.scrollTop = centerY * this.zoom - this.viewport.clientHeight / 2;
    this.rememberPosition(); this.callbacks.onView?.();
  }
  rememberPosition() {
    // Hidden tabs can report zero geometry; never replace the last visible reading position with it.
    if(this.host?.hidden || this.disposed)return false;
    const view = {scrollTop:this.scrollTop, scrollLeft:this.scrollLeft, zoom:this.zoom, autoFit:this.autoFit, ...(Number.isFinite(this.tocResizedWidth)?{tocWidth:this.tocResizedWidth}:{}),...(this.metadata.view?.sourceStorage?{sourceStorage:this.metadata.view.sourceStorage}:{})};
    const previous = this.metadata.view || {};
    if (Object.keys(previous).length === Object.keys(view).length && Object.keys(view).every(key => view[key] === previous[key])) return false;
    this.metadata.view = view;
    this.callbacks.onPosition?.();
    return true;
  }
  setTool(tool) {
    this.cancelTextMarkGesture();this.cancelAnnotationDrag();
    this.cancelDrawingGesture();this.touchErase=null;
    this.tool = tool; this.doc.documentElement.toggleAttribute('data-htmlmemo-drawing', DRAW_TOOLS.includes(tool) || ['note','text'].includes(tool));
    this.doc.documentElement.toggleAttribute('data-htmlmemo-text-marking',TEXT_TOOLS.includes(tool));
    this.syncAnnotationPicking();
    if (TEXT_TOOLS.includes(tool) && this.selection) this.addText(tool, this.selection);
    this.callbacks.onView?.();
  }
  captureTextSelection() {
    if(this.textMarkGesture)return this.selection;
    const selection=this.doc.getSelection(),anchor=selection?.rangeCount&&!selection.isCollapsed?selectionAnchor(this.doc,selection.getRangeAt(0),this.searchCache().get()):null;
    this.selection=anchor?this.sectionAnchor(anchor):null;return this.selection;
  }
  restoreTextSelection(anchor) {
    if(!anchor?.quote?.trim()||this.disposed||this.host?.hidden||(anchor.section||'')!==currentSection(this.doc))return false;
    const index=this.searchCache().get(),resolved=resolveTextAnchor(index,anchor),selection=this.doc.getSelection();
    const range=resolved&&rangeFromOffsets(this.doc,resolved.start,resolved.end,index);
    if(!selection||!range)return false;
    selection.removeAllRanges();selection.addRange(range);this.selection=this.sectionAnchor({...anchor,...resolved});return true;
  }
  async addSelectionNote(anchor=this.captureTextSelection()) {
    if(!anchor?.quote?.trim()||this.selectionNotePending||this.disposed||this.host?.hidden)return false;
    // Pin the quote and chapter before modal focus can change the live selection.
    const target=this.sectionAnchor({...anchor}),section=currentSection(this.doc);
    if(anchor.section&&anchor.section!==section)return false;
    this.selectionNotePending=true;
    try{
      const text=await this.callbacks.requestText?.('note');
      if(this.disposed||this.host?.hidden||currentSection(this.doc)!==section)return false;
      if(!text?.trim()){this.restoreTextSelection(target);return false;}
      const added=this.addText('note',target,text.trim());
      if(!added)this.callbacks.onNotice?.('선택한 글의 위치를 찾지 못했습니다. 글을 다시 선택해 주세요.');
      return added;
    }catch(error){this.restoreTextSelection(target);throw error;}
    finally{this.selectionNotePending=false;}
  }
  annotation(type, properties) { const highlight=type==='highlight'||type==='area';return {id:uid(), type, color:highlight?this.highlightColor:this.color, width:this.width, opacity:highlight?this.opacity:1, created:Date.now(), ...(FILL_TOOLS.includes(type)?{fill:this.rectFill===true,...(this.rectFill===true?{fillOpacity:this.opacity}:{})}:{}), ...properties}; }
  addText(type, anchor, text) {
    if (!anchor?.quote?.trim()) return false;
    if (type === 'note') {
      const index=this.searchCache().get(),resolved=resolveTextAnchor(index,anchor);if(!resolved||!text?.trim())return false;
      const range = rangeFromOffsets(this.doc, resolved.start, resolved.end,index); if (!range) return false;
      const rect = range.getBoundingClientRect(), element = range.startContainer.parentElement;
      const position = this.elementAnchor(element, true), origin = this.layerOrigin();
      // The quote and paragraph let 「새 판으로 주석 옮기기」 find this note in a later edition.
      this.commit([...this.metadata.annotations, this.annotation(type, {anchor:position.key, anchorTarget:position.target, textAnchor:this.sectionAnchor(anchor), points:[{x:(rect.left - origin.left - position.x)/position.width,y:(rect.top - origin.top - position.y)/position.height}], text:text.trim()})]);
    } else this.commit([...this.metadata.annotations, this.annotation(type, {textAnchor:this.sectionAnchor(anchor)})]);
    if(type==='note')this.restoreTextSelection(anchor);
    else {this.doc.getSelection()?.removeAllRanges();this.selection=null;}
    return true;
  }
  // A packed book shows one section at a time. Recording it keeps a common phrase from being
  // marked in other sections, and tells a later edition where to look.
  sectionAnchor(anchor) { const section = currentSection(this.doc); return section ? {...anchor, section} : anchor; }
  commit(annotations) {
    this.metadata.annotations = this.history.commit(annotations); this.render(); this.callbacks.onChange?.(); this.callbacks.onView?.();
  }
  undo() { if (this.history.canUndo) { this.metadata.annotations = this.history.undo(); this.render(); this.callbacks.onChange?.(); this.callbacks.onView?.(); } }
  redo() { if (this.history.canRedo) { this.metadata.annotations = this.history.redo(); this.render(); this.callbacks.onChange?.(); this.callbacks.onView?.(); } }
  remove(id) { this.commit(this.metadata.annotations.filter(a => a.id !== id)); if (this.selectedId === id) this.selectedId = null; }
  point(event) {
    const origin = this.layerOrigin();
    return {x:event.clientX - origin.left, y:event.clientY - origin.top};
  }
  anchorBox(element, origin = this.layerOrigin()) {
    const scrollHost = origin.scrollHost;
    if (scrollHost && (!element || element === this.doc.body || element === this.doc.documentElement || element === scrollHost || element.contains?.(scrollHost))) {
      const r = scrollHost.getBoundingClientRect?.() || {width:1, height:1};
      return {
        x:0,
        y:0,
        width:Math.max(1, scrollHost.scrollWidth || scrollHost.clientWidth || r.width),
        height:Math.max(1, scrollHost.scrollHeight || scrollHost.clientHeight || r.height),
      };
    }
    const r = element.getBoundingClientRect();
    return {
      x:r.left - origin.left,
      y:r.top - origin.top,
      width:Math.max(1, r.width),
      height:Math.max(1, r.height),
    };
  }
  drawingTargetQuote(element) { return drawingTargetQuote(this.doc, element); }
  describeDrawingTarget(element) { return describeDrawingTarget(this.doc, element); }
  drawingTargetContext() { return {section:currentSection(this.doc),anchors:new Map(),indexed:false,lookups:0,quotes:new WeakMap()}; }
  resolveDrawingTarget(annotation,context=null) {
    const target = annotation.anchorTarget;
    if (!this.annotationInSection(annotation,context?.section??currentSection(this.doc))) return null;
    const direct=()=>{
      if(!context)return this.doc.querySelector(`[data-htmlmemo-anchor="${annotation.anchor}"]`);
      if(context.anchors.has(annotation.anchor)||context.indexed)return context.anchors.get(annotation.anchor)||null;
      // A few nearby notes need no whole-book walk. Batch only when many
      // different legacy anchors actually need direct lookup in this pass.
      if(++context.lookups<8){const node=this.doc.querySelector(`[data-htmlmemo-anchor="${annotation.anchor}"]`);context.anchors.set(annotation.anchor,node);return node;}
      context.anchors.clear();context.indexed=true;
      for(const node of this.doc.querySelectorAll('[data-htmlmemo-anchor]')){const key=node.getAttribute('data-htmlmemo-anchor');if(!context.anchors.has(key))context.anchors.set(key,node);}
      return context.anchors.get(annotation.anchor)||null;
    };
    if (!target) return direct();
    const root = target.rootId ? this.doc.getElementById(target.rootId) : this.doc.body;
    if (!root) return null;
    const quote=node=>{if(!context)return this.drawingTargetQuote(node);if(!context.quotes.has(node))context.quotes.set(node,this.drawingTargetQuote(node));return context.quotes.get(node);};
    const matches = node => node?.isConnected && node.localName === target.tag &&
      (!target.id || node.id === target.id) && (!target.quote || quote(node) === target.quote);
    this.resolvedDrawingTargets ||= new WeakMap();
    const cached = this.resolvedDrawingTargets.get(annotation);
    if (cached && root.contains(cached) && matches(cached)) return cached;
    let node = target.id ? this.doc.getElementById(target.id) : root;
    if (!target.id) for (const index of target.path) node = node?.children[index];
    if (!matches(node) || !root.contains(node)) {const found=direct();node=root.contains(found)&&matches(found)?found:null;}
    if (!node && target.quote) {
      const candidates = [...root.querySelectorAll(target.tag)].filter(matches);
      if (candidates.length === 1) node = candidates[0];
    }
    if (node) this.resolvedDrawingTargets.set(annotation,node);
    return node;
  }
  elementAnchor(target, describe = false) {
    const origin = this.layerOrigin();
    const scrollHost = origin.scrollHost;
    let element = target?.closest?.('[data-htmlmemo-anchor]') || scrollHost || this.doc.body;
    if (element.namespaceURI === NS || element.closest?.('#' + LAYER_ID)) element = scrollHost || this.doc.body;
    while (element !== this.doc.body && element !== scrollHost && ['span','a','b','strong','em','i','small','mark'].includes(element.localName)) element = element.parentElement || this.doc.body;
    const win = this.doc?.defaultView;
    if (typeof win?.getComputedStyle === 'function') {
      while (element && element !== this.doc.body && element !== scrollHost && /^(?:fixed|sticky)$/i.test(win.getComputedStyle(element)?.position || '')) {
        element = element.parentElement || scrollHost || this.doc.body;
      }
    }
    if (scrollHost && !scrollHost.contains(element)) element = scrollHost;
    const box = this.anchorBox(element, origin);
    return {key:element.dataset?.htmlmemoAnchor || 'body', ...box, ...(describe ? {target:this.describeDrawingTarget(element),fontSize:this.drawingFontSize(element)} : {})};
  }
  drawingFontSize(element) {
    if(!element)return null;
    const content = this.doc.getElementById('reader-content');
    const target = content && element !== content && element.contains?.(content) ? content : element;
    const size = Number.parseFloat(this.doc.defaultView?.getComputedStyle?.(target)?.fontSize);
    return Number.isFinite(size) && size >= .1 && size <= 1000 ? size : null;
  }
  penTextIndex(element) {
    // Index only the stroke's paragraph, never the whole (possibly packed) book.
    if (!element || element === this.doc.body || element === this.doc.documentElement || !this.doc.createRange?.().getClientRects) return null;
    const nodes = []; let text = '', count = 0;
    const walker = this.doc.createTreeWalker(element, NodeFilter.SHOW_TEXT, {acceptNode:node =>
      node.parentElement?.closest('script,style,noscript,svg,textarea,template,[data-htmlmemo-ui]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT});
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (++count > 2000 || text.length + node.textContent.length > 64000) return null;
      nodes.push({node,start:text.length,end:text.length+node.textContent.length}); text += node.textContent;
    }
    return text.trim() ? {nodes,text} : null;
  }
  penTextRect(index, start, end, origin) {
    const range = rangeFromOffsets(this.doc,start,end,index), rect = range?.getBoundingClientRect?.();
    if (!rect || !rect.width || !rect.height) return null;
    const node = index.nodes.find(n=>n.end>start)?.node;
    const fontSize = this.drawingFontSize(node?.parentElement);
    return fontSize ? {x:rect.left+rect.width/2-origin.left,y:rect.top+rect.height/2-origin.top,fontSize} : null;
  }
  resolvePenTextAnchor(index, anchor) {
    // A single repeated letter is not enough to identify a changed paragraph.
    // Verify its surrounding text, including at the original numeric offset.
    const matches = start => index.text.slice(start,start+anchor.quote.length)===anchor.quote &&
      index.text.slice(Math.max(0,start-anchor.prefix.length),start)===anchor.prefix &&
      index.text.slice(start+anchor.quote.length,start+anchor.quote.length+anchor.suffix.length)===anchor.suffix;
    if(matches(anchor.start))return {start:anchor.start,end:anchor.end};
    let hit=null;
    for(let at=index.text.indexOf(anchor.quote);at!==-1;at=index.text.indexOf(anchor.quote,at+1)){
      if(!matches(at))continue;
      if(hit)return null;
      hit={start:at,end:at+anchor.quote.length};
    }
    return hit;
  }
  capturePenTextAnchor(element, points, box, origin, scale = 1, index = this.penTextIndex(element)) {
    if (!index || !points.length) return null;
    let left=Infinity,right=-Infinity,top=Infinity,bottom=-Infinity;
    for (const p of points) { left=Math.min(left,p.x);right=Math.max(right,p.x);top=Math.min(top,p.y);bottom=Math.max(bottom,p.y); }
    const x=(left+right)/2+origin.left,y=(top+bottom)/2+origin.top;
    const distance = (start,end) => {
      const rects = rangeFromOffsets(this.doc,start,end,index)?.getClientRects?.() || [];
      let best=Infinity;
      for (const r of rects) if(r.width && r.height) best=Math.min(best,Math.max(r.left-x,0,x-r.right)**2+Math.max(r.top-y,0,y-r.bottom)**2);
      return best;
    };
    // Range fragments find the nearest character even off-screen, with RTL,
    // nested highlights or wrapped lines. No caret hit-testing/scroll is needed.
    let start=0,end=index.text.length;
    while(end-start>8){const mid=(start+end)>>>1;if(distance(start,mid)<=distance(mid,end))end=mid;else start=mid;}
    let hit=null,best=Infinity;
    for(let at=Math.max(0,start-1);at<Math.min(index.text.length,end+1);at++){
      if(/\s|[\uDC00-\uDFFF]/u.test(index.text[at]))continue;
      const finish=at+(index.text.codePointAt(at)>0xffff?2:1),d=distance(at,finish);
      if(d<best){best=d;hit={start:at,end:finish};}
    }
    if(!hit)return null;
    const rect=this.penTextRect(index,hit.start,hit.end,origin);
    if(!rect || best>(rect.fontSize*3)**2 || rect.fontSize/scale<.1 || rect.fontSize/scale>1000)return null; // Blank-space diagrams keep their box anchor.
    return {...hit,quote:index.text.slice(hit.start,hit.end),prefix:index.text.slice(Math.max(0,hit.start-40),hit.start),suffix:index.text.slice(hit.end,hit.end+40),
      x:(rect.x-box.x)/scale,y:(rect.y-box.y)/scale,fontSize:rect.fontSize/scale};
  }
  annotationDragTarget(event) {
    const top=this.doc.elementFromPoint?.(event.clientX,event.clientY);
    if(!top||this.isInteractiveControl(top)||(top.closest?.('[data-htmlmemo-ui]')&&!top.closest?.('#'+LAYER_ID)))return null;
    return [...(this.doc.elementsFromPoint?.(event.clientX,event.clientY)||[top])].find(node=>!node.closest?.('#'+LAYER_ID+',[data-htmlmemo-ui]')&&!this.isInsideTocOrTopbar(node))||null;
  }
  annotationDragTextOffset(drag,event) {
    if(!this.annotationDragTarget(event))return null;
    const caret=this.doc.caretPositionFromPoint?.(event.clientX,event.clientY),range=caret?null:this.doc.caretRangeFromPoint?.(event.clientX,event.clientY);
    const node=caret?.offsetNode||range?.startContainer,offset=caret?.offset??range?.startOffset,item=drag.textNodes.get(node);
    if(!item||!drag.contentRoot.contains(node)||this.isInteractiveControl(node)||drag.index.text.slice(item.start,item.end)!==node.textContent)return null;
    return item.start+clamp(offset,0,item.end-item.start);
  }
  startAnnotationDrag(event) {
    const id=this.annotationIdAt(event.target),source=this.metadata.annotations.find(a=>a.id===id);
    if(!source||!this.annotationInSection(source)||this.isInteractiveControl(event.target))return false;
    if(!this.layer?.isConnected)this.renderDrawingLayer();
    const drag={pointerId:event.pointerId,source,annotation:structuredClone(source),section:currentSection(this.doc),start:this.point(event),moved:false,delta:{x:0,y:0}};
    if(TEXT_TOOLS.includes(source.type)){
      drag.index=this.searchCache().get();drag.resolved=resolveTextAnchor(drag.index,source.textAnchor);
      if(!drag.resolved)return false;
      drag.contentRoot=this.doc.getElementById('reader-content')||this.doc.body;drag.textNodes=new WeakMap();drag.bounds={start:Infinity,end:0};
      for(const item of drag.index.nodes){drag.textNodes.set(item.node,item);if(drag.contentRoot.contains(item.node)){drag.bounds.start=Math.min(drag.bounds.start,item.start);drag.bounds.end=Math.max(drag.bounds.end,item.end);}}
      const offset=this.annotationDragTextOffset(drag,event);drag.grabOffset=offset==null?0:clamp(offset-drag.resolved.start,0,drag.resolved.end-drag.resolved.start-1);
    }else{
      drag.geometry=this.drawingGeometry(source);if(!drag.geometry.points.length)return false;
    }
    this.annotationDrag=drag;event.preventDefault();event.stopPropagation();return true;
  }
  movedTextAnnotation(drag,event) {
    const offset=this.annotationDragTextOffset(drag,event),length=drag.resolved.end-drag.resolved.start;
    if(offset==null||drag.bounds.end-drag.bounds.start<length)return null;
    const start=clamp(offset-drag.grabOffset,drag.bounds.start,drag.bounds.end-length),end=start+length,text=drag.index.text;
    const range=rangeFromOffsets(this.doc,start,end,drag.index);
    if(!range||this.isInsideTocOrTopbar(range.startContainer)||this.isInsideTocOrTopbar(range.endContainer))return null;
    const textAnchor=this.sectionAnchor({...drag.annotation.textAnchor,start,end,quote:text.slice(start,end),prefix:text.slice(Math.max(0,start-40),start),suffix:text.slice(end,end+40)});
    return {...drag.annotation,textAnchor};
  }
  previewTextAnnotation(drag,next) {
    if(!this.preview){this.preview=svg(this.doc,'g',{'data-htmlmemo-preview':''});this.layer.append(this.preview);}
    this.preview.replaceChildren();if(!next)return;
    const origin=this.layerOrigin(),a=drag.annotation,range=rangeFromOffsets(this.doc,next.textAnchor.start,next.textAnchor.end,drag.index);
    for(const rect of range?.getClientRects?.()||[]){
      if(!rect.width||!rect.height)continue;
      const x=rect.left-origin.left,y=rect.top-origin.top;
      this.preview.append(a.type==='highlight'?svg(this.doc,'rect',{x,y,width:rect.width,height:rect.height,fill:a.color,opacity:a.opacity}):svg(this.doc,'path',{d:`M${x},${y+(a.type==='underline'?rect.height:rect.height/2)}h${rect.width}`,fill:'none',stroke:a.color,'stroke-width':a.width}));
    }
  }
  moveAnnotationDrag(event) {
    const drag=this.annotationDrag;if(!drag||drag.pointerId!==event.pointerId)return false;
    event.preventDefault();event.stopPropagation();
    if(this.disposed||this.tool!=='select'||drag.section!==currentSection(this.doc)){this.cancelAnnotationDrag();return true;}
    const point=this.point(event);drag.delta={x:point.x-drag.start.x,y:point.y-drag.start.y};drag.lastPoint={clientX:event.clientX,clientY:event.clientY};
    if(!drag.moved){
      if(Math.hypot(drag.delta.x,drag.delta.y)*(this.zoom||1)<4)return true;
      drag.moved=true;this.doc.documentElement.setAttribute('data-htmlmemo-moving','');
      drag.sources=[...this.doc.querySelectorAll(`[data-htmlmemo-id="${drag.annotation.id}"],[data-htmlmemo-hit="${drag.annotation.id}"]`)];
      for(const node of drag.sources)node.setAttribute('data-htmlmemo-drag-source','');
      this.selection=null;this.doc.getSelection?.()?.removeAllRanges();
      try{this.doc.documentElement.setPointerCapture?.(event.pointerId);}catch{/* Document listeners still handle an available pointer. */}
      if(drag.geometry){this.preview=this.drawAnnotation(drag.annotation,false,drag.geometry);this.preview.removeAttribute('data-htmlmemo-id');this.preview.setAttribute('data-htmlmemo-preview','');this.layer.append(this.preview);}
    }
    this.callbacks.onAnnotationInput?.();
    if(drag.geometry)this.preview.setAttribute('transform',`translate(${drag.delta.x} ${drag.delta.y})`);
    else{drag.next=this.movedTextAnnotation(drag,event);this.previewTextAnnotation(drag,drag.next);}
    return true;
  }
  movedDrawingAnnotation(drag,event) {
    const target=this.annotationDragTarget(event);if(!target)return null;
    const box=this.elementAnchor(target,true),points=drag.geometry.points.map(p=>({x:p.x+drag.delta.x,y:p.y+drag.delta.y}));
    const next={...drag.annotation,anchor:box.key,anchorTarget:box.target};let width=box.width,height=box.height;
    if(next.type==='pen'){
      const scale=drag.geometry.scale||1,fontSize=box.fontSize/scale;
      if(!Number.isFinite(fontSize)||fontSize<.1||fontSize>1000)return null;
      const basis={width:clamp(width/scale,1,1e8),height:clamp(height/scale,1,1e8),fontSize};width=basis.width*scale;height=basis.height*scale;
      const textAnchor=this.capturePenTextAnchor(this.resolveDrawingTarget(next),points,box,this.layerOrigin(),scale);
      if(textAnchor)basis.textAnchor=textAnchor;next.penBasis=basis;
    }
    next.points=points.map(p=>({x:(p.x-box.x)/width,y:(p.y-box.y)/height}));return next;
  }
  cancelAnnotationDrag() {
    const drag=this.annotationDrag;if(!drag)return false;this.annotationDrag=null;
    if(drag.moved){this.suppressAnnotationClick=performance.now()+500;this.annotationDragEndedAt=performance.now();}
    this.preview?.remove();this.preview=null;
    for(const node of drag.sources||[])node.removeAttribute('data-htmlmemo-drag-source');
    this.doc.documentElement.removeAttribute('data-htmlmemo-moving');
    try{if(this.doc.documentElement.hasPointerCapture?.(drag.pointerId))this.doc.documentElement.releasePointerCapture(drag.pointerId);}catch{/* The pointer may already have been released. */}
    return true;
  }
  finishAnnotationDrag(event) {
    const drag=this.annotationDrag;if(!drag||drag.pointerId!==event.pointerId)return false;
    // Keep a touch drop at the last visible preview; a release can report
    // coordinates after the browser has already ended direct manipulation.
    if(drag.moved&&event.pointerType!=='touch')this.moveAnnotationDrag(event);
    if(this.annotationDrag!==drag)return true;
    let next=null;
    if(drag.moved&&this.metadata.annotations.includes(drag.source)&&drag.section===currentSection(this.doc)){
      if(drag.geometry){if(Math.hypot(drag.delta.x,drag.delta.y)>.001)next=this.movedDrawingAnnotation(drag,event.pointerType==='touch'?drag.lastPoint:event);}
      else{const entry=this.searchCache().entry(this.doc.body);this.searchCache().flush(entry);if(!entry.dirty&&entry.index===drag.index)next=drag.next;if(next?.textAnchor.start===drag.resolved.start&&next?.textAnchor.end===drag.resolved.end)next=null;}
    }
    this.cancelAnnotationDrag();
    if(drag.moved){event.preventDefault();event.stopPropagation();if(next)this.commit(this.metadata.annotations.map(a=>a.id===next.id?next:a));}
    return true;
  }
  textMarkPoint(event,strict=false) {
    const hit=this.textAtClick(event);if(hit?.node)return this.isInteractiveControl(hit.node)||hit.node.parentElement?.closest('[contenteditable]')?null:hit;
    if(strict)return null;
    // A moving finger may reach the whitespace at a line end. Keep the nearest
    // text caret, while refusing controls and text outside this document.
    let node,offset;
    try{const caret=this.doc.caretPositionFromPoint?.(event.clientX,event.clientY),range=caret?null:this.doc.caretRangeFromPoint?.(event.clientX,event.clientY);node=caret?.offsetNode||range?.startContainer;offset=caret?.offset??range?.startOffset;}catch{return null;}
    if(node?.nodeType!==3||!Number.isInteger(offset)||!node.isConnected||!node.textContent.trim()||!this.doc.body.contains(node)||this.isInteractiveControl(node)||node.parentElement?.closest('script,style,noscript,svg,textarea,template,[data-htmlmemo-ui],[contenteditable]'))return null;
    return {node,offset:clamp(offset,0,node.textContent.length-1)};
  }
  startTextMarkGesture(event) {
    if(!TEXT_TOOLS.includes(this.tool)||!['touch','pen'].includes(event.pointerType)||this.disposed||this.host?.hidden||this.preparing)return false;
    if(this.textMarkGesture){this.cancelTextMarkGesture();return true;}
    if(event.isPrimary===false)return false;
    const start=this.textMarkPoint(event,true);if(!start)return false;
    const target=this.doc.documentElement;
    this.textMarkGesture={pointerId:event.pointerId,type:this.tool,start,target,x:event.clientX,y:event.clientY,section:currentSection(this.doc),moved:false,range:null};
    this.selection=null;this.doc.getSelection()?.removeAllRanges();
    event.preventDefault();event.stopPropagation();
    try{target.setPointerCapture?.(event.pointerId);}catch{/* Document listeners still receive an available pointer. */}
    this.callbacks.onAnnotationInput?.();return true;
  }
  moveTextMarkGesture(event) {
    const state=this.textMarkGesture;if(!state||state.pointerId!==event.pointerId)return false;
    event.preventDefault();event.stopPropagation();
    if(this.disposed||this.host?.hidden||this.preparing||this.tool!==state.type||currentSection(this.doc)!==state.section||!state.start.node.isConnected){this.cancelTextMarkGesture();return true;}
    if(!state.moved&&Math.hypot(event.clientX-state.x,event.clientY-state.y)<4)return true;
    const hit=this.textMarkPoint(event);if(!hit)return true;
    const forward=hit.node===state.start.node?hit.offset>=state.start.offset:!!(state.start.node.compareDocumentPosition(hit.node)&4);
    const first=forward?state.start:hit,last=forward?hit:state.start,range=this.doc.createRange(),selection=this.doc.getSelection();
    range.setStart(first.node,first.offset);range.setEnd(last.node,last.offset+1);
    if(!selection)return true;
    state.moved=true;state.range=range;selection.removeAllRanges();selection.addRange(range);
    this.callbacks.onAnnotationInput?.();return true;
  }
  cancelTextMarkGesture() {
    const state=this.textMarkGesture;if(!state)return false;
    this.textMarkGesture=null;this.selection=null;this.doc.getSelection()?.removeAllRanges();
    this.suppressAnnotationClick=performance.now()+500;
    try{state.target?.releasePointerCapture?.(state.pointerId);}catch{/* Capture may already have been released. */}
    return true;
  }
  finishTextMarkGesture(event) {
    const state=this.textMarkGesture;if(!state||state.pointerId!==event.pointerId)return false;
    if(event.pointerType!=='touch')this.moveTextMarkGesture(event);
    const valid=!this.disposed&&!this.host?.hidden&&!this.preparing&&this.textMarkGesture===state&&state.moved&&state.range&&this.tool===state.type&&currentSection(this.doc)===state.section&&state.range.startContainer.isConnected&&state.range.endContainer.isConnected;
    const anchor=valid?selectionAnchor(this.doc,state.range,this.searchCache().get()):null;
    this.cancelTextMarkGesture();event.preventDefault();event.stopPropagation();
    if(anchor)this.addText(state.type,anchor);
    return true;
  }
  pointerDown(event) {
    if (event.button !== 0) return;
    if(this.touchScroll&&event.pointerType==='touch')return;
    this.suppressAnnotationClick=0;
    if(this.annotationDrag){this.cancelAnnotationDrag();return;}
    if(this.tool==='select'&&this.startAnnotationDrag(event))return;
    if (this.tool === 'eraser') {
      const id = this.annotationIdAt(event.target); if (id) { event.preventDefault(); if(event.pointerType==='touch')this.touchErase={pointerId:event.pointerId,id};else this.remove(id); } return;
    }
    if (this.isInteractiveControl(event.target)) return;
    if(this.startTextMarkGesture(event))return;
    if (DRAW_TOOLS.includes(this.tool) || ['note','text'].includes(this.tool)) {
      if (this.gesture) { this.cancelDrawingGesture(); return; }
      event.preventDefault(); event.stopPropagation();
      const scrollHost = this.findAnnotationScrollHost();
      if (!this.layer?.isConnected || (scrollHost && this.layer.parentElement !== scrollHost)) this.renderDrawingLayer();
      const anchor = this.elementAnchor(event.target,true); const p = this.point(event);
      this.gesture = {pointerId:event.pointerId, target:event.target, type:this.tool, anchor, points:[p]};
      this.callbacks.onAnnotationInput?.();
      event.target.setPointerCapture?.(event.pointerId);
    }
  }
  pointerMove(event) {
    if(this.touchScroll&&event.pointerType==='touch')return;
    if(this.moveTextMarkGesture(event))return;
    if(this.moveAnnotationDrag(event))return;
    if (!this.gesture || this.gesture.pointerId !== event.pointerId) return;
    this.callbacks.onAnnotationInput?.();
    event.preventDefault();
    const p = this.point(event); const g = this.gesture;
    if (g.type === 'pen') { if (Math.hypot(p.x - g.points.at(-1).x, p.y - g.points.at(-1).y) >= 1) g.points.push(p); }
    else g.points[1] = p;
    this.preview?.remove(); this.preview = this.drawAnnotation(this.annotation(g.type, {points:g.points}), true);
    if (this.preview) { this.preview.setAttribute('data-htmlmemo-preview', ''); this.layer.append(this.preview); }
  }
  async pointerUp(event) {
    if(this.touchScroll&&event.pointerType==='touch')return;
    if(this.touchErase?.pointerId===event.pointerId){const {id}=this.touchErase;this.touchErase=null;if(this.tool==='eraser')this.remove(id);return;}
    if(this.finishTextMarkGesture(event))return;
    if(this.finishAnnotationDrag(event))return;
    if (this.gesture && this.gesture.pointerId === event.pointerId) {
      event.preventDefault(); const g = this.gesture; this.gesture = null; this.preview?.remove(); this.preview = null;
      const points = g.points.map(p => ({x:(p.x - g.anchor.x) / g.anchor.width, y:(p.y - g.anchor.y) / g.anchor.height}));
      if (['note','text'].includes(g.type)) {
        const text = await this.callbacks.requestText?.(g.type);
        if (text?.trim()) this.commit([...this.metadata.annotations, this.annotation(g.type, {anchor:g.anchor.key, anchorTarget:g.anchor.target, points:[points[0]], text:text.trim()})]);
      } else if (g.points.length > 1) {
        const penBasis = g.type === 'pen' && g.anchor.fontSize ? {width:g.anchor.width,height:g.anchor.height,fontSize:g.anchor.fontSize} : null;
        const next = this.annotation(g.type, {anchor:g.anchor.key, anchorTarget:g.anchor.target, points, ...(penBasis ? {penBasis} : {})});
        if(penBasis && this.doc){
          const origin=this.layerOrigin(),element=this.resolveDrawingTarget(next);
          const textAnchor=this.capturePenTextAnchor(element,g.points,g.anchor,origin);
          if(textAnchor)penBasis.textAnchor=textAnchor;
        }
        if (g.type === 'pen' && this.penTTL > 0) {
          const temporary = this.drawAnnotation(next);
          if (temporary) { temporary.dataset.htmlmemoPreview = ''; this.layer.append(temporary);setTimeout(() => temporary.remove(), this.penTTL * 1000); }
        } else this.commit([...this.metadata.annotations, next]);
      }
      return;
    }
    if (this.tool === 'select') setTimeout(() => {
      if (this.disposed || this.tool !== 'select') return;
      this.captureTextSelection();
      if (this.selection) this.callbacks.onTextSelection?.(this.selection);
    }, 0);
    if (TEXT_TOOLS.includes(this.tool)&&!['touch','pen'].includes(event.pointerType)) {
      const tool=this.tool,section=currentSection(this.doc);
      setTimeout(() => {
        if(this.disposed||this.tool!==tool||currentSection(this.doc)!==section)return;
        const selection = this.doc.getSelection();
        if (selection?.rangeCount && !selection.isCollapsed) this.addText(tool, selectionAnchor(this.doc, selection.getRangeAt(0),this.searchCache().get()));
      }, 0);
    }
  }
  render() {
    this.cancelTextMarkGesture();this.cancelAnnotationDrag();
    this.dynamicObserver?.disconnect();
    this.searchIndexCache?.invalidate();this.searchMarks=[];this.bookSearchMarks=[];
    cleanAnnotations(this.doc); this.selectedId = null;
    const style = this.doc.createElement('style'); style.id = 'htmlmemo-annotation-style';
    style.textContent = '[data-htmlmemo-mark]{border-radius:2px;box-decoration-break:clone;-webkit-box-decoration-break:clone}'; this.doc.head.append(style);
    const textAnnotations=this.metadata.annotations.filter(a=>TEXT_TOOLS.includes(a.type));
    const index=textAnnotations.length?textIndex(this.doc):null;
    const section = currentSection(this.doc);
    for (const annotation of textAnnotations) {
      if (!this.annotationInSection(annotation,section)) continue;
      const resolved = resolveTextAnchor(index, annotation.textAnchor); if (!resolved) continue;
      const style = annotation.type === 'highlight' ? `background:${annotation.color}${Math.round(annotation.opacity * 255).toString(16).padStart(2,'0')};color:inherit` : `text-decoration-line:${annotation.type === 'underline' ? 'underline' : 'line-through'};text-decoration-color:${annotation.color};text-decoration-thickness:${annotation.width}px;text-underline-offset:3px`;
      wrapOffsets(this.doc, resolved.start, resolved.end, {'data-htmlmemo-mark':'','data-htmlmemo-id':annotation.id}, style,index);
    }
    // Annotation restoration already made a current index. Adopt it instead
    // of walking the book again on the first search.
    if(index)this.searchCache().seed(this.doc.body,index);
    this.renderDrawingLayer();
    if (this.searchQuery) this.search(this.searchQuery, false);
    if (this.bookSearchHit) this.stepDocumentBookSearch(0,{move:false});
    this.observeDynamicDocument();
  }
  drawingGeometry(annotation, textIndexes = null,layout=null) {
    if (!this.annotationInSection(annotation,layout?.section??currentSection(this.doc))) return {points:[],scale:1};
    if (!annotation.anchor) return {points:annotation.points,scale:1};
    const origin = layout?.origin||this.layerOrigin();
    const scrollHost = origin.scrollHost;
    const element = this.resolveDrawingTarget(annotation,layout);
    // A delayed/absent paragraph is not the whole page. Keep its saved data,
    // and draw only once that actual target exists and has a rendered box.
    if (!element) return {points:[],scale:1};
    let metrics=layout?.boxes.get(element);
    if(metrics===undefined){
      const visible=element.getClientRects?.().length!==0&&(!scrollHost||scrollHost.contains(element)||element===this.doc.body||element===this.doc.documentElement||element.contains(scrollHost));
      metrics=visible?{box:this.anchorBox(element,origin)}:null;layout?.boxes.set(element,metrics);
    }
    if(!metrics)return {points:[],scale:1};
    const box = metrics.box;
    if (annotation.type === 'pen') {
      const fontSize = 'fontSize' in metrics?metrics.fontSize:(metrics.fontSize=this.drawingFontSize(element));
      let basis = annotation.penBasis;
      if (!basis && fontSize) {
        // Old files have no drawing-time font size. Preserve their first visible
        // appearance as the baseline; never guess it from the whole page.
        this.legacyPenBases ||= new Map();
        basis = this.legacyPenBases.get(annotation.id);
        if (!basis) { basis = {width:box.width,height:box.height,fontSize}; this.legacyPenBases.set(annotation.id,basis); }
      }
      if (basis && fontSize) {
        let scale = fontSize / basis.fontSize, dx=0, dy=0, textChanged=false;
        let index;
        const getIndex=()=>{
          if(index===undefined){
            if(textIndexes && !textIndexes.has(element))textIndexes.set(element,this.penTextIndex(element));
            index=textIndexes ? textIndexes.get(element) : this.penTextIndex(element);
          }
          return index;
        };
        if(!basis.textAnchor){
          // Older files do not contain a glyph reference. Pin their first visible
          // appearance without moving it or dirtying the document on open.
          this.legacyPenTextBases ||= new WeakMap();
          let cached=this.legacyPenTextBases.get(annotation.points);
          // A known old baseline must be measured at its drawing-time size.
          // Guessing a glyph from an already enlarged/reflowed stroke would
          // make it jump to the wrong word when the original size is restored.
          if(!cached && Math.abs(scale-1)<1e-6){
            const initialPoints=annotation.points.map(p=>({x:box.x+p.x*basis.width*scale,y:box.y+p.y*basis.height*scale}));
            const textAnchor=this.capturePenTextAnchor(element,initialPoints,box,origin,scale,getIndex());
            cached={basis:textAnchor?{...basis,textAnchor}:basis,scale};this.legacyPenTextBases.set(annotation.points,cached);
          }
          if(cached){basis=cached.basis;textChanged=Math.abs(scale-cached.scale)>1e-6;}
        }
        if(basis.textAnchor){
          const textIndex=getIndex(),hit=textIndex && this.resolvePenTextAnchor(textIndex,basis.textAnchor);
          const rect=hit && this.penTextRect(textIndex,hit.start,hit.end,origin);
          if(rect){
            scale=rect.fontSize/basis.textAnchor.fontSize;
            dx=rect.x-box.x-basis.textAnchor.x*scale;dy=rect.y-box.y-basis.textAnchor.y*scale;
            textChanged ||= Math.abs(dx)>.01 || Math.abs(dy)>.01;
          }
        }
        return {points:annotation.points.map(p => ({x:box.x+p.x*basis.width*scale+dx,y:box.y+p.y*basis.height*scale+dy})),scale,basis,textChanged};
      }
    }
    return {points:annotation.points.map(p => ({x:box.x + p.x * box.width, y:box.y + p.y * box.height})),scale:1};
  }
  absolutePoints(annotation) { return this.drawingGeometry(annotation).points; }
  annotationIdAt(target) {
    const node=(target?.nodeType===3?target.parentElement:target)?.closest?.('[data-htmlmemo-id],[data-htmlmemo-hit]');
    const id=node?.getAttribute('data-htmlmemo-id')||node?.getAttribute('data-htmlmemo-hit');
    return id&&this.metadata.annotations.some(annotation=>annotation.id===id)?id:null;
  }
  syncAnnotationPicking() {
    const root=this.doc?.documentElement,tool=this.tool||'select';
    if(['select','eraser'].includes(tool)){if(root?.getAttribute?.('data-htmlmemo-picking')!==tool)root?.setAttribute?.('data-htmlmemo-picking',tool);}else root?.removeAttribute?.('data-htmlmemo-picking');
    // Six screen pixels beyond either edge, independent of the reader zoom.
    const style=this.layer?.style,padding=12/(this.zoom||1)+'px';
    if(style&&style.getPropertyValue('--htmlmemo-hit-padding')!==padding)style.setProperty('--htmlmemo-hit-padding',padding);
  }
  drawingHitArea(node,id) {
    if(!['path','rect','ellipse','circle'].includes(node.localName))return null;
    const hit=node.cloneNode(false),width=node.getAttribute('stroke')==='none'?0:Number(node.getAttribute('stroke-width'))||0;
    hit.removeAttribute('data-htmlmemo-id');hit.setAttribute('data-htmlmemo-hit',id);hit.setAttribute('aria-hidden','true');hit.setAttribute('fill','none');hit.setAttribute('stroke','transparent');
    hit.setAttribute('style',`pointer-events:none;stroke-width:calc(${width}px + var(--htmlmemo-hit-padding,12px))`);
    return hit;
  }
  drawAnnotation(annotation, preview = false, geometry = null) {
    const {points:p,scale} = preview ? {points:annotation.points,scale:1} : geometry || this.drawingGeometry(annotation); if (!p?.length) return null;
    const attrs = {stroke:annotation.color, 'stroke-width':annotation.width * (annotation.type === 'pen' ? scale : 1), fill:'none', ...(FILL_TOOLS.includes(annotation.type)&&annotation.fill===true?{fill:annotation.color,'fill-opacity':annotation.fillOpacity}:{}), opacity:annotation.opacity, 'stroke-linecap':'round', 'stroke-linejoin':'round', 'data-htmlmemo-id':annotation.id, style:'pointer-events:visiblePainted;cursor:pointer'};
    const first = p[0]; const last = p.at(-1);
    if (annotation.type === 'pen') return svg(this.doc, 'path', {...attrs, d:p.map((point,i) => `${i ? 'L':'M'}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ')});
    if (['rect','area'].includes(annotation.type)) return svg(this.doc, 'rect', {...attrs, x:Math.min(first.x,last.x), y:Math.min(first.y,last.y), width:Math.abs(first.x-last.x), height:Math.abs(first.y-last.y), ...(annotation.type === 'area' ? {fill:annotation.color, stroke:'none'} : {})});
    if (annotation.type === 'area-underline') return svg(this.doc, 'path', {...attrs, d:`M${first.x},${first.y}L${last.x},${last.y}`});
    if (annotation.type === 'ellipse') return svg(this.doc, 'ellipse', {...attrs, cx:(first.x+last.x)/2, cy:(first.y+last.y)/2, rx:Math.abs(first.x-last.x)/2, ry:Math.abs(first.y-last.y)/2});
    if (annotation.type === 'circle') return svg(this.doc, 'circle', {...attrs, cx:(first.x+last.x)/2, cy:(first.y+last.y)/2, r:Math.min(Math.abs(first.x-last.x),Math.abs(first.y-last.y))/2});
    if (annotation.type === 'arrow') {
      const angle = Math.atan2(last.y-first.y,last.x-first.x); const len = 12 + annotation.width;
      return svg(this.doc, 'path', {...attrs, d:`M${first.x},${first.y}L${last.x},${last.y}M${last.x-len*Math.cos(angle-.5)},${last.y-len*Math.sin(angle-.5)}L${last.x},${last.y}L${last.x-len*Math.cos(angle+.5)},${last.y-len*Math.sin(angle+.5)}`});
    }
    if (['note','text'].includes(annotation.type)) {
      const group = svg(this.doc, 'g', {'data-htmlmemo-id':annotation.id, style:'pointer-events:visiblePainted;cursor:pointer'});
      const lines = (annotation.text || '메모').split('\n').flatMap(line => { const parts = []; for (let i = 0; i < Math.max(line.length,1); i += 24) parts.push(line.slice(i,i+24)); return parts; });
      const x = first.x; const y = first.y;
      if (annotation.type === 'note') group.append(svg(this.doc, 'rect', {x,y,width:Math.min(340,Math.max(130,Math.max(...lines.map(l=>l.length))*12+24)),height:lines.length*22+24,rx:5,fill:'#fff9df',stroke:annotation.color,'stroke-width':1.5}));
      const text = svg(this.doc, 'text', {x:x+(annotation.type==='note'?12:0),y:y+(annotation.type==='note'?25:16),fill:annotation.type==='note'?'#544a30':annotation.color,'font-size':annotation.type==='note'?14:18,'font-family':'system-ui,sans-serif'});
      lines.forEach((line,i) => { const span = svg(this.doc, 'tspan', {x:x+(annotation.type==='note'?12:0),dy:i===0?0:22}); span.textContent = line || ' '; text.append(span); }); group.append(text); return group;
    }
    return null;
  }
  renderDrawingLayer() {
    if (!this.doc || this.disposed || this.preparing) return;
    this.cancelAnnotationDrag();
    // Keep one overlay: source Mutation/ResizeObservers must not see a removed
    // and reinserted SVG every time their own layout changes.
    const scrollHost=this.ensureAnnotationLayerHost();
    const hostParent=scrollHost||this.doc.body;
    let layer=this.doc.getElementById(LAYER_ID);
    const drawings=this.metadata.annotations.filter(a=>!TEXT_TOOLS.includes(a.type));
    // These measurements are shared only within this synchronous pass. Never
    // retain boxes across reflow, zoom, chapter replacement or font changes.
    const layout=drawings.length?{...this.drawingTargetContext(),origin:this.layerOrigin(scrollHost),boxes:new WeakMap()}:null;
    const textIndexes=new WeakMap(),geometry=drawings.map(a=>this.drawingGeometry(a,textIndexes,layout));
    let upgraded=false;
    drawings.forEach((a,i)=>{
      // Persist a legacy baseline only after a font change, so simply opening
      // an old file does not mark it edited. Reload/export then retain the scale.
      if(a.type==='pen' && geometry[i].basis && ((!a.penBasis && Math.abs(geometry[i].scale-1)>1e-6) || (!a.penBasis?.textAnchor && geometry[i].basis.textAnchor && geometry[i].textChanged))){a.penBasis={...geometry[i].basis};upgraded=true;}
    });
    const contentKey=JSON.stringify(drawings);
    const layoutKey=JSON.stringify(geometry.map(({points,scale})=>({points,scale})));
    if(!layer){
      layer=svg(this.doc,'svg',{id:LAYER_ID,'aria-label':'HTMLMemo 주석',style:'position:absolute;top:0;left:0;z-index:2147483000;pointer-events:none;overflow:visible;'});
      layer.dataset.htmlmemoUi='';hostParent.append(layer);
      this.drawingContentKey=null;this.drawingLayoutKey=null;
    } else if (layer.parentElement!==hostParent) {
      hostParent.append(layer);
      this.drawingContentKey=null;this.drawingLayoutKey=null;
    }
    this.layer=layer;
    this.syncAnnotationPicking();
    const width=scrollHost ? Math.max(1, scrollHost.clientWidth || this.doc.documentElement?.clientWidth || this.naturalWidth) : (this.nativeScroll ? this.doc.documentElement?.clientWidth || this.naturalWidth : this.naturalWidth);
    const height=(this.nativeScroll || scrollHost) ? 1 : this.naturalHeight || 800;
    if(layer.getAttribute('width')!==String(width))layer.setAttribute('width',String(width));
    if(layer.getAttribute('height')!==String(height))layer.setAttribute('height',String(height));
    if(contentKey!==this.drawingContentKey || layoutKey!==this.drawingLayoutKey){
      layer.replaceChildren(...drawings.flatMap((a,i)=>{const node=this.drawAnnotation(a,false,geometry[i]);if(!node)return [];const hit=this.drawingHitArea(node,a.id);return hit?[node,hit]:[node];}));
      this.drawingContentKey=contentKey;this.drawingLayoutKey=layoutKey;
    }
    if(scrollHost){
      if(layer.style.left!=='0px')layer.style.left='0px';
      if(layer.style.top!=='0px')layer.style.top='0px';
    } else {
      const offset=layer.getBoundingClientRect();
      const left=(Number.parseFloat(layer.style.left)||0)-offset.left-this.rootScrollLeft();
      const top=(Number.parseFloat(layer.style.top)||0)-offset.top-this.rootScrollTop();
      if(Math.abs(left-(Number.parseFloat(layer.style.left)||0))>.5)layer.style.left=left+'px';
      if(Math.abs(top-(Number.parseFloat(layer.style.top)||0))>.5)layer.style.top=top+'px';
    }
    if(upgraded)this.callbacks?.onChange?.();
  }
  html() { return serializeHTML(this.runtime?this.runtime.exportDocument():this.doc, this.metadata); }
  async back() { const p = this.linkHistory.pop(); if (!p) return false; this.scrollTop=p.top; this.scrollLeft=p.left; this.callbacks.onView?.(); return true; }
  jump(target) {
    const r = target.getBoundingClientRect(), origin = this.layerOrigin(); this.scrollTop = Math.max(0,(r.top-origin.top+r.height/2)*this.zoom-this.viewport.clientHeight/2); this.scrollLeft = Math.max(0,(r.left-origin.left+r.width/2)*this.zoom-this.viewport.clientWidth/2);
  }
  jumpToHash(hash) {
    if(!hash||hash==='#')return false;
    let id;try{id=decodeURIComponent(hash.slice(1));}catch{id=hash.slice(1);}
    const target=this.doc.getElementById(id)||[...this.doc.querySelectorAll('a[name]')].find(a=>a.name===id);
    if(!target)return false;
    this.linkHistory.push({top:this.scrollTop,left:this.scrollLeft});if(this.linkHistory.length>128)this.linkHistory.shift();
    this.jump(target);this.callbacks.onView?.();return true;
  }
  async navigateSourceHash(hash) {
    if(this.preparing||this.disposed||typeof hash!=='string'||!hash.startsWith('#')||hash.length>=2000)return false;
    let id;try{id=decodeURIComponent(hash.slice(1));}catch{id=hash.slice(1);}
    if(this.annotationBookPaths().has(id))return this.jumpOutlineSection(id);
    const target=this.doc.getElementById(id)||[...this.doc.querySelectorAll('a[name]')].find(a=>a.name===id);
    return this.navigateSourceTarget(target);
  }
  navigateSourceTarget(target) {
    if(this.preparing||this.disposed||target?.ownerDocument!==this.doc||!target.isConnected||!this.doc.body.contains(target)||this.isInsideTocOrTopbar(target)||target.closest('script,style,template,[data-htmlmemo-ui]'))return false;
    this.cancelAnnotationJump?.();this.annotationJumpGeneration=(this.annotationJumpGeneration||0)+1;
    this.linkHistory.push({top:this.scrollTop,left:this.scrollLeft});if(this.linkHistory.length>128)this.linkHistory.shift();
    this.jump(target);this.callbacks.onView?.();return true;
  }
  async jumpOutlineSection(section) {
    if(!this.annotationBookPaths().has(section))return false;
    this.cancelAnnotationJump?.();
    const generation=this.annotationJumpGeneration=(this.annotationJumpGeneration||0)+1;
    try{
      if(this.preparing&&this.ready)await this.ready;
      if(this.disposed||generation!==this.annotationJumpGeneration)return false;
      if(currentSection(this.doc)!==section){
        const result=await this.waitForLocationTarget(null,{section,navigate:true,generation,bookmark:true,noticeMessage:'목차의 본문을 준비하는 중…'});
        if(this.disposed||generation!==this.annotationJumpGeneration||result.cancelled)return false;
        if(result.error)throw result.error;
        if(!result.ready)throw new Error('목차의 본문을 불러오지 못했습니다. 다시 눌러 주세요. 문서와 주석은 보관됩니다.');
      }
      // Source scripts run in a separate document: their scrollTo(0, 0) does
      // not move this visible reader, including a re-click of the current chapter.
      this.scrollTop=0;this.scrollLeft=0;this.callbacks.onView?.();return true;
    }catch(error){if(!this.disposed&&generation===this.annotationJumpGeneration)this.callbacks.onError?.(error);return false;}
  }
  async jumpAnnotation(id) {
    this.cancelAnnotationJump?.();
    const generation=this.annotationJumpGeneration=(this.annotationJumpGeneration||0)+1;
    const annotation=this.metadata.annotations.find(a=>a.id===id);if(!annotation)return false;
    try{
      if(this.preparing&&this.ready)await this.ready;
      if(this.disposed||generation!==this.annotationJumpGeneration)return false;
      const location=this.annotationLocation(annotation),section=location?.section||location?.startSection||annotation.textAnchor?.section||annotation.anchorTarget?.section;
      const navigate=!!section&&currentSection(this.doc)!==section;
      if(navigate){
        if(!this.annotationBookPaths().has(section))throw new Error('이 주석의 장을 현재 책 목차에서 찾지 못했습니다. 주석은 보관됩니다.');
      }
      const result=await this.waitForLocationTarget(annotation,{section,location,navigate,generation});
      if(this.disposed||generation!==this.annotationJumpGeneration||result.cancelled)return false;
      if(result.error)throw result.error;
      if(!result.ready)throw new Error(result.sectionReady?'이 주석의 원문 위치를 찾지 못했습니다. 주석은 보관됩니다.':'주석이 있는 장을 불러오지 못했습니다. 원본 책 목차에서 다시 열어 주세요. 주석은 보관됩니다.');
      const element=result.element;
      if(location?.approximate){
        const content=this.doc.getElementById('reader-content');
        const target=element||content?.querySelector('h1,h2,h3')||content;
        if(target)this.jump(target);
        this.selectedId=id;this.callbacks.onView?.();
        this.callbacks.onNotice?.(`${location.label}으로 이동했습니다. 정확한 주석 위치는 남아 있는 정보만으로 확정하기 어렵습니다.`);return true;
      }
      this.jump(element);this.selectedId=id;this.callbacks.onView?.();if(result.noticeShown)this.callbacks.onNotice?.('주석 위치로 이동했습니다.');return true;
    }catch(error){if(!this.disposed&&generation===this.annotationJumpGeneration)this.callbacks.onError?.(error);return false;}
  }
  async jumpBookmark(id) {
    this.cancelAnnotationJump?.();
    const generation=this.annotationJumpGeneration=(this.annotationJumpGeneration||0)+1;
    const mark=this.metadata.bookmarks.find(item=>item.id===id);if(!mark)return false;
    try{
      if(this.preparing&&this.ready)await this.ready;
      if(this.disposed||generation!==this.annotationJumpGeneration)return false;
      const saved=typeof mark.section==='string'?mark.section:'',section=(saved&&this.annotationLocation({textAnchor:{section:saved}})?.section)||saved,navigate=!!section&&currentSection(this.doc)!==section;
      if(navigate){
        if(!this.annotationBookPaths().has(section))throw new Error('이 북마크의 장을 현재 책 목차에서 찾지 못했습니다. 북마크는 보관됩니다.');
        const result=await this.waitForLocationTarget(mark,{section,navigate,generation,bookmark:true});
        if(this.disposed||generation!==this.annotationJumpGeneration||result.cancelled)return false;
        if(result.error)throw result.error;
        if(!result.ready)throw new Error('북마크가 있는 장을 불러오지 못했습니다. 원본 책 목차에서 다시 열어 주세요. 북마크는 보관됩니다.');
        if(result.noticeShown)this.callbacks.onNotice?.('북마크 위치로 이동했습니다.');
      }
      this.scrollTop=mark.top*this.zoom;this.scrollLeft=mark.left*this.zoom;this.callbacks.onView?.();
      if(!section&&this.annotationBookPaths().size)this.callbacks.onNotice?.('이전 북마크에 장 정보가 없어 현재 장의 저장된 화면 위치로 이동했습니다.');
      return true;
    }catch(error){if(!this.disposed&&generation===this.annotationJumpGeneration)this.callbacks.onError?.(error);return false;}
  }
  waitForLocationTarget(annotation,{section,location,navigate,generation,bookmark=false,noticeMessage}) {
    return new Promise(resolve=>{
      let settled=false,busy=false,scheduled=null,timer=null,notice=null,noticeShown=false,refresh=navigate;
      const cancelled=()=>this.disposed||generation!==this.annotationJumpGeneration;
      const book=!!section||this.bookIntegrity?.complete;
      const sectionReady=()=> (!section||currentSection(this.doc)===section)&&(!book||!this.doc.getElementById('reader-status')?.textContent.trim()&&this.doc.documentElement.dataset.readerReady!=='false');
      const finish=result=>{if(settled)return;settled=true;observer?.disconnect();clearTimeout(timer);clearTimeout(notice);clearTimeout(scheduled);if(this.cancelAnnotationJump===cancel)this.cancelAnnotationJump=null;resolve({...result,noticeShown});};
      const cancel=()=>finish({cancelled:true});
      const schedule=()=>{if(!settled&&!busy&&scheduled===null)scheduled=setTimeout(()=>{scheduled=null;void attempt();},40);};
      const MO=this.doc.defaultView?.MutationObserver,observer=MO?new MO(schedule):null;
      const observe=()=>{if(!settled)observer?.observe(this.doc.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['data-section','data-reader-ready']});};
      const attempt=async()=>{
        if(settled||busy)return;if(cancelled()){cancel();return;}if(!sectionReady())return;
        busy=true;observer?.disconnect();
        try{
          if(refresh||this.dynamicTask||this.dynamicRunning||this.dynamicDirty||this.dynamicRoots?.size){
            this.dynamicRoots?.add(this.doc.getElementById('reader-content')||this.doc.body);
            await this.refreshDynamicDocument();refresh=false;
          }
          if(settled||cancelled()){cancel();return;}if(!sectionReady())return;
          if(bookmark){finish({ready:true});return;}
          // Exact IDs can contain quotes in legacy imports; compare attributes,
          // not an interpolated selector. Never guess another matching sentence.
          const find=()=>[...this.doc.querySelectorAll('[data-htmlmemo-id]')].find(node=>node.getAttribute('data-htmlmemo-id')===annotation.id);
          let element=find();
          if(!element){this.render();this.measure();element=find();}
          if(element||location?.approximate&&this.doc.getElementById('reader-content')){finish({ready:true,element});return;}
          if(!this.metadata.execution?.allowScripts&&!this.bookIntegrity?.complete)finish({ready:false,sectionReady:true});
        }catch(error){finish({error});}
        finally{busy=false;observe();}
      };
      this.cancelAnnotationJump=cancel;observe();
      timer=setTimeout(()=>finish({ready:false,sectionReady:sectionReady()}),15000);
      notice=setTimeout(()=>{if(!settled){noticeShown=true;this.callbacks.onNotice?.(noticeMessage||(bookmark?'북마크가 있는 본문을 준비하는 중…':'주석이 있는 본문과 위치를 준비하는 중…'));}},250);
      try{if(navigate)this.doc.defaultView.location.hash=encodeURIComponent(section);void attempt();}catch(error){finish({error});}
    });
  }
  // Read only the small, complete TOC manifest. Never decode unopened book bodies
  // or expand the source reader's lazy tree just to list annotations.
  annotationBookPaths() {
    const data=this.doc.getElementById('book-manifest'),source=data?.textContent||'';
    if(this.annotationCatalogSource===source)return this.annotationCatalog;
    const paths=new Map(),sections=new Map();let manifest;
    try{manifest=JSON.parse(source);}catch{/* Ordinary HTML has no book manifest. */}
    if(['book-html-v1','memosuite-book-html-v1'].includes(manifest?.format)&&Array.isArray(manifest.volumes)){
      let order=0;const categories=new Map();
      manifest.volumes.forEach((volume,vi)=>{
        if(!volume||typeof volume!=='object')return;
        const root={id:JSON.stringify(['volume',vi]),title:volume.label||volume.title||volume.book||`${vi+1}권`,order:vi,kind:'volume'};
        for(const section of Array.isArray(volume.sections)?volume.sections:[]){
          if(typeof section?.key!=='string'||paths.has(section.key))continue;
          const path=[root],names=[];
          for(const title of String(section.category||'').split(' › ').map(s=>s.trim()).filter(Boolean).slice(0,32)){
            names.push(title);const id=JSON.stringify(['category',vi,...names]);
            if(!categories.has(id))categories.set(id,{id,title,order:order++,kind:'category'});
            path.push(categories.get(id));
          }
          path.push({id:JSON.stringify(['section',section.key]),title:section.title||section.key,order:order++,kind:'section'});
          paths.set(section.key,path);
          sections.set(section.key,section);
        }
      });
    }
    this.annotationCatalogSource=source;this.annotationCatalog=paths;this.annotationSections=sections;this.annotationLocations=new WeakMap();
    this.annotationOpening=null;
    // The reported legacy annotations precede 1.1 in the introductory volume.
    // Use the actual first-part branch and the TOC interval before 1.1, not a
    // global rename of every unresolved annotation in every book.
    const entries=[...paths.entries()],intro=entries.find(([,path])=>/입문|\bintro(?:duction|ductory)?\b/i.test(path[0].title));
    if(intro){
      const volume=entries.filter(([,path])=>path[0].id===intro[1][0].id);
      const firstChapter=volume.findIndex(([,path])=>/^\s*[\[(（]?\s*(?:제\s*)?1\s*[.．]\s*1(?=\D|$)/.test(path.at(-1).title));
      if(firstChapter>0){
        const chapterPath=volume[firstChapter][1],isFirstPart=part=>/(?:^|\s|[\[(（])(?:제\s*)?0*1\s*부(?:\D|$)|\bpart\s*0*1\b/i.test(part.title);
        let parent=chapterPath.slice(0,-1),part=parent.findIndex(isFirstPart);
        if(part>=0)parent=parent.slice(0,part+1);
        else{
          const openingPath=volume[0][1].slice(0,-1);part=openingPath.findIndex(isFirstPart);
          parent=part>=0?openingPath.slice(0,part+1):[chapterPath[0],{id:JSON.stringify(['part',chapterPath[0].id,1]),title:'1부',order:-1,kind:'category'}];
        }
        const allowedSections=volume.slice(0,firstChapter).map(([key])=>key);
        this.annotationOpening={path:[...parent,{id:JSON.stringify(['opening',parent.at(-1).id]),title:'1부 앞부분',order:-1,kind:'opening'}],allowedSections,startSection:allowedSections[0],label:'1부 앞부분',approximate:true};
      }
    }
    return paths;
  }
  annotationLocation(annotation) {
    const paths=this.annotationBookPaths();
    if(!paths.size)return null;
    this.annotationLocations ||= new WeakMap();
    const cached=this.annotationLocations.get(annotation);if(cached)return cached;
    const saved=annotation.textAnchor?.section||annotation.anchorTarget?.section;
    const exact=section=>({path:paths.get(section),section});
    let location=paths.has(saved)?exact(saved):null;
    if(!location&&typeof saved==='string'){
      // Older exports can keep a document ID or a section/heading fragment.
      const keys=[...paths.keys()],prefix=keys.filter(key=>saved.startsWith(key+'/')||saved.startsWith(key+'#')).sort((a,b)=>b.length-a.length);
      const ids=keys.filter(key=>this.annotationSections?.get(key)?.id===saved);
      if(prefix.length)location=exact(prefix[0]);else if(ids.length===1)location=exact(ids[0]);
    }
    if(!location){
      let candidates=[...paths.entries()];const volume=typeof saved==='string'?/^v(\d+):/.exec(saved):null;
      if(volume)candidates=candidates.filter(([,path])=>path[0].order===Number(volume[1]));
      const target=annotation.anchorTarget;
      if(target&&/^h[1-6]$/.test(target.tag)&&target.quote){
        const normalize=value=>String(value).replace(/\s+/g,' ').trim();
        const quote=normalize(target.quote),matching=candidates.filter(([,path])=>path.some(part=>normalize(part.title)===quote));
        if(matching.length===1&&normalize(matching[0][1].at(-1).title)===quote)location=exact(matching[0][0]);
        else if(matching.length)candidates=matching;
        else if(!volume)candidates=[];
      }else if(!volume)candidates=[];
      if(!location&&candidates.length){
        let common=candidates[0][1].filter(part=>part.kind!=='section');
        for(const [,path] of candidates)common=common.filter((part,index)=>path[index]?.id===part.id);
        if(common.length){
          const parent=common.at(-1),label=`${parent.title} 내 세부 위치 미확인`;
          location={path:[...common,{id:JSON.stringify(['partial',parent.id]),title:'세부 위치 미확인',order:Number.MAX_SAFE_INTEGER,kind:'other'}],startSection:candidates[0][0],label,approximate:true};
        }
      }
    }
    // Keep the user-confirmed opening assignment stable after chapter changes.
    // A saved chapter, matching title, or conflicting numbered heading wins.
    const target=annotation.anchorTarget,numberedHeading=target&&/^h[1-6]$/.test(target.tag)&&/^\s*[\[(（]?\s*(?:제\s*)?\d+\s*(?:부|[.．]\s*\d+)/.test(target.quote);
    if(!location&&!saved&&!numberedHeading&&this.annotationOpening&&this.annotationOpening.allowedSections.includes(this.initialBookSection))location=this.annotationOpening;
    if(location)this.annotationLocations.set(annotation,location);
    return location;
  }
  annotationInSection(annotation,section=currentSection(this.doc)) {
    const location=this.annotationLocation(annotation);
    if(location?.allowedSections)return location.allowedSections.includes(section);
    const saved=location?.section||annotation.textAnchor?.section||annotation.anchorTarget?.section;
    return !saved||saved===section;
  }
  annotationTree(contexts=this.annotationContexts()) {
    const paths=this.annotationBookPaths();
    const preamble=this.outline().some(item=>!this.isInsideTocOrTopbar(item.node))?'목차 밖 주석':'문서 전체';
    return this.locationTree(this.metadata.annotations,'annotations',annotation=>{
      const section=annotation.textAnchor?.section||annotation.anchorTarget?.section;
      let path=this.annotationLocation(annotation)?.path;
      if(!path?.length){
        path=paths.size||section?[{id:'unlocated',title:'목차 위치 미확인',order:Number.MAX_SAFE_INTEGER,kind:'other'}]
          :contexts.get(annotation.id)?.path;
        if(!path?.length)path=[{id:'preamble',title:preamble,order:-1,kind:'other'}];
      }
      return path;
    });
  }
  bookmarkTree() {
    const paths=this.annotationBookPaths(),contexts=paths.size?new Map():this.bookmarkContexts();
    const preamble=this.outline().some(item=>!this.isInsideTocOrTopbar(item.node))?'목차 밖 북마크':'문서 전체';
    return this.locationTree([...this.metadata.bookmarks].sort((a,b)=>a.top-b.top||a.left-b.left),'bookmarks',mark=>{
      // Old bookmarks saved only coordinates. Never assign them to whichever
      // chapter happens to be open, or to the annotation-only legacy opening.
      const section=typeof mark.section==='string'?mark.section:'';
      const path=section?this.annotationLocation({textAnchor:{section}})?.path:contexts.get(mark.id);
      const unresolved=!!(paths.size||section);
      return path?.length?path:[{id:unresolved?'unlocated':'preamble',title:unresolved?'목차 위치 미확인':preamble,order:unresolved?Number.MAX_SAFE_INTEGER:-1,kind:'other'}];
    });
  }
  locationTree(items,field,pathFor) {
    const roots=[],nodes=new Map();
    for(const item of items){
      let children=roots,node;
      const path=pathFor(item);
      for(const part of path){
        node=nodes.get(part.id);
        if(!node){node={...part,children:[],[field]:[],count:0};nodes.set(part.id,node);children.push(node);}
        node.count++;children=node.children;
      }
      node[field].push(item);
    }
    const sort=list=>{list.sort((a,b)=>(a.kind==='section')-(b.kind==='section')||a.order-b.order);for(const node of list)sort(node.children);};
    sort(roots);return roots;
  }
  headingContexts() {
    const outline=this.outline().filter(item=>!this.isInsideTocOrTopbar(item.node));
    const paths=[],stack=[];
    outline.forEach((item,index)=>{
      while(stack.length&&stack.at(-1).level>=item.level)stack.pop();
      stack.push({id:JSON.stringify(['heading',currentSection(this.doc),index,item.node.id||'']),title:item.title,level:item.level,order:index,kind:'heading'});
      paths.push([...stack]);
    });
    return {outline,paths};
  }
  bookmarkContexts(marks=this.metadata.bookmarks) {
    const {outline,paths}=this.headingContexts(),result=new Map();if(!outline.length)return result;
    const origin=this.layerOrigin(),section=currentSection(this.doc);
    const positions=outline.map(({node},index)=>({top:node.getBoundingClientRect?.().top-origin.top,index})).filter(item=>Number.isFinite(item.top)).sort((a,b)=>a.top-b.top||a.index-b.index);
    const savedPaths=new Map(paths.map(path=>[path.at(-1).id,path]));
    for(const mark of marks){
      if(mark.section&&mark.section!==section)continue;
      let path=savedPaths.get(mark.heading),lo=0,hi=positions.length-1,found=-1;
      if(!path){
        while(lo<=hi){const mid=(lo+hi)>>1;if(positions[mid].top<=mark.top+1){found=mid;lo=mid+1;}else hi=mid-1;}
        path=found>=0?paths[positions[found].index]:[];
      }
      result.set(mark.id,path);
    }
    return result;
  }
  // The annotation list shows more than the tool name: the text an annotation marks or was drawn on,
  // and the heading it sits under. Headings are in document order, so the last one at or before the
  // annotation is found by binary search. A drawing on empty space falls back to its drawn position.
  annotationContexts() {
    const {outline,paths}=this.headingContexts(),headings=outline.map(item=>item.node),result=new Map();
    const headingBefore = node => {
      let lo = 0, hi = headings.length - 1, found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1, h = headings[mid];
        if (h === node || h.contains(node) || (h.compareDocumentPosition(node) & 4)) { found = mid; lo = mid + 1; } else hi = mid - 1;
      }
      return found;
    };
    let tops = null;
    const headingAbove = element => {
      const top = element.getBoundingClientRect?.().top;
      if (!Number.isFinite(top)) return -1;
      tops ||= headings.map(h=>{const r=h.getBoundingClientRect();return r.width||r.height?r.top:NaN;});
      let found = -1; tops.forEach((value,index)=>{if(value <= top + 1)found = index;}); return found;
    };
    const markedNodes=new Map(),drawnNodes=new Map(),context=this.drawingTargetContext();
    for(const node of this.doc.querySelectorAll('[data-htmlmemo-id]')){
      const id=node.getAttribute('data-htmlmemo-id');if(!drawnNodes.has(id))drawnNodes.set(id,node);
      if(node.hasAttribute('data-htmlmemo-mark')&&!markedNodes.has(id))markedNodes.set(id,node);
    }
    for (const annotation of this.metadata.annotations) {
      const marked = TEXT_TOOLS.includes(annotation.type);
      const node = marked ? markedNodes.get(annotation.id) : this.resolveDrawingTarget(annotation,context);
      let index = node?.isConnected && node !== this.doc.body ? headingBefore(node) : -1;
      if (index < 0 && !marked) { const drawn = drawnNodes.get(annotation.id); if (drawn) index = headingAbove(drawn); }
      result.set(annotation.id, {quote:annotation.textAnchor?.quote || annotation.anchorTarget?.quote || (node?.isConnected ? this.drawingTargetQuote(node) : ''),
        heading:index >= 0 ? headings[index].textContent.replace(/\s+/g, ' ').trim() : '',path:index>=0?paths[index]:[]});
    }
    return result;
  }
  searchCache(){return this.searchIndexCache ||= new SearchIndexCache(this.doc);}
  clearSearchHighlight() {
    this.searchMarks ||= [...this.doc.querySelectorAll('[data-htmlmemo-search]')].filter(mark=>!mark.hasAttribute('data-htmlmemo-book-search-hit'));
    for(const mark of this.searchMarks)if(mark.isConnected)mark.replaceWith(...mark.childNodes);
    this.searchMarks=[];
  }
  async searchAsync(query,move=true,isCurrent=()=>true) {
    const generation=this.searchGeneration=(this.searchGeneration||0)+1;
    if(query.trim())await this.searchCache().prepare();
    if(this.disposed||generation!==this.searchGeneration||!isCurrent())return null;
    return this.search(query,move);
  }
  search(query, move = true) {
    this.searchGeneration=(this.searchGeneration||0)+1;
    this.searchQuery = query;
    const cache=this.searchCache();cache.mutate(null,()=>this.clearSearchHighlight(),false);
    this.searchResults = []; this.searchPosition = -1;
    if (!query.trim()) { this.callbacks?.onSearchChange?.(this); return []; }
    const {index,results}=cache.query(query);this.searchTextIndex=index;this.searchResults=results;
    // Only the active hit is marked, keeping long documents responsive.
    if (move && this.searchResults.length) this.nextSearch(1); else this.callbacks?.onSearchChange?.(this); return this.searchResults;
  }
  nextSearch(direction) {
    if(!this.searchQuery?.trim())return false;
    const cache=this.searchCache(),index=cache.get();
    if(this.searchTextIndex!==index&&this.searchQuery)this.search(this.searchQuery,false);
    if (!this.searchResults.length) return false;
    const position=clamp(this.searchPosition+direction,0,this.searchResults.length-1);
    if(position===this.searchPosition)return false;
    this.searchPosition=position;
    cache.mutate(null,()=>this.clearSearchHighlight(),false);const result=this.searchResults[this.searchPosition];
    const range=rangeFromOffsets(this.doc,result.start,result.end,index); if (!range) { this.callbacks?.onSearchChange?.(this); return false; }
    const rect=range.getBoundingClientRect(), origin=this.layerOrigin(); this.scrollTop=Math.max(0,(rect.top-origin.top+rect.height/2)*this.zoom-this.viewport.clientHeight/2);
    this.scrollLeft=Math.max(0,(rect.left-origin.left+rect.width/2)*this.zoom-this.viewport.clientWidth/2);
    this.searchMarks=cache.mutate(index,()=>wrapOffsets(this.doc,result.start,result.end,{'data-htmlmemo-search':''},'background:#f0a85b80;outline:2px solid #df9057;border-radius:2px;color:inherit',index));
    this.callbacks?.onSearchChange?.(this);return true;
  }
  outline() { return [...this.doc.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(n=>n.textContent.trim()&&!n.closest('[data-htmlmemo-ui]')).map(node=>({node,level:Number(node.localName[1]),title:node.textContent.trim()})); }
  addBookmark(title) {
    const mark={id:uid(),title,top:this.scrollTop/this.zoom,left:this.scrollLeft/this.zoom},section=currentSection(this.doc);
    if(section)mark.section=section;
    if(!this.annotationBookPaths().size){const path=this.bookmarkContexts([mark]).get(mark.id);if(path?.length)mark.heading=path.at(-1).id;}
    this.metadata.bookmarks.push(mark);this.callbacks.onChange?.();
  }
  readAloudPlayer() {
    if(this.disposed||this.host.hidden)return null;
    if(!this.host.ownerDocument.defaultView.speechSynthesis){this.callbacks.onError?.(new Error('기기의 음성 읽기를 지원하지 않습니다.'));return null;}
    return this.readAloud ||= createReadAloud(this);
  }
  speakSelection(anchor=this.selection||this.captureTextSelection()) {
    if(!anchor?.quote?.trim())return false;
    return this.readAloudPlayer()?.openSelection(anchor)||false;
  }
  toggleReadAloud() {
    this.readAloudPlayer()?.toggle();
  }
  stopSpeech() { this.readAloud?.close(); this.host?.ownerDocument?.defaultView?.speechSynthesis?.cancel(); }
  dispose() {
    this.cancelTextMarkGesture();this.cancelAnnotationDrag();
    this.cancelDrawingGesture();this.touchScroll=null;this.touchErase=null;
    this.searchGeneration=(this.searchGeneration||0)+1;this.searchIndexCache?.dispose();
    this.cancelBookSearchJump?.();this.documentBookSearchObserver?.disconnect();if(this.documentBookSearchResults)this.clearDocumentBookSearchHighlight();
    this.stopMiddleScroll();this.readAloud?.dispose();this.readAloud=null;this.stopSpeech(); this.disposed=true;this.cancelOpeningWait?.();this.cancelAnnotationJump?.();this.cancelFrameOpen?.();this.runtime?.dispose(); clearTimeout(this.positionTimer);clearTimeout(this.dynamicTimer);clearTimeout(this.documentSidebarUI?.sidebarSearchTimer);this.dynamicObserver?.disconnect();this.fontObserver?.disconnect();if(this.fontFrame)this.doc.defaultView?.cancelAnimationFrame(this.fontFrame); this.resizeObserver?.disconnect(); this.hostObserver?.disconnect(); this.frame.srcdoc=''; if(this.documentURL){URL.revokeObjectURL(this.documentURL);this.documentURL=null;} this.host.remove();
  }
}
