import {installableLocation} from './install.js';

function workerReady(worker,timeout=30000){
  if(!worker||['installed','activated'].includes(worker.state))return Promise.resolve(worker);
  return new Promise((resolve,reject)=>{
    const finish=error=>{clearTimeout(timer);worker.removeEventListener('statechange',changed);error?reject(error):resolve(worker);};
    const changed=()=>{if(['installed','activated'].includes(worker.state))finish();else if(worker.state==='redundant')finish(Error('새 버전 준비를 끝내지 못했습니다.'));};
    const timer=setTimeout(()=>finish(Error('새 버전 확인 시간이 초과되었습니다.')),timeout);worker.addEventListener('statechange',changed);changed();
  });
}
const failure=(message,code)=>Object.assign(Error(message),{code});
function checkRequest(task,timeout){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(failure('새 버전 확인 시간이 초과되었습니다. 현재 버전으로 계속합니다.','UPDATE_CHECK_TIMEOUT')),timeout);Promise.resolve(task).then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});});}
function request(worker,message,Channel,timeout=15000){
  if(!worker||worker.state==='redundant')return Promise.reject(failure('준비된 업데이트가 바뀌었습니다. 앱을 다시 실행해주세요.','UPDATE_WORKER_CHANGED'));
  return new Promise((resolve,reject)=>{
    let settled=false;const channel=new Channel(),finish=(value,error)=>{if(settled)return;settled=true;clearTimeout(timer);worker.removeEventListener?.('statechange',changed);channel.port1.close();channel.port2.close();error?reject(error):resolve(value);};
    const changed=()=>{if(worker.state==='redundant')finish(null,failure('준비된 업데이트가 바뀌었습니다. 앱을 다시 실행해주세요.','UPDATE_WORKER_CHANGED'));};
    const timer=setTimeout(()=>finish(null,failure('업데이트 응답을 받지 못했습니다. 앱을 다시 실행해주세요.','UPDATE_TIMEOUT')),timeout);worker.addEventListener?.('statechange',changed);
    channel.port1.onmessage=event=>event.data?.ok?finish(event.data):finish(null,failure(event.data?.error||'업데이트하지 못했습니다.','UPDATE_REJECTED'));
    channel.port1.onmessageerror=()=>finish(null,failure('업데이트 응답을 읽지 못했습니다.','UPDATE_COMMUNICATION'));
    try{worker.postMessage(message,[channel.port2]);}catch(error){finish(null,failure(error.message||'업데이트를 요청하지 못했습니다.','UPDATE_COMMUNICATION'));}
  });
}
function controlledBy(service,worker,timeout=15000){
  if(service.controller===worker)return Promise.resolve();
  return new Promise((resolve,reject)=>{
    const finish=error=>{clearTimeout(timer);service.removeEventListener('controllerchange',changed);error?reject(error):resolve();};
    const changed=()=>{if(service.controller===worker)finish();};
    const timer=setTimeout(()=>finish(Error('새 버전으로 전환하지 못했습니다. 앱을 다시 실행해주세요.')),timeout);service.addEventListener('controllerchange',changed);changed();
  });
}
// One check per full launch. No focus, online, visibility or periodic update checks.
export class UpdateController {
  constructor({navigator,location,onOffer=async()=>false,beforeUpdate=async()=>{},onState=()=>{},reload=()=>location.reload(),Channel=globalThis.MessageChannel,requestTimeout=15000,checkTimeout=15000}){
    Object.assign(this,{navigator,location,onOffer,beforeUpdate,onState,reload,Channel,requestTimeout,checkTimeout});this.started=false;this.cancelled=false;
  }
  state(value,error=null){this.onState(value,error);}
  cancel(){this.cancelled=true;}
  start(){return this.task||=(async()=>{
    this.started=true;const service=this.navigator.serviceWorker;
    if(!installableLocation(this.location)||!service?.register){this.state('unavailable');return;}
    this.state('checking');
    try{
      const existing=await checkRequest(service.getRegistration?.('./'),this.checkTimeout),registration=existing||await checkRequest(service.register('./sw.js',{updateViaCache:'none'}),this.checkTimeout);
      if(!registration){this.state('current');return;}
      if(existing)try{await checkRequest(registration.update(),this.checkTimeout);}catch{/* Offline: a previously prepared release can still be offered. */}
      const installed=await workerReady(registration.installing),worker=registration.waiting||installed||registration.active;
      if(!worker){this.state('current');return;}
      this.registration=registration;const info=await request(worker,{type:'HTMLMEMO_UPDATE_INFO'},this.Channel,this.requestTimeout);
      if(!info.available){this.state('current');return;}
      this.offer={worker,info};
      this.state('available');
      if(!await this.onOffer(info)||this.cancelled){this.state('deferred');return;}
      await this.install();
    }catch(error){this.state('error',error);}
  })();}
  async target(info){
    const registration=await this.navigator.serviceWorker.getRegistration?.('./')||this.registration;
    const offered=this.offer.worker,worker=registration?.waiting||(['installed','activating'].includes(offered?.state)?offered:registration?.active)||offered;
    if(worker!==this.offer.worker){
      const current=await request(worker,{type:'HTMLMEMO_UPDATE_INFO'},this.Channel,this.requestTimeout);
      if(current.build!==info.build)throw failure('준비된 새 버전이 바뀌었습니다. 앱을 다시 실행해 확인해주세요.','UPDATE_WORKER_CHANGED');
      this.offer.worker=worker;
    }
    return worker;
  }
  async install(){
    if(this.busy||!this.offer)return;this.busy=true;this.cancelled=false;
    const {info}=this.offer,service=this.navigator.serviceWorker;let applying=false;
    try{
      this.state('saving');await this.beforeUpdate();
      if(this.cancelled){this.state('deferred');return;}
      const worker=await this.target(info);if(this.cancelled){this.state('deferred');return;}
      this.state('applying');applying=true;let receipt;
      try{receipt=await request(worker,{type:'HTMLMEMO_UPDATE_APPLY',build:info.build},this.Channel,this.requestTimeout);}
      catch(error){
        if(!['UPDATE_TIMEOUT','UPDATE_COMMUNICATION'].includes(error.code))throw error;
        // A reply can be lost after the user-approved selection was persisted.
        // Reload only after the exact proposed build confirms that selection.
        const current=await this.target(info),proof=await request(current,{type:'HTMLMEMO_UPDATE_INFO'},this.Channel,this.requestTimeout).catch(()=>null);
        if(proof?.build!==info.build||proof.selected!==true)throw error;
        receipt={navigationReady:true};
      }
      if(!receipt.navigationReady)await controlledBy(service,worker);
      this.state('reloading');this.reload();
    }catch(error){if(applying)error.applying=true;this.state('error',error);}
    finally{this.busy=false;}
  }
}
