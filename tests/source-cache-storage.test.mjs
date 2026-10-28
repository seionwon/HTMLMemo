import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceCacheFixture} from './source-cache-fixture.mjs';
import {localFileIdentity,sameLocalFile} from '../public/src/local-files.js';
import {portableRecord} from '../public/src/data-folder.js';

test('repeated stored-source reads retain the verified immutable Blob across annotation-only syncs',async()=>{
  const f=sourceCacheFixture(),first=await f.api.getDocument('book');let reads=0;const slice=first.file.slice.bind(first.file);
  first.file.slice=(...args)=>{reads++;return slice(...args);};const identity=await localFileIdentity(first.file),bodyReads=f.reads.filter(n=>n==='contents').length;
  await f.api.putDocumentView('book',{scrollTop:400});let current=await f.api.getDocument('book');assert.strictEqual(current.file,first.file);assert.equal(current.metadata.view.scrollTop,400);
  const record=structuredClone(portableRecord(current));record.metadata.annotations=[{id:'note'}];
  await f.api.commitDeviceSync([{record,content:null,revisions:[],expected:f.api.syncRecordSnapshot(current),previousHistoryVersion:0}],[],[]);
  current=await f.api.getDocument('book');assert.strictEqual(current.file,first.file);assert.deepEqual(await localFileIdentity(current.file),identity);assert.equal(reads,1);assert.equal(f.reads.filter(n=>n==='contents').length,bodyReads);assert.ok(current.syncEpoch);assert.equal(current.contentKey,first.contentKey);assert.equal(portableRecord(current).contentKey,undefined);
});
test('replacing source bytes invalidates the cache even with forged identical source metadata and a reused requested key',async()=>{
  const f=sourceCacheFixture({file:new Blob(['AAA'],{type:'text/html'})}),first=await f.api.getDocument('book'),identity=await localFileIdentity(first.file);
  const record=portableRecord(first);record.contentKey=first.contentKey;record.sourceIdentity=identity;
  const content={file:new Blob(['BBB'],{type:'text/html'}),originalFile:new Blob(['BBB'],{type:'text/html'})};
  await f.api.commitDeviceSync([{record,content,revisions:[],expected:f.api.syncRecordSnapshot(first)}],[],[]);
  const next=await f.api.getDocument('book');assert.notStrictEqual(next.file,first.file);assert.notEqual(next.contentKey,first.contentKey);assert.equal(sameLocalFile(await localFileIdentity(next.file),identity),false);
  content.file=new Blob(['CCC']);assert.equal(await(await f.api.getDocument('book')).file.text(),'BBB','mutating the caller object cannot mutate retained content');
});
test('failed source replacement never publishes an uncommitted cache entry',async()=>{
  const f=sourceCacheFixture(),first=await f.api.getDocument('book');f.control.fail='contents';
  await assert.rejects(f.api.commitDeviceSync([{record:portableRecord(first),content:{file:new Blob(['new'])},revisions:[],expected:f.api.syncRecordSnapshot(first)}],[],[]),/Disk full/);
  const current=await f.api.getDocument('book');assert.strictEqual(current.file,first.file);assert.equal(current.contentKey,first.contentKey);
});
test('existing books acquire an opaque cache key without rewriting source or history',async()=>{
  const f=sourceCacheFixture({key:null}),first=await f.api.getDocument('book');assert.ok(first.contentKey);assert.deepEqual(f.writes,['documents']);const next=await f.api.getDocument('book');assert.strictEqual(next.file,first.file);assert.equal(next.contentKey,first.contentKey);
});
test('prepared HTML blobs are reused only when attached to actual stored content',async()=>{
  const f=sourceCacheFixture();f.stores.get('contents').set('book',{documentId:'book',html:'<p>Prepared HTML</p>'});
  const first=await f.api.getDocument('book'),next=await f.api.getDocument('book');assert.strictEqual(f.api.documentSource(first),f.api.documentSource(next));assert.equal(await f.api.documentSource(first).text(),first.html);
  const fake={...first,html:'<p>Changed HTML</p>'};assert.equal(await f.api.documentSource(fake).text(),fake.html);assert.notStrictEqual(f.api.documentSource(fake),f.api.documentSource(first));
});
test('deletion and folder restore cannot reuse an earlier content key or satisfy its old commit guard',async()=>{
  const f=sourceCacheFixture(),first=await f.api.getDocument('book'),expected=f.api.syncRecordSnapshot(first);
  f.stores.get('documents').delete('book');f.stores.get('contents').delete('book');
  await f.api.restoreFolderDocuments([{record:{...portableRecord(first),contentKey:first.contentKey},content:{file:new Blob(['replacement'])},revisions:[]}]);
  const restored=await f.api.getDocument('book');assert.notEqual(restored.contentKey,first.contentKey);assert.equal(await restored.file.text(),'replacement');
  await assert.rejects(f.api.commitDeviceSync([{record:portableRecord(first),content:null,revisions:[],expected}],[],[]),/다른 창/);assert.equal(await(await f.api.getDocument('book')).file.text(),'replacement');
});
