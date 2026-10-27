// A separate, disposable database. The user's library/root handles are never
// touched until the complete, verified bundle is committed by sync-adapter.
let connection;
async function database(){
  if(!connection)connection=new Promise((resolve,reject)=>{
    const request=indexedDB.open('HTMLMemo-device-sync-temp-v1',1);
    request.onupgradeneeded=()=>{request.result.createObjectStore('parts');request.result.createObjectStore('sessions');};
    request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>{db.close();connection=null;};resolve(db);};
    request.onerror=()=>{connection=null;reject(request.error);};
  });return connection;
}
const range=prefix=>IDBKeyRange.bound(prefix,prefix+'\uffff');
function storageError(error){return error?.name==='QuotaExceededError'?Error('이 기기의 임시 저장 공간이 부족합니다. 공간을 확보한 뒤 다시 연결해주세요. 기존 서재는 유지됩니다.'):error||Error('전송 중인 파일을 임시 저장하지 못했습니다. 기존 서재는 유지됩니다.');}
async function removeSession(id){
  const db=await database();await new Promise((resolve,reject)=>{
    const tx=db.transaction(['parts','sessions'],'readwrite'),parts=tx.objectStore('parts');parts.delete(range(id+'/'));tx.objectStore('sessions').delete(id);tx.oncomplete=resolve;tx.onabort=()=>reject(storageError(tx.error));tx.onerror=()=>reject(storageError(tx.error));
  });
}
export class SyncTempStore{
  constructor(){this.id=crypto.randomUUID();this.closed=false;}
  async open(){
    const db=await database(),stale=await new Promise((resolve,reject)=>{
      const tx=db.transaction('sessions','readonly'),request=tx.objectStore('sessions').getAll();tx.oncomplete=()=>resolve(request.result.filter(s=>s.updated<Date.now()-7*86400000).map(s=>s.id));tx.onerror=()=>reject(storageError(tx.error));
    });for(const id of stale)await removeSession(id);
    if(this.closed)throw new DOMException('전송을 취소했습니다.','AbortError');return this;
  }
  async append(file,part,blob){
    if(this.closed)throw new DOMException('전송을 취소했습니다.','AbortError');
    const db=await database();if(this.closed)throw new DOMException('전송을 취소했습니다.','AbortError');await new Promise((resolve,reject)=>{
      const tx=db.transaction(['parts','sessions'],'readwrite');tx.objectStore('parts').put(blob,this.id+'/'+file+'/'+String(part).padStart(8,'0'));tx.objectStore('sessions').put({id:this.id,updated:Date.now()},this.id);tx.oncomplete=resolve;tx.onabort=()=>reject(storageError(tx.error));tx.onerror=()=>reject(storageError(tx.error));
    });
  }
  async blob(file,mime){
    if(this.closed)throw new DOMException('전송을 취소했습니다.','AbortError');const db=await database();if(this.closed)throw new DOMException('전송을 취소했습니다.','AbortError');
    return new Promise((resolve,reject)=>{const tx=db.transaction('parts','readonly'),request=tx.objectStore('parts').getAll(range(this.id+'/'+file+'/'));tx.oncomplete=()=>resolve(new Blob(request.result,{type:mime}));tx.onabort=()=>reject(storageError(tx.error));tx.onerror=()=>reject(storageError(tx.error));});
  }
  async clear(){this.closed=true;await removeSession(this.id);}
}
