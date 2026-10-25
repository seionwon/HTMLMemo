import {folderPath,validateFolders} from './library-folders.js';
import {localFileIdentity} from './local-files.js';

export const FOLDER_MARKER='HTMLMemo-folder.json';
const marker=(library,id)=>({format:'HTMLMemo.folder',version:1,library,id});
async function readMarker(directory) {
  try{const file=await(await directory.getFileHandle(FOLDER_MARKER)).getFile();if(file.size>2048)return null;return JSON.parse(await file.text());}
  catch(error){if(error.name==='NotFoundError'||error instanceof SyntaxError)return null;throw error;}
}
const owns=(value,library,id)=>value?.format==='HTMLMemo.folder'&&value.version===1&&value.library===library&&value.id===id;
const pathKey=path=>JSON.stringify(path);
async function directoryAt(root,path) {let directory=root;for(const name of path)directory=await directory.getDirectoryHandle(name);return directory;}
function locations(manifest) {
  const folders=validateFolders(manifest?.folders||[]),paths=new Map([['',[]]]);
  for(const f of folders)paths.set(f.id,folderPath(folders,f.id).map(p=>p.name));
  return {folders,paths};
}
/** Materialize app-owned directories and immutable raw copies BEFORE publishing the manifest. */
export async function syncFolderTree(root,manifest,previous,{readOriginal,write}) {
  const {folders,paths}=locations(manifest),directories=new Map([['',root]]),pending=[...folders];
  while(pending.length){
    const index=pending.findIndex(f=>directories.has(f.parentId)),folder=pending.splice(index,1)[0],parent=directories.get(folder.parentId);
    let directory,created=false;
    try{directory=await parent.getDirectoryHandle(folder.name);}catch(error){if(error.name!=='NotFoundError')throw error;directory=await parent.getDirectoryHandle(folder.name,{create:true});created=true;}
    const found=await readMarker(directory);
    if(!owns(found,manifest.id,folder.id)){
      const previousFolder=(previous?.folders||[]).find(f=>owns(found,manifest.id,f.id)&&pathKey(folderPath(previous.folders,f.id).map(p=>p.name))===pathKey(paths.get(folder.id)));
      let empty=true;for await(const entry of directory.entries()){empty=false;break;}
      if(!created&&!empty&&!previousFolder)throw Error(`“${paths.get(folder.id).join('/')}” 위치에 앱이 관리하지 않는 폴더 또는 파일이 있습니다. 기존 항목을 덮어쓰지 않습니다. 서재에서 다른 폴더 이름을 사용하세요.`);
      await write(directory,FOLDER_MARKER,JSON.stringify(marker(manifest.id,folder.id))+'\n');
    }
    directories.set(folder.id,directory);
  }
  const old=locations(previous),oldCopies=new Set((previous?.documents||[]).filter(e=>e.copy).map(e=>pathKey([...(old.paths.get(e.copy.folderId)||[]),e.copy.name,e.original?.name||e.source.name])));
  for(const entry of manifest.documents){
    const directory=directories.get(entry.copy.folderId),ref=entry.original||entry.source,name=entry.copy.name,key=pathKey([...paths.get(entry.copy.folderId),name,ref.name]);
    let file;try{file=await(await directory.getFileHandle(name)).getFile();}catch(error){if(error.name!=='NotFoundError')throw error;}
    if(file){
      // A previously published copy only needs a cheap existence/size check on edits.
      if(file.size===ref.size&&(oldCopies.has(key)||(await localFileIdentity(file)).digest===ref.name.slice(0,64)))continue;
      throw Error(`“${name}” 원본 복사본이 앱 밖에서 변경되었습니다. 덮어쓰지 않습니다. 해당 파일을 다른 이름으로 보관한 뒤 저장 위치를 다시 연결하세요.`);
    }
    await write(directory,name,await readOriginal(ref));
  }
}
/** After publication, remove ONLY verified old app copies and empty, owned directories. */
export async function cleanupFolderTree(root,current,previous) {
  if(!previous)return;
  const old=locations(previous),now=locations(current);
  const keep=new Set(current.documents.filter(e=>e.copy).map(e=>pathKey([...now.paths.get(e.copy.folderId),e.copy.name])));
  for(const entry of previous.documents){
    if(!entry.copy)continue;const path=old.paths.get(entry.copy.folderId),name=entry.copy.name;
    if(keep.has(pathKey([...path,name])))continue;
    try{const directory=await directoryAt(root,path),file=await(await directory.getFileHandle(name)).getFile(),ref=entry.original||entry.source;
      if(file.size===ref.size&&(await localFileIdentity(file)).digest===ref.name.slice(0,64))await directory.removeEntry(name);
    }catch(error){if(error.name!=='NotFoundError')throw error;}
  }
  const keptDirectories=new Set([...now.paths.values()].map(pathKey));
  for(const folder of [...old.folders].sort((a,b)=>old.paths.get(b.id).length-old.paths.get(a.id).length)){
    const path=old.paths.get(folder.id);if(keptDirectories.has(pathKey(path)))continue;
    try{const directory=await directoryAt(root,path);if(!owns(await readMarker(directory),previous.id,folder.id))continue;
      let foreign=false;for await(const [name] of directory.entries())if(name!==FOLDER_MARKER){foreign=true;break;}
      if(foreign)continue;
      await directory.removeEntry(FOLDER_MARKER);const parent=await directoryAt(root,path.slice(0,-1));
      // Deliberately non-recursive: a file created by another program wins the race.
      await parent.removeEntry(path.at(-1));
    }catch(error){if(!['NotFoundError','InvalidModificationError'].includes(error.name))throw error;}
  }
}
