import {listDocuments,getDocument,listRevisions,readLibrary,commitDeviceSync,syncRecordSnapshot,documentSource} from './storage.js';
import {portableRecord,validateState,validateSettings,folderSettings} from './data-folder.js';
import {localFileIdentity,localFileWithType,sameLocalFile} from './local-files.js';
import {mergeLibraryFolders,validateFolders} from './library-folders.js';
import {PREFERENCES_KEY,PRESET_PALETTES,normalizePreferences} from './preferences.js';

export const DEVICE_SYNC_FORMAT='HTMLMemo.sync';
export const DEVICE_SYNC_LIMIT=1300000;
export const DEVICE_SYNC_STREAM_LIMIT=2*1024*1024*1024;
const idOK=id=>typeof id==='string'&&/^[\w-]{1,80}$/.test(id);
const syncEligible=record=>!record.trashedAt;
const sizeError=()=>Error('중계 서비스의 전송 용량을 넘습니다. 두 기기의 앱을 최신 버전으로 열고, 문서를 나누어 동기화해주세요.');
const b64=bytes=>{let text='';for(let i=0;i<bytes.length;i+=32768)text+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(text);};
const fingerprint=async record=>{const text=JSON.stringify({title:record.title,name:record.name,sourceIdentity:record.sourceIdentity,metadata:record.metadata,trashedAt:record.trashedAt});return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(n=>n.toString(16).padStart(2,'0')).join('');};
async function pack(blob){if(blob.size>800000)throw sizeError();return {mime:blob.type,bytes:b64(new Uint8Array(await blob.arrayBuffer())),identity:await localFileIdentity(blob)};}
async function unpack(body){
  if(!body||typeof body.bytes!=='string'||body.bytes.length>DEVICE_SYNC_LIMIT||!/^[A-Za-z0-9+/]*={0,2}$/.test(body.bytes))throw Error('받은 원본 파일이 손상되었습니다.');
  const text=atob(body.bytes),blob=new Blob([Uint8Array.from(text,c=>c.charCodeAt(0))],{type:typeof body.mime==='string'?body.mime:'text/html'});
  if(!sameLocalFile(await localFileIdentity(blob),body.identity))throw Error('받은 원본 파일의 검증에 실패했습니다. 기존 문서는 유지됩니다.');return blob;
}
const contentOf=record=>record.file?{file:record.file,...(record.originalFile?{originalFile:record.originalFile}:{})}:{html:record.html,...(record.originalFile?{originalFile:record.originalFile}:{})};
const validStamp=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const stableJSON=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const markState=record=>({annotations:record.metadata.annotations,bookmarks:record.metadata.bookmarks});
const sameMarks=(a,b)=>stableJSON(markState(a))===stableJSON(markState(b));
const markContent=item=>{const {id,...content}=item;return stableJSON(content);};
const containsMarks=(result,original)=>['annotations','bookmarks'].every(key=>{const known=new Set(result.metadata[key].map(markContent));return original.metadata[key].every(item=>known.has(markContent(item)));});
function mergeMarks(local,remote){
  const merge=(a,b)=>{
    const result=[],known=new Set(),ids=new Set();
    for(const item of [...a,...b]){
      const key=markContent(item);if(known.has(key))continue;
      const copy=structuredClone(item);if(ids.has(copy.id))do{copy.id=crypto.randomUUID();}while(ids.has(copy.id));
      known.add(key);ids.add(copy.id);result.push(copy);
    }
    return result;
  };
  return {annotations:merge(local.metadata.annotations,remote.metadata.annotations),bookmarks:merge(local.metadata.bookmarks,remote.metadata.bookmarks)};
}
function validateChoiceEnvelope(value){
  if(value.choiceToken!==undefined&&!idOK(value.choiceToken))throw Error('주석 선택 확인 정보가 손상되었습니다.');
  const decision=value.annotationDecision;
  if(decision!==undefined&&(!decision||typeof decision!=='object'||!idOK(decision.target)||!idOK(decision.token)||!['merge','local'].includes(decision.choice)))throw Error('주석 선택 결과가 올바르지 않습니다.');
}
// Non-annotation changes can advance from a common version. Annotation
// differences instead require the explicit four-way choice below.
function oneSidedResolution(previous,record,localStamp,remoteStamp){
  if(previous.id!==record.id||!sameLocalFile(previous.sourceIdentity,record.sourceIdentity))return null;
  const localBase=previous.syncSourceId===record.id&&validStamp(previous.syncFingerprint)?previous.syncFingerprint:null;
  const remoteBase=record.syncSourceId===previous.id&&validStamp(record.syncFingerprint)?record.syncFingerprint:null;
  if(remoteBase===localStamp||localBase===localStamp&&(!remoteBase||remoteBase===localBase))return 'remote';
  if(localBase===remoteStamp||remoteBase===remoteStamp)return 'local';
  return null;
}
async function sameStoredContent(previous,value){
  // Prove reuse with the actual prepared/raw bytes, never just a cached header.
  if(!sameLocalFile(previous.sourceIdentity,value.record.sourceIdentity))return false;
  const body=documentSource(previous);
  if(!(body instanceof Blob)||value.body&&!sameLocalFile(await localFileIdentity(body),await localFileIdentity(value.body)))return false;
  return !value.original||previous.originalFile instanceof Blob&&sameLocalFile(await localFileIdentity(previous.originalFile),await localFileIdentity(value.original));
}

export function normalizeSyncSettings(value){
  const {entries}=validateSettings(value),preferences=normalizePreferences(entries[PREFERENCES_KEY]?JSON.parse(entries[PREFERENCES_KEY]):{theme:entries['htmlmemo-theme']||'light'});
  preferences.annotation.paletteId||='preset-1';preferences.annotation.customColors||=[];preferences.annotation.customPalettes||=[];
  entries[PREFERENCES_KEY]=JSON.stringify(preferences);entries['htmlmemo-theme']=preferences.theme;
  const rate=Number(entries.msuite_tts_rate||1);entries.msuite_tts_rate=Number.isFinite(rate)?String(rate):'1';
  for(const key of Object.keys(entries))if(entries[key]===''&&/^(msuite_tts_voice_|htmlmemo_tts_lang_)/.test(key))delete entries[key];
  return {entries:Object.fromEntries(Object.entries(entries).sort(([a],[b])=>a.localeCompare(b)))};
}
export const syncSettingsSnapshot=storage=>normalizeSyncSettings(folderSettings(storage));
export const sameSyncSettings=(a,b)=>JSON.stringify(normalizeSyncSettings(a))===JSON.stringify(normalizeSyncSettings(b));
export function syncSettingsDifferences(local,remote){
  const a=normalizeSyncSettings(local).entries,b=normalizeSyncSettings(remote).entries,pa=JSON.parse(a[PREFERENCES_KEY]),pb=JSON.parse(b[PREFERENCES_KEY]),rows=[];
  const add=(label,x,y,different=JSON.stringify(x)!==JSON.stringify(y))=>{if(different)rows.push({label,local:String(x??'기본값'),remote:String(y??'기본값')});};
  const themes={light:'밝게',dark:'어둡게',system:'시스템 설정'},views={card:'카드',list:'목록'};
  add('화면 테마',themes[pa.theme],themes[pb.theme]);add('서재 보기',views[pa.libraryView],views[pb.libraryView]);
  const sort=p=>({modified:'수정일',created:'저장일',title:'제목'})[p.librarySort]+' · '+(p.librarySortDirection==='asc'?'오름차순':'내림차순');add('서재 정렬',sort(pa),sort(pb));
  for(const [key,label,format]of [['color','펜 색상',v=>v],['highlightColor','형광펜 색상',v=>v],['width','펜 굵기',v=>v+''],['opacity','형광펜/채움 투명도',v=>Math.round(v*100)+'%'],['penTTL','펜 표시 시간',v=>v?v+'초':'계속 표시'],['customColors','사용자 색상',v=>v.length?v.join(', '):'없음'],['customPalettes','사용자 팔레트',v=>v.length?v.map(p=>p.name+': '+p.colors.join(', ')).join(' / '):'없음']])add(label,format(pa.annotation[key]),format(pb.annotation[key]));
  const palette=p=>(PRESET_PALETTES.find(v=>v.id===p.annotation.paletteId)||p.annotation.customPalettes.find(v=>v.id===p.annotation.paletteId))?.name||'사용자 팔레트';add('색상 팔레트',palette(pa),palette(pb),pa.annotation.paletteId!==pb.annotation.paletteId);
  const position=p=>p?Math.round(p.x*100)+'%, '+Math.round(p.y*100)+'%':'기본 위치';add('툴바 위치',position(pa.toolbarPosition),position(pb.toolbarPosition));add('사이드바 폭',pa.sidebarWidth+'px',pb.sidebarWidth+'px');
  const label=key=>key==='msuite_tts_rate'?'읽어주기 속도':key.startsWith('msuite_tts_voice_')?'읽어주기 음성':key.startsWith('htmlmemo_tts_lang_')?'읽어주기 언어':'본문 목차 폭';
  for(const key of new Set([...Object.keys(a),...Object.keys(b)]))if(![PREFERENCES_KEY,'htmlmemo-theme'].includes(key))add(label(key),a[key],b[key]);
  return rows;
}
function replaceSyncSettings(storage,value){
  const next=normalizeSyncSettings(value),previous=folderSettings(storage),keys=new Set([...Object.keys(previous.entries),...Object.keys(next.entries)]);
  const replace=entries=>{for(const key of keys)storage.removeItem(key);for(const[key,value]of Object.entries(entries))storage.setItem(key,value);};
  try{replace(next.entries);}catch(error){try{replace(previous.entries);}catch{/* Preserve the original storage failure. */}throw error;}
}

// Bulk originals travel on the authenticated WebRTC channel, never in relay JSON.
export function validateStreamManifest(data){
  if(data?.format!==DEVICE_SYNC_FORMAT||data.version!==2||!Array.isArray(data.documents)||data.documents.length>10000||!Array.isArray(data.files)||data.files.length>20000)throw Error('지원하지 않는 기기 간 전송 목록입니다.');
  const folderIds=new Set(validateFolders(data.folders).map(folder=>folder.id));if(data.settings!==null)validateSettings(data.settings);
  if(data.settingsChoice!==undefined&&(data.settingsChoice!==1||data.settings===null))throw Error('앱 설정 선택 정보가 올바르지 않습니다.');
  const files=new Map();let total=0;
  for(const file of data.files){
    if(!Number.isSafeInteger(file.id)||file.id<1||files.has(file.id)||!Number.isSafeInteger(file.size)||file.size<0||file.size>DEVICE_SYNC_STREAM_LIMIT||typeof file.mime!=='string'||file.mime.length>200||!sameLocalFile(file.identity,file.identity)||file.identity.size!==file.size)throw Error('받은 원본 파일 목록이 손상되었습니다.');
    total+=file.size;if(total>DEVICE_SYNC_STREAM_LIMIT)throw Error('한 번에 전송할 수 있는 파일은 총 2GB까지입니다. 일부 문서를 나누어 보내주세요.');files.set(file.id,file);
  }
  const ids=new Set(),used=new Set();
  for(const value of data.documents){
    if(!idOK(value?.record?.id)||ids.has(value.record.id)||!['html','file'].includes(value.sourceType))throw Error('받은 문서 목록이 손상되었습니다.');ids.add(value.record.id);validateState(value,value.record.id);validateChoiceEnvelope(value);
    if(value.record.folderId&&!folderIds.has(value.record.folderId))throw Error('받은 문서의 상대 폴더가 없습니다.');
    for(const ref of [value.body,value.original])if(ref!==null){if(!files.has(ref))throw Error('문서가 참조하는 원본 파일이 없습니다.');used.add(ref);}
  }
  if(used.size!==files.size)throw Error('전송 목록에 사용하지 않는 파일이 있습니다.');return files;
}

/** MemoSuite SyncAdapter, backed by HTMLMemo's IndexedDB. Roots are intentionally absent. */
export class DeviceSyncAdapter {
  constructor({storage=localStorage,includeSources=true,includeSettings=true,isHost=()=>true,isActive=()=>true,afterCommit=async()=>{},onStage=()=>{},resolveSettings,operations={}}={}){
    this.storage=storage;this.includeSources=includeSources;this.includeSettings=includeSettings;this.isHost=isHost;this.isActive=isActive;this.afterCommit=afterCommit;
    this.ops={listDocuments,getDocument,listRevisions,readLibrary,commitDeviceSync,...operations};
    this.resolveSettings=resolveSettings;this.onStage=onStage;this.settingsSelection=undefined;this.sentSettings=null;this.settingsPlans=new WeakMap();
    this.sentChoices=new Map();this.annotationReplies=new Map();
  }
  annotationReplyIds(){return [...this.annotationReplies.keys()];}
  // Session-only receipts let the sender apply the peer choice once, after
  // checking that its previously sent version has not changed.
  async outgoingState(state){
    const stamp=await fingerprint(state.record),reply=this.annotationReplies.get(state.record.id);
    if(reply&&reply.stamp!==stamp)throw Error('선택 후 이 기기의 문서가 바뀌었습니다. 새 내용을 보존하고 동기화를 멈췄습니다. 다시 연결해주세요.');
    const choiceToken=crypto.randomUUID();this.sentChoices.set(choiceToken,{id:state.record.id,stamp});
    return {...state,choiceToken,...(reply?{annotationDecision:reply.decision}:{})};
  }
  settingsPayload(ids){
    const settings=!ids&&this.includeSettings&&this.settingsSelection!==null?(this.settingsSelection||syncSettingsSnapshot(this.storage)):null;
    this.sentSettings=settings;return {settings,...(settings&&this.settingsSelection?{settingsChoice:1}:{})};
  }
  async planSettings(data){
    if(!this.includeSettings||data.settings===null)return {settings:null};
    const local=syncSettingsSnapshot(this.storage),remote=normalizeSyncSettings(data.settings);
    if(data.settingsChoice!==undefined&&(data.settingsChoice!==1||!this.sentSettings||!this.isHost()))throw Error('앱 설정 선택을 확인하지 못했습니다. 다시 연결해주세요.');
    if(data.settingsChoice===1){
      if(!sameSyncSettings(local,this.sentSettings))throw Error('연결 후 이 기기의 앱 설정이 바뀌었습니다. 다시 연결해주세요.');
      return {settings:remote,expected:local};
    }
    if(sameSyncSettings(local,remote))return {settings:local,expected:local};
    if(typeof this.resolveSettings!=='function')throw Error('앱 설정이 다릅니다. 사용할 기기의 설정을 선택해주세요.');
    const choice=await this.resolveSettings({local,remote,differences:syncSettingsDifferences(local,remote)});this.check();
    if(!['local','remote'].includes(choice))throw new DOMException('동기화를 취소했습니다. 문서와 앱 설정은 변경하지 않았습니다.','AbortError');
    return {settings:choice==='local'?local:remote,expected:local};
  }
  prepareSettings(data){if(!this.settingsPlans.has(data))this.settingsPlans.set(data,this.planSettings(data));return this.settingsPlans.get(data);}
  check(){if(!this.isActive())throw new DOMException('동기화를 닫았습니다.','AbortError');}
  async analyzeSyncData(initial){const ids=await this.getSyncTargetIds(initial),wanted=ids?new Set(ids):null,docs=(await this.ops.listDocuments({includeTrashed:false})).filter(syncEligible),targets=wanted?docs.filter(d=>wanted.has(d.id)):docs;return {type:ids?'single':'full',count:targets.length,label:ids?targets[0]?.title:'서재 전체'};}
  async getSyncTargetIds(initial){return initial?(Array.isArray(initial)?initial:[initial]):undefined;}
  async getBackupData(ids,exclude=[]){
    this.check();this.sentChoices.clear();const library=await this.ops.readLibrary(),documents=[],wanted=ids?new Set(ids):null,excluded=new Set(exclude);let packedBytes=0;
    for(const header of library.documents){
      if(!syncEligible(header)||wanted&&!wanted.has(header.id)||excluded.has(header.id))continue;
      const doc=await this.ops.getDocument(header.id);if(!doc)throw Error('전송할 문서가 변경되었습니다. 다시 시작해주세요.');
      if(!syncEligible(doc))continue;
      const source=documentSource(doc),record=portableRecord(doc);
      if(!record.sourceIdentity)record.sourceIdentity=await localFileIdentity(doc.originalFile||source);
      const state=validateState({record,revisions:await this.ops.listRevisions(doc.id)},doc.id);
      const body=this.includeSources?await pack(source):null,original=this.includeSources&&doc.originalFile?await pack(doc.originalFile):null;
      const entry={...await this.outgoingState(state),body,original,sourceType:doc.file?'file':'html'};packedBytes+=new Blob([JSON.stringify(entry)]).size;if(packedBytes>DEVICE_SYNC_LIMIT)throw sizeError();documents.push(entry);this.check();
    }
    const result={format:DEVICE_SYNC_FORMAT,version:1,documents,folders:validateFolders(library.folders),...this.settingsPayload(ids),logs:documents.map(d=>({title:d.record.title}))};
    if(new Blob([JSON.stringify(result)]).size>DEVICE_SYNC_LIMIT)throw sizeError();return result;
  }
  async getStreamBundle(ids,exclude=[]){
    this.check();this.sentChoices.clear();const library=await this.ops.readLibrary(),documents=[],files=new Map(),descriptors=[],identities=new Map(),wanted=ids?new Set(ids):null,excluded=new Set(exclude);let total=0;
    const add=async blob=>{
      this.check();const identity=await localFileIdentity(blob),mime=blob.type||'text/html',key=identity.digest+':'+identity.size+':'+mime;
      if(identities.has(key))return identities.get(key);
      total+=blob.size;if(total>DEVICE_SYNC_STREAM_LIMIT)throw Error('한 번에 전송할 수 있는 파일은 총 2GB까지입니다. 일부 문서를 나누어 보내주세요.');
      const id=descriptors.length+1;descriptors.push({id,size:blob.size,mime,identity});files.set(id,blob);identities.set(key,id);return id;
    };
    for(const header of library.documents){
      if(!syncEligible(header)||wanted&&!wanted.has(header.id)||excluded.has(header.id))continue;
      const doc=await this.ops.getDocument(header.id);if(!doc)throw Error('전송할 문서가 변경되었습니다. 다시 시작해주세요.');
      if(!syncEligible(doc))continue;
      const source=documentSource(doc),record=portableRecord(doc);
      if(!record.sourceIdentity)record.sourceIdentity=await localFileIdentity(doc.originalFile||source);
      const state=validateState({record,revisions:await this.ops.listRevisions(doc.id)},doc.id);
      documents.push({...await this.outgoingState(state),body:this.includeSources?await add(source):null,original:this.includeSources&&doc.originalFile?await add(doc.originalFile):null,sourceType:doc.file?'file':'html'});this.check();
    }
    const manifest={format:DEVICE_SYNC_FORMAT,version:2,documents,files:descriptors,folders:validateFolders(library.folders),...this.settingsPayload(ids),logs:documents.map(d=>({title:d.record.title}))};
    validateStreamManifest(manifest);return {manifest,files};
  }
  async findReusableStreamFiles(manifest){
    this.check();const descriptors=validateStreamManifest(manifest),found=new Map();
    if(!descriptors.size)return found;
    const key=identity=>identity.digest+':'+identity.size,wanted=new Map(),sizes=new Map();
    for(const descriptor of descriptors.values()){
      const identityKey=key(descriptor.identity);if(!wanted.has(identityKey)){wanted.set(identityKey,[]);sizes.set(descriptor.size,(sizes.get(descriptor.size)||0)+1);}
      wanted.get(identityKey).push(descriptor);
    }
    const sourceIds=new Set(manifest.documents.map(value=>value.record.id)),sourceKeys=new Set(manifest.documents.filter(value=>sameLocalFile(value.record.sourceIdentity,value.record.sourceIdentity)).map(value=>key(value.record.sourceIdentity)));
    const headers=(await this.ops.readLibrary()).documents.filter(syncEligible);
    // Local document IDs, filenames and root names may differ. Try likely
    // sources first, but prove every reuse with the actual immutable bytes.
    const likely=header=>sourceIds.has(header.id)||sameLocalFile(header.sourceIdentity,header.sourceIdentity)&&sourceKeys.has(key(header.sourceIdentity));
    for(const header of [...headers.filter(likely),...headers.filter(header=>!likely(header))]){
      this.check();if(!wanted.size)break;
      if(!likely(header)&&Number.isSafeInteger(header.byteSize)&&!sizes.has(header.byteSize)&&!sizes.has(header.sourceIdentity?.size))continue;
      const doc=await this.ops.getDocument(header.id);this.check();if(!doc||!syncEligible(doc))continue;
      for(const blob of [documentSource(doc),doc.originalFile]){
        if(!(blob instanceof Blob)||!sizes.has(blob.size))continue;
        const identity=await localFileIdentity(blob);this.check();const identityKey=key(identity),matches=wanted.get(identityKey);if(!matches)continue;
        for(const descriptor of matches)found.set(descriptor.id,localFileWithType(blob,descriptor.mime));
        wanted.delete(identityKey);const remaining=sizes.get(blob.size)-1;if(remaining)sizes.set(blob.size,remaining);else sizes.delete(blob.size);
      }
    }
    return found;
  }
  async mergeStreamBundle({manifest,files},resolver){
    this.onStage('받은 원본 파일을 검증하는 중…');
    this.check();const descriptors=validateStreamManifest(manifest),verified=new Map();
    if(!(files instanceof Map)||files.size!==descriptors.size)throw Error('전송이 끝나지 않았습니다. 기존 문서는 유지됩니다.');
    const documents=manifest.documents.filter(value=>syncEligible(value.record)),used=new Set(documents.flatMap(value=>[value.body,value.original]).filter(id=>id!==null));
    for(const [id,descriptor] of descriptors){if(!used.has(id))continue;const blob=files.get(id);if(!(blob instanceof Blob)||blob.size!==descriptor.size||!sameLocalFile(await localFileIdentity(blob),descriptor.identity))throw Error('받은 원본 파일의 검증에 실패했습니다. 기존 문서는 유지됩니다.');verified.set(id,blob);this.check();}
    const incoming=await Promise.all(documents.map(async value=>({...validateState(value,value.record.id),choiceToken:value.choiceToken,annotationDecision:value.annotationDecision,body:value.body===null?null:verified.get(value.body),original:value.original===null?null:verified.get(value.original),sourceType:value.sourceType,fingerprint:await fingerprint(value.record)})));
    return this.mergePreparedData(manifest,incoming,resolver);
  }
  async mergeBackupData(data,resolver){
    this.check();
    if(data?.format!==DEVICE_SYNC_FORMAT||data.version!==1||!Array.isArray(data.documents)||data.documents.length>10000||new Blob([JSON.stringify(data)]).size>DEVICE_SYNC_LIMIT)throw Error('지원하지 않거나 너무 큰 HTMLMemo 동기화 데이터입니다.');
    const remoteFolders=validateFolders(data.folders),folderIds=new Set(remoteFolders.map(folder=>folder.id)),settings=data.settings===null?null:validateSettings(data.settings),seen=new Set(),incoming=[];
    for(const value of data.documents){
      if(!idOK(value?.record?.id)||seen.has(value.record.id)||!['html','file'].includes(value.sourceType))throw Error('받은 문서 목록이 손상되었습니다.');seen.add(value.record.id);
      const state=validateState(value,value.record.id);validateChoiceEnvelope(value);
      if(state.record.folderId&&!folderIds.has(state.record.folderId))throw Error('받은 문서의 상대 폴더가 없습니다.');
      if(!syncEligible(state.record))continue;
      const body=value.body?await unpack(value.body):null,original=value.original?await unpack(value.original):null;
      incoming.push({...state,choiceToken:value.choiceToken,annotationDecision:value.annotationDecision,body,original,sourceType:value.sourceType,fingerprint:await fingerprint(state.record)});
    }
    return this.mergePreparedData(data,incoming,resolver);
  }
  async mergePreparedData(data,incoming,resolver){
    this.check();const remoteFolders=validateFolders(data.folders);if(data.settings!==null)validateSettings(data.settings);
    const settingsPlan=await this.prepareSettings(data);this.check();
    this.onStage('마지막 동기화 이후의 주석 변경을 비교하는 중…');
    const local=await this.ops.readLibrary(),tree=mergeLibraryFolders(local.folders,remoteFolders,()=>crypto.randomUUID()),entries=[],mirrored=[],conflicts=[],plans=[],replies=new Map(),consumedTokens=new Set(),assigned=new Set();
    const available=local.documents.filter(syncEligible),protectedIds=new Set(local.documents.filter(record=>!syncEligible(record)).map(record=>record.id)),reserved=new Set(incoming.flatMap(value=>[value.record.id,...(value.annotationDecision?[value.annotationDecision.target]:[])]));
    // Index this merge's immutable header snapshot once. Actual content and
    // the current record are still read and verified before any replacement.
    const byId=new Map(),bySource=new Map(),mirrors=new Map(),histories=new Map();
    const sourceKey=identity=>sameLocalFile(identity,identity)?identity.digest+':'+identity.size:null;
    for(const header of available){
      byId.set(header.id,header);
      if(header.syncSourceId){if(!mirrors.has(header.syncSourceId))mirrors.set(header.syncSourceId,[]);mirrors.get(header.syncSourceId).push(header);}
      const key=sourceKey(header.sourceIdentity);
      if(key&&!reserved.has(header.id)){if(!bySource.has(key))bySource.set(key,{items:[],next:0});bySource.get(key).items.push(header);}
    }
    const sourceMatch=record=>{const group=bySource.get(sourceKey(record.sourceIdentity));if(!group)return;while(group.next<group.items.length&&assigned.has(group.items[group.next].id))group.next++;return group.items[group.next];};
    const revisionsFor=id=>{if(!histories.has(id))histories.set(id,this.ops.listRevisions(id));return histories.get(id);};
    for(const value of incoming){
      const record=value.record,stamp=value.fingerprint;
      if(!syncEligible(record)||protectedIds.has(record.id))continue;
      const decision=value.annotationDecision,proof=decision?this.sentChoices.get(decision.token):null;
      if(decision&&(!this.isHost()||!proof||proof.id!==decision.target||consumedTokens.has(decision.token)))throw Error('요청하지 않은 주석 선택 결과입니다. 기존 내용은 유지했습니다. 다시 연결해주세요.');
      if(!decision&&mirrors.get(record.id)?.some(d=>d.syncFingerprint===stamp&&sameMarks(d,record)&&(d.folderId||'')===(tree.mapping.get(record.folderId||'')||''))){continue;}
      const match=decision?byId.get(decision.target):byId.get(record.id)||sourceMatch(record);
      const previous=match?await this.ops.getDocument(match.id):null;
      if(previous&&!syncEligible(previous))continue;
      if(previous&&assigned.has(previous.id))throw Error('같은 문서에 여러 선택 결과가 도착했습니다. 기존 내용은 유지했습니다. 다시 연결해주세요.');
      if(previous)assigned.add(previous.id);
      const localStamp=previous?await fingerprint(previous):null,sameFolder=previous&&(previous.folderId||'')===(tree.mapping.get(record.folderId||'')||'');
      if(decision&&(!previous||localStamp!==proof.stamp))throw Error('선택 중 이 기기의 문서가 바뀌었습니다. 새 내용을 보존하고 동기화를 멈췄습니다. 다시 연결해주세요.');
      if(!decision&&previous&&localStamp===stamp&&sameFolder){mirrored.push(previous.id);continue;}
      if(!value.body&&!previous)throw Error('이 기기에 ‘'+record.title+'’의 원본이 없습니다. 두 기기를 최신 버전으로 열고 다시 연결해주세요.');
      if(!value.body&&previous&&!sameLocalFile(previous.sourceIdentity||await localFileIdentity(previous.originalFile||previous.file||new Blob([previous.html],{type:'text/html'})),record.sourceIdentity))throw Error('문서 원본이 다릅니다. 원본 파일을 포함해 다시 보내주세요.');
      const reuse=previous&&await sameStoredContent(previous,value);
      if(decision){
        if(!reuse)throw Error('선택한 주석의 원본 HTML이 다릅니다. 기존 내용은 유지했습니다.');
        if(decision.choice==='merge'&&!containsMarks(record,previous))throw Error('합친 주석에 이 기기의 내용이 빠져 있습니다. 기존 내용은 유지했습니다.');consumedTokens.add(decision.token);
        if(sameMarks(previous,record)){mirrored.push(previous.id);continue;}
        plans.push({type:'annotations',value,previous,resolution:'remote',confirmed:true});continue;
      }
      if(reuse&&!sameMarks(previous,record)){
        if(!value.choiceToken)throw Error('주석·북마크 선택을 사용하려면 두 기기 모두 앱을 최신 버전으로 업데이트해주세요.');
        if(this.isHost()&&this.sentChoices.size)throw Error('상대 기기에서 주석 선택 확인을 받지 못했습니다. 기존 내용은 유지했습니다. 다시 연결해주세요.');
        plans.push({type:'annotations',value,previous});
        conflicts.push({id:plans.length-1,type:'annotations',title:record.title,localContent:`이 기기: 주석 ${previous.metadata.annotations.length}개 · 북마크 ${previous.metadata.bookmarks.length}개`,remoteContent:`상대 기기: 주석 ${record.metadata.annotations.length}개 · 북마크 ${record.metadata.bookmarks.length}개`});continue;
      }
      const automatic=previous&&sameFolder?oneSidedResolution(previous,record,localStamp,stamp):null,plan={value,previous,reuse,resolution:previous?automatic:'remote',automatic:!!automatic};plans.push(plan);
      if(previous&&!automatic)conflicts.push({id:plans.length-1,type:'memo',title:record.title,localDate:new Date(previous.modified),remoteDate:new Date(record.modified),localContent:`이 기기: 주석 ${previous.metadata.annotations.length}개 · 북마크 ${previous.metadata.bookmarks.length}개`,remoteContent:`상대 기기: 주석 ${record.metadata.annotations.length}개 · 북마크 ${record.metadata.bookmarks.length}개`});
    }
    if(conflicts.length){if(!resolver)throw Error('서로 다른 주석·문서가 있어 보관 방법을 선택해야 합니다.');const choices=await resolver(conflicts);this.check();if(choices===null)throw new DOMException('동기화를 취소했습니다. 문서와 앱 설정은 변경하지 않았습니다.','AbortError');if(!Array.isArray(choices)||choices.length!==conflicts.length||choices.some((c,i)=>!(conflicts[i].type==='annotations'?['merge','local','remote','skip']:['local','remote','both']).includes(c)))throw Error('충돌 선택을 완료하지 않았습니다.');conflicts.forEach((c,i)=>plans[c.id].resolution=choices[i]);}
    for(const {type,value,previous,resolution,automatic,reuse,confirmed} of plans){
      if(type==='annotations'){
        // Keep each device document identity, source and view; replace marks only.
        if(resolution==='skip'){mirrored.push(previous.id);continue;}
        const marks=resolution==='merge'?mergeMarks(previous,value.record):markState(resolution==='local'?previous:value.record);
        const record={...portableRecord(previous),modified:Date.now(),metadata:{...previous.metadata,...marks},syncSourceId:value.record.id,syncFingerprint:value.fingerprint};
        validateState({record,revisions:[]},record.id);
        if(!sameMarks(previous,record)){
          const history=await revisionsFor(previous.id),key=revision=>{const {id,documentId,...state}=revision;return stableJSON(state);},known=new Set(history.map(key));
          const revisions=value.revisions.filter(revision=>!known.has(key(revision))),created=Date.now();
          revisions.push({created,kind:'sync-before',...structuredClone(markState(previous))},{created,kind:resolution==='merge'?'sync-merge':'sync-choice',...structuredClone(marks)});
          entries.push({record,content:null,revisions,expected:syncRecordSnapshot(previous),previousHistoryVersion:previous.historyVersion||0});
        }
        if(!confirmed&&['merge','local'].includes(resolution))replies.set(previous.id,{stamp:await fingerprint(record),decision:{target:value.record.id,token:value.choiceToken,choice:resolution}});
        else mirrored.push(previous.id);
        continue;
      }
      if(resolution==='local')continue;
      const record={...value.record,folderId:tree.mapping.get(value.record.folderId||'')||'',syncSourceId:value.record.id,syncFingerprint:value.fingerprint};
      const content=reuse?null:value.body?(value.sourceType==='file'||value.body.size>=4*1024*1024?{file:value.body}:{html:await value.body.text()}):contentOf(previous);
      if(value.original&&content)content.originalFile=value.original;
      if(previous&&resolution==='remote'){
        // Explicit conflict replacement keeps a full copy. One-sided updates
        // retain the existing source record and append only unseen revisions.
        if(!automatic){const backup={...portableRecord(previous),id:crypto.randomUUID(),title:previous.title+' (동기화 전 보관본)'};
        entries.push({record:backup,content:contentOf(previous),revisions:await revisionsFor(previous.id),expected:null});}
        record.id=previous.id;
      }else if(previous){record.id=crypto.randomUUID();record.title+=' (상대 기기)';}
      let revisions=value.revisions;if(previous&&resolution==='remote'){const key=revision=>{const {id,documentId,...state}=revision;return JSON.stringify(state);};const known=new Set((await revisionsFor(previous.id)).map(key));revisions=revisions.filter(revision=>!known.has(key(revision)));}
      entries.push({record,content:previous&&resolution==='both'&&content===null?contentOf(previous):content,revisions,expected:previous&&resolution==='remote'?syncRecordSnapshot(previous):null,previousHistoryVersion:previous?.historyVersion||0});mirrored.push(record.id);
    }
    this.check();if(settingsPlan.expected&&!sameSyncSettings(syncSettingsSnapshot(this.storage),settingsPlan.expected))throw Error('선택 중 이 기기의 앱 설정이 바뀌었습니다. 다시 연결해주세요.');
    this.onStage('변경된 주석과 이력을 앱에 저장하는 중…');await this.ops.commitDeviceSync(entries,tree.folders,local.folders);
    if(settingsPlan.settings&&!sameSyncSettings(syncSettingsSnapshot(this.storage),settingsPlan.settings)){
      if(!sameSyncSettings(syncSettingsSnapshot(this.storage),settingsPlan.expected))throw Error('저장 중 앱 설정이 바뀌어 설정 적용을 멈췄습니다. 문서는 보존됩니다. 다시 연결해주세요.');
      replaceSyncSettings(this.storage,settingsPlan.settings);
    }
    this.settingsSelection=settingsPlan.settings;
    this.onStage('변경 내용을 전용 저장 폴더에 반영하는 중…');await this.afterCommit();this.check();this.annotationReplies=replies;for(const token of consumedTokens)this.sentChoices.delete(token);return mirrored;
  }
}
