import {SyncService,cleanRoomId} from './sync-service.js';
import {deriveTopic,encryptData,decryptData} from './sync-crypto.js';
import {DirectSyncConnection} from './sync-peer.js';
import {SyncStream} from './sync-stream.js';

// Keep the tested MemoSuite relay/encryption for discovery and small legacy
// packets. V2 authenticates SDP/ICE with the room key, then streams originals
// directly over DTLS; ntfy never receives the bulk file data.
export class DeviceSyncService extends SyncService{
  constructor(options){super(options);this.instanceId=crypto.randomUUID();this.signalQueue=Promise.resolve();this.remoteId=null;this.sessionId=null;this.peer=null;this.stream=null;this.finished=false;this.failing=false;this.joinSending=false;}
  clearWaiting(){clearInterval(this.joinTimer);clearTimeout(this.waitTimer);clearTimeout(this.handshakeTimer);this.joinTimer=null;this.waitTimer=null;this.handshakeTimer=null;}
  setStatus(status,message){
    if(this.isDestroyed||this.finished)return;
    if(status==='error'){void this.fail(Error(message||'동기화하지 못했습니다.'));return;}
    if(status==='completed'){this.finished=true;this.clearWaiting();}
    super.setStatus(status,message);
  }
  async initialize(roomId){
    this.isHost=true;this.roomId=cleanRoomId(roomId);this.topic=await deriveTopic(this.roomId);await this.analyzeSyncData();this.setStatus('connecting','중계 서버에 연결하는 중…');await this.connectRelay();
    if(!this.remoteId)this.setStatus('ready','연결 대기 중입니다. 상대 기기에서 이 QR을 스캔하세요.');return this.roomId;
  }
  async connect(roomId){
    this.isHost=false;this.roomId=cleanRoomId(roomId);this.topic=await deriveTopic(this.roomId);this.setStatus('connecting','중계 서버에 연결하는 중…');await this.connectRelay();
    if(this.isDestroyed)return;this.setStatus('waiting','중계 서버에 접속했습니다. 상대 기기의 응답을 기다리는 중…');
    this.waitTimer=setTimeout(()=>void this.fail(Error('상대 기기의 응답이 없습니다. QR을 표시한 기기에서 ‘연결 시작’을 누르고, 두 기기 모두 최신 화면으로 새로고침한 뒤 다시 스캔해주세요.')),30000);
    const join=async()=>{if(this.joinSending||this.remoteId||this.isDestroyed)return;this.joinSending=true;try{await this.sendRelayMessage({type:'join',protocol:2,direct:typeof RTCPeerConnection==='function'});}catch(error){void this.fail(error);}finally{this.joinSending=false;}};
    this.joinTimer=setInterval(()=>void join(),3000);await join();
  }
  sendSignal(message){
    if(!this.remoteId||!this.sessionId||!this.roomId)return Promise.resolve();
    const body={...message,from:this.instanceId,to:this.remoteId,session:this.sessionId},secret=this.roomId;
    const next=this.signalQueue.then(async()=>{
      if(this.isDestroyed||body.to!==this.remoteId||body.session!==this.sessionId)return;const encoded=await encryptData(JSON.stringify(body),secret),payload={type:'sync_control',data:encoded};
      if(JSON.stringify(payload).length>3000)await this.sendRelayAttachment('CONTROL:'+encoded);else await this.sendRelayMessage(payload);
    });this.signalQueue=next.catch(()=>{});return next;
  }
  makePeer(){
    if(this.peer)return;
    if(typeof RTCPeerConnection!=='function')throw Error('이 브라우저는 기기 간 파일 전송을 지원하지 않습니다. 최신 Chrome으로 두 기기를 다시 열어주세요.');
    this.peer=new DirectSyncConnection({signal:message=>this.sendSignal(message),onOpen:()=>{
      this.clearWaiting();this.setStatus('connected','상대 기기의 응답을 확인했습니다. 파일 전송 연결이 준비됐습니다.');if(this.isHost)void this.syncDirectData();
    },onMessage:data=>this.stream.receive(data),onError:error=>void this.fail(error)});
    this.stream=new SyncStream({send:data=>this.peer.send(data),onManifest:manifest=>this.options.adapter.prepareSettings?.(manifest),findFiles:typeof this.options.adapter.findReusableStreamFiles==='function'?manifest=>this.options.adapter.findReusableStreamFiles(manifest):null,onProgress:progress=>this.options.onProgress?.(progress),onBundle:async(bundle)=>{
      this.setStatus('merging','받은 파일을 검증하고 문서·주석을 저장하는 중…');this.updateSyncInfoMeta(bundle.manifest,!this.isHost&&!!this.remotePartial);
      const exclude=await this.options.adapter.mergeStreamBundle(bundle,this.options.onConflict);this.mergedExcludeIds=Array.isArray(exclude)?exclude:[];this.hasReceivedData=true;return exclude;
    },onCommitted:({partial,confirmed})=>{
      if(this.isDestroyed)return;
      if(this.isHost||partial)void this.confirmCompletion({direct:confirmed});else if(!this.hasSentInitialSync)void this.syncDirectData();
    }});
  }
  async syncDirectData(){
    if(this.isDestroyed||this.isSyncing||this.hasSentInitialSync)return;
    this.isSyncing=true;this.hasSentInitialSync=true;
    try{
      this.setStatus('syncing','원본 파일과 주석·이력을 검사하고 전송 목록을 준비하는 중…');
      const ids=await this.options.adapter.getSyncTargetIds(this.options.initialDataLogId),bundle=await this.options.adapter.getStreamBundle(ids,this.mergedExcludeIds);
      if(this.isDestroyed)return;this.setStatus('syncing','기기 간 암호화 연결로 파일을 나누어 전송하는 중…');
      const result=await this.stream.sendBundle(bundle,{partial:!!ids});
      if(result?.committed&&(ids||!this.isHost&&this.hasReceivedData)){await this.confirmCompletion({direct:true});return;}
      if(!this.isDestroyed&&!this.finished)this.setStatus('syncing',this.isHost?'원본 전송을 마쳤습니다. 상대 기기의 저장·응답을 기다리는 중…':'이 기기의 변경을 보냈습니다. 상대 기기의 저장 확인을 기다리는 중…');
    }catch(error){if(!this.isDestroyed)await this.fail(error);}finally{this.isSyncing=false;}
  }
  async confirmCompletion({direct=false}={}){
    try{
      // New peers acknowledge the committed database over the direct channel.
      // Completion must not wait for a relay that is no longer needed.
      if(!direct){
        let timer;try{await Promise.race([this.sendSignal({kind:'complete'}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('저장은 끝났지만 상대 기기에 완료를 알리지 못했습니다. 양쪽 앱을 새로고침하고 다시 연결해주세요.')),15000);})]);}finally{clearTimeout(timer);}
      }
      if(!this.isDestroyed&&!this.finished){this.setStatus('completed','전송이 완료되었습니다. 이 화면은 닫아도 됩니다.');this.options.onDataReceived();}
    }
    catch(error){if(!this.isDestroyed)await this.fail(error);}
  }
  async acceptSignal(encoded){
    if(encoded.length>131072)return;let message;
    try{message=JSON.parse(await decryptData(encoded,this.roomId));}catch{return;}
    if(this.isDestroyed||message?.to!==this.instanceId||typeof message.from!=='string'||message.from===this.instanceId||typeof message.session!=='string'||!/^[\w-]{1,80}$/.test(message.session))return;
    if(message.kind==='hello'){
      if(this.isHost||this.remoteId&&this.remoteId!==message.from)return;
      this.remoteId=message.from;this.sessionId=message.session;this.remotePartial=!!message.partial;this.clearWaiting();this.setStatus('negotiating','상대 기기의 응답을 확인했습니다. 기기 간 파일 전송 연결을 만드는 중…');this.makePeer();await this.sendSignal({kind:'hello_ack'});return;
    }
    if(message.from!==this.remoteId||message.session!==this.sessionId)return;
    if(message.kind==='hello_ack'&&this.isHost){this.clearWaiting();if(!this.peer){this.makePeer();await this.peer.offer();}return;}
    if(message.kind==='complete'){
      if(!this.hasSentInitialSync)return;this.setStatus('completed','전송이 완료되었습니다. 이 화면은 닫아도 됩니다.');this.options.onDataReceived();return;
    }
    if(message.kind==='error'){const text='상대 기기에서 동기화를 '+(message.cancelled===true?'취소했습니다. ':'중단했습니다. ')+String(message.message||'연결을 확인해주세요.').slice(0,1500);await this.fail(message.cancelled===true?new DOMException(text,'AbortError'):Error(text),false);return;}
    if(['offer','answer','candidates'].includes(message.kind)){this.makePeer();await this.peer.receive(message);}
  }
  async handleRelayMessage(message){
    if(this.isDestroyed||this.finished)return;
    try{
      if(message.attachment){await super.handleRelayMessage(message);return;}
      let payload;try{payload=JSON.parse(message.message);}catch{return;}
      if(payload?.instanceId===this.instanceId)return;
      if(payload?.type==='sync_control'&&typeof payload.data==='string'){await this.acceptSignal(payload.data);return;}
      if(payload?.type==='join'&&this.isHost&&payload.protocol===2&&payload.direct&&typeof payload.instanceId==='string'&&/^[\w-]{1,80}$/.test(payload.instanceId)&&typeof RTCPeerConnection==='function'){
        if(this.remoteId)return;this.remoteId=payload.instanceId;this.sessionId=crypto.randomUUID();this.setStatus('negotiating','상대 기기의 연결 요청을 받았습니다. 파일 전송 연결을 만드는 중…');
        this.handshakeTimer=setTimeout(()=>{if(!this.peer&&!this.isDestroyed){this.remoteId=null;this.sessionId=null;this.setStatus('ready','이전 요청의 응답이 없어 새 연결을 기다립니다. 상대 기기에서 다시 연결해주세요.');}},5000);
        await this.sendSignal({kind:'hello',partial:!!this.options.initialDataLogId});return;
      }
      // Old clients retain the original, bounded MemoSuite transfer. Their
      // document bytes never enter a v2 stream without a confirmed handshake.
      if(!this.peer){if(payload?.type==='sync_data'){this.clearWaiting();this.remoteId=payload.instanceId;}await super.handleRelayMessage(message);}
    }catch(error){if(!this.isDestroyed)await this.fail(error);}
  }
  async downloadAndProcessAttachment(url){
    const safe=new URL(url);if(safe.origin!=='https://ntfy.sh'||!safe.pathname.startsWith('/file/'))throw Error('잘못된 중계 파일 주소입니다.');
    const response=await fetch(url,{signal:this.abort.signal});if(!response.ok)throw Error('연결 정보를 받지 못했습니다. '+response.status);
    if(Number(response.headers.get('content-length'))>2000000)throw Error('중계 연결 정보가 너무 큽니다.');const text=await response.text();if(text.length>2000000)throw Error('중계 연결 정보가 너무 큽니다.');
    if(text.startsWith('CONTROL:'))await this.acceptSignal(text.slice(8));else if(!this.peer){this.clearWaiting();await this.processReceivedEncodedData(text);}
  }
  async fail(error,notify=true){
    if(this.isDestroyed||this.finished||this.failing)return;this.failing=true;this.clearWaiting();const message=error?.message||String(error),cancelled=error?.name==='AbortError';
    if(notify&&this.remoteId&&this.sessionId){let timer;try{await Promise.race([this.sendSignal({kind:'error',message:message.slice(0,1500),...(cancelled?{cancelled:true}:{})}),new Promise(resolve=>{timer=setTimeout(resolve,5000);})]);}catch{}finally{clearTimeout(timer);}}
    if(!this.isDestroyed)super.setStatus(cancelled?'cancelled':'error',message);
  }
  destroy(){if(this.isDestroyed)return;this.clearWaiting();this.peer?.destroy({graceful:this.finished});this.stream?.destroy();super.destroy();}
}
