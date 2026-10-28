import test from 'node:test';
import assert from 'node:assert/strict';
import {SyncStream,SYNC_FRAME_BYTES,SYNC_WINDOW_BYTES} from '../public/src/sync-stream.js';
import {localFileIdentity} from '../public/src/local-files.js';
import {DeviceSyncService} from '../public/src/sync-device-service.js';
import {DirectSyncConnection} from '../public/src/sync-peer.js';

class MemoryTemp{
 constructor(){this.files=new Map();this.closed=false;this.writes=[];}
 async open(){return this;}
 async append(file,part,blob){if(this.closed)throw Error('closed');this.writes.push({file,size:blob.size});if(!this.files.has(file))this.files.set(file,[]);this.files.get(file)[part]=blob;}
 async blob(file,mime){return new Blob(this.files.get(file)||[],{type:mime});}
 async clear(){this.closed=true;this.files.clear();}
}
async function bundle(size=3*1024*1024+37){
 const blob=new Blob([new Uint8Array(size).fill(63)],{type:'text/html'}),identity=await localFileIdentity(blob);
 const record={id:'streamed',title:'조각 전송',name:'streamed.html',created:1000,modified:2000,sourceIdentity:identity,metadata:{version:1,view:{scrollTop:0},viewport:{width:1000,height:800},annotations:[],bookmarks:[]}};
 return {files:new Map([[1,blob]]),manifest:{format:'HTMLMemo.sync',version:2,files:[{id:1,size,mime:'text/html',identity}],documents:[{record,revisions:[],body:1,original:1,sourceType:'file'}],folders:[],settings:null,logs:[]}};
}
function pair({corrupt=false,onBundle=async()=>{},dropAck=false,findFiles=null,legacy=false}={}){
 const stores=[],errors=[],frames=[],progress=[],sentProgress=[],committed=[];let left,right,q1=Promise.resolve(),q2=Promise.resolve(),changed=false;
 const abort=error=>{errors.push(error);left.destroy();right.destroy();};
 left=new SyncStream({send:async data=>{
   let value=data;if(legacy&&typeof data==='string'){const message=JSON.parse(data);delete message.reuseFiles;delete message.commitAck;value=JSON.stringify(message);}if(data instanceof ArrayBuffer){frames.push(data.byteLength);if(corrupt&&!changed){changed=true;value=data.slice(0);new Uint8Array(value)[0]^=1;}}
   q2=q2.then(()=>right.receive(value)).catch(abort);
 },onBundle:async()=>{},onCommitted:()=>{},onProgress:p=>sentProgress.push(p),storeFactory:()=>{const s=new MemoryTemp();stores.push(s);return s;}});
 right=new SyncStream({send:async data=>{if(dropAck&&typeof data==='string'&&JSON.parse(data).type==='ack')return;q1=q1.then(()=>left.receive(data)).catch(abort);},onBundle,findFiles,onCommitted:value=>committed.push(value),onProgress:p=>progress.push(p),storeFactory:()=>{const s=new MemoryTemp();stores.push(s);return s;}});
 return {left,right,stores,errors,frames,progress,sentProgress,committed,async settle(){await q1;await q2;},close(){left.destroy();right.destroy();}};
}
test('stream frames stay at 16 KiB and wait for each persisted 1 MiB window',async()=>{
 const data=await bundle(),committed=[],p=pair({onBundle:async value=>committed.push(value)});
 try{await p.left.sendBundle(data);await p.settle();assert.equal(committed.length,1);assert.deepEqual(await localFileIdentity(committed[0].files.get(1)),data.manifest.files[0].identity);assert.ok(p.frames.length>190);assert.equal(Math.max(...p.frames),SYNC_FRAME_BYTES);assert.ok(p.right.maxPendingBytes<=SYNC_WINDOW_BYTES);assert.equal(p.errors.length,0);assert.ok(p.progress.every((v,i)=>!i||v.bytes>=p.progress[i-1].bytes));assert.ok(p.stores.every(s=>s.closed));}finally{p.close();}
});
test('corruption never reaches library merge and releases all temporary parts',async()=>{
 let writes=0;const p=pair({corrupt:true,onBundle:async()=>writes++});try{await assert.rejects(p.left.sendBundle(await bundle(100000)));await p.settle();assert.equal(writes,0);assert.match(p.errors[0].message,/검증/);assert.ok(p.stores.every(s=>s.closed));}finally{p.close();}
});
test('closing a stalled transfer rejects pending acknowledgements and preserves the library',async()=>{
 let writes=0;const p=pair({dropAck:true,onBundle:async()=>writes++});const sending=p.left.sendBundle(await bundle(1));await new Promise(resolve=>setImmediate(resolve));p.close();await assert.rejects(sending,{name:'AbortError'});assert.equal(writes,0);await p.settle();assert.ok(p.stores.every(s=>s.closed));
});

test('a relay connection without a host stays waiting and reports a bounded handshake timeout',async t=>{
 const previousFetch=globalThis.fetch,previousSocket=globalThis.WebSocket,states=[];let service;
 t.after(()=>{service?.destroy();globalThis.fetch=previousFetch;globalThis.WebSocket=previousSocket;});
 globalThis.fetch=async()=>({ok:true});globalThis.WebSocket=class{static OPEN=1;constructor(){this.readyState=0;queueMicrotask(()=>{this.readyState=1;this.onopen?.()})}send(){}close(){this.readyState=3;this.onclose?.({code:1000})}};
 t.mock.timers.enable({apis:['setTimeout','setInterval']});
 service=new DeviceSyncService({adapter:{},onStatusChange:(state,message)=>states.push({state,message}),onDataReceived:()=>{assert.fail('No host has sent any data');}});
 await service.connect('HM-NOBODY-IS-HERE');assert.equal(states.at(-1).state,'waiting');assert.ok(!states.some(v=>v.state==='connected'));
 t.mock.timers.tick(30001);assert.equal(states.at(-1).state,'error');assert.match(states.at(-1).message,/상대 기기의 응답/);
});

test('identical local originals send metadata only and do not write original bytes to temporary storage',async()=>{
 const data=await bundle(),received=[],p=pair({findFiles:async()=>new Map(data.files),onBundle:async value=>received.push(value)});
 try{
  const result=await p.left.sendBundle(data);await p.settle();assert.equal(result.committed,true);assert.equal(received.length,1);assert.equal(received[0].files.get(1),data.files.get(1));
  assert.ok(p.frames.reduce((a,b)=>a+b,0)<5000);assert.ok(p.stores.every(store=>store.writes.every(write=>write.file===0)));
  assert.equal(p.sentProgress.at(-1).reusedBytes,data.files.get(1).size);assert.equal(p.sentProgress.at(-1).reusedFiles,1);assert.equal(p.progress.at(-1).reusedBytes,data.files.get(1).size);assert.equal(p.errors.length,0);
 }finally{p.close();}
});
test('mixed synchronization sends only missing bytes while both local and new originals reach the commit',async()=>{
 const data=await bundle(8192),fresh=new Blob([new Uint8Array(16385).fill(7)],{type:'text/html'}),identity=await localFileIdentity(fresh);
 data.files.set(2,fresh);data.manifest.files.push({id:2,size:fresh.size,mime:fresh.type,identity});
 const next=structuredClone(data.manifest.documents[0]);next.record.id='new-file';next.record.sourceIdentity=identity;next.body=2;next.original=2;data.manifest.documents.push(next);
 const received=[],p=pair({findFiles:async()=>new Map([[1,data.files.get(1)]]),onBundle:async value=>received.push(value)});
 try{
  assert.equal((await p.left.sendBundle(data)).committed,true);await p.settle();assert.equal(received[0].files.size,2);assert.deepEqual(await localFileIdentity(received[0].files.get(2)),identity);
  assert.equal(p.frames.reduce((a,b)=>a+b,0),new Blob([JSON.stringify(data.manifest)]).size+fresh.size);assert.ok(p.stores.every(store=>!store.writes.some(write=>write.file===1)));assert.equal(p.errors.length,0);
 }finally{p.close();}
});
test('a false local match falls back to full transfer and legacy peers never negotiate reuse or direct completion',async()=>{
 const data=await bundle(200000);
 for(const legacy of [false,true]){
  let lookups=0;const p=pair({legacy,findFiles:async()=>{lookups++;return new Map([[1,new Blob([new Uint8Array(200000).fill(9)],{type:'text/html'})]]);}});
  try{const result=await p.left.sendBundle(data);await p.settle();assert.ok(p.frames.reduce((a,b)=>a+b,0)>200000);assert.equal(result.committed,!legacy);assert.equal(lookups,legacy?0:1);assert.equal(p.sentProgress.at(-1).reusedFiles,0);assert.equal(p.errors.length,0);}finally{p.close();}
 }
});
test('the final acknowledgement and completed progress wait for the receiver database commit',async()=>{
 let announce,release;const started=new Promise(resolve=>announce=resolve),saved=new Promise(resolve=>release=resolve),p=pair({onBundle:async()=>{announce();await saved;}});let finished=false;
 try{
  const sending=p.left.sendBundle(await bundle(2000)).then(result=>{finished=true;return result;});await started;
  assert.equal(finished,false);assert.equal(p.sentProgress.at(-1).phase,'commit');assert.ok(!p.sentProgress.some(progress=>progress.complete));
  release();assert.equal((await sending).committed,true);await p.settle();assert.equal(p.sentProgress.at(-1).complete,true);assert.equal(p.committed[0].confirmed,true);
 }finally{release();p.close();}
});
test('a partial transfer acknowledges a required annotation reply before completing both devices',async()=>{
 const p=pair({onBundle:async()=>({replyRequired:true})});
 try{const result=await p.left.sendBundle(await bundle(2000),{partial:true});await p.settle();assert.equal(result.committed,true);assert.equal(result.replyRequired,true);assert.equal(p.committed[0].partial,true);assert.equal(p.committed[0].replyRequired,true);}finally{p.close();}
});
test('the sender waits for a chosen partial reply and the receiver sends only those document IDs',async()=>{
 for(const replyRequired of [true,false]){
  let completed=0;const service=new DeviceSyncService({adapter:{getSyncTargetIds:async()=>['selected'],getStreamBundle:async ids=>{assert.deepEqual(ids,['selected']);return {}; }},onStatusChange:()=>{},onDataReceived:()=>{}});
  service.isHost=true;service.stream={sendBundle:async()=>({committed:true,replyRequired}),destroy(){}};service.confirmCompletion=async()=>{completed++;};
  try{await service.syncDirectData();assert.equal(completed,replyRequired?0:1);}finally{service.destroy();}
 }
 let completed=0;const service=new DeviceSyncService({adapter:{annotationReplyIds:()=>['chosen'],getSyncTargetIds:()=>assert.fail('A selected reply must not send the whole library'),getStreamBundle:async ids=>{assert.deepEqual(ids,['chosen']);return {}; }},onStatusChange:()=>{},onDataReceived:()=>{}});
 service.isHost=false;service.receivedPartial=true;service.hasReceivedData=true;service.stream={sendBundle:async(_bundle,options)=>{assert.equal(options.partial,true);return {committed:true};},destroy(){}};service.confirmCompletion=async()=>{completed++;};
 try{await service.syncDirectData();assert.equal(completed,1);}finally{service.destroy();}
});
test('closing while matching local files never commits a partial synchronization',async()=>{
 let announce,release;const started=new Promise(resolve=>announce=resolve),ready=new Promise(resolve=>release=resolve);let writes=0;
 const p=pair({findFiles:async()=>{announce();await ready;return new Map();},onBundle:async()=>writes++});
 try{const sending=p.left.sendBundle(await bundle(1000));await started;p.close();release();await assert.rejects(sending,{name:'AbortError'});await p.settle();assert.equal(writes,0);assert.ok(p.stores.every(store=>store.closed));}finally{release();p.close();}
});
test('confirmed direct completion does not depend on relay availability',async()=>{
 const states=[];let calls=0,done=0;const service=new DeviceSyncService({adapter:{},onStatusChange:(state,message)=>states.push({state,message}),onDataReceived:()=>done++});
 service.sendSignal=async()=>{calls++;throw Error('Relay unavailable after file transfer');};
 try{await service.confirmCompletion({direct:true});assert.equal(calls,0);assert.equal(states.at(-1).state,'completed');assert.equal(states.at(-1).message,'전송이 완료되었습니다. 이 화면은 닫아도 됩니다.');assert.equal(done,1);}finally{service.destroy();}
});
test('legacy completion cannot wait forever for an unresponsive relay',async t=>{
 const states=[];const service=new DeviceSyncService({adapter:{},onStatusChange:(state,message)=>states.push({state,message}),onDataReceived:()=>assert.fail('No completion was confirmed')});
 service.sendSignal=()=>new Promise(()=>{});t.mock.timers.enable({apis:['setTimeout']});
 try{const finishing=service.confirmCompletion();t.mock.timers.tick(15001);await finishing;assert.equal(states.at(-1).state,'error');assert.match(states.at(-1).message,/저장은 끝났지만/);}finally{service.destroy();}
});
test('successful close drains the data channel before closing the peer connection',()=>{
 const channel=new EventTarget();let channels=0,peers=0;channel.readyState='open';channel.close=()=>{channels++;channel.readyState='closing';};
 const peer=Object.create(DirectSyncConnection.prototype);peer.pc={close:()=>peers++};peer.channel=channel;peer.destroy({graceful:true});
 assert.equal(channels,1);assert.equal(peers,0);channel.dispatchEvent(new Event('close'));assert.equal(peers,1);
});
