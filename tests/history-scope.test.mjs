import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {documentFor} from './dom.mjs';
import {escapeHTML} from '../public/src/utils.js';

const source=await readFile(new URL('../public/src/app.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('async function annotationHistory('),source.indexOf('function documentInfo('));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
function fixture(){
  const doc=documentFor('<html><body><dialog id="dialog"><div id="dialog-content"></div></dialog></body></html>'),dialog=doc.querySelector('#dialog'),content=doc.querySelector('#dialog-content');
  dialog.close=()=>dialog.open=false;
  const versions=[['a',11,'A의 이전 주석'],['b',12,'B의 주석'],['a',13,'A의 현재 주석']].map(([documentId,id,text])=>({documentId,id,created:new Date(2026,0,1,12).getTime(),kind:'edit',annotations:[{id:'note-'+id,type:'note',text}],bookmarks:[],annotationCount:1,bookmarkCount:0}));
  const calls=[],commits=[];
  const tabs=Object.fromEntries(['a','b','empty'].map(id=>[id,{record:{id,title:id==='a'?'A <img src=x> 문서':id==='b'?'B 문서':'빈 문서',name:'same.html'},reader:{ready:Promise.resolve(),metadata:{annotations:[{text:id+' current'}],bookmarks:[]},commit(rows){this.metadata.annotations=rows;commits.push(id);}},queue:{flush:async()=>{}},checkpoints:{flush:async()=>{}}}]));
  let selected=tabs.a;
  const modal=(html,bind)=>{content.innerHTML=html;dialog.open=true;for(const select of content.querySelectorAll('select')){let value=select.firstElementChild?.getAttribute('value')||'';Object.defineProperty(select,'value',{configurable:true,get:()=>value,set:next=>value=String(next)});}bind(dialog);};
  const context=vm.createContext({Date,structuredClone,active:()=>selected,$:(selector,root=doc)=>root.querySelector(selector),$$:(selector,root=doc)=>[...root.querySelectorAll(selector)],esc:escapeHTML,icon:()=>'',safely:fn=>fn,modal,toast(){},renderSidebar(){},
    listRevisionPeriods:async(id,year,month)=>{calls.push(id);const rows=versions.filter(v=>v.documentId===id);return rows.length?[{value:year===undefined?2026:1,count:rows.length}]:[];},
    listRevisionDay:async id=>{calls.push(id);return {rows:versions.filter(v=>v.documentId===id).reverse(),next:null};},adjacentRevisionDay:async id=>{calls.push(id);return null;},getRevision:async id=>versions.find(v=>v.id===id)});
  vm.runInContext('let historyRequest=0;let sidebarMode="";'+code,context);
  return {doc,dialog,content,context,tabs,versions,calls,commits,select:id=>selected=tabs[id],open:id=>context.annotationHistory(tabs[id]),modal,ids:()=>[...content.querySelectorAll('[data-revision]')].map(b=>Number(b.dataset.revision))};
}

test('history names and counts only the selected document, even with shared filenames and interleaved revision IDs',async()=>{
  const a=fixture();await a.open('a');assert.deepEqual(a.ids(),[13,11]);assert.ok(a.calls.every(id=>id==='a'));
  assert.equal(a.content.querySelector('[data-history-document]').dataset.historyDocument,'a');assert.match(a.content.textContent,/A <img src=x> 문서/);assert.equal(a.content.querySelector('img'),null);assert.match(a.content.querySelector('#history-summary').textContent,/이 문서의 이력 2개/);assert.doesNotMatch(a.content.textContent,/#13|#11/);
  a.select('b');a.calls.length=0;await a.open('b');assert.deepEqual(a.ids(),[12]);assert.ok(a.calls.every(id=>id==='b'));assert.match(a.content.querySelector('#history-summary').textContent,/이 문서의 이력 1개/);
  a.select('empty');await a.open('empty');assert.deepEqual(a.ids(),[]);assert.match(a.content.textContent,/이 문서에는 아직 저장된 이력이 없습니다/);assert.match(a.content.querySelector('#history-summary').textContent,/이 문서의 이력 0개/);
});
test('a previous document cannot open its history after a slow save and a tab switch',async()=>{
  const a=fixture(),save=deferred();a.tabs.a.queue.flush=()=>save.promise;
  const pending=a.open('a');await tick();a.select('b');await a.open('b');save.resolve();await pending;
  assert.equal(a.content.querySelector('[data-history-document]').dataset.historyDocument,'b');assert.deepEqual(a.ids(),[12]);assert.ok(a.calls.every(id=>id==='b'));
});
test('a pending history cannot replace a different dialog or query an inactive document',async()=>{
  const a=fixture(),save=deferred();a.tabs.a.queue.flush=()=>save.promise;
  const pending=a.open('a');await tick();a.modal('<p id="settings">설정</p>',()=>{});save.resolve();await pending;
  assert.ok(a.content.querySelector('#settings'));assert.deepEqual(a.calls,[]);
  a.select('b');await a.open('a');assert.deepEqual(a.calls,[]);
});
test('history preview rejects a revision belonging to another document',async()=>{
  const a=fixture();await a.open('a');a.content.querySelector('[data-revision]').dataset.revision='12';
  await assert.rejects(a.content.querySelector('[data-revision]').onclick(),/저장 이력을 찾지 못했습니다/);assert.equal(a.content.querySelector('.revision-preview'),null);assert.deepEqual(a.commits,[]);
});
test('restoration stays scoped to its selected document and does not alter another document',async()=>{
  const a=fixture(),before=structuredClone(a.tabs.b.reader.metadata);await a.open('a');await a.content.querySelector('[data-revision="11"]').onclick();
  assert.equal(a.content.querySelector('[data-history-document]').dataset.historyDocument,'a');assert.match(a.content.querySelector('.revision-preview').textContent,/A의 이전 주석/);assert.doesNotMatch(a.content.textContent,/B의 주석/);
  await a.content.querySelector('#restore-revision').onclick();assert.deepEqual(a.commits,['a']);assert.equal(a.tabs.a.reader.metadata.annotations[0].text,'A의 이전 주석');assert.deepEqual(a.tabs.b.reader.metadata,before);
});
test('switching documents while a restore waits for saving cancels the stale restoration',async()=>{
  const a=fixture();await a.open('a');await a.content.querySelector('[data-revision="11"]').onclick();
  const save=deferred();a.tabs.a.queue.flush=()=>save.promise;const pending=a.content.querySelector('#restore-revision').onclick();await tick();a.select('b');await a.open('b');save.resolve();await pending;
  assert.deepEqual(a.commits,[]);assert.equal(a.tabs.a.reader.metadata.annotations[0].text,'a current');assert.equal(a.content.querySelector('[data-history-document]').dataset.historyDocument,'b');
});
