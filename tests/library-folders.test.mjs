import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {validateFolders,folderName,folderPath,folderDescendants,editLibraryFolders,mergeLibraryFolders,documentCopyName,LIBRARY_FOLDERS_KEY,LibraryIndex} from '../public/src/library-folders.js';

const tree=()=>[{id:'books',parentId:'',name:'책'},{id:'study',parentId:'books',name:'공부'},{id:'archive',parentId:'',name:'보관'}];
test('library folders form a rooted, ordered path and include descendants without reading documents',()=>{
  const folders=validateFolders(tree());assert.deepEqual(folderPath(folders,'study').map(f=>f.name),['책','공부']);assert.deepEqual([...folderDescendants(folders,'books')],['books','study']);assert.deepEqual(folderPath(folders,''),[]);
});
test('folder names normalize Unicode and reject traversal, control characters, reserved names and duplicates',()=>{
  assert.equal(folderName('  한글  '),'한글');assert.equal(folderName('한글'),'한글');
  for(const name of ['','.', '..','/tmp','a\\b','a\n','<bad>','HTMLMemo-data','HTMLMemo-library.json','CON','nul.txt','name.','x'.repeat(101)])assert.throws(()=>folderName(name),undefined,name);
  assert.throws(()=>validateFolders([{id:'a',parentId:'',name:'Books'},{id:'b',parentId:'',name:'books'}]),/중복/);
  assert.throws(()=>validateFolders([{id:'a',parentId:'missing',name:'책'}]),/상위/);
  assert.throws(()=>validateFolders([{id:'a',parentId:'b',name:'A'},{id:'b',parentId:'a',name:'B'}]),/하위/);
});
test('create, rename and move validate the full resulting hierarchy without mutating the input',()=>{
  const folders=tree(),original=structuredClone(folders);let next=editLibraryFolders(folders,[],{type:'create',id:'new',parentId:'study',name:' 새 폴더 '}).folders;
  next=editLibraryFolders(next,[],{type:'rename',id:'new',name:'메모'}).folders;next=editLibraryFolders(next,[],{type:'move',id:'books',parentId:'archive'}).folders;
  assert.deepEqual(folderPath(next,'new').map(f=>f.name),['보관','책','공부','메모']);assert.deepEqual(folders,original);
  assert.throws(()=>editLibraryFolders(next,[],{type:'move',id:'archive',parentId:'study'}),/하위/);
  assert.throws(()=>editLibraryFolders(next,[],{type:'delete',id:''}),/root/);
  assert.throws(()=>editLibraryFolders(next,[],{type:'rename',id:'missing',name:'X'}),/변경/);
  const deep=Array.from({length:32},(_,i)=>({id:'d'+i,parentId:i?'d'+(i-1):'',name:'D'+i}));assert.equal(validateFolders(deep).length,32);assert.throws(()=>editLibraryFolders(deep,[],{type:'create',id:'too-deep',parentId:'d31',name:'초과'}),/32/);
});
test('only empty folders can be deleted, while moving documents preserves every annotation and date',()=>{
  const record={id:'book',folderId:'study',created:100,modified:200,metadata:{annotations:[{id:'note',text:'keep'}],bookmarks:[{id:'mark'}],view:{zoom:2}}},before=structuredClone(record);
  assert.throws(()=>editLibraryFolders(tree(),[record],{type:'delete',id:'study'}),/비어/);assert.throws(()=>editLibraryFolders(tree(),[],{type:'delete',id:'books'}),/하위/);
  const moved=editLibraryFolders(tree(),[record],{type:'move-documents',ids:['book','book'],parentId:'archive'});assert.deepEqual(moved.documents,[{...before,folderId:'archive'}]);assert.deepEqual(record,before);
  assert.equal(editLibraryFolders(tree(),moved.documents,{type:'delete',id:'study'}).folders.length,2);
  assert.throws(()=>editLibraryFolders(tree(),[record],{type:'move-documents',ids:['missing'],parentId:''}),/삭제/);
});
test('reconnecting merges equal paths and remaps ID conflicts without losing either hierarchy',()=>{
  const incoming=[{id:'remote-books',parentId:'',name:'책'},{id:'study',parentId:'remote-books',name:'다른 공부'},{id:'notes',parentId:'study',name:'주석'}],merged=mergeLibraryFolders(tree(),incoming,()=> 'conflict-copy');
  assert.equal(merged.mapping.get('remote-books'),'books');assert.equal(merged.mapping.get('study'),'conflict-copy');assert.deepEqual(folderPath(merged.folders,'notes').map(f=>f.name),['책','다른 공부','주석']);assert.equal(merged.folders.length,5);
});
test('deleting an otherwise empty folder keeps its trashed documents recoverable at root',()=>{
  const record={id:'trashed',folderId:'study',trashedAt:123,metadata:{annotations:[{id:'note'}]}},before=structuredClone(record);
  const next=editLibraryFolders(tree(),[record],{type:'delete',id:'study'});assert.equal(next.folders.some(folder=>folder.id==='study'),false);assert.deepEqual(next.documents,[{...before,folderId:''}]);assert.deepEqual(record,before);
  assert.throws(()=>editLibraryFolders(tree(),[record],{type:'move-documents',ids:['trashed'],parentId:'archive'}),/복원/);
});
test('the trash index spans all original folders and reuses queries without mixing ordinary folder results',()=>{
  const index=new LibraryIndex(),records=[{id:'one',folderId:'study',title:'첫 책',name:'first.html',trashedAt:200},{id:'two',folderId:'archive',title:'둘째 책',name:'second.html',trashedAt:100}];index.update(records,tree());
  const query={allFolders:true,sort:'trashedAt',direction:'desc'},all=index.select(query);assert.deepEqual(all.documents.map(record=>record.id),['one','two']);assert.equal(all.folders.length,0);assert.equal(index.select(query),all);
  assert.deepEqual(index.select({...query,filter:'공부'}).documents.map(record=>record.id),['one']);assert.equal(index.select({folderId:''}).documents.length,0);assert.equal(index.select({folderId:''}).folders.length,2);
});
test('raw copy names are safe, retain the original extension and distinguish same-name documents',()=>{
  const ref={name:'a'.repeat(64)+'.mhtml'};const a=documentCopyName({id:'one',name:'../받은 <문서>.MHTML'},ref),b=documentCopyName({id:'two',name:'../받은 <문서>.MHTML'},ref);
  assert.ok(a.endsWith('[one].mhtml'));assert.ok(!/[<>/\\]/.test(a));assert.notEqual(a,b);
});

const source=(await readFile(new URL('../public/src/storage.js',import.meta.url),'utf8')).replace(/^export /gm,'');
function storageFixture(){
  let stores=new Map([['settings',new Map([[LIBRARY_FOLDERS_KEY,tree()]])],['documents',new Map([['book',{id:'book',folderId:'study',modified:123,byteSize:10,metadata:{annotations:[{id:'note'}],bookmarks:[],view:{zoom:1}}}]])]]);
  const writes=[],transactions=[],control={};
  const connection={transaction(names){
    transactions.push(Array.isArray(names)?Array.from(names):names);const snapshot=structuredClone(stores);let pending=0,aborted=false,scheduled=false;const tx={};
    const request=value=>{pending++;const r={};queueMicrotask(()=>{if(aborted)return;r.result=structuredClone(value);r.onsuccess?.();if(!--pending&&!scheduled){scheduled=true;setImmediate(()=>{if(!aborted){stores=snapshot;tx.oncomplete?.();}});}});return r;};
    tx.abort=()=>{aborted=true;queueMicrotask(()=>tx.onabort?.());};
    tx.objectStore=name=>{if(!snapshot.has(name))snapshot.set(name,new Map());const map=snapshot.get(name);return {get:key=>request(map.get(key)),getAll:()=>request([...map.values()]),getKey:()=>request('retained'),put:(value,key)=>{if(control.failWrite)throw Error('Disk full');writes.push(name);map.set(key??value.id,structuredClone(value));return request(key??value.id);},index:()=>({openKeyCursor:()=>request({primaryKey:1}),openCursor:()=>request({primaryKey:1,value:map.get('book')?.metadata})})};};return tx;
  }};
  const context=vm.createContext({connection,structuredClone,Blob,Date,IDBKeyRange:{only:id=>id}});vm.runInContext(source+'\ndatabase=Promise.resolve(connection);',context);
  return {api:context,writes,transactions,control,get folders(){return stores.get('settings').get(LIBRARY_FOLDERS_KEY);},get record(){return stores.get('documents').get('book');}};
}
test('folder edits atomically update only metadata; stale reader autosaves cannot reverse a document move',async()=>{
  const f=storageFixture(),stale=structuredClone(f.record);await f.api.updateLibraryFolders((folders,records)=>editLibraryFolders(folders,records,{type:'move-documents',ids:['book'],parentId:'archive'}));
  assert.equal(f.record.folderId,'archive');assert.deepEqual(f.record.metadata,stale.metadata);assert.equal(f.record.modified,123);assert.deepEqual(f.transactions[0],['settings','documents']);assert.deepEqual(f.writes,['settings','documents']);
  stale.metadata.annotations.push({id:'new-note'});await f.api.saveDocumentHTML(stale,undefined,{revision:{checkpoint:false}});assert.equal(f.record.folderId,'archive');assert.equal(stale.folderId,'archive');assert.equal(f.record.metadata.annotations.length,2);assert.ok(!f.writes.includes('contents'));assert.ok(!f.writes.includes('revisions'));
});
test('failed folder operations roll back both the tree and document placements',async()=>{
  const f=storageFixture(),before=structuredClone(f.record);f.control.failWrite=true;
  await assert.rejects(f.api.updateLibraryFolders((folders,records)=>editLibraryFolders(folders,records,{type:'move-documents',ids:['book'],parentId:'archive'})),/Disk full/);assert.deepEqual(f.record,before);assert.deepEqual(f.folders,tree());
  f.control.failWrite=false;await assert.rejects(f.api.updateLibraryFolders((folders,records)=>editLibraryFolders(folders,records,{type:'delete',id:'study'})),/비어/);assert.deepEqual(f.record,before);
});
test('folder restoration rejects a concurrently changed local hierarchy instead of replacing it',async()=>{
  const f=storageFixture();await assert.rejects(f.api.restoreFolderDocuments([],[],[]),/다른 창/);assert.deepEqual(f.folders,tree());
  await f.api.restoreFolderDocuments([],[],tree());assert.deepEqual(f.folders,[]);
});
test('library reads use one readonly transaction and return only document headers and the tree',async()=>{
  const f=storageFixture(),snapshot=await f.api.readLibrary();assert.deepEqual(snapshot.folders,tree());assert.deepEqual(snapshot.documents,[f.record]);assert.deepEqual(f.transactions,[['settings','documents']]);assert.deepEqual(f.writes,[]);
});
