import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DeviceSyncAdapter,DEVICE_SYNC_FORMAT} from '../public/src/sync-adapter.js';
import {encryptData,decryptData,deriveTopic} from '../public/src/sync-crypto.js';
import {cleanRoomId} from '../public/src/sync-service.js';
import {localFileIdentity} from '../public/src/local-files.js';
import {memoryLocal} from './folder-fixture.mjs';

async function record(id,{trash=false,annotations=[],html='<h1>'+id+'</h1>',folderId=''}={}){
  const source=new Blob([html],{type:'text/html'});
  return {id,title:id,name:id+'.html',created:1000,modified:2000,historyVersion:1,html,sourceIdentity:await localFileIdentity(source),folderId,...(trash?{trashedAt:3000}:{}),metadata:{version:1,title:id,source:'',viewport:{width:1000,height:800},view:{scrollTop:100},annotations,bookmarks:[],execution:{allowScripts:false}}};
}
function fixture(rows=[],folders=[],root='My root'){
 const docs=new Map(rows.map(r=>[r.id,r])),history=new Map(rows.map(r=>[r.id,[{created:1000,annotations:r.metadata.annotations,bookmarks:[]}]]));
 const storage=memoryLocal([['htmlmemo-theme','light'],['root-folder-name',root]]),calls=[];let current=folders;
 const operations={
  listDocuments:async()=>[...docs.values()],readLibrary:async()=>({documents:[...docs.values()],folders:current}),getDocument:async id=>structuredClone(docs.get(id)),listRevisions:async id=>structuredClone(history.get(id)||[]),
  commitDeviceSync:async(entries,tree,expected)=>{assert.deepEqual(current,expected);calls.push(entries);for(const entry of entries){docs.set(entry.record.id,{...entry.record,...entry.content});history.set(entry.record.id,entry.revisions);}current=tree;}
 };
 return {docs,history,storage,calls,operations,get folders(){return current;},adapter:options=>new DeviceSyncAdapter({operations,storage,...options})};
}
test('MemoSuite room normalization, topic derivation and AES encryption remain compatible',async()=>{
 assert.equal(cleanRoomId(' a b_c '),'A-B_C');
 const key='HM-TEST-ROOM-KEY';assert.equal(await deriveTopic(key),'ms'+createHash('sha256').update('memosuite-sync-topic:'+key).digest('hex').slice(0,48));
 const text='주석·북마크와 private content '.repeat(4000),encrypted=await encryptData(text,key);assert.ok(!encrypted.includes('private'));
 assert.equal(await decryptData(encrypted,key),text);await assert.rejects(decryptData(encrypted,'different-key'));
 const tampered=encrypted.slice(0,-20)+(encrypted.at(-20)==='A'?'B':'A')+encrypted.slice(-19);await assert.rejects(decryptData(tampered,key));
});
test('all documents, trash contents, bookmarks, positions and history transfer; root names never enter the package',async()=>{
 const a=fixture([await record('live'),await record('trash',{trash:true})],[],'원래-루트'),b=fixture([],[],'다른-루트');
 const data=await a.adapter().getBackupData();assert.equal(data.documents.length,2);assert.ok(!JSON.stringify(data).includes('원래-루트'));assert.ok(!JSON.stringify(data).includes('root-folder-name'));
 assert.equal((await a.adapter().analyzeSyncData()).count,2);await b.adapter({isHost:()=>false}).mergeBackupData(data);
 assert.equal(b.docs.get('trash').trashedAt,3000);assert.equal(b.docs.get('trash').html,'<h1>trash</h1>');assert.equal(b.docs.get('live').metadata.view.scrollTop,100);assert.equal(b.history.get('trash').length,1);assert.equal(b.storage.getItem('root-folder-name'),'다른-루트');
});
test('relative folders merge into this device root despite different folder IDs and root names',async()=>{
 const a=fixture([await record('book',{folderId:'source-sub'})],[{id:'source-sub',parentId:'',name:'책'}],'A'),b=fixture([],[{id:'target-sub',parentId:'',name:'책'}],'B');
 await b.adapter().mergeBackupData(await a.adapter().getBackupData());assert.equal(b.docs.get('book').folderId,'target-sub');assert.equal(b.folders.length,1);assert.equal(b.storage.getItem('root-folder-name'),'B');
});
test('selected item sharing and mirrored exclusions do not send unrelated items',async()=>{
 const a=fixture([await record('one'),await record('two')]);const adapter=a.adapter();assert.deepEqual(await adapter.getSyncTargetIds('two'),['two']);assert.deepEqual((await adapter.getBackupData(['two'])).documents.map(d=>d.record.id),['two']);assert.deepEqual((await adapter.getBackupData(undefined,['one'])).documents.map(d=>d.record.id),['two']);
});
test('conflicts support local, remote with a full safety copy, and keep both without repeated copies',async()=>{
 const a=fixture([await record('same',{html:'<p>remote</p>',trash:true})]);const packet=await a.adapter().getBackupData();
 for(const choice of ['local','remote','both']){
  const local=await record('same',{html:'<p>local</p>'}),b=fixture([local]);await b.adapter().mergeBackupData(packet,async conflicts=>{assert.equal(conflicts.length,1);return [choice];});
  assert.equal(b.docs.size,choice==='local'?1:2);
  if(choice==='local')assert.equal(b.docs.get('same').html,'<p>local</p>');
  else if(choice==='remote'){assert.equal(b.docs.get('same').html,'<p>remote</p>');assert.equal(b.docs.get('same').trashedAt,3000);assert.ok([...b.docs.values()].some(d=>d.title.includes('보관본')&&d.html==='<p>local</p>'));}
  else{assert.equal(b.docs.get('same').html,'<p>local</p>');assert.ok([...b.docs.values()].some(d=>d.html==='<p>remote</p>'));await b.adapter().mergeBackupData(packet);assert.equal(b.docs.size,2);}
 }
});
test('metadata-only sync keeps a matching original and fails atomically if the original is absent',async()=>{
 const a=fixture([await record('same')]),packet=await a.adapter({includeSources:false}).getBackupData();assert.equal(packet.documents[0].body,null);
 const b=fixture([await record('same')]);packet.documents[0].record.metadata.view.scrollTop=300;await b.adapter().mergeBackupData(packet,async()=>['remote']);assert.equal(b.docs.get('same').html,'<h1>same</h1>');assert.equal(b.docs.get('same').metadata.view.scrollTop,300);
 const empty=fixture();await assert.rejects(empty.adapter().mergeBackupData(packet),/원본/);assert.equal(empty.calls.length,0);
});
test('wrong app, corrupt bytes, invalid annotations and cancelled imports never write data',async()=>{
 const a=fixture([await record('test')]),packet=await a.adapter().getBackupData(),b=fixture();
 await assert.rejects(b.adapter().mergeBackupData({...packet,format:'MemoSuite'}),/지원/);
 const corrupt=structuredClone(packet);corrupt.documents[0].body.bytes=btoa('tampered');await assert.rejects(b.adapter().mergeBackupData(corrupt),/검증/);
 const bad=structuredClone(packet);bad.documents[0].record.metadata.annotations=[{id:'bad'}];await assert.rejects(b.adapter().mergeBackupData(bad),/주석/);
 await assert.rejects(b.adapter({isActive:()=>false}).mergeBackupData(packet),/닫았/);assert.equal(b.calls.length,0);
});
test('large original fails before upload and metadata-only remains available',async()=>{
 const a=fixture([await record('large',{html:'x'.repeat(900000)})]);await assert.rejects(a.adapter().getBackupData(),/전송 용량/);assert.equal((await a.adapter({includeSources:false}).getBackupData()).documents[0].body,null);
});
