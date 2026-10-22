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
  assert.deepEqual([...a.doc.querySelectorAll('[data-sidebar-view]')].map(button=>button.textContent),['목차·북마크','검색','주석']);
  a.doc.querySelector('[data-heading]').onclick();assert.deepEqual(a.calls.headings,['heading-1']);
  const button=a.doc.querySelector('[data-sidebar-view=search]');a.choose('search');
  const input=a.doc.querySelector('#document-search');assert.equal(input.getAttribute('placeholder'),'불러온 부분에서 찾기');assert.equal(input.getAttribute('aria-label'),'불러온 부분 검색어');assert.equal(a.doc.querySelector('#sidebar-title').textContent,'검색');input.value='기억';input.oninput();a.flush();
  assert.equal(a.doc.querySelector('#search-count').textContent,'1개 결과');
  a.doc.querySelector('[data-search-index]').onclick();assert.deepEqual(a.calls.next,[1]);
  a.choose('annotations');assert.equal(a.doc.querySelector('#sidebar-title').textContent,'주석');a.doc.querySelector('[data-annotation]').onclick();assert.deepEqual(a.calls.annotations,['a1']);
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
  assert.strictEqual(toc.firstElementChild,panel);assert.deepEqual([...panel.querySelectorAll('[data-sidebar-view]')].map(button=>button.textContent),['목차','검색','주석']);
  assert.equal(toc.querySelector('h2:not([hidden])').hasAttribute('data-htmlmemo-redundant-toc-title'),true);assert.equal(doc.querySelectorAll('[data-htmlmemo-redundant-toc-title]').length,1);
  assert.equal(doc.querySelector('main h2').hasAttribute('data-htmlmemo-redundant-toc-title'),false);assert.equal(toc.querySelector('input').getAttribute('placeholder'),'책 전체 검색');
  toc.scrollTop=37;a.r.tocStrip=true;a.r.tocExpandedWidth=260;let expanded=0,synced=0;
  a.r.applyTocWidth=width=>{expanded=width;a.r.tocStrip=false;};a.r.syncAfterTocResize=()=>synced++;
  panel.querySelector('[data-sidebar-view=search]').onclick();assert.equal(expanded,260);assert.equal(synced,1);assert.equal(toc.scrollTop,0);
  assert.equal(toc.getAttribute('data-htmlmemo-sidebar-view'),'search');const input=panel.querySelector('input');assert.equal(input.getAttribute('placeholder'),'불러온 부분에서 찾기');assert.equal(input.getAttribute('aria-label'),'불러온 부분 검색어');input.value='원래';input.oninput();a.flush();
  panel.querySelector('[data-sidebar-view=annotations]').onclick();assert.equal(panel.querySelector('[data-annotation] .annotation-main').textContent,'남겨 둔 메모');assert.equal(panel.querySelector('[data-annotation] .annotation-meta').textContent,'메모');
  panel.querySelector('[data-sidebar-view=outline]').onclick();assert.equal(toc.scrollTop,37);assert.equal(panel.querySelector('.sidebar-content').hidden,true);
  assert.strictEqual(toc.querySelector('details'),tree);tree.querySelector('summary').onclick();assert.equal(clicks,1);assert.equal(tree.hasAttribute('open'),true);
  assert.equal(textIndex(doc).text,text);a.r.setupDocumentSidebar();assert.equal(toc.querySelectorAll('[data-htmlmemo-doc-sidebar-ui]').length,1);
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
  assert.deepEqual([...a.r.documentSidebarUI.querySelectorAll('[data-sidebar-view]')].map(button=>button.textContent),['목차','검색','주석']);
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
