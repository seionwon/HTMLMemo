import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {documentFor} from './dom.mjs';
import {escapeHTML} from '../public/src/utils.js';

const source=await readFile(new URL('../public/src/app.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('async function migrateEdition('),source.indexOf('async function finishTrashChange('));
function fixture({marks=true,available=true}={}){
  const doc=documentFor('<html><body><dialog id="dialog"><div id="dialog-content"></div></dialog></body></html>'),dialog=doc.querySelector('#dialog'),content=doc.querySelector('#dialog-content'),messages=[],created=[];
  const old={annotations:[],bookmarks:marks?[{id:'shared',title:'기존 북마크 <b>그대로</b>',top:100,left:0,section:'a'}]:[]};
  const next={annotations:[{id:'embedded-note'}],bookmarks:[{id:'shared',title:'새 판에 있던 북마크',top:0,left:0}]};
  const report={same:0,changed:0,deleted:[],unplaceable:[],unchecked:[],failedSections:[]};
  let listener,picks=0,disposed=0,saves=0,commits=0,id=0;
  dialog.addEventListener=(_,fn)=>listener=fn;dialog.removeEventListener=()=>listener=null;
  const tab={reader:{ready:Promise.resolve(),metadata:old,doc:{},bookmarksForEdition:()=>structuredClone(old.bookmarks)},queue:{flush:async()=>{}}};
  const context=vm.createContext({structuredClone,Set,ANNOTATION_LABELS:{},uid:()=>`new-${++id}`,esc:escapeHTML,icon:()=>'',safely:fn=>fn,$:selector=>doc.querySelector(selector),toast:message=>messages.push(message),
    pickHTMLFile:async()=>{picks++;return {};},readLocalHTML:async()=>({snapshot:{},name:'edition.html'}),openEditionProbe:async()=>({dispose(){disposed++;}}),
    migrateAnnotations:async({bookmarks})=>({annotations:[],bookmarks:available?bookmarks:[],report,bookmarkReport:{...report,same:available?bookmarks.length:0,approximate:0,unplaceable:available?[]:bookmarks},oldSections:new Map()}),
    modal(html,bind){content.innerHTML=html;bind?.(dialog);},createDocument:async(...args)=>{created.push(args);return {reader:{ready:Promise.resolve(),metadata:next,commit(items){next.annotations=items;commits++;}},queue:{flush:async()=>saves++}};}});
  vm.runInContext(code,context);
  return {doc,content,old,next,messages,created,open:()=>context.migrateEdition(tab),async finish(value){dialog.returnValue=value;await listener();},get metrics(){return {picks,disposed,saves,commits};}};
}
test('bookmark-only transfers retain embedded bookmarks, regenerate colliding IDs and leave the source unchanged',async()=>{
  const f=fixture(),before=structuredClone(f.old);await f.open();assert.equal(f.content.querySelector('[value=confirm]').disabled,false);assert.match(f.content.textContent,/새 판으로 주석\/북마크 옮기기/);assert.match(f.content.textContent,/북마크 1개 가운데 1개/);
  await f.finish('confirm');assert.equal(f.created.length,1);assert.deepEqual(f.next.bookmarks.map(m=>m.title),['새 판에 있던 북마크','기존 북마크 <b>그대로</b>']);assert.equal(new Set(f.next.bookmarks.map(m=>m.id)).size,2);assert.equal(f.next.annotations[0].id,'embedded-note');assert.deepEqual(f.old,before);assert.deepEqual(f.metrics,{picks:1,disposed:1,saves:1,commits:1});assert.match(f.messages.at(-1),/주석 0개 · 북마크 1개/);
});
test('cancelling a transfer writes nothing and unlocatable bookmark labels stay escaped',async()=>{
  const f=fixture({available:false}),before=structuredClone(f.old);await f.open();assert.equal(f.content.querySelector('[value=confirm]').disabled,true);assert.match(f.content.querySelector('details').textContent,/기존 북마크 <b>그대로<\/b>/);assert.equal(f.content.querySelector('details b'),null);
  await f.finish('cancel');assert.equal(f.created.length,0);assert.equal(f.metrics.saves,0);assert.deepEqual(f.old,before);
});
test('a document without annotations or bookmarks does not open the file picker',async()=>{
  const f=fixture({marks:false});await f.open();assert.equal(f.metrics.picks,0);assert.equal(f.created.length,0);assert.match(f.messages.at(-1),/옮길 주석과 북마크가 없습니다/);
});
