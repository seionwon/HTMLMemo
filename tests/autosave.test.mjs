import test from 'node:test';
import assert from 'node:assert/strict';
import { saveDocumentHTML } from '../public/src/storage.js';
import { SaveQueue } from '../public/src/model.js';

const setup = (failure) => {
  let saved, internal, externalWrites = 0;
  const record = {id:'document',fileHandle:{},diskStamp:{modified:123,size:10}};
  const operations = {
    put: async value => { saved = structuredClone({...value,fileHandle:null}); },
    internal: async (_id, html) => {internal=html;},
    external: async () => {externalWrites++;if(failure)throw failure;},
  };
  return {record,operations,read:()=>({saved,internal,externalWrites})};
};

test('lost external permission preserves the complete internal copy and lets autosave finish', async()=>{
  const fixture=setup(new DOMException('permission expired','NotAllowedError'));
  const queue=new SaveQueue(()=>saveDocumentHTML(fixture.record,'<html>latest annotation</html>',fixture.operations));
  queue.schedule();await queue.flush();
  assert.equal(queue.error,null);assert.equal(queue.pending,false);
  assert.equal(fixture.read().saved.html,'<html>latest annotation</html>');assert.equal(fixture.read().internal,fixture.read().saved.html);
  assert.equal(fixture.read().saved.diskPending,true);assert.equal(fixture.record.diskError.name,'NotAllowedError');
  await queue.flush();assert.equal(fixture.read().externalWrites,1);
});

test('new annotations keep saving internally while external synchronization is blocked',async()=>{
 const fixture=setup(new DOMException('permission expired','NotAllowedError'));
 await saveDocumentHTML(fixture.record,'first',fixture.operations);await saveDocumentHTML(fixture.record,'second',fixture.operations);
 assert.equal(fixture.read().saved.html,'second');assert.equal(fixture.read().internal,'second');assert.equal(fixture.record.diskPending,true);
});

test('retry after restored permission saves the current content and clears persisted warning',async()=>{
 const fixture=setup(new DOMException('permission expired','NotAllowedError'));
 await saveDocumentHTML(fixture.record,'first',fixture.operations);let written;
 fixture.operations.external=async (_record,html)=>{written=html;};
 await saveDocumentHTML(fixture.record,'latest',fixture.operations);
 assert.equal(written,'latest');assert.equal(fixture.record.diskPending,false);assert.equal(fixture.read().saved.diskPending,false);assert.equal(fixture.read().saved.diskError,null);
});

test('external conflict and disk errors remain visible without discarding the internal recovery copy',async()=>{
 for(const error of [new Error('file changed outside the app'),new DOMException('full','QuotaExceededError')]){
  const fixture=setup(error);await saveDocumentHTML(fixture.record,'recoverable',fixture.operations);
  assert.equal(fixture.read().saved.html,'recoverable');assert.equal(fixture.record.diskPending,true);assert.equal(fixture.record.diskError.message,error.message);assert.deepEqual(fixture.record.diskStamp,{modified:123,size:10});
 }
});

test('an actual internal persistence failure still fails the queue and never writes the external file',async()=>{
 const fixture=setup();fixture.operations.put=async()=>{throw Error('IndexedDB full');};
 const queue=new SaveQueue(()=>saveDocumentHTML(fixture.record,'data',fixture.operations));queue.schedule();await assert.rejects(queue.flush(),/IndexedDB full/);
 assert.equal(queue.pending,true);assert.equal(fixture.read().externalWrites,0);
});

test('internal-only documents do not get a misleading external-file warning',async()=>{
 const fixture=setup();fixture.record.fileHandle=null;fixture.record.diskError={name:'OldError',message:'old'};
 await saveDocumentHTML(fixture.record,'data',fixture.operations);
 assert.equal(fixture.record.diskPending,false);assert.equal(fixture.record.diskError,null);assert.equal(fixture.read().externalWrites,0);
});
