import {SyncTempStore} from './sync-temp.js';
import {localFileIdentity,sameLocalFile} from './local-files.js';
import {validateStreamManifest,DEVICE_SYNC_STREAM_LIMIT} from './sync-adapter.js';

export const SYNC_FRAME_BYTES=16384;
export const SYNC_WINDOW_BYTES=1024*1024;
const MANIFEST_LIMIT=16*1024*1024;
const validDescriptor=value=>Number.isSafeInteger(value?.id)&&value.id>=0&&Number.isSafeInteger(value.size)&&value.size>=0&&value.size<=DEVICE_SYNC_STREAM_LIMIT&&typeof value.mime==='string'&&value.mime.length<=200&&sameLocalFile(value.identity,value.identity)&&value.identity.size===value.size;

// One persisted window must be acknowledged before the next is sent. Network
// buffers and receiver JS heap therefore cannot grow with the book's size.
export class SyncStream{
  constructor({send,onBundle,onCommitted,onProgress=()=>{},storeFactory=()=>new SyncTempStore()}){
    Object.assign(this,{send,onBundle,onCommitted,onProgress,storeFactory});this.waiters=new Map();this.closed=false;this.sending=false;this.incoming=null;this.maxPendingBytes=0;
  }
  check(){if(this.closed)throw new DOMException('전송을 취소했습니다.','AbortError');}
  json(message){this.check();return this.send(JSON.stringify({p:'HTMLMemo.transfer',v:2,...message}));}
  wait(key,timeout=45000){
    this.check();if(this.waiters.has(key))throw Error('전송 확인 순서가 잘못되었습니다.');
    let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});promise.catch(()=>{});
    const timer=timeout?setTimeout(()=>{this.waiters.delete(key);reject(Error('상대 기기의 저장 확인을 받지 못했습니다. 두 기기의 연결과 저장 공간을 확인해주세요.'));},timeout):null;
    const cancel=()=>{clearTimeout(timer);this.waiters.delete(key);};this.waiters.set(key,{resolve:value=>{cancel();resolve(value);},reject:error=>{cancel();reject(error);}});return {promise,cancel};
  }
  async request(message,key,timeout){const waiting=this.wait(key,timeout);try{await this.json(message);return await waiting.promise;}catch(error){waiting.cancel();throw error;}}
  async ack(transfer,key){await this.json({type:'ack',transfer,key});}
  async sendBundle(bundle,{partial=false}={}){
    this.check();if(this.sending)throw Error('이 기기에서 이미 전송하고 있습니다.');this.sending=true;
    try{
      const descriptors=validateStreamManifest(bundle.manifest),manifest=new Blob([JSON.stringify(bundle.manifest)],{type:'application/json'});
      if(manifest.size>MANIFEST_LIMIT)throw Error('문서의 주석·이력이 한 번에 전송하기에 너무 큽니다. 문서를 나누어 보내주세요.');
      const transfer=crypto.randomUUID(),all=[{id:0,blob:manifest,mime:manifest.type,size:manifest.size,identity:await localFileIdentity(manifest)},...Array.from(descriptors.values(),d=>({...d,blob:bundle.files.get(d.id)}))];
      const total=all.reduce((n,d)=>n+d.size,0);let sent=0;
      await this.request({type:'bundle-start',transfer,partial,manifestSize:manifest.size,fileCount:descriptors.size,total},transfer+':start');
      for(const descriptor of all){
        this.check();if(!(descriptor.blob instanceof Blob)||descriptor.blob.size!==descriptor.size)throw Error('전송할 원본 파일이 변경되었습니다. 다시 시작해주세요.');
        const {blob,...wire}=descriptor;await this.request({type:'file-start',transfer,file:wire},transfer+':file:'+descriptor.id);
        for(let windowStart=0;windowStart<blob.size;windowStart+=SYNC_WINDOW_BYTES){
          const windowEnd=Math.min(blob.size,windowStart+SYNC_WINDOW_BYTES);
          for(let offset=windowStart;offset<windowEnd;offset+=SYNC_FRAME_BYTES){this.check();await this.send(await blob.slice(offset,Math.min(windowEnd,offset+SYNC_FRAME_BYTES)).arrayBuffer());}
          await this.request({type:'window-end',transfer,file:descriptor.id,offset:windowEnd},transfer+':window:'+descriptor.id+':'+windowEnd);
          this.onProgress({direction:'send',bytes:sent+windowEnd,total,file:descriptor.id,files:all.length-1});
        }
        await this.request({type:'file-end',transfer,file:descriptor.id},transfer+':end:'+descriptor.id);sent+=descriptor.size;
      }
      // Database merging may ask the user to resolve a conflict. The open peer
      // connection supplies disconnect detection without timing out that choice.
      await this.request({type:'bundle-end',transfer},transfer+':done',0);this.onProgress({direction:'send',bytes:total,total,files:all.length-1,complete:true});
    }finally{this.sending=false;}
  }
  async receive(data){
    this.check();
    if(typeof data!=='string'){
      const file=this.incoming?.file;if(!file)throw Error('파일 준비 전에 원본 조각이 도착했습니다.');
      const bytes=data instanceof Blob?await data.arrayBuffer():data;
      if(!(bytes instanceof ArrayBuffer)||bytes.byteLength===0||bytes.byteLength>SYNC_FRAME_BYTES||file.received+bytes.byteLength>file.descriptor.size||file.pendingBytes+bytes.byteLength>SYNC_WINDOW_BYTES)throw Error('받은 파일 조각의 크기나 순서가 올바르지 않습니다.');
      file.pending.push(bytes);file.pendingBytes+=bytes.byteLength;file.received+=bytes.byteLength;this.maxPendingBytes=Math.max(this.maxPendingBytes,file.pendingBytes);return;
    }
    if(data.length>32768)throw Error('전송 제어 정보가 너무 큽니다.');const message=JSON.parse(data);
    if(message?.p!=='HTMLMemo.transfer'||message.v!==2||typeof message.transfer!=='string'||!/^[\w-]{1,80}$/.test(message.transfer))throw Error('지원하지 않는 파일 전송 정보입니다.');
    const {transfer,type}=message;
    if(type==='ack'){if(typeof message.key!=='string'||!message.key.startsWith(transfer+':'))throw Error('잘못된 전송 확인입니다.');this.waiters.get(message.key)?.resolve();return;}
    if(type==='bundle-start'){
      if(this.incoming||!Number.isSafeInteger(message.manifestSize)||message.manifestSize<1||message.manifestSize>MANIFEST_LIMIT||!Number.isSafeInteger(message.fileCount)||message.fileCount<0||message.fileCount>20000||!Number.isSafeInteger(message.total)||message.total<message.manifestSize||message.total>DEVICE_SYNC_STREAM_LIMIT+MANIFEST_LIMIT)throw Error('전송할 자료의 크기나 목록이 올바르지 않습니다.');
      const store=this.storeFactory();this.incoming={transfer,store,partial:!!message.partial,manifestSize:message.manifestSize,fileCount:message.fileCount,total:message.total,received:0,files:new Map(),seen:new Set(),file:null};
      await store.open();this.check();await this.ack(transfer,transfer+':start');return;
    }
    const incoming=this.incoming;if(!incoming||incoming.transfer!==transfer)throw Error('현재 전송과 다른 파일 정보입니다.');
    if(type==='file-start'){
      const descriptor=message.file;if(incoming.file||!validDescriptor(descriptor)||incoming.seen.has(descriptor.id))throw Error('받은 파일 목록이 손상되었습니다.');
      if(!incoming.manifest){if(descriptor.id!==0||descriptor.size!==incoming.manifestSize)throw Error('문서 목록보다 원본 파일이 먼저 도착했습니다.');}
      else{const expected=incoming.descriptors.get(descriptor.id);if(!expected||expected.size!==descriptor.size||expected.mime!==descriptor.mime||!sameLocalFile(expected.identity,descriptor.identity))throw Error('전송 목록과 다른 원본 파일입니다.');}
      incoming.file={descriptor,received:0,part:0,pending:[],pendingBytes:0};await this.ack(transfer,transfer+':file:'+descriptor.id);return;
    }
    if(type==='window-end'){
      const file=incoming.file;if(!file||file.descriptor.id!==message.file||message.offset!==file.received||!file.pendingBytes)throw Error('파일 조각의 저장 확인 순서가 다릅니다.');
      await incoming.store.append(message.file,file.part++,new Blob(file.pending));file.pending=[];file.pendingBytes=0;this.check();
      this.onProgress({direction:'receive',bytes:incoming.received+file.received,total:incoming.total,file:message.file,files:incoming.fileCount});await this.ack(transfer,transfer+':window:'+message.file+':'+message.offset);return;
    }
    if(type==='file-end'){
      const file=incoming.file;if(!file||file.descriptor.id!==message.file||file.pendingBytes||file.received!==file.descriptor.size)throw Error('파일 전송이 끝나지 않았습니다.');
      const blob=await incoming.store.blob(message.file,file.descriptor.mime);this.check();if(blob.size!==file.descriptor.size||!sameLocalFile(await localFileIdentity(blob),file.descriptor.identity))throw Error('받은 원본 파일의 검증에 실패했습니다. 기존 서재는 유지됩니다.');
      if(message.file===0){const manifest=JSON.parse(await blob.text()),descriptors=validateStreamManifest(manifest);if(descriptors.size!==incoming.fileCount||Array.from(descriptors.values()).reduce((n,d)=>n+d.size,blob.size)!==incoming.total)throw Error('전송할 파일의 총 크기나 개수가 다릅니다.');incoming.manifest=manifest;incoming.descriptors=descriptors;}
      else incoming.files.set(message.file,blob);
      incoming.seen.add(message.file);incoming.received+=blob.size;incoming.file=null;await this.ack(transfer,transfer+':end:'+message.file);return;
    }
    if(type==='bundle-end'){
      if(incoming.file||!incoming.manifest||incoming.files.size!==incoming.fileCount||incoming.received!==incoming.total)throw Error('원본 파일을 모두 받지 못했습니다. 기존 서재는 유지됩니다.');
      const result=await this.onBundle({manifest:incoming.manifest,files:incoming.files},{partial:incoming.partial});this.check();await this.ack(transfer,transfer+':done');this.incoming=null;await incoming.store.clear();this.onCommitted({partial:incoming.partial},result);return;
    }
    throw Error('알 수 없는 파일 전송 단계입니다.');
  }
  destroy(){if(this.closed)return;this.closed=true;for(const waiter of [...this.waiters.values()])waiter.reject(new DOMException('전송을 취소했습니다.','AbortError'));if(this.incoming)void this.incoming.store.clear().catch(()=>{});this.incoming=null;}
}
