import { createReadAloud } from './read-aloud.js';
import { clamp, uid } from './utils.js';
import { History, TEXT_TOOLS, DRAW_TOOLS } from './model.js';
import { LAYER_ID, prepareLoadedHTML, cleanAnnotations, textIndex, selectionAnchor, resolveTextAnchor, wrapOffsets, rangeFromOffsets, serializeHTML, inspectBookDocument, drawingTargetQuote, describeDrawingTarget, currentSection } from './document.js';

const NS = 'http://www.w3.org/2000/svg';
const TOC_WIDTH_KEY = 'htmlmemo-doc-toc-width-v1', TOC_EXPANDED_WIDTH_KEY = 'htmlmemo-doc-toc-expanded-width-v1', TOC_MIN = 8, TOC_STRIP_SNAP = 48, TOC_MAX = 640, TOC_DEFAULT = 260;
const svg = (doc, tag, attrs = {}) => { const node = doc.createElementNS(NS, tag); for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value)); return node; };
export class Reader {
  constructor(host, parsed, callbacks) {
    this.host = host; this.metadata = parsed.metadata; this.callbacks = callbacks; this.history = new History(this.metadata.annotations);
    this.tool = 'select'; this.color = '#edcf67'; this.width = 3; this.opacity = .35; this.penTTL = 0; this.zoom = 1;
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
    this.frame.setAttribute('sandbox', this.metadata.execution?.allowScripts ? 'allow-same-origin allow-scripts' : 'allow-same-origin'); this.frame.referrerPolicy = 'no-referrer';
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
            const prepared = await prepareLoadedHTML(this.doc, this.metadata, () => this.disposed, {serialize:false});
            this.doc.removeEventListener('click',blockNavigation,true);this.doc.removeEventListener('keydown',blockNavigation,true);
            const openingScroll = {top:this.doc.defaultView.scrollY,left:this.doc.defaultView.scrollX};
            this.metadata = parsed.savedMetadata ? {...prepared.metadata,...parsed.metadata} : prepared.metadata; this.history = new History(this.metadata.annotations);
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
          this.preparing = false; this.measure(); this.render();
          await new Promise(done => requestAnimationFrame(done));
          if (this.disposed) { resolve(this); return; }
          this.scrollTop = this.openingScroll?.top ? this.openingScroll.top*this.zoom : Number(this.metadata.view.scrollTop) || 0;
          this.scrollLeft = this.openingScroll?.left ? this.openingScroll.left*this.zoom : Number(this.metadata.view.scrollLeft) || 0;
          this.measure(); this.renderDrawingLayer();
          // Scroll restoration and source ResizeObservers settle before the
          // first visible frame, so annotations do not flash at the page top.
          await new Promise(done => requestAnimationFrame(done));
          if (this.disposed) { resolve(this); return; }
          this.measure(); this.renderDrawingLayer();
          this.setupDocumentSidebar();
          this.frame.style.visibility = 'visible'; this.frame.style.pointerEvents = '';
          this.frame.removeAttribute('aria-hidden'); this.viewport.setAttribute('aria-busy', 'false');this.loading.remove();
          this.callbacks.onView?.(); resolve(this);
        } catch (error) { reject(error); }
      }, {once:true});
    });
    if (this.nativeScroll) {
      this.documentURL = URL.createObjectURL(parsed.file || new Blob([parsed.html], {type:'text/html;charset=utf-8'}));
      this.frame.src = this.documentURL;
    } else this.frame.srcdoc = parsed.html;
  }
  waitForBookContent() {
    if (!this.bookIntegrity?.complete) return Promise.resolve();
    const content = this.doc.getElementById('reader-content');
    if (!content) return Promise.resolve();
    const ready = () => this.doc.documentElement.dataset.readerReady === 'true' ||
      (content.childElementCount > 0 && !this.doc.getElementById('reader-status')?.textContent.trim());
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
  bind({deferDynamicObserver = false} = {}) {
    let editorStyle = this.doc.getElementById('htmlmemo-editor-style');
    if (!editorStyle) {
      editorStyle = this.doc.createElement('style');
      editorStyle.id = 'htmlmemo-editor-style';
      editorStyle.textContent = this.baseEditorStyle();
      (this.doc.head || this.doc.documentElement).append(editorStyle);
    }
    this.setupDocumentTocResize();
    if (this.bound) {
      if (!deferDynamicObserver) this.startDynamicObserver();
      return;
    }
    this.bound = true;
    this.doc.addEventListener('wheel', event => this.forwardWheel(event), {capture:true,passive:false});
    this.doc.addEventListener('pointerdown', event => { if(this.startTocResize(event))return; if(this.startMiddleScroll(event))return;this.stopMiddleScroll();this.callbacks.onSelectionDismiss?.(); this.pointerDown(event); }, true);
    this.doc.addEventListener('mousedown', event => { if(this.startTocResize(event))return; }, true);
    this.doc.addEventListener('dragstart', event => { if(this.tocDrag||this.isTocResizeTarget(event))event.preventDefault(); }, true);
    this.doc.addEventListener('pointermove', event => { if(this.tocDrag)return; if(this.moveMiddleScroll(event))return;this.pointerMove(event); }, true);
    this.doc.addEventListener('pointerup', event => { if(this.tocDrag)return; if(this.endMiddleScroll(event))return;this.pointerUp(event); }, true);
    this.doc.addEventListener('pointercancel', () => { this.stopMiddleScroll();this.gesture = null; this.preview?.remove(); this.preview = null; });
    this.doc.addEventListener('auxclick', event => {if(event.button===1&&!event.target.closest?.('a,button,input,textarea,select,[contenteditable]'))event.preventDefault();}, true);
    this.doc.addEventListener('selectionchange', () => { const s = this.doc.getSelection(); if (s?.rangeCount && !s.isCollapsed) this.selection = selectionAnchor(this.doc, s.getRangeAt(0)); });
    this.doc.addEventListener('keydown', event => {if(this.handleTocKeydown(event))return; if(event.key==='Escape'&&this.middleScroll){this.stopMiddleScroll();event.preventDefault();return;}this.callbacks.onKey?.(event);}, true);
    this.doc.addEventListener('dblclick', event => {if(this.handleTocDblClick(event))return; this.focusDocument(event);}, true);
    this.viewport.addEventListener('dblclick', event => this.focusDocument(event));
    const jumpToHash = hash => {
      if (!hash || hash === '#') return false;
      let id; try { id = decodeURIComponent(hash.slice(1)); } catch { id = hash.slice(1); }
      if (!id) return false;
      const target = this.doc.getElementById(id) || [...this.doc.querySelectorAll('a[name]')].find(a => a.name === id);
      if (!target) return false;
      this.linkHistory.push({top:this.scrollTop, left:this.scrollLeft});
      if (this.linkHistory.length > 128) this.linkHistory.shift();
      this.jump(target);
      return true;
    };
    this.doc.addEventListener('click', event => {
      const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
      this.lastTocClickState = this.captureTocClickState(target);
      if (this.tocResizeJustEnded || this.isTocResizerNode(target)) { this.tocResizeJustEnded = false; event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation?.(); return; }
      const annotation = target?.closest?.('[data-htmlmemo-id]');
      if (annotation && this.tool === 'select') { event.preventDefault(); event.stopPropagation(); this.selectedId = annotation.dataset.htmlmemoId; this.callbacks.onSelect?.(this.selectedId); return; }
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
      if (hash && hash.length > 1) jumpToHash(hash);
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
      if (link && href.startsWith('#') && !pagePrevented) {
        if (href === '#') {
          if (!summary) event.preventDefault();
        } else {
          let id; try { id = decodeURIComponent(href.slice(1)); } catch { id = href.slice(1); }
          const hashTarget = id ? (this.doc.getElementById(id) || [...this.doc.querySelectorAll('a[name]')].find(a => a.name === id)) : null;
          if (hashTarget && hashTarget !== container) {
            event.preventDefault();
            if (this.tool === 'select' || this.isInsideTocOrTopbar(link)) jumpToHash(href);
          } else if (hashTarget === container) {
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
        if(this.autoFit)this.zoom=this.fitZoom();
        if(this.nativeScroll || this.autoFit)this.applyZoom();
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
    // Keep every source TOC node and listener in place. Only editor-owned UI is added.
    const title=[...sidebar.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')].find(node=>node.textContent.trim()==='목차');
    title?.setAttribute('data-htmlmemo-redundant-toc-title','');
    sidebar.setAttribute('data-htmlmemo-native-sidebar','');sidebar.prepend(panel);this.documentSidebarUI=panel;
    panel.addEventListener('click',event=>event.stopPropagation());
    this.showDocumentSidebarView(this.documentSidebarMode||'outline');
  }
  showDocumentSidebarView(mode) {
    if(!['outline','search','annotations'].includes(mode)||!this.documentSidebarUI?.isConnected)return;
    const sidebar=this.tocResize.sidebar,previous=this.documentSidebarMode||'outline';
    if(mode!=='outline'&&this.tocStrip){
      this.applyTocWidth(Math.max(TOC_STRIP_SNAP,this.tocExpandedWidth||this.tocDefaultWidth||TOC_DEFAULT),{persist:true,snapStrip:true});
      this.syncAfterTocResize();
    }
    if(previous==='outline'&&mode!=='outline')this.documentTocScrollTop=sidebar.scrollTop;
    this.documentSidebarMode=mode;sidebar.setAttribute('data-htmlmemo-sidebar-view',mode);
    this.callbacks.onSidebarView(mode,this.documentSidebarUI,this);
    if(mode==='outline'&&Number.isFinite(this.documentTocScrollTop))sidebar.scrollTop=this.documentTocScrollTop;
    else if(mode!==previous)sidebar.scrollTop=0;
  }
  refreshDocumentSidebar() {
    if(this.documentSidebarMode==='annotations')this.showDocumentSidebarView('annotations');
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
  isInsideTocOrTopbar(node) {
    const el = node?.nodeType === 1 ? node : node?.parentElement;
    if (!el) return false;
    const sidebar = this.tocResize?.sidebar;
    const sidebarItem = this.tocResize?.sidebarItem;
    if (sidebar && (el === sidebar || sidebar.contains?.(el) || (sidebarItem && (el === sidebarItem || sidebarItem.contains?.(el))))) return true;
    if (this.topbarNode && (el === this.topbarNode || this.topbarNode.contains?.(el))) return true;
    return !!el.closest?.('[data-htmlmemo-toc-sidebar],[data-htmlmemo-toc-item],[data-htmlmemo-doc-topbar],[data-htmlmemo-doc-topbar-item],aside,nav,[role="navigation"],.toc,#toc,.sidebar,#sidebar');
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
    for(let node=event.target;node?.nodeType===1;node=node.parentElement){
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
        node.scrollBy?.({left,top});
        if (!node.scrollBy) { node.scrollLeft+=left;node.scrollTop+=top; }
        event.preventDefault();return;
      }
    }
    if(this.nativeScroll) {
      const root=this.findAnnotationScrollHost()||this.doc.scrollingElement||this.doc.documentElement||this.doc.body;
      root.scrollBy?.({left,top});
      if (!root.scrollBy) { root.scrollLeft+=left;root.scrollTop+=top; }
    } else this.viewport.scrollBy({left,top});
    event.preventDefault();
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
    if (this.disposed || this.host?.hidden || this.dynamicRunning) return;
    if (this.tocDrag) { this.scheduleDynamicRefresh(); return; }
    this.dynamicRunning = true;this.dynamicDirty = false;
    try {
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
  focusDocument(event) {
    if (this.disposed || event.button != null && event.button !== 0) return;
    if (event.target.closest?.('a,button,input,textarea,select,[contenteditable],[data-htmlmemo-id],[role="separator"],[data-htmlmemo-toc-resizer],[data-htmlmemo-toc-resizer-bound],[data-htmlmemo-toc-strip]')) return;
    event.preventDefault();
    this.callbacks.onDocumentFocus?.();
  }
  measure() {
    if (!this.doc) return;
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
  fitZoom() { const focused=!!this.host.closest('.reader-focus'); return clamp(this.viewport.clientWidth / this.naturalWidth, .2, focused ? 8 : 2); }
  applyZoom() {
    const set=(style,key,value)=>{if(style[key]!==value)style[key]=value;};
    if(this.nativeScroll)set(this.frame.style,'height',Math.max(200,this.viewport.clientHeight/this.zoom)+'px');
    set(this.frame.style,'transform',`scale(${this.zoom})`);
    set(this.sizer.style,'width',this.naturalWidth*this.zoom+'px');
    set(this.sizer.style,'height',(this.nativeScroll?Math.max(200*this.zoom,this.viewport.clientHeight):(this.naturalHeight||800)*this.zoom)+'px');
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
    const centerX = (this.scrollLeft + this.viewport.clientWidth / 2) / this.zoom;
    const centerY = (this.scrollTop + this.viewport.clientHeight / 2) / this.zoom;
    this.autoFit = fit; this.zoom = clamp(fit ? this.fitZoom() : value, .2, 8); this.applyZoom();
    this.scrollLeft = centerX * this.zoom - this.viewport.clientWidth / 2; this.scrollTop = centerY * this.zoom - this.viewport.clientHeight / 2;
    this.rememberPosition(); this.callbacks.onView?.();
  }
  rememberPosition() {
    const view = {scrollTop:this.scrollTop, scrollLeft:this.scrollLeft, zoom:this.zoom, autoFit:this.autoFit, ...(Number.isFinite(this.tocResizedWidth)?{tocWidth:this.tocResizedWidth}:{})};
    const previous = this.metadata.view || {};
    if (Object.keys(previous).length === Object.keys(view).length && Object.keys(view).every(key => view[key] === previous[key])) return false;
    this.metadata.view = view;
    this.callbacks.onPosition?.();
    return true;
  }
  setTool(tool) {
    this.tool = tool; this.doc.documentElement.toggleAttribute('data-htmlmemo-drawing', DRAW_TOOLS.includes(tool) || ['note','text'].includes(tool));
    if (TEXT_TOOLS.includes(tool) && this.selection) this.addText(tool, this.selection);
    this.callbacks.onView?.();
  }
  annotation(type, properties) { return {id:uid(), type, color:this.color, width:this.width, opacity:type === 'highlight' || type === 'area' ? this.opacity : 1, created:Date.now(), ...properties}; }
  addText(type, anchor, text) {
    if (!anchor?.quote.trim()) return;
    if (type === 'note') {
      const resolved = resolveTextAnchor(textIndex(this.doc), anchor); if (!resolved || !text?.trim()) return;
      const range = rangeFromOffsets(this.doc, resolved.start, resolved.end); if (!range) return;
      const rect = range.getBoundingClientRect(), element = range.startContainer.parentElement;
      const position = this.elementAnchor(element, true), origin = this.layerOrigin();
      // The quote and paragraph let 「새 판으로 주석 옮기기」 find this note in a later edition.
      this.commit([...this.metadata.annotations, this.annotation(type, {anchor:position.key, anchorTarget:position.target, textAnchor:this.sectionAnchor(anchor), points:[{x:(rect.left - origin.left - position.x)/position.width,y:(rect.top - origin.top - position.y)/position.height}], text:text.trim()})]);
    } else this.commit([...this.metadata.annotations, this.annotation(type, {textAnchor:this.sectionAnchor(anchor)})]);
    this.doc.getSelection()?.removeAllRanges(); this.selection = null;
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
  resolveDrawingTarget(annotation) {
    const direct = this.doc.querySelector(`[data-htmlmemo-anchor="${annotation.anchor}"]`);
    const target = annotation.anchorTarget;
    if (!target) return direct;
    if (target.section && this.doc.getElementById('reader-content')?.dataset.section !== target.section) return null;
    const root = target.rootId ? this.doc.getElementById(target.rootId) : this.doc.body;
    if (!root) return null;
    const matches = node => node?.isConnected && node.localName === target.tag &&
      (!target.id || node.id === target.id) && (!target.quote || this.drawingTargetQuote(node) === target.quote);
    this.resolvedDrawingTargets ||= new WeakMap();
    const cached = this.resolvedDrawingTargets.get(annotation);
    if (cached && root.contains(cached) && matches(cached)) return cached;
    let node = target.id ? this.doc.getElementById(target.id) : root;
    if (!target.id) for (const index of target.path) node = node?.children[index];
    if (!matches(node) || !root.contains(node)) node = root.contains(direct) && matches(direct) ? direct : null;
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
    return {key:element.dataset?.htmlmemoAnchor || 'body', ...box, ...(describe ? {target:this.describeDrawingTarget(element)} : {})};
  }
  pointerDown(event) {
    if (event.button !== 0) return;
    if (this.tool === 'eraser') {
      const target = event.target.closest?.('[data-htmlmemo-id]'); if (target) { event.preventDefault(); this.remove(target.dataset.htmlmemoId); } return;
    }
    if (this.isInteractiveControl(event.target)) return;
    if (DRAW_TOOLS.includes(this.tool) || ['note','text'].includes(this.tool)) {
      // Touch scroll remains available in selection mode; a second pointer
      // cancels a stroke instead of accidentally recording a two-finger gesture.
      if (this.gesture) { this.gesture = null; this.preview?.remove(); return; }
      event.preventDefault(); event.stopPropagation();
      const scrollHost = this.findAnnotationScrollHost();
      if (!this.layer?.isConnected || (scrollHost && this.layer.parentElement !== scrollHost)) this.renderDrawingLayer();
      const anchor = this.elementAnchor(event.target,true); const p = this.point(event);
      this.gesture = {pointerId:event.pointerId, type:this.tool, anchor, points:[p]};
      event.target.setPointerCapture?.(event.pointerId);
    }
  }
  pointerMove(event) {
    if (!this.gesture || this.gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    const p = this.point(event); const g = this.gesture;
    if (g.type === 'pen') { if (Math.hypot(p.x - g.points.at(-1).x, p.y - g.points.at(-1).y) >= 1) g.points.push(p); }
    else g.points[1] = p;
    this.preview?.remove(); this.preview = this.drawAnnotation(this.annotation(g.type, {points:g.points}), true);
    if (this.preview) { this.preview.setAttribute('data-htmlmemo-preview', ''); this.layer.append(this.preview); }
  }
  async pointerUp(event) {
    if (this.gesture && this.gesture.pointerId === event.pointerId) {
      event.preventDefault(); const g = this.gesture; this.gesture = null; this.preview?.remove(); this.preview = null;
      const points = g.points.map(p => ({x:(p.x - g.anchor.x) / g.anchor.width, y:(p.y - g.anchor.y) / g.anchor.height}));
      if (['note','text'].includes(g.type)) {
        const text = await this.callbacks.requestText?.(g.type);
        if (text?.trim()) this.commit([...this.metadata.annotations, this.annotation(g.type, {anchor:g.anchor.key, anchorTarget:g.anchor.target, points:[points[0]], text:text.trim()})]);
      } else if (g.points.length > 1) {
        const next = this.annotation(g.type, {anchor:g.anchor.key, anchorTarget:g.anchor.target, points});
        if (g.type === 'pen' && this.penTTL > 0) {
          const temporary = this.drawAnnotation(next);
          if (temporary) { temporary.dataset.htmlmemoPreview = ''; this.layer.append(temporary);setTimeout(() => temporary.remove(), this.penTTL * 1000); }
        } else this.commit([...this.metadata.annotations, next]);
      }
      return;
    }
    if (this.tool === 'select') setTimeout(() => {
      if (this.disposed || this.tool !== 'select') return;
      const selection = this.doc.getSelection();
      if (!selection?.rangeCount || selection.isCollapsed) return;
      this.selection = selectionAnchor(this.doc, selection.getRangeAt(0));
      if (this.selection) this.callbacks.onTextSelection?.(this.selection);
    }, 0);
    if (TEXT_TOOLS.includes(this.tool)) setTimeout(() => {
      const selection = this.doc.getSelection();
      if (selection?.rangeCount && !selection.isCollapsed) this.addText(this.tool, selectionAnchor(this.doc, selection.getRangeAt(0)));
    }, 0);
  }
  render() {
    this.dynamicObserver?.disconnect();
    cleanAnnotations(this.doc); this.selectedId = null;
    const style = this.doc.createElement('style'); style.id = 'htmlmemo-annotation-style';
    style.textContent = '[data-htmlmemo-mark]{border-radius:2px;box-decoration-break:clone;-webkit-box-decoration-break:clone}'; this.doc.head.append(style);
    const textAnnotations=this.metadata.annotations.filter(a=>TEXT_TOOLS.includes(a.type));
    const index=textAnnotations.length?textIndex(this.doc):null;
    const section = currentSection(this.doc);
    for (const annotation of textAnnotations) {
      if (annotation.textAnchor.section && annotation.textAnchor.section !== section) continue;
      const resolved = resolveTextAnchor(index, annotation.textAnchor); if (!resolved) continue;
      const style = annotation.type === 'highlight' ? `background:${annotation.color}${Math.round(annotation.opacity * 255).toString(16).padStart(2,'0')};color:inherit` : `text-decoration-line:${annotation.type === 'underline' ? 'underline' : 'line-through'};text-decoration-color:${annotation.color};text-decoration-thickness:${annotation.width}px;text-underline-offset:3px`;
      wrapOffsets(this.doc, resolved.start, resolved.end, {'data-htmlmemo-mark':'','data-htmlmemo-id':annotation.id}, style,index);
    }
    this.renderDrawingLayer();
    if (this.searchQuery) this.search(this.searchQuery, false);
    this.observeDynamicDocument();
  }
  absolutePoints(annotation) {
    if (!annotation.anchor) return annotation.points;
    const origin = this.layerOrigin();
    const scrollHost = origin.scrollHost;
    const element = this.resolveDrawingTarget(annotation);
    // A delayed/absent paragraph is not the whole page. Keep its saved data,
    // and draw only once that actual target exists and has a rendered box.
    if (!element || element.getClientRects?.().length === 0) return [];
    if (scrollHost && !scrollHost.contains(element) && element !== this.doc.body && element !== this.doc.documentElement && !element.contains(scrollHost)) return [];
    const box = this.anchorBox(element, origin);
    return annotation.points.map(p => ({x:box.x + p.x * box.width, y:box.y + p.y * box.height}));
  }
  drawAnnotation(annotation, preview = false) {
    const p = preview ? annotation.points : this.absolutePoints(annotation); if (!p?.length) return null;
    const attrs = {stroke:annotation.color, 'stroke-width':annotation.width, fill:'none', opacity:annotation.opacity, 'stroke-linecap':'round', 'stroke-linejoin':'round', 'data-htmlmemo-id':annotation.id, style:'pointer-events:visiblePainted;cursor:pointer'};
    const first = p[0]; const last = p.at(-1);
    if (annotation.type === 'pen') return svg(this.doc, 'path', {...attrs, d:p.map((point,i) => `${i ? 'L':'M'}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ')});
    if (['rect','area'].includes(annotation.type)) return svg(this.doc, 'rect', {...attrs, x:Math.min(first.x,last.x), y:Math.min(first.y,last.y), width:Math.abs(first.x-last.x), height:Math.abs(first.y-last.y), ...(annotation.type === 'area' ? {fill:annotation.color, stroke:'none'} : {})});
    if (annotation.type === 'area-underline') return svg(this.doc, 'path', {...attrs, d:`M${first.x},${first.y}L${last.x},${last.y}`});
    if (annotation.type === 'ellipse') return svg(this.doc, 'ellipse', {...attrs, cx:(first.x+last.x)/2, cy:(first.y+last.y)/2, rx:Math.abs(first.x-last.x)/2, ry:Math.abs(first.y-last.y)/2});
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
    // Keep one overlay: source Mutation/ResizeObservers must not see a removed
    // and reinserted SVG every time their own layout changes.
    const scrollHost=this.ensureAnnotationLayerHost();
    const hostParent=scrollHost||this.doc.body;
    let layer=this.doc.getElementById(LAYER_ID);
    const drawings=this.metadata.annotations.filter(a=>!TEXT_TOOLS.includes(a.type));
    const contentKey=JSON.stringify(drawings);
    const layoutKey=JSON.stringify(drawings.map(a=>a.anchor?this.absolutePoints(a):null));
    if(!layer){
      layer=svg(this.doc,'svg',{id:LAYER_ID,'aria-label':'HTMLMemo 주석',style:'position:absolute;top:0;left:0;z-index:2147483000;pointer-events:none;overflow:visible;'});
      layer.dataset.htmlmemoUi='';hostParent.append(layer);
      this.drawingContentKey=null;this.drawingLayoutKey=null;
    } else if (layer.parentElement!==hostParent) {
      hostParent.append(layer);
      this.drawingContentKey=null;this.drawingLayoutKey=null;
    }
    this.layer=layer;
    const width=scrollHost ? Math.max(1, scrollHost.clientWidth || this.doc.documentElement?.clientWidth || this.naturalWidth) : (this.nativeScroll ? this.doc.documentElement?.clientWidth || this.naturalWidth : this.naturalWidth);
    const height=(this.nativeScroll || scrollHost) ? 1 : this.naturalHeight || 800;
    if(layer.getAttribute('width')!==String(width))layer.setAttribute('width',String(width));
    if(layer.getAttribute('height')!==String(height))layer.setAttribute('height',String(height));
    if(contentKey!==this.drawingContentKey || layoutKey!==this.drawingLayoutKey){
      layer.replaceChildren(...drawings.map(a=>this.drawAnnotation(a)).filter(Boolean));
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
  }
  html() { return serializeHTML(this.doc, this.metadata); }
  async back() { const p = this.linkHistory.pop(); if (!p) return false; this.scrollTop=p.top; this.scrollLeft=p.left; this.callbacks.onView?.(); return true; }
  jump(target) {
    const r = target.getBoundingClientRect(), origin = this.layerOrigin(); this.scrollTop = Math.max(0,(r.top-origin.top+r.height/2)*this.zoom-this.viewport.clientHeight/2); this.scrollLeft = Math.max(0,(r.left-origin.left+r.width/2)*this.zoom-this.viewport.clientWidth/2);
  }
  jumpAnnotation(id) {
    const annotation = this.metadata.annotations.find(a=>a.id===id); if (!annotation) return;
    const element = this.doc.querySelector(`[data-htmlmemo-id="${id}"]`); if (element) this.jump(element);
    this.selectedId=id; this.callbacks.onView?.();
  }
  // The annotation list shows more than the tool name: the text an annotation marks or was drawn on,
  // and the heading it sits under. Headings are in document order, so the last one at or before the
  // annotation is found by binary search. A drawing on empty space falls back to its drawn position.
  annotationContexts() {
    const headings = this.outline().map(item=>item.node), result = new Map();
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
    for (const annotation of this.metadata.annotations) {
      const marked = TEXT_TOOLS.includes(annotation.type);
      const node = marked ? this.doc.querySelector(`[data-htmlmemo-mark][data-htmlmemo-id="${annotation.id}"]`)
        : this.resolveDrawingTarget(annotation);
      let index = node?.isConnected && node !== this.doc.body ? headingBefore(node) : -1;
      if (index < 0 && !marked) { const drawn = this.doc.querySelector(`[data-htmlmemo-id="${annotation.id}"]`); if (drawn) index = headingAbove(drawn); }
      result.set(annotation.id, {quote:annotation.textAnchor?.quote || annotation.anchorTarget?.quote || (node?.isConnected ? this.drawingTargetQuote(node) : ''),
        heading:index >= 0 ? headings[index].textContent.replace(/\s+/g, ' ').trim() : ''});
    }
    return result;
  }
  search(query, move = true) {
    this.searchQuery = query;
    for (const mark of [...this.doc.querySelectorAll('[data-htmlmemo-search]')].reverse()) mark.replaceWith(...mark.childNodes);
    this.doc.body.normalize(); this.searchResults = []; this.searchPosition = -1;
    if (!query.trim()) return [];
    const index = textIndex(this.doc); const haystack=index.text.toLocaleLowerCase(); const needle=query.toLocaleLowerCase(); let found=haystack.indexOf(needle);
    while (found !== -1 && this.searchResults.length < 3000) { this.searchResults.push({start:found,end:found+query.length,quote:index.text.slice(Math.max(0,found-35),found+query.length+45)}); found=haystack.indexOf(needle,found+Math.max(needle.length,1)); }
    // Only the active hit is marked, keeping long documents responsive.
    if (move && this.searchResults.length) this.nextSearch(1); return this.searchResults;
  }
  nextSearch(direction) {
    if (!this.searchResults.length) return;
    this.searchPosition = (this.searchPosition + direction + this.searchResults.length) % this.searchResults.length;
    for (const mark of [...this.doc.querySelectorAll('[data-htmlmemo-search]')].reverse()) mark.replaceWith(...mark.childNodes);
    this.doc.body.normalize(); const result=this.searchResults[this.searchPosition];
    const range=rangeFromOffsets(this.doc,result.start,result.end); if (!range) return;
    const rect=range.getBoundingClientRect(), origin=this.layerOrigin(); this.scrollTop=Math.max(0,(rect.top-origin.top+rect.height/2)*this.zoom-this.viewport.clientHeight/2);
    this.scrollLeft=Math.max(0,(rect.left-origin.left+rect.width/2)*this.zoom-this.viewport.clientWidth/2);
    wrapOffsets(this.doc,result.start,result.end,{'data-htmlmemo-search':''},'background:#f0a85b80;outline:2px solid #df9057;border-radius:2px;color:inherit');
  }
  outline() { return [...this.doc.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(n=>n.textContent.trim()&&!n.closest('[data-htmlmemo-ui]')).map(node=>({node,level:Number(node.localName[1]),title:node.textContent.trim()})); }
  addBookmark(title) { this.metadata.bookmarks.push({id:uid(),title,top:this.scrollTop/this.zoom,left:this.scrollLeft/this.zoom}); this.callbacks.onChange?.(); }
  speakSelection() {
    const anchor = this.selection || (() => {
      const selection = this.doc.getSelection();
      return selection?.rangeCount && !selection.isCollapsed ? selectionAnchor(this.doc, selection.getRangeAt(0)) : null;
    })();
    if (!anchor) return false;
    // HTMLMemoEx tab.js/content.js selectionAction('speak'), with the host window
    // supplying the browser API because the document lives inside our reader iframe.
    const window = this.host.ownerDocument.defaultView, document = this.doc;
    const { speechSynthesis, SpeechSynthesisUtterance } = window;
    if (!window.speechSynthesis) { this.callbacks.onError?.(new Error('기기의 음성 읽기를 지원하지 않습니다.')); return false; }
    this.readAloud?.close();
    speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(anchor.quote); u.lang = /[가-힣]/.test(anchor.quote) ? 'ko-KR' : (document.documentElement.lang || 'en-US'); speechSynthesis.speak(u);
    return true;
  }
  toggleReadAloud() {
    if (!this.host.ownerDocument.defaultView.speechSynthesis) { this.callbacks.onError?.(new Error('기기의 음성 읽기를 지원하지 않습니다.'));return; }
    this.readAloud ||= createReadAloud(this);
    this.readAloud?.toggle();
  }
  stopSpeech() { this.readAloud?.close(); this.host?.ownerDocument?.defaultView?.speechSynthesis?.cancel(); }
  dispose() { this.stopMiddleScroll();this.readAloud?.dispose();this.readAloud=null;this.stopSpeech(); this.disposed=true;this.cancelOpeningWait?.(); clearTimeout(this.positionTimer);clearTimeout(this.dynamicTimer);clearTimeout(this.documentSidebarUI?.sidebarSearchTimer);this.dynamicObserver?.disconnect(); this.resizeObserver?.disconnect(); this.hostObserver?.disconnect(); this.frame.srcdoc=''; if(this.documentURL){URL.revokeObjectURL(this.documentURL);this.documentURL=null;} this.host.remove(); }
}
