// The relay carries AES-encrypted SDP/ICE only. Original bytes use WebRTC's
// authenticated DTLS channel, with small frames and bounded browser buffering.
export class DirectSyncConnection{
  constructor({signal,onOpen,onMessage,onError}){
    Object.assign(this,{signal,onOpen,onMessage,onError});this.closed=false;this.candidates=[];this.remoteCandidates=[];this.queue=Promise.resolve();
    this.pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.cloudflare.com:3478'}]});
    this.pc.onicecandidate=event=>{
      if(!event.candidate||this.closed)return;this.candidates.push(event.candidate.toJSON());
      if(!this.candidateTimer)this.candidateTimer=setTimeout(()=>{this.candidateTimer=null;const candidates=this.candidates.splice(0);if(!this.closed)void this.signal({kind:'candidates',candidates}).catch(e=>this.fail(e));},100);
    };
    this.pc.ondatachannel=event=>this.attach(event.channel);
    this.pc.onconnectionstatechange=()=>{
      clearTimeout(this.disconnectTimer);if(this.closed)return;
      if(this.pc.connectionState==='failed'||this.pc.connectionState==='closed')this.fail(Error('기기 간 연결이 끊겼습니다. 두 창을 열어 두고 다시 연결해주세요.'));
      if(this.pc.connectionState==='disconnected')this.disconnectTimer=setTimeout(()=>this.fail(Error('상대 기기의 연결이 끊겼습니다. 두 기기의 인터넷 연결을 확인해주세요.')),15000);
    };
    this.connectTimer=setTimeout(()=>this.fail(Error('기기 간 직접 연결을 만들지 못했습니다. 두 기기를 같은 Wi-Fi에 연결한 뒤 다시 시도해주세요.')),30000);
  }
  fail(error){
    // A sender publishes its concrete error before closing WebRTC. Give that
    // authenticated relay message time to arrive/decrypt before a generic close
    // event can replace the useful explanation on the receiving phone.
    if(this.closed||this.errorTimer)return;this.errorTimer=setTimeout(()=>{this.errorTimer=null;if(!this.closed)this.onError(error);},1000);
  }
  attach(channel){
    if(this.channel){channel.close();return;}this.channel=channel;channel.binaryType='arraybuffer';channel.bufferedAmountLowThreshold=65536;
    channel.onopen=()=>{clearTimeout(this.connectTimer);this.onOpen();};
    channel.onmessage=event=>{this.queue=this.queue.then(()=>this.onMessage(event.data)).catch(error=>this.fail(error));};
    channel.onerror=()=>this.fail(Error('파일 전송 연결에 오류가 발생했습니다. 다시 연결해주세요.'));
    channel.onclose=()=>this.fail(Error('상대 기기에서 전송 연결을 닫았습니다. 두 창을 열어 두고 다시 연결해주세요.'));
  }
  async offer(){this.attach(this.pc.createDataChannel('htmlmemo-sync-v2',{ordered:true}));await this.pc.setLocalDescription(await this.pc.createOffer());await this.signal({kind:'offer',description:this.pc.localDescription.toJSON()});}
  async receive(message){
    if(this.closed)return;
    if(message.kind==='offer'){
      await this.pc.setRemoteDescription(message.description);await this.applyCandidates();await this.pc.setLocalDescription(await this.pc.createAnswer());await this.signal({kind:'answer',description:this.pc.localDescription.toJSON()});
    }else if(message.kind==='answer'){await this.pc.setRemoteDescription(message.description);await this.applyCandidates();}
    else if(message.kind==='candidates'){
      if(!Array.isArray(message.candidates)||message.candidates.length>32)throw Error('잘못된 기기 연결 정보입니다.');
      this.remoteCandidates.push(...message.candidates);if(this.remoteCandidates.length>128)throw Error('기기 연결 정보가 너무 많습니다.');await this.applyCandidates();
    }
  }
  async applyCandidates(){if(!this.pc.remoteDescription)return;for(const candidate of this.remoteCandidates.splice(0))await this.pc.addIceCandidate(candidate);}
  async send(data){
    const channel=this.channel;if(this.closed||channel?.readyState!=='open')throw Error('파일 전송 연결이 닫혔습니다.');
    if(channel.bufferedAmount>262144)await new Promise((resolve,reject)=>{
      const done=error=>{clearTimeout(timer);channel.removeEventListener('bufferedamountlow',low);channel.removeEventListener('close',close);error?reject(error):resolve();};
      const low=()=>done(),close=()=>done(Error('파일 전송 연결이 닫혔습니다.')),timer=setTimeout(()=>done(Error('파일 전송이 지연되고 있습니다. 두 기기의 연결을 확인한 뒤 다시 시도해주세요.')),30000);
      channel.addEventListener('bufferedamountlow',low,{once:true});channel.addEventListener('close',close,{once:true});if(channel.bufferedAmount<=65536)low();
    });
    if(this.closed||channel.readyState!=='open')throw Error('파일 전송 연결이 닫혔습니다.');channel.send(data);
  }
  destroy({graceful=false}={}){
    if(this.closed)return;this.closed=true;for(const timer of [this.connectTimer,this.disconnectTimer,this.candidateTimer,this.errorTimer])clearTimeout(timer);
    this.pc.onconnectionstatechange=null;this.pc.onicecandidate=null;this.pc.ondatachannel=null;
    const channel=this.channel;
    if(channel){
      channel.onopen=null;channel.onmessage=null;channel.onerror=null;channel.onclose=null;
      if(graceful&&channel.readyState==='open'){
        // Drain the final commit ACK before closing the entire connection.
        const timer=setTimeout(()=>this.pc.close(),5000);channel.addEventListener('close',()=>{clearTimeout(timer);this.pc.close();},{once:true});channel.close();return;
      }
      channel.close();
    }
    this.pc.close();
  }
}
