import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=(await readFile(new URL('../public/src/storage.js',import.meta.url),'utf8')).replace(/^export /gm,'');
const identity={version:1,size:123,digest:'a'.repeat(64)};
const original={id:'book',modified:1234,byteSize:456,metadata:{annotations:[{id:'note',text:'Keep me'}],bookmarks:[{id:'mark'}],view:{zoom:1}}};
function storage(record=original){
  let current=structuredClone(record);const transactions=[],writes=[];
  const connection={transaction(names){
    transactions.push(names);let pending=0,aborted=false;const tx={};
    const request=result=>{pending++;const r={};queueMicrotask(()=>{r.result=structuredClone(result);r.onsuccess?.();if(!--pending)setImmediate(()=>{if(!aborted)tx.oncomplete?.();});});return r;};
    tx.abort=()=>{aborted=true;tx.onabort?.();};
    tx.objectStore=name=>({
      get:()=>request(current),getKey:()=>request('book'),
      put:value=>{writes.push(name);if(name==='documents')current=structuredClone(value);},
      add:()=>{throw Error('Source bodies and revisions must not be rewritten');},
      index:()=>({openKeyCursor:()=>request({primaryKey:1})}),
    });
    return tx;
  }};
  const context=vm.createContext({connection,structuredClone,Blob,Date,IDBKeyRange:{only:id=>id}});
  vm.runInContext(source+'\ndatabase=Promise.resolve(connection);',context);
  return {context,transactions,writes,get current(){return current;}};
}
test('legacy identity cache changes only the latest document summary, not annotations, modified time, source or history',async()=>{
  const a=storage(),saved=await a.context.putDocumentSourceIdentity('book',identity);
  assert.deepEqual(saved,{...original,sourceIdentity:identity});assert.deepEqual(a.current,saved);
  assert.deepEqual(a.transactions,['documents']);assert.deepEqual(a.writes,['documents']);
  identity.size++;assert.equal(saved.sourceIdentity.size,123);identity.size--;
});
test('legacy identity cache never recreates a deleted document',async()=>{
  const a=storage(null);assert.equal(await a.context.putDocumentSourceIdentity('deleted',identity),null);assert.deepEqual(a.writes,[]);
});
test('an old open tab autosave retains a migrated identity without rewriting source or adding an annotation revision',async()=>{
  const a=storage({...original,sourceIdentity:identity}),stale=structuredClone(original);
  await a.context.putDocumentRevision(stale,{baseline:true});
  assert.deepEqual(a.current.sourceIdentity,identity);assert.deepEqual(a.current.metadata,original.metadata);assert.equal(a.current.modified,original.modified);
  assert.deepEqual(a.writes,['documents']);assert.equal(stale.sourceIdentity,undefined);
});
