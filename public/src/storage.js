const DB_NAME = 'HTMLMemo-v1';
let database;
async function db() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 3);
    let blocked=false;
    request.onblocked=()=>{blocked=true;database=null;reject(new Error('다른 HTMLMemo 창이 이전 보관함을 사용하고 있습니다. 해당 창을 닫고 다시 열어주세요. 보관한 문서는 유지됩니다.'));};
    request.onupgradeneeded = event => {
      const database = request.result;
      if (!database.objectStoreNames.contains('documents')) database.createObjectStore('documents', {keyPath:'id'});
      if (!database.objectStoreNames.contains('settings')) database.createObjectStore('settings');
      if (!database.objectStoreNames.contains('contents')) database.createObjectStore('contents', {keyPath:'documentId'});
      if (!database.objectStoreNames.contains('revisions')) database.createObjectStore('revisions', {keyPath:'id',autoIncrement:true}).createIndex('documentId','documentId');
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
  return {...record,html:content.html,file:content.file};
}
// Library cards never load book bodies; getDocument is the explicit lazy read.
export const listDocuments = () => transaction('documents','readonly',store=>store.getAll());
export const getDocument = async id => withContent(await transaction('documents', 'readonly', store => store.get(id)));
export const putDocument = record => putDocumentRevision(record);
export const getSetting = key => transaction('settings', 'readonly', store => store.get(key));
export const setSetting = (key, value) => transaction('settings', 'readwrite', store => store.put(value, key));
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
    tx.oncomplete=()=>resolve(saved);
    tx.onerror=()=>reject(tx.error);
    tx.onabort=()=>reject(failure||tx.error||new Error('파일 확인 결과를 보관하지 못했습니다.'));
  });
}
/** View-only saves leave annotations, history, source HTML and the modification date alone. */
export async function putDocumentView(id, view) {
  const position = structuredClone(view), connection = await db();
  return new Promise((resolve, reject) => {
    const tx = connection.transaction('documents', 'readwrite'), store = tx.objectStore('documents');
    const request = store.get(id); let saved, failure;
    request.onsuccess = () => {
      try {
        saved = request.result;
        if (!saved) throw new Error('읽기 위치를 저장할 문서를 찾지 못했습니다.');
        saved.metadata = {...saved.metadata, view:position};
        store.put(saved);
      } catch (error) { failure = error; tx.abort(); }
    };
    tx.oncomplete = () => resolve(saved);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(failure || tx.error || new Error('읽기 위치를 저장하지 못했습니다.'));
  });
}
export async function deleteDocument(id) {
  const connection=await db();
  await new Promise((resolve,reject)=>{
    const tx=connection.transaction(['documents','contents','revisions'],'readwrite');tx.objectStore('documents').delete(id);tx.objectStore('contents').delete(id);
    const request=tx.objectStore('revisions').index('documentId').openCursor(IDBKeyRange.only(id));
    request.onsuccess=()=>{const cursor=request.result;if(cursor){cursor.delete();cursor.continue();}};
    tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);tx.onerror=()=>reject(tx.error);
  });
  try { const root = await navigator.storage.getDirectory(); await root.removeEntry(id + '.html'); } catch { /* IndexedDB also contains the complete HTML. */ }
}
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
export async function listRevisionSummaries(id, before = Infinity, limit = 50) {
  const connection=await db();
  return new Promise((resolve,reject)=>{
    const tx=connection.transaction('revisions','readonly'),rows=[];
    const request=tx.objectStore('revisions').index('documentId').openCursor(IDBKeyRange.only(id),'prev');
    request.onsuccess=()=>{
      const cursor=request.result;if(!cursor)return;
      if(cursor.primaryKey<before){const v=cursor.value;rows.push({id:v.id,created:v.created,kind:v.kind,annotationCount:v.annotations.length,bookmarkCount:v.bookmarks.length});}
      if(rows.length<limit)cursor.continue();
    };
    tx.oncomplete=()=>resolve(rows);tx.onabort=()=>reject(tx.error);tx.onerror=()=>reject(tx.error);
  });
}

/** The current document and its annotation revision commit atomically. No source-file permission is needed. */
export async function putDocumentRevision(record, {baseline = false, restoredFrom = null} = {}) {
  const connection=await db();
  const state={annotations:record.metadata?.annotations || [],bookmarks:record.metadata?.bookmarks || []};
  const {html,file,...value}=record;value.diskPending=false;value.diskError=null;
  if(!value.byteSize)value.byteSize=file?.size || (typeof html==='string'?new Blob([html]).size:0);
  return new Promise((resolve,reject)=>{
    const tx=connection.transaction(['documents','contents','revisions'],'readwrite');
    let failure;
    const documents=tx.objectStore('documents'),revisions=tx.objectStore('revisions'),contents=tx.objectStore('contents');
    const previous=documents.get(record.id),content=contents.getKey(record.id);
    const latest=revisions.index('documentId').openKeyCursor(IDBKeyRange.only(record.id),'prev');
    // Queue reads before any awaits so the transaction stays active.
    latest.onsuccess=()=>{
      try {
        const last=latest.result;
        const old=previous.result;
        // A still-open legacy tab must not erase a later duplicate-check cache.
        if(!value.sourceIdentity&&old?.sourceIdentity)value.sourceIdentity=old.sourceIdentity;
        if (!last && old && !sameAnnotationState(old.metadata,state)) revisions.add({documentId:record.id,created:Date.now(),kind:'baseline',...annotationState(old.metadata)});
        if (!last || !sameAnnotationState(old?.metadata,state)) revisions.add({documentId:record.id,created:Date.now(),kind:restoredFrom?'restore':baseline?'baseline':'edit',restoredFrom,...state});
        if(!content.result){if(file instanceof Blob)contents.add({documentId:record.id,file});else{const source=old?.html ?? html;if(typeof source!=='string')throw Error('HTML 본문을 보관하지 못했습니다. 문서를 다시 열어주세요.');contents.add({documentId:record.id,html:source});}}
        documents.put(value);
      } catch(error){failure=error;tx.abort();}
    };
    tx.oncomplete=()=>resolve(value);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(failure || tx.error || new Error('주석과 이력을 저장하지 못했습니다.'));
  });
}

/** Autosave never writes the imported file. HTML is retained once; edits are separate metadata. */
export async function saveDocumentHTML(record, html, operations = {}) {
  if(typeof html==='string')record.html=html;record.diskPending=false;record.diskError=null;
  const put=operations.put || putDocumentRevision;
  const saved=await put(record,operations.revision);
  if(saved?.byteSize)record.byteSize=saved.byteSize;
  return record;
}
