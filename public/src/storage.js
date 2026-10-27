const DB_NAME = 'HTMLMemo-v1';
let database;
const storageListeners = new Set();
let storageChannel;
export function onStorageChange(listener) {
  storageListeners.add(listener);
  if(!storageChannel&&typeof BroadcastChannel!=='undefined'){storageChannel=new BroadcastChannel('htmlmemo-storage');storageChannel.onmessage=event=>changed(event.data,false);}
  return () => {storageListeners.delete(listener);if(!storageListeners.size){storageChannel?.close();storageChannel=null;}};
}
function changed(id,broadcast=true) { if(broadcast)storageChannel?.postMessage(id);for (const listener of storageListeners) { try { listener(id); } catch { /* A mirror must not undo a committed internal save. */ } } }
async function db() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 4);
    let blocked=false;
    request.onblocked=()=>{blocked=true;database=null;reject(new Error('다른 HTMLMemo 창이 이전 보관함을 사용하고 있습니다. 해당 창을 닫고 다시 열어주세요. 보관한 문서는 유지됩니다.'));};
    request.onupgradeneeded = event => {
      const database = request.result;
      if (!database.objectStoreNames.contains('documents')) database.createObjectStore('documents', {keyPath:'id'});
      if (!database.objectStoreNames.contains('settings')) database.createObjectStore('settings');
      if (!database.objectStoreNames.contains('contents')) database.createObjectStore('contents', {keyPath:'documentId'});
      if (!database.objectStoreNames.contains('revisions')) database.createObjectStore('revisions', {keyPath:'id',autoIncrement:true}).createIndex('documentId','documentId');
      if (!database.objectStoreNames.contains('revisionHeaders')) {
        const headers=database.createObjectStore('revisionHeaders',{keyPath:'id'});
        headers.createIndex('documentRevision',['documentId','id']);
        headers.createIndex('documentCreated',['documentId','time','id']);
      }
      // Build the small date index once, preserving every legacy snapshot and ID.
      // An interrupted upgrade rolls back both the schema and the derived index.
      if(event && event.oldVersion<4){
        const tx=request.transaction,headers=tx.objectStore('revisionHeaders');
        const cursorRequest=tx.objectStore('revisions').openCursor();
        cursorRequest.onsuccess=()=>{const cursor=cursorRequest.result;if(cursor){headers.add(revisionHeader(cursor.value));cursor.continue();}};
      }
      // Migrate legacy inline bodies one document at a time, without getAll().
      if(event && event.oldVersion<3){
        const tx=request.transaction,contents=tx.objectStore('contents');
        const cursorRequest=tx.objectStore('documents').openCursor();
        cursorRequest.onsuccess=()=>{const cursor=cursorRequest.result;if(!cursor)return;
          const {html,...record}=cursor.value;
          if(typeof html==='string'){
            contents.put({documentId:record.id,html});record.byteSize=new Blob([html]).size;cursor.update(record);
          }
          cursor.continue();
        };
      }
    };
    request.onsuccess = () => { const connection=request.result;if(blocked){connection.close();return;} connection.onversionchange=()=>{connection.close();database=null;};resolve(connection); }; request.onerror = () => {database=null;reject(request.error);};
  });
  return database;
}
async function transaction(store, mode, action) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(store, mode); const request = action(tx.objectStore(store));
    tx.oncomplete = () => resolve(request?.result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('저장이 중단되었습니다.'));
  });
}
async function withContent(record) {
  if(!record || typeof record.html === 'string')return record;
  const content=await transaction('contents','readonly',store=>store.get(record.id));
  if(!content)throw new Error('보관한 HTML 본문을 찾지 못했습니다.');
  return {...record,html:content.html,file:content.file,originalFile:content.originalFile};
}
// Library cards never load book bodies; getDocument is the explicit lazy read.
export const listDocuments = async ({includeTrashed=false}={}) => {
  const records=await transaction('documents','readonly',store=>store.getAll());
  return includeTrashed?records:records.filter(record=>!record.trashedAt);
};
export const getDocument = async id => withContent(await transaction('documents', 'readonly', store => store.get(id)));
export const putDocument = record => putDocumentRevision(record);
export const getSetting = key => transaction('settings', 'readonly', store => store.get(key));
export const setSetting = (key, value) => transaction('settings', 'readwrite', store => store.put(value, key));
/** One coherent header/tree snapshot even when another window moves a folder. */
export async function readLibrary() {
  const connection=await db();return new Promise((resolve,reject)=>{
    const tx=connection.transaction(['settings','documents'],'readonly'),folders=tx.objectStore('settings').get('library-folders-v1'),documents=tx.objectStore('documents').getAll();
    tx.oncomplete=()=>resolve({folders:folders.result||[],documents:documents.result});tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('서재 폴더와 문서 목록을 읽지 못했습니다.'));
  });
}
/** Serialize folder edits with all document headers, across tabs. Never read HTML or history. */
export async function updateLibraryFolders(edit) {
  const connection=await db();
  return new Promise((resolve,reject)=>{
    const tx=connection.transaction(['settings','documents'],'readwrite'),settings=tx.objectStore('settings'),documents=tx.objectStore('documents');
    const tree=settings.get('library-folders-v1'),rows=documents.getAll();let result,failure,ready=0;
    const apply=()=>{if(++ready!==2)return;try{result=edit(tree.result||[],rows.result);settings.put(result.folders,'library-folders-v1');for(const record of result.documents)documents.put(record);}catch(error){failure=error;tx.abort();}};
    tree.onsuccess=apply;rows.onsuccess=apply;
    tx.oncomplete=()=>{changed(null);resolve(result);};tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(failure||tx.error||new Error('서재 폴더 변경을 저장하지 못했습니다. 기존 폴더와 문서는 유지됩니다.'));
  });
}
/** Cache a proven legacy source identity without reading/writing its body or history. */
export async function putDocumentSourceIdentity(id, sourceIdentity) {
  const identity=structuredClone(sourceIdentity),connection=await db();
  return new Promise((resolve,reject)=>{
    const tx=connection.transaction('documents','readwrite'),store=tx.objectStore('documents');
    const request=store.get(id);let saved,failure;
    request.onsuccess=()=>{
      try{saved=request.result;if(saved){saved.sourceIdentity=identity;store.put(saved);}}
      catch(error){failure=error;tx.abort();}
    };
    tx.oncomplete=()=>{if(saved)changed(id);resolve(saved);};
    tx.onerror=()=>reject(tx.error);
    tx.onabort=()=>reject(failure||tx.error||new Error('파일 확인 결과를 보관하지 못했습니다.'));
  });
}
/** View-only saves leave annotations, history, source HTML and the modification date alone. */
export async function putDocumentView(id, view, expectedSyncEpoch) {
  const position = structuredClone(view), connection = await db();
  return new Promise((resolve, reject) => {
    const tx = connection.transaction('documents', 'readwrite'), store = tx.objectStore('documents');
    const request = store.get(id); let saved, failure;
    request.onsuccess = () => {
      try {
        saved = request.result;
        if (!saved) throw new Error('읽기 위치를 저장할 문서를 찾지 못했습니다.');
        if(saved.syncEpoch&&saved.syncEpoch!==expectedSyncEpoch)throw Error('다른 기기에서 받은 최신 문서입니다. 이 탭을 다시 열어주세요.');
        saved.metadata = {...saved.metadata, view:position};
        store.put(saved);
      } catch (error) { failure = error; tx.abort(); }
    };
    tx.oncomplete = () => { changed(id); resolve(saved); };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(failure || tx.error || new Error('읽기 위치를 저장하지 못했습니다.'));
  });
}
/** Trash/restore change headers only; immutable bodies and every history entry stay intact. */
async function changeTrashState(id, restore) {
  const connection=await db();
  return new Promise((resolve,reject)=>{
    const tx=connection.transaction(['documents','settings'],'readwrite'),store=tx.objectStore('documents');
    const request=store.get(id),folders=tx.objectStore('settings').get('library-folders-v1');let saved,failure,ready=0;
    const apply=()=>{if(++ready!==2)return;try{
      saved=request.result;if(!saved)throw Error('문서가 삭제되었거나 다른 창에서 변경되었습니다. 서재를 다시 확인해주세요.');
      if(restore){
        delete saved.trashedAt;
        if(saved.folderId&&!(folders.result||[]).some(folder=>folder.id===saved.folderId))saved.folderId='';
      }else if(!saved.trashedAt)saved.trashedAt=Date.now();
      store.put(saved);
    }catch(error){failure=error;tx.abort();}};
    request.onsuccess=apply;folders.onsuccess=apply;
    tx.oncomplete=()=>{changed(id);resolve(saved);};tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(failure||tx.error||new Error('휴지통 변경을 저장하지 못했습니다. 문서와 주석은 유지됩니다.'));
  });
}
export const trashDocument = id => changeTrashState(id,false);
export const restoreDocument = id => changeTrashState(id,true);
/** A confirmed purge is atomic and cannot delete a document another window has restored. */
export async function deleteTrashedDocuments(ids) {
  const selected=[...new Set(ids)];if(!selected.length)return;
  const connection=await db();
  await new Promise((resolve,reject)=>{
    const tx=connection.transaction(['documents','contents','revisions','revisionHeaders'],'readwrite'),store=tx.objectStore('documents');let failure;
    for(const id of selected){const request=store.get(id);request.onsuccess=()=>{try{
      if(!request.result)return;
      if(!request.result.trashedAt)throw Error('복원된 문서는 영구 삭제하지 않습니다. 휴지통을 다시 확인해주세요.');
      store.delete(id);tx.objectStore('contents').delete(id);
      const revisions=tx.objectStore('revisions').index('documentId').openCursor(IDBKeyRange.only(id));
      revisions.onsuccess=()=>{const cursor=revisions.result;if(cursor){tx.objectStore('revisionHeaders').delete(cursor.primaryKey);cursor.delete();cursor.continue();}};
    }catch(error){failure=error;tx.abort();}};}
    tx.oncomplete=resolve;tx.onabort=()=>reject(failure||tx.error||new Error('휴지통을 비우지 못했습니다. 기존 문서와 주석은 유지됩니다.'));tx.onerror=()=>reject(tx.error);
  });
  for(const id of selected){
    try{const root=await navigator.storage.getDirectory();await root.removeEntry(id+'.html');}catch{/* Legacy OPFS copies are best-effort cleanup only. */}
    changed(id);
  }
}
export const deleteDocument = id => deleteTrashedDocuments([id]);
export async function permission(handle, request = false) {
  if (!handle) return false;
  if (!handle.queryPermission) return true;
  const options = {mode: 'readwrite'};
  if (await handle.queryPermission(options) === 'granted') return true;
  return request && await handle.requestPermission(options) === 'granted';
}
export async function writeExternalHTML(record, html, force = false) {
  if (!record.fileHandle) return;
  if (!await permission(record.fileHandle)) throw new DOMException('원본 HTML 파일의 쓰기 권한이 필요합니다.', 'NotAllowedError');
  const before = await record.fileHandle.getFile();
  if (!force && record.diskStamp && (before.lastModified !== record.diskStamp.modified || before.size !== record.diskStamp.size)) throw new Error('다른 프로그램에서 파일을 수정했습니다. 파일을 다시 열거나 다른 이름으로 저장해주세요.');
  const writer = await record.fileHandle.createWritable();
  try { await writer.write(html); await writer.close(); } catch (error) { await writer.abort().catch(() => {}); throw error; }
  const after = await record.fileHandle.getFile(); record.diskStamp = {modified: after.lastModified, size: after.size};
}

/** Only annotation content belongs in history; scrolling never creates a revision. */
export const annotationState = metadata => ({annotations:structuredClone(metadata?.annotations || []),bookmarks:structuredClone(metadata?.bookmarks || [])});
export const sameAnnotationState = (a,b) => JSON.stringify({annotations:a?.annotations||[],bookmarks:a?.bookmarks||[]}) === JSON.stringify({annotations:b?.annotations||[],bookmarks:b?.bookmarks||[]});
export const listRevisions = id => transaction('revisions','readonly',store=>store.index('documentId').getAll(id));

export const getRevision = id => transaction('revisions','readonly',store=>store.get(id));

function revisionHeader(version) {
  const time=Number.isFinite(version.created)&&Number.isFinite(new Date(version.created).getTime())?version.created:-Infinity;
  return {id:version.id,documentId:version.documentId,time,created:time===-Infinity?null:time,kind:version.kind,annotationCount:version.annotations?.length||0,bookmarkCount:version.bookmarks?.length||0};
}
function addRevision(tx, version) {
  const request=tx.objectStore('revisions').add(version);
  request.onsuccess=()=>tx.objectStore('revisionHeaders').add(revisionHeader({...version,id:request.result}));
}
/** Local calendar boundaries, including 23/25-hour DST days. Unknown dates remain browsable. */
export function revisionDate(time) {
  const date=new Date(time);
  return time===null||!Number.isFinite(time)||!Number.isFinite(date.getTime())?{year:'unknown',month:null,day:null}:{year:date.getFullYear(),month:date.getMonth()+1,day:date.getDate()};
}
export function revisionDateRange(year, month, day) {
  if(year==='unknown')return [-Infinity,-Infinity];
  const start=new Date(0);start.setFullYear(Number(year),month==null?0:Number(month)-1,day==null?1:Number(day));start.setHours(0,0,0,0);
  const end=new Date(start);
  if(day!=null)end.setDate(end.getDate()+1);else if(month!=null)end.setMonth(end.getMonth()+1);else end.setFullYear(end.getFullYear()+1);
  return [start.getTime(),end.getTime()];
}
const revisionRange=(id,start=-Infinity,end=Infinity)=>IDBKeyRange.bound([id,start],[id,end,...(start===end?[Infinity]:[])],false,start!==end);
async function readRevisionHeaders(id, range, indexName, limit) {
  const connection=await db();
  return new Promise((resolve,reject)=>{
    const tx=connection.transaction('revisionHeaders','readonly'),rows=[];
    const request=tx.objectStore('revisionHeaders').index(indexName).openCursor(range,'prev');
    request.onsuccess=()=>{const cursor=request.result;if(cursor){rows.push(cursor.value);if(rows.length<limit)cursor.continue();}};
    tx.oncomplete=()=>resolve(rows);tx.onabort=()=>reject(tx.error);tx.onerror=()=>reject(tx.error);
  });
}
export async function listRevisionSummaries(id, before = Infinity, limit = 50) {
  return readRevisionHeaders(id,IDBKeyRange.bound([id,0],[id,before],false,true),'documentRevision',Math.max(1,Math.min(limit,100)));
}
/** One key per populated year/month/day plus index counts; never load annotation payloads. */
export async function listRevisionPeriods(id, year = null, month = null) {
  const connection=await db();
  return new Promise((resolve,reject)=>{
    const tx=connection.transaction('revisionHeaders','readonly'),index=tx.objectStore('revisionHeaders').index('documentCreated'),rows=[];
    const bounds=year===null?[-Infinity,Infinity]:revisionDateRange(year,month);
    const request=index.openKeyCursor(revisionRange(id,...bounds),'prev');
    request.onsuccess=()=>{
      const cursor=request.result;if(!cursor)return;
      const date=revisionDate(cursor.key[1]),value=year===null?date.year:month===null?date.month:date.day;
      const [start,end]=revisionDateRange(date.year,year===null?null:date.month,month===null?null:date.day);
      const row={value,count:0};rows.push(row);
      const count=index.count(revisionRange(id,start,end));count.onsuccess=()=>{row.count=count.result;};
      // A short compound key sorts before all records at that boundary, so even
      // midnight timestamps and thousands of identical timestamps are skipped once.
      cursor.continue([id,start]);
    };
    tx.oncomplete=()=>resolve(rows);tx.onabort=()=>reject(tx.error);tx.onerror=()=>reject(tx.error);
  });
}
export async function listRevisionDay(id, date, before = null, limit = 50) {
  const [start,end]=revisionDateRange(date.year,date.month,date.day),size=Math.max(1,Math.min(limit,100));
  const range=before?IDBKeyRange.bound([id,start],[id,before.time,before.id],false,true):revisionRange(id,start,end);
  const rows=await readRevisionHeaders(id,range,'documentCreated',size+1),more=rows.length>size;
  if(more)rows.pop();
  return {rows,next:more?{time:rows.at(-1).time,id:rows.at(-1).id}:null};
}
export async function adjacentRevisionDay(id, date, direction) {
  const [start,end]=revisionDateRange(date.year,date.month,date.day),connection=await db();
  if(direction!=='next'&&start===-Infinity)return null;
  return new Promise((resolve,reject)=>{
    const tx=connection.transaction('revisionHeaders','readonly');let result=null;
    const range=direction==='next'?IDBKeyRange.bound(start===end?[id,end,Infinity]:[id,end],[id,Infinity],true,true):revisionRange(id,-Infinity,start);
    const request=tx.objectStore('revisionHeaders').index('documentCreated').openKeyCursor(range,direction==='next'?'next':'prev');
    request.onsuccess=()=>{if(request.result)result=revisionDate(request.result.key[1]);};
    tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(tx.error);tx.onerror=()=>reject(tx.error);
  });
}

/** The current document and its annotation revision commit atomically. No source-file permission is needed. */
export async function putDocumentRevision(record, {baseline = false, restoredFrom = null, checkpoint = true, mustExist = false} = {}) {
  const connection=await db();
  const state={annotations:record.metadata?.annotations || [],bookmarks:record.metadata?.bookmarks || []};
  const {html,file,originalFile,...value}=record;value.diskPending=false;value.diskError=null;
  if(!value.byteSize)value.byteSize=file?.size || (typeof html==='string'?new Blob([html]).size:0);
  return new Promise((resolve,reject)=>{
    const tx=connection.transaction(['documents','contents','revisions','revisionHeaders','settings'],'readwrite');
    let failure;
    const documents=tx.objectStore('documents'),revisions=tx.objectStore('revisions'),contents=tx.objectStore('contents');
    const previous=documents.get(record.id),content=contents.getKey(record.id),folders=tx.objectStore('settings').get('library-folders-v1');
    const index=revisions.index('documentId'),latest=checkpoint?index.openCursor(IDBKeyRange.only(record.id),'prev'):index.openKeyCursor(IDBKeyRange.only(record.id),'prev');
    // Queue reads before any awaits so the transaction stays active.
    latest.onsuccess=()=>{
      try {
        const last=latest.result;
        const old=previous.result;
        if(mustExist&&!old)throw Error('문서가 영구 삭제되었습니다. 이전 탭의 내용으로 다시 만들지 않습니다.');
        if(old?.syncEpoch&&old.syncEpoch!==value.syncEpoch)throw Error('동기화로 최신 문서가 저장되었습니다. 이전 탭을 다시 열어주세요. 작성 중인 내용은 유지됩니다.');
        // A still-open legacy tab must not erase a later duplicate-check cache.
        if(!value.sourceIdentity&&old?.sourceIdentity)value.sourceIdentity=old.sourceIdentity;
        // Moving a document is independent of an open reader's annotation saves.
        if(old)value.folderId=old.folderId||'';
        else if(value.folderId&&(!Array.isArray(folders.result)||!folders.result.some(f=>f.id===value.folderId)))value.folderId='';
        if(old?.trashedAt)value.trashedAt=old.trashedAt;else delete value.trashedAt;
        value.historyVersion=Number.isSafeInteger(old?.historyVersion)?old.historyVersion:0;
        let previousState=last?.value;
        const add=(metadata,kind)=>{addRevision(tx,{documentId:record.id,created:Date.now(),kind,restoredFrom:kind==='restore'?restoredFrom:null,...annotationState(metadata)});previousState=metadata;value.historyVersion++;};
        if(!last&&old)add(old.metadata,'baseline');
        if(!last&&!old)add(state,baseline||!checkpoint?'baseline':'edit');
        // Restoration keeps the unsnapshotted current state and the target in
        // the same transaction. A failure cannot strand only half of a restore.
        if(restoredFrom&&old&&!sameAnnotationState(previousState,old.metadata))add(old.metadata,'edit');
        if(checkpoint&&!sameAnnotationState(previousState,state))add(state,restoredFrom?'restore':'edit');
        if(!content.result){const original=originalFile instanceof Blob?{originalFile}:{};if(file instanceof Blob)contents.add({documentId:record.id,file,...original});else{const source=old?.html ?? html;if(typeof source!=='string')throw Error('HTML 본문을 보관하지 못했습니다. 문서를 다시 열어주세요.');contents.add({documentId:record.id,html:source,...original});}}
        documents.put(value);
      } catch(error){failure=error;tx.abort();}
    };
    tx.oncomplete=()=>{changed(record.id);resolve(value);};tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(failure || tx.error || new Error('주석과 이력을 저장하지 못했습니다.'));
  });
}

/** Snapshot the latest durable annotations, never an old in-memory tab or HTML body. */
export async function checkpointAnnotations(id) {
  const connection=await db();
  return new Promise((resolve,reject)=>{
    const tx=connection.transaction(['documents','revisions','revisionHeaders'],'readwrite'),documents=tx.objectStore('documents'),revisions=tx.objectStore('revisions');
    const current=documents.get(id),latest=revisions.index('documentId').openCursor(IDBKeyRange.only(id),'prev');let added=false,failure;
    latest.onsuccess=()=>{try{
      const record=current.result;if(!record)return;
      if(!latest.result||!sameAnnotationState(latest.result.value,record.metadata)){
        addRevision(tx,{documentId:id,created:Date.now(),kind:latest.result?'edit':'baseline',...annotationState(record.metadata)});
        record.historyVersion=(Number.isSafeInteger(record.historyVersion)?record.historyVersion:0)+1;documents.put(record);added=true;
      }
    }catch(error){failure=error;tx.abort();}};
    tx.oncomplete=()=>{if(added)changed(id);resolve(added);};tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(failure||tx.error||new Error('주석 이력을 저장하지 못했습니다. 현재 주석은 자동 저장된 상태로 유지됩니다.'));
  });
}

/** Import an already validated folder snapshot without replacing any existing document. */
export async function restoreFolderDocuments(entries, folders = null, expectedFolders = null) {
  if(!entries.length&&folders===null)return;
  const connection=await db();
  await new Promise((resolve,reject)=>{
    const tx=connection.transaction(['documents','contents','revisions','revisionHeaders',...(folders===null?[]:['settings'])],'readwrite');let failure;
    const apply=()=>{try {
      for(const {record,content,revisions} of entries){
        tx.objectStore('documents').add({...record,historyVersion:revisions.length});
        tx.objectStore('contents').add({documentId:record.id,...content});
        for(const revision of revisions){const {id:oldId,...value}=revision;addRevision(tx,{...value,documentId:record.id});}
      }
      if(folders!==null)tx.objectStore('settings').put(folders,'library-folders-v1');
    }catch(error){failure=error;tx.abort();}};
    if(folders===null)apply();else{
      const current=tx.objectStore('settings').get('library-folders-v1');
      current.onsuccess=()=>{if(expectedFolders!==null&&JSON.stringify(current.result||[])!==JSON.stringify(expectedFolders)){failure=new Error('복원 중 다른 창에서 폴더가 바뀌었습니다. 다시 연결해주세요.');tx.abort();}else apply();};
    }
    tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(failure||tx.error||new Error('폴더의 데이터를 복원하지 못했습니다. 기존 보관함은 유지됩니다.'));
  });
  for(const entry of entries)changed(entry.record.id);
  if(folders!==null)changed(null);
}

/** Optimistic, atomic device import. Incoming entries are validated before opening the transaction.
 * No file handle, root folder name or filesystem permission can enter this path.
 */
export const syncRecordSnapshot = record => record ? JSON.stringify({id:record.id,title:record.title,name:record.name,modified:record.modified,metadata:record.metadata,folderId:record.folderId||'',trashedAt:record.trashedAt,historyVersion:record.historyVersion,sourceIdentity:record.sourceIdentity,syncEpoch:record.syncEpoch}) : null;
export async function commitDeviceSync(entries, folders, expectedFolders) {
  const connection=await db();
  await new Promise((resolve,reject)=>{
    const tx=connection.transaction(['documents','contents','revisions','revisionHeaders','settings'],'readwrite');let failure,pending=entries.length+1;
    const fail=error=>{failure=error;tx.abort();};
    const apply=()=>{if(--pending)return;try{
      for(const entry of entries){
        const {content,revisions,expected}=entry;const record={...entry.record,syncEpoch:crypto.randomUUID()};
        const documents=tx.objectStore('documents');
        if(expected===null)documents.add({...record,historyVersion:revisions.length});
        else documents.put({...record,historyVersion:(entry.previousHistoryVersion||0)+revisions.length});
        tx.objectStore('contents').put({documentId:record.id,...content});
        for(const revision of revisions){const {id:oldId,documentId:oldDocumentId,...value}=revision;addRevision(tx,{...value,documentId:record.id});}
      }
      tx.objectStore('settings').put(folders,'library-folders-v1');
    }catch(error){fail(error);}};
    for(const entry of entries){const request=tx.objectStore('documents').get(entry.record.id);request.onsuccess=()=>{
      if(syncRecordSnapshot(request.result)!==entry.expected)return fail(Error('동기화 중 다른 창에서 문서가 바뀌었습니다. 기존 내용은 유지했습니다. 다시 시도해주세요.'));
      apply();
    };}
    const current=tx.objectStore('settings').get('library-folders-v1');current.onsuccess=()=>{
      if(JSON.stringify(current.result||[])!==JSON.stringify(expectedFolders))return fail(Error('동기화 중 폴더가 바뀌었습니다. 다시 시도해주세요.'));
      apply();
    };
    tx.oncomplete=resolve;tx.onerror=()=>reject(failure||tx.error||Error('동기화 데이터를 저장하지 못했습니다.'));tx.onabort=()=>reject(failure||tx.error||Error('받은 데이터를 저장하지 못했습니다. 기존 데이터는 유지됩니다.'));
  });
  for(const entry of entries)changed(entry.record.id);changed(null);
}

/** Autosave never writes the imported file. HTML is retained once; edits are separate metadata. */
export async function saveDocumentHTML(record, html, operations = {}) {
  if(typeof html==='string')record.html=html;record.diskPending=false;record.diskError=null;
  const put=operations.put || putDocumentRevision;
  const saved=await put(record,operations.revision);
  if(saved?.byteSize)record.byteSize=saved.byteSize;
  if(saved?.folderId!==undefined)record.folderId=saved.folderId;
  if(saved?.trashedAt)record.trashedAt=saved.trashedAt;else delete record.trashedAt;
  return record;
}
