import test from 'node:test';
import assert from 'node:assert/strict';
import {Reader} from '../public/src/reader.js';
import {documentFor,installDOM} from './dom.mjs';
installDOM();
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture({scripted=true}={}) {
  const doc=documentFor('<html><head></head><body><article id="reader-content" data-section="part"></article></body></html>'),r=Object.create(Reader.prototype),errors=[],jumps=[],notices=[];
  r.doc=doc;r.metadata={execution:{allowScripts:scripted},annotations:[{id:'saved-note',type:'note',text:'보관할 주석',anchorTarget:{section:'part'}}]};r.annotationLocation=()=>null;r.annotationBookPaths=()=>new Map([['part',[]],['other',[]]]);
  r.callbacks={onError:error=>errors.push(error.message),onNotice:value=>notices.push(value)};r.jump=node=>jumps.push(node);r.measure=()=>{};r.refreshDynamicDocument=async()=>{};
  r.render=()=>{const target=doc.querySelector('#target');if(target&&!doc.querySelector('[data-htmlmemo-id]')){const marker=doc.createElement('span');marker.dataset.htmlmemoId='saved-note';marker.textContent='메모';target.append(marker);}};
  return {r,doc,errors,jumps,notices,insert(){doc.getElementById('reader-content').innerHTML='<p id="target">원문입니다.</p>';}};
}
test('first-import annotation clicks wait for a delayed target in the current section without requiring reopen',async()=>{
  const f=fixture(),before=structuredClone(f.r.metadata);let finished=false;const pending=f.r.jumpAnnotation('saved-note').then(value=>{finished=true;return value;});await tick();assert.equal(finished,false);assert.deepEqual(f.errors,[]);
  f.insert();assert.equal(await pending,true);assert.equal(f.jumps.length,1);assert.deepEqual(f.errors,[]);assert.deepEqual(f.r.metadata,before);assert.equal(f.r.cancelAnnotationJump,null);
});
test('a changed section key does not count as loaded before its body and readiness flag are restored',async()=>{
  const f=fixture();f.r.metadata.annotations[0].anchorTarget.section='other';const view=f.doc.defaultView;
  Object.defineProperty(f.doc,'defaultView',{value:{MutationObserver:view.MutationObserver,location:{set hash(value){f.doc.getElementById('reader-content').dataset.section=decodeURIComponent(value);f.doc.documentElement.dataset.readerReady='false';}}}});
  let finished=false;const pending=f.r.jumpAnnotation('saved-note').then(value=>{finished=true;return value;});await tick();assert.equal(finished,false);assert.deepEqual(f.errors,[]);f.insert();await tick();assert.equal(finished,false);f.doc.documentElement.dataset.readerReady='true';assert.equal(await pending,true);assert.equal(f.jumps.length,1);assert.deepEqual(f.errors,[]);
});
test('annotation navigation awaits an already-running dynamic restoration instead of racing its first render',async()=>{
  const f=fixture();let release,started=0;delete f.r.refreshDynamicDocument;f.r.refreshDynamicDocumentNow=async()=>{started++;await new Promise(resolve=>release=resolve);f.insert();};
  const first=f.r.refreshDynamicDocument(),second=f.r.refreshDynamicDocument();let finished=false;const pending=f.r.jumpAnnotation('saved-note').then(value=>{finished=true;return value;});await tick();assert.equal(started,1);assert.equal(finished,false);release();await Promise.all([first,second]);assert.equal(await pending,true);assert.equal(started,1);assert.equal(f.r.dynamicTask,null);assert.deepEqual(f.errors,[]);
});
test('a newer click cancels the previous wait and late content cannot steal the reading position',async()=>{
  const f=fixture();f.r.metadata.annotations.push({id:'already-here',anchorTarget:{section:'part'}});const node=f.doc.createElement('span');node.dataset.htmlmemoId='already-here';f.doc.body.append(node);
  const old=f.r.jumpAnnotation('saved-note');assert.equal(await f.r.jumpAnnotation('already-here'),true);assert.equal(await old,false);f.insert();await tick();assert.equal(f.jumps.length,1);assert.equal(f.jumps[0],node);assert.deepEqual(f.errors,[]);assert.equal(f.r.metadata.annotations.length,2);
});
test('genuinely missing static targets report an error without deleting notes or guessing another paragraph',async()=>{
  const f=fixture({scripted:false}),before=structuredClone(f.r.metadata);assert.equal(await f.r.jumpAnnotation('saved-note'),false);assert.match(f.errors[0],/원문 위치/);assert.equal(f.jumps.length,0);assert.deepEqual(f.r.metadata,before);
});
test('disposal cancels a pending target wait and releases its observer and timeout',async()=>{
  const f=fixture(),pending=f.r.jumpAnnotation('saved-note');await tick();f.r.disposed=true;f.r.cancelAnnotationJump();assert.equal(await pending,false);f.insert();await tick();assert.equal(f.jumps.length,0);assert.deepEqual(f.errors,[]);assert.equal(f.r.cancelAnnotationJump,null);
});
test('a saved ready flag without a loaded first chapter cannot finish opening a packed export',async()=>{
  const f=fixture();f.r.bookIntegrity={complete:true};f.doc.documentElement.dataset.readerReady='true';let finished=false;const pending=f.r.waitForBookContent().then(()=>finished=true);await tick();assert.equal(finished,false);f.insert();await pending;assert.equal(finished,true);assert.equal(f.r.cancelOpeningWait,null);
});
test('legacy annotation IDs containing selector punctuation still navigate by their exact ID',async()=>{
  const f=fixture();f.r.metadata.annotations[0].id='legacy"[주석]';const node=f.doc.createElement('span');node.setAttribute('data-htmlmemo-id','legacy"[주석]');f.doc.body.append(node);assert.equal(await f.r.jumpAnnotation('legacy"[주석]'),true);assert.equal(f.jumps[0],node);assert.deepEqual(f.errors,[]);
});
