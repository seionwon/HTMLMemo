import {publicAppURL} from './install.js';
import { listDocuments, getDocument, listRevisions, restoreFolderDocuments, getSetting, setSetting, onStorageChange, permission, readLibrary } from './storage.js';
import { localFileIdentity } from './local-files.js';
import { PREFERENCES_KEY, normalizePreferences } from './preferences.js';
import { validateAnnotations,validPDFPosition } from './model.js';
import {LIBRARY_FOLDERS_KEY,validateFolders,mergeLibraryFolders,documentCopyName} from './library-folders.js';
import {syncFolderTree,cleanupFolderTree} from './folder-tree.js';

export const FOLDER_MANIFEST = 'HTMLMemo-library.json';
export const FOLDER_PREVIOUS = 'HTMLMemo-library.previous.json';
export const FOLDER_DATA = 'HTMLMemo-data';
export const FOLDER_GUIDE = '새 기기로 옮기는 방법.txt';
export const CHROME_REQUIRED_MESSAGE = '이 앱은 구글 크롬에서만 정상적으로 작동합니다. 크롬에서 실행해주세요.';
export function supportsDataFolder(window,navigator) {
  return typeof window.showDirectoryPicker==='function'&&typeof navigator.locks?.request==='function';
}
export function storageFolderName(value) {
  const name=typeof value==='string'?value.trim().normalize('NFC'):'';
  if(!name||name==='.'||name==='..'||/[\u0000-\u001f\u007f/\\<>:"|?*]/.test(name)||/[. ]$/.test(name)||new TextEncoder().encode(name).length>240||/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name))throw Error('폴더 이름에는 경로나 특수문자 없이 짧은 이름을 입력해주세요.');
  return name;
}
/** Only inspect the user-granted directory; never search outside that permission. */
export async function createStorageSubfolder(parent,value,previousAttempt=null) {
  const name=storageFolderName(value);let base=parent;
  if(!/^(documents|문서)$/i.test(parent.name||'')){
    for(const candidate of ['Documents','문서']){
      try{base=await parent.getDirectoryHandle(candidate);break;}
      catch(error){if(!['NotFoundError','TypeMismatchError'].includes(error.name))throw error;}
    }
  }
  let child;
  try{child=await base.getDirectoryHandle(name);}
  catch(error){if(error.name!=='NotFoundError')throw error;return base.getDirectoryHandle(name,{create:true});}
  if(previousAttempt&&(child===previousAttempt||typeof child.isSameEntry==='function'&&await child.isSameEntry(previousAttempt)))return child;
  for(const marker of [FOLDER_MANIFEST,FOLDER_PREVIOUS]){
    try{await child.getFileHandle(marker);return child;}
    catch(error){if(error.name!=='NotFoundError')throw error;}
  }
  for await(const [entry] of child.entries())if(!['.DS_Store','desktop.ini','Thumbs.db'].includes(entry))throw Error('같은 이름의 폴더에 다른 파일이 있습니다. 다른 이름을 입력하거나 기존 LibreMemo 저장 폴더를 연결해주세요.');
  return child;
}
const FORMAT = 'HTMLMemo.library';
const CHECKPOINT = 'data-folder-checkpoint';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const validId = value => typeof value === 'string' && /^[\w-]{1,80}$/.test(value);
const refName = /^[a-f0-9]{64}\.(?:json|html|htm|mhtml|mht|pdf|epub|epub3|mobi|azw|azw3|fb2|fbz|fb2\.zip|cbz|hwp|hwpx|hml|docx|odt|ott|xlsx|xlsm|xls|csv|tsv|ods|ots|pptx|odp|otp|md|markdown|txt)$/;
const portableKey = key => [PREFERENCES_KEY,'htmlmemo-theme','htmlmemo-doc-toc-width-v1','htmlmemo-doc-toc-expanded-width-v1','msuite_tts_rate'].includes(key) || /^msuite_tts_voice_[\w-]{1,40}$/.test(key) || /^htmlmemo_tts_lang_[\w-]{1,80}$/.test(key);
const jsonBlob = value => new Blob([JSON.stringify(value)], {type:'application/json'});
const uid = () => crypto.randomUUID();
const message = error => ['NotAllowedError','SecurityError'].includes(error?.name)
  ? '폴더 쓰기 권한이 필요합니다. 다시 연결을 눌러 허용해주세요. 앱 내부의 변경은 유지됩니다.'
  : '폴더에 저장하지 못했습니다. 앱 내부의 변경은 유지됩니다. '+(error?.message || String(error));

/** Only LibreMemo's own settings are portable, never other same-origin apps or handles. */
export function folderSettings(storage) {
  const keys=new Set([PREFERENCES_KEY,'htmlmemo-theme','htmlmemo-doc-toc-width-v1','htmlmemo-doc-toc-expanded-width-v1','msuite_tts_rate']);
  for(let i=0;i<storage.length;i++){const key=storage.key(i);if(portableKey(key))keys.add(key);}
  const entries={};for(const key of keys){const value=storage.getItem(key);if(value!==null)entries[key]=value;}
  return validateSettings({entries});
}
export function validateSettings(value) {
  if(!object(value?.entries) || Object.keys(value.entries).length>50000)throw Error('폴더의 설정 형식이 올바르지 않습니다.');
  const entries={};
  for(const [key,item] of Object.entries(value.entries)){
    if(!portableKey(key)||typeof item!=='string'||item.length>131072)throw Error('지원하지 않는 폴더 설정입니다.');
    if(key===PREFERENCES_KEY)normalizePreferences(JSON.parse(item));
    if(key==='htmlmemo-theme'&&!['light','dark','system'].includes(item))throw Error('폴더의 테마 설정이 손상되었습니다.');
    entries[key]=item;
  }
  return {entries};
}
export function applyFolderSettings(storage, settings) {
  const {entries}=validateSettings(settings);
  for(const [key,value] of Object.entries(entries))storage.setItem(key,value);
}
export function portableRecord(record) {
  const result={};
  for(const key of ['id','title','name','source','created','modified','metadata','nativeScroll','byteSize','sourceIdentity','folderId','trashedAt','syncSourceId','syncFingerprint'])if(record[key]!==undefined)result[key]=record[key];
  return result;
}
export function validateState(value, id) {
  const record=value?.record;
  if(!object(record)||record.id!==id||!validId(id)||typeof record.title!=='string'||record.title.length>1000||typeof record.name!=='string'||record.name.length>1000||!Number.isFinite(record.created)||!Number.isFinite(record.modified)||!object(record.metadata)||record.metadata.version!==1||!object(record.metadata.view)||!object(record.metadata.viewport)||!Array.isArray(value.revisions))throw Error('폴더의 문서 정보가 손상되었습니다.');
  const validateMarks = metadata => {
    validateAnnotations(metadata.annotations);
    if(metadata.bookmarks?.some(mark=>mark.pdfPosition!=null&&!validPDFPosition(mark.pdfPosition)))throw Error('PDF 북마크 위치가 손상되었습니다.');
    if(metadata.bookmarks?.some(mark=>mark.pdfQuoteOffset!=null&&(!Number.isFinite(mark.pdfQuoteOffset)||Math.abs(mark.pdfQuoteOffset)>1)))throw Error('PDF 북마크의 본문 위치가 손상되었습니다.');
    if(metadata.view?.pdfPosition!=null&&!validPDFPosition(metadata.view.pdfPosition))throw Error('PDF 읽기 위치가 손상되었습니다.');
    if(!Array.isArray(metadata.bookmarks)||metadata.bookmarks.length>10000||metadata.bookmarks.some(b=>typeof b?.id!=='string'||typeof b.title!=='string'||!Number.isFinite(b.top)||!Number.isFinite(b.left)))throw Error('폴더의 북마크가 손상되었습니다.');
  };
  validateMarks(record.metadata);
  if(record.folderId!==undefined&&record.folderId!==''&&!validId(record.folderId))throw Error('문서의 서재 폴더 위치가 손상되었습니다.');
  if(record.trashedAt!==undefined&&(!Number.isFinite(record.trashedAt)||record.trashedAt<=0||record.trashedAt>8640000000000000))throw Error('문서의 휴지통 삭제일이 손상되었습니다.');
  for(const revision of value.revisions){if(!object(revision)||!Number.isFinite(revision.created))throw Error('폴더의 주석 이력이 손상되었습니다.');validateMarks(revision);}
  return {record:portableRecord(record),revisions:value.revisions.map(({id:oldId,documentId,...revision})=>revision)};
}
function validateManifest(value) {
  if(!object(value)||value.format!==FORMAT||![1,2].includes(value.version)||!validId(value.id)||!validId(value.revision)||!Array.isArray(value.documents)||value.documents.length>100000)throw Error('지원하지 않거나 손상된 LibreMemo 데이터 폴더입니다.');
  const folders=validateFolders(value.folders||(value.version===1?[]:null)),folderIds=new Set(['',...folders.map(f=>f.id)]);
  const seen=new Set();
  for(const entry of value.documents){
    if(!validId(entry?.id)||seen.has(entry.id)||!['html','file'].includes(entry.sourceType)||!/^[a-f0-9]{64}$/.test(entry.stamp)||!/^[a-f0-9]{64}$/.test(entry.annotationStamp))throw Error('폴더의 문서 목록이 손상되었습니다.');
    seen.add(entry.id);checkRef(entry.source);checkRef(entry.state);checkRef(entry.history);if(entry.original)checkRef(entry.original);
    if(value.version===2||entry.copy){const copy=entry.copy,suffix=(entry.original||entry.source).name.slice(64);if(!object(copy)||!folderIds.has(copy.folderId)||typeof copy.name!=='string'||copy.name.length>220||/[\u0000-\u001f\u007f/\\<>:"|?*]/.test(copy.name)||/^[. ]/.test(copy.name)||!copy.name.endsWith(`[${entry.id}]${suffix}`))throw Error('원본 복사본의 폴더 경로가 올바르지 않습니다.');}
  }
  checkRef(value.settings);return value;
}
function checkRef(ref) { if(!object(ref)||!refName.test(ref.name)||!Number.isSafeInteger(ref.size)||ref.size<0)throw Error('폴더 파일 경로 또는 크기가 올바르지 않습니다.'); }
async function optionalText(folder,name) {
  try{const file=await (await folder.getFileHandle(name)).getFile();if(file.size>64*1024*1024)throw Error('폴더 목록 파일이 너무 큽니다.');return await file.text();}
  catch(error){if(error.name==='NotFoundError')return null;throw error;}
}
async function atomicWrite(folder,name,contents) {
  let handle,created=false,writer;
  try{handle=await folder.getFileHandle(name);}catch(error){if(error.name!=='NotFoundError')throw error;handle=await folder.getFileHandle(name,{create:true});created=true;}
  try{writer=await handle.createWritable();await writer.write(contents);await writer.close();}
  catch(error){
    await writer?.abort().catch(()=>{});
    // A failed first create can leave an empty manifest; remove only our new, still-empty file.
    if(created){try{if((await handle.getFile()).size===0)await folder.removeEntry(name);}catch{/* A revoked permission may also prevent cleanup; retain the error. */}}
    throw error;
  }
}
async function objectFile(data,ref,verify=false) {
  checkRef(ref);const file=await (await data.getFileHandle(ref.name)).getFile();
  if(file.size!==ref.size || verify && (await localFileIdentity(file)).digest!==ref.name.slice(0,64)){const error=Error('폴더의 파일이 누락되거나 손상되었습니다: '+ref.name);error.name='DataIntegrityError';throw error;}
  return file;
}
async function storeObject(data,blob,suffix) {
  const {digest}=await localFileIdentity(blob),ref={name:digest+'.'+suffix,size:blob.size};
  try{await objectFile(data,ref,true);}catch(error){if(!['NotFoundError','DataIntegrityError'].includes(error.name))throw error;await atomicWrite(data,ref.name,blob);}
  return ref;
}
async function manifestAt(folder,name=FOLDER_MANIFEST) {
  const raw=await optionalText(folder,name);return raw===null?null:{raw,manifest:validateManifest(JSON.parse(raw))};
}
async function loadSnapshot(folder,head) {
  const data=await folder.getDirectoryHandle(FOLDER_DATA),documents=[];
  const settingsFile=await objectFile(data,head.manifest.settings,true);
  if(settingsFile.size>16*1024*1024)throw Error('폴더의 설정 파일이 너무 큽니다.');
  const settings=validateSettings(JSON.parse(await settingsFile.text()));
  const folders=validateFolders(head.manifest.folders||[]),folderIds=new Set(['',...folders.map(f=>f.id)]);
  for(const entry of head.manifest.documents){
    const stateFile=await objectFile(data,entry.state,true);
    if(stateFile.size>128*1024*1024)throw Error('폴더의 주석 이력 파일이 너무 큽니다.');
    const historyFile=await objectFile(data,entry.history,true);if(historyFile.size>128*1024*1024)throw Error('폴더의 주석 이력 파일이 너무 큽니다.');
    const state=validateState({...JSON.parse(await stateFile.text()),revisions:JSON.parse(await historyFile.text()).revisions},entry.id);
    if(!folderIds.has(state.record.folderId||'')||entry.copy&&(state.record.folderId||'')!==entry.copy.folderId)throw Error('문서의 서재 폴더 위치가 목록과 일치하지 않습니다.');
    const source=await objectFile(data,entry.source,true),original=entry.original?await objectFile(data,entry.original,true):null;
    documents.push({...state,source,original,sourceType:entry.sourceType});
  }
  return {head,documents,settings,folders};
}
async function recoverSnapshot(folder) {
  let failure;
  try{const head=await manifestAt(folder);if(head)return await loadSnapshot(folder,head);}
  catch(error){failure=error;}
  try{const previous=await manifestAt(folder,FOLDER_PREVIOUS);if(previous)return {...await loadSnapshot(folder,previous),recovered:true};}
  catch(error){failure ||= error;}
  if(failure)throw failure;
  return null;
}
function references(manifest) { return manifest?[manifest.settings,...manifest.documents.flatMap(e=>[e.source,e.state,e.history,e.original].filter(Boolean))]:[]; }
function sameHead(a,b) { return a?.id===b?.id && a?.revision===b?.revision; }
const defaultLock = action => {
  if(!navigator.locks?.request)throw Error(CHROME_REQUIRED_MESSAGE);
  return navigator.locks.request('htmlmemo-data-folder',action);
};

/** Internal commits stay fast; one locked, incremental folder writer publishes a complete snapshot last. */
export class DataFolder {
  constructor({storage,report=()=>{},onRestored=()=>{},operations={},lock=defaultLock,delay=500}={}) {
    this.storage=storage;this.report=report;this.onRestored=onRestored;this.lock=lock;this.delay=delay;
    this.ops={listDocuments,getDocument,listRevisions,restoreFolderDocuments,getSetting,setSetting,readLibrary,...operations};
    if(operations.listDocuments&&!operations.readLibrary)this.ops.readLibrary=async()=>({documents:await this.ops.listDocuments(),folders:await this.ops.getSetting(LIBRARY_FOLDERS_KEY)||[]});
    this.handle=null;this.head=null;this.state='unconnected';this.error=null;this.revision=0;this.saved=0;this.running=null;this.timer=null;this.restoring=false;this.dirty=new Set();this.allDirty=true;this.historyVersions=new Map();
    this.unsubscribe=onStorageChange(id=>this.schedule({id}));
  }
  publish(state,error=null) { this.state=state;this.error=error;this.report(this); }
  get pending() { return !!this.handle&&(this.saved<this.revision||!!this.running||this.state==='saving'); }
  get failureMessage() { return this.error?message(this.error):''; }
  schedule({id=null,settingsOnly=false}={}) {
    this.revision++;
    if(id)this.dirty.add(id);else if(!settingsOnly)this.allDirty=true;
    if(!this.handle||this.restoring||this.state==='error')return;
    this.publish('pending');clearTimeout(this.timer);this.timer=setTimeout(()=>this.flush().catch(()=>{}),this.delay);
  }
  async connect(handle,{resume=false}={}) {
    clearTimeout(this.timer);if(this.running)await this.running.catch(()=>{});
    if(!await permission(handle)){this.handle=resume?handle:this.handle;const error=new DOMException('폴더 쓰기 권한이 필요합니다.','NotAllowedError');if(resume)this.publish('error',error);throw error;}
    const oldHandle=this.handle,oldHead=this.head;this.historyVersions.clear();this.restoring=true;this.publish('saving');
    try{
      await this.lock(async()=>{
        const checkpoint=await this.ops.getSetting(CHECKPOINT);
        let current;try{current=await manifestAt(handle);}catch{/* A verified previous snapshot may recover an interrupted/corrupt manifest. */}
        const reuse=current&&sameHead(checkpoint,current.manifest);
        const snapshot=reuse?null:await recoverSnapshot(handle);
        if(!current&&!snapshot&&resume&&checkpoint)throw Error('이전에 저장한 폴더 목록이 없습니다. 다른 폴더인지 확인해주세요. 빈 목록으로 덮어쓰지 않습니다.');
        const target=snapshot?.head||current;
        // Persist the new handle before touching the library; a denied IDB write keeps the old connection.
        await this.ops.setSetting('folder',handle);
        this.handle=handle;this.head=target;
        if(snapshot){
          const localLibrary=await this.ops.readLibrary(),localFolders=validateFolders(localLibrary.folders),merged=mergeLibraryFolders(localFolders,snapshot.folders,uid);
          const existing=new Map(localLibrary.documents.map(r=>[r.id,r])),entries=[];
          for(const item of snapshot.documents){
            let record=structuredClone(item.record),found=existing.get(record.id);
            if(record.folderId)record.folderId=merged.mapping.get(record.folderId);
            if(found&&JSON.stringify(portableRecord(found))===JSON.stringify(record)){
              const local=await this.ops.getDocument(record.id),body=local.file instanceof Blob?local.file:new Blob([local.html]);
              const history=(await this.ops.listRevisions(record.id)).map(({id,documentId,...revision})=>revision);
              if((await localFileIdentity(body)).digest===(await localFileIdentity(item.source)).digest&&JSON.stringify(history)===JSON.stringify(item.revisions))continue;
            }
            if(found){record.id=uid();record.title=(record.title+' (폴더에서 복원)').slice(0,1000);}
            const content=item.sourceType==='file'?{file:item.source}:{html:await item.source.text()};if(item.original)content.originalFile=item.original;
            entries.push({record,content,revisions:item.revisions});existing.set(record.id,record);
          }
          await this.ops.restoreFolderDocuments(entries,merged.folders,localFolders);
          applyFolderSettings(this.storage,snapshot.settings);
          await this.onRestored({count:entries.length,folders:merged.folders.length,recovered:!!snapshot.recovered});
        }
        if(snapshot?.recovered){const raw=await optionalText(handle,FOLDER_MANIFEST);if(raw!==null)await atomicWrite(handle,'HTMLMemo-library.recovered-'+uid()+'.json',raw);}
        this.saved=0;this.revision++;this.allDirty=true;
        let recovering=!!snapshot?.recovered;
        while(this.saved<this.revision){const next=this.revision;await this.writeSnapshot({recovered:recovering});recovering=false;this.saved=next;}
      });
      this.dirty.clear();this.allDirty=false;this.publish('saved');
    }catch(error){
      if(this.handle!==handle){this.handle=oldHandle;this.head=oldHead;}
      this.publish('error',error);throw error;
    }finally{this.restoring=false;}
  }
  async flush() {
    clearTimeout(this.timer);if(!this.handle||this.restoring)return;
    if(this.running){await this.running;if(this.saved<this.revision)return this.flush();return;}
    this.running=(async()=>{
      try{
        while(this.saved<this.revision){const next=this.revision;this.publish('saving');await this.lock(()=>this.writeSnapshot());this.saved=next;}
        this.dirty.clear();this.allDirty=false;this.publish('saved');
      }catch(error){this.publish('error',error);throw error;}
    })();
    try{await this.running;}finally{this.running=null;this.report(this);}
  }
  async writeSnapshot({recovered=false}={}) {
    if(!await permission(this.handle))throw new DOMException('폴더 쓰기 권한이 필요합니다.','NotAllowedError');
    let before=null;if(!recovered)before=await manifestAt(this.handle);
    const checkpoint=await this.ops.getSetting(CHECKPOINT);
    if(!recovered&&before&&!sameHead(before.manifest,this.head?.manifest)&&!sameHead(before.manifest,checkpoint))throw Error('다른 창이나 기기에서 폴더가 변경됐습니다. 다시 연결하면 양쪽 문서를 보존해 합칩니다.');
    if(!before&&this.head&&!recovered)throw Error('폴더 목록이 사라졌습니다. 기존 데이터를 덮어쓰지 않습니다. 다시 연결해주세요.');
    const base=recovered?this.head:before,data=await this.handle.getDirectoryHandle(FOLDER_DATA,{create:true});
    const library=await this.ops.readLibrary(),folders=validateFolders(library.folders),folderIds=new Set(['',...folders.map(f=>f.id)]);
    const place=(entry,record)=>{const folderId=record.folderId||'';if(!folderIds.has(folderId))throw Error('문서의 서재 폴더를 찾지 못했습니다. 폴더를 다시 연결해주세요.');return {...entry,copy:{folderId,name:documentCopyName(record,entry.original||entry.source)}};};
    const checkAll=this.allDirty||!sameHead(base?.manifest,this.head?.manifest);
    const previous=new Map((base?.manifest.documents||[]).map(e=>[e.id,e])),documents=[],checked=new Set(),historyVersions=new Map(this.historyVersions);
    for(const summary of library.documents){
      const record=portableRecord(summary);let old=previous.get(record.id);
      if(old){try{for(const ref of [old.source,old.original,old.state,old.history].filter(Boolean)){if(!checked.has(ref.name))await objectFile(data,ref);checked.add(ref.name);}}catch(error){if(!['NotFoundError','DataIntegrityError'].includes(error.name))throw error;old=null;}}
      if(old&&!checkAll&&!this.dirty.has(record.id)){documents.push(place(old,record));continue;}
      const historyVersion=summary.historyVersion||0,stamp=(await localFileIdentity(jsonBlob({record,historyVersion}))).digest;
      if(old?.stamp===stamp){documents.push(place(old,record));continue;}
      let source=old?.source,original=old?.original,sourceType=old?.sourceType;
      if(!source){
        const content=await this.ops.getDocument(record.id);if(!content)continue;
        sourceType=content.file instanceof Blob?'file':'html';
        const body=sourceType==='file'?content.file:new Blob([content.html],{type:'text/html;charset=utf-8'});
        source=await storeObject(data,body,record.metadata?.format==='pdf'?'pdf':'html');
        const extension=(record.name.match(/\.(html?|mhtml|mht|pdf|epub|epub3|mobi|azw|azw3|fb2|fbz|fb2\.zip|cbz|hwp|hwpx|hml|docx|odt|ott|xlsx|xlsm|xls|csv|tsv|ods|ots|pptx|odp|otp|md|markdown|txt|json)$/i)?.[1]||'html').toLowerCase();
        original=content.originalFile instanceof Blob?await storeObject(data,content.originalFile,extension):source;
      }
      const annotationStamp=(await localFileIdentity(jsonBlob({annotations:record.metadata.annotations,bookmarks:record.metadata.bookmarks,historyVersion}))).digest;
      let history=old?.history;
      // Current notes change much more often than checkpoints. A version is
      // trusted only for the exact history object published by this writer.
      const versioned=Number.isSafeInteger(summary.historyVersion)&&summary.historyVersion>=0,cached=historyVersions.get(record.id);
      const historyUnchanged=versioned&&cached?.version===historyVersion&&cached.name===history?.name;
      if(!history||!historyUnchanged&&old.annotationStamp!==annotationStamp){
        const revisions=(await this.ops.listRevisions(record.id)).map(({id,documentId,...revision})=>revision);
        validateState({record,revisions},record.id);
        const historyBlob=jsonBlob({revisions});if(historyBlob.size>128*1024*1024)throw Error('한 문서의 주석 이력이 폴더 저장 한도(128MB)를 넘었습니다. 기존 폴더 저장본은 유지됩니다.');
        history=await storeObject(data,historyBlob,'json');
      }else validateState({record,revisions:[]},record.id);
      if(versioned)historyVersions.set(record.id,{version:historyVersion,name:history.name});else historyVersions.delete(record.id);
      const stateBlob=jsonBlob({record});if(stateBlob.size>128*1024*1024)throw Error('한 문서의 현재 주석이 폴더 저장 한도(128MB)를 넘었습니다.');
      const state=await storeObject(data,stateBlob,'json');
      documents.push(place({id:record.id,source,original,sourceType,state,history,stamp,annotationStamp},record));
    }
    const settingsBlob=jsonBlob(folderSettings(this.storage));if(settingsBlob.size>16*1024*1024)throw Error('설정의 크기가 폴더 저장 한도(16MB)를 넘었습니다.');
    const settings=await storeObject(data,settingsBlob,'json');
    const manifest={format:FORMAT,version:2,id:base?.manifest.id||uid(),revision:uid(),savedAt:new Date().toISOString(),settings,folders,documents};
    // Check every referenced file exists, without rereading large immutable sources on edits.
    for(const ref of new Map(references(manifest).map(ref=>[ref.name,ref])).values())if(!checked.has(ref.name))await objectFile(data,ref);
    const treeShape=head=>JSON.stringify({folders:head?.folders||[],documents:(head?.documents||[]).map(e=>({id:e.id,copy:e.copy,original:e.original||e.source}))});
    if(checkAll||treeShape(manifest)!==treeShape(base?.manifest))await syncFolderTree(this.handle,manifest,base?.manifest,{readOriginal:ref=>objectFile(data,ref),write:atomicWrite});
    if(!recovered&&base&&JSON.stringify({settings:base.manifest.settings,folders:base.manifest.folders,documents:base.manifest.documents})===JSON.stringify({settings,folders,documents})){
      this.head=base;await this.ops.setSetting(CHECKPOINT,{id:base.manifest.id,revision:base.manifest.revision});return;
    }
    const latest=await optionalText(this.handle,FOLDER_MANIFEST);
    if(!recovered&&latest!==(before?.raw??null))throw Error('저장 중 다른 프로그램에서 폴더를 변경했습니다. 다시 연결해주세요.');
    await atomicWrite(this.handle,FOLDER_GUIDE,`LibreMemo 데이터 폴더: ${this.handle.name}\n\n문서 원본 복사본·본문·주석·북마크·주석 이력·읽기 위치·설정을 자동 보관합니다. 평소에는 원본 HTML에 주석을 합치지 않습니다. 휴지통으로 옮긴 문서도 모두 보관하며 내 서재 → 휴지통에서 복원할 수 있습니다. 휴지통의 영구 삭제·비우기는 앱에서 복원할 수 없습니다.\n\n새 기기로 옮길 때\n1. LibreMemo의 폴더 상태가 “폴더 자동 저장 완료”인지 확인하고 앱을 닫습니다.\n2. 이 폴더 전체를 하위 폴더·파일 빠짐없이 새 기기의 Documents(문서) 폴더로 복사합니다. 일부 HTML 파일만 옮기면 주석·설정이 빠집니다.\n3. ${publicAppURL()} 에서 설정 → 데이터 폴더 연결을 누르고 옮긴 폴더를 선택해 읽기·쓰기를 허용합니다. 문서·주석·설정은 자동 복원됩니다. 별도의 설정 파일 저장·불러오기는 필요 없습니다.\n\n다른 사람에게 문서 하나와 주석을 보낼 때\nLibreMemo에서 문서를 열어 상단의 “HTML 내보내기”로 .html 파일을 새로 저장한 뒤 그 파일을 보내세요. 이 작업을 해야 현재 주석이 HTML 안에 포함됩니다. 받는 분도 LibreMemo의 “HTML 파일 가져오기”로 엽니다. 원본 복사본만 보내면 앱에서 추가한 주석은 전달되지 않습니다.\n\n주의\n관리 파일 이름과 내용을 개별적으로 바꾸거나 일부만 삭제하지 마세요. 브라우저 데이터 삭제는 이 폴더의 파일을 지우지 않지만 다시 폴더를 선택해야 합니다. 권한 회수·이동·디스크 부족·앱 강제 종료 중 미완료 저장은 자동 보호할 수 없습니다. 폴더 자체 삭제나 기기 고장에도 대비하려면 폴더 전체를 다른 저장장치에 복사하세요. 다른 기기에서 동시에 편집하는 실시간 동기화 기능은 아닙니다.\n`);
    if(base)await atomicWrite(this.handle,FOLDER_PREVIOUS,base.raw);
    const raw=JSON.stringify(manifest,null,2)+'\n';await atomicWrite(this.handle,FOLDER_MANIFEST,raw);
    this.head={raw,manifest};await this.ops.setSetting(CHECKPOINT,{id:manifest.id,revision:manifest.revision});
    this.historyVersions=new Map(documents.flatMap(entry=>{const cached=historyVersions.get(entry.id);return cached?.name===entry.history.name?[[entry.id,cached]]:[];}));
    // Old snapshots use protected objects, so moving visible raw copies cannot break recovery.
    try{await cleanupFolderTree(this.handle,manifest,base?.manifest);}catch{/* Keep leftovers rather than deleting an unverified file or risking the committed backup. */}
    // Only collect our own content-addressed objects, after both manifests are durable.
    const keep=new Set([...references(manifest),...references(base?.manifest)].map(ref=>ref.name));
    try{
      // Recovered manifests may still contain useful evidence; keep their orphaned objects too.
      for await(const [name] of this.handle.entries())if(/^HTMLMemo-library\.recovered-/.test(name))return;
      for await(const [name,entry] of data.entries())if(entry.kind==='file'&&refName.test(name)&&!keep.has(name))await data.removeEntry(name);
    }catch{/* A failed cleanup never invalidates a completed snapshot. */}
  }
  dispose() { clearTimeout(this.timer);this.unsubscribe(); }
}
