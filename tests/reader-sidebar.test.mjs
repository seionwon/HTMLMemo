import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {DOMParser} from 'linkedom';
import {$, $$, icon, escapeHTML} from '../public/src/utils.js';

const source=await readFile(new URL('../public/src/app.js',import.meta.url),'utf8');
const sidebarCode=source.slice(source.indexOf('function closeSidebar('),source.indexOf('function annotationDialog('));

function sidebar() {
  const doc=new DOMParser().parseFromString('<html><body><aside id="sidebar" hidden></aside></body></html>','text/html');
  const calls={search:[],next:[],headings:[],annotations:[],saved:0},timers=new Map();let timerId=0;
  const r={zoom:2,metadata:{bookmarks:[{id:'b1',title:'읽던 곳',top:240,left:12}],annotations:[{id:'a1',type:'note',color:'#334155',text:'남겨 둔 메모'}]},
    outline:()=>[{node:'heading-1',level:1,title:'첫 번째 절'}],jump:node=>calls.headings.push(node),jumpAnnotation:id=>calls.annotations.push(id),
    search(query){this.searchQuery=query;calls.search.push(query);return query?[{quote:'찾은 문장: '+query}]:[];},nextSearch:direction=>calls.next.push(direction)};
  let current=r;
  const context=vm.createContext({document:doc,$:(selector,root=doc)=>$(selector,root),$$:(selector,root=doc)=>$$(selector,root),icon,esc:escapeHTML,
    reader:()=>current,active:()=>({queue:{schedule(){calls.saved++;}}}),closePopover(){},toolAction(){},
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
