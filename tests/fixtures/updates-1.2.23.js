import {installableLocation} from './install.js';

function workerReady(worker,timeout=30000){
  if(!worker||['installed','activated'].includes(worker.state))return Promise.resolve(worker);
  return new Promise((resolve,reject)=>{
    const finish=error=>{clearTimeout(timer);worker.removeEventListener('statechange',changed);error?reject(error):resolve(worker);};
    const changed=()=>{if(['installed','activated'].includes(worker.state))finish();else if(worker.state==='redundant')finish(Error('새 버전 준비를 끝내지 못했습니다.'));};
    const timer=setTimeout(()=>finish(Error('새 버전 확인 시간이 초과되었습니다.')),timeout);worker.addEventListener('statechange',changed);changed();
  });
}
function request(worker,message,Channel,timeout=15000){
  return new Promise((resolve,reject)=>{
    const channel=new Channel(),finish=(value,error)=>{clearTimeout(timer);channel.port1.close();channel.port2.close();error?reject(error):resolve(value);};
    const timer=setTimeout(()=>finish(null,Error('업데이트 응답을 받지 못했습니다. 앱을 다시 실행해주세요.')),timeout);
    channel.port1.onmessage=event=>event.data?.ok?finish(event.data):finish(null,Error(event.data?.error||'업데이트하지 못했습니다.'));
    channel.port1.onmessageerror=()=>finish(null,Error('업데이트 응답을 읽지 못했습니다.'));
    try{worker.postMessage(message,[channel.port2]);}catch(error){finish(null,error);}
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
  constructor({navigator,location,onOffer=async()=>false,beforeUpdate=async()=>{},onState=()=>{},reload=()=>location.reload(),Channel=globalThis.MessageChannel}){
    Object.assign(this,{navigator,location,onOffer,beforeUpdate,onState,reload,Channel});this.started=false;this.cancelled=false;
  }
  state(value,error=null){this.onState(value,error);}
  cancel(){this.cancelled=true;}
  start(){return this.task||=(async()=>{
    this.started=true;const service=this.navigator.serviceWorker;
    if(!installableLocation(this.location)||!service?.register){this.state('unavailable');return;}
    this.state('checking');
    try{
      const existing=await service.getRegistration?.('./'),registration=existing||await service.register('./sw.js',{updateViaCache:'none'});
      if(!registration){this.state('current');return;}
      if(existing)try{await registration.update();}catch{/* Offline: a previously prepared release can still be offered. */}
      const installed=await workerReady(registration.installing),worker=registration.waiting||installed||registration.active;
      if(!worker){this.state('current');return;}
      const info=await request(worker,{type:'HTMLMEMO_UPDATE_INFO'},this.Channel);
      if(!info.available){this.state('current');return;}
      this.offer={worker,info};
      this.state('available');
      if(!await this.onOffer(info)||this.cancelled){this.state('deferred');return;}
      await this.install();
    }catch(error){this.state('error',error);}
  })();}
  async install(){
    if(this.busy||!this.offer)return;this.busy=true;this.cancelled=false;
    const {worker,info}=this.offer,service=this.navigator.serviceWorker;
    try{
      this.state('saving');await this.beforeUpdate();
      if(this.cancelled){this.state('deferred');return;}
      this.state('applying');await request(worker,{type:'HTMLMEMO_UPDATE_APPLY',build:info.build},this.Channel);
      await controlledBy(service,worker);this.state('reloading');this.reload();
    }catch(error){this.state('error',error);}
    finally{this.busy=false;}
  }
}
