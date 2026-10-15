import test from 'node:test';
import assert from 'node:assert/strict';
import { saveDocumentHTML, annotationState, sameAnnotationState } from '../public/src/storage.js';
import { SaveQueue } from '../public/src/model.js';

test('autosave never queries or writes an imported file, including expired legacy connections',async()=>{
  for(const error of ['NotAllowedError','SecurityError','QuotaExceededError']){
    let saved,externalCalls=0;
    const record={id:'doc',fileHandle:{queryPermission(){externalCalls++;throw Error('unexpected query');}},diskPending:true,diskError:{name:error},metadata:{annotations:[]}};
    const queue=new SaveQueue(()=>saveDocumentHTML(record,'original source',{put:async value=>{saved={...value};},external:()=>{externalCalls++;},internal:()=>{throw Error('unexpected HTML rewrite');}}));
    queue.schedule();await queue.flush();
    assert.equal(queue.pending,false);assert.equal(queue.error,null);assert.equal(saved.html,'original source');assert.equal(saved.diskPending,false);assert.equal(saved.diskError,null);assert.equal(externalCalls,0);
  }
});

test('internal history persistence failure keeps autosave pending and visibly failed',async()=>{
  const record={id:'doc',metadata:{annotations:[]}};
  const queue=new SaveQueue(()=>saveDocumentHTML(record,'source',{put:async()=>{throw Error('IndexedDB full');}}));
  queue.schedule();await assert.rejects(queue.flush(),/IndexedDB full/);assert.equal(queue.pending,true);assert.match(queue.error.message,/IndexedDB full/);
});

test('history ignores viewport, source metadata and timestamps but includes edits and deletion',()=>{
  const first={annotations:[{id:'one',text:'memo'}],bookmarks:[],view:{scrollTop:0}};
  const moved={...first,view:{scrollTop:900,zoom:2},modifiedAt:42,title:'same body'};
  assert.equal(sameAnnotationState(first,moved),true);
  assert.equal(sameAnnotationState(first,{...first,annotations:[{id:'one',text:'edited memo'}]}),false);
  assert.equal(sameAnnotationState(first,{annotations:[],bookmarks:[]}),false);
  assert.equal(sameAnnotationState(first,{...first,bookmarks:[{id:'mark',top:50}]}),false);
  const copy=annotationState(first);copy.annotations[0].text='changed';assert.equal(first.annotations[0].text,'memo');
});
