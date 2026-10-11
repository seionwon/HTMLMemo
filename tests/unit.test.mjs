import test from 'node:test';
import assert from 'node:assert/strict';
import { History, SaveQueue, validateAnnotations } from '../public/src/model.js';
import { normalizeURL, filename } from '../public/src/utils.js';
test('URLs support domains, local ports and search, reject executable schemes',()=>{
  assert.equal(normalizeURL('example.com/docs'),'https://example.com/docs');assert.equal(normalizeURL('localhost:4173/example.html'),'http://localhost:4173/example.html');assert.equal(normalizeURL('127.0.0.1:5000/a'),'http://127.0.0.1:5000/a');assert.match(normalizeURL('천천히 읽기'),/^https:\/\/www.google.com\/search\?q=/);
  for(const url of ['javascript:alert(1)','file:///etc/passwd','data:text/html,test','https://user:pass@example.com',''])assert.throws(()=>normalizeURL(url));
});
test('filenames are portable and bounded',()=>{assert.equal(filename('a/b:c*?<>"|'),'a_b_c______.html');assert.ok(filename('x'.repeat(300)).length<=105);});
test('history branches after undo and never shares mutable arrays',()=>{
  const history=new History([{id:'a'}]);history.commit([{id:'a'},{id:'b'}]);history.commit([{id:'c'}]);assert.deepEqual(history.undo(),[{id:'a'},{id:'b'}]);history.commit([{id:'d'}]);assert.equal(history.canRedo,false);const returned=history.current;returned[0].id='changed';assert.equal(history.current[0].id,'d');
});
test('history keeps a bounded undo window',()=>{const h=new History();for(let i=0;i<300;i++)h.commit([{i}]);assert.equal(h.entries.length,101);for(let i=0;i<101;i++)h.undo();assert.equal(h.current[0].i,199);});
test('save queue drains new edits arriving during a slow write',async()=>{
  let release;const gate=new Promise(resolve=>release=resolve);const written=[];
  const queue=new SaveQueue(async revision=>{written.push(revision);if(revision===1)await gate;});queue.schedule();const flushing=queue.flush();queue.schedule();queue.schedule();release();await flushing;assert.deepEqual(written,[1,3]);assert.equal(queue.pending,false);
});
test('save queue exposes failures, remains pending and retries without data loss',async()=>{
  let failing=true;let writes=0;const queue=new SaveQueue(async()=>{writes++;if(failing)throw new Error('disk full');});queue.schedule();await assert.rejects(queue.flush(),/disk full/);assert.equal(queue.pending,true);assert.match(queue.error.message,/disk full/);failing=false;await queue.flush();assert.equal(queue.pending,false);assert.equal(queue.error,null);assert.equal(writes,2);
});
test('concurrent flushes serialize writes',async()=>{let running=0;let max=0;const queue=new SaveQueue(async()=>{running++;max=Math.max(max,running);await new Promise(r=>setTimeout(r,10));running--;});queue.schedule();await Promise.all([queue.flush(),queue.flush(),queue.flush()]);assert.equal(max,1);});
test('annotation validation rejects damaged data instead of silently erasing it',()=>{
  const annotation={id:'x',type:'highlight',color:'#edcf67',width:3,opacity:.35,textAnchor:{start:0,end:5,quote:'hello'}};assert.equal(validateAnnotations([annotation]).length,1);
  for(const data of [[annotation,annotation],[{...annotation,color:'url(evil)'}],[{...annotation,width:NaN}],[{...annotation,textAnchor:{start:-1,end:2,quote:'bad'}}],[{...annotation,type:'script'}],[{...annotation,type:'pen',points:[{x:Infinity,y:1}]}]])assert.throws(()=>validateAnnotations(data));
});
