import test from 'node:test';
import assert from 'node:assert/strict';
import {SyncStream,SYNC_FRAME_BYTES,SYNC_WINDOW_BYTES} from '../public/src/sync-stream.js';
import {localFileIdentity} from '../public/src/local-files.js';
import {DeviceSyncService} from '../public/src/sync-device-service.js';

class MemoryTemp{
 constructor(){this.files=new Map();this.closed=false;}
 async open(){return this;}
 async append(file,part,blob){if(this.closed)throw Error('closed');if(!this.files.has(file))this.files.set(file,[]);this.files.get(file)[part]=blob;}
 async blob(file,mime){return new Blob(this.files.get(file)||[],{type:mime});}
 async clear(){this.closed=true;this.files.clear();}
}
async function bundle(size=3*1024*1024+37){
 const blob=new Blob([new Uint8Array(size).fill(63)],{type:'text/html'}),identity=await localFileIdentity(blob);
 const record={id:'streamed',title:'조각 전송',name:'streamed.html',created:1000,modified:2000,sourceIdentity:identity,metadata:{version:1,view:{scrollTop:0},viewport:{width:1000,height:800},annotations:[],bookmarks:[]}};
 return {files:new Map([[1,blob]]),manifest:{format:'HTMLMemo.sync',version:2,files:[{id:1,size,mime:'text/html',identity}],documents:[{record,revisions:[],body:1,original:1,sourceType:'file'}],folders:[],settings:null,logs:[]}};
}
function pair({corrupt=false,onBundle=async()=>{},dropAck=false}={}){
 const stores=[],errors=[],frames=[],progress=[];let left,right,q1=Promise.resolve(),q2=Promise.resolve(),changed=false;
 const abort=error=>{errors.push(error);left.destroy();right.destroy();};
 left=new SyncStream({send:async data=>{
   let value=data;if(data instanceof ArrayBuffer){frames.push(data.byteLength);if(corrupt&&!changed){changed=true;value=data.slice(0);new Uint8Array(value)[0]^=1;}}
   q2=q2.then(()=>right.receive(value)).catch(abort);
 },onBundle:async()=>{},onCommitted:()=>{},storeFactory:()=>{const s=new MemoryTemp();stores.push(s);return s;}});
 right=new SyncStream({send:async data=>{if(dropAck&&typeof data==='string'&&JSON.parse(data).type==='ack')return;q1=q1.then(()=>left.receive(data)).catch(abort);},onBundle,onCommitted:()=>{},onProgress:p=>progress.push(p),storeFactory:()=>{const s=new MemoryTemp();stores.push(s);return s;}});
 return {left,right,stores,errors,frames,progress,async settle(){await q1;await q2;},close(){left.destroy();right.destroy();}};
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
 t.mock.timers.tick(30001);assert.equal(states.at(-1).state,'error');assert.match(states.at(-1).message,/基準|기준 기기의 응답/);
});
