import test from 'node:test';
import assert from 'node:assert/strict';
import {DataFolder,FOLDER_MANIFEST,FOLDER_PREVIOUS,FOLDER_DATA,FOLDER_GUIDE,folderSettings,applyFolderSettings,portableRecord} from '../public/src/data-folder.js';
import {PREFERENCES_KEY,normalizePreferences} from '../public/src/preferences.js';
import {memoryFolder,memoryLocal,settleUntil} from './folder-fixture.mjs';
import {LIBRARY_FOLDERS_KEY,editLibraryFolders} from '../public/src/library-folders.js';

function document(id='doc') {
  const note={id:'note',type:'note',color:'#edcf67',width:3,opacity:1,points:[{x:20,y:30}],text:'Separate annotation'};
  return {id,title:'보관할 문서',name:'받은 파일.html',source:'',created:1000,modified:2000,byteSize:50,nativeScroll:true,metadata:{version:1,title:'보관할 문서',source:'',viewport:{width:1100,height:800},view:{scrollTop:1200,scrollLeft:0,zoom:1,autoFit:false},annotations:[note],bookmarks:[{id:'bookmark',title:'이어서',top:1200,left:0}],execution:{allowScripts:true},warnings:[]}};
}
function library(documents=[document()]) {
  const records=new Map(documents.map(r=>[r.id,structuredClone(r)])),contents=new Map(documents.map(r=>[r.id,{html:'<!doctype html><body>Original content</body>',originalFile:new File(['<!doctype html><body>Raw received bytes</body>'],r.name)}])),histories=new Map(documents.map(r=>[r.id,[{id:1,documentId:r.id,created:1000,kind:'baseline',annotations:[],bookmarks:[]},{id:2,documentId:r.id,created:2000,kind:'edit',annotations:r.metadata.annotations,bookmarks:r.metadata.bookmarks}]])),settings=new Map();let reads=0;
  const operations={listDocuments:async()=>[...records.values()].map(r=>structuredClone(r)),getDocument:async id=>{reads++;return {...structuredClone(records.get(id)),...contents.get(id)};},listRevisions:async id=>structuredClone(histories.get(id)||[]),getSetting:async key=>settings.get(key),setSetting:async(key,value)=>settings.set(key,value),restoreFolderDocuments:async(entries,folders)=>{for(const e of entries){assert.ok(!records.has(e.record.id));records.set(e.record.id,structuredClone(e.record));contents.set(e.record.id,e.content);histories.set(e.record.id,structuredClone(e.revisions));}if(folders)settings.set(LIBRARY_FOLDERS_KEY,structuredClone(folders));}};
  return {operations,records,contents,histories,settings,get reads(){return reads;}};
}
function manager(t,lib,storage=memoryLocal(),extra={}) { const backup=new DataFolder({storage,operations:lib.operations,lock:fn=>fn(),delay:100000,...extra});t.after(()=>backup.dispose());return backup; }
const manifest=async folder=>JSON.parse(await (await (await folder.getFileHandle(FOLDER_MANIFEST)).getFile()).text());
const readObject=async(folder,ref)=> (await(await(await folder.getDirectoryHandle(FOLDER_DATA)).getFileHandle(ref.name)).getFile()).text();

test('folder connection copies every source, separate notes, bookmarks, history, view and settings into one portable folder',async t=>{
  const lib=library([document(),document('second')]),disk=memoryFolder(),storage=memoryLocal([[PREFERENCES_KEY,JSON.stringify(normalizePreferences({theme:'dark',libraryView:'list'}))],['msuite_tts_rate','1.5'],['htmlmemo_tts_lang_doc','ko'],['msuite_tts_voice_ko','device voice'],['htmlmemo-doc-toc-width-v1','310'],['other-app-secret','never copy']]);
  const backup=manager(t,lib,storage);await backup.connect(disk);assert.equal(backup.state,'saved');assert.equal(backup.pending,false);
  const head=await manifest(disk);assert.equal(head.documents.length,2);assert.equal(lib.reads,2);
  for(const e of head.documents){assert.match(await readObject(disk,e.original),/Raw received bytes/);assert.doesNotMatch(await readObject(disk,e.original),/Separate annotation|htmlmemo-data/);assert.doesNotMatch(await readObject(disk,e.source),/Separate annotation/);const state=JSON.parse(await readObject(disk,e.state)),history=JSON.parse(await readObject(disk,e.history));assert.equal(state.record.metadata.annotations[0].text,'Separate annotation');assert.equal(state.record.metadata.bookmarks.length,1);assert.equal(state.record.metadata.view.scrollTop,1200);assert.equal(history.revisions.length,2);assert.ok(!('id' in history.revisions[0]));}
  const settings=JSON.parse(await readObject(disk,head.settings));assert.equal(settings.entries.msuite_tts_rate,'1.5');assert.equal(settings.entries.htmlmemo_tts_lang_doc,'ko');assert.equal(settings.entries['other-app-secret'],undefined);
  const instructions=await (await(await disk.getFileHandle(FOLDER_GUIDE)).getFile()).text();for(const text of ['폴더 전체','설정 파일','HTML 내보내기','주석이 HTML 안에 포함','Documents'])assert.ok(instructions.includes(text));
});
test('a fresh device restores only folder files with complete history and preferences, without source handles or an export',async t=>{
  const sender=library(),disk=memoryFolder(),settings=memoryLocal([[PREFERENCES_KEY,JSON.stringify(normalizePreferences({theme:'dark',annotation:{width:7}}))]]);sender.records.get('doc').fileHandle={private:'must not serialize'};sender.records.get('doc').originalHandle={private:'must not serialize'};
  await manager(t,sender,settings).connect(disk);
  const receiver=library([]),local=memoryLocal();let restored;await manager(t,receiver,local,{onRestored:value=>restored=value}).connect(disk);
  assert.equal(receiver.records.size,1);assert.equal(receiver.records.get('doc').metadata.annotations[0].text,'Separate annotation');assert.equal(receiver.histories.get('doc').length,2);assert.equal(receiver.records.get('doc').fileHandle,undefined);assert.equal(JSON.parse(local.getItem(PREFERENCES_KEY)).annotation.width,7);assert.equal(restored.count,1);assert.match(await receiver.contents.get('doc').originalFile.text(),/Raw received bytes/);
});
test('a history-only checkpoint updates the portable history without changing annotations or rewriting source files',async t=>{
  const lib=library(),control={writes:[]},disk=memoryFolder('HTMLMemo',control),backup=manager(t,lib);lib.records.get('doc').historyVersion=1;
  await backup.connect(disk);const first=await manifest(disk),reads=lib.reads;control.writes.length=0;
  lib.histories.get('doc').push({id:3,documentId:'doc',created:3000,kind:'edit',annotations:lib.records.get('doc').metadata.annotations,bookmarks:[]});lib.records.get('doc').historyVersion++;
  backup.schedule({id:'doc'});await backup.flush();const next=await manifest(disk);
  assert.notEqual(next.documents[0].history.name,first.documents[0].history.name);assert.equal(JSON.parse(await readObject(disk,next.documents[0].history)).revisions.length,3);assert.deepEqual(next.documents[0].state,first.documents[0].state);assert.equal(lib.reads,reads);assert.ok(!control.writes.some(name=>name.endsWith('.html')));
});
test('annotation and view edits reuse original and prepared HTML without loading or rewriting source bodies',async t=>{
  const lib=library(),control={writes:[]},disk=memoryFolder('HTMLMemo',control),backup=manager(t,lib);await backup.connect(disk);const first=await manifest(disk),reads=lib.reads;control.writes.length=0;
  lib.records.get('doc').metadata.annotations[0].text='Updated note';lib.records.get('doc').metadata.view.scrollTop=3000;backup.schedule();await backup.flush();const next=await manifest(disk);
  assert.equal(lib.reads,reads);assert.deepEqual(next.documents[0].source,first.documents[0].source);assert.deepEqual(next.documents[0].original,first.documents[0].original);assert.notEqual(next.documents[0].state.name,first.documents[0].state.name);assert.ok(!control.writes.some(name=>name.endsWith('.html')));assert.equal(JSON.parse(await readObject(disk,next.documents[0].state)).record.metadata.view.scrollTop,3000);
});
test('permission loss and disk errors remain pending and keep the last complete manifest until an explicit reconnect',async t=>{
  const lib=library(),control={},disk=memoryFolder('HTMLMemo',control),backup=manager(t,lib);await backup.connect(disk);const old=await manifest(disk);lib.records.get('doc').metadata.annotations[0].text='Not yet on disk';
  control.permission='denied';backup.schedule();await assert.rejects(backup.flush(),{name:'NotAllowedError'});assert.equal(backup.state,'error');assert.equal(backup.pending,true);assert.deepEqual(await manifest(disk),old);
  control.permission='granted';control.failClose=FOLDER_MANIFEST;await assert.rejects(backup.flush(),/Interrupted/);assert.deepEqual(await manifest(disk),old);assert.equal(control.aborts,1);
  control.failClose=null;await backup.connect(disk);assert.equal(backup.state,'saved');assert.equal(lib.records.size,1);assert.match(await readObject(disk,(await manifest(disk)).documents[0].state),/Not yet on disk/);
});
test('a broken current manifest automatically recovers the verified previous snapshot without erasing evidence',async t=>{
  const lib=library(),disk=memoryFolder(),backup=manager(t,lib);await backup.connect(disk);lib.records.get('doc').metadata.annotations[0].text='Second version';backup.schedule();await backup.flush();await disk.getFileHandle(FOLDER_PREVIOUS);
  (await disk.getFileHandle(FOLDER_MANIFEST)).replace('{corrupt');const receiver=library([]);let restored;const recovered=manager(t,receiver,memoryLocal(),{onRestored:value=>restored=value});await recovered.connect(disk);
  assert.equal(restored.recovered,true);assert.equal(receiver.records.get('doc').metadata.annotations[0].text,'Separate annotation');assert.equal((await manifest(disk)).documents.length,1);assert.ok([...disk.children.keys()].some(name=>/^HTMLMemo-library\.recovered-/.test(name)));
});
test('damaged content and traversal references reject before restoring documents, settings or connection',async t=>{
  for(const damage of ['content','path']){
    const lib=library(),disk=memoryFolder();await manager(t,lib).connect(disk);const head=await manifest(disk);
    if(damage==='content')(await(await disk.getDirectoryHandle(FOLDER_DATA)).getFileHandle(head.documents[0].state.name)).replace('broken');
    else{head.documents[0].source.name='../secret.html';(await disk.getFileHandle(FOLDER_MANIFEST)).replace(JSON.stringify(head));}
    const receiver=library([]),local=memoryLocal([['htmlmemo-theme','light']]),backup=manager(t,receiver,local);await assert.rejects(backup.connect(disk));assert.equal(receiver.records.size,0);assert.equal(receiver.settings.has('folder'),false);assert.equal(local.getItem('htmlmemo-theme'),'light');
  }
});
test('different existing annotations survive a folder restore as distinct copies rather than being overwritten',async t=>{
  const lib=library(),disk=memoryFolder();await manager(t,lib).connect(disk);const receiver=library();receiver.records.get('doc').metadata.annotations[0].text='Keep my local edit';
  await manager(t,receiver).connect(disk);assert.equal(receiver.records.size,2);assert.equal(receiver.records.get('doc').metadata.annotations[0].text,'Keep my local edit');const incoming=[...receiver.records.values()].find(r=>r.id!=='doc');assert.equal(incoming.metadata.annotations[0].text,'Separate annotation');assert.match(incoming.title,/폴더에서 복원/);assert.equal(receiver.histories.get(incoming.id).length,2);
});
test('matching headers never discard a different source or annotation history from the incoming folder',async t=>{
  for(const change of ['source','history']){
    const source=library(),disk=memoryFolder();await manager(t,source).connect(disk);
    const receiver=library();if(change==='source')receiver.contents.get('doc').html='<body>A different document</body>';else receiver.histories.get('doc').push({created:2500,kind:'edit',annotations:[],bookmarks:[]});
    await manager(t,receiver).connect(disk);assert.equal(receiver.records.size,2);assert.ok([...receiver.records.values()].some(r=>r.id!=='doc'&&r.title.includes('폴더에서 복원')));
  }
});
test('a changed external manifest is not silently overwritten and reconnect merges both copies',async t=>{
  const lib=library(),disk=memoryFolder(),backup=manager(t,lib);await backup.connect(disk);const external=await manifest(disk);external.revision=crypto.randomUUID();(await disk.getFileHandle(FOLDER_MANIFEST)).replace(JSON.stringify(external));
  lib.records.get('doc').metadata.annotations[0].text='Local after external';backup.schedule();await assert.rejects(backup.flush(),/다른 창이나 기기/);assert.equal((await manifest(disk)).revision,external.revision);await backup.connect(disk);assert.equal(lib.records.size,2);
});
test('unchanged reconnect does not resurrect deleted documents, change settings or re-read large sources',async t=>{
  const lib=library(),disk=memoryFolder(),local=memoryLocal(),backup=manager(t,lib,local);await backup.connect(disk);const reads=lib.reads;lib.records.clear();backup.schedule();await backup.connect(disk,{resume:true});assert.equal(lib.records.size,0);assert.equal(lib.reads,reads);assert.equal((await manifest(disk)).documents.length,0);
});
test('portable settings reject foreign keys and invalid preferences, and records never contain file handles',()=>{
  const local=memoryLocal([['other-token','private'],['msuite_tts_rate','1.25']]);assert.deepEqual(folderSettings(local),{entries:{msuite_tts_rate:'1.25'}});assert.throws(()=>applyFolderSettings(local,{entries:{'other-token':'copy'}}));assert.throws(()=>applyFolderSettings(local,{entries:{[PREFERENCES_KEY]:'{"theme":"invalid"}'}}));assert.equal(portableRecord({...document(),fileHandle:{secret:true},originalFile:new Blob(['private'])}).fileHandle,undefined);
});
test('view-only saves reuse history and original files, while automatic debouncing drains edits made during a write',async t=>{
  const lib=library(),control={writes:[]},disk=memoryFolder('HTMLMemo',control),backup=manager(t,lib,memoryLocal(),{delay:1});let historyReads=0;
  const readHistory=lib.operations.listRevisions;backup.ops.listRevisions=async id=>{historyReads++;return readHistory(id);};
  await backup.connect(disk);const first=await manifest(disk);control.writes.length=0;lib.records.get('doc').metadata.view.scrollTop=4000;backup.schedule({id:'doc'});await backup.flush();const moved=await manifest(disk);
  assert.equal(historyReads,1);assert.deepEqual(moved.documents[0].history,first.documents[0].history);assert.ok(!control.writes.includes(first.documents[0].history.name));assert.equal(lib.reads,1);
  let edited=false;control.onWrite=async name=>{if(name===FOLDER_MANIFEST&&!edited){edited=true;lib.records.get('doc').metadata.annotations[0].text='Edit during a write';backup.schedule({id:'doc'});}};
  lib.records.get('doc').metadata.view.scrollTop=5000;backup.schedule({id:'doc'});await settleUntil(()=>edited&&backup.state==='saved'&&!backup.pending);
  const last=await manifest(disk);assert.match(await readObject(disk,last.documents[0].state),/Edit during a write/);assert.equal(backup.pending,false);
});
test('an aborted first object write and a missing managed copy are repaired from the retained library on retry',async t=>{
  const lib=library(),control={failClose:null},disk=memoryFolder('HTMLMemo',control),backup=manager(t,lib);
  let interrupted=false;control.onWrite=async name=>{if(!interrupted&&/^[a-f0-9]{64}\.html$/.test(name)){interrupted=true;control.failClose=name;}};
  await assert.rejects(backup.connect(disk),/Interrupted/);assert.equal(backup.state,'error');control.failClose=null;await backup.connect(disk);assert.equal(backup.state,'saved');
  const head=await manifest(disk),data=await disk.getDirectoryHandle(FOLDER_DATA);await data.removeEntry(head.documents[0].source.name);backup.schedule({id:'doc'});await backup.flush();assert.equal(await readObject(disk,(await manifest(disk)).documents[0].source),'<!doctype html><body>Original content</body>');
});
test('an interrupted very first manifest leaves no empty root file and reconnect completes without manual file cleanup',async t=>{
  const lib=library(),control={failClose:FOLDER_MANIFEST},disk=memoryFolder('HTMLMemo',control),backup=manager(t,lib);
  await assert.rejects(backup.connect(disk),/Interrupted/);await assert.rejects(disk.getFileHandle(FOLDER_MANIFEST),{name:'NotFoundError'});assert.equal(lib.records.size,1);
  control.failClose=null;await backup.connect(disk);assert.equal(backup.state,'saved');assert.equal((await manifest(disk)).documents.length,1);
});
const hierarchy=()=>[{id:'books',parentId:'',name:'책'},{id:'part',parentId:'books',name:'1부'},{id:'archive',parentId:'',name:'보관'}];
async function copyFile(disk,head,id='doc') {const entry=head.documents.find(e=>e.id===id);let directory=disk;const folders=new Map(head.folders.map(f=>[f.id,f])),path=[];for(let node=folders.get(entry.copy.folderId);node;node=folders.get(node.parentId))path.unshift(node.name);for(const name of path)directory=await directory.getDirectoryHandle(name);return (await directory.getFileHandle(entry.copy.name)).getFile();}
test('nested library folders are real directories and a fresh device restores the hierarchy, raw copies and notes',async t=>{
  const lib=library(),disk=memoryFolder();lib.settings.set(LIBRARY_FOLDERS_KEY,hierarchy());lib.records.get('doc').folderId='part';await manager(t,lib).connect(disk);const head=await manifest(disk);
  assert.equal(head.version,2);assert.deepEqual(head.folders,hierarchy());assert.match(await(await copyFile(disk,head)).text(),/Raw received bytes/);assert.ok((await disk.getDirectoryHandle('책')).children.has('1부'));assert.equal(disk.children.has('보관'),true);
  const other=library([]);await manager(t,other).connect(disk);assert.deepEqual(other.settings.get(LIBRARY_FOLDERS_KEY),hierarchy());assert.equal(other.records.get('doc').folderId,'part');assert.equal(other.records.get('doc').metadata.annotations[0].text,'Separate annotation');assert.equal(other.histories.get('doc').length,2);
});
test('moving a folder moves its nested raw copies without reading source bodies or rewriting annotation history',async t=>{
  const lib=library(),control={writes:[]},disk=memoryFolder('HTMLMemo',control);lib.settings.set(LIBRARY_FOLDERS_KEY,hierarchy());lib.records.get('doc').folderId='part';const backup=manager(t,lib);await backup.connect(disk);const before=await manifest(disk),reads=lib.reads;control.writes.length=0;
  lib.settings.set(LIBRARY_FOLDERS_KEY,editLibraryFolders(hierarchy(),[...lib.records.values()],{type:'move',id:'books',parentId:'archive'}).folders);backup.schedule();await backup.flush();const after=await manifest(disk);
  assert.equal(disk.children.has('책'),false);assert.ok((await(await disk.getDirectoryHandle('보관')).getDirectoryHandle('책')).children.has('1부'));assert.match(await(await copyFile(disk,after)).text(),/Raw received bytes/);assert.equal(lib.reads,reads);assert.deepEqual(after.documents[0].history,before.documents[0].history);assert.deepEqual(after.documents[0].state,before.documents[0].state);assert.deepEqual(JSON.parse(await(await(await disk.getFileHandle(FOLDER_PREVIOUS)).getFile()).text()).folders,hierarchy());
});
test('document moves, folder renames and deletion of empty folders retain annotations and clean only old app copies',async t=>{
  const lib=library(),disk=memoryFolder();lib.settings.set(LIBRARY_FOLDERS_KEY,hierarchy());lib.records.get('doc').folderId='part';const backup=manager(t,lib);await backup.connect(disk);const before=await manifest(disk);
  lib.records.get('doc').folderId='archive';let folders=editLibraryFolders(hierarchy(),[...lib.records.values()],{type:'rename',id:'archive',name:'옮긴 곳'}).folders;folders=editLibraryFolders(folders,[...lib.records.values()],{type:'delete',id:'part'}).folders;lib.settings.set(LIBRARY_FOLDERS_KEY,folders);backup.schedule();await backup.flush();const after=await manifest(disk);
  assert.equal((await disk.getDirectoryHandle('책')).children.has('1부'),false);assert.equal(disk.children.has('보관'),false);assert.equal(after.documents[0].copy.folderId,'archive');assert.match(await(await copyFile(disk,after)).text(),/Raw received bytes/);assert.deepEqual(after.documents[0].history,before.documents[0].history);assert.equal(lib.records.get('doc').modified,2000);
});
test('unmanaged files and changed raw copies are never overwritten or recursively removed',async t=>{
  const lib=library(),disk=memoryFolder();lib.settings.set(LIBRARY_FOLDERS_KEY,hierarchy());lib.records.get('doc').folderId='part';const backup=manager(t,lib);await backup.connect(disk);const before=await manifest(disk),books=await disk.getDirectoryHandle('책');
  (await books.getFileHandle('외부.txt',{create:true})).replace('Keep outside file');lib.settings.set(LIBRARY_FOLDERS_KEY,editLibraryFolders(hierarchy(),[...lib.records.values()],{type:'move',id:'books',parentId:'archive'}).folders);backup.schedule();await backup.flush();assert.equal(await(await(await books.getFileHandle('외부.txt')).getFile()).text(),'Keep outside file');assert.equal(disk.children.has('책'),true);
  const head=await manifest(disk),entry=head.documents[0],destination=await(await(await disk.getDirectoryHandle('보관')).getDirectoryHandle('책')).getDirectoryHandle('1부');(await destination.getFileHandle(entry.copy.name)).replace('External edit');backup.schedule();await assert.rejects(backup.flush(),/앱 밖/);assert.deepEqual(await manifest(disk),head);assert.equal(await(await(await destination.getFileHandle(entry.copy.name)).getFile()).text(),'External edit');assert.deepEqual(before.documents[0].history,head.documents[0].history);
});
test('a conflicting external directory blocks publication without changing its files or the last saved hierarchy',async t=>{
  const lib=library(),disk=memoryFolder(),backup=manager(t,lib);await backup.connect(disk);const before=await manifest(disk),external=await disk.getDirectoryHandle('책',{create:true});(await external.getFileHandle('외부.html',{create:true})).replace('Not ours');lib.settings.set(LIBRARY_FOLDERS_KEY,hierarchy());backup.schedule();await assert.rejects(backup.flush(),/관리하지 않는/);assert.deepEqual(await manifest(disk),before);assert.equal(await(await(await external.getFileHandle('외부.html')).getFile()).text(),'Not ours');assert.equal(external.children.size,1);
});
test('legacy version-one folders upgrade in place, and invalid folder paths reject before touching the library',async t=>{
  const lib=library(),disk=memoryFolder();await manager(t,lib).connect(disk);const old=await manifest(disk);old.version=1;delete old.folders;old.documents.forEach(e=>delete e.copy);(await disk.getFileHandle(FOLDER_MANIFEST)).replace(JSON.stringify(old));const fresh=library([]);await manager(t,fresh).connect(disk);assert.equal(fresh.records.size,1);assert.equal((await manifest(disk)).version,2);
  for(const damage of ['cycle','copy']){const damaged=memoryFolder();await manager(t,library()).connect(damaged);const head=await manifest(damaged);if(damage==='cycle')head.folders=[{id:'a',parentId:'a',name:'순환'}];else head.documents[0].copy.name='../secret.html';(await damaged.getFileHandle(FOLDER_MANIFEST)).replace(JSON.stringify(head));const receiver=library([]);await assert.rejects(manager(t,receiver).connect(damaged));assert.equal(receiver.records.size,0);assert.equal(receiver.settings.has('folder'),false);}
});
test('restoring into an existing same-name library folder remaps IDs and physical ownership without overwriting notes',async t=>{
  const sender=library(),disk=memoryFolder();sender.settings.set(LIBRARY_FOLDERS_KEY,[{id:'remote',parentId:'',name:'책'}]);sender.records.get('doc').folderId='remote';await manager(t,sender).connect(disk);
  const receiver=library([]);receiver.settings.set(LIBRARY_FOLDERS_KEY,[{id:'local',parentId:'',name:'책'}]);await manager(t,receiver).connect(disk);assert.deepEqual(receiver.settings.get(LIBRARY_FOLDERS_KEY),[{id:'local',parentId:'',name:'책'}]);assert.equal(receiver.records.get('doc').folderId,'local');assert.equal((await manifest(disk)).documents[0].copy.folderId,'local');assert.match(await(await copyFile(disk,await manifest(disk))).text(),/Raw received bytes/);
});
