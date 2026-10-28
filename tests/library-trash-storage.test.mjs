import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const source=(await readFile(new URL('../public/src/storage.js',import.meta.url),'utf8')).replace(/^export /gm,'');
function fixture(){
  const book={id:'book',title:'보관할 책',name:'원본.html',folderId:'part',created:100,modified:200,historyVersion:2,metadata:{annotations:[{id:'note',text:'보존할 주석'}],bookmarks:[{id:'mark'}],view:{scrollTop:620}}};
  let stores=new Map([
    ['documents',new Map([['book',book],['other',{...structuredClone(book),id:'other',folderId:''}]])],
    ['contents',new Map([['book',{documentId:'book',html:'<p>원본 본문</p>',originalFile:new Blob(['original bytes'])}],['other',{documentId:'other',html:'other body'}]])],
    ['revisions',new Map([[1,{id:1,documentId:'book',annotations:[],created:100}],[2,{id:2,documentId:'book',annotations:book.metadata.annotations,created:200}],[3,{id:3,documentId:'other',annotations:[],created:100}]])],
    ['revisionHeaders',new Map([[1,{id:1,documentId:'book'}],[2,{id:2,documentId:'book'}],[3,{id:3,documentId:'other'}]])],
    ['settings',new Map([['library-folders-v1',[{id:'part',parentId:'',name:'1부'}]]])],
  ]);
  const control={now:10000},transactions=[],reads=[],writes=[],removed=[];
  const connection={transaction(names){
    transactions.push(Array.isArray(names)?Array.from(names):names);const snapshot=structuredClone(stores);let pending=0,aborted=false;const tx={};
    const enqueue=callback=>{pending++;queueMicrotask(()=>{if(aborted)return;callback();pending--;if(!pending)setImmediate(()=>{if(!aborted&&!pending){stores=snapshot;tx.oncomplete?.();}});});};
    const request=value=>{const r={};enqueue(()=>{r.result=structuredClone(value);r.onsuccess?.();});return r;};
    tx.abort=()=>{aborted=true;queueMicrotask(()=>tx.onabort?.());};
    tx.objectStore=name=>{
      const map=snapshot.get(name),write=()=>{writes.push(name);if(control.fail===name){tx.error=Error('Disk full');tx.abort();return false;}return true;};
      const cursor=rows=>{const r={};let offset=0;const next=()=>enqueue(()=>{const row=rows[offset];r.result=row?{primaryKey:row.id,value:structuredClone(row),delete:()=>tx.objectStore(name).delete(row.id),continue:()=>{offset++;next();}}:null;r.onsuccess?.();});next();return r;};
      return {
        get:key=>{reads.push(name);return request(map.get(key));},getAll:()=>{reads.push(name);return request([...map.values()]);},
        put:(value,key)=>{if(write())map.set(key??value.id,structuredClone(value));return request(key??value.id);},
        delete:key=>{if(write())map.delete(key);return request(undefined);},
        index:()=>({getAll:id=>request([...map.values()].filter(row=>row.documentId===id)),openCursor:id=>cursor([...map.values()].filter(row=>row.documentId===id))}),
      };
    };return tx;
  }};
  class Clock extends Date{static now(){return control.now;}}
  const context=vm.createContext({connection,structuredClone,Blob,crypto,Date:Clock,IDBKeyRange:{only:id=>id},navigator:{storage:{getDirectory:async()=>({removeEntry:async name=>removed.push(name)})}}});
  vm.runInContext(source+'\ndatabase=Promise.resolve(connection);this.api={listDocuments,getDocument,listRevisions,readLibrary,trashDocument,restoreDocument,deleteDocument,deleteTrashedDocuments};',context);
  return {api:context.api,control,transactions,reads,writes,removed,get stores(){return stores;},get record(){return stores.get('documents').get('book');}};
}

test('trash and restore preserve the exact body, received bytes, notes, bookmarks, position and all history',async()=>{
  const f=fixture(),before=structuredClone(f.record),content=structuredClone(f.stores.get('contents').get('book')),history=structuredClone([...f.stores.get('revisions')]);
  await f.api.trashDocument('book');assert.equal(f.record.trashedAt,10000);assert.equal(f.record.modified,200);
  assert.deepEqual(f.transactions,[['documents','settings']]);assert.ok(!f.reads.includes('contents'));assert.deepEqual(f.writes,['documents']);
  assert.deepEqual(Array.from(await f.api.listDocuments(),row=>row.id),['other']);assert.equal((await f.api.listDocuments({includeTrashed:true})).length,2);assert.equal((await f.api.readLibrary()).documents.length,2);
  await f.api.restoreDocument('book');assert.deepEqual(f.record,before);assert.equal((await f.api.getDocument('book')).html,content.html);assert.equal(await(await f.api.getDocument('book')).originalFile.text(),'original bytes');assert.deepEqual([...f.stores.get('revisions')],history);assert.deepEqual(f.removed,[]);
});
test('repeated trash keeps the first deletion date, and restore falls back to root if its folder disappeared',async()=>{
  const f=fixture();await f.api.trashDocument('book');f.control.now=20000;await f.api.trashDocument('book');assert.equal(f.record.trashedAt,10000);
  f.stores.get('settings').set('library-folders-v1',[]);await f.api.restoreDocument('book');assert.equal(f.record.folderId,'');assert.equal(f.record.trashedAt,undefined);assert.equal(f.record.metadata.annotations[0].text,'보존할 주석');
  await f.api.restoreDocument('book');assert.equal(f.record.trashedAt,undefined);await assert.rejects(f.api.trashDocument('missing'),/삭제|변경/);
});
test('a failed trash or restore leaves the committed document and all content intact',async()=>{
  const f=fixture(),before=structuredClone(f.record);f.control.fail='documents';await assert.rejects(f.api.trashDocument('book'),/Disk full/);assert.deepEqual(f.record,before);
  f.control.fail=null;await f.api.trashDocument('book');const trashed=structuredClone(f.record);f.control.fail='documents';await assert.rejects(f.api.restoreDocument('book'),/Disk full/);assert.deepEqual(f.record,trashed);assert.equal(f.stores.get('contents').size,2);assert.equal(f.stores.get('revisions').size,3);
});
test('permanent deletion removes only a trashed document, its body and both history indexes',async()=>{
  const f=fixture();await f.api.trashDocument('book');await f.api.deleteDocument('book');assert.equal(f.record,undefined);assert.equal(f.stores.get('contents').has('book'),false);assert.deepEqual([...f.stores.get('revisions').keys()],[3]);assert.deepEqual([...f.stores.get('revisionHeaders').keys()],[3]);assert.equal(f.stores.get('documents').has('other'),true);assert.deepEqual(f.removed,['book.html']);
});
test('empty trash aborts atomically if a selected document was restored in another window',async()=>{
  const f=fixture();await f.api.trashDocument('book');await assert.rejects(f.api.deleteTrashedDocuments(['book','other']),/복원/);
  assert.ok(f.record.trashedAt);assert.equal(f.stores.get('contents').size,2);assert.equal(f.stores.get('revisions').size,3);assert.equal(f.stores.get('revisionHeaders').size,3);assert.deepEqual(f.removed,[]);
  await f.api.trashDocument('other');await f.api.deleteTrashedDocuments(['book','other','book']);for(const name of ['documents','contents','revisions','revisionHeaders'])assert.equal(f.stores.get(name).size,0);
});
test('a history-index failure rolls back the entire purge and leaves both documents recoverable',async()=>{
  const f=fixture();await f.api.trashDocument('book');await f.api.trashDocument('other');f.control.fail='revisionHeaders';await assert.rejects(f.api.deleteTrashedDocuments(['book','other']),/Disk full/);assert.equal(f.stores.get('documents').size,2);assert.equal(f.stores.get('contents').size,2);assert.equal(f.stores.get('revisions').size,3);assert.equal(f.stores.get('revisionHeaders').size,3);assert.deepEqual(f.removed,[]);
});
