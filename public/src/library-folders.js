/** The empty ID is the dedicated data folder itself; it cannot be moved or deleted. */
export const LIBRARY_FOLDERS_KEY = 'library-folders-v1';
const validId = value => typeof value === 'string' && /^[\w-]{1,80}$/.test(value);
export function folderName(value) {
  if(typeof value !== 'string')throw Error('폴더 이름을 입력해주세요.');
  if(/[\u0000-\u001f\u007f]/.test(value))throw Error('폴더 이름에 제어 문자를 사용할 수 없습니다.');
  const name=value.trim().normalize('NFC');
  if(!name || name.length>100 || /[\u0000-\u001f\u007f/\\<>:"|?*]/.test(name) || /[. ]$/.test(name) || /^\./.test(name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) || /^(?:HTMLMemo|LibreMemo)(?:[.-]|$)/i.test(name) || name==='새 기기로 옮기는 방법.txt')throw Error('폴더 이름은 1~100자로 입력하세요. 경로 기호, 숨김 이름, LibreMemo 관리 이름은 사용할 수 없습니다.');
  if(new TextEncoder().encode(name).length>240)throw Error('폴더 이름이 너무 깁니다. 한글은 80자 이내로 줄여주세요.');
  return name;
}
const nameKey = name => name.normalize('NFC').toLocaleLowerCase('en-US');
export function validateFolders(value = []) {
  if(!Array.isArray(value) || value.length>10000)throw Error('서재 폴더 목록이 손상되었거나 폴더 수 한도(10,000개)를 넘었습니다.');
  const folders=value.map(item=>{
    if(!item || !validId(item.id) || typeof item.parentId!=='string' || item.parentId && !validId(item.parentId) || folderName(item.name)!==item.name)throw Error('서재 폴더 정보가 올바르지 않습니다.');
    return {id:item.id,parentId:item.parentId,name:item.name};
  });
  const ids=new Map(),siblings=new Set();
  for(const item of folders){const key=item.parentId+'\0'+nameKey(item.name);if(ids.has(item.id)||siblings.has(key))throw Error('같은 위치에 중복된 서재 폴더가 있습니다.');ids.set(item.id,item);siblings.add(key);}
  for(const item of folders){const visited=new Set();let node=item;while(node){if(visited.has(node.id)||visited.size>=32)throw Error('폴더를 자기 하위로 옮길 수 없으며, 폴더 깊이는 32단계까지입니다.');visited.add(node.id);if(node.parentId&&!ids.has(node.parentId))throw Error('상위 서재 폴더를 찾지 못했습니다.');node=ids.get(node.parentId);}}
  return folders;
}
/** Reuse this index while traversing a validated hierarchy, even if children precede parents. */
export function indexFolders(folders) {
  const byId=new Map(),children=new Map();
  for(const item of folders){byId.set(item.id,item);if(!children.has(item.parentId))children.set(item.parentId,[]);children.get(item.parentId).push(item);}
  const ordered=[],seen=new Set();
  for(const item of folders){
    const path=[];for(let node=item;node&&!seen.has(node.id);node=byId.get(node.parentId))path.push(node);
    while(path.length){const node=path.pop();seen.add(node.id);ordered.push(node);}
  }
  return {byId,children,ordered};
}
export function folderPath(folders,id,byId=new Map(folders.map(f=>[f.id,f]))) {
  const path=[];let current=byId.get(id);
  while(current && path.length<32){path.unshift(current);current=byId.get(current.parentId);}
  return path;
}
export function folderDescendants(folders,id) {
  const children=new Map();for(const f of folders){if(!children.has(f.parentId))children.set(f.parentId,[]);children.get(f.parentId).push(f.id);}
  const result=new Set([id]),queue=[id];for(let i=0;i<queue.length;i++)for(const child of children.get(queue[i])||[])if(!result.has(child)){result.add(child);queue.push(child);}return result;
}
/** Pure edit; the storage layer applies folders and document placements in one transaction. */
export function editLibraryFolders(current,records,change) {
  let folders=validateFolders(current);const updates=[];
  const requireFolder=id=>{if(id!==''&&!folders.some(f=>f.id===id))throw Error('폴더가 변경되었거나 삭제되었습니다. 다시 선택해주세요.');};
  if(change.type==='create'){
    requireFolder(change.parentId);if(!validId(change.id)||folders.some(f=>f.id===change.id))throw Error('새 폴더 ID가 올바르지 않습니다.');
    folders.push({id:change.id,parentId:change.parentId,name:folderName(change.name)});
  }else if(change.type==='move-documents'){
    requireFolder(change.parentId);if(!Array.isArray(change.ids)||!change.ids.length)throw Error('이동할 문서를 선택해주세요.');
    const byId=new Map(records.map(r=>[r.id,r]));for(const id of new Set(change.ids)){const record=byId.get(id);if(!record||record.trashedAt)throw Error('이동할 문서가 삭제되었습니다. 휴지통에 있다면 먼저 복원해주세요.');if((record.folderId||'')!==change.parentId)updates.push({...record,folderId:change.parentId});}
  }else{
    if(!change.id)throw Error('전용 폴더(root)는 이름 변경·이동·삭제할 수 없습니다.');requireFolder(change.id);
    if(change.type==='delete'){
      if(folders.some(f=>f.parentId===change.id)||records.some(r=>r.folderId===change.id&&!r.trashedAt))throw Error('비어 있는 폴더만 삭제할 수 있습니다. 문서와 하위 폴더를 먼저 다른 폴더로 옮기세요.');
      for(const record of records)if(record.folderId===change.id&&record.trashedAt)updates.push({...record,folderId:''});
      folders=folders.filter(f=>f.id!==change.id);
    }else if(change.type==='move'){
      requireFolder(change.parentId);if(folderDescendants(folders,change.id).has(change.parentId))throw Error('폴더를 자기 자신이나 하위 폴더로 옮길 수 없습니다.');
      folders=folders.map(f=>f.id===change.id?{...f,parentId:change.parentId}:f);
    }else if(change.type==='rename')folders=folders.map(f=>f.id===change.id?{...f,name:folderName(change.name)}:f);
    else throw Error('지원하지 않는 폴더 작업입니다.');
  }
  return {folders:validateFolders(folders),documents:updates};
}
/** Merge on reconnect without replacing local folders or orphaning their documents. */
export function mergeLibraryFolders(local,incoming,newId) {
  const folders=validateFolders(local),ordered=indexFolders(validateFolders(incoming)).ordered,mapping=new Map([['','']]);
  const ids=new Set(folders.map(f=>f.id)),siblings=new Map(folders.map(f=>[f.parentId+'\0'+nameKey(f.name),f]));
  for(const item of ordered){
    const parentId=mapping.get(item.parentId),key=parentId+'\0'+nameKey(item.name),exact=siblings.get(key);
    if(exact){mapping.set(item.id,exact.id);continue;}
    const id=ids.has(item.id)?newId():item.id;
    if(!validId(id)||ids.has(id))throw Error('새 폴더 ID가 올바르지 않습니다.');
    const added={...item,id,parentId};folders.push(added);ids.add(id);siblings.set(key,added);mapping.set(item.id,id);
  }
  return {folders:validateFolders(folders),mapping};
}
const libraryCollator=new Intl.Collator('ko');
/** Metadata only: no document bodies, persistent text index or unbounded query cache. */
export class LibraryIndex {
  update(records,folders,root='전용 폴더') {
    if(this.records===records&&this.folders===folders&&this.root===root)return false;
    this.records=records;this.folders=folders;this.root=root;
    Object.assign(this,indexFolders(folders));
    for(const children of this.children.values())children.sort((a,b)=>libraryCollator.compare(a.name,b.name));
    this.paths=new Map([['',root]]);this.counts=new Map([['',records.length]]);this.documents=new Map();this.searchText=new Map();this.queries=new Map();
    for(const record of records){
      const parent=this.byId.has(record.folderId)?record.folderId:'';
      if(!this.documents.has(parent))this.documents.set(parent,[]);this.documents.get(parent).push(record);
      for(let id=parent;id;id=this.byId.get(id)?.parentId)this.counts.set(id,(this.counts.get(id)||0)+1);
    }
    return true;
  }
  label(id) {
    if(this.paths.has(id))return this.paths.get(id);
    const item=this.byId.get(id);if(!item)return this.root;
    const path=this.label(item.parentId)+' / '+item.name;this.paths.set(id,path);return path;
  }
  select({filter='',folderId='',sort='modified',direction='desc',allFolders=false}={}) {
    filter=filter.toLocaleLowerCase();const key=JSON.stringify([filter,folderId,sort,direction,allFolders]);
    if(this.queries.has(key)){const result=this.queries.get(key);this.queries.delete(key);this.queries.set(key,result);return result;}
    const documents=filter?this.records.filter(record=>{
      if(!this.searchText.has(record))this.searchText.set(record,`${record.title} ${record.source} ${record.name} ${this.label(record.folderId||'')}`.toLocaleLowerCase());
      return this.searchText.get(record).includes(filter);
    }):allFolders?[...this.records]:[...(this.documents.get(folderId)||[])];
    const order=direction==='asc'?1:-1;
    documents.sort((a,b)=>order*(sort==='title'?libraryCollator.compare(a.title,b.title):a[sort]-b[sort]));
    const folders=allFolders?[]:filter?this.folders.filter(f=>this.label(f.id).toLocaleLowerCase().includes(filter)).sort((a,b)=>libraryCollator.compare(a.name,b.name)):(this.children.get(folderId)||[]);
    const result={documents,folders};this.queries.set(key,result);while(this.queries.size>8)this.queries.delete(this.queries.keys().next().value);return result;
  }
}
/** IDs prevent identically named imports from overwriting each other or external files. */
export function documentCopyName(record,ref) {
  if(!validId(record.id))throw Error('문서 ID가 올바르지 않습니다.');
  const suffix=ref.name.match(/\.(html?|mhtml|mht|pdf|epub|epub3|mobi|azw|azw3|fb2|fbz|fb2\.zip|cbz|hwp|hwpx|hml|docx|odt|ott|xlsx|xlsm|xls|csv|tsv|ods|ots|pptx|odp|otp|md|markdown|txt|json)$/i)?.[0]||'.html';
  const base=(typeof record.name==='string'?record.name:'문서').replace(/\.(html?|mhtml|mht|pdf|epub|epub3|mobi|azw|azw3|fb2|fbz|fb2\.zip|cbz|hwp|hwpx|hml|docx|odt|ott|xlsx|xlsm|xls|csv|tsv|ods|ots|pptx|odp|otp|md|markdown|txt|json)$/i,'').replace(/[\u0000-\u001f\u007f/\\<>:"|?*]/g,'_').replace(/^[. ]+|[. ]+$/g,'').slice(0,55)||'문서';
  return `${base} [${record.id}]${suffix}`;
}
