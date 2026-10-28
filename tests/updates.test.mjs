import test from 'node:test';
import assert from 'node:assert/strict';
import {MessageChannel} from 'node:worker_threads';
import {UpdateController} from '../public/src/updates.js';

function fixture({available=true,accept=true,offline=false,beforeUpdate=async()=>{},failure=null}={}){
  const states=[],calls=[],service=new EventTarget();let reloads=0,offers=0;
  class Worker extends EventTarget{
    constructor(){super();this.state='activated';}
    postMessage(message,ports){
      calls.push(message.type);
      if(message.type==='HTMLMEMO_UPDATE_INFO')ports[0].postMessage({ok:true,available,currentVersion:'1.0.0',version:'1.0.1',build:'test-new'});
      else if(failure)ports[0].postMessage({ok:false,error:failure});
      else{service.controller=this;service.dispatchEvent(new Event('controllerchange'));ports[0].postMessage({ok:true});}
    }
  }
  const old=new Worker(),worker=new Worker();service.controller=old;
  const registration={active:worker,installing:null,waiting:null,update:async()=>{calls.push('update');if(offline)throw Error('offline');}};
  service.getRegistration=async()=>registration;service.register=async()=>{calls.push('register');return registration;};
  const controller=new UpdateController({navigator:{serviceWorker:service},location:new URL('https://app.test/HTMLMemo/'),Channel:MessageChannel,onOffer:async info=>{offers++;assert.equal(info.version,'1.0.1');return accept;},beforeUpdate:async()=>{calls.push('save');await beforeUpdate();},onState:(state,error)=>states.push({state,error}),reload:()=>{calls.push('reload');reloads++;}});
  return {controller,service,registration,worker,calls,states,get reloads(){return reloads;},get offers(){return offers;}};
}
test('startup checks once; cancel never activates or reloads and another launch offers the update again',async()=>{
  for(let launch=0;launch<2;launch++){
    const f=fixture({accept:false});await Promise.all([f.controller.start(),f.controller.start()]);
    assert.deepEqual(f.calls,['update','HTMLMEMO_UPDATE_INFO']);assert.equal(f.offers,1);assert.equal(f.reloads,0);assert.equal(f.states.at(-1).state,'deferred');
    f.service.dispatchEvent(new Event('controllerchange'));f.service.dispatchEvent(new Event('focus'));f.service.dispatchEvent(new Event('online'));await Promise.resolve();assert.equal(f.offers,1);assert.equal(f.reloads,0);
  }
});
test('accept saves first, activates only the proposed release and reloads once after control changes',async()=>{
  const f=fixture();await f.controller.start();assert.deepEqual(f.calls,['update','HTMLMEMO_UPDATE_INFO','save','HTMLMEMO_UPDATE_APPLY','reload']);assert.equal(f.reloads,1);assert.equal(f.service.controller,f.worker);
  await f.controller.start();assert.equal(f.reloads,1);assert.equal(f.states.at(-1).state,'reloading');
});
test('a failed save leaves the current worker untouched and an explicit retry can finish',async()=>{
  let failed=true;const f=fixture({beforeUpdate:async()=>{if(failed)throw Error('Folder is not writable');}}),old=f.service.controller;
  await f.controller.start();assert.equal(f.states.at(-1).state,'error');assert.match(f.states.at(-1).error.message,/not writable/);assert.equal(f.service.controller,old);assert.equal(f.reloads,0);assert.ok(!f.calls.includes('HTMLMEMO_UPDATE_APPLY'));
  failed=false;await f.controller.install();assert.equal(f.reloads,1);assert.equal(f.calls.filter(c=>c==='update').length,1);
});
test('cancel while saving never applies the update and overlapping install clicks cannot duplicate a reload',async()=>{
  let release;const f=fixture({beforeUpdate:()=>new Promise(resolve=>release=resolve)}),task=f.controller.start();
  while(!release)await new Promise(resolve=>setImmediate(resolve));f.controller.cancel();await f.controller.install();release();await task;
  assert.equal(f.states.at(-1).state,'deferred');assert.equal(f.reloads,0);assert.equal(f.calls.filter(c=>c==='save').length,1);assert.ok(!f.calls.includes('HTMLMEMO_UPDATE_APPLY'));
});
test('offline checks may offer an already prepared release, while a current installation is silent',async()=>{
  const offline=fixture({offline:true});await offline.controller.start();assert.equal(offline.reloads,1);
  const current=fixture({available:false});await current.controller.start();assert.equal(current.offers,0);assert.equal(current.reloads,0);assert.equal(current.states.at(-1).state,'current');
});
test('install errors preserve the current app and do not turn unrelated controller changes into reloads',async()=>{
  const f=fixture({failure:'Prepared version changed'}),old=f.service.controller;await f.controller.start();assert.equal(f.reloads,0);assert.equal(f.service.controller,old);assert.equal(f.states.at(-1).state,'error');
  f.service.controller=f.worker;f.service.dispatchEvent(new Event('controllerchange'));assert.equal(f.reloads,0);
});
test('first registration, pending installation and unsupported locations do not produce a false update prompt',async()=>{
  const f=fixture({available:false});f.service.getRegistration=async()=>undefined;f.registration.installing=f.worker;f.worker.state='installing';
  const task=f.controller.start();queueMicrotask(()=>{f.worker.state='installed';f.worker.dispatchEvent(new Event('statechange'));});await task;
  assert.deepEqual(f.calls,['register','HTMLMEMO_UPDATE_INFO']);assert.equal(f.offers,0);
  for(const options of [{navigator:{},location:new URL('https://app.test/')},{navigator:{serviceWorker:f.service},location:new URL('file:///HTMLMemo.html')}]){
    const states=[],controller=new UpdateController({...options,onState:s=>states.push(s)});await controller.start();assert.deepEqual(states,['unavailable']);
  }
});
