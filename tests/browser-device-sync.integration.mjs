import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {createServer} from '../scripts/server.mjs';
import {prepareAssets,root} from '../scripts/assets.mjs';
import {launchChrome,clickSettingsAction} from './chrome.mjs';

async function streamFixtureServer(){
 const server=createServer(),serve=server.listeners('request')[0],topics=new Map(),files=new Map(),published=[];server.removeAllListeners('request');
 server.on('request',async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname.startsWith('/test-relay-file/')){res.end(files.get(url.pathname.slice(17))||'');return;}
  if(!url.pathname.startsWith('/test-relay/'))return serve(req,res);
  const topic=url.pathname.slice(12).split('/')[0];if(!topics.has(topic))topics.set(topic,new Set());
  if(req.method==='GET'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});res.write(': ready\n\n');topics.get(topic).add(res);req.on('close',()=>topics.get(topic).delete(res));return;}
  let body='';for await(const chunk of req)body+=chunk;published.push(body);const id=randomUUID();let message={id,event:'message',message:body};
  if(req.method==='PUT'){files.set(id,body);message={...message,attachment:{url:'https://ntfy.sh/file/'+id},tags:String(req.headers.tags||'').split(',')};}
  for(const client of topics.get(topic))client.write('data: '+JSON.stringify(message)+'\n\n');res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(message));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return {server,topics,published,origin:'http://127.0.0.1:'+server.address().port};
}
const streamFixtureSource=`(()=>{
 const nativeFetch=window.fetch.bind(window);window.__relaySockets=0;window.__wireBytes=0;window.__maxFrame=0;window.__sourceWireBytes=0;
 window.fetch=(input,options)=>{const url=new URL(input,location.href);return url.origin==='https://ntfy.sh'?nativeFetch(url.pathname.startsWith('/file/')?'/test-relay-file/'+url.pathname.slice(6):'/test-relay'+url.pathname,options):nativeFetch(input,options);};
 window.WebSocket=class{static OPEN=1;constructor(url){this.readyState=0;window.__relaySockets++;this.events=new EventSource('/test-relay/'+new URL(url).pathname.split('/')[1]);this.events.onopen=()=>{this.readyState=1;this.onopen?.({})};this.events.onmessage=e=>this.onmessage?.(e);this.events.onerror=()=>this.onerror?.({})}send(){}close(){if(this.readyState===3)return;this.readyState=3;window.__relaySockets--;this.events.close();this.onclose?.({code:1000})}};
 const NativePeer=window.RTCPeerConnection;window.__pcs=[];
 const instrument=channel=>{const send=channel.send.bind(channel);let file=0;channel.send=data=>{if(typeof data==='string'){const message=JSON.parse(data);if(message.p==='HTMLMemo.transfer'&&message.type==='file-start')file=message.file.id;}if(data instanceof ArrayBuffer){window.__wireBytes+=data.byteLength;window.__maxFrame=Math.max(window.__maxFrame,data.byteLength);if(file>0)window.__sourceWireBytes+=data.byteLength;}send(data);}};
 window.RTCPeerConnection=class extends NativePeer{constructor(config){super({...config,iceServers:[]});window.__pcs.push(this);this.addEventListener('datachannel',e=>instrument(e.channel))}createDataChannel(...args){const channel=super.createDataChannel(...args);instrument(channel);return channel;}};
})()`;

const largeMiB=Number(process.env.HTMLMEMO_SYNC_LARGE_MIB||64);
if(![64,1024].includes(largeMiB))throw Error('Large transfer check supports 64 or 1024 MiB.');
const publicSyncRelay=process.env.HTMLMEMO_SYNC_PUBLIC_RELAY==='1';
const publicRelaySource=`(()=>{
 const nativeFetch=window.fetch.bind(window),NativeSocket=window.WebSocket;window.__published=[];window.__relaySockets=0;window.__wireBytes=0;window.__maxFrame=0;window.__sourceWireBytes=0;
 window.fetch=(input,options)=>{if(new URL(input,location.href).origin==='https://ntfy.sh'&&typeof options?.body==='string')window.__published.push(options.body);return nativeFetch(input,options)};
 window.WebSocket=class extends NativeSocket{constructor(...args){super(...args);window.__relaySockets++;this.addEventListener('close',()=>window.__relaySockets--,{once:true})}};
`+streamFixtureSource.slice(streamFixtureSource.indexOf(' const NativePeer=')).replace('super({...config,iceServers:[]})','super(config)');

test('device sync streams a '+largeMiB+' MiB live original and propagates sender failures to the phone',{timeout:largeMiB===1024?600000:180000},async()=>{
 await prepareAssets();await mkdir(root+'/test-results',{recursive:true});const fixture=await streamFixtureServer();let a,b;const report={scope:'Native WebRTC data channels between independent Chrome profiles; '+(publicSyncRelay?'public ntfy encrypted signaling':'fixture signaling')+', '+largeMiB+' MiB synthetic original; no user library',checks:[]};
 try{
  a=await launchChrome();b=await launchChrome();
  for(const device of [a,b]){await device.page.send('Page.addScriptToEvaluateOnNewDocument',{source:publicSyncRelay?publicRelaySource:streamFixtureSource});await device.page.navigate(publicSyncRelay&&process.env.HTMLMEMO_SIDEBAR_TEST_URL||fixture.origin);await device.page.waitFor('document.querySelector("#status-left").textContent.includes("개의 문서")');}
  await b.page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  for(const [device,name] of [[a,'MacBook-Large'],[b,'Android-Library']]){await device.page.evaluate(`window.showDirectoryPicker=async()=> (await navigator.storage.getDirectory()).getDirectoryHandle(${JSON.stringify(name)},{create:true})`);await clickSettingsAction(device.page,'#settings-folder');await device.page.click('#select-storage-folder');await device.page.waitFor('document.querySelector("#settings-folder-status")?.textContent.includes('+JSON.stringify(name)+')');await device.page.click('#dialog [data-dialog-close]');}
  for(const device of [a,b])await device.page.evaluate(`(async()=>{const {DeviceSyncService}=await import('./src/sync-device-service.js'),send=DeviceSyncService.prototype.sendSignal;window.__completionRelayCalls=0;DeviceSyncService.prototype.sendSignal=function(message){if(message.kind==='complete'){window.__completionRelayCalls++;throw Error('시험: 완료 시 중계 서비스 사용 불가');}return send.call(this,message);};})()`);
  const expected=await a.page.evaluate(`(async()=>{const s=await import('./src/storage.js'),{localFileIdentity}=await import('./src/local-files.js');const chunk=new Uint8Array(1024*1024).fill(65),file=new Blob(['<!doctype html><html><body><p>PRIVATE-LARGE-ORIGINAL</p><!--',...Array(${largeMiB}).fill(chunk),'--></body></html>'],{type:'text/html'}),identity=await localFileIdentity(file);await s.putDocumentRevision({id:'large-book',title:'큰 책',name:'large.html',file,originalFile:file,sourceIdentity:identity,created:1000,modified:2000,metadata:{version:1,title:'큰 책',source:'',viewport:{width:1100,height:800},view:{scrollTop:789},annotations:[],bookmarks:[{id:'large-mark',title:'남긴 위치',top:789,left:0}],execution:{allowScripts:true}}});return {size:file.size,identity};})()`);
  const inspect=async device=>device.page.evaluate(`(async()=>{const s=await import('./src/storage.js'),{localFileIdentity}=await import('./src/local-files.js'),r=await s.getDocument('large-book');return {root:(await s.getSetting('folder')).name,id:r.id,trash:!!r.trashedAt,size:r.file.size,original:r.originalFile.size,identity:await localFileIdentity(r.file),annotations:r.metadata.annotations,bookmarks:r.metadata.bookmarks,history:(await s.listRevisions(r.id)).length};})()`);
  const open=async()=>{await clickSettingsAction(a.page,'#settings-sync');await clickSettingsAction(b.page,'#settings-sync');const code=await a.page.evaluate('document.querySelector("#sync-room").value');assert.equal(await a.page.evaluate('document.querySelector("#sync-qr").hidden'),true);await a.page.click('#sync-start');await a.page.waitFor('document.querySelector("#sync-status").dataset.state==="ready"');assert.equal(await a.page.evaluate('document.querySelector("#sync-qr").hidden'),false);await b.page.click('#sync-join-tab');return code;};
  const scan=async code=>{await b.page.evaluate(`window.__scanStops=0;window.Html5Qrcode=class{async start(_camera,_options,onResult){window.__scanResult=onResult}async stop(){window.__scanStops++}}`);await b.page.click('#sync-scan');await b.page.waitFor('typeof window.__scanResult==="function"');await b.page.evaluate(`window.__scanResult(${JSON.stringify(code)})`);};
  await scan(await open());await a.page.waitFor('document.querySelector("#sync-status").dataset.state==="completed"',90000);await b.page.waitFor('document.querySelector("#sync-status").dataset.state==="completed"',90000);
  const left=await inspect(a);let right=await inspect(b);assert.equal(right.root,'Android-Library');assert.equal(left.root,'MacBook-Large');assert.equal(right.size,expected.size);assert.equal(right.original,expected.size);assert.deepEqual(right.identity,expected.identity);assert.equal(right.trash,false);assert.equal(right.bookmarks.length,1);assert.ok(right.history>0);
  const stats=await a.page.evaluate('({wire:window.__wireBytes,max:window.__maxFrame})');assert.equal(stats.max,16384);assert.ok(stats.wire>=expected.size&&stats.wire<expected.size+100000);const published=publicSyncRelay?[...await a.page.evaluate('window.__published'),...await b.page.evaluate('window.__published')]:fixture.published;assert.ok(published.every(text=>!text.includes('PRIVATE-LARGE-ORIGINAL')));assert.ok(published.reduce((n,t)=>n+t.length,0)<200000);
  report.bytes=expected.size;report.maxFrame=stats.max;report.relayBytes=published.reduce((n,t)=>n+t.length,0);report.checks.push(largeMiB+' MiB original bytes travel once over native WebRTC, with 16 KiB frames; relay contains encrypted signaling only','Bookmarks, history, source identity and different roots survive');
  if(!publicSyncRelay)await writeFile(root+'/test-results/device-sync-large-phone.png',await b.page.screenshot());
  for(const device of [a,b]){assert.equal(await device.page.evaluate('document.querySelector("#sync-status").textContent'),'전송이 완료되었습니다. 이 화면은 닫아도 됩니다.');assert.doesNotMatch(await device.page.evaluate('document.querySelector("#sync-transfer-detail").textContent'),/undefined|NaN/);assert.equal(await device.page.evaluate('window.__completionRelayCalls'),0);const count=await device.page.evaluate(`(async()=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('HTMLMemo-device-sync-temp-v1');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});try{return await new Promise((resolve,reject)=>{const t=db.transaction('parts','readonly'),r=t.objectStore('parts').count();t.oncomplete=()=>resolve(r.result);t.onerror=()=>reject(t.error)});}finally{db.close();}})()`);assert.equal(count,0);await device.page.click('#sync-close');await device.page.waitFor('!document.querySelector("#dialog").open');}
  const beforeReuse=await Promise.all([a,b].map(device=>device.page.evaluate('window.__sourceWireBytes')));
  for(const device of [a,b])await device.page.evaluate(`(()=>{window.__syncSourcePuts=0;window.__syncHTMLWrites=0;window.__syncSourceReadBytes=0;window.__syncContentReads=0;const read=Blob.prototype.arrayBuffer;Blob.prototype.arrayBuffer=function(...args){if(this.size>=512*1024)window.__syncSourceReadBytes+=this.size;return read.apply(this,args);};const get=IDBObjectStore.prototype.get;IDBObjectStore.prototype.get=function(...args){if(this.name==='contents')window.__syncContentReads++;return get.apply(this,args);};const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){if(this.name==='contents')window.__syncSourcePuts++;return put.apply(this,args);};const writable=FileSystemFileHandle.prototype.createWritable;FileSystemFileHandle.prototype.createWritable=function(...args){if(/\\.(html?|mhtml|mht)$/i.test(this.name))window.__syncHTMLWrites++;return writable.apply(this,args);};})()`);
  await a.page.evaluate(`(async()=>{const s=await import('./src/storage.js'),r=await s.getDocument('large-book');r.metadata.annotations.push({id:'single-new-note',type:'note',text:'첫 동기화 직후 추가한 주석 하나',color:'#edcf67',width:3,opacity:1,points:[{x:20,y:30}]});await s.putDocumentRevision(r);})()`);
  const repeatStarted=Date.now();await scan(await open());
  await b.page.waitFor('!!document.querySelector("#sync-conflict .sync-mark-choices")',30000);await b.page.click('#sync-conflict [data-choice="merge"]');
  await a.page.waitFor('document.querySelector("#sync-status").dataset.state==="completed"',30000);await b.page.waitFor('document.querySelector("#sync-status").dataset.state==="completed"',30000);
  report.singleAnnotationRepeatMs=Date.now()-repeatStarted;
  report.repeatedSourceWork=await Promise.all([a,b].map(device=>device.page.evaluate('({sourceReadBytes:window.__syncSourceReadBytes,contentReads:window.__syncContentReads})')));
  for(const work of report.repeatedSourceWork){assert.equal(work.sourceReadBytes,0,'An unchanged original must not be rehashed during a repeat sync');assert.equal(work.contentReads,0,'An unchanged stored body must not be loaded again during a repeat sync');}
  right=await inspect(b);assert.equal(right.bookmarks.length,1);assert.equal(right.annotations.length,1);assert.equal(right.annotations[0].id,'single-new-note');assert.deepEqual(right.identity,expected.identity);assert.equal(await b.page.evaluate(`(async()=>{const s=await import('./src/storage.js');return(await s.listDocuments({includeTrashed:true})).length;})()`),1);
  report.reusedSourceBytes=[];
  for(const [index,device] of [a,b].entries()){
   assert.equal(await device.page.evaluate('window.__syncSourcePuts'),0,'A one-note sync must retain existing IndexedDB source bodies');assert.equal(await device.page.evaluate('window.__syncHTMLWrites'),0,'A one-note sync must not rewrite HTML files or create safety copies');assert.equal(await device.page.evaluate('document.querySelector("#sync-conflict").hidden'),true);
   const wire=await device.page.evaluate('window.__sourceWireBytes');assert.equal(wire-beforeReuse[index],0);report.reusedSourceBytes.push(wire-beforeReuse[index]);
   assert.match(await device.page.evaluate('document.querySelector("#sync-transfer-detail").textContent'),/전송 생략/);assert.equal(await device.page.evaluate('document.querySelector("#sync-status").textContent'),'전송이 완료되었습니다. 이 화면은 닫아도 됩니다.');assert.equal(await device.page.evaluate('window.__completionRelayCalls'),0);await device.page.click('#sync-close');
  }
  report.checks.push('One new annotation immediately after the first sync asks once for merge, then completes without document copies, original wire bytes, IndexedDB source puts or HTML file writes; original hashes and bookmarks remain unchanged');
  await a.page.evaluate(`(async()=>{const {DeviceSyncAdapter}=await import('./src/sync-adapter.js');window.__backupStream=DeviceSyncAdapter.prototype.getStreamBundle;DeviceSyncAdapter.prototype.getStreamBundle=async()=>{throw Error('시험용 원본 준비 실패')};})()`);
  await scan(await open());await a.page.waitFor('document.querySelector("#sync-status").dataset.state==="error"',30000);await b.page.waitFor('document.querySelector("#sync-status").dataset.state==="error"',30000);assert.match(await b.page.evaluate('document.querySelector("#sync-status").textContent'),/시험용 원본 준비 실패/);assert.deepEqual(await inspect(b),right);report.checks.push('Sender errors appear on the phone; previously synchronized originals remain unchanged');
  await a.page.evaluate(`(async()=>{const {DeviceSyncAdapter}=await import('./src/sync-adapter.js');DeviceSyncAdapter.prototype.getStreamBundle=window.__backupStream;})()`);await a.page.click('#dialog [data-dialog-close]');await b.page.click('#dialog [data-dialog-close]');
  await a.page.evaluate(`(async()=>{const s=await import('./src/storage.js'),r=await s.getDocument('large-book');const {localFileIdentity}=await import('./src/local-files.js');r.id='interrupt-new-file';r.title='중단 검사용 새 원본';r.file=new Blob([r.file.slice(0,80),'B',r.file.slice(81,8*1024*1024),'--></body></html>'],{type:r.file.type});r.originalFile=r.file;r.sourceIdentity=await localFileIdentity(r.file);r.metadata.bookmarks.push({id:'not-committed',title:'중단하면 반영하지 않을 변경',top:999,left:0});await s.putDocumentRevision(r);})()`);
  await b.page.evaluate(`(async()=>{const {SyncTempStore}=await import('./src/sync-temp.js'),append=SyncTempStore.prototype.append;SyncTempStore.prototype.append=async function(...args){await append.apply(this,args);await new Promise(resolve=>setTimeout(resolve,30));};})()`);
  await scan(await open());await b.page.waitFor('document.querySelector("#sync-progress").value>2*1024*1024&&document.querySelector("#sync-progress").value<document.querySelector("#sync-progress").max',30000);await b.page.evaluate('window.__pcs.forEach(pc=>pc.close())');await b.page.waitFor('document.querySelector("#sync-status").dataset.state==="error"',30000);await a.page.waitFor('document.querySelector("#sync-status").dataset.state==="error"',30000);assert.deepEqual(await inspect(b),right);assert.equal(await b.page.evaluate(`(async()=>{const s=await import('./src/storage.js');return !!await s.getDocument('interrupt-new-file');})()`),false);report.checks.push('An interrupted large transfer cannot overwrite the last committed original, bookmarks or trash state');await a.page.click('#dialog [data-dialog-close]');await b.page.click('#dialog [data-dialog-close]');
  await clickSettingsAction(b.page,'#settings-sync');await b.page.click('#sync-join-tab');await b.page.evaluate(`document.querySelector('#sync-target').value='HM-NO-SOURCE-'+crypto.randomUUID()`);await b.page.click('#sync-connect');await b.page.waitFor('document.querySelector("#sync-status").dataset.state==="waiting"');assert.match(await b.page.evaluate('document.querySelector("#sync-status").textContent'),/상대 기기의 응답/);await b.page.click('#dialog [data-dialog-close]');await b.page.waitFor('!document.querySelector("#dialog").open&&window.__relaySockets===0');report.checks.push('Relay-only connection is never labeled as a peer connection, and cancellation closes it');
  assert.deepEqual(a.errors,[]);assert.deepEqual(b.errors,[]);report.status='pass';
 }catch(error){report.status='failed';report.error=error.stack;report.diagnostics=[];for(const device of [a,b])if(device)report.diagnostics.push(await device.page.evaluate('({status:document.querySelector("#sync-status")?.textContent,state:document.querySelector("#sync-status")?.dataset.state,detail:document.querySelector("#sync-transfer-detail")?.textContent,pcs:window.__pcs?.map(p=>({state:p.connectionState,ice:p.iceConnectionState}))})').catch(()=>null));if(b&&!publicSyncRelay)await writeFile(root+'/test-results/device-sync-large-failure.png',await b.page.screenshot());throw error;
 }finally{await writeFile(root+'/test-results/device-sync-large-'+largeMiB+(publicSyncRelay?'-public':'')+'.json',JSON.stringify(report,null,2)+'\n');if(!publicSyncRelay&&largeMiB===64)await writeFile(root+'/test-results/device-sync-large.json',JSON.stringify(report,null,2)+'\n');await a?.close();await b?.close();for(const clients of fixture.topics.values())for(const response of clients)response.end();fixture.server.closeAllConnections();await new Promise(resolve=>fixture.server.close(resolve));}
});

test('device sync reuses separately imported prepared HTML and original files across different document IDs',{timeout:90000},async()=>{
 await prepareAssets();const fixture=await streamFixtureServer();let a,b;const report={checks:[]};
 try{
  a=await launchChrome();b=await launchChrome();
  for(const [index,device] of [a,b].entries()){
   await device.page.send('Page.addScriptToEvaluateOnNewDocument',{source:streamFixtureSource});await device.page.navigate(fixture.origin);
   await device.page.evaluate(`(async()=>{const {readLocalHTML}=await import('./src/local-files.js'),s=await import('./src/storage.js');const raw=new File(['<!doctype html><html><body><p>Same actual source</p><!--',...Array(32).fill(new Uint8Array(1024*1024).fill(65)),'--></body></html>'],${JSON.stringify(index?'renamed-on-phone.html':'original-on-laptop.html')},{type:'text/html'}),local=await readLocalHTML(raw,{native:true,allowScripts:true});await s.putDocumentRevision({id:${JSON.stringify(index?'phone-copy':'laptop-book')},title:${JSON.stringify(index?'폰의 같은 책':'노트북 원본')},name:raw.name,file:local.snapshot.file,originalFile:raw,sourceIdentity:local.sourceIdentity,created:1000,modified:2000,metadata:{version:1,title:'같은 책',source:'',viewport:{width:1000,height:800},view:{scrollTop:0},annotations:[],bookmarks:[{id:'saved-mark',title:'옮길 북마크',top:100,left:0}],execution:{allowScripts:true}}});})()`);
   await clickSettingsAction(device.page,'#settings-sync');
  }
  const code=await a.page.evaluate('document.querySelector("#sync-room").value');await a.page.click('#sync-start');await a.page.waitFor('document.querySelector("#sync-status").dataset.state==="ready"');await b.page.click('#sync-join-tab');await b.page.evaluate(`document.querySelector('#sync-target').value=${JSON.stringify(code)}`);await b.page.click('#sync-connect');
  await b.page.waitFor('!document.querySelector("#sync-conflict").hidden');await b.page.click('[data-choice="remote"]');
  await a.page.waitFor('!document.querySelector("#sync-conflict").hidden');await a.page.click('[data-choice="local"]');
  for(const device of [a,b]){
   await device.page.waitFor('document.querySelector("#sync-status").dataset.state==="completed"');
   assert.equal(await device.page.evaluate('window.__sourceWireBytes'),0);assert.match(await device.page.evaluate('document.querySelector("#sync-transfer-detail").textContent'),/같은 파일 4개/);assert.match(await device.page.evaluate('document.querySelector("#sync-transfer-detail").textContent'),/전송 완료/);assert.doesNotMatch(await device.page.evaluate('document.querySelector("#sync-transfer-detail").textContent'),/undefined|NaN|저장 중/);
   await device.page.click('#sync-close');await device.page.waitFor('!document.querySelector("#dialog").open');
  }
  assert.equal(await b.page.evaluate(`(async()=>{const {getDocument}=await import('./src/storage.js');return (await getDocument('phone-copy')).metadata.bookmarks.length;})()`),1);
  report.checks.push('Independent HTML imports create matching prepared and original blobs despite different IDs and filenames','Both directions send zero original bytes, retain bookmarks and finish with an explicit close action');report.status='pass';assert.deepEqual(a.errors,[]);assert.deepEqual(b.errors,[]);
 }catch(error){report.status='failed';report.error=error.stack;throw error;}
 finally{await mkdir(root+'/test-results',{recursive:true});await writeFile(root+'/test-results/device-sync-reuse-imports.json',JSON.stringify(report,null,2)+'\n');await a?.close();await b?.close();for(const clients of fixture.topics.values())for(const response of clients)response.end();fixture.server.closeAllConnections();await new Promise(resolve=>fixture.server.close(resolve));}
});

test('device sync entry and QR stay compact on the published desktop and phone views', {timeout:90000},async()=>{
 let server,browser;const remote=process.env.HTMLMEMO_SIDEBAR_TEST_URL,optionReport={cases:[],status:'failed'};
 try{
  let origin=remote;if(!origin){await prepareAssets();server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;}
  browser=await launchChrome();const {page}=browser,relay=[];await page.send('Network.enable');page.on('Network.requestWillBeSent',e=>{if(/ntfy\.sh/.test(e.request.url))relay.push(e.request.url)});
  await page.navigate(origin);await page.waitFor('!!document.querySelector("#settings-button")');
  const option=()=>page.evaluate('(()=>{const input=document.querySelector("#sync-settings"),label=document.querySelector("#sync-settings-option");return {checked:input.checked,hidden:label.hidden,disabled:input.disabled,visible:!!label.getClientRects().length};})()');
  for(const width of [1280,390,320]){
   await page.send('Emulation.setDeviceMetricsOverride',{width,height:850,deviceScaleFactor:1,mobile:false});await clickSettingsAction(page,'#settings-sync');
   assert.ok(await page.evaluate('document.querySelector("#dialog").open&&document.querySelector("#sync-qr").width>100'));
   assert.equal(await page.evaluate('document.querySelector("#sync-host-tab").textContent'),'상대가 이 기기로 연결');assert.equal(await page.evaluate('document.querySelector("#sync-settings-option").textContent.trim()'),'앱 설정도 동기화');
   assert.ok(await page.evaluate('document.querySelector(".device-sync>.dialog-description").textContent.includes("휴지통은 동기화하지 않습니다.")'));
   assert.equal(await page.evaluate('document.querySelector("#sync-sources,#sync-scope select")'),null);assert.deepEqual(await page.evaluate('[...document.querySelectorAll("#sync-scope span")].map(e=>e.textContent)'),['서재 전체','현재 문서만 공유']);assert.equal(await page.evaluate('document.querySelectorAll("[name=sync-scope]:checked").length'),1);assert.doesNotMatch(await page.evaluate('document.querySelector("#sync-options").textContent'),/기준 기기|원본 파일 포함|휴지통 포함/);
   assert.ok(await page.evaluate('document.documentElement.scrollWidth<=innerWidth&&document.querySelector("#dialog").scrollWidth<=document.querySelector("#dialog").clientWidth'));
   for(const theme of ['light','dark']){await page.evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);assert.ok(await page.evaluate(`(()=>{const s=getComputedStyle(document.querySelector('#sync-scope input:checked+span')),l=c=>{const v=c.match(/[\\d.]+/g).slice(0,3).map(Number).map(n=>{n/=255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4;});return .2126*v[0]+.7152*v[1]+.0722*v[2];},a=l(s.color),b=l(s.backgroundColor);return(Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5;})()`));}await page.evaluate('document.documentElement.dataset.theme="light"');
   await mkdir(root+'/test-results',{recursive:true});await writeFile(root+`/test-results/device-sync-${remote?'published':'local'}-${width}.png`,await page.screenshot());
   assert.deepEqual(await option(),{checked:true,hidden:false,disabled:false,visible:true});await page.click('#sync-settings');await page.click('#sync-join-tab');assert.deepEqual(await option(),{checked:false,hidden:true,disabled:true,visible:false});
   await writeFile(root+`/test-results/device-sync-settings-join-${remote?'published':'local'}-${width}.png`,await page.screenshot());await page.click('#sync-host-tab');assert.deepEqual(await option(),{checked:false,hidden:false,disabled:false,visible:true});
   await page.click('#dialog [data-dialog-close]');await clickSettingsAction(page,'#settings-sync');assert.equal((await option()).checked,false);await page.click('#dialog [data-dialog-close]');await page.navigate(origin);await clickSettingsAction(page,'#settings-sync');assert.equal((await option()).checked,false);
   await page.click('#sync-settings');await page.click('#sync-join-tab');assert.deepEqual(await option(),{checked:true,hidden:true,disabled:true,visible:false});await page.click('#sync-host-tab');assert.deepEqual(await option(),{checked:true,hidden:false,disabled:false,visible:true});
   await page.click('#dialog [data-dialog-close]');await page.navigate(origin);await clickSettingsAction(page,'#settings-sync');assert.deepEqual(await option(),{checked:true,hidden:false,disabled:false,visible:true});optionReport.cases.push({width,hostOnly:true,defaultChecked:true,roleChangesPreserveChoice:true,reopenUnchecked:true,reloadUnchecked:true,reloadChecked:true});
   await page.evaluate(`(async()=>{const {syncConflictMarkup}=await import('./src/sync-ui.js'),box=document.querySelector('#sync-conflict');box.innerHTML=syncConflictMarkup({type:'annotations',title:'같은 HTML 문서',localContent:'이 기기: 주석 3개 · 북마크 2개',remoteContent:'상대 기기: 주석 4개 · 북마크 1개'},0,1);box.hidden=false;box.scrollIntoView({block:'start'});box.querySelector('[data-choice]').focus();})()`);
   assert.deepEqual(await page.evaluate('[...document.querySelectorAll("#sync-conflict [data-choice]")].map(b=>b.dataset.choice)'),['merge','local','remote','skip']);
   assert.ok(await page.evaluate('document.querySelector("#dialog").scrollWidth<=document.querySelector("#dialog").clientWidth'));
   await writeFile(root+`/test-results/device-sync-annotation-choices-${remote?'published':'local'}-${width}.png`,await page.screenshot());await page.click('#dialog [data-dialog-close]');
  }
  await clickSettingsAction(page,'#settings-sync');await page.click('#sync-join-tab');
  await page.evaluate(`window.__cameraStops=0;window.Html5Qrcode=class{start(){return new Promise(resolve=>window.__cameraResolve=resolve)}stop(){window.__cameraStops++;return Promise.resolve()}}`);
  await page.click('#sync-scan');await page.waitFor('!!window.__cameraResolve');await page.click('#sync-host-tab');await page.evaluate('window.__cameraResolve()');await page.waitFor('window.__cameraStops>=2');
  assert.ok(await page.evaluate('document.querySelector("#sync-scanner").hidden'));await page.click('#dialog [data-dialog-close]');
  assert.deepEqual(relay,[]);assert.deepEqual(browser.errors,[]);optionReport.status='pass';
 }catch(error){optionReport.error=error.stack;throw error;}finally{await mkdir(root+'/test-results',{recursive:true});await writeFile(root+'/test-results/device-sync-settings-option.json',JSON.stringify(optionReport,null,2)+'\n');await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}}
});

test('device sync settings choices apply either peer to both devices or cancel before original transfer',{timeout:180000},async()=>{
 await prepareAssets();await mkdir(root+'/test-results',{recursive:true});const fixture=await streamFixtureServer();let a,b;const report={checks:[],layouts:[],hardwarePhonesTested:false};
 const saved='document.querySelector("#data-folder-status").textContent==="폴더 저장 완료"';
 try{
  a=await launchChrome();b=await launchChrome();
  for(const device of [a,b]){await device.page.send('Page.addScriptToEvaluateOnNewDocument',{source:streamFixtureSource});await device.page.navigate(fixture.origin);}
  const prefs=async(device,theme,width)=>{await device.page.evaluate(`(async()=>{const p=await import('./src/preferences.js');p.storePreferences({theme:${JSON.stringify(theme)},annotation:{width:${width}}},localStorage);window.dispatchEvent(new Event('storage'));})()`);await device.page.waitFor(saved);};
  for(const[device,id]of [[a,'settings-laptop'],[b,'settings-phone']]){
   await device.page.evaluate(`(async()=>{const s=await import('./src/storage.js'),{parseHTML}=await import('./src/document.js'),{localFileIdentity}=await import('./src/local-files.js'),p=parseHTML('<html><head><title>${id}</title></head><body><p>Original ${id}</p></body></html>');p.metadata.bookmarks=[{id:'kept',title:'Kept bookmark',top:120,left:0}];await s.putDocumentRevision({id:${JSON.stringify(id)},title:p.metadata.title,name:'${id}.html',html:p.html,sourceIdentity:await localFileIdentity(new Blob([p.html],{type:'text/html'})),metadata:p.metadata,created:1000,modified:2000});})()`);await device.page.waitFor(saved);
  }
  await prefs(a,'dark',9);await prefs(b,'light',3);
  const inspect=device=>device.page.evaluate(`(async()=>{const s=await import('./src/storage.js'),{syncSettingsSnapshot}=await import('./src/sync-adapter.js');return {root:(await s.getSetting('folder')).name,settings:syncSettingsSnapshot(localStorage),documents:await Promise.all((await s.listDocuments({includeTrashed:true})).map(async h=>{const r=await s.getDocument(h.id);return {id:r.id,html:r.html,metadata:r.metadata,history:(await s.listRevisions(r.id)).length};}))};})()`);
  const connect=async({unchecked=false}={})=>{
   await clickSettingsAction(a.page,'#settings-sync');await clickSettingsAction(b.page,'#settings-sync');if(await a.page.evaluate('document.querySelector("#sync-settings").checked')===unchecked)await a.page.click('#sync-settings');assert.equal(await b.page.evaluate('document.querySelector("#sync-settings").checked'),false);
   const code=await a.page.evaluate('document.querySelector("#sync-room").value');await a.page.click('#sync-start');await a.page.waitFor('document.querySelector("#sync-status").dataset.state==="ready"');await b.page.click('#sync-join-tab');assert.equal(await b.page.evaluate('document.querySelector("#sync-settings-option").hidden'),true);await b.page.evaluate(`document.querySelector('#sync-target').value=${JSON.stringify(code)}`);await b.page.click('#sync-connect');
  };
  const close=async()=>{for(const device of [a,b]){await device.page.click('#dialog [data-dialog-close]');await device.page.waitFor('!document.querySelector("#dialog").open&&window.__relaySockets===0');}};
  const completed=async()=>{for(const device of [a,b])await device.page.waitFor('document.querySelector("#sync-status").dataset.state==="completed"',30000);};
  await clickSettingsAction(b.page,'#settings-sync');assert.equal(await b.page.evaluate('document.querySelector("#sync-settings").checked'),true);await b.page.click('#sync-settings');await b.page.click('#dialog [data-dialog-close]');report.checks.push('The joining device remembers its own unchecked host option');
  const before=await Promise.all([a,b].map(inspect));await connect();await b.page.waitFor('!document.querySelector("#sync-settings-conflict").hidden');
  assert.deepEqual(await Promise.all([a,b].map(inspect)),before);for(const device of [a,b])assert.equal(await device.page.evaluate('window.__sourceWireBytes'),0);
  for(const[width,height]of [[390,844],[320,740],[844,390]]){
   await b.page.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<600});await b.page.evaluate('document.querySelector("#sync-settings-conflict").scrollIntoView({block:"nearest"})');assert.ok(await b.page.evaluate('document.querySelector("#dialog").scrollWidth<=document.querySelector("#dialog").clientWidth'));await writeFile(root+`/test-results/device-sync-settings-choice-${width}.png`,await b.page.screenshot());report.layouts.push({width,height});
  }
  assert.match(await b.page.evaluate('document.querySelector("#sync-settings-conflict").textContent'),/화면 테마/);assert.match(await b.page.evaluate('document.querySelector("#sync-settings-conflict").textContent'),/펜 굵기/);
  await b.page.click('[data-settings-choice="cancel"]');for(const device of [a,b])await device.page.waitFor('document.querySelector("#sync-status").dataset.state==="cancelled"',30000);assert.deepEqual(await Promise.all([a,b].map(inspect)),before);report.checks.push('Cancellation precedes original bytes, document changes and settings changes on both peers');await close();
  await connect();await b.page.waitFor('!document.querySelector("#sync-settings-conflict").hidden');await b.page.click('[data-settings-choice="local"]');await completed();let left=await inspect(a),right=await inspect(b);assert.deepEqual(left.settings,before[1].settings);assert.deepEqual(right.settings,before[1].settings);assert.equal(left.documents.length,2);assert.equal(right.documents.length,2);assert.equal(left.root,before[0].root);assert.equal(right.root,before[1].root);report.checks.push('Choosing this device applies the joining device settings to both peers and preserves documents, history and roots');await close();
  await prefs(a,'dark',5);const desired=(await inspect(a)).settings;await connect();await b.page.waitFor('!document.querySelector("#sync-settings-conflict").hidden');await b.page.click('[data-settings-choice="remote"]');await completed();left=await inspect(a);right=await inspect(b);assert.deepEqual(left.settings,desired);assert.deepEqual(right.settings,desired);report.checks.push('Choosing the QR device settings applies to both peers despite the joining device remembered unchecked option');await close();
  await connect();await completed();for(const device of [a,b])assert.equal(await device.page.evaluate('document.querySelector("#sync-settings-conflict").hidden'),true);report.checks.push('Equal effective settings complete without asking');await close();
  await prefs(b,'light',2);const unchanged=await Promise.all([a,b].map(inspect));await connect({unchecked:true});await completed();assert.deepEqual((await inspect(a)).settings,unchanged[0].settings);assert.deepEqual((await inspect(b)).settings,unchanged[1].settings);report.checks.push('An unchecked QR device keeps each device settings while document synchronization completes');await close();
  for(const device of [a,b]){await clickSettingsAction(device.page,'#settings-sync');assert.equal(await device.page.evaluate('document.querySelector("#sync-settings").checked'),false);}await close();report.checks.push('Settings application never overwrites either device remembered host option');
  assert.deepEqual([...a.errors,...b.errors],[]);assert.ok(fixture.published.every(text=>!text.includes('Original settings-')));report.status='pass';
 }catch(error){report.status='failed';report.error=error.stack;report.state=[];for(const device of [a,b])if(device)report.state.push(await device.page.evaluate('({status:document.querySelector("#sync-status")?.textContent,state:document.querySelector("#sync-status")?.dataset.state,choice:document.querySelector("#sync-settings-conflict")?.textContent,conflict:document.querySelector("#sync-conflict")?.textContent})').catch(()=>null));throw error;}
 finally{await writeFile(root+'/test-results/device-sync-settings.json',JSON.stringify(report,null,2));await a?.close();await b?.close();for(const clients of fixture.topics.values())for(const response of clients)response.end();fixture.server.closeAllConnections();await new Promise(resolve=>fixture.server.close(resolve));}
});

// Two separate profiles, real app dialogs/IndexedDB/crypto, deterministic temporary relay.
// No user data or messages are sent to the public ntfy service in CI.
test('device sync exchanges live documents while keeping each device trash local', {timeout:180000},async()=>{
 await prepareAssets();await mkdir(root+'/test-results',{recursive:true});
 const server=createServer(),serve=server.listeners('request')[0],topics=new Map(),files=new Map(),published=[];
 server.removeAllListeners('request');server.on('request',async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname.startsWith('/test-relay-file/')){res.setHeader('content-type','text/plain');res.end(files.get(url.pathname.slice(17))||'');return;}
  if(!url.pathname.startsWith('/test-relay/'))return serve(req,res);
  const topic=url.pathname.slice(12).split('/')[0];if(!topics.has(topic))topics.set(topic,new Set());
  if(req.method==='GET'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});res.write(': ready\n\n');topics.get(topic).add(res);req.on('close',()=>topics.get(topic).delete(res));return;}
  let body='';for await(const chunk of req)body+=chunk;published.push(body);const id=randomUUID();
  let message={id,event:'message',message:body};
  if(req.method==='PUT'){files.set(id,body);message={...message,attachment:{url:'https://ntfy.sh/file/'+id},tags:String(req.headers.tags||'').split(',')};}
  for(const client of topics.get(topic))client.write('data: '+JSON.stringify(message)+'\n\n');res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(message));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 let a,b;const report={checks:[],errors:[],scope:'Independent device profiles, actual HTMLMemo sync UI and crypto; fixture relay only'};
 const check=name=>{report.checks.push(name);console.log('PASS:',name);};
 try{
  a=await launchChrome();b=await launchChrome();
  for(const device of [a,b]){
   await device.page.send('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{const fetchOriginal=window.fetch.bind(window);window.__relaySockets=0;window.fetch=(input,options)=>{const url=new URL(input,location.href);if(url.origin==='https://ntfy.sh')return fetchOriginal(url.pathname.startsWith('/file/')?'/test-relay-file/'+url.pathname.slice(6):'/test-relay'+url.pathname,options);return fetchOriginal(input,options);};window.WebSocket=class {static OPEN=1;constructor(url){this.readyState=0;window.__relaySockets++;const topic=new URL(url).pathname.split('/')[1];this.events=new EventSource('/test-relay/'+topic);this.events.onopen=()=>{this.readyState=1;this.onopen?.({});};this.events.onmessage=e=>this.onmessage?.(e);this.events.onerror=()=>this.onerror?.({});}send(){}close(){if(this.readyState===3)return;this.readyState=3;window.__relaySockets--;this.events.close();this.onclose?.({code:1000});}};})()`});
   await device.page.navigate(origin);await device.page.waitFor('!!document.querySelector("#settings-button")');
  }
  assert.equal(await a.page.evaluate('window.__relaySockets'),0);assert.equal(await b.page.evaluate('window.__relaySockets'),0);
  for(const [device,name] of [[a,'Laptop-Archive'],[b,'Phone-Books']]){
   await device.page.evaluate(`window.showDirectoryPicker=async()=>{const root=await navigator.storage.getDirectory();return root.getDirectoryHandle(${JSON.stringify(name)},{create:true})}`);
   await clickSettingsAction(device.page,'#settings-folder');await device.page.click('#select-storage-folder');await device.page.waitFor('!!document.querySelector("#settings-folder-status")&&document.querySelector("#settings-folder-status").textContent.includes('+JSON.stringify(name)+')');await device.page.click('#dialog [data-dialog-close]');
  }
  const seed=async(device,id,trashed=false)=>device.page.evaluate(`(async()=>{const store=await import('./src/storage.js'),{localFileIdentity}=await import('./src/local-files.js');const html='<h1>${id}</h1><p>Private fixture text, never plaintext on relay.</p>';const record={id:'${id}',title:'${id}',name:'${id}.html',created:1000,modified:2000,folderId:'',html,sourceIdentity:await localFileIdentity(new Blob([html],{type:'text/html'})),metadata:{version:1,title:'${id}',source:'',viewport:{width:1000,height:800},view:{scrollTop:321},annotations:[],bookmarks:[{id:'mark-${id}',title:'북마크',top:12,left:0}],execution:{allowScripts:false}}};await store.putDocumentRevision(record);${trashed?`await store.trashDocument('${id}');`:''}return true;})()`);
  await seed(a,'host-book');await seed(a,'host-trash',true);await seed(b,'peer-book');await seed(b,'peer-trash',true);await seed(a,'protected-book');await seed(b,'protected-book',true);
  const inspect=async device=>device.page.evaluate(`(async()=>{const s=await import('./src/storage.js');const rows=await s.listDocuments({includeTrashed:true});return {root:(await s.getSetting('folder')).name,rows:await Promise.all(rows.map(async r=>({id:r.id,title:r.title,trash:!!r.trashedAt,html:(await s.getDocument(r.id)).html,bookmarks:r.metadata.bookmarks.length,history:(await s.listRevisions(r.id)).length})))}})()`);
  const initialLocalTrash=await Promise.all([a,b].map(async device=>(await inspect(device)).rows.filter(r=>r.trash)));
  await clickSettingsAction(a.page,'#settings-sync');await clickSettingsAction(b.page,'#settings-sync');
  assert.equal(await a.page.evaluate('window.__relaySockets'),0);assert.equal(await a.page.evaluate('document.querySelector("#sync-qr").hidden'),true);check('No relay connection starts during ordinary use or just opening the dialog');
  const code=await a.page.evaluate('document.querySelector("#sync-room").value');
  await a.page.click('#sync-start');await a.page.waitFor('document.querySelector("#sync-status").dataset.state==="ready"');assert.equal(await a.page.evaluate('document.querySelector("#sync-qr").hidden'),false);assert.equal(await a.page.evaluate('document.querySelector("#sync-room").readOnly'),true);
  await b.page.click('#sync-join-tab');await b.page.evaluate(`document.querySelector('#sync-target').value=${JSON.stringify(code)}`);await b.page.click('#sync-connect');
  await a.page.waitFor('document.querySelector("#sync-status").dataset.state==="completed"',30000);await b.page.waitFor('document.querySelector("#sync-status").dataset.state==="completed"',30000);
  const left=await inspect(a),right=await inspect(b);
  assert.equal(left.root,'Laptop-Archive');assert.equal(right.root,'Phone-Books');assert.deepEqual(left.rows.map(r=>r.id).sort(),['host-book','host-trash','peer-book','protected-book']);assert.deepEqual(right.rows.map(r=>r.id).sort(),['host-book','peer-book','peer-trash','protected-book']);
  assert.deepEqual(left.rows.filter(r=>r.trash),initialLocalTrash[0]);assert.deepEqual(right.rows.filter(r=>r.trash),initialLocalTrash[1]);assert.equal(left.rows.find(r=>r.id==='protected-book').trash,false);assert.equal(right.rows.find(r=>r.id==='protected-book').trash,true);
  assert.ok(published.every(text=>!text.includes('Private fixture')&&!text.includes('Laptop-Archive')&&!text.includes('Phone-Books')));
  check('Two-way transfer includes live documents only; both local trash collections and their bookmarks/history remain unchanged, and an active peer cannot restore a local trash copy');
  await a.page.send('Emulation.setDeviceMetricsOverride',{width:320,height:780,deviceScaleFactor:1,mobile:false});
  assert.ok(await a.page.evaluate('document.documentElement.scrollWidth<=innerWidth'));
  await writeFile(root+'/test-results/device-sync-phone.png',await a.page.screenshot());
  await a.page.click('#dialog [data-dialog-close]');await b.page.click('#dialog [data-dialog-close]');assert.equal(await a.page.evaluate('window.__relaySockets'),0);assert.equal(await b.page.evaluate('window.__relaySockets'),0);
  check('320px dialog remains usable; closing releases relay connections');
  await a.page.navigate(origin);await b.page.navigate(origin);assert.deepEqual((await inspect(a)).rows.map(r=>[r.id,r.trash]).sort(),left.rows.map(r=>[r.id,r.trash]).sort());assert.deepEqual((await inspect(b)).rows.map(r=>[r.id,r.trash]).sort(),right.rows.map(r=>[r.id,r.trash]).sort());
  check('Independent reloads preserve live synchronization and each device local trash');
  await a.page.evaluate(`(async()=>{const s=await import('./src/storage.js');const r=await s.getDocument('host-book');r.metadata.view.scrollTop=555;await s.putDocumentRevision(r);window.__staleSyncRecord=await s.getDocument('host-book');})()`);
  await b.page.evaluate(`(async()=>{const s=await import('./src/storage.js');const r=await s.getDocument('host-book');r.metadata.view.scrollTop=999;await s.putDocumentRevision(r);})()`);
  await clickSettingsAction(a.page,'#settings-sync');await clickSettingsAction(b.page,'#settings-sync');
  const nextCode=await a.page.evaluate('document.querySelector("#sync-room").value');
  const decoded=await a.page.evaluate(`(async()=>{if(!window.Html5Qrcode){const script=document.createElement('script');script.src='./vendor/html5-qrcode.min.js';await new Promise((resolve,reject)=>{script.onload=resolve;script.onerror=reject;document.head.append(script)});}const blob=await new Promise(r=>document.querySelector('#sync-qr').toBlob(r,'image/png'));const box=document.createElement('div');box.id='test-qr-decoder';document.body.append(box);const scanner=new Html5Qrcode(box.id);try{return await scanner.scanFile(new File([blob],'code.png',{type:'image/png'}),false);}finally{scanner.clear();box.remove();}})()`);
  assert.equal(decoded,nextCode);check('The displayed connection QR decodes with the same scanner library as MemoSuite');
  await a.page.click('#sync-start');await a.page.waitFor('document.querySelector("#sync-status").dataset.state==="ready"');await b.page.click('#sync-join-tab');await b.page.evaluate(`document.querySelector('#sync-target').value=${JSON.stringify(nextCode)}`);await b.page.click('#sync-connect');
  await b.page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await b.page.waitFor('!document.querySelector("#sync-conflict").hidden',30000);assert.equal(await b.page.evaluate('document.querySelector("#sync-status").dataset.state'),'conflict');assert.match(await b.page.evaluate('document.querySelector("#sync-transfer-detail").textContent'),/선택을 기다리는 중/);assert.ok(await b.page.evaluate('(()=>{const r=document.querySelector("#sync-conflict [data-choice]").getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;})()'));await writeFile(root+'/test-results/device-sync-conflict-phone.png',await b.page.screenshot());await b.page.click('[data-choice="local"]');
  await a.page.waitFor('!document.querySelector("#sync-conflict").hidden',30000);await a.page.click('[data-choice="remote"]');
  await a.page.waitFor('document.querySelector("#sync-status").dataset.state==="completed"',30000);await b.page.waitFor('document.querySelector("#sync-status").dataset.state==="completed"',30000);
  assert.equal(await a.page.evaluate(`(async()=>{const s=await import('./src/storage.js');return (await s.getDocument('host-book')).metadata.view.scrollTop})()`),999);
  assert.ok((await inspect(a)).rows.some(r=>r.title.includes('동기화 전 보관본')));check('Actual conflict buttons preserve the chosen version and a safety copy of the entire prior document');
  const atomic=await a.page.evaluate(`(async()=>{const s=await import('./src/storage.js'),r=await s.getDocument('host-book'),library=await s.readLibrary();try{await s.commitDeviceSync([{record:{...r,title:'Must not save'},content:{html:'MUST NOT REPLACE'},revisions:[],expected:'stale'}],library.folders,library.folders);return false;}catch{return (await s.getDocument('host-book')).html===r.html;}})()`);assert.equal(atomic,true);check('Stale writes abort the actual IndexedDB transaction without replacing the original');
  assert.equal(await a.page.evaluate(`(async()=>{const s=await import('./src/storage.js');try{await s.putDocumentRevision(window.__staleSyncRecord,{mustExist:true});return false;}catch{return (await s.getDocument('host-book')).metadata.view.scrollTop===999;}})()`),true);check('A stale reader cannot overwrite a version received through device sync');
  await a.page.click('#dialog [data-dialog-close]');await b.page.click('#dialog [data-dialog-close]');
  await seed(b,'peer-only-after-full');await a.page.waitFor('!!document.querySelector(\'[data-open="host-book"]\')');await a.page.click('[data-open="host-book"]');await a.page.waitFor('!!document.querySelector(".document-host:not([hidden]) iframe")');
  await clickSettingsAction(a.page,'#settings-sync');await clickSettingsAction(b.page,'#settings-sync');
  const shareCode=await a.page.evaluate('document.querySelector("#sync-room").value');
  await a.page.click('#sync-scope label:has([value="current"])');
  await a.page.click('#sync-start');await a.page.waitFor('document.querySelector("#sync-status").dataset.state==="ready"');await b.page.click('#sync-join-tab');await b.page.evaluate(`document.querySelector('#sync-target').value=${JSON.stringify(shareCode)}`);await b.page.click('#sync-connect');
  await b.page.waitFor('!document.querySelector("#sync-conflict").hidden||document.querySelector("#sync-status").dataset.state==="completed"',30000);
  if(await b.page.evaluate('!document.querySelector("#sync-conflict").hidden'))await b.page.click('[data-choice="both"]');
  await b.page.waitFor('document.querySelector("#sync-status").dataset.state==="completed"',30000);
  assert.ok(!(await inspect(a)).rows.some(row=>row.id==='peer-only-after-full'));await a.page.click('#dialog [data-dialog-close]');await b.page.click('#dialog [data-dialog-close]');
  await a.page.waitFor('!!document.querySelector(".document-host:not([hidden]) iframe")');
  check('Current-document sharing is one-way and closing sync restores the previously open reader');
  report.errors=[...a.errors,...b.errors];assert.deepEqual(report.errors,[]);report.status='pass';
 }catch(error){report.status='failed';report.error=error.stack;report.diagnostics=[];for(const device of [a,b])if(device)report.diagnostics.push(await device.page.evaluate("({status:document.querySelector('#sync-status')?.textContent,state:document.querySelector('#sync-status')?.dataset.state,conflict:document.querySelector('#sync-conflict')?.textContent})").catch(()=>null));if(a)await writeFile(root+'/test-results/device-sync-failure.png',await a.page.screenshot().catch(()=>Buffer.alloc(0)));throw error;}
 finally{await writeFile(root+'/test-results/device-sync.json',JSON.stringify(report,null,2)+'\n');await a?.close();await b?.close();for(const clients of topics.values())for(const res of clients)res.end();server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('device sync annotation choices merge, replace or skip both devices once including current-document replies',{timeout:180000},async()=>{
 await prepareAssets();await mkdir(root+'/test-results',{recursive:true});const fixture=await streamFixtureServer();let a,b;const report={scope:'Independent Chrome profiles, actual UI, WebRTC, IndexedDB and OPFS; synthetic documents and fixture signaling',checks:[],cases:[]};
 try{
  a=await launchChrome();b=await launchChrome();
  for(const device of [a,b]){await device.page.send('Page.addScriptToEvaluateOnNewDocument',{source:streamFixtureSource});await device.page.navigate(fixture.origin);await device.page.waitFor('document.querySelector("#status-left").textContent.includes("개의 문서")');}
  const seed=async(device,index,label)=>device.page.evaluate(`(async()=>{
   const s=await import('./src/storage.js'),{localFileIdentity}=await import('./src/local-files.js'),old=await s.getDocument('choice-book'),html='<h1>Choice book</h1><p>Same immutable original for both devices.</p>';
   const note=(id,text)=>({id,type:'note',text,anchor:'body',points:[{x:20,y:30}],color:'#445566',width:2,opacity:1,created:1});
   await s.putDocumentRevision({...old,id:'choice-book',title:${JSON.stringify(index?'폰의 책':'맥의 책')},name:${JSON.stringify(index?'phone.html':'mac.html')},html,sourceIdentity:await localFileIdentity(new Blob([html],{type:'text/html'})),created:1000,modified:Date.now(),folderId:'',metadata:{version:1,title:'Choice book',source:'',viewport:{width:1000,height:800},view:{scrollTop:${index?222:111}},annotations:[note('common','Same note'),note('edited',${JSON.stringify(label+' '+(index?'phone edit':'mac edit'))}),note(${JSON.stringify(index?'phone-note':'mac-note')},${JSON.stringify(index?'Phone unique':'Mac unique')})],bookmarks:[{id:'common-mark',title:'Same bookmark',top:10,left:0},{id:'edited-mark',title:${JSON.stringify(index?'Phone bookmark':'Mac bookmark')},top:20,left:0}],execution:{allowScripts:false}}});
   if(!await s.getDocument(${JSON.stringify(index?'peer-only':'host-only')})){const id=${JSON.stringify(index?'peer-only':'host-only')},html='<p>'+id+'</p>';await s.putDocumentRevision({id,title:id,name:id+'.html',html,sourceIdentity:await localFileIdentity(new Blob([html],{type:'text/html'})),created:1000,modified:2000,metadata:{version:1,title:id,source:'',viewport:{width:1000,height:800},view:{scrollTop:0},annotations:[],bookmarks:[],execution:{allowScripts:false}}});}
  })()`);
  const inspect=async device=>device.page.evaluate(`(async()=>{const s=await import('./src/storage.js'),r=await s.getDocument('choice-book');return {title:r.title,name:r.name,html:r.html,source:r.sourceIdentity,metadata:r.metadata,history:(await s.listRevisions(r.id)).map(v=>({kind:v.kind,annotations:v.annotations,bookmarks:v.bookmarks})),ids:(await s.listDocuments({includeTrashed:true})).map(d=>d.id).sort()};})()`);
  for(const partial of [true,false])for(const choice of ['merge','local','remote','skip']){
   for(const [index,device]of [a,b].entries())await seed(device,index,`${partial?'partial':'full'}-${choice}`);
   if(partial){await a.page.waitFor('!!document.querySelector(\'[data-open="choice-book"]\')');await a.page.click('[data-open="choice-book"]');await a.page.waitFor('document.querySelector(".document-host:not([hidden]) iframe")?.contentDocument?.title==="맥의 책"||document.querySelector(".document-host:not([hidden]) iframe")?.contentDocument?.body.textContent.includes("Same immutable original")');}
   if(partial)await a.page.waitFor('document.querySelector("#status-left").textContent.includes("자동 저장됨")');
   const before=await Promise.all([a,b].map(inspect));
   await clickSettingsAction(a.page,'#settings-sync');await clickSettingsAction(b.page,'#settings-sync');
   if(partial)await a.page.click('#sync-scope label:has([value="current"])');
   const code=await a.page.evaluate('document.querySelector("#sync-room").value');await a.page.click('#sync-start');await a.page.waitFor('document.querySelector("#sync-status").dataset.state==="ready"');await b.page.click('#sync-join-tab');await b.page.evaluate(`document.querySelector('#sync-target').value=${JSON.stringify(code)}`);await b.page.click('#sync-connect');
   await b.page.waitFor('!!document.querySelector("#sync-conflict .sync-mark-choices")',30000);
   assert.deepEqual(await b.page.evaluate('[...document.querySelectorAll("#sync-conflict [data-choice]")].map(b=>b.dataset.choice)'),['merge','local','remote','skip']);
   assert.equal(await a.page.evaluate('document.querySelector("#sync-status").dataset.state==="completed"'),false);
   if(partial&&choice==='merge'){
    for(const width of [390,320]){await b.page.send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:true});await b.page.evaluate('document.querySelector("#sync-conflict").scrollIntoView({block:"start"})');assert.ok(await b.page.evaluate('document.querySelector("#dialog").scrollWidth<=document.querySelector("#dialog").clientWidth'));await writeFile(root+`/test-results/device-sync-annotation-choices-live-${width}.png`,await b.page.screenshot());}
   }
   await b.page.click('#sync-conflict [data-choice="'+choice+'"]');
   for(const device of [a,b])await device.page.waitFor('document.querySelector("#sync-status").dataset.state==="completed"',30000);
   const after=await Promise.all([a,b].map(inspect));
   for(const [index,state]of after.entries()){
    assert.equal(state.title,before[index].title);assert.equal(state.name,before[index].name);assert.equal(state.html,before[index].html);assert.deepEqual(state.source,before[index].source);
    const marks=state.metadata,expected=choice==='skip'?before[index].metadata:choice==='local'?before[1].metadata:choice==='remote'?before[0].metadata:null;
    if(expected){assert.deepEqual(marks.annotations,expected.annotations);assert.deepEqual(marks.bookmarks,expected.bookmarks);}else{assert.equal(marks.annotations.length,5);assert.equal(new Set(marks.annotations.map(n=>n.id)).size,5);assert.equal(marks.bookmarks.length,3);assert.equal(new Set(marks.bookmarks.map(n=>n.id)).size,3);}
    if(choice==='skip')assert.deepEqual(state.history,before[index].history);
    assert.ok(!state.ids.some(id=>id!=='choice-book'&&id!=='host-only'&&id!=='peer-only'));
    if(partial)assert.deepEqual(state.ids,before[index].ids);else assert.deepEqual(state.ids,['choice-book','host-only','peer-only']);
   }
   if(choice!=='skip'){assert.deepEqual(after[0].metadata.annotations,after[1].metadata.annotations);assert.deepEqual(after[0].metadata.bookmarks,after[1].metadata.bookmarks);}
   report.cases.push({partial,choice,questions:1,annotations:after.map(r=>r.metadata.annotations.length),bookmarks:after.map(r=>r.metadata.bookmarks.length)});
   for(const device of [a,b]){assert.equal(await device.page.evaluate('document.querySelector("#sync-conflict").hidden'),true);await device.page.click('#sync-close');await device.page.waitFor('!document.querySelector("#dialog").open');}
   if(partial){await a.page.waitFor('!!document.querySelector(".tab.document.active .tab-close")&&document.querySelector("#status-left").textContent.includes("자동 저장됨")');await a.page.click('.tab.document.active .tab-close');await a.page.waitFor('!document.querySelector(".tab.document")');}
  }
  report.checks.push('All four choices apply once to both independent devices','Merging deduplicates common annotations and bookmarks and retains both edits of a shared ID','Local and remote replace only annotations and bookmarks while document identities and originals remain intact','Skip preserves each device annotations and history','Current-document replies contain only the chosen document and both completion states wait for the reply commit','Full synchronization still exchanges unrelated library documents');report.status='pass';assert.deepEqual(a.errors,[]);assert.deepEqual(b.errors,[]);
 }catch(error){report.status='failed';report.error=error.stack;report.state=[];for(const device of [a,b])if(device){report.state.push(await device.page.evaluate('({status:document.querySelector("#sync-status")?.textContent,state:document.querySelector("#sync-status")?.dataset.state,choice:document.querySelector("#sync-conflict")?.textContent})').catch(()=>null));}if(b)await writeFile(root+'/test-results/device-sync-annotation-choices-failure.png',await b.page.screenshot().catch(()=>Buffer.alloc(0)));throw error;}
 finally{await writeFile(root+'/test-results/device-sync-annotation-choices.json',JSON.stringify(report,null,2)+'\n');await a?.close();await b?.close();for(const clients of fixture.topics.values())for(const response of clients)response.end();fixture.server.closeAllConnections();await new Promise(resolve=>fixture.server.close(resolve));}
});

test('device sync connection recovery rebuilds failed pre-transfer peers once and preserves originals',{timeout:120000},async()=>{
 await prepareAssets();await mkdir(root+'/test-results',{recursive:true});const fixture=await streamFixtureServer();let a,b;const report={cases:[],hardwarePhonesTested:false,status:'failed'};
 try{
  a=await launchChrome();b=await launchChrome();
  for(const [index,device] of [a,b].entries()){
   await device.page.send('Page.addScriptToEvaluateOnNewDocument',{source:streamFixtureSource});await device.page.navigate(fixture.origin);
   await device.page.evaluate(`(async()=>{const {DeviceSyncService}=await import('./src/sync-device-service.js'),send=DeviceSyncService.prototype.sendSignal;window.__recoverySignals=[];DeviceSyncService.prototype.sendSignal=function(message){window.__recoverySignals.push({kind:message.kind,attempt:message.attempt??0});if(window.__dropInitial&&['offer','candidates'].includes(message.kind)&&(message.attempt??0)===0)return Promise.resolve();return send.call(this,message);};const s=await import('./src/storage.js'),{parseHTML}=await import('./src/document.js'),p=parseHTML('<!doctype html><html><head><title>Recovery ${index}</title></head><body><p>Original recovery document ${index}</p></body></html>');p.metadata.annotations=[{id:'kept-note-${index}',type:'note',text:'Kept recovery note ${index}',color:'#edcf67',width:3,opacity:1,points:[{x:20,y:30}],created:1}];p.metadata.bookmarks=[{id:'kept-bookmark-${index}',title:'Kept bookmark',top:20,left:0}];await s.putDocumentRevision({id:'recovery-${index}',name:'recovery-${index}.html',title:p.metadata.title,html:p.html,sourceIdentity:await(await import('./src/local-files.js')).localFileIdentity(new Blob([p.html],{type:'text/html'})),metadata:p.metadata,created:1000,modified:2000});})()`);
   await device.page.waitFor('document.querySelector("#data-folder-status").textContent==="폴더 저장 완료"');
  }
  const inspect=device=>device.page.evaluate(`(async()=>{const s=await import('./src/storage.js');return Promise.all((await s.listDocuments()).sort((a,b)=>a.id.localeCompare(b.id)).map(async d=>{const r=await s.getDocument(d.id);return {id:r.id,html:r.html,annotations:r.metadata.annotations,bookmarks:r.metadata.bookmarks};}));})()`);
  for(const failedSide of ['phone','host']){
   const before=await Promise.all([a,b].map(inspect)),starts=[];
   for(const device of [a,b]){
    starts.push(await device.page.evaluate('window.__pcs.length'));await device.page.evaluate('window.__dropInitial=true;window.__recoverySignals=[];window.__wireBytes=0;window.__sourceWireBytes=0');await clickSettingsAction(device.page,'#settings-sync');
    await device.page.evaluate(`window.__recoveryStatuses=[];new MutationObserver(()=>window.__recoveryStatuses.push(document.querySelector('#sync-status').textContent)).observe(document.querySelector('#sync-status'),{childList:true,subtree:true,characterData:true});`);
   }
   const code=await a.page.evaluate('document.querySelector("#sync-room").value');await a.page.click('#sync-start');await a.page.waitFor('document.querySelector("#sync-status").dataset.state==="ready"');await b.page.click('#sync-join-tab');await b.page.evaluate('document.querySelector("#sync-target").value='+JSON.stringify(code));await b.page.click('#sync-connect');
   for(const [index,device] of [a,b].entries())await device.page.waitFor('window.__pcs.length==='+String(starts[index]+1));
   assert.deepEqual(await Promise.all([a,b].map(inspect)),before);for(const device of [a,b])assert.equal(await device.page.evaluate('window.__wireBytes'),0);
   const failed=failedSide==='phone'?b:a,failedStart=starts[failedSide==='phone'?1:0];await failed.page.evaluate(`(()=>{const pc=window.__pcs[${failedStart}];Object.defineProperty(pc,'connectionState',{configurable:true,get:()=> 'failed'});pc.dispatchEvent(new Event('connectionstatechange'));})()`);
   for(const device of [a,b])await device.page.waitFor('document.querySelector("#sync-status").dataset.state==="completed"',30000);
   const actual=await Promise.all([a,b].map(inspect));assert.deepEqual(actual[0],actual[1]);assert.equal(actual[0].length,2);for(const doc of actual[0]){assert.ok(doc.html.includes('Original recovery document'));assert.equal(doc.annotations.length,1);assert.equal(doc.bookmarks.length,1);}
   const peers=[];
   for(const [index,device] of [a,b].entries()){
    const state=await device.page.evaluate(`({count:window.__pcs.length-${starts[index]},oldClosed:window.__pcs[${starts[index]}].signalingState==='closed',retries:window.__recoveryStatuses.filter(s=>s.includes('연결 경로를 다시 확인')).length,signals:window.__recoverySignals})`);assert.equal(state.count,2);assert.equal(state.oldClosed,true);assert.ok(state.retries>0);assert.ok(state.signals.some(s=>s.attempt===1));peers.push({freshPeers:state.count,oldClosed:state.oldClosed,retryShown:state.retries>0});
   }
   report.cases.push({failedSide,preTransferBytes:0,peers,documents:2,annotationsAndBookmarksPreserved:true,completedBoth:true});
   await writeFile(root+`/test-results/device-sync-recovery-${failedSide}.png`,await b.page.screenshot());for(const device of [a,b]){await device.page.click('#dialog [data-dialog-close]');await device.page.waitFor('!document.querySelector("#dialog").open&&window.__relaySockets===0');}
  }
  assert.deepEqual([...a.errors,...b.errors],[]);report.status='pass';
 }catch(error){report.error=error.stack;report.state=[];for(const device of [a,b])if(device)report.state.push(await device.page.evaluate('({status:document.querySelector("#sync-status")?.textContent,state:document.querySelector("#sync-status")?.dataset.state,conflict:document.querySelector("#sync-conflict")?.textContent,signals:window.__recoverySignals,pcs:window.__pcs?.map(pc=>({state:pc.connectionState,signaling:pc.signalingState}))})').catch(()=>null));throw error;}
 finally{await writeFile(root+'/test-results/device-sync-connection-recovery.json',JSON.stringify(report,null,2)+'\n');await a?.close();await b?.close();for(const clients of fixture.topics.values())for(const response of clients)response.end();fixture.server.closeAllConnections();await new Promise(resolve=>fixture.server.close(resolve));}
});
