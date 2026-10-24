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
  const doc=new DOMParser().parseFromString('<html><body><section id="workspace"></section><aside id="sidebar" hidden></aside></body></html>','text/html');
  const calls={search:[],next:[],headings:[],annotations:[],saved:0},timers=new Map();let timerId=0;
  const r={zoom:2,metadata:{bookmarks:[{id:'b1',title:'읽던 곳',top:240,left:12}],annotations:[{id:'a1',type:'note',color:'#334155',text:'남겨 둔 메모'}]},
    outline:()=>[{node:'heading-1',level:1,title:'첫 번째 절'}],jump:node=>calls.headings.push(node),jumpAnnotation:id=>calls.annotations.push(id),
    search(query){this.searchQuery=query;calls.search.push(query);this.searchResults=query?[{quote:'찾은 문장: '+query}]:[];this.searchPosition=this.searchResults.length?0:-1;return this.searchResults;},nextSearch(direction){calls.next.push(direction);if(this.searchResults?.length)this.searchPosition=Math.max(0,Math.min(this.searchResults.length-1,this.searchPosition+direction));}};
  let current=r;
  const context=vm.createContext({ANNOTATION_LABELS,document:doc,$:(selector,root=doc)=>$(selector,root),$$:(selector,root=doc)=>$$(selector,root),icon,esc:escapeHTML,
    reader:()=>current,active:()=>({queue:{schedule(){calls.saved++;}}}),closePopover(){},toolAction(){},
    getComputedStyle:()=>({getPropertyValue:()=>''}),
    setTimeout(fn){const id=++timerId;timers.set(id,fn);return id;},clearTimeout(id){timers.delete(id);}});
  // All sidebar interactions use the app's real renderer and handlers.
  vm.runInContext('var sidebarMode="",readerFocused=false;\n'+sidebarCode,context);
  return {doc,r,calls,timers,context,open:mode=>context.renderSidebar(mode),
    choose:mode=>doc.querySelector(`[data-sidebar-view="${mode}"]`).onclick(),
    flush(){for(const [id,fn] of [...timers]){timers.delete(id);fn();}},setReader:reader=>current=reader};
}

test('sidebar switches four icon-only views with tooltip labels and total counts without changing document data',()=>{
  const a=sidebar(),before=structuredClone(a.r.metadata);a.open('outline');
  assert.equal(a.doc.querySelector('#sidebar').hidden,false);
  assert.deepEqual([...a.doc.querySelectorAll('[data-sidebar-view]')].map(button=>button.textContent),['','','1','1']);
  assert.deepEqual([...a.doc.querySelectorAll('[data-sidebar-view]')].map(button=>button.getAttribute('aria-label')),['목차','검색','주석 · 전체 1개','북마크 · 전체 1개']);
  assert.equal(a.doc.querySelectorAll('.sidebar-bookmarks,.sidebar-heading').length,0);
  a.doc.querySelector('[data-heading]').onclick();assert.deepEqual(a.calls.headings,['heading-1']);
  const button=a.doc.querySelector('[data-sidebar-view=search]');a.choose('search');
  const input=a.doc.querySelector('#document-search');assert.equal(input.getAttribute('placeholder'),'불러온 부분에서 찾기');assert.equal(input.getAttribute('aria-label'),'불러온 부분 검색어');assert.equal(a.doc.querySelector('#sidebar-title').textContent,'검색');input.value='기억';input.oninput();a.flush();
  assert.equal(a.doc.querySelector('#search-count').textContent,'1 / 1개 결과');
  a.doc.querySelector('[data-search-index]').onclick();assert.deepEqual(a.calls.next,[1]);
  a.choose('annotations');assert.equal(a.doc.querySelector('#sidebar-title').textContent,'주석');a.doc.querySelector('[data-annotation]').onclick();assert.deepEqual(a.calls.annotations,['a1']);
  assert.equal(a.doc.querySelector('[data-sidebar-view=annotations]').getAttribute('aria-pressed'),'true');
  assert.equal(a.doc.querySelectorAll('[data-sidebar-view][aria-pressed=true]').length,1);
  a.choose('bookmarks');a.doc.querySelector('[data-bookmark]').onclick();
  assert.equal(a.r.scrollTop,480);assert.equal(a.r.scrollLeft,24);
  assert.deepEqual(a.r.metadata,before);assert.equal(a.calls.saved,0);
  assert.strictEqual(a.doc.querySelector('[data-sidebar-view=search]'),button);
});

function collapsibleSidebar(){
  installDOM();const a=sidebar(),doc=documentFor('<html><head></head><body><nav id="reader-nav"><h2>목차</h2><div id="reader-tree"><details id="part" open><summary>1부</summary><details id="chapter" open><summary>1.1장</summary><a href="#body">첫 절</a></details></details><details id="other"><summary>2부</summary><a href="#body">다른 절</a></details></div></nav><main><h1 id="body">본문</h1><details id="body-detail" open><summary>본문 설명</summary><p>본문은 그대로 둡니다.</p></details></main></body></html>');
  Object.setPrototypeOf(a.r,Reader.prototype);a.r.doc=doc;a.r.tocResize={sidebar:doc.querySelector('nav')};a.r.callbacks={onSidebarView:(mode,panel,documentReader)=>a.context.renderSidebar(mode,{panel,embedded:true,documentReader})};a.r.setupDocumentSidebar();
  return {...a,doc,tree:doc.querySelector('#reader-tree'),choose:mode=>a.r.documentSidebarUI.querySelector(`[data-sidebar-view="${mode}"]`).onclick()};
}

test('reselecting the active outline collapses every source TOC level but not body or annotation disclosures',()=>{
  const a=collapsibleSidebar(),before=structuredClone(a.r.metadata),tree=a.tree,link=tree.querySelector('a');let clicked=0;link.onclick=()=>clicked++;
  const ui=a.doc.createElement('details');ui.setAttribute('open','');ui.innerHTML='<summary>앱 주석 그룹</summary>';a.r.documentSidebarUI.append(ui);
  a.choose('outline');assert.equal(tree.querySelectorAll('details[open]').length,0);assert.equal(a.doc.querySelector('#body-detail').hasAttribute('open'),true);assert.equal(ui.hasAttribute('open'),true);
  assert.strictEqual(a.doc.querySelector('#reader-tree'),tree);link.onclick();assert.equal(clicked,1);assert.deepEqual(a.r.metadata,before);
  a.choose('outline');assert.equal(tree.querySelectorAll('details[open]').length,0);assert.equal(a.r.documentSidebarMode,'outline');
});

test('returning from search, annotations or bookmarks preserves TOC expansion until outline is clicked again',()=>{
  const a=collapsibleSidebar();
  for(const mode of ['search','annotations','bookmarks']){
    for(const group of a.tree.querySelectorAll('details'))group.setAttribute('open','');a.r.tocResize.sidebar.scrollTop=37;
    a.choose(mode);a.choose('outline');assert.equal(a.tree.querySelectorAll('details[open]').length,3,mode);assert.equal(a.r.tocResize.sidebar.scrollTop,37);
    a.choose('outline');assert.equal(a.tree.querySelectorAll('details[open]').length,0,mode);
  }
});

test('initial setup, automatic render and native sidebar restore never collapse an expanded TOC',()=>{
  const a=collapsibleSidebar();assert.equal(a.tree.querySelectorAll('details[open]').length,2);
  a.r.setupDocumentSidebar();a.r.showDocumentSidebarView('outline');a.r.refreshDocumentSidebar();assert.equal(a.tree.querySelectorAll('details[open]').length,2);
});

test('outline reselection uses the current shared-panel document, not the first renderer closure',()=>{
  const a=sidebar();let first=0,second=0;a.r.collapseDocumentToc=()=>first++;a.open('outline');a.choose('search');a.choose('outline');assert.equal(first,0);a.choose('outline');assert.equal(first,1);
  const other={...a.r,collapseDocumentToc:()=>second++};a.setReader(other);a.open('outline');a.choose('outline');assert.equal(first,1);assert.equal(second,1);
});

test('active outline collapse supports nested custom controlled groups without hiding the sidebar or breaking reopening',()=>{
  const a=collapsibleSidebar(),nav=a.doc.querySelector('nav');a.tree.innerHTML='<div class="toc-group"><button class="toc-toggle" aria-controls="part-items" aria-expanded="true">▼ 1부</button><ul id="part-items"><li><button class="toc-toggle" aria-controls="chapter-items" aria-expanded="true">▼ 1.1장</button><ul id="chapter-items"><li><a href="#body">첫 절</a></li></ul></li></ul></div>';
  const part=a.doc.querySelector('#part-items'),chapter=a.doc.querySelector('#chapter-items'),trigger=a.tree.querySelector('button');a.choose('outline');
  assert.equal(part.hidden,true);assert.equal(chapter.hidden,true);assert.equal(trigger.getAttribute('aria-expanded'),'false');assert.equal(nav.hidden,false);assert.equal(a.r.documentSidebarUI.hidden,false);assert.equal(a.tree.hidden,false);
  a.r.toggleTocSubContainer(trigger,part,true);assert.equal(part.hidden,false);assert.equal(trigger.getAttribute('aria-expanded'),'true');assert.equal(chapter.hidden,true);
});

test('TOC-less HTML automatically exposes search, annotations and bookmarks, including empty totals',()=>{
  const a=sidebar();a.r.doc={};a.r.outline=()=>[];a.r.metadata={annotations:[],bookmarks:[]};const before=structuredClone(a.r.metadata);
  a.context.restoreSidebar();const panel=a.doc.querySelector('#sidebar');assert.equal(panel.hidden,false);assert.equal(panel.sidebarMode,'search');assert.equal(a.doc.querySelector('#workspace').hasAttribute('data-app-sidebar'),true);
  assert.deepEqual([...panel.querySelectorAll('[data-sidebar-view]')].filter(button=>!button.hidden).map(button=>button.dataset.sidebarView),['search','annotations','bookmarks']);
  assert.equal(a.doc.querySelector('#document-search').getAttribute('placeholder'),'불러온 부분에서 찾기');assert.equal(a.doc.querySelector('[data-sidebar-count=annotations]').textContent,'0');assert.equal(a.doc.querySelector('[data-sidebar-count=bookmarks]').textContent,'0');
  a.choose('annotations');assert.match(a.doc.querySelector('.panel-empty').textContent,/아직 주석/);a.choose('bookmarks');assert.match(a.doc.querySelector('.panel-empty').textContent,/저장한 북마크/);assert.ok(a.doc.querySelector('#add-bookmark'));assert.deepEqual(a.r.metadata,before);assert.equal(a.calls.saved,0);
});

test('automatic sidebar restore never focuses a search field or restarts an existing hit',()=>{
  const a=sidebar();a.r.doc={};a.r.outline=()=>[];a.open('search');let input=a.doc.querySelector('#document-search');input.value='기억';input.oninput();a.flush();
  const searchCalls=[...a.calls.search],results=a.r.searchResults,position=a.r.searchPosition;
  a.context.closeSidebar({remember:false,clearSearch:false});const prototype=a.doc.defaultView.HTMLElement.prototype,focus=prototype.focus;let focused=0;prototype.focus=()=>focused++;
  try{a.context.restoreSidebar();}finally{prototype.focus=focus;}
  input=a.doc.querySelector('#document-search');assert.equal(input.value,'기억');assert.equal(focused,0);assert.deepEqual(a.calls.search,searchCalls);assert.strictEqual(a.r.searchResults,results);assert.equal(a.r.searchPosition,position);assert.equal(a.doc.querySelector('#search-count').textContent,'1 / 1개 결과');
});

test('explicit close remains closed on tab return, and manual reopen restores the selected view',()=>{
  const a=sidebar();a.r.doc={};a.r.outline=()=>[];a.open('bookmarks');a.doc.querySelector('#close-sidebar').onclick();assert.equal(a.r.appSidebarClosed,true);assert.equal(a.doc.querySelector('#workspace').hasAttribute('data-app-sidebar'),false);
  a.context.restoreSidebar();assert.equal(a.doc.querySelector('#sidebar').hidden,true);assert.equal(a.r.appSidebarMode,'bookmarks');a.open(a.r.appSidebarMode);assert.equal(a.doc.querySelector('#sidebar').hidden,false);assert.equal(a.r.appSidebarClosed,false);
  a.context.closeSidebar({remember:false,clearSearch:false});a.context.restoreSidebar();assert.equal(a.doc.querySelector('#sidebar').sidebarMode,'bookmarks');
});

test('shared sidebar hides or restores only the available outline when switching documents',()=>{
  const a=sidebar();a.r.doc={};a.r.outline=()=>[];a.open('outline');assert.equal(a.doc.querySelector('#sidebar').sidebarMode,'search');assert.equal(a.doc.querySelector('[data-sidebar-view=outline]').hidden,true);
  const other={...a.r,outline:()=>[{node:'new-heading',level:1,title:'새 제목'}],metadata:{annotations:[],bookmarks:[]}};a.setReader(other);a.open('outline');assert.equal(a.doc.querySelector('[data-sidebar-view=outline]').hidden,false);assert.equal(a.doc.querySelector('#sidebar-title').textContent,'목차');assert.equal(a.doc.querySelector('[data-sidebar-count=annotations]').textContent,'0');
  a.setReader(a.r);a.context.restoreSidebar();assert.equal(a.doc.querySelector('[data-sidebar-view=outline]').hidden,true);assert.equal(a.doc.querySelector('[data-sidebar-count=annotations]').textContent,'1');
});

test('native TOC, preparing/disposed documents and fullscreen never gain a duplicate automatic sidebar',()=>{
  for(const state of [{preparing:true},{disposed:true},{documentSidebarUI:{isConnected:true}}]){const a=sidebar();Object.assign(a.r,{doc:{}},state);a.context.restoreSidebar();assert.equal(a.doc.querySelector('#sidebar').hidden,true);}
  const a=sidebar();a.r.doc={};a.context.readerFocused=true;a.context.restoreSidebar();assert.equal(a.doc.querySelector('#sidebar').hidden,true);
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

test('loaded-part search disables its first/last arrows, updates the position and flushes a pending query before keyboard navigation',()=>{
  const a=sidebar();a.r.search=function(query){this.searchQuery=query;this.searchResults=query==='여러 개'?[{quote:'첫째'},{quote:'둘째'},{quote:'셋째'}]:query==='하나'?[{quote:'하나'}]:[];this.searchPosition=this.searchResults.length?0:-1;return this.searchResults;};
  a.open('search');const input=a.doc.querySelector('#document-search'),prev=a.doc.querySelector('#search-prev'),next=a.doc.querySelector('#search-next'),count=a.doc.querySelector('#search-count');
  assert.equal(prev.disabled,true);assert.equal(next.disabled,true);
  input.value='여러 개';input.oninput();a.flush();assert.equal(count.textContent,'1 / 3개 결과');assert.equal(prev.disabled,true);assert.equal(next.disabled,false);
  prev.onclick();assert.equal(count.textContent,'1 / 3개 결과');next.onclick();assert.equal(count.textContent,'2 / 3개 결과');assert.equal(prev.disabled,false);next.onclick();assert.equal(count.textContent,'3 / 3개 결과');assert.equal(next.disabled,true);
  input.onkeydown({key:'Enter',preventDefault(){}});assert.equal(count.textContent,'3 / 3개 결과');prev.onclick();assert.equal(count.textContent,'2 / 3개 결과');
  a.doc.querySelector('[data-search-index="0"]').onclick();assert.equal(count.textContent,'1 / 3개 결과');assert.equal(prev.disabled,true);assert.equal(next.disabled,false);
  input.onkeydown({key:'Enter',shiftKey:true,preventDefault(){}});assert.equal(count.textContent,'1 / 3개 결과');
  input.value='하나';input.oninput();input.onkeydown({key:'Enter',preventDefault(){}});a.flush();assert.equal(count.textContent,'1 / 1개 결과');assert.equal(prev.disabled,true);assert.equal(next.disabled,true);
  a.r.searchPosition=-1;a.context.updateSearchNavigation(a.r);assert.equal(prev.disabled,true);assert.equal(next.disabled,true);
  input.value='없음';input.oninput();a.flush();assert.equal(count.textContent,'검색 결과가 없습니다.');assert.equal(prev.disabled,true);assert.equal(next.disabled,true);
  input.value='';input.oninput();a.flush();assert.equal(count.textContent,'검색어를 입력하세요.');assert.equal(prev.disabled,true);assert.equal(next.disabled,true);
});

test('reader loaded-part search stops at both ends without replacing the active mark or scrolling again',()=>{
  installDOM();const doc=documentFor('<html><body><main><p>첫 키워드, 둘째 키워드, 셋째 키워드.</p></main></body></html>');let rangeCalls=0;const states=[];
  doc.createRange=()=>{rangeCalls++;return {setStart(){},setEnd(){},getBoundingClientRect:()=>({left:20,top:300,width:30,height:10})};};
  const r=Object.create(Reader.prototype);r.doc=doc;r.viewport={clientHeight:200,clientWidth:200};r.zoom=1;r.layerOrigin=()=>({left:0,top:0});r.metadata={annotations:[],bookmarks:[]};r.callbacks={onSearchChange:reader=>states.push(reader.searchPosition)};
  const before=structuredClone(r.metadata);assert.equal(r.search('키워드').length,3);assert.equal(r.searchPosition,0);const first=doc.querySelector('[data-htmlmemo-search]'),top=r.scrollTop;
  assert.equal(r.nextSearch(-1),false);assert.strictEqual(doc.querySelector('[data-htmlmemo-search]'),first);assert.equal(r.scrollTop,top);assert.equal(rangeCalls,1);
  assert.equal(r.nextSearch(1),true);assert.equal(r.searchPosition,1);assert.equal(r.nextSearch(1),true);assert.equal(r.searchPosition,2);const last=doc.querySelector('[data-htmlmemo-search]');assert.equal(r.nextSearch(1),false);assert.strictEqual(doc.querySelector('[data-htmlmemo-search]'),last);assert.equal(rangeCalls,3);
  r.nextSearch(-1);r.nextSearch(-1);assert.equal(r.searchPosition,0);assert.equal(r.nextSearch(-1),false);assert.deepEqual(states,[0,1,2,1,0]);assert.deepEqual(r.metadata,before);
  r.search('키워드',false);assert.equal(r.searchPosition,-1);r.nextSearch(-1);assert.equal(r.searchPosition,0,'an unselected search never jumps backwards to its last result');
  r.search('없음');assert.equal(r.nextSearch(1),false);assert.equal(r.searchPosition,-1);r.search('');assert.equal(doc.querySelector('[data-htmlmemo-search]'),null);
});

test('asynchronous sidebar search cannot overwrite another view or a newer query and reports failures',async()=>{
  const a=sidebar(),pending=[],errors=[];a.r.callbacks={onError:error=>errors.push(error.message)};
  a.r.searchAsync=(query,move,current)=>new Promise((resolve,reject)=>pending.push({query,current,resolve,reject}));a.open('search');
  let input=a.doc.querySelector('#document-search');input.value='old';input.oninput();a.flush();assert.equal(a.doc.querySelector('#search-count').textContent,'검색 준비 중…');
  a.choose('annotations');assert.equal(pending[0].current(),false);pending[0].resolve([{quote:'stale'}]);await Promise.resolve();assert.ok(a.doc.querySelector('[data-annotation]'));
  a.choose('search');input=a.doc.querySelector('#document-search');const resumed=pending.at(-1);input.value='new';input.oninput();a.flush();assert.equal(resumed.current(),false);resumed.resolve([{quote:'stale draft'}]);await Promise.resolve();assert.equal(a.doc.querySelector('[data-search-index]'),null);
  pending.at(-1).reject(new Error('index failed'));await Promise.resolve();await Promise.resolve();assert.match(a.doc.querySelector('#search-count').textContent,/검색을 준비하지 못했습니다/);assert.deepEqual(errors,['index failed']);
});

test('icon totals include all annotations and bookmarks, update in place and show zero',()=>{
  const a=sidebar();a.open('search');const input=a.doc.querySelector('#document-search'),button=a.doc.querySelector('[data-sidebar-view=annotations]');
  a.r.metadata.annotations.push({id:'unloaded',type:'note',anchorTarget:{section:'not-loaded'}});a.r.metadata.bookmarks=[];
  a.context.updateSidebarCounts(a.doc.querySelector('#sidebar'),a.r);
  assert.equal(button.textContent,'2');assert.equal(button.getAttribute('title'),'주석 · 전체 2개');
  assert.equal(a.doc.querySelector('[data-sidebar-view=bookmarks]').textContent,'0');assert.strictEqual(a.doc.querySelector('#document-search'),input);
  assert.equal(button.firstElementChild.localName,'svg');assert.equal(button.lastElementChild.getAttribute('data-sidebar-count'),'annotations');
  a.r.metadata.annotations=[];a.context.updateSidebarCounts(a.doc.querySelector('#sidebar'),a.r);assert.equal(button.textContent,'0');
});

test('native search fields share loaded-part metrics and equal top/between spacing without a separator',async()=>{
  const css=await readFile(new URL('../public/design.tailwind.css',import.meta.url),'utf8');
  const shared=css.match(/\[data-htmlmemo-doc-sidebar-ui\] \.sidebar-book-search input,\[data-htmlmemo-doc-sidebar-ui\] \.search-field input\{([^}]+)\}/)?.[1];
  assert.ok(shared,'both search inputs must use one rule');
  for(const declaration of ['display:block!important','width:100%!important','height:auto!important','margin:0!important','padding:8px!important','font:400 12px/1.6 var(--app-font)!important'])assert.ok(shared.includes(declaration),declaration);
  assert.match(css,/\.sidebar-content\{--sidebar-search-gap:10px;padding:var\(--sidebar-search-gap\) 2px;/);
  assert.match(css,/\.sidebar-book-search\{display:flow-root;margin:0 0 var\(--sidebar-search-gap\);padding:0;border:0\}/);
  assert.match(css,/\.sidebar-book-search>\[data-htmlmemo-book-search-part\]:not\(input\)\{margin:0!important;padding:0!important;border:0!important\}/);
});

test('both sidebar icon rows are 25px high with 24px buttons and no top inset',async()=>{
  const css=await readFile(new URL('../public/design.tailwind.css',import.meta.url),'utf8');
  const row=css.match(/^\.sidebar-views\{([^}]+)\}/m)?.[1],nativeRow=css.match(/^\[data-htmlmemo-doc-sidebar-ui\] \.sidebar-views\{([^}]+)\}/m)?.[1];
  for(const rules of [row,nativeRow])for(const declaration of ['box-sizing:border-box','height:25px','min-height:25px','margin:0','padding:0 '])assert.ok(rules?.includes(declaration),declaration);
  const button=css.match(/^\.sidebar-views button\{([^}]+)\}/m)?.[1],nativeButton=css.match(/^\[data-htmlmemo-doc-sidebar-ui\] \.sidebar-views button\{([^}]+)\}/m)?.[1];
  for(const rules of [button,nativeButton])for(const declaration of ['height:24px','min-height:24px','max-height:24px','padding:0 ','line-height:1'])assert.ok(rules?.includes(declaration),declaration);
  assert.match(css,/^\[data-htmlmemo-native-sidebar\]\{padding-top:0!important\}/m);
  assert.match(css,/^\[data-htmlmemo-doc-sidebar-ui\]\{[^}]*margin:0!important;padding:0!important/m);
});

test('native whole-book search keeps its nodes, listeners and query above loaded-part search across all views and export',()=>{
  installDOM();const a=sidebar(),doc=documentFor('<html><head></head><body><nav id="reader-nav"><h2>목차</h2><form id="whole-book-search"><input id="whole-query" placeholder="책 전체 검색"><button id="whole-clear" type="button">지우기</button><div id="whole-results"></div></form><div id="reader-tree"><details><summary>원래 목차</summary></details></div></nav><main><h1>본문</h1><p>검색할 내용</p></main></body></html>');
  const nav=doc.querySelector('nav'),form=doc.querySelector('form'),query=doc.querySelector('#whole-query'),clear=doc.querySelector('#whole-clear'),tree=doc.querySelector('#reader-tree'),text=textIndex(doc).text;
  let searched=0,cleared=0;query.addEventListener('input',()=>searched++);nav.addEventListener('click',event=>{if(event.target===clear)cleared++;});
  Object.setPrototypeOf(a.r,Reader.prototype);a.r.doc=doc;a.r.tocResize={sidebar:nav};
  a.r.callbacks={onSidebarView:(mode,panel,documentReader)=>a.context.renderSidebar(mode,{panel,embedded:true,documentReader}),onSidebarCounts:(panel,r)=>a.context.updateSidebarCounts(panel,r)};
  a.r.setupDocumentSidebar();const host=a.r.documentBookSearchHost;assert.equal(host.hidden,true);assert.equal(host.isConnected,true);
  a.r.showDocumentSidebarView('search');assert.strictEqual(a.r.documentSidebarUI.querySelector('.sidebar-content').firstElementChild,host);assert.strictEqual(host.querySelector('form'),form);assert.equal(host.hidden,false);
  assert.ok(host.nextElementSibling.contains(doc.querySelector('#htmlmemo-native-document-search')));
  query.value='아직 열지 않은 장';query.dispatchEvent(new doc.defaultView.Event('input',{bubbles:true}));clear.dispatchEvent(new doc.defaultView.Event('click',{bubbles:true}));assert.equal(searched,1);assert.equal(cleared,1);
  for(const view of ['bookmarks','annotations','outline']){a.r.showDocumentSidebarView(view);assert.equal(host.hidden,true);assert.equal(host.isConnected,true);assert.strictEqual(nav.querySelector('#reader-tree'),tree);}
  a.r.showDocumentSidebarView('search');assert.strictEqual(doc.querySelector('#whole-query'),query);assert.equal(query.value,'아직 열지 않은 장');assert.equal(host.hidden,false);
  a.r.metadata.annotations=[];a.r.refreshDocumentSidebar();assert.equal(a.r.documentSidebarUI.querySelector('[data-sidebar-count=annotations]').textContent,'0');assert.strictEqual(doc.querySelector('#whole-query'),query);assert.equal(query.value,'아직 열지 않은 장');assert.equal(textIndex(doc).text,text);
  assert.deepEqual(Reader.prototype.search.call(a.r,'지우기',false),[],'hidden source-offset placeholders are not loaded-part search results');
  const exported=documentFor(serializeHTML(doc,a.r.metadata));assert.equal(exported.querySelector('nav>form').id,'whole-book-search');assert.equal(exported.querySelector('form').nextElementSibling.id,'reader-tree');assert.equal(exported.querySelector('[data-htmlmemo-book-search-part],[data-htmlmemo-book-search-slot],[data-htmlmemo-doc-sidebar-ui]'),null);
});

test('adjacent native search results return to their source slots when opening an editor-marked HTML',()=>{
  installDOM();const a=sidebar(),doc=documentFor('<html><head></head><body><nav><input id="q" placeholder="책 전체 검색"><div id="book-search-results">결과</div><div id="reader-tree">목차</div></nav><main><h1>본문</h1></main></body></html>');
  Object.setPrototypeOf(a.r,Reader.prototype);a.r.doc=doc;a.r.tocResize={sidebar:doc.querySelector('nav')};a.r.callbacks={onSidebarView:(mode,panel,documentReader)=>a.context.renderSidebar(mode,{panel,embedded:true,documentReader})};a.r.setupDocumentSidebar();a.r.showDocumentSidebarView('search');
  assert.equal(a.r.documentBookSearchHost.querySelectorAll('[data-htmlmemo-book-search-part]').length,2);
  const parsed=documentFor(parseHTML('<!doctype html>'+doc.documentElement.outerHTML).html);
  assert.deepEqual([...parsed.querySelector('nav').children].map(node=>node.id),['q','book-search-results','reader-tree']);assert.equal(parsed.querySelector('[data-htmlmemo-book-search-slot],[data-htmlmemo-book-search-part],[data-htmlmemo-doc-sidebar-ui]'),null);
});

function searchableBook(){
  installDOM();const a=sidebar(),manifest={format:'memosuite-book-html-v1',volumes:[{label:'입문',sections:[{key:'v0:first',title:'첫 장'},{key:'v0:next',title:'다음 장'}]}]};
  const doc=documentFor(`<html><head><script id="book-manifest" type="application/json">${JSON.stringify(manifest)}</script></head><body><nav id="reader-nav"><h2>목차</h2><input id="q" placeholder="책 전체 검색"><div id="search-status"></div><div id="reader-tree"><details><summary>입문</summary><a href="#v0%3Afirst">첫 장</a><a href="#v0%3Anext">다음 장</a></details></div></nav><main><article id="reader-content" data-section="v0:first"><p>앞의 <em>기</em>억과 뒤의 기억, 마침표 . 하나입니다.</p></article></main></body></html>`);
  const payload=doc.createElement('script');payload.id='book-volume-0';payload.type='application/octet-stream';payload.textContent='["시험 본문"]';doc.head.append(payload);
  const runtime=doc.createElement('script');runtime.textContent='window.testBook=true;';doc.head.append(runtime);
  Object.setPrototypeOf(a.r,Reader.prototype);a.r.doc=doc;a.r.tocResize={sidebar:doc.querySelector('nav')};
  a.r.callbacks={onSidebarView:(mode,panel,documentReader)=>a.context.renderSidebar(mode,{panel,embedded:true,documentReader})};a.r.setupDocumentSidebar();
  const input=doc.querySelector('#q'),tree=doc.querySelector('#reader-tree');
  const query=value=>{input.value=value;input.dispatchEvent(new doc.defaultView.Event('input',{bubbles:true}));};
  return {...a,doc,input,tree,query};
}

test('whole-book search restores pre-search expansion and only a second outline click collapses it',()=>{
  const {r,doc,tree,query}=searchableBook(),group=tree.querySelector('details');group.setAttribute('open','');r.showDocumentSidebarView('search');query('기억');
  const choose=()=>r.documentSidebarUI.querySelector('[data-sidebar-view=outline]').onclick();choose();assert.equal(group.hasAttribute('open'),true);assert.equal(tree.parentElement.id,'reader-nav');
  choose();assert.equal(group.hasAttribute('open'),false);r.showDocumentSidebarView('search');assert.equal(group.hasAttribute('open'),true);choose();assert.equal(group.hasAttribute('open'),false);
  assert.equal(doc.querySelector('#q').value,'기억');r.documentBookSearchObserver.disconnect();
});

test('whole-book search exposes its live filtered result tree, preserves offsets and returns it to the outline and export',()=>{
  const {r,doc,tree,query}=searchableBook(),originalText=textIndex(doc).text,group=tree.querySelector('details');let nativeClicks=0;
  tree.addEventListener('click',()=>nativeClicks++);
  r.showDocumentSidebarView('search');assert.equal(tree.parentElement.id,'reader-nav');
  query('기억');assert.ok(r.documentBookSearchResults.contains(tree));assert.equal(r.documentBookSearchResults.hidden,false);assert.equal(group.hasAttribute('open'),true);assert.equal(textIndex(doc).text,originalText);
  tree.querySelector('summary').dispatchEvent(new doc.defaultView.Event('click',{bubbles:true}));assert.equal(nativeClicks,1);
  assert.equal(r.documentBookSearchSection(tree.querySelector('a')),'v0:first');assert.equal(r.documentBookSearchSection(doc.createElement('a')),'');
  const serialized=serializeHTML(doc,r.metadata),exported=documentFor(serialized);
  assert.equal(exported.querySelector('#reader-tree').parentElement.id,'reader-nav');assert.equal(exported.querySelector('#reader-tree details').hasAttribute('open'),false);assert.equal(exported.querySelector('[data-htmlmemo-book-search-part],[data-htmlmemo-book-search-slot],[data-htmlmemo-book-search-open],.sidebar-book-results'),null);
  r.showDocumentSidebarView('outline');assert.strictEqual(doc.querySelector('#reader-tree'),tree);assert.equal(tree.parentElement.id,'reader-nav');assert.equal(group.hasAttribute('open'),false);assert.equal(r.documentBookSearchResults.hidden,true);
  r.showDocumentSidebarView('search');assert.ok(r.documentBookSearchResults.contains(tree));query('');assert.equal(tree.parentElement.id,'reader-nav');assert.equal(r.documentBookSearchResults.hidden,true);assert.equal(textIndex(doc).text,originalText);
  r.documentBookSearchObserver.disconnect();
});

test('whole-book keyword navigation scopes matches to the loaded body, supports inline text and literal punctuation and wraps both ways',()=>{
  const {r,doc,query}=searchableBook(),highlights=new Map(),ranges=[];
  Object.defineProperty(doc,'defaultView',{value:{CSS:{highlights},Highlight:class{constructor(range){this.range=range;}}}});
  doc.createRange=()=>{const range={setStart(node,offset){this.startContainer=node;this.startOffset=offset;},setEnd(node,offset){this.endContainer=node;this.endOffset=offset;},getBoundingClientRect:()=>({left:20,top:300,width:30,height:10})};ranges.push(range);return range;};
  r.viewport={clientHeight:200,clientWidth:200};r.layerOrigin=()=>({left:0,top:10});r.sidebarSearchQuery='별도 검색';
  r.showDocumentSidebarView('search');r.documentBookSearchInput.value='기억';r.syncDocumentBookSearchResults();
  r.bookSearchHit={section:'v0:first',query:'기억',position:0};const before=structuredClone(r.metadata);
  assert.equal(r.stepDocumentBookSearch(),true);assert.equal(r.documentBookSearchStatus.textContent,'이 장에서 1 / 2');assert.equal(r.viewport.scrollTop,490);
  const first=highlights.get('htmlmemo-book-search').range;assert.equal(first.startContainer.parentElement.localName,'em');assert.equal(first.startOffset,0);assert.equal(first.endOffset,1);
  r.stepDocumentBookSearch(1);assert.equal(r.documentBookSearchStatus.textContent,'이 장에서 2 / 2');r.stepDocumentBookSearch(1);assert.equal(r.documentBookSearchStatus.textContent,'이 장에서 1 / 2');r.stepDocumentBookSearch(-1);assert.equal(r.documentBookSearchStatus.textContent,'이 장에서 2 / 2');
  r.documentBookSearchInput.value='.';r.syncDocumentBookSearchResults();r.bookSearchHit={section:'v0:first',query:'.',position:0};assert.equal(r.stepDocumentBookSearch(),true);assert.equal(r.documentBookSearchStatus.textContent,'이 장에서 1 / 2');
  r.documentBookSearchInput.value='없는 검색어';r.syncDocumentBookSearchResults();r.bookSearchHit={section:'v0:first',query:'없는 검색어',position:0};assert.equal(r.stepDocumentBookSearch(),false);assert.match(r.documentBookSearchStatus.textContent,/본문에서 검색어를 찾지 못했습니다/);assert.equal(highlights.size,0);
  assert.equal(r.sidebarSearchQuery,'별도 검색');assert.deepEqual(r.metadata,before);assert.equal(ranges.length,5);
  r.documentBookSearchObserver.disconnect();
});

test('whole-book result navigation waits for only the selected section and does not read unopened payloads',async()=>{
  const {r,doc,query}=searchableBook();query('기억');r.showDocumentSidebarView('search');let callback,hash,highlighted,refreshed=0;
  Object.defineProperty(doc.getElementById('book-volume-0'),'textContent',{get(){throw Error('Unopened book decoded');}});
  Object.defineProperty(doc,'defaultView',{value:{MutationObserver:class{constructor(fn){callback=fn;}observe(){}disconnect(){}},location:{set hash(value){hash=value;doc.getElementById('reader-content').dataset.section=decodeURIComponent(value);queueMicrotask(callback);}}}});
  r.refreshDynamicDocument=async()=>refreshed++;r.render=()=>{};r.measure=()=>{};r.stepDocumentBookSearch=()=>{highlighted={...r.bookSearchHit};return true;};
  const before=structuredClone(r.metadata);assert.equal(await r.jumpDocumentBookSearch('v0:next','기억'),true);assert.equal(hash,'v0%3Anext');assert.equal(refreshed,1);assert.deepEqual(highlighted,{section:'v0:next',query:'기억',position:0});assert.deepEqual(r.metadata,before);
  assert.equal(await r.jumpDocumentBookSearch('not-in-the-book','기억'),false);r.documentBookSearchObserver.disconnect();
});

test('clearing or leaving whole-book search cancels pending navigation and a timeout reports an error without changing notes',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const {r,doc,query}=searchableBook(),errors=[];query('기억');r.showDocumentSidebarView('search');
  Object.defineProperty(doc,'defaultView',{value:{MutationObserver:class{observe(){}disconnect(){}},location:{hash:''}}});r.callbacks.onError=error=>errors.push(error.message);
  const before=structuredClone(r.metadata),cancelled=r.jumpDocumentBookSearch('v0:next','기억');r.documentBookSearchInput.value='';r.syncDocumentBookSearchResults();assert.equal(await cancelled,false);assert.deepEqual(errors,[]);
  r.documentBookSearchInput.value='기억';r.syncDocumentBookSearchResults();const leaving=r.jumpDocumentBookSearch('v0:next','기억');r.showDocumentSidebarView('outline');assert.equal(await leaving,false);assert.deepEqual(errors,[]);
  r.showDocumentSidebarView('search');const timedOut=r.jumpDocumentBookSearch('v0:next','기억');t.mock.timers.tick(15000);assert.equal(await timedOut,false);assert.match(errors[0],/불러오지 못했습니다/);assert.equal(r.documentBookSearchStatus.textContent,errors[0]);assert.deepEqual(r.metadata,before);r.documentBookSearchObserver.disconnect();
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
  const rows=['p1','h1','n1'].map(id=>[...a.doc.querySelector(`[data-annotation="${id}"]`).querySelectorAll('.annotation-text>span')].map(span=>span.textContent));
  const stamp=new Date(created).toLocaleString('ko-KR',{month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});
  assert.deepEqual(rows,[
    ['에이전트를 설치하는 문단입니다.',`펜 그림 · 설치하기 · ${stamp}`],
    ['핵심 문장',`형광펜 · 설치하기 · ${stamp}`],
    ['다시 읽기','“핵심 문장”','메모']]);
});

test('annotation tree follows complete volume/category/section order and omits every empty branch',()=>{
  installDOM();const a=sidebar();
  const volumes=[{label:'입문',sections:[{key:'v0:empty',title:'주석 없는 장',category:'빈 분류'},{key:'v0:one',title:'첫 장',category:'기초 › 시작'},{key:'v0:two',title:'둘째 장',category:'기초 › 다음'}]},
    {label:'실전',sections:[{key:'v1:one',title:'첫 장',category:'기초 › 시작'}]},{label:'빈 책',sections:[{key:'v2:none',title:'빈 장'}]}];
  const doc=documentFor(`<html><head><script id="book-manifest" type="application/json">${JSON.stringify({format:'memosuite-book-html-v1',volumes})}</script></head><body><main><article id="reader-content" data-section="v0:one"><h1>첫 장</h1></article></main></body></html>`);
  // A list must never read compressed bodies or force unopened source TOC groups open.
  const payload=doc.createElement('script');payload.id='book-volume-0';Object.defineProperty(payload,'textContent',{get(){throw Error('Book body read');}});doc.body.append(payload);
  Object.setPrototypeOf(a.r,Reader.prototype);a.r.doc=doc;a.r.metadata.annotations=[
    {id:'later',type:'pen',anchorTarget:{section:'v1:one',quote:'실전의 문장'}},
    {id:'second',type:'highlight',textAnchor:{section:'v0:two',quote:'둘째 장 문장'}},
    {id:'first',type:'note',text:'첫 장 메모',anchorTarget:{section:'v0:one',quote:'첫 장 문장'}},
    {id:'first-again',type:'underline',textAnchor:{section:'v0:one',quote:'또 다른 문장'}}];
  const before=structuredClone(a.r.metadata),tree=a.r.annotationTree(new Map());
  assert.deepEqual(tree.map(g=>[g.title,g.count]),[['입문',3],['실전',1]]);
  assert.deepEqual(tree[0].children.map(g=>[g.title,g.count]),[['기초',3]]);
  assert.deepEqual(tree[0].children[0].children.map(g=>g.title),['시작','다음']);
  assert.deepEqual(tree[0].children[0].children[0].children[0].annotations.map(g=>g.id),['first','first-again']);
  assert.equal(tree[1].children[0].children[0].children[0].title,'첫 장','same titles in different volumes stay separate');
  assert.equal(JSON.stringify(tree).includes('주석 없는 장'),false);assert.equal(JSON.stringify(tree).includes('빈 분류'),false);
  a.r.metadata.annotations.push({id:'orphan',textAnchor:{section:'deleted',quote:'옛 문장'}});
  assert.equal(a.r.annotationTree(new Map()).at(-1).title,'목차 위치 미확인');
  a.r.metadata.annotations.pop();assert.deepEqual(a.r.metadata,before);
});

test('ordinary HTML annotation tree keeps nested headings in document order and prunes empty headings',()=>{
  installDOM();const doc=documentFor('<html><body><nav><h2>목차</h2></nav><main><h1>첫 장</h1><h2>동일 이름</h2><p data-htmlmemo-anchor="n1">첫 내용</p><h3>빈 절</h3><h1>둘째 장</h1><h2>동일 이름</h2><p data-htmlmemo-anchor="n2">다음 내용</p><h1>주석 없는 장</h1></main></body></html>');
  const r=Object.create(Reader.prototype);r.doc=doc;r.metadata={annotations:[{id:'two',type:'pen',anchor:'n2'},{id:'one',type:'pen',anchor:'n1'}]};
  const tree=r.annotationTree();assert.deepEqual(tree.map(g=>g.title),['첫 장','둘째 장']);
  assert.equal(tree[0].children[0].title,'동일 이름');assert.equal(tree[1].children[0].title,'동일 이름');assert.notEqual(tree[0].children[0].id,tree[1].children[0].id);
  assert.deepEqual(tree[0].children[0].annotations.map(g=>g.id),['one']);assert.deepEqual(tree[1].children[0].annotations.map(g=>g.id),['two']);
  assert.equal(JSON.stringify(tree).includes('빈 절'),false);assert.equal(JSON.stringify(tree).includes('주석 없는 장'),false);
});

function partialBook(){
  const manifest={format:'memosuite-book-html-v1',volumes:[{label:'입문',sections:[
    {key:'v0:opening',id:'opening',title:'1부 시작',category:'1부 · 준비'},
    {key:'v0:one',id:'one',title:'(1.1) 첫 장',category:'1부 · 준비 › 첫걸음'},
    {key:'v0:two',id:'two',title:'(1.2) 다음 장',category:'1부 · 준비 › 첫걸음'},
    {key:'v0:part2',id:'part2',title:'2부 시작',category:'2부 · 진행'}]},
    {label:'실전',sections:[{key:'v1:opening',id:'opening',title:'실전 시작',category:'1부 · 활용'}]}]};
  const doc=documentFor(`<html><head><script id="book-manifest" type="application/json">${JSON.stringify(manifest)}</script></head><body data-htmlmemo-anchor="body"><article id="reader-content" data-section="v0:opening"><h1>1부 시작</h1><p>첫머리 공통 문장입니다.</p></article></body></html>`);
  const r=Object.create(Reader.prototype);r.doc=doc;r.initialBookSection='v0:opening';r.metadata={annotations:[]};return {r,doc,manifest};
}
test('legacy opening annotations use the introductory first-part branch and stay there after navigation',()=>{
  const {r,doc}=partialBook();
  const old={id:'old',type:'note',text:'예전 메모',points:[{x:20,y:40}],color:'#334155',width:3,opacity:1};
  const exact={id:'exact',type:'note',anchorTarget:{section:'v0:two'}};
  r.metadata.annotations=[old,exact];const before=structuredClone(r.metadata);
  const location=r.annotationLocation(old);assert.deepEqual(location.path.map(p=>p.title),['입문','1부 · 준비','1부 앞부분']);assert.equal(location.startSection,'v0:opening');assert.equal(location.approximate,true);
  assert.equal(r.annotationLocation(exact).section,'v0:two');assert.equal(r.annotationInSection(old),true);
  doc.getElementById('reader-content').dataset.section='v0:one';
  assert.equal(r.annotationInSection(old),false);assert.deepEqual(r.drawingGeometry(old).points,[]);assert.strictEqual(r.annotationLocation(old),location);
  const tree=r.annotationTree(new Map());assert.equal(tree[0].children[0].children[0].title,'1부 앞부분');assert.equal(tree[0].count,2);assert.deepEqual(r.metadata,before);
});
test('partial book locations retain the deepest known volume/part and prefer recoverable exact IDs and headings',()=>{
  const {r}=partialBook();
  const partial=r.annotationLocation({id:'partial',anchorTarget:{section:'v1:removed'}});
  assert.deepEqual(partial.path.map(p=>p.title),['실전','1부 · 활용','세부 위치 미확인']);assert.equal(partial.startSection,'v1:opening');
  const volume=r.annotationLocation({id:'volume',textAnchor:{section:'v0:removed'}});assert.deepEqual(volume.path.map(p=>p.title),['입문','세부 위치 미확인']);
  assert.equal(r.annotationLocation({id:'id',textAnchor:{section:'two'}}).section,'v0:two');
  assert.equal(r.annotationLocation({id:'fragment',textAnchor:{section:'v0:two/heading'}}).section,'v0:two');
  assert.equal(r.annotationLocation({id:'heading',anchorTarget:{tag:'h1',quote:'(1.2) 다음 장'}}).section,'v0:two');
  assert.equal(r.annotationLocation({id:'ambiguous',textAnchor:{section:'opening'}}),null,'the same ID in two books is not guessed');
  assert.equal(r.annotationLocation({id:'conflict',anchorTarget:{tag:'h1',quote:'(9.9) 다른 곳'}}),null,'a conflicting numbered heading is not assigned to the opening');
});
test('the introduction opening fallback is not a global rename for other books or an initially different chapter',()=>{
  const {r,doc,manifest}=partialBook();r.initialBookSection='v0:one';assert.equal(r.annotationLocation({id:'different'}),null);
  manifest.volumes[0].label='다른 책';doc.getElementById('book-manifest').textContent=JSON.stringify(manifest);r.initialBookSection='v0:opening';assert.equal(r.annotationLocation({id:'other'}),null);
  manifest.volumes[0].label='입문';manifest.volumes[0].sections[1].title='번호 없는 장';doc.getElementById('book-manifest').textContent=JSON.stringify(manifest);assert.equal(r.annotationLocation({id:'no-interval'}),null);
});
test('opening text marks are not repeated on later chapters, and approximate jumps report their precision without changing metadata',async()=>{
  const {r,doc}=partialBook(),quote='첫머리 공통 문장입니다.';
  r.metadata.annotations=[{id:'old-mark',type:'highlight',color:'#edcf67',width:3,opacity:.35,textAnchor:{start:0,end:quote.length,quote}}];
  r.renderDrawingLayer=()=>{};r.observeDynamicDocument=()=>{};r.render();assert.ok(doc.querySelector('[data-htmlmemo-id="old-mark"]'));
  doc.getElementById('reader-content').dataset.section='v0:one';r.render();assert.equal(doc.querySelector('[data-htmlmemo-id="old-mark"]'),null);
  doc.getElementById('reader-content').dataset.section='v0:opening';const before=structuredClone(r.metadata),notices=[],errors=[];let jumped;
  r.callbacks={onNotice:message=>notices.push(message),onError:error=>errors.push(error.message)};r.jump=element=>jumped=element;
  assert.equal(await r.jumpAnnotation('old-mark'),true);assert.equal(jumped.localName,'h1');assert.match(notices[0],/1부 앞부분/);assert.match(notices[0],/확정/);assert.deepEqual(errors,[]);assert.deepEqual(r.metadata,before);
});

test('annotation disclosure state survives view changes and deletion without saving UI state or showing empty groups',()=>{
  const a=sidebar(),before=structuredClone(a.r.metadata);
  a.r.metadata.annotations.push({id:'a2',type:'note',text:'다른 장 메모',color:'#334155'});
  a.r.annotationTree=()=>a.r.metadata.annotations.map((annotation,index)=>({id:annotation.id,title:index?'둘째 장':'첫 장',count:1,children:[],annotations:[annotation]}));
  a.open('annotations');let group=a.doc.querySelector('[data-annotation-group="a1"]');assert.equal(group.hasAttribute('open'),false);
  group.open=true;group.ontoggle();a.choose('search');a.choose('annotations');
  assert.equal(a.doc.querySelector('[data-annotation-group="a1"]').hasAttribute('open'),true);assert.equal(a.doc.querySelector('[data-annotation-group="a2"]').hasAttribute('open'),false);
  a.r.remove=id=>{a.r.metadata.annotations=a.r.metadata.annotations.filter(annotation=>annotation.id!==id);a.open('annotations');};
  a.doc.querySelector('[data-delete-annotation="a1"]').onclick();assert.equal(a.doc.querySelector('[data-annotation-group="a1"]'),null);
  assert.equal(a.doc.querySelector('[data-annotation-group="a2"]').hasAttribute('open'),false);assert.equal(a.calls.saved,0);
  a.r.metadata.annotations=[];a.open('annotations');assert.equal(a.doc.querySelector('[data-annotation-group]'),null);assert.match(a.doc.querySelector('.panel-empty').textContent,/아직 주석/);
  assert.deepEqual(before.annotations[0],{id:'a1',type:'note',color:'#334155',text:'남겨 둔 메모'});
});

test('annotation tree escapes source titles and annotation text',()=>{
  const a=sidebar();a.r.annotationTree=()=>[{id:'a"<',title:'<img src=x onerror=bad()>',count:1,children:[],annotations:a.r.metadata.annotations}];
  a.r.metadata.annotations[0].text='<script>bad()</script>';a.open('annotations');
  assert.equal(a.doc.querySelector('.annotation-group-title').textContent,'<img src=x onerror=bad()>');assert.equal(a.doc.querySelector('.annotation-main').textContent,'<script>bad()</script>');
  assert.equal(a.doc.querySelector('img,script'),null);assert.equal(a.doc.querySelector('[data-annotation-group]').dataset.annotationGroup,'a"<');
});

test('annotation navigation loads only the requested section before rendering and jumping',async()=>{
  installDOM();const doc=documentFor('<html><head><script id="book-manifest" type="application/json">{"format":"memosuite-book-html-v1","volumes":[{"sections":[{"key":"v0:first"},{"key":"v0:next"}]}]}</script></head><body><main><article id="reader-content" data-section="v0:first"></article></main></body></html>');
  let callback,hash,jumped,rendered=0,refreshed=0;const errors=[];
  Object.defineProperty(doc,'defaultView',{value:{MutationObserver:class{constructor(fn){callback=fn;}observe(){}disconnect(){}},location:{set hash(value){hash=value;doc.getElementById('reader-content').dataset.section=decodeURIComponent(value);queueMicrotask(callback);}}}});
  const r=Object.create(Reader.prototype);r.doc=doc;r.metadata={annotations:[{id:'next-note',type:'note',anchorTarget:{section:'v0:next'}}]};r.callbacks={onError:error=>errors.push(error.message)};
  r.refreshDynamicDocument=async()=>{refreshed++;};r.render=()=>{rendered++;doc.getElementById('reader-content').innerHTML='<span data-htmlmemo-id="next-note">A note</span>';};r.measure=()=>{};r.jump=element=>jumped=element;
  assert.equal(await r.jumpAnnotation('next-note'),true);assert.equal(hash,'v0%3Anext');assert.equal(refreshed,1);assert.equal(rendered,1);assert.equal(jumped.dataset.htmlmemoId,'next-note');assert.deepEqual(errors,[]);
  r.metadata.annotations.push({id:'missing',textAnchor:{section:'not-in-book'}});assert.equal(await r.jumpAnnotation('missing'),false);assert.match(errors[0],/目|목차/);assert.equal(r.metadata.annotations.length,2);
});

test('cancelled and timed-out annotation navigation never deletes annotations or jumps to stale content',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});installDOM();
  const doc=documentFor('<html><body><article id="reader-content" data-section="local"><span data-htmlmemo-id="here">Here</span></article></body></html>');
  let disconnected=0,jumps=0;const errors=[];
  Object.defineProperty(doc,'defaultView',{value:{MutationObserver:class{observe(){}disconnect(){disconnected++;}},location:{hash:''}}});
  const r=Object.create(Reader.prototype);r.doc=doc;r.metadata={annotations:[{id:'there',textAnchor:{section:'remote'}},{id:'here',textAnchor:{section:'local'}}]};
  r.annotationBookPaths=()=>new Map([['remote',[]]]);r.callbacks={onError:error=>errors.push(error.message)};r.jump=()=>jumps++;
  const cancelled=r.jumpAnnotation('there');assert.equal(await r.jumpAnnotation('here'),true);assert.equal(await cancelled,false);assert.equal(errors.length,0);assert.equal(jumps,1);
  const timedOut=r.jumpAnnotation('there');t.mock.timers.tick(15000);assert.equal(await timedOut,false);assert.match(errors[0],/불러오지 못했습니다/);
  assert.equal(disconnected,2);assert.equal(r.metadata.annotations.length,2);assert.equal(jumps,1);assert.equal(r.cancelAnnotationJump,null);
});

test('the visible source TOC gets inline choices without moving its tree, listeners or text anchors',()=>{
  installDOM();const a=sidebar();
  const doc=documentFor('<html><head></head><body><nav id="reader-nav"><h2>목차</h2><input placeholder="책 전체 검색"><details open><summary>첫 권</summary><a href="#chapter">본문으로</a></details></nav><main><h1 id="chapter">첫 장</h1><h2>목차</h2><p>원래 본문입니다.</p></main></body></html>');
  const toc=doc.querySelector('nav'),tree=doc.querySelector('details'),text=textIndex(doc).text;let clicks=0;tree.querySelector('summary').onclick=()=>clicks++;
  Object.setPrototypeOf(a.r,Reader.prototype);a.r.doc=doc;a.r.tocResize={sidebar:toc};
  a.r.callbacks={onSidebarView:(mode,panel,documentReader)=>a.context.renderSidebar(mode,{panel,embedded:true,documentReader})};
  a.r.setupDocumentSidebar();const panel=a.r.documentSidebarUI;
  assert.strictEqual(toc.firstElementChild,panel);assert.deepEqual([...panel.querySelectorAll('[data-sidebar-view]')].map(button=>button.textContent),['','','1','1']);
  assert.equal(toc.querySelector('h2:not([hidden])').hasAttribute('data-htmlmemo-redundant-toc-title'),true);assert.equal(doc.querySelectorAll('[data-htmlmemo-redundant-toc-title]').length,1);
  assert.equal(doc.querySelector('main h2').hasAttribute('data-htmlmemo-redundant-toc-title'),false);assert.equal(toc.querySelector('input').getAttribute('placeholder'),'책 전체 검색');
  toc.scrollTop=37;a.r.tocStrip=true;a.r.tocExpandedWidth=260;let expanded=0,synced=0;
  a.r.applyTocWidth=width=>{expanded=width;a.r.tocStrip=false;};a.r.syncAfterTocResize=()=>synced++;
  panel.querySelector('[data-sidebar-view=search]').onclick();assert.equal(expanded,260);assert.equal(synced,1);assert.equal(toc.scrollTop,0);
  assert.equal(toc.getAttribute('data-htmlmemo-sidebar-view'),'search');const input=panel.querySelector('#htmlmemo-native-document-search');assert.equal(input.getAttribute('placeholder'),'불러온 부분에서 찾기');assert.equal(input.getAttribute('aria-label'),'불러온 부분 검색어');input.value='원래';input.oninput();a.flush();
  panel.querySelector('[data-sidebar-view=annotations]').onclick();assert.equal(panel.querySelector('[data-annotation] .annotation-main').textContent,'남겨 둔 메모');assert.equal(panel.querySelector('[data-annotation] .annotation-meta').textContent,'메모');
  panel.querySelector('[data-sidebar-view=outline]').onclick();assert.equal(toc.scrollTop,37);assert.equal(panel.querySelector('.sidebar-content').hidden,false);
  assert.equal(panel.querySelectorAll('.sidebar-bookmarks').length,0);assert.equal(panel.querySelector('#htmlmemo-native-add-bookmark'),null);assert.equal(panel.querySelector('[data-heading]'),null,'the source TOC is not duplicated');
  assert.strictEqual(tree.parentElement,toc);tree.querySelector('summary').onclick();assert.equal(clicks,1);assert.equal(tree.hasAttribute('open'),true);
  assert.equal(textIndex(doc).text,text);a.r.setupDocumentSidebar();assert.equal(toc.querySelectorAll('[data-htmlmemo-doc-sidebar-ui]').length,1);
});
test('native bookmark icon opens its own view and keeps navigation and editing in the same panel',()=>{
  installDOM();const a=sidebar(),doc=documentFor('<html><head></head><body><nav><div id="source-tree">원래 목차</div></nav><main><h1>제목</h1><p>본문</p></main></body></html>');
  Object.setPrototypeOf(a.r,Reader.prototype);a.r.doc=doc;a.r.viewport={scrollTop:0,scrollLeft:0};a.r.tocResize={sidebar:doc.querySelector('nav')};
  a.r.callbacks={onSidebarView:(mode,panel,documentReader)=>a.context.renderSidebar(mode,{panel,embedded:true,documentReader})};
  const actions=[];a.context.toolAction=action=>actions.push(action);a.r.setupDocumentSidebar();
  assert.equal(a.r.documentSidebarUI.querySelector('.sidebar-bookmarks'),null);
  a.r.showDocumentSidebarView('bookmarks');a.r.documentSidebarUI.querySelector('[data-bookmark=b1]').onclick();assert.equal(a.r.scrollTop,480);assert.equal(a.r.scrollLeft,24);
  a.r.documentSidebarUI.querySelector('#htmlmemo-native-add-bookmark').onclick();assert.deepEqual(actions,['bookmark']);
  a.r.showDocumentSidebarView('search');a.r.showDocumentSidebarView('bookmarks');assert.equal(a.r.documentSidebarUI.querySelectorAll('[data-bookmark]').length,1);
  a.r.documentSidebarUI.querySelector('[data-delete-bookmark=b1]').onclick();assert.equal(a.r.metadata.bookmarks.length,0);assert.equal(a.calls.saved,1);
  assert.equal(a.r.documentSidebarUI.querySelector('[data-sidebar-count=bookmarks]').textContent,'0');assert.equal(a.doc.querySelector('#sidebar').hidden,true);assert.ok(doc.querySelector('#source-tree'));
  assert.ok(a.r.documentSidebarUI.querySelector('#htmlmemo-native-add-bookmark'));assert.equal(a.r.documentSidebarUI.querySelector('[data-bookmark]'),null);
});

test('the source book strong title is hidden without removing its drawer close button or chapter labels',()=>{
  installDOM();const a=sidebar();
  const doc=documentFor('<html><head></head><body><nav id="reader-nav"><div class="nav-head"><strong>목차</strong><button id="reader-close">×</button></div><input placeholder="책 전체 검색"><div id="reader-tree"><h2>목차</h2><div class="nav-head"><strong>목차</strong></div><a href="#chapter">목차</a></div></nav><main><h1 id="chapter">목차</h1></main></body></html>');
  const toc=doc.querySelector('nav'),title=toc.querySelector('.nav-head>strong'),close=toc.querySelector('#reader-close'),tree=toc.querySelector('#reader-tree'),before=textIndex(doc).text;let closed=0;close.onclick=()=>closed++;
  Object.setPrototypeOf(a.r,Reader.prototype);a.r.doc=doc;a.r.tocResize={sidebar:toc};
  a.r.callbacks={onSidebarView:(mode,panel,documentReader)=>a.context.renderSidebar(mode,{panel,embedded:true,documentReader})};
  a.r.setupDocumentSidebar();
  assert.strictEqual(doc.querySelector('[data-htmlmemo-redundant-toc-title]'),title);assert.equal(doc.querySelectorAll('[data-htmlmemo-redundant-toc-title]').length,1);
  assert.equal(tree.querySelector('[data-htmlmemo-redundant-toc-title]'),null);assert.equal(doc.querySelector('main [data-htmlmemo-redundant-toc-title]'),null);
  assert.deepEqual([...a.r.documentSidebarUI.querySelectorAll('[data-sidebar-view]')].map(button=>button.textContent),['','','1','1']);
  assert.equal(toc.querySelector('input').getAttribute('placeholder'),'책 전체 검색');assert.strictEqual(toc.querySelector('#reader-close'),close);close.onclick();assert.equal(closed,1);assert.equal(textIndex(doc).text,before);
  const exported=documentFor(serializeHTML(doc,a.r.metadata));
  assert.equal(exported.querySelector('#reader-nav>.nav-head>strong').textContent,'목차');assert.ok(exported.querySelector('#reader-close'));assert.equal(exported.querySelector('[data-htmlmemo-redundant-toc-title]'),null);
  // Without a source header, a chapter's heading must not become the title.
  title.parentElement.remove();a.r.documentSidebarUI.remove();a.r.setupDocumentSidebar();
  assert.equal(tree.querySelector('[data-htmlmemo-redundant-toc-title]'),null);
});

test('opening and exporting strip inline panel state while preserving the source TOC and scripts',()=>{
  installDOM();const html='<html><head><style id="htmlmemo-doc-sidebar-style">[data-htmlmemo-sidebar-view=search]>h2{display:none}</style></head><body><nav id="reader-nav" data-htmlmemo-native-sidebar data-htmlmemo-sidebar-view="search"><section data-htmlmemo-doc-sidebar-ui data-htmlmemo-ui><h2>주석 목록</h2><button>문서 검색</button></section><h2 data-htmlmemo-redundant-toc-title>목차</h2><details open><summary>원래 트리</summary><a href="#chapter">첫 장</a></details></nav><main><h1 id="chapter">본문</h1></main><script>window.originalScript=true</script></body></html>';
  const metadata=parseHTML('<html><head></head><body></body></html>').metadata;
  for(const result of [parseHTML(html,{}, {allowScripts:true}).html,serializeHTML(documentFor(html),metadata)]){
    const doc=documentFor(result);assert.equal(doc.querySelector('[data-htmlmemo-doc-sidebar-ui],#htmlmemo-doc-sidebar-style,[data-htmlmemo-native-sidebar],[data-htmlmemo-sidebar-view],[data-htmlmemo-redundant-toc-title]'),null);
    assert.equal(doc.querySelector('#reader-nav h2').textContent,'목차');assert.equal(doc.querySelector('#reader-nav details').hasAttribute('open'),true);assert.match(result,/window.originalScript=true/);
  }
});
