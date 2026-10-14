import { createReadAloud } from './read-aloud.js';
import { clamp, uid } from './utils.js';
import { History, TEXT_TOOLS, DRAW_TOOLS } from './model.js';
import { LAYER_ID, prepareLoadedHTML, cleanAnnotations, textIndex, selectionAnchor, resolveTextAnchor, wrapOffsets, rangeFromOffsets, serializeHTML } from './document.js';

const NS = 'http://www.w3.org/2000/svg';
const svg = (doc, tag, attrs = {}) => { const node = doc.createElementNS(NS, tag); for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value)); return node; };
export class Reader {
  constructor(host, parsed, callbacks) {
    this.host = host; this.metadata = parsed.metadata; this.callbacks = callbacks; this.history = new History(this.metadata.annotations);
    this.tool = 'select'; this.color = '#edcf67'; this.width = 3; this.opacity = .35; this.penTTL = 0; this.zoom = 1;
    this.nativeScroll = !!parsed.nativeScroll;
    this.selection = null; this.selectedId = null; this.linkHistory = []; this.searchResults = []; this.searchPosition = -1; this.autoFit = !this.metadata.view.zoom;
    this.middleScroll = null;
    this.viewport = document.createElement('div'); this.viewport.className = 'reader-viewport';
    this.viewport.classList.toggle('reader-native-scroll', this.nativeScroll);
    this.sizer = document.createElement('div'); this.sizer.className = 'reader-sizer';
    this.frame = document.createElement('iframe'); this.frame.className = 'document-frame'; this.frame.title = this.metadata.title;
    // Local documents explicitly enable scripts; captures retain static mode.
    // Forms, popups and top-level navigation remain sandboxed.
    this.frame.setAttribute('sandbox', this.metadata.execution?.allowScripts ? 'allow-same-origin allow-scripts' : 'allow-same-origin'); this.frame.referrerPolicy = 'no-referrer';
    this.naturalWidth = this.metadata.viewport.width; this.frame.style.height = '100%'; this.frame.style.width = this.naturalWidth + 'px';
    this.sizer.append(this.frame); this.viewport.append(this.sizer); host.append(this.viewport);
    if (this.nativeScroll) this.applyZoom();
    if (parsed.file) this.frame.style.pointerEvents = 'none';
    this.ready = new Promise((resolve, reject) => {
      this.frame.addEventListener('load', async () => {
        try {
          this.doc = this.frame.contentDocument;
          if (!this.doc?.body) throw new Error('HTML 문서를 표시하지 못했습니다.');
          if (parsed.file) {
            // Let the browser paint the original File before preparation. Reuse
            // its DOM instead of decoding, parsing and copying the book again.
            await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
            if (this.disposed) { resolve(this); return; }
            const blockNavigation = event => { if(event.type==='click'||event.key==='Enter')event.preventDefault(); };
            this.doc.addEventListener('click',blockNavigation,true);this.doc.addEventListener('keydown',blockNavigation,true);
            this.frame.style.pointerEvents = '';
            const prepared = await prepareLoadedHTML(this.doc, this.metadata, () => this.disposed);
            this.doc.removeEventListener('click',blockNavigation,true);this.doc.removeEventListener('keydown',blockNavigation,true);
            const openingScroll = {top:this.doc.defaultView.scrollY,left:this.doc.defaultView.scrollX};
            this.metadata = prepared.metadata; this.history = new History(this.metadata.annotations);
            this.autoFit = !this.metadata.view.zoom;
            this.initialHTML = prepared.html;
            this.naturalWidth = this.metadata.viewport.width;
            this.frame.style.width = this.naturalWidth + 'px';
            this.openingScroll = openingScroll;
          }
          this.bind(); this.frame.style.pointerEvents = ''; this.measure(); this.render();
          this.zoom = clamp(this.metadata.view.zoom || this.fitZoom(), .2, 8); this.applyZoom();
          requestAnimationFrame(() => { if(this.disposed){resolve(this);return;} this.scrollTop = this.openingScroll?.top ? this.openingScroll.top*this.zoom : Number(this.metadata.view.scrollTop) || 0; this.scrollLeft = this.openingScroll?.left ? this.openingScroll.left*this.zoom : Number(this.metadata.view.scrollLeft) || 0; this.positionDocumentSidebarToggle(); this.callbacks.onView?.(); resolve(this); });
        } catch (error) { reject(error); }
      }, {once:true});
    });
    if (this.nativeScroll) {
      this.documentURL = URL.createObjectURL(parsed.file || new Blob([parsed.html], {type:'text/html;charset=utf-8'}));
      this.frame.src = this.documentURL;
    } else this.frame.srcdoc = parsed.html;
  }
  bind() {
    const editorStyle = this.doc.createElement('style'); editorStyle.id = 'htmlmemo-editor-style';
    editorStyle.textContent = `${this.nativeScroll ? '' : 'html{overflow:hidden!important;height:auto!important;min-height:0!important;scroll-behavior:auto!important}body{touch-action:pan-x pan-y;height:auto!important;min-height:0!important}'}html[data-htmlmemo-drawing] *{cursor:crosshair!important;user-select:none!important;touch-action:none!important}`; this.doc.head.append(editorStyle);
    this.doc.addEventListener('wheel', event => this.forwardWheel(event), {capture:true,passive:false});
    this.doc.addEventListener('pointerdown', event => { if(this.startMiddleScroll(event))return;this.stopMiddleScroll();this.callbacks.onSelectionDismiss?.(); this.pointerDown(event); }, true);
    this.doc.addEventListener('pointermove', event => { if(this.moveMiddleScroll(event))return;this.pointerMove(event); }, true);
    this.doc.addEventListener('pointerup', event => { if(this.endMiddleScroll(event))return;this.pointerUp(event); }, true);
    this.doc.addEventListener('pointercancel', () => { this.stopMiddleScroll();this.gesture = null; this.preview?.remove(); this.preview = null; });
    this.doc.addEventListener('auxclick', event => {if(event.button===1&&!event.target.closest?.('a,button,input,textarea,select,[contenteditable]'))event.preventDefault();}, true);
    this.doc.addEventListener('selectionchange', () => { const s = this.doc.getSelection(); if (s?.rangeCount && !s.isCollapsed) this.selection = selectionAnchor(this.doc, s.getRangeAt(0)); });
    this.doc.addEventListener('keydown', event => {if(event.key==='Escape'&&this.middleScroll){this.stopMiddleScroll();event.preventDefault();return;}this.callbacks.onKey?.(event);});
    this.doc.addEventListener('dblclick', event => this.focusDocument(event));
    this.viewport.addEventListener('dblclick', event => this.focusDocument(event));
    this.doc.addEventListener('click', event => {
      const annotation = event.target.closest?.('[data-htmlmemo-id]');
      if (annotation && this.tool === 'select') { event.preventDefault(); event.stopPropagation(); this.selectedId = annotation.dataset.htmlmemoId; this.callbacks.onSelect?.(this.selectedId); return; }
      const link = event.target.closest?.('a[href]');
      if (!link) return;
      const href = link.getAttribute('href');
      if (this.metadata.execution?.allowScripts && /^javascript:/i.test(href)) return;
      event.preventDefault();
      if (this.tool !== 'select') return;
      let hash = href.startsWith('#') ? href : '';
      if (!hash && this.metadata.source) { try { const current = new URL(this.metadata.source); const dest = new URL(href); if (current.origin === dest.origin && current.pathname === dest.pathname && current.search === dest.search) hash = dest.hash; } catch { /* non-web links aren't opened by the app */ } }
      if (hash) {
        let id; try { id = decodeURIComponent(hash.slice(1)); } catch { id = hash.slice(1); }
        const target = this.doc.getElementById(id) || [...this.doc.querySelectorAll('a[name]')].find(a => a.name === id);
        if (target) { this.linkHistory.push({top:this.scrollTop, left:this.scrollLeft}); if (this.linkHistory.length > 128) this.linkHistory.shift(); this.jump(target); }
      } else if (/^https?:/.test(href)) this.callbacks.onLink?.(href);
    }, true);
    (this.nativeScroll ? this.doc : this.viewport).addEventListener('scroll', () => {
      clearTimeout(this.positionTimer);
      this.positionTimer = setTimeout(() => {
        if (this.disposed) return;
        this.metadata.view = {scrollTop:this.scrollTop, scrollLeft:this.scrollLeft, zoom:this.zoom};
        this.callbacks.onPosition?.(); this.callbacks.onView?.();
      }, 250);
    }, {passive:true});
    this.resizeObserver = new ResizeObserver(() => { if (!this.disposed) { this.measure(); this.renderDrawingLayer(); } });
    this.resizeObserver.observe(this.doc.body);
    this.hostObserver = new ResizeObserver(() => { if (!this.disposed) { if(this.autoFit)this.zoom = this.fitZoom(); if(this.nativeScroll || this.autoFit)this.applyZoom(); this.positionDocumentSidebarToggle(); } }); this.hostObserver.observe(this.viewport);
    this.doc.fonts.ready.then(() => { if (!this.disposed) { this.measure(); this.renderDrawingLayer(); } });
    this.installDocumentSidebarToggle();
    if (this.metadata.execution?.allowScripts) {
      this.dynamicAnchor = 0;
      this.dynamicObserver = new MutationObserver(records => {
        const editor = node => (node.nodeType===3?node.parentElement:node)?.closest?.('#'+LAYER_ID+',#htmlmemo-annotation-style,#htmlmemo-editor-style,#htmlmemo-sidebar-style,#htmlmemo-toc-toggle-style,[data-htmlmemo-ui],[data-htmlmemo-mark],[data-htmlmemo-search]');
        if(records.some(record=>!editor(record.target) && (record.type==='characterData' || [...record.addedNodes,...record.removedNodes].some(node=>!editor(node)))))this.scheduleDynamicRefresh();
      });
      this.observeDynamicDocument();
      this.scheduleDynamicRefresh();
    }
  }
  forwardWheel(event) {
    // The iframe is a separate event tree.  Move its actual scroll owner
    // directly so a wheel keeps working even when the source HTML cancels its
    // own wheel event or uses a custom root scroller.
    if (event.ctrlKey) return;
    const scale=event.deltaMode===1?16:event.deltaMode===2?this.viewport.clientHeight:1;
    const left=event.deltaX*scale,top=event.deltaY*scale;
    for(let node=event.target;node?.nodeType===1;node=node.parentElement){
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
      if (node===this.doc.documentElement) break;
    }
    if(this.nativeScroll) {
      const root=this.doc.scrollingElement||this.doc.documentElement||this.doc.body;
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
        if(this.nativeScroll)this.doc.defaultView.scrollBy(left/this.zoom,top/this.zoom);
        else this.viewport.scrollBy(left,top);
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
  installDocumentSidebarToggle() {
    if (this.disposed || !this.doc) return;
    const sidebar=this.findDocumentSidebar();
    if (!sidebar) { this.clearDocumentSidebarToggle();return; }
    if (this.documentSidebar!==sidebar) {
      this.clearDocumentSidebarToggle();
      this.documentSidebar=sidebar;this.sidebarFolded=false;this.sidebarGrid=null;
    }
    this.ensureDocumentSidebarToggleStyle();
    let button=[...sidebar.children].find(node=>node.hasAttribute?.('data-htmlmemo-toc-toggle'));
    if (!button) {
      button=this.doc.createElement('button');button.type='button';button.setAttribute('data-htmlmemo-toc-toggle','');
      sidebar.prepend(button);
    }
    if (this.tocToggle!==button) {
      this.tocToggle?.remove();
      button.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();this.toggleDocumentSidebar();});
    }
    button.setAttribute('data-htmlmemo-ui','');
    this.tocToggle=button;
    this.positionDocumentSidebarToggle();
  }
  findDocumentSidebar() {
    const named='.toc,#toc,.table-of-contents,#table-of-contents,.book-toc,#book-toc,.reader-toc,[data-toc]';
    const label=value=>/목차|table of contents|contents/i.test(String(value||''));
    const isMain=node=>!!node?.closest?.('main,article,[role="main"]');
    const name=node=>`${node?.id||''} ${typeof node?.className==='string'?node.className:''} ${node?.getAttribute?.('role')||''} ${node?.getAttribute?.('data-toc')||''}`;
    const namedNode=node=>node.matches?.(named)||/(?:^|[\s_-])(toc|contents?|목차)(?:$|[\s_-])/i.test(name(node));
    const navigation=node=>!!node.querySelector?.('a[href],ol,ul,li,[role="list"],[role="tree"]');
    const titled=node=>{
      if(label(node.getAttribute?.('aria-label'))||label(node.getAttribute?.('data-title'))||label(node.getAttribute?.('title')))return true;
      return [...node.querySelectorAll?.('h1,h2,h3,h4,h5,h6,header,[role="heading"],[data-toc-title],[data-title]')||[]].some(heading=>label(heading.textContent)||label(heading.getAttribute?.('aria-label')));
    };
    const candidates=[...this.doc.querySelectorAll(named+',aside,nav,[role="navigation"],[role="complementary"],#sidebar,.sidebar')];
    const direct=candidates.find(node=>!isMain(node)&&navigation(node)&&(namedNode(node)||titled(node)));
    if(direct)return direct;
    // Some publishers use an otherwise unlabelled <div> as the sidebar. Walk
    // out from a real “목차” heading, but never make a main article panel a TOC.
    const headings=[...this.doc.querySelectorAll('h1,h2,h3,h4,h5,h6,header,[role="heading"],[data-toc-title],[data-title],[aria-label]')].filter(node=>label(node.textContent)||label(node.getAttribute?.('aria-label'))||label(node.getAttribute?.('data-title')));
    for(const heading of headings){
      for(let node=heading.parentElement,depth=0;node&&node!==this.doc.body&&depth<6;node=node.parentElement,depth++){
        if(!isMain(node)&&navigation(node)&&(namedNode(node)||['aside','nav','section'].includes(node.localName)||node.parentElement===this.doc.body))return node;
      }
    }
    return null;
  }
  ensureDocumentSidebarToggleStyle() {
    if (this.doc.getElementById('htmlmemo-toc-toggle-style')) return;
    const style=this.doc.createElement('style');style.id='htmlmemo-toc-toggle-style';
    // The button is a temporary direct child of the source TOC.  Keeping it
    // inside the panel means the same control becomes the narrow visible tab
    // after folding, without creating an app-owned outline or touching scroll
    // containers outside the source document.
    style.textContent='[data-htmlmemo-toc-toggle]{box-sizing:border-box!important;float:right!important;display:flex!important;align-items:center!important;justify-content:center!important;width:26px!important;min-width:26px!important;height:26px!important;margin:2px!important;padding:0!important;border:1px solid #94a3b8!important;border-radius:5px!important;background:#fff!important;color:#334155!important;font:600 18px/1 system-ui,sans-serif!important;cursor:pointer!important;position:relative!important;z-index:2147483646!important}[data-htmlmemo-toc-toggle]:hover{background:#f1f5f9!important}[data-htmlmemo-toc-toggle]:focus-visible{outline:2px solid #334155!important;outline-offset:1px!important}[data-htmlmemo-toc-collapsed]{box-sizing:border-box!important;width:18px!important;min-width:18px!important;max-width:18px!important;flex:0 0 18px!important;padding:0!important;margin:0!important;overflow:hidden!important;font-size:0!important}[data-htmlmemo-toc-collapsed]>:not([data-htmlmemo-toc-toggle]){display:none!important}[data-htmlmemo-toc-collapsed]>[data-htmlmemo-toc-toggle]{float:none!important;display:flex!important;width:18px!important;min-width:18px!important;max-width:18px!important;height:96px!important;min-height:96px!important;margin:0!important;padding:0!important;border-width:0 1px 0 0!important;border-radius:0 5px 5px 0!important;font-size:17px!important;line-height:1!important}[data-htmlmemo-sidebar-grid]{grid-template-columns:var(--htmlmemo-toc-grid-columns)!important}[data-htmlmemo-sidebar-grid-item],[data-htmlmemo-sidebar-flex]{box-sizing:border-box!important;width:18px!important;min-width:0!important;max-width:18px!important;margin-inline:0!important;padding-inline:0!important;overflow:hidden!important}[data-htmlmemo-sidebar-flex]{flex:0 0 18px!important}';
    this.doc.head.append(style);
  }
  gridTracks(value) {
    const values=String(value||'').trim().split(/\s+/).filter(Boolean);
    if(values.length<2||values.some(value=>!/^\d+(?:\.\d+)?px$/i.test(value)))return [];
    return values.map(value=>Number.parseFloat(value));
  }
  gridTrackIndex(parent,item,tracks,layout) {
    const box=parent.getBoundingClientRect(),cell=item.getBoundingClientRect();
    if(!box.width||!cell.width)return -1;
    const left=box.left+(Number.parseFloat(layout.borderLeftWidth)||0)+(Number.parseFloat(layout.paddingLeft)||0);
    const right=(box.right??box.left+box.width)-(Number.parseFloat(layout.borderRightWidth)||0)-(Number.parseFloat(layout.paddingRight)||0);
    const gap=Number.parseFloat(layout.columnGap||layout.gap)||0,x=cell.left+cell.width/2;
    const rtl=String(layout.direction||'').toLowerCase()==='rtl';
    let cursor=rtl?right:left;
    for(let index=0;index<tracks.length;index++){
      const start=rtl?cursor-tracks[index]:cursor,end=rtl?cursor:cursor+tracks[index];
      if(x>=start-1&&x<=end+1)return index;
      cursor=rtl?start-gap:end+gap;
    }
    return -1;
  }
  gridItem(parent,node) {
    for(let item=node;item&&item!==parent;item=item.parentElement)if(item.parentElement===parent)return item;
    return null;
  }
  documentMainTrack(parent,sidebarItem,tracks,layout) {
    const mainNodes=[...parent.querySelectorAll('main,[role="main"],article,#main,#content,.page,.content')];
    const candidates=[];
    for(const node of mainNodes){
      const item=this.gridItem(parent,node);
      if(!item||item===sidebarItem||sidebarItem.contains(node)||node.contains(sidebarItem))continue;
      const index=this.gridTrackIndex(parent,item,tracks,layout);
      if(index<0)continue;
      const box=item.getBoundingClientRect(),main=node.matches('main,[role="main"]')?3:node.matches('article,#main,#content')?2:1;
      candidates.push({index,score:main*1e9+Math.max(0,box.width)*Math.max(0,box.height)});
    }
    if(candidates.length)return candidates.sort((a,b)=>b.score-a.score)[0].index;
    const siblings=[];
    for(const item of parent.children){
      if(item===sidebarItem)continue;
      const index=this.gridTrackIndex(parent,item,tracks,layout);
      if(index<0)continue;
      const box=item.getBoundingClientRect();siblings.push({index,score:Math.max(0,box.width)*Math.max(0,box.height)});
    }
    if(siblings.length)return siblings.sort((a,b)=>b.score-a.score)[0].index;
    return -1;
  }
  findDocumentSidebarLayout(sidebar) {
    let flexLayout=null;
    for(let item=sidebar,depth=0;item?.parentElement&&depth<10;item=item.parentElement,depth++){
      const parent=item.parentElement,layout=this.doc.defaultView.getComputedStyle(parent);
      if(/grid/.test(layout.display||'')){
        const tracks=this.gridTracks(layout.gridTemplateColumns),index=this.gridTrackIndex(parent,item,tracks,layout);
        if(index>=0){
          let mainTrack=this.documentMainTrack(parent,item,tracks,layout);
          if(mainTrack===index)mainTrack=-1;
          const columns=tracks.map((width,cursor)=>cursor===index?'18px':cursor===mainTrack?'minmax(0,1fr)':`${width}px`).join(' ');
          return {kind:'grid',element:parent,item,columns};
        }
      }
      if(/flex/.test(layout.display||'')&&!flexLayout)flexLayout={kind:'flex',element:item};
    }
    return flexLayout;
  }
  applyDocumentSidebarLayout(sidebar) {
    this.restoreDocumentSidebarLayout();
    const layout=this.findDocumentSidebarLayout(sidebar);
    if(!layout)return;
    if(layout.kind==='grid'){
      const style=layout.element.style,property='--htmlmemo-toc-grid-columns';
      this.sidebarLayout={...layout,value:style.getPropertyValue(property),priority:style.getPropertyPriority?.(property)||''};
      layout.element.setAttribute('data-htmlmemo-sidebar-grid','');layout.item.setAttribute('data-htmlmemo-sidebar-grid-item','');style.setProperty(property,layout.columns);this.sidebarGrid=layout.element;
    } else {
      layout.element.setAttribute('data-htmlmemo-sidebar-flex','');this.sidebarLayout=layout;
    }
  }
  restoreDocumentSidebarLayout() {
    const layout=this.sidebarLayout;
    if(layout?.kind==='grid'){
      layout.element.removeAttribute('data-htmlmemo-sidebar-grid');
      layout.item.removeAttribute('data-htmlmemo-sidebar-grid-item');
      if(layout.value)layout.element.style.setProperty('--htmlmemo-toc-grid-columns',layout.value,layout.priority);else layout.element.style.removeProperty('--htmlmemo-toc-grid-columns');
    } else if(layout?.kind==='flex')layout.element.removeAttribute('data-htmlmemo-sidebar-flex');
    if(this.sidebarGrid&&this.sidebarGrid!==layout?.element)this.sidebarGrid.removeAttribute('data-htmlmemo-sidebar-grid');
    this.sidebarGrid=null;this.sidebarLayout=null;
  }
  clearDocumentSidebarToggle() {
    this.documentSidebar?.removeAttribute('data-htmlmemo-toc-collapsed');
    this.restoreDocumentSidebarLayout();
    this.tocToggle?.remove();
    this.doc?.getElementById('htmlmemo-toc-toggle-style')?.remove();
    this.tocToggle=null;this.documentSidebar=null;this.sidebarGrid=null;this.sidebarFolded=false;this.sidebarScroll=null;
  }
  toggleDocumentSidebar() {
    if (this.disposed || !this.documentSidebar?.isConnected) return;
    const sidebar=this.documentSidebar,position={top:this.scrollTop,left:this.scrollLeft};
    const folded=!this.sidebarFolded;
    if (folded) {
      this.sidebarScroll={top:sidebar.scrollTop,left:sidebar.scrollLeft};
      this.ensureDocumentSidebarToggleStyle();
      // The TOC can be wrapped before it reaches the actual grid/flex item.
      // Narrow that layout track as well as the sidebar itself so the reading
      // pane receives the released width.
      this.applyDocumentSidebarLayout(sidebar);
      sidebar.setAttribute('data-htmlmemo-toc-collapsed','');
    } else {
      sidebar.removeAttribute('data-htmlmemo-toc-collapsed');
      this.restoreDocumentSidebarLayout();
      sidebar.scrollTop=this.sidebarScroll?.top||0;sidebar.scrollLeft=this.sidebarScroll?.left||0;
    }
    this.sidebarFolded=folded;
    this.measure();this.renderDrawingLayer();
    this.scrollTop=position.top;this.scrollLeft=position.left;
    this.positionDocumentSidebarToggle();
    this.doc.defaultView.requestAnimationFrame(()=>{
      if(this.disposed)return;
      this.scrollTop=position.top;this.scrollLeft=position.left;this.positionDocumentSidebarToggle();
    });
  }
  positionDocumentSidebarToggle() {
    if (this.disposed || !this.tocToggle || !this.documentSidebar?.isConnected) return;
    const label=this.sidebarFolded?'목차 사이드바 펼치기':'목차 사이드바 접기';
    this.tocToggle.hidden=false;this.tocToggle.textContent=this.sidebarFolded?'›':'‹';this.tocToggle.title=label;
    this.tocToggle.setAttribute('aria-label',label);this.tocToggle.setAttribute('aria-expanded',String(!this.sidebarFolded));
  }
  observeDynamicDocument() {
    if (!this.disposed) this.dynamicObserver?.observe(this.doc.documentElement,{childList:true,subtree:true,characterData:true});
  }
  scheduleDynamicRefresh() {
    if (this.disposed) return;
    this.dynamicDirty = true;
    clearTimeout(this.dynamicTimer);
    this.dynamicTimer = setTimeout(() => this.refreshDynamicDocument().catch(error=>this.callbacks.onError?.(error)),400);
  }
  async refreshDynamicDocument() {
    if (this.disposed || this.dynamicRunning) return;
    this.dynamicRunning = true;this.dynamicDirty = false;
    try {
      const body = this.doc.body;if (!body) return;
      body.setAttribute('data-htmlmemo-anchor','body');
      let count=0;
      for (const element of body.querySelectorAll('*')) {
        if (!element.closest('#'+LAYER_ID+',[data-htmlmemo-ui]') && !['script','style','meta','link','template'].includes(element.localName) && !element.hasAttribute('data-htmlmemo-anchor')) element.setAttribute('data-htmlmemo-anchor','js'+this.dynamicAnchor++);
        if (++count % 1000 === 0) {await new Promise(resolve=>setTimeout(resolve,0));if(this.disposed)return;}
      }
      this.initialHTML = null;
      this.measure();this.render();this.installDocumentSidebarToggle();
      this.callbacks.onChange?.();this.callbacks.onView?.();
    } finally {
      this.dynamicRunning = false;
      if (this.dynamicDirty && !this.disposed) this.scheduleDynamicRefresh();
    }
  }
  focusDocument(event) {
    if (this.disposed || event.button != null && event.button !== 0) return;
    if (event.target.closest?.('a,button,input,textarea,select,[contenteditable],[data-htmlmemo-id]')) return;
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
  fitZoom() { const inset=this.host.closest('.reader-focus') ? 0 : innerWidth < 600 ? 16 : 56; return clamp((this.viewport.clientWidth - inset) / this.naturalWidth, .2, this.host.closest('.reader-focus') ? 8 : 2); }
  applyZoom() {
    if (this.nativeScroll) this.frame.style.height = Math.max(200, this.viewport.clientHeight / this.zoom) + 'px';
    this.frame.style.transform = `scale(${this.zoom})`;
    this.sizer.style.width = this.naturalWidth * this.zoom + 'px'; this.sizer.style.height = this.nativeScroll ? Math.max(200 * this.zoom, this.viewport.clientHeight) + 'px' : (this.naturalHeight || 800) * this.zoom + 'px';
    // The document-owned TOC tab stays in the iframe. Keep its label current
    // after every size or zoom update so it is ready on the first paint.
    this.positionDocumentSidebarToggle?.();
  }
  get scrollTop() { return this.nativeScroll ? (this.doc.defaultView.scrollY || 0) * this.zoom : this.viewport.scrollTop; }
  set scrollTop(value) { if(this.nativeScroll)this.doc.defaultView.scrollTo(this.doc.defaultView.scrollX, value / this.zoom);else this.viewport.scrollTop=value; }
  get scrollLeft() { return this.nativeScroll ? this.viewport.scrollLeft + (this.doc.defaultView.scrollX || 0) * this.zoom : this.viewport.scrollLeft; }
  set scrollLeft(value) { if(this.nativeScroll){const target=Math.max(0,value);this.viewport.scrollLeft=target;this.doc.defaultView.scrollTo((target-this.viewport.scrollLeft)/this.zoom, this.doc.defaultView.scrollY);}else this.viewport.scrollLeft=value; }
  setZoom(value, fit = false) {
    const centerX = (this.scrollLeft + this.viewport.clientWidth / 2) / this.zoom;
    const centerY = (this.scrollTop + this.viewport.clientHeight / 2) / this.zoom;
    this.autoFit = fit; this.zoom = clamp(fit ? this.fitZoom() : value, .2, 8); this.applyZoom();
    this.scrollLeft = centerX * this.zoom - this.viewport.clientWidth / 2; this.scrollTop = centerY * this.zoom - this.viewport.clientHeight / 2;
    this.rememberPosition(); this.callbacks.onView?.();
  }
  rememberPosition() {
    this.metadata.view = {scrollTop:this.scrollTop, scrollLeft:this.scrollLeft, zoom:this.zoom};
    this.callbacks.onPosition?.();
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
      const position = this.elementAnchor(element);
      this.commit([...this.metadata.annotations, this.annotation(type, {anchor:position.key, points:[{x:(rect.left + this.doc.defaultView.scrollX-position.x)/position.width,y:(rect.top+this.doc.defaultView.scrollY-position.y)/position.height}], text:text.trim()})]);
    } else this.commit([...this.metadata.annotations, this.annotation(type, {textAnchor:anchor})]);
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
    return {key:element.dataset.htmlmemoAnchor || 'body', x:rect.left + this.doc.defaultView.scrollX, y:rect.top + this.doc.defaultView.scrollY, width:Math.max(1, rect.width), height:Math.max(1, rect.height)};
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
    for (const annotation of this.metadata.annotations.filter(a => TEXT_TOOLS.includes(a.type))) {
      const resolved = resolveTextAnchor(textIndex(this.doc), annotation.textAnchor); if (!resolved) continue;
      const style = annotation.type === 'highlight' ? `background:${annotation.color}${Math.round(annotation.opacity * 255).toString(16).padStart(2,'0')};color:inherit` : `text-decoration-line:${annotation.type === 'underline' ? 'underline' : 'line-through'};text-decoration-color:${annotation.color};text-decoration-thickness:${annotation.width}px;text-underline-offset:3px`;
      wrapOffsets(this.doc, resolved.start, resolved.end, {'data-htmlmemo-mark':'','data-htmlmemo-id':annotation.id}, style);
    }
    this.renderDrawingLayer();
    if (this.searchQuery) this.search(this.searchQuery, false);
    this.observeDynamicDocument();
  }
  absolutePoints(annotation) {
    if (!annotation.anchor) return annotation.points;
    const element = this.doc.querySelector(`[data-htmlmemo-anchor="${annotation.anchor}"]`) || this.doc.body;
    const r = element.getBoundingClientRect();
    return annotation.points.map(p => ({x:r.left + this.doc.defaultView.scrollX + p.x * Math.max(1,r.width), y:r.top + this.doc.defaultView.scrollY + p.y * Math.max(1,r.height)}));
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
    this.layer = svg(this.doc, 'svg', {id:LAYER_ID,width:this.naturalWidth,height:this.nativeScroll ? 1 : this.naturalHeight || 800,'aria-label':'HTMLMemo 주석',style:'position:absolute;top:0;left:0;z-index:2147483000;pointer-events:none;overflow:visible;'});
    this.layer.dataset.htmlmemoUi = '';
    for (const annotation of this.metadata.annotations.filter(a => !TEXT_TOOLS.includes(a.type))) { const node = this.drawAnnotation(annotation); if (node) this.layer.append(node); }
    this.doc.body.append(this.layer);
    // Source pages can position their body. Keep overlay coordinates relative
    // to the document viewport rather than applying the body offset twice.
    const offset=this.layer.getBoundingClientRect();this.layer.style.left=-(offset.left + (this.doc.defaultView.scrollX || 0))+'px';this.layer.style.top=-(offset.top + (this.doc.defaultView.scrollY || 0))+'px';
  }
  html() { return serializeHTML(this.doc, this.metadata); }
  async back() { const p = this.linkHistory.pop(); if (!p) return false; this.scrollTop=p.top; this.scrollLeft=p.left; this.callbacks.onView?.(); return true; }
  jump(target) {
    const r = target.getBoundingClientRect(); this.scrollTop = Math.max(0,(r.top+this.doc.defaultView.scrollY+r.height/2)*this.zoom-this.viewport.clientHeight/2); this.scrollLeft = Math.max(0,(r.left+this.doc.defaultView.scrollX+r.width/2)*this.zoom-this.viewport.clientWidth/2);
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
    const rect=range.getBoundingClientRect(); this.scrollTop=Math.max(0,(rect.top+this.doc.defaultView.scrollY+rect.height/2)*this.zoom-this.viewport.clientHeight/2);
    this.scrollLeft=Math.max(0,(rect.left+this.doc.defaultView.scrollX+rect.width/2)*this.zoom-this.viewport.clientWidth/2);
    wrapOffsets(this.doc,result.start,result.end,{'data-htmlmemo-search':''},'background:#f0a85b80;outline:2px solid #df9057;border-radius:2px;color:inherit');
  }
  outline() { return [...this.doc.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(n=>n.textContent.trim()).map(node=>({node,level:Number(node.localName[1]),title:node.textContent.trim()})); }
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
  dispose() { this.stopMiddleScroll();this.readAloud?.dispose();this.readAloud=null;this.stopSpeech(); this.disposed=true; clearTimeout(this.positionTimer);clearTimeout(this.dynamicTimer);this.dynamicObserver?.disconnect(); this.resizeObserver?.disconnect(); this.hostObserver?.disconnect(); this.frame.srcdoc=''; if(this.documentURL){URL.revokeObjectURL(this.documentURL);this.documentURL=null;} this.host.remove(); }
}
