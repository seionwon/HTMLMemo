const DB_NAME = 'HTMLMemo-v1';
let database;
async function db() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('documents', {keyPath: 'id'}); request.result.createObjectStore('settings'); };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
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
export const listDocuments = () => transaction('documents', 'readonly', store => store.getAll());
export const getDocument = id => transaction('documents', 'readonly', store => store.get(id));
export const putDocument = record => transaction('documents', 'readwrite', store => store.put(record));
export const getSetting = key => transaction('settings', 'readonly', store => store.get(key));
export const setSetting = (key, value) => transaction('settings', 'readwrite', store => store.put(value, key));
export async function deleteDocument(id) {
  await transaction('documents', 'readwrite', store => store.delete(id));
  try { const root = await navigator.storage.getDirectory(); await root.removeEntry(id + '.html'); } catch { /* IndexedDB also contains the complete HTML. */ }
}
export async function writeInternalHTML(id, html) {
  if (!navigator.storage?.getDirectory) return;
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(id + '.html', {create: true});
  const writer = await handle.createWritable();
  try { await writer.write(html); await writer.close(); } catch (error) { await writer.abort().catch(() => {}); throw error; }
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
  if (!await permission(record.fileHandle)) throw new Error('파일 쓰기 권한이 필요합니다. 「파일 연결 / 저장 재시도」를 눌러주세요.');
  const before = await record.fileHandle.getFile();
  if (!force && record.diskStamp && (before.lastModified !== record.diskStamp.modified || before.size !== record.diskStamp.size)) throw new Error('다른 프로그램에서 파일을 수정했습니다. 파일을 다시 열거나 다른 이름으로 저장해주세요.');
  const writer = await record.fileHandle.createWritable();
  try { await writer.write(html); await writer.close(); } catch (error) { await writer.abort().catch(() => {}); throw error; }
  const after = await record.fileHandle.getFile(); record.diskStamp = {modified: after.lastModified, size: after.size};
}
