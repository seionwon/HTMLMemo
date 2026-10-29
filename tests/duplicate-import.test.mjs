import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {documentFor,installDOM} from './dom.mjs';
import {escapeHTML} from '../public/src/utils.js';
import {findLocalDuplicates,identifyLocalFile} from '../public/src/local-files.js';
import {parseHTML} from '../public/src/document.js';
installDOM();
const source=await readFile(new URL('../public/src/app.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('function duplicateImportDialog('),source.indexOf('async function savePage('));
const identity={version:1,size:100,digest:'a'.repeat(64)};
const local={name:'book.html',sourceIdentity:identity,snapshot:{html:'<body>Book</body>'},handle:null};
const record={id:'existing',title:'기존 책',name:local.name,sourceIdentity:identity,modified:1234,metadata:{annotations:[{id:'original'}],bookmarks:[{id:'bookmark'}]}};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function app(rows=[structuredClone(record)],{cacheError=false}={}){
  const doc=documentFor('<html><head></head><body><span id="status-left"></span><dialog id="dialog"><div id="dialog-content"></div></dialog></body></html>');
  const dialog=doc.querySelector('#dialog'),created=[],opened=[],reads=[],cached=[],notices=[];let restored=0;
  dialog.close=value=>{dialog.returnValue=value||'';dialog.open=false;dialog.dispatchEvent(new doc.defaultView.Event('close'));};
  const context=vm.createContext({document:doc,$:(s,root=doc)=>root.querySelector(s),esc:escapeHTML,formatDate:()=> '10월 23일',
    modal(html,bind){doc.querySelector('#dialog-content').innerHTML=html;dialog.open=true;dialog.returnValue='';const select=doc.querySelector('select');let value=select.firstElementChild.value;Object.defineProperty(select,'value',{configurable:true,get:()=>value,set:next=>value=next});bind(dialog);},
    readLocalHTML:async(input,options)=>{assert.equal(options.identify,false);reads.push(input);if(input.error)throw Error('read failed');return {...input};},findLocalDuplicates,identifyLocalFile,listDocuments:async()=>rows,getDocument:async id=>rows.find(row=>row.id===id),
    putDocumentSourceIdentity:async(id,sourceIdentity)=>{if(cacheError)throw Error('storage full');const row=rows.find(row=>row.id===id);row.sourceIdentity=sourceIdentity;cached.push(id);return row;},toast:message=>notices.push(message),
    openRecord:async item=>{opened.push(item);return item;},createDocument:async(...args)=>{created.push(args);return {id:'new'};},renderLibrary:()=>restored++,updateChrome:()=>restored++,setTimeout:fn=>fn(),
  });
  vm.runInContext('var localImportQueue=Promise.resolve(),activeId="library",libraryFolderId="",folderSetupPending=false,folderSetupWaiters=[],startupPending=false;'+code,context);
  return {context,doc,dialog,created,opened,reads,rows,cached,notices,get restored(){return restored;}};
}
test('a proven legacy match caches only its source identity and keeps the three-way choice',async()=>{
  const old={...structuredClone(record),html:parseHTML(local.snapshot.html,{}, {allowScripts:true}).html};delete old.sourceIdentity;
  const before=structuredClone(old),a=app([old]),pending=a.context.openLocalFile({...local});await tick();
  assert.deepEqual(a.cached,['existing']);assert.deepEqual(a.rows,[{...before,sourceIdentity:identity}]);assert.equal(a.dialog.open,true);
  a.dialog.close('cancel');await pending;
  const again=a.context.openLocalFile({...local});await tick();assert.deepEqual(a.cached,['existing']);a.dialog.close('existing');await again;
  assert.equal(a.opened.length,1);assert.equal(a.created.length,0);
});
test('an optional identity-cache write failure does not block opening the existing annotations',async()=>{
  const old={...structuredClone(record),html:parseHTML(local.snapshot.html,{}, {allowScripts:true}).html};delete old.sourceIdentity;
  const a=app([old],{cacheError:true}),pending=a.context.openLocalFile({...local});await tick();assert.equal(a.dialog.open,true);assert.match(a.notices[0],/다음에는 다시 검사/);
  a.dialog.close('existing');await pending;assert.equal(a.opened.length,1);assert.equal(a.created.length,0);assert.equal(a.rows[0].sourceIdentity,undefined);
});
test('duplicate import presents exactly the three requested choices and safely focuses cancel',async()=>{
  const a=app(),pending=a.context.openLocalFile(local);await tick();
  assert.deepEqual([...a.doc.querySelectorAll('button')].map(b=>b.textContent),['취소','새롭게 열기','기존의 주석 파일로 가기']);
  assert.equal(a.doc.querySelector('button[autofocus]').getAttribute('value'),'cancel');assert.match(a.doc.body.textContent,/기존 문서와 주석, 원본 HTML 파일은 변경하지 않습니다/);
  a.dialog.close('cancel');assert.equal(await pending,null);assert.equal(a.created.length,0);assert.equal(a.opened.length,0);assert.deepEqual(a.rows,[record]);assert.equal(a.restored,1);
});
test('Escape or backdrop close is cancellation, not permission to create a new document',async()=>{
  const a=app(),pending=a.context.openLocalFile(local);await tick();a.dialog.close();assert.equal(await pending,null);assert.equal(a.created.length,0);assert.equal(a.opened.length,0);
});
test('Escape remains available to the import dialog instead of reaching reader/TTS shortcuts',async()=>{
  const a=app(),pending=a.context.openLocalFile({...local});await tick();let reached=false;
  a.doc.addEventListener('keydown',()=>reached=true);const event=new a.doc.defaultView.Event('keydown',{bubbles:true,cancelable:true});event.key='Escape';a.doc.querySelector('[data-duplicate-import] button').dispatchEvent(event);
  assert.equal(reached,false);assert.equal(event.defaultPrevented,false);a.dialog.close();await pending;assert.equal(a.created.length,0);
});
test('new opens an independent fresh annotation copy without mutating the existing record or input',async()=>{
  const a=app(),before=structuredClone(local),pending=a.context.openLocalFile(local);await tick();a.dialog.close('new');await pending;
  assert.equal(a.created.length,1);assert.equal(a.created[0][3].freshAnnotations,true);assert.deepEqual(a.rows,[record]);assert.equal(a.opened.length,0);
  assert.deepEqual(local,before);
});
test('existing opens the chosen record without creating or replacing annotations',async()=>{
  const other={...structuredClone(record),id:'other',title:'다른 주석 사본'},a=app([structuredClone(record),other]);
  const pending=a.context.openLocalFile({...local});await tick();a.doc.querySelector('select').value='other';a.dialog.close('existing');await pending;
  assert.equal(a.created.length,0);assert.strictEqual(a.opened[0],other);assert.deepEqual(a.rows[0],record);
});
test('nonduplicate input opens normally and does not discard annotations embedded in the first import',async()=>{
  const a=app([]);await a.context.openLocalFile({...local});assert.equal(a.dialog.open,undefined);assert.equal(a.created.length,1);assert.equal(a.created[0][3].freshAnnotations,undefined);
});
test('all import paths are serialized so simultaneous imports cannot replace a pending choice',async()=>{
  const a=app(),first=a.context.openLocalFile({...local}),second=a.context.openLocalFile({...local});await tick();assert.equal(a.reads.length,1);
  a.dialog.close('cancel');await first;await tick();assert.equal(a.reads.length,2);assert.equal(a.dialog.open,true);a.dialog.close('existing');await second;assert.equal(a.opened.length,1);assert.equal(a.created.length,0);
});
test('a failed import restores status and does not poison subsequent imports',async()=>{
  const a=app([]);await assert.rejects(a.context.openLocalFile({error:true}),/read failed/);await a.context.openLocalFile({...local});assert.equal(a.created.length,1);assert.equal(a.restored,2);
});
test('queued imports keep the folder selected when each import began, not a later navigation',async()=>{
  const a=app([]);a.context.libraryFolderId='first';const first=a.context.openLocalFile({...local});a.context.libraryFolderId='second';const second=a.context.openLocalFile({...local});a.context.libraryFolderId='later';await Promise.all([first,second]);
  assert.deepEqual(a.created.map(args=>args[3].libraryFolderId),['first','second']);assert.equal(local.libraryFolderId,undefined);
});

test('startup update decisions block imports without reading or changing the selected file',async()=>{
 const a=app([]),before=structuredClone(local);a.context.startupPending=true;
 assert.equal(await a.context.openLocalFile(local),null);assert.equal(a.reads.length,0);assert.equal(a.created.length,0);assert.equal(a.opened.length,0);assert.deepEqual(local,before);
 a.context.startupPending=false;await a.context.openLocalFile(local);assert.equal(a.created.length,1);
});
