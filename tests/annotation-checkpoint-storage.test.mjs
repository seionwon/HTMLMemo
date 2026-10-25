import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=(await readFile(new URL('../public/src/storage.js',import.meta.url),'utf8')).replace(/^export /gm,'');
const record=()=>({id:'book',title:'Book',modified:1000,byteSize:100,metadata:{annotations:[],bookmarks:[],view:{scrollTop:0}}});
function fixture(){
  let current,history=[],headers=[];const control={},transactions=[];
  const connection={transaction(names){
    transactions.push(names);let doc=structuredClone(current),rows=structuredClone(history),index=structuredClone(headers),pending=0,aborted=false,scheduled=false;const tx={};
    const request=value=>{pending++;const r={};queueMicrotask(()=>{if(aborted)return;r.result=structuredClone(value);r.onsuccess?.();if(!--pending&&!scheduled){scheduled=true;setImmediate(()=>{if(!aborted){current=doc;history=rows;headers=index;tx.oncomplete?.();}});}});return r;};
    tx.abort=()=>{aborted=true;queueMicrotask(()=>tx.onabort?.());};
    tx.objectStore=name=>({get:()=>request(doc),getKey:()=>request('source-already-retained'),
      put:value=>{doc=structuredClone(value);},
      add:value=>{if(name==='revisionHeaders'){if(control.failHeaders){tx.abort();return request(null);}index.push(structuredClone(value));return request(value.id);}if(control.failHistory)throw Error('History disk full');const row=structuredClone(value);row.id=rows.length+1;rows.push(row);return request(row.id);},
      index:()=>({openKeyCursor:()=>request(rows.length?{primaryKey:rows.at(-1).id}:null),openCursor:()=>request(rows.length?{primaryKey:rows.at(-1).id,value:rows.at(-1)}:null)}),
    });return tx;
  }};
  const context=vm.createContext({connection,structuredClone,Blob,Date,IDBKeyRange:{only:id=>id}});vm.runInContext(source+'\ndatabase=Promise.resolve(connection);',context);
  return {api:context,control,transactions,get current(){return current;},get history(){return history;},get headers(){return headers;},remove(){current=undefined;}};
}
test('fast autosave persists every change without a new revision until a checkpoint',async()=>{
  const f=fixture(),r=record();await f.api.putDocumentRevision(r,{baseline:true});
  for(let i=1;i<=20;i++){r.metadata.annotations=[{id:'note',text:String(i)}];await f.api.putDocumentRevision(r,{checkpoint:false});assert.equal(f.current.metadata.annotations[0].text,String(i));}
  assert.equal(f.history.length,1);assert.equal(f.current.historyVersion,1);assert.equal(await f.api.checkpointAnnotations('book'),true);assert.equal(f.history.length,2);assert.equal(f.history[1].annotations[0].text,'20');assert.equal(f.current.historyVersion,2);
  assert.equal(await f.api.checkpointAnnotations('book'),false);assert.equal(f.history.length,2);
});
test('editing and undoing back to the previous checkpoint never adds a duplicate',async()=>{
  const f=fixture(),r=record();await f.api.putDocumentRevision(r,{baseline:true});r.metadata.bookmarks=[{id:'bookmark'}];await f.api.putDocumentRevision(r,{checkpoint:false});r.metadata.bookmarks=[];await f.api.putDocumentRevision(r,{checkpoint:false});assert.equal(await f.api.checkpointAnnotations('book'),false);assert.equal(f.history.length,1);assert.equal(f.current.historyVersion,1);
});
test('a stale reader header cannot roll back the durable history version',async()=>{
  const f=fixture(),r=record();await f.api.putDocumentRevision(r,{baseline:true});r.metadata.annotations=[{id:'first'}];await f.api.putDocumentRevision(r,{checkpoint:false});await f.api.checkpointAnnotations('book');r.historyVersion=0;r.metadata.annotations.push({id:'second'});await f.api.putDocumentRevision(r,{checkpoint:false});assert.equal(f.current.historyVersion,2);await f.api.checkpointAnnotations('book');assert.equal(f.current.historyVersion,3);assert.equal(f.history.at(-1).annotations.length,2);
});
test('restoration atomically preserves unsnapshotted notes and the chosen target without duplicate targets',async()=>{
  const f=fixture(),r=record();await f.api.putDocumentRevision(r,{baseline:true});r.metadata.annotations=[{id:'unsnapshotted'}];await f.api.putDocumentRevision(r,{checkpoint:false});r.metadata.annotations=[];await f.api.putDocumentRevision(r,{restoredFrom:1});assert.equal(f.history.length,3);assert.equal(f.history[1].annotations[0].id,'unsnapshotted');assert.equal(f.history[2].kind,'restore');assert.equal(f.history[2].restoredFrom,1);assert.equal(f.current.historyVersion,3);await f.api.putDocumentRevision(r,{restoredFrom:1});assert.equal(f.history.length,3);
});
test('checkpoint failure retains the fast-saved current work and retry succeeds',async()=>{
  const f=fixture(),r=record();await f.api.putDocumentRevision(r,{baseline:true});r.metadata.annotations=[{id:'already-saved'}];await f.api.putDocumentRevision(r,{checkpoint:false});f.control.failHistory=true;await assert.rejects(f.api.checkpointAnnotations('book'),/History disk full/);assert.equal(f.current.metadata.annotations[0].id,'already-saved');assert.equal(f.history.length,1);assert.equal(f.current.historyVersion,1);f.control.failHistory=false;await f.api.checkpointAnnotations('book');assert.equal(f.history.length,2);
});
test('a failed restore rolls back both the pre-restore snapshot and restored current state',async()=>{
  const f=fixture(),r=record();await f.api.putDocumentRevision(r,{baseline:true});r.metadata.annotations=[{id:'keep'}];await f.api.putDocumentRevision(r,{checkpoint:false});r.metadata.annotations=[];r.uncloneable=()=>{};await assert.rejects(f.api.putDocumentRevision(r,{restoredFrom:1}));assert.equal(f.history.length,1);assert.equal(f.current.metadata.annotations[0].id,'keep');assert.equal(f.current.historyVersion,1);
});
test('a checkpoint for a deleted document never resurrects it or adds an orphan revision',async()=>{
  const f=fixture();await f.api.putDocumentRevision(record(),{baseline:true});f.remove();assert.equal(await f.api.checkpointAnnotations('book'),false);assert.equal(f.current,undefined);assert.equal(f.history.length,1);
});
test('date headers commit with snapshots, carry only counts and leave fast saves unindexed',async()=>{
  const f=fixture(),r=record();await f.api.putDocumentRevision(r,{baseline:true});assert.equal(f.headers.length,1);r.metadata.annotations=[{id:'note',text:'Private annotation content'}];await f.api.putDocumentRevision(r,{checkpoint:false});assert.equal(f.headers.length,1);await f.api.checkpointAnnotations('book');assert.equal(f.headers.length,2);const header=f.headers[1];assert.equal(header.id,f.history[1].id);assert.equal(header.created,f.history[1].created);assert.equal(header.annotationCount,1);assert.equal(header.bookmarkCount,0);assert.equal(Object.hasOwn(header,'annotations'),false);assert.ok(!JSON.stringify(header).includes('Private annotation content'));
});
test('date index failure rolls back the checkpoint without losing durable current annotations',async()=>{
  const f=fixture(),r=record();await f.api.putDocumentRevision(r,{baseline:true});r.metadata.annotations=[{id:'keep'}];await f.api.putDocumentRevision(r,{checkpoint:false});f.control.failHeaders=true;await assert.rejects(f.api.checkpointAnnotations('book'));assert.equal(f.current.metadata.annotations[0].id,'keep');assert.equal(f.history.length,1);assert.equal(f.headers.length,1);assert.equal(f.current.historyVersion,1);f.control.failHeaders=false;await f.api.checkpointAnnotations('book');assert.equal(f.history.length,2);assert.equal(f.headers.length,2);
});
