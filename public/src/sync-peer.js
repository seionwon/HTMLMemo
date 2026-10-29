// The relay carries AES-encrypted SDP/ICE only. Original bytes use WebRTC's
// authenticated DTLS channel, with small frames and bounded browser buffering.
const initialConnectionError=()=>Error('자료 전송을 시작하기 전에 기기 간 직접 연결을 만들지 못했습니다. 연결 경로를 한 차례 다시 확인했지만 연결되지 않았습니다. 같은 공유기의 기기 간 통신 차단과 두 기기의 방화벽·네트워크 권한을 확인해주세요.');
const attemptOf=message=>{const value=message.attempt??0;if(!Number.isInteger(value)||value<0||value>1)throw Error('잘못된 기기 연결 재시도 정보입니다.');return value;};
export class DirectSyncConnection{
  constructor({signal,onOpen,onMessage,onError,onRetry=()=>{}}){
    Object.assign(this,{signal,onOpen,onMessage,onError,onRetry});this.closed=false;this.opened=false;this.attempt=0;this.initiator=false;this.remoteCandidates=[];this.queue=Promise.resolve();this.createPeer();
  }
  active(pc){return !this.closed&&this.pc===pc;}
  createPeer(){
    const pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.cloudflare.com:3478'},{urls:'stun:stun.l.google.com:19302'}]});this.pc=pc;this.candidates=[];
    pc.onicecandidate=event=>{
      if(!event.candidate||!this.active(pc))return;this.candidates.push(event.candidate.toJSON());
      if(!this.candidateTimer)this.candidateTimer=setTimeout(()=>{
        this.candidateTimer=null;if(!this.active(pc))return;
        const candidates=this.candidates.splice(0);for(let i=0;i<candidates.length;i+=32)void this.signal({kind:'candidates',attempt:this.attempt,candidates:candidates.slice(i,i+32)}).catch(error=>{if(this.active(pc)&&!this.opened)this.fail(error);});
      },100);
    };
    pc.ondatachannel=event=>{if(this.active(pc))this.attach(event.channel,pc);else event.channel.close();};
    pc.onconnectionstatechange=()=>{
      clearTimeout(this.disconnectTimer);if(!this.active(pc))return;
      if(pc.connectionState==='failed'||pc.connectionState==='closed'){
        if(!this.opened)void this.recoverInitial();
        else this.fail(Error('기기 간 연결이 끊겼습니다. 두 창을 열어 두고 다시 연결해주세요.'),()=>this.active(pc)&&['failed','closed'].includes(pc.connectionState));
      }
      if(pc.connectionState==='disconnected')this.disconnectTimer=setTimeout(()=>{
        if(!this.active(pc)||pc.connectionState!=='disconnected')return;
        if(!this.opened)void this.recoverInitial();else this.fail(Error('상대 기기의 연결이 끊겼습니다. 두 기기의 인터넷 연결을 확인해주세요.'),()=>this.active(pc)&&pc.connectionState==='disconnected');
      },15000);
    };
    this.armConnectTimer();
  }
  armConnectTimer(){clearTimeout(this.connectTimer);this.connectTimer=setTimeout(()=>{if(!this.closed&&!this.opened)void this.recoverInitial();},30000);}
  async recoverInitial(){
    if(this.closed||this.opened||this.retryPending)return;
    if(this.attempt===1){this.fail(initialConnectionError(),()=>!this.opened);return;}
    this.retryPending=true;this.attempt=1;this.onRetry();this.closePeer();this.remoteCandidates=this.remoteCandidates.filter(item=>item.attempt===1);
    // Recreate the failed transport before any original/metadata is sent.
    // The receiver asks the original offerer to keep one negotiation owner.
    // The next deadline must still fire if the relay never answers this send.
    let starting;try{if(this.initiator){this.createPeer();starting=this.offer();}else{this.armConnectTimer();starting=this.signal({kind:'retry',attempt:1});}}catch(error){this.retryPending=false;this.fail(error);return;}
    this.retryPending=false;try{await starting;}catch(error){if(!this.closed&&!this.opened)this.fail(error);}
  }
  fail(error,remainsFailed=null){
    // Allow an authenticated concrete peer error to arrive before a generic
    // disconnect, and recheck a transient connection state after that delay.
    if(this.closed)return;if(this.errorTimer){if(remainsFailed||!this.errorRemainsFailed)return;clearTimeout(this.errorTimer);}
    this.errorRemainsFailed=remainsFailed;this.errorTimer=setTimeout(()=>{
      this.errorTimer=null;this.errorRemainsFailed=null;if(this.closed||remainsFailed&&!remainsFailed())return;
      this.onError(error);
    },1000);
  }
  attach(channel,pc=this.pc){
    if(this.channel){channel.close();return;}this.channel=channel;channel.binaryType='arraybuffer';channel.bufferedAmountLowThreshold=65536;
    channel.onopen=()=>{if(!this.active(pc)||this.opened)return;this.opened=true;clearTimeout(this.connectTimer);clearTimeout(this.disconnectTimer);this.onOpen();};
    channel.onmessage=event=>{if(!this.active(pc))return;this.queue=this.queue.then(()=>{if(this.active(pc))return this.onMessage(event.data);}).catch(error=>{if(this.active(pc))this.fail(error);});};
    channel.onerror=()=>{if(this.active(pc)){if(!this.opened)void this.recoverInitial();else this.fail(Error('파일 전송 연결에 오류가 발생했습니다. 다시 연결해주세요.'));}};
    channel.onclose=()=>{if(this.active(pc)){if(!this.opened)void this.recoverInitial();else this.fail(Error('상대 기기에서 전송 연결을 닫았습니다. 두 창을 열어 두고 다시 연결해주세요.'));}};
  }
  async offer(){
    if(this.closed||this.opened)return;this.initiator=true;const pc=this.pc,attempt=this.attempt;if(!pc)return;
    if(!this.channel)this.attach(pc.createDataChannel('htmlmemo-sync-v2',{ordered:true}),pc);
    const description=await pc.createOffer();if(!this.active(pc))return;await pc.setLocalDescription(description);if(this.active(pc))await this.signal({kind:'offer',attempt,description:pc.localDescription.toJSON()});
  }
  async receive(message){
    if(this.closed)return;const attempt=attemptOf(message);
    if(message.kind==='retry'){
      if(attempt!==1)throw Error('잘못된 기기 연결 재시도 정보입니다.');
      if(this.initiator&&!this.opened&&this.attempt===0)await this.recoverInitial();return;
    }
    if(attempt<this.attempt)return;
    if(message.kind==='offer'){
      if(this.initiator||this.opened)return;
      if(attempt>this.attempt){this.attempt=attempt;this.onRetry();this.closePeer();this.remoteCandidates=this.remoteCandidates.filter(item=>item.attempt===attempt);}
      if(!this.pc)this.createPeer();const pc=this.pc;
      if(pc.remoteDescription)return;
      await pc.setRemoteDescription(message.description);if(!this.active(pc))return;await this.applyCandidates();if(!this.active(pc))return;
      await pc.setLocalDescription(await pc.createAnswer());if(this.active(pc))await this.signal({kind:'answer',attempt,description:pc.localDescription.toJSON()});
    }else if(message.kind==='answer'){
      if(attempt!==this.attempt||!this.initiator||!this.pc||this.pc.remoteDescription)return;const pc=this.pc;
      await pc.setRemoteDescription(message.description);if(this.active(pc))await this.applyCandidates();
    }else if(message.kind==='candidates'){
      if(!Array.isArray(message.candidates)||message.candidates.length>32)throw Error('잘못된 기기 연결 정보입니다.');
      this.remoteCandidates.push(...message.candidates.map(candidate=>({attempt,candidate})));if(this.remoteCandidates.length>128)throw Error('기기 연결 정보가 너무 많습니다.');await this.applyCandidates();
    }
  }
  async applyCandidates(){
    const pc=this.pc;if(!pc?.remoteDescription)return;const pending=this.remoteCandidates;this.remoteCandidates=[];
    for(const item of pending){if(item.attempt>this.attempt)this.remoteCandidates.push(item);else if(item.attempt===this.attempt&&this.active(pc))await pc.addIceCandidate(item.candidate);}
  }
  async send(data){
    const channel=this.channel;if(this.closed||channel?.readyState!=='open')throw Error('파일 전송 연결이 닫혔습니다.');
    if(channel.bufferedAmount>262144)await new Promise((resolve,reject)=>{
      const done=error=>{clearTimeout(timer);channel.removeEventListener('bufferedamountlow',low);channel.removeEventListener('close',close);error?reject(error):resolve();};
      const low=()=>done(),close=()=>done(Error('파일 전송 연결이 닫혔습니다.')),timer=setTimeout(()=>done(Error('파일 전송이 지연되고 있습니다. 두 기기의 연결을 확인한 뒤 다시 시도해주세요.')),30000);
      channel.addEventListener('bufferedamountlow',low,{once:true});channel.addEventListener('close',close,{once:true});if(channel.bufferedAmount<=65536)low();
    });
    if(this.closed||this.channel!==channel||channel.readyState!=='open')throw Error('파일 전송 연결이 닫혔습니다.');channel.send(data);
  }
  closePeer({graceful=false}={}){
    for(const timer of [this.connectTimer,this.disconnectTimer,this.candidateTimer,this.errorTimer])clearTimeout(timer);this.candidateTimer=null;this.errorTimer=null;
    const pc=this.pc,channel=this.channel;this.pc=null;this.channel=null;if(!pc)return;
    pc.onconnectionstatechange=null;pc.onicecandidate=null;pc.ondatachannel=null;
    if(channel){
      channel.onopen=null;channel.onmessage=null;channel.onerror=null;channel.onclose=null;
      if(graceful&&channel.readyState==='open'){
        const timer=setTimeout(()=>pc.close(),5000);channel.addEventListener('close',()=>{clearTimeout(timer);pc.close();},{once:true});channel.close();return;
      }
      channel.close();
    }
    pc.close();
  }
  destroy({graceful=false}={}){if(this.closed)return;this.closed=true;this.closePeer({graceful});}
}
