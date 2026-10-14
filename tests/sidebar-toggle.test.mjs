import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {Reader} from '../public/src/reader.js';
import {icon} from '../public/src/utils.js';
import {serializeHTML,textIndex,parseHTML,cleanAnnotations} from '../public/src/document.js';
import {documentFor,installDOM} from './dom.mjs';
installDOM();

const source='<html><head><style>body{display:grid;grid-template-columns:240px 1fr}.toc{position:sticky;top:0;height:100dvh;overflow:auto;width:240px}.page{min-height:4000px}</style></head><body><aside class="toc" style="color:navy" data-htmlmemo-anchor="toc"><h2>목차</h2><a href="#chapter">첫 장</a></aside><main class="page"><h1 id="chapter">본문</h1><p>읽기와 메모</p></main></body></html>';
function sidebarReader({layout='grid',native=true,html=source,layoutSelector='body',gridColumns='240px 860px',direction='ltr',rects={}}={}) {
  const doc=documentFor(html),app=documentFor('<html><body><section id="host"></section></body></html>');
  const frames=[],listeners=[],moves=[];
  const layoutRoot=doc.querySelector(layoutSelector)||doc.body;
  const view={scrollX:0,scrollY:800,scrollTo(x,y){this.scrollX=x;this.scrollY=y;},requestAnimationFrame(fn){frames.push(fn);},addEventListener(name,fn){listeners.push([name,fn]);},getComputedStyle(node){return {display:node===layoutRoot?layout:'block',gridTemplateColumns:gridColumns,direction,overflowX:'visible',overflowY:'visible'};}};
  Object.defineProperty(doc,'defaultView',{value:view,configurable:true});
  const host=app.querySelector('#host');host.getBoundingClientRect=()=>({left:180,top:100,width:1000,height:700});
  const frame={style:{},getBoundingClientRect:()=>({left:180,top:100,width:825,height:700})};
  doc.body.getBoundingClientRect=()=>({left:0,top:0,right:1100,bottom:4000,width:1100,height:4000});
  Object.defineProperties(doc.body,{scrollHeight:{value:4000},offsetHeight:{value:4000},offsetTop:{value:0}});
  for(const child of doc.body.children)child.getBoundingClientRect=doc.body.getBoundingClientRect;
  for(const [selector,rect] of Object.entries(rects))doc.querySelector(selector).getBoundingClientRect=()=>rect;
  const sidebar=doc.querySelector('.toc');
  if(sidebar){sidebar.scrollTop=125;sidebar.scrollLeft=0;sidebar.getBoundingClientRect=()=>({left:0,top:0,right:sidebar.hasAttribute('data-htmlmemo-toc-collapsed')?18:240,bottom:600,width:sidebar.hasAttribute('data-htmlmemo-toc-collapsed')?18:240,height:600});}
  doc.documentElement.scrollBy=move=>{moves.push(move);view.scrollY+=move.top;};
  const viewport=app.createElement('div');Object.assign(viewport,{clientWidth:1000,clientHeight:700,scrollTop:600,scrollLeft:0,scrollBy(move){moves.push(move);this.scrollTop+=move.top;}});
  const r=Object.create(Reader.prototype);
  Object.assign(r,{doc,host,frame,viewport,nativeScroll:native,zoom:.75,naturalWidth:1100,sizer:{style:{}},metadata:parseHTML(source,{}, {allowScripts:native}).metadata,renderDrawingLayer(){},callbacks:{}});
  return {r,doc,sidebar,layoutRoot,app,moves,flush(){while(frames.length)frames.shift()();}};
}

test('the document TOC receives one direct-child toggle without creating an app-owned outline',()=>{
  const {r,doc,sidebar,app}=sidebarReader();
  r.installDocumentSidebarToggle();r.installDocumentSidebarToggle();
  const button=[...sidebar.children].find(node=>node.hasAttribute('data-htmlmemo-toc-toggle'));
  assert.equal(button.parentElement,sidebar);
  assert.equal(button.getAttribute('data-htmlmemo-ui'),'');
  assert.equal(app.querySelector('.document-sidebar-toggle'),null);
  assert.equal(doc.querySelector('#htmlmemo-toc-toggle-style')?.parentElement,doc.head);
  assert.equal(sidebar.querySelector('h2').textContent,'목차');
  assert.equal(button.getAttribute('aria-expanded'),'true');
  assert.equal(button.getAttribute('aria-label'),'목차 사이드바 접기');
});

test('the TOC folds to an 18px vertical tab and restores source layout and scrolling',()=>{
  for(const layout of ['grid','flex']){
    const {r,doc,sidebar,flush}=sidebarReader({layout});r.installDocumentSidebarToggle();
    const original=sidebar.innerHTML,css=doc.querySelector('style').textContent,index=textIndex(doc).text;
    for(let count=0;count<3;count++){
      const position=r.scrollTop;r.toggleDocumentSidebar();flush();
      const button=r.tocToggle;
      assert.equal(r.scrollTop,position);assert.equal(button.getAttribute('aria-expanded'),'false');
      assert.equal(doc.body.hasAttribute('data-htmlmemo-sidebar-grid'),layout==='grid');
      assert.equal(sidebar.hasAttribute('data-htmlmemo-toc-collapsed'),true);
      assert.equal(sidebar.getBoundingClientRect().width,18);
      assert.equal(button.parentElement,sidebar);
      assert.equal(textIndex(doc).text,index,'folding does not move text annotation offsets');
      sidebar.scrollTop=0;r.toggleDocumentSidebar();flush();
      assert.equal(sidebar.scrollTop,125);assert.equal(r.scrollTop,position);
      assert.equal(sidebar.innerHTML,original);assert.equal(doc.querySelector('style').textContent,css);
      assert.equal(sidebar.hasAttribute('data-htmlmemo-toc-collapsed'),false);
      assert.equal(doc.body.hasAttribute('data-htmlmemo-sidebar-grid'),false);
      assert.equal(button.getAttribute('aria-expanded'),'true');
    }
  }
});

test('a wrapped TOC shrinks its actual ancestor grid track and gives the reading pane the width',()=>{
  const nested='<html><head><style>.reader-layout{display:grid;grid-template-columns:240px minmax(0,1fr)}.toc{width:240px}.page{min-width:0}</style></head><body><div class="reader-layout"><div class="toc-slot"><div class="toc"><div>목차</div><ol><li><a href="#chapter">첫 장</a></li></ol></div></div><main class="page"><h1 id="chapter">본문</h1></main></div></body></html>';
  const {r,doc,sidebar,layoutRoot,flush}=sidebarReader({html:nested,layoutSelector:'.reader-layout',rects:{'.toc-slot':{left:0,top:0,right:240,bottom:600,width:240,height:600},'.page':{left:240,top:0,right:1100,bottom:600,width:860,height:600}}});
  r.installDocumentSidebarToggle();assert.ok(r.tocToggle,'a document-owned TOC is found even when its label is a plain div');
  r.toggleDocumentSidebar();flush();
  assert.equal(sidebar.hasAttribute('data-htmlmemo-toc-collapsed'),true);
  assert.equal(layoutRoot.hasAttribute('data-htmlmemo-sidebar-grid'),true);
  assert.equal(doc.querySelector('.toc-slot').hasAttribute('data-htmlmemo-sidebar-grid-item'),true);
  assert.equal(layoutRoot.style.getPropertyValue('--htmlmemo-toc-grid-columns'),'18px minmax(0,1fr)');
  assert.match(doc.querySelector('#htmlmemo-toc-toggle-style').textContent,/var\(--htmlmemo-toc-grid-columns\)/);
  r.toggleDocumentSidebar();flush();
  assert.equal(layoutRoot.hasAttribute('data-htmlmemo-sidebar-grid'),false);
  assert.equal(doc.querySelector('.toc-slot').hasAttribute('data-htmlmemo-sidebar-grid-item'),false);
  assert.equal(layoutRoot.style.getPropertyValue('--htmlmemo-toc-grid-columns')||'','');
});

test('a left TOC remains left when its source grid uses right-to-left column lines',()=>{
  const rtl='<html><head><style>.reader-layout{display:grid;direction:rtl;grid-template-columns:minmax(0,1fr) 240px}.toc{direction:ltr;grid-column:2;width:240px}.page{direction:ltr;grid-column:1;min-width:0}</style></head><body><div class="reader-layout"><aside class="toc"><h2>목차</h2><a href="#chapter">첫 장</a></aside><main class="page"><h1 id="chapter">본문</h1></main></div></body></html>';
  const {r,doc,layoutRoot,flush}=sidebarReader({html:rtl,layoutSelector:'.reader-layout',gridColumns:'860px 240px',direction:'rtl',rects:{'.toc':{left:0,top:0,right:240,bottom:600,width:240,height:600},'.page':{left:240,top:0,right:1100,bottom:600,width:860,height:600}}});
  r.installDocumentSidebarToggle();r.toggleDocumentSidebar();flush();
  assert.equal(layoutRoot.style.getPropertyValue('--htmlmemo-toc-grid-columns'),'minmax(0,1fr) 18px');
  assert.equal(doc.querySelector('.toc').hasAttribute('data-htmlmemo-toc-collapsed'),true);
  assert.equal(doc.querySelector('.page').getBoundingClientRect().left,240,'the main pane stays to the right of the left TOC');
});

test('annotation rendering cleanup does not remove the live document TOC tab',()=>{
  const {r,doc,sidebar,flush}=sidebarReader();r.installDocumentSidebarToggle();r.toggleDocumentSidebar();flush();
  cleanAnnotations(doc);
  assert.equal(sidebar.hasAttribute('data-htmlmemo-toc-collapsed'),true);
  assert.equal(sidebar.querySelector('[data-htmlmemo-toc-toggle]'),r.tocToggle);
  assert.ok(doc.querySelector('#htmlmemo-toc-toggle-style'));
});

test('wheel scrolling uses the same scroll owner with the TOC expanded and folded',()=>{
  for(const native of [true,false]){
    const {r,doc,moves,flush}=sidebarReader({native});r.installDocumentSidebarToggle();
    let prevented=0;
    const wheel={target:doc.querySelector('p'),deltaX:0,deltaY:80,deltaMode:0,preventDefault(){prevented++;}};
    for(let count=0;count<4;count++){
      const top=r.scrollTop;r.forwardWheel(wheel);
      assert.equal(r.scrollTop,top+(native?60:80));
      r.toggleDocumentSidebar();flush();
    }
    assert.equal(prevented,4);assert.equal(moves.length,4);
  }
});

test('saving while folded excludes the temporary TOC button and reopens the TOC expanded',()=>{
  const {r,doc,flush}=sidebarReader();r.installDocumentSidebarToggle();r.toggleDocumentSidebar();flush();
  const saved=serializeHTML(doc,r.metadata);
  assert.doesNotMatch(saved,/htmlmemo-toc-toggle-style|data-htmlmemo-toc-toggle|data-htmlmemo-toc-collapsed|data-htmlmemo-sidebar-grid(?:-item)?|data-htmlmemo-sidebar-flex|--htmlmemo-toc-grid-columns|document-sidebar-toggle/);
  const reopened=documentFor(parseHTML(saved).html);
  assert.equal(reopened.querySelector('.toc').getAttribute('style'),'color:navy');
  assert.equal(reopened.querySelector('.toc a').getAttribute('href'),'#chapter');
  assert.match(reopened.querySelector('style').textContent,/position:sticky;top:0;height:100dvh;overflow:auto;width:240px/);
  assert.equal(doc.querySelector('.toc').hasAttribute('data-htmlmemo-toc-collapsed'),true,'exporting does not expand the live document');
});

test('documents without a TOC do not acquire an unrelated navigation toggle',()=>{
  const {r,doc,app}=sidebarReader({html:'<html><head></head><body><nav><a href="#chapter">Home</a></nav><h1 id="chapter">본문</h1></body></html>'});
  r.installDocumentSidebarToggle();assert.equal(app.querySelector('.document-sidebar-toggle'),null);
  const sidebar=doc.createElement('aside');sidebar.className='toc';sidebar.innerHTML='<h2>목차</h2><a href="#chapter">첫 장</a>';
  sidebar.getBoundingClientRect=()=>({left:0,top:0,right:240,width:240,height:600});doc.body.prepend(sidebar);
  r.installDocumentSidebarToggle();assert.ok(sidebar.querySelector('[data-htmlmemo-toc-toggle]'),'a later generated TOC is discovered');
});

const appSource=await readFile(new URL('../public/src/app.js',import.meta.url),'utf8');
const appHTML=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
function libraryToggle(reader=null){
  const doc=documentFor(appHTML),frames=[];
  const context=vm.createContext({$:selector=>doc.querySelector(selector),reader:()=>reader,icon,requestAnimationFrame:fn=>frames.push(fn),applyToolbarPosition(){}});
  new vm.Script(appSource.slice(appSource.indexOf('function toggleLibrarySidebar('),appSource.indexOf('function bindUI('))).runInContext(context);
  return {doc,toggle:()=>context.toggleLibrarySidebar(),flush(){while(frames.length)frames.shift()();}};
}

test('the library button remains keyboard accessible when its content is folded and restores the same menu',()=>{
  const {doc,toggle,flush}=libraryToggle();const button=doc.querySelector('#desk-nav-toggle'),content=doc.querySelector('#desk-nav-content');
  const menu=content.innerHTML;
  assert.equal(button.type,'button');assert.equal(button.getAttribute('aria-controls'),content.id);
  for(let count=0;count<3;count++){
    toggle();flush();assert.equal(content.hidden,true);assert.equal(button.hidden,false);assert.equal(button.getAttribute('aria-expanded'),'false');
    assert.equal(button.getAttribute('aria-label'),'서재 사이드바 펼치기');
    toggle();flush();assert.equal(content.hidden,false);assert.equal(content.innerHTML,menu);assert.equal(button.getAttribute('aria-expanded'),'true');
  }
});

test('library resize keeps reading position across auto-fit zoom without changing the document fold state',()=>{
  const {r,flush:flushDocument}=sidebarReader();r.installDocumentSidebarToggle();r.toggleDocumentSidebar();flushDocument();
  r.autoFit=true;r.fitZoom=()=>1;const naturalPosition=r.scrollTop/r.zoom;
  const library=libraryToggle(r);library.toggle();library.flush();
  assert.equal(r.zoom,1);assert.equal(r.scrollTop/r.zoom,naturalPosition);
  assert.equal(r.sidebarFolded,true);assert.equal(r.doc.querySelector('.toc').hasAttribute('data-htmlmemo-toc-collapsed'),true);
  r.toggleDocumentSidebar();flushDocument();assert.equal(library.doc.querySelector('#desk-nav-content').hidden,true);
});
