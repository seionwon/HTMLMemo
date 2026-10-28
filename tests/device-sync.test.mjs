import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DeviceSyncAdapter,DEVICE_SYNC_FORMAT,syncSettingsSnapshot,sameSyncSettings,syncSettingsDifferences} from '../public/src/sync-adapter.js';
import {PREFERENCES_KEY,storePreferences,normalizePreferences} from '../public/src/preferences.js';
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
test('settings compare effective defaults and JSON key order without asking or changing them',async()=>{
 const a=fixture(),b=fixture([],[],'Other root');storePreferences(normalizePreferences(),a.storage);a.storage.setItem(PREFERENCES_KEY,JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(a.storage.getItem(PREFERENCES_KEY))).reverse())));a.storage.setItem('msuite_tts_rate','1.0');
 const before=[...b.storage.values],packet=await a.adapter().getStreamBundle();let prompts=0;
 const receiver=b.adapter({isHost:()=>false,resolveSettings:()=>{prompts++;throw Error('Same settings must not ask');}});
 assert.ok(sameSyncSettings(syncSettingsSnapshot(a.storage),syncSettingsSnapshot(b.storage)));assert.deepEqual(syncSettingsDifferences(syncSettingsSnapshot(a.storage),syncSettingsSnapshot(b.storage)),[]);
 await receiver.prepareSettings(packet.manifest);await receiver.mergeStreamBundle(packet);assert.equal(prompts,0);assert.deepEqual([...b.storage.values],before);
});
test('either settings choice is reflected to both peers once while roots and originals remain local',async()=>{
 for(const choice of ['local','remote']){
  const a=fixture([await record('a')],[],'Laptop'),b=fixture([await record('b')],[],'Phone');storePreferences({theme:'dark',annotation:{width:9}},a.storage);storePreferences({theme:'light',annotation:{width:2}},b.storage);a.storage.setItem('msuite_tts_voice_en','Laptop voice');b.storage.setItem('msuite_tts_voice_ko','Phone voice');
  const expected=syncSettingsSnapshot(choice==='local'?b.storage:a.storage);let questions=0;
  const host=a.adapter({isHost:()=>true}),join=b.adapter({isHost:()=>false,resolveSettings:async({differences})=>{questions++;assert.ok(differences.some(d=>d.label==='화면 테마'));assert.equal(b.calls.length,0);return choice;}}),bundle=await host.getStreamBundle();
  await join.prepareSettings(bundle.manifest);assert.equal(b.calls.length,0);const mirrored=await join.mergeStreamBundle(bundle);const reply=await join.getStreamBundle(undefined,mirrored);assert.equal(reply.manifest.settingsChoice,1);await host.prepareSettings(reply.manifest);await host.mergeStreamBundle(reply);
  assert.equal(questions,1);assert.ok(sameSyncSettings(syncSettingsSnapshot(a.storage),expected));assert.ok(sameSyncSettings(syncSettingsSnapshot(b.storage),expected));assert.equal(a.storage.getItem('root-folder-name'),'Laptop');assert.equal(b.storage.getItem('root-folder-name'),'Phone');assert.equal(a.docs.get('b').html,'<h1>b</h1>');assert.equal(b.docs.get('a').html,'<h1>a</h1>');
  assert.equal(a.storage.getItem(choice==='local'?'msuite_tts_voice_en':'msuite_tts_voice_ko'),null);assert.equal(b.storage.getItem(choice==='local'?'msuite_tts_voice_en':'msuite_tts_voice_ko'),null);
 }
});
test('canceling settings selection aborts before any document or settings commit',async()=>{
 const a=fixture([await record('a')]),b=fixture([await record('b')]);storePreferences({theme:'dark'},a.storage);const original=syncSettingsSnapshot(b.storage),receiver=b.adapter({resolveSettings:async()=>null}),bundle=await a.adapter().getStreamBundle();
 await assert.rejects(receiver.prepareSettings(bundle.manifest),{name:'AbortError'});assert.equal(b.calls.length,0);assert.deepEqual([...b.docs.keys()],['b']);assert.ok(sameSyncSettings(syncSettingsSnapshot(b.storage),original));assert.equal(a.calls.length,0);
});
test('either unchecked peer skips settings in both directions while documents still synchronize',async()=>{
 for(const[hostEnabled,joinEnabled]of [[false,true],[true,false],[false,false]]){
  const a=fixture([await record('a')]),b=fixture([await record('b')]);storePreferences({theme:'dark'},a.storage);const left=syncSettingsSnapshot(a.storage),right=syncSettingsSnapshot(b.storage);
  const host=a.adapter({includeSettings:hostEnabled}),join=b.adapter({includeSettings:joinEnabled,isHost:()=>false,resolveSettings:()=>{throw Error('Disabled settings must not ask');}}),bundle=await host.getStreamBundle();
  await join.prepareSettings(bundle.manifest);const mirrored=await join.mergeStreamBundle(bundle),reply=await join.getStreamBundle(undefined,mirrored);assert.equal(reply.manifest.settings,null);await host.mergeStreamBundle(reply);assert.ok(sameSyncSettings(syncSettingsSnapshot(a.storage),left));assert.ok(sameSyncSettings(syncSettingsSnapshot(b.storage),right));assert.equal(a.docs.size,2);assert.equal(b.docs.size,2);
 }
});
test('settings edited during a choice or a closed sync cannot be overwritten by a late decision',async()=>{
 const a=fixture([await record('a')]),b=fixture();storePreferences({theme:'dark'},a.storage);const bundle=await a.adapter().getStreamBundle();
 const receiver=b.adapter({resolveSettings:async()=>{storePreferences({theme:'system'},b.storage);return 'remote';}});await receiver.prepareSettings(bundle.manifest);await assert.rejects(receiver.mergeStreamBundle(bundle),/설정이 바뀌었습니다/);assert.equal(b.calls.length,0);assert.equal(JSON.parse(b.storage.getItem(PREFERENCES_KEY)).theme,'system');
 let active=true,finish;const closed=b.adapter({isActive:()=>active,resolveSettings:()=>new Promise(resolve=>finish=resolve)}),pending=closed.prepareSettings(bundle.manifest);while(!finish)await new Promise(resolve=>setImmediate(resolve));active=false;finish('remote');await assert.rejects(pending,{name:'AbortError'});assert.equal(b.calls.length,0);
});
test('an unrequested settings decision is rejected and storage failure restores the old portable values',async()=>{
 const a=fixture(),b=fixture();storePreferences({theme:'dark'},a.storage);const bundle=await a.adapter().getStreamBundle(),forged={...bundle,manifest:{...bundle.manifest,settingsChoice:1}};await assert.rejects(b.adapter().mergeStreamBundle(forged),/선택을 확인/);assert.equal(b.calls.length,0);
 const original=syncSettingsSnapshot(b.storage),set=b.storage.setItem.bind(b.storage);let failed=false;b.storage.setItem=(key,value)=>{if(key===PREFERENCES_KEY&&!failed){failed=true;throw Error('Fixture quota');}return set(key,value);};await assert.rejects(b.adapter({resolveSettings:async()=>'remote'}).mergeStreamBundle(bundle),/Fixture quota/);assert.ok(sameSyncSettings(syncSettingsSnapshot(b.storage),original));
});
test('current document sharing never carries app settings or triggers a settings question',async()=>{
 const a=fixture([await record('a')]),b=fixture();storePreferences({theme:'dark'},a.storage);const data=await a.adapter().getStreamBundle(['a']);assert.equal(data.manifest.settings,null);const before=syncSettingsSnapshot(b.storage);await b.adapter({resolveSettings:()=>{throw Error('Document sharing must not ask');}}).mergeStreamBundle(data);assert.ok(sameSyncSettings(syncSettingsSnapshot(b.storage),before));assert.equal(b.docs.size,1);
});
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
test('legacy relay packets keep their size bound while metadata-only remains available',async()=>{
 const a=fixture([await record('large',{html:'x'.repeat(900000)})]);await assert.rejects(a.adapter().getBackupData(),/전송 용량/);assert.equal((await a.adapter({includeSources:false}).getBackupData()).documents[0].body,null);
});

test('stream bundles transfer large originals and trash without base64 relay limits or duplicate source bytes',async()=>{
 const blob=new Blob(Array(12).fill(new Uint8Array(1024*1024).fill(65)),{type:'text/html'}),large=await record('large-trash',{trash:true});delete large.html;large.file=blob;large.originalFile=blob;large.sourceIdentity=await localFileIdentity(blob);
 const a=fixture([large],[],'맥북 원본'),b=fixture([],[],'폰의 다른 루트'),bundle=await a.adapter().getStreamBundle();
 assert.equal(bundle.files.size,1);assert.equal(bundle.manifest.files[0].size,12*1024*1024);assert.equal(bundle.manifest.documents[0].body,bundle.manifest.documents[0].original);assert.ok(JSON.stringify(bundle.manifest).length<5000);
 assert.ok(!JSON.stringify(bundle.manifest).includes('맥북 원본'));await b.adapter({isHost:()=>false}).mergeStreamBundle(bundle);
 const received=b.docs.get('large-trash');assert.equal(received.trashedAt,3000);assert.equal(received.file.size,blob.size);assert.equal(received.originalFile.size,blob.size);assert.deepEqual(await localFileIdentity(received.file),large.sourceIdentity);assert.equal(b.storage.getItem('root-folder-name'),'폰의 다른 루트');assert.equal(b.history.get('large-trash').length,1);
 const reply=await b.adapter().getStreamBundle(undefined,['large-trash']);assert.equal(reply.files.size,0);assert.equal(reply.manifest.documents.length,0);
});
test('stream manifest, original digest, missing files and cancellation reject before library changes',async()=>{
 const a=fixture([await record('stream')]),bundle=await a.adapter().getStreamBundle(),b=fixture();
 await assert.rejects(b.adapter().mergeStreamBundle({...bundle,files:new Map()}),/끝나지/);
 const corrupt={...bundle,files:new Map(bundle.files)};corrupt.files.set(1,new Blob(['z'.repeat(bundle.files.get(1).size)],{type:'text/html'}));await assert.rejects(b.adapter().mergeStreamBundle(corrupt),/검증/);
 const invalid=structuredClone(bundle.manifest);invalid.documents[0].body=999;await assert.rejects(b.adapter().mergeStreamBundle({manifest:invalid,files:bundle.files}),/원본 파일/);
 await assert.rejects(b.adapter({isActive:()=>false}).mergeStreamBundle(bundle),/닫았/);assert.equal(b.calls.length,0);
});

test('existing sources are reused across different IDs, filenames and trash without library writes',async()=>{
 const remote=await record('remote'),a=fixture([remote]),bundle=await a.adapter().getStreamBundle();
 const local=await record('phone-copy',{html:remote.html,trash:true});local.name='renamed-on-phone.html';
 const b=fixture([local],[],'Other root'),files=await b.adapter().findReusableStreamFiles(bundle.manifest);
 assert.equal(files.size,bundle.files.size);assert.deepEqual(await localFileIdentity(files.get(1)),bundle.manifest.files[0].identity);
 assert.equal(b.calls.length,0);assert.equal(b.docs.get('phone-copy').trashedAt,3000);
});
test('cached source identity, matching names and matching sizes cannot hide different original bytes',async()=>{
 const a=fixture([await record('same')]),bundle=await a.adapter().getStreamBundle(),changed=await record('same',{html:'x'.repeat(bundle.files.get(1).size)});
 changed.sourceIdentity=bundle.manifest.documents[0].record.sourceIdentity;
 const b=fixture([changed]);assert.equal((await b.adapter().findReusableStreamFiles(bundle.manifest)).size,0);assert.equal(b.calls.length,0);
});
test('reuse includes both a prepared HTML and its unchanged original with the requested MIME types',async()=>{
 const original=new Blob(['<p>original</p>'],{type:'text/html'}),prepared=new Blob(['<head></head><p>original</p>'],{type:'text/html;charset=utf-8'});
 const remote=await record('remote');delete remote.html;remote.file=prepared;remote.originalFile=original;remote.sourceIdentity=await localFileIdentity(original);
 const bundle=await fixture([remote]).adapter().getStreamBundle(),local={...remote,id:'other',file:new Blob([prepared],{type:'text/html'}),originalFile:new Blob([original],{type:'application/octet-stream'})},b=fixture([local]);
 const files=await b.adapter().findReusableStreamFiles(bundle.manifest);assert.equal(files.size,2);
 for(const descriptor of bundle.manifest.files){assert.equal(files.get(descriptor.id).type,descriptor.mime);assert.deepEqual(await localFileIdentity(files.get(descriptor.id)),descriptor.identity);}
});
