import { clamp, uid } from './utils.js';
import { History, TEXT_TOOLS, DRAW_TOOLS } from './model.js';
import { LAYER_ID, cleanAnnotations, textIndex, selectionAnchor, resolveTextAnchor, wrapOffsets, rangeFromOffsets, serializeHTML } from './document.js';

const NS = 'http://www.w3.org/2000/svg';
const svg = (doc, tag, attrs = {}) => { const node = doc.createElementNS(NS, tag); for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value)); return node; };
export class Reader {
  constructor(host, parsed, callbacks) {
    this.host = host; this.metadata = parsed.metadata; this.callbacks = callbacks; this.history = new History(this.metadata.annotations);
    this.tool = 'select'; this.color = '#edcf67'; this.width = 3; this.opacity = .35; this.penTTL = 0; this.zoom = 1;
    this.selection = null; this.selectedId = null; this.linkHistory = []; this.searchResults = []; this.searchPosition = -1; this.autoFit = !this.metadata.view.zoom;
    this.viewport = document.createElement('div'); this.viewport.className = 'reader-viewport';
    this.sizer = document.createElement('div'); this.sizer.className = 'reader-sizer';
    this.frame = document.createElement('iframe'); this.frame.className = 'document-frame'; this.frame.title = this.metadata.title;
    // The parent can manipulate the DOM. Source scripts, forms and top-level
    // navigation remain disabled by the sandbox, even for imported hostile HTML.
    this.frame.setAttribute('sandbox', 'allow-same-origin'); this.frame.referrerPolicy = 'no-referrer';
    this.naturalWidth = this.metadata.viewport.width; this.frame.style.width = this.naturalWidth + 'px';
    this.sizer.append(this.frame); this.viewport.append(this.sizer); host.append(this.viewport);
    this.ready = new Promise((resolve, reject) => {
      this.frame.addEventListener('load', () => {
        try {
          this.doc = this.frame.contentDocument;
          if (!this.doc?.body) throw new Error('HTML 문서를 표시하지 못했습니다.');
          this.bind(); this.measure(); this.render();
          this.zoom = clamp(this.metadata.view.zoom || this.fitZoom(), .2, 8); this.applyZoom();
          requestAnimationFrame(() => { this.viewport.scrollTop = Number(this.metadata.view.scrollTop) || 0; this.viewport.scrollLeft = Number(this.metadata.view.scrollLeft) || 0; this.callbacks.onView?.(); resolve(this); });
        } catch (error) { reject(error); }
      }, {once:true});
    });
    this.frame.srcdoc = parsed.html;
  }
  bind() {
    const editorStyle = this.doc.createElement('style'); editorStyle.id = 'htmlmemo-editor-style';
    editorStyle.textContent = 'html{overflow:hidden!important;height:auto!important;min-height:0!important}body{touch-action:pan-x pan-y;height:auto!important;min-height:0!important}html[data-htmlmemo-drawing] *{cursor:crosshair!important;user-select:none!important;touch-action:none!important}'; this.doc.head.append(editorStyle);
    this.doc.addEventListener('pointerdown', event => this.pointerDown(event), true);
    this.doc.addEventListener('pointermove', event => this.pointerMove(event), true);
    this.doc.addEventListener('pointerup', event => this.pointerUp(event), true);
    this.doc.addEventListener('pointercancel', () => { this.gesture = null; this.preview?.remove(); this.preview = null; });
    this.doc.addEventListener('selectionchange', () => { const s = this.doc.getSelection(); if (s?.rangeCount && !s.isCollapsed) this.selection = selectionAnchor(this.doc, s.getRangeAt(0)); });
    this.doc.addEventListener('keydown', event => this.callbacks.onKey?.(event));
    this.doc.addEventListener('click', event => {
      const annotation = event.target.closest?.('[data-htmlmemo-id]');
      if (annotation && this.tool === 'select') { event.preventDefault(); event.stopPropagation(); this.selectedId = annotation.dataset.htmlmemoId; this.callbacks.onSelect?.(this.selectedId); return; }
      const link = event.target.closest?.('a[href]');
      if (!link) return;
      event.preventDefault();
      if (this.tool !== 'select') return;
      const href = link.getAttribute('href');
      let hash = href.startsWith('#') ? href : '';
      if (!hash && this.metadata.source) { try { const current = new URL(this.metadata.source); const dest = new URL(href); if (current.origin === dest.origin && current.pathname === dest.pathname && current.search === dest.search) hash = dest.hash; } catch { /* non-web links aren't opened by the app */ } }
      if (hash) {
        let id; try { id = decodeURIComponent(hash.slice(1)); } catch { id = hash.slice(1); }
        const target = this.doc.getElementById(id) || [...this.doc.querySelectorAll('a[name]')].find(a => a.name === id);
        if (target) { this.linkHistory.push({top:this.viewport.scrollTop, left:this.viewport.scrollLeft}); if (this.linkHistory.length > 128) this.linkHistory.shift(); this.jump(target); }
      } else if (/^https?:/.test(href)) this.callbacks.onLink?.(href);
    }, true);
    this.viewport.addEventListener('scroll', () => {
      clearTimeout(this.positionTimer);
      this.positionTimer = setTimeout(() => {
        if (this.disposed) return;
        this.metadata.view = {scrollTop:this.viewport.scrollTop, scrollLeft:this.viewport.scrollLeft, zoom:this.zoom};
        this.callbacks.onPosition?.(); this.callbacks.onView?.();
      }, 250);
    });
    this.resizeObserver = new ResizeObserver(() => { if (!this.disposed) { this.measure(); this.renderDrawingLayer(); } });
    this.resizeObserver.observe(this.doc.body);
    this.hostObserver = new ResizeObserver(() => { if (!this.disposed && this.autoFit) { this.zoom = this.fitZoom(); this.applyZoom(); } }); this.hostObserver.observe(this.viewport);
    this.doc.fonts.ready.then(() => { if (!this.disposed) { this.measure(); this.renderDrawingLayer(); } });
  }
  measure() {
    if (!this.doc) return;
    const body = this.doc.body;
    // The iframe's own viewport height must not feed back into scrollHeight.
    // Body geometry and descendant bottoms capture both normal and positioned content.
    let height = Math.max(body.offsetHeight + body.offsetTop, body.getBoundingClientRect().bottom, 200);
    for (const child of body.children) if (child.id !== LAYER_ID) height = Math.max(height, child.getBoundingClientRect().bottom + this.doc.defaultView.scrollY);
    this.naturalHeight = Math.ceil(height + 24);
    this.frame.style.height = this.naturalHeight + 'px'; this.applyZoom();
  }
  fitZoom() { return clamp((this.viewport.clientWidth - (innerWidth < 600 ? 16 : 56)) / this.naturalWidth, .2, 2); }
  applyZoom() {
    this.frame.style.transform = `scale(${this.zoom})`;
    this.sizer.style.width = this.naturalWidth * this.zoom + 'px'; this.sizer.style.height = (this.naturalHeight || 800) * this.zoom + 'px';
  }
  setZoom(value, fit = false) {
    const centerX = (this.viewport.scrollLeft + this.viewport.clientWidth / 2) / this.zoom;
    const centerY = (this.viewport.scrollTop + this.viewport.clientHeight / 2) / this.zoom;
    this.autoFit = fit; this.zoom = clamp(fit ? this.fitZoom() : value, .2, 8); this.applyZoom();
    this.viewport.scrollLeft = centerX * this.zoom - this.viewport.clientWidth / 2; this.viewport.scrollTop = centerY * this.zoom - this.viewport.clientHeight / 2;
    this.rememberPosition(); this.callbacks.onView?.();
  }
  rememberPosition() {
    this.metadata.view = {scrollTop:this.viewport.scrollTop, scrollLeft:this.viewport.scrollLeft, zoom:this.zoom};
    this.callbacks.onPosition?.();
  }
  setTool(tool) {
    this.tool = tool; this.doc.documentElement.toggleAttribute('data-htmlmemo-drawing', DRAW_TOOLS.includes(tool) || ['note','text'].includes(tool));
    if (TEXT_TOOLS.includes(tool) && this.selection) this.addText(tool, this.selection);
    this.callbacks.onView?.();
  }
  annotation(type, properties) { return {id:uid(), type, color:this.color, width:this.width, opacity:type === 'highlight' || type === 'area' ? this.opacity : 1, created:Date.now(), ...properties}; }
  addText(type, anchor) {
    if (!anchor?.quote.trim()) return;
    this.commit([...this.metadata.annotations, this.annotation(type, {textAnchor:anchor})]);
    this.doc.getSelection()?.removeAllRanges(); this.selection = null;
  }
  commit(annotations) {
    this.metadata.annotations = this.history.commit(annotations); this.render(); this.callbacks.onChange?.(); this.callbacks.onView?.();
  }
  undo() { if (this.history.canUndo) { this.metadata.annotations = this.history.undo(); this.render(); this.callbacks.onChange?.(); this.callbacks.onView?.(); } }
  redo() { if (this.history.canRedo) { this.metadata.annotations = this.history.redo(); this.render(); this.callbacks.onChange?.(); this.callbacks.onView?.(); } }
  remove(id) { this.commit(this.metadata.annotations.filter(a => a.id !== id)); if (this.selectedId === id) this.selectedId = null; }
  point(event) { return {x:event.clientX + this.doc.defaultView.scrollX, y:event.clientY + this.doc.defaultView.scrollY}; }
  elementAnchor(target) {
    let element = target.closest?.('[data-htmlmemo-anchor]') || this.doc.body;
    if (element.namespaceURI === NS || element.closest('#' + LAYER_ID)) element = this.doc.body;
    while (element !== this.doc.body && ['span','a','b','strong','em','i','small','mark'].includes(element.localName)) element = element.parentElement;
    const rect = element.getBoundingClientRect();
    return {key:element.dataset.htmlmemoAnchor || 'body', x:rect.left, y:rect.top, width:Math.max(1, rect.width), height:Math.max(1, rect.height)};
  }
  pointerDown(event) {
    if (event.button !== 0) return;
    if (this.tool === 'eraser') {
      const target = event.target.closest?.('[data-htmlmemo-id]'); if (target) { event.preventDefault(); this.remove(target.dataset.htmlmemoId); } return;
    }
    if (DRAW_TOOLS.includes(this.tool) || ['note','text'].includes(this.tool)) {
      // Touch scroll remains available in selection mode; a second pointer
      // cancels a stroke instead of accidentally recording a two-finger gesture.
      if (this.gesture) { this.gesture = null; this.preview?.remove(); return; }
      event.preventDefault(); event.stopPropagation();
      const anchor = this.elementAnchor(event.target); const p = this.point(event);
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
        if (text?.trim()) this.commit([...this.metadata.annotations, this.annotation(g.type, {anchor:g.anchor.key, points:[points[0]], text:text.trim()})]);
      } else if (g.points.length > 1) {
        const next = this.annotation(g.type, {anchor:g.anchor.key, points});
        if (g.type === 'pen' && this.penTTL > 0) {
          const temporary = this.drawAnnotation(next); temporary.dataset.htmlmemoPreview = ''; this.layer.append(temporary);
          setTimeout(() => temporary.remove(), this.penTTL * 1000);
        } else this.commit([...this.metadata.annotations, next]);
      }
      return;
    }
    if (TEXT_TOOLS.includes(this.tool)) setTimeout(() => {
      const selection = this.doc.getSelection();
      if (selection?.rangeCount && !selection.isCollapsed) this.addText(this.tool, selectionAnchor(this.doc, selection.getRangeAt(0)));
    }, 0);
  }
  render() {
    cleanAnnotations(this.doc); this.selectedId = null;
    const style = this.doc.createElement('style'); style.id = 'htmlmemo-annotation-style';
    style.textContent = '[data-htmlmemo-mark]{border-radius:2px;box-decoration-break:clone;-webkit-box-decoration-break:clone}'; this.doc.head.append(style);
    for (const annotation of this.metadata.annotations.filter(a => TEXT_TOOLS.includes(a.type))) {
      const resolved = resolveTextAnchor(textIndex(this.doc), annotation.textAnchor); if (!resolved) continue;
      const style = annotation.type === 'highlight' ? `background:${annotation.color}${Math.round(annotation.opacity * 255).toString(16).padStart(2,'0')};color:inherit` : `text-decoration-line:${annotation.type === 'underline' ? 'underline' : 'line-through'};text-decoration-color:${annotation.color};text-decoration-thickness:${annotation.width}px;text-underline-offset:3px`;
      wrapOffsets(this.doc, resolved.start, resolved.end, {'data-htmlmemo-mark':'','data-htmlmemo-id':annotation.id}, style);
    }
    this.renderDrawingLayer();
    if (this.searchQuery) this.search(this.searchQuery, false);
  }
  absolutePoints(annotation) {
    if (!annotation.anchor) return annotation.points;
    const element = this.doc.querySelector(`[data-htmlmemo-anchor="${annotation.anchor}"]`) || this.doc.body;
    const r = element.getBoundingClientRect();
    return annotation.points.map(p => ({x:r.left + p.x * Math.max(1,r.width), y:r.top + p.y * Math.max(1,r.height)}));
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
    if (!this.doc || this.disposed) return;
    this.doc.getElementById(LAYER_ID)?.remove();
    this.layer = svg(this.doc, 'svg', {id:LAYER_ID,width:this.naturalWidth,height:this.naturalHeight || 800,'aria-label':'HTMLMemo 주석',style:'position:absolute;top:0;left:0;z-index:2147483000;pointer-events:none;overflow:visible;'});
    this.layer.dataset.htmlmemoUi = '';
    for (const annotation of this.metadata.annotations.filter(a => !TEXT_TOOLS.includes(a.type))) { const node = this.drawAnnotation(annotation); if (node) this.layer.append(node); }
    this.doc.body.append(this.layer);
    // Source pages can position their body. Keep overlay coordinates relative
    // to the document viewport rather than applying the body offset twice.
    const offset=this.layer.getBoundingClientRect();this.layer.style.left=-offset.left+'px';this.layer.style.top=-offset.top+'px';
  }
  html() { return serializeHTML(this.doc, this.metadata); }
  async back() { const p = this.linkHistory.pop(); if (!p) return false; this.viewport.scrollTop=p.top; this.viewport.scrollLeft=p.left; this.callbacks.onView?.(); return true; }
  jump(target) {
    const r = target.getBoundingClientRect(); this.viewport.scrollTop = Math.max(0,(r.top+r.height/2)*this.zoom-this.viewport.clientHeight/2); this.viewport.scrollLeft = Math.max(0,(r.left+r.width/2)*this.zoom-this.viewport.clientWidth/2);
  }
  jumpAnnotation(id) {
    const annotation = this.metadata.annotations.find(a=>a.id===id); if (!annotation) return;
    const element = this.doc.querySelector(`[data-htmlmemo-id="${id}"]`); if (element) this.jump(element);
    this.selectedId=id; this.callbacks.onView?.();
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
    const rect=range.getBoundingClientRect(); this.viewport.scrollTop=Math.max(0,(rect.top+rect.height/2)*this.zoom-this.viewport.clientHeight/2);
    this.viewport.scrollLeft=Math.max(0,(rect.left+rect.width/2)*this.zoom-this.viewport.clientWidth/2);
    wrapOffsets(this.doc,result.start,result.end,{'data-htmlmemo-search':''},'background:#f0a85b80;outline:2px solid #df9057;border-radius:2px;color:inherit');
  }
  outline() { return [...this.doc.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(n=>n.textContent.trim()).map(node=>({node,level:Number(node.localName[1]),title:node.textContent.trim()})); }
  addBookmark(title) { this.metadata.bookmarks.push({id:uid(),title,top:this.viewport.scrollTop/this.zoom,left:this.viewport.scrollLeft/this.zoom}); this.callbacks.onChange?.(); }
  dispose() { this.disposed=true; clearTimeout(this.positionTimer); this.resizeObserver?.disconnect(); this.hostObserver?.disconnect(); this.frame.srcdoc=''; this.host.remove(); }
}
