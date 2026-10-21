import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {DOMParser} from 'linkedom';
import {$, $$, icon, escapeHTML} from '../public/src/utils.js';
import {Reader} from '../public/src/reader.js';
import {ANNOTATION_LABELS} from '../public/src/model.js';
import {documentFor,installDOM} from './dom.mjs';
import {textIndex,serializeHTML,parseHTML} from '../public/src/document.js';

const source=await readFile(new URL('../public/src/app.js',import.meta.url),'utf8');
const sidebarCode=source.slice(source.indexOf('function closeSidebar('),source.indexOf('function annotationDialog('));

function sidebar() {
  const doc=new DOMParser().parseFromString('<html><body><aside id="sidebar" hidden></aside></body></html>','text/html');
  const calls={search:[],next:[],headings:[],annotations:[],saved:0},timers=new Map();let timerId=0;
  const r={zoom:2,metadata:{bookmarks:[{id:'b1',title:'읽던 곳',top:240,left:12}],annotations:[{id:'a1',type:'note',color:'#334155',text:'남겨 둔 메모'}]},
    outline:()=>[{node:'heading-1',level:1,title:'첫 번째 절'}],jump:node=>calls.headings.push(node),jumpAnnotation:id=>calls.annotations.push(id),
    search(query){this.searchQuery=query;calls.search.push(query);return query?[{quote:'찾은 문장: '+query}]:[];},nextSearch:direction=>calls.next.push(direction)};
  let current=r;
  const context=vm.createContext({ANNOTATION_LABELS,document:doc,$:(selector,root=doc)=>$(selector,root),$$:(selector,root=doc)=>$$(selector,root),icon,esc:escapeHTML,
    reader:()=>current,active:()=>({queue:{schedule(){calls.saved++;}}}),closePopover(){},toolAction(){},
    getComputedStyle:()=>({getPropertyValue:()=>''}),
    setTimeout(fn){const id=++timerId;timers.set(id,fn);return id;},clearTimeout(id){timers.delete(id);}});
  // All sidebar interactions use the app's real renderer and handlers.
  vm.runInContext('var sidebarMode="";\n'+sidebarCode,context);
  return {doc,r,calls,timers,context,open:mode=>context.renderSidebar(mode),
    choose:mode=>doc.querySelector(`[data-sidebar-view="${mode}"]`).onclick(),
    flush(){for(const [id,fn] of [...timers]){timers.delete(id);fn();}},setReader:reader=>current=reader};
}

test('sidebar switches between outline, search and annotations without changing document data',()=>{
  const a=sidebar(),before=structuredClone(a.r.metadata);a.open('outline');
  assert.equal(a.doc.querySelector('#sidebar').hidden,false);
  assert.deepEqual([...a.doc.querySelectorAll('[data-sidebar-view]')].map(button=>button.textContent),['목차·북마크','문서 검색','주석 목록']);
  a.doc.querySelector('[data-heading]').onclick();assert.deepEqual(a.calls.headings,['heading-1']);
  const button=a.doc.querySelector('[data-sidebar-view=search]');a.choose('search');
  const input=a.doc.querySelector('#document-search');input.value='기억';input.oninput();a.flush();
  assert.equal(a.doc.querySelector('#search-count').textContent,'1개 결과');
  a.doc.querySelector('[data-search-index]').onclick();assert.deepEqual(a.calls.next,[1]);
  a.choose('annotations');a.doc.querySelector('[data-annotation]').onclick();assert.deepEqual(a.calls.annotations,['a1']);
  assert.equal(a.doc.querySelector('[data-sidebar-view=annotations]').getAttribute('aria-pressed'),'true');
  assert.equal(a.doc.querySelectorAll('[data-sidebar-view][aria-pressed=true]').length,1);
  a.choose('outline');a.doc.querySelector('[data-bookmark]').onclick();
  assert.equal(a.r.scrollTop,480);assert.equal(a.r.scrollLeft,24);
  assert.deepEqual(a.r.metadata,before);assert.equal(a.calls.saved,0);
  assert.strictEqual(a.doc.querySelector('[data-sidebar-view=search]'),button);
});

test('sidebar cancels pending searches on view changes, close and document switches while keeping the search draft',()=>{
  const a=sidebar();a.open('search');let input=a.doc.querySelector('#document-search');input.value='빠른 전환';input.oninput();
  a.choose('annotations');a.flush();assert.deepEqual(a.calls.search,[]);
  a.choose('search');assert.equal(a.doc.querySelector('#document-search').value,'빠른 전환');assert.deepEqual(a.calls.search,['빠른 전환']);
  input=a.doc.querySelector('#document-search');input.value='닫기 전 검색';input.oninput();a.context.closeSidebar();a.flush();
  assert.equal(a.doc.querySelector('#sidebar').hidden,true);assert.equal(a.timers.size,0);assert.equal(a.r.searchQuery,'');
  a.open('search');input=a.doc.querySelector('#document-search');input.value='이전 문서';input.oninput();
  a.setReader({});a.flush();assert.equal(a.calls.search.includes('이전 문서'),false);
});

test('annotation list names what each annotation marks, the heading above it and when it was made',()=>{
  installDOM();const a=sidebar();
  const doc=documentFor('<html><head></head><body><main><h1>첫 장</h1><p>머리말입니다.</p><h2>설치하기</h2><p data-htmlmemo-anchor="n7">에이전트를 설치하는 문단입니다.</p><p>강조할 <mark data-htmlmemo-mark data-htmlmemo-id="h1">핵심 문장</mark>이 있습니다.</p></main></body></html>');
  Object.setPrototypeOf(a.r,Reader.prototype);delete a.r.outline;a.r.doc=doc;
  const created=new Date(2026,9,21,23,40).getTime();
  a.r.metadata.annotations=[{id:'p1',type:'pen',color:'#334155',anchor:'n7',anchorTarget:null,points:[{x:0,y:0}],created},
    {id:'h1',type:'highlight',color:'#edcf67',textAnchor:{quote:'핵심 문장',start:0,end:5},created},
    {id:'n1',type:'note',color:'#334155',text:'다시 읽기',textAnchor:{quote:'핵심 문장',start:0,end:5}}];
  a.open('annotations');
  const rows=[...a.doc.querySelectorAll('[data-annotation]')].map(row=>[...row.querySelectorAll('.annotation-text>span')].map(span=>span.textContent));
  const stamp=new Date(created).toLocaleString('ko-KR',{month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});
  assert.deepEqual(rows,[
    ['에이전트를 설치하는 문단입니다.',`펜 그림 · 설치하기 · ${stamp}`],
    ['핵심 문장',`형광펜 · 설치하기 · ${stamp}`],
    ['다시 읽기','“핵심 문장”','메모']]);
});

test('the visible source TOC gets inline choices without moving its tree, listeners or text anchors',()=>{
  installDOM();const a=sidebar();
  const doc=documentFor('<html><head></head><body><nav id="reader-nav"><h2>목차</h2><details open><summary>첫 권</summary><a href="#chapter">본문으로</a></details></nav><main><h1 id="chapter">첫 장</h1><p>원래 본문입니다.</p></main></body></html>');
  const toc=doc.querySelector('nav'),tree=doc.querySelector('details'),text=textIndex(doc).text;let clicks=0;tree.querySelector('summary').onclick=()=>clicks++;
  Object.setPrototypeOf(a.r,Reader.prototype);a.r.doc=doc;a.r.tocResize={sidebar:toc};
  a.r.callbacks={onSidebarView:(mode,panel,documentReader)=>a.context.renderSidebar(mode,{panel,embedded:true,documentReader})};
  a.r.setupDocumentSidebar();const panel=a.r.documentSidebarUI;
  assert.strictEqual(toc.firstElementChild,panel);assert.deepEqual([...panel.querySelectorAll('[data-sidebar-view]')].map(button=>button.textContent),['목차','문서 검색','주석 목록']);
  toc.scrollTop=37;a.r.tocStrip=true;a.r.tocExpandedWidth=260;let expanded=0,synced=0;
  a.r.applyTocWidth=width=>{expanded=width;a.r.tocStrip=false;};a.r.syncAfterTocResize=()=>synced++;
  panel.querySelector('[data-sidebar-view=search]').onclick();assert.equal(expanded,260);assert.equal(synced,1);assert.equal(toc.scrollTop,0);
  assert.equal(toc.getAttribute('data-htmlmemo-sidebar-view'),'search');const input=panel.querySelector('input');input.value='원래';input.oninput();a.flush();
  panel.querySelector('[data-sidebar-view=annotations]').onclick();assert.equal(panel.querySelector('[data-annotation] .annotation-main').textContent,'남겨 둔 메모');assert.equal(panel.querySelector('[data-annotation] .annotation-meta').textContent,'메모');
  panel.querySelector('[data-sidebar-view=outline]').onclick();assert.equal(toc.scrollTop,37);assert.equal(panel.querySelector('.sidebar-content').hidden,true);
  assert.strictEqual(toc.querySelector('details'),tree);tree.querySelector('summary').onclick();assert.equal(clicks,1);assert.equal(tree.hasAttribute('open'),true);
  assert.equal(textIndex(doc).text,text);a.r.setupDocumentSidebar();assert.equal(toc.querySelectorAll('[data-htmlmemo-doc-sidebar-ui]').length,1);
});

test('opening and exporting strip inline panel state while preserving the source TOC and scripts',()=>{
  installDOM();const html='<html><head><style id="htmlmemo-doc-sidebar-style">[data-htmlmemo-sidebar-view=search]>h2{display:none}</style></head><body><nav id="reader-nav" data-htmlmemo-native-sidebar data-htmlmemo-sidebar-view="search"><section data-htmlmemo-doc-sidebar-ui data-htmlmemo-ui><h2>주석 목록</h2><button>문서 검색</button></section><h2>목차</h2><details open><summary>원래 트리</summary><a href="#chapter">첫 장</a></details></nav><main><h1 id="chapter">본문</h1></main><script>window.originalScript=true</script></body></html>';
  const metadata=parseHTML('<html><head></head><body></body></html>').metadata;
  for(const result of [parseHTML(html,{}, {allowScripts:true}).html,serializeHTML(documentFor(html),metadata)]){
    const doc=documentFor(result);assert.equal(doc.querySelector('[data-htmlmemo-doc-sidebar-ui],#htmlmemo-doc-sidebar-style,[data-htmlmemo-native-sidebar],[data-htmlmemo-sidebar-view]'),null);
    assert.equal(doc.querySelector('#reader-nav h2').textContent,'목차');assert.equal(doc.querySelector('#reader-nav details').hasAttribute('open'),true);assert.match(result,/window.originalScript=true/);
  }
});
