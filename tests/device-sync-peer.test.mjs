import test from 'node:test';
import assert from 'node:assert/strict';
import {DirectSyncConnection} from '../public/src/sync-peer.js';
import {DeviceSyncService} from '../public/src/sync-device-service.js';
import {encryptData} from '../public/src/sync-crypto.js';

function fixture(t){
 const old=globalThis.RTCPeerConnection,pcs=[],packets=[],pending=[],errors=[],opens=[],retries=[];
 class Channel extends EventTarget{
  constructor(){super();this.readyState='connecting';this.bufferedAmount=0;this.sent=[];}
  close(){this.readyState='closed';this.onclose?.();this.dispatchEvent(new Event('close'));}
  send(data){assert.equal(this.readyState,'open');this.sent.push(data);}
  open(){this.readyState='open';this.onopen?.();}
 }
 globalThis.RTCPeerConnection=class{
  constructor(config){this.config=config;this.connectionState='new';this.added=[];this.id=pcs.length;pcs.push(this);}
  createDataChannel(){return new Channel();}
  async createOffer(){return {type:'offer',sdp:'offer-'+this.id};}
  async createAnswer(){return {type:'answer',sdp:'answer-'+this.id};}
  async setLocalDescription(value){this.localDescription={...value,toJSON:()=>value};}
  async setRemoteDescription(value){this.remoteDescription=value;}
  async addIceCandidate(candidate){assert.ok(this.remoteDescription);this.added.push(candidate);}
  close(){this.connectionState='closed';this.onconnectionstatechange?.();}
 };
 t.mock.timers.enable({apis:['setTimeout']});
 let left,right;
 const options=side=>({signal:async message=>{packets.push({side,message});pending.push({target:side==='left'?right:left,message});},onOpen:()=>opens.push(side),onMessage:()=>{},onRetry:()=>retries.push(side),onError:error=>errors.push({side,error})});
 left=new DirectSyncConnection(options('left'));right=new DirectSyncConnection(options('right'));
 t.after(()=>{left.destroy();right.destroy();globalThis.RTCPeerConnection=old;});
 const settle=async()=>{for(let i=0;i<100;i++){await new Promise(resolve=>setImmediate(resolve));if(!pending.length)return;while(pending.length){const {target,message}=pending.shift();await target.receive(message);}}throw Error('Negotiation did not settle');};
 const connect=async()=>{await left.offer();await settle();};
 const fail=peer=>{peer.pc.connectionState='failed';peer.pc.onconnectionstatechange();};
 const open=()=>{right.pc.ondatachannel({channel:new Channel()});for(const peer of [left,right]){peer.pc.connectionState='connected';peer.pc.onconnectionstatechange();peer.channel.open();}};
 return {left,right,pcs,packets,errors,opens,retries,settle,connect,fail,open};
}

test('initial failures on either device rebuild both peers once before starting any transfer',async t=>{
 const f=fixture(t);await f.connect();const previous=[f.left.pc,f.right.pc];assert.deepEqual(f.opens,[]);f.fail(f.right);await f.settle();
 assert.equal(f.pcs.length,4);assert.ok(previous.every(pc=>pc.connectionState==='closed'));assert.equal(f.left.attempt,1);assert.equal(f.right.attempt,1);assert.deepEqual(f.retries.sort(),['left','right']);assert.deepEqual(f.errors,[]);
 f.open();assert.deepEqual(f.opens.sort(),['left','right']);await f.left.send('saved only after open');assert.deepEqual(f.left.channel.sent,['saved only after open']);assert.ok(f.pcs[0].config.iceServers.length>=2);
});
test('initial offerer failure uses one fresh offer and late messages from the old attempt cannot enter it',async t=>{
 const f=fixture(t);await f.connect();const future={candidate:'candidate-next'};await f.right.receive({kind:'candidates',attempt:1,candidates:[future]});assert.deepEqual(f.right.pc.added,[]);
 f.fail(f.left);await f.settle();assert.equal(f.pcs.length,4);assert.deepEqual(f.right.pc.added,[future]);const description=f.left.pc.remoteDescription;
 await f.left.receive({kind:'answer',attempt:0,description:{type:'answer',sdp:'stale'}});await f.right.receive({kind:'candidates',attempt:0,candidates:[{candidate:'stale'}]});await f.left.receive({kind:'retry',attempt:1});
 assert.equal(f.pcs.length,4);assert.equal(f.left.pc.remoteDescription,description);assert.deepEqual(f.right.pc.added,[future]);await assert.rejects(f.left.receive({kind:'retry',attempt:2}),/재시도/);f.open();assert.deepEqual(f.errors,[]);
});
test('two failed connection attempts end with a bounded pre-transfer error without repeated retries',async t=>{
 const f=fixture(t);await f.connect();t.mock.timers.tick(30001);await f.settle();assert.equal(f.pcs.length,4);assert.deepEqual(f.opens,[]);
 t.mock.timers.tick(30001);t.mock.timers.tick(1001);assert.equal(f.errors.length,2);assert.ok(f.errors.every(({error})=>/자료 전송을 시작하기 전에/.test(error.message)));assert.equal(f.pcs.length,4);assert.deepEqual(f.opens,[]);
});
test('an unanswered retry offer still has a finite connection deadline',async t=>{
 const f=fixture(t);await f.connect();f.left.signal=()=>new Promise(()=>{});f.fail(f.left);await f.settle();assert.equal(f.left.attempt,1);
 t.mock.timers.tick(30001);await f.settle();t.mock.timers.tick(1001);assert.ok(f.errors.some(({side,error})=>side==='left'&&/자료 전송을 시작하기 전에/.test(error.message)));assert.deepEqual(f.opens,[]);
});
test('a recovered live connection does not fail later, while a real data-channel close stays fatal',async t=>{
 const f=fixture(t);await f.connect();f.open();f.fail(f.right);f.right.pc.connectionState='connected';f.right.pc.onconnectionstatechange();t.mock.timers.tick(1001);assert.deepEqual(f.errors,[]);assert.equal(f.pcs.length,2);
 f.fail(f.right);f.right.pc.connectionState='connected';f.right.channel.close();t.mock.timers.tick(1001);assert.equal(f.errors.length,1);assert.match(f.errors[0].error.message,/전송 연결을 닫았습니다/);assert.equal(f.pcs.length,2);
});
test('closing a retry cancels the attempt and ignores callbacks from the old peer',async t=>{
 const f=fixture(t);await f.connect();const previous=f.right.pc,onCandidate=previous.onicecandidate;f.fail(f.right);f.right.destroy();await f.settle();onCandidate({candidate:{toJSON:()=>({candidate:'late'})}});t.mock.timers.tick(1001);assert.equal(f.right.closed,true);assert.deepEqual(f.opens,[]);assert.deepEqual(f.errors,[]);assert.ok(!f.packets.some(({message})=>message.candidates?.some(c=>c.candidate==='late')));
});
test('many local paths stay within candidate batch bounds and late discovery errors cannot interrupt an open channel',async t=>{
 const f=fixture(t);await f.connect();for(let i=0;i<65;i++)f.left.pc.onicecandidate({candidate:{toJSON:()=>({candidate:'path-'+i})}});t.mock.timers.tick(101);await f.settle();assert.deepEqual(f.packets.filter(({side,message})=>side==='left'&&message.kind==='candidates').map(({message})=>message.candidates.length),[32,32,1]);assert.equal(f.right.pc.added.length,65);
 f.open();f.left.signal=async()=>{throw Error('Late discovery unavailable');};f.left.pc.onicecandidate({candidate:{toJSON:()=>({candidate:'late-path'})}});t.mock.timers.tick(101);await f.settle();t.mock.timers.tick(1001);assert.deepEqual(f.errors,[]);
});
test('connection retry signals require the authenticated peer and current session',async()=>{
 const service=new DeviceSyncService({adapter:{},onStatusChange:()=>{},onDataReceived:()=>{}}),received=[];
 service.roomId='HM-RETRY-SESSION';service.remoteId='other';service.sessionId='current';service.peer={receive:async message=>received.push(message),destroy(){}};
 const encode=changes=>encryptData(JSON.stringify({kind:'retry',attempt:1,from:'other',to:service.instanceId,session:'current',...changes}),service.roomId);
 try{await service.acceptSignal(await encode({session:'previous'}));await service.acceptSignal(await encode({from:'unknown'}));assert.equal(received.length,0);await service.acceptSignal(await encode({}));assert.equal(received.length,1);assert.equal(received[0].attempt,1);}finally{service.destroy();}
});
