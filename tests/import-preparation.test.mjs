import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {SaveQueue,AnnotationCheckpoints} from '../public/src/model.js';
const source=await readFile(new URL('../public/src/app.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('async function openRecord('),source.indexOf('function saveStatus('));
const identity={version:1,size:123,digest:'a'.repeat(64)};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function setup(t){
  let resolve,reject;const fingerprint=new Promise((yes,no)=>{resolve=yes;reject=no;});
  const writes=[];let disposed=0;
  class Reader{
    constructor(host,parsed,callbacks){this.metadata=structuredClone(parsed.metadata);this.ready=Promise.resolve();this.callbacks=callbacks;}
    dispose(){disposed++;}
  }
  const metadata={title:'Book',source:'',annotations:[{id:'imported',text:'Original note'}],bookmarks:[],view:{zoom:1}};
  const parsed={file:new Blob(['<body>Book</body>']),metadata,nativeScroll:true};
  const record={id:'book',title:'Book',file:parsed.file,metadata};
  const context=vm.createContext({Reader,SaveQueue,AnnotationCheckpoints,structuredClone,uid:()=> 'tab',createHost:()=>({}),activate:()=>{},renderTabs:()=>{},renderToolbar:()=>{},updateChrome:()=>{},preferences:{annotation:{}},checkpointAnnotations:async()=>{},
    promptText:()=>{},handleKey:()=>{},showError:()=>{},renderFolderState:()=>{},dataFolder:null,
    putDocumentRevision:async value=>{writes.push({kind:'baseline',record:structuredClone(value)});return {byteSize:parsed.file.size};},
    putDocumentView:async(id,view)=>{writes.push({kind:'view'});return {...record,sourceIdentity:identity,metadata:{...metadata,view}};},
    saveDocumentHTML:async value=>{writes.push({kind:'edit',record:structuredClone(value)});},
  });
  vm.runInContext('var tabs=[],records=[],activeId="library";'+code,context);
  t.after(()=>context.tabs.forEach(tab=>tab.checkpoints?.dispose()));
  return {context,record,parsed,fingerprint,resolve,reject,writes,get disposed(){return disposed;}};
}
test('reader preparation overlaps fingerprinting but edits wait and preserve the imported baseline',async t=>{
  const a=setup(t),opening=a.context.openRecord(a.record,a.parsed,{sourceIdentity:a.fingerprint});await tick();
  const tab=a.context.tabs[0];tab.reader.metadata.annotations.push({id:'new',text:'Edit while fingerprinting'});tab.reader.callbacks.onChange();
  const saving=tab.queue.flush();await tick();assert.deepEqual(a.writes,[]);
  a.resolve(identity);await opening;await saving;
  assert.deepEqual(a.writes.map(write=>write.kind),['baseline','edit']);
  assert.deepEqual(a.writes[0].record.metadata.annotations,[{id:'imported',text:'Original note'}]);
  assert.deepEqual(a.writes[1].record.metadata.annotations.map(note=>note.id),['imported','new']);
  assert.deepEqual(a.writes[0].record.sourceIdentity,identity);assert.deepEqual(a.writes[1].record.sourceIdentity,identity);
});
test('early view saves wait for the fingerprint and initial source persistence',async t=>{
  const a=setup(t),opening=a.context.openRecord(a.record,a.parsed,{sourceIdentity:a.fingerprint});await tick();
  const tab=a.context.tabs[0];tab.queue.schedule({background:true});const saving=tab.queue.flush();await tick();assert.deepEqual(a.writes,[]);
  a.resolve(identity);await opening;await saving;assert.deepEqual(a.writes.map(write=>write.kind),['baseline','view']);
});
test('failed fingerprinting disposes the unfinished reader and never saves an identity-free document',async t=>{
  const a=setup(t),opening=a.context.openRecord(a.record,a.parsed,{sourceIdentity:a.fingerprint});await tick();
  const rejected=assert.rejects(opening,/read failed/);a.reject(Error('read failed'));await rejected;
  assert.equal(a.context.tabs.length,0);assert.equal(a.disposed,1);assert.deepEqual(a.writes,[]);
});
test('a reading-position change immediately updates folder status without turning it into an annotation edit',async t=>{
  const a=setup(t);let reports=0;a.context.renderFolderState=()=>reports++;
  const opening=a.context.openRecord(a.record,a.parsed,{sourceIdentity:a.fingerprint});a.resolve(identity);const tab=await opening;const before=reports;
  tab.reader.callbacks.onPosition();assert.equal(reports,before+1);assert.equal(tab.queue.pending,true);assert.equal(tab.queue.editsPending,false);await tab.queue.flush();
});
