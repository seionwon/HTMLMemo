import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {createServer} from '../scripts/server.mjs';
import {prepareAssets,root} from '../scripts/assets.mjs';
import {launchChrome,clickSettingsAction} from './chrome.mjs';

test('device sync entry and QR stay compact on the published desktop and phone views', {timeout:90000},async()=>{
 let server,browser;const remote=process.env.HTMLMEMO_SIDEBAR_TEST_URL;
 try{
  let origin=remote;if(!origin){await prepareAssets();server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;}
  browser=await launchChrome();const {page}=browser,relay=[];await page.send('Network.enable');page.on('Network.requestWillBeSent',e=>{if(/ntfy\.sh/.test(e.request.url))relay.push(e.request.url)});
  await page.navigate(origin);await page.waitFor('!!document.querySelector("#settings-button")');
  for(const width of [1280,390,320]){
   await page.send('Emulation.setDeviceMetricsOverride',{width,height:850,deviceScaleFactor:1,mobile:false});await clickSettingsAction(page,'#settings-sync');
   assert.ok(await page.evaluate('document.querySelector("#dialog").open&&document.querySelector("#sync-qr").width>100'));
   assert.ok(await page.evaluate('document.documentElement.scrollWidth<=innerWidth&&document.querySelector("#dialog").scrollWidth<=document.querySelector("#dialog").clientWidth'));
   await mkdir(root+'/test-results',{recursive:true});await writeFile(root+`/test-results/device-sync-${remote?'published':'local'}-${width}.png`,await page.screenshot());await page.click('#dialog [data-dialog-close]');
  }
  await clickSettingsAction(page,'#settings-sync');await page.click('#sync-join-tab');
  await page.evaluate(`window.__cameraStops=0;window.Html5Qrcode=class{start(){return new Promise(resolve=>window.__cameraResolve=resolve)}stop(){window.__cameraStops++;return Promise.resolve()}}`);
  await page.click('#sync-scan');await page.waitFor('!!window.__cameraResolve');await page.click('#sync-host-tab');await page.evaluate('window.__cameraResolve()');await page.waitFor('window.__cameraStops>=2');
  assert.ok(await page.evaluate('document.querySelector("#sync-scanner").hidden'));await page.click('#dialog [data-dialog-close]');
  assert.deepEqual(relay,[]);assert.deepEqual(browser.errors,[]);
 }finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}}
});

// Two separate profiles, real app dialogs/IndexedDB/crypto, deterministic temporary relay.
// No user data or messages are sent to the public ntfy service in CI.
test('device sync exchanges local data and trash across different root folder names', {timeout:180000},async()=>{
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
  await seed(a,'host-book');await seed(a,'host-trash',true);await seed(b,'peer-book');
  const inspect=async device=>device.page.evaluate(`(async()=>{const s=await import('./src/storage.js');const rows=await s.listDocuments({includeTrashed:true});return {root:(await s.getSetting('folder')).name,rows:await Promise.all(rows.map(async r=>({id:r.id,title:r.title,trash:!!r.trashedAt,html:(await s.getDocument(r.id)).html,bookmarks:r.metadata.bookmarks.length,history:(await s.listRevisions(r.id)).length})))}})()`);
  await clickSettingsAction(a.page,'#settings-sync');await clickSettingsAction(b.page,'#settings-sync');
  assert.equal(await a.page.evaluate('window.__relaySockets'),0);check('No relay connection starts during ordinary use or just opening the dialog');
  const code=await a.page.evaluate('document.querySelector("#sync-room").value');
  await a.page.click('#sync-start');await a.page.waitFor('document.querySelector("#sync-status").dataset.state==="ready"');
  await b.page.click('#sync-join-tab');await b.page.evaluate(`document.querySelector('#sync-target').value=${JSON.stringify(code)}`);await b.page.click('#sync-connect');
  await a.page.waitFor('document.querySelector("#sync-status").dataset.state==="completed"',30000);await b.page.waitFor('document.querySelector("#sync-status").dataset.state==="completed"',30000);
  const left=await inspect(a),right=await inspect(b);
  assert.equal(left.root,'Laptop-Archive');assert.equal(right.root,'Phone-Books');assert.deepEqual(left.rows.map(r=>r.id).sort(),['host-book','host-trash','peer-book']);assert.deepEqual(right.rows.map(r=>r.id).sort(),['host-book','host-trash','peer-book']);
  for(const state of [left,right]){const trash=state.rows.find(r=>r.id==='host-trash');assert.ok(trash.trash);assert.ok(trash.html.includes('host-trash'));assert.equal(trash.bookmarks,1);assert.ok(trash.history>0);}
  assert.ok(published.every(text=>!text.includes('Private fixture')&&!text.includes('Laptop-Archive')&&!text.includes('Phone-Books')));
  check('Two-way encrypted transfer preserves every document and trash body/bookmark/history; different root names stay local');
  await a.page.send('Emulation.setDeviceMetricsOverride',{width:320,height:780,deviceScaleFactor:1,mobile:false});
  assert.ok(await a.page.evaluate('document.documentElement.scrollWidth<=innerWidth'));
  await writeFile(root+'/test-results/device-sync-phone.png',await a.page.screenshot());
  await a.page.click('#dialog [data-dialog-close]');await b.page.click('#dialog [data-dialog-close]');assert.equal(await a.page.evaluate('window.__relaySockets'),0);assert.equal(await b.page.evaluate('window.__relaySockets'),0);
  check('320px dialog remains usable; closing releases relay connections');
  await a.page.navigate(origin);await b.page.navigate(origin);assert.deepEqual((await inspect(a)).rows.map(r=>[r.id,r.trash]).sort(),left.rows.map(r=>[r.id,r.trash]).sort());assert.deepEqual((await inspect(b)).rows.map(r=>[r.id,r.trash]).sort(),right.rows.map(r=>[r.id,r.trash]).sort());
  check('Independent reloads preserve synchronized data and trash states');
  await a.page.evaluate(`(async()=>{const s=await import('./src/storage.js');const r=await s.getDocument('host-book');r.metadata.view.scrollTop=555;await s.putDocumentRevision(r);window.__staleSyncRecord=await s.getDocument('host-book');})()`);
  await b.page.evaluate(`(async()=>{const s=await import('./src/storage.js');const r=await s.getDocument('host-book');r.metadata.view.scrollTop=999;await s.putDocumentRevision(r);})()`);
  await clickSettingsAction(a.page,'#settings-sync');await clickSettingsAction(b.page,'#settings-sync');
  const nextCode=await a.page.evaluate('document.querySelector("#sync-room").value');
  const decoded=await a.page.evaluate(`(async()=>{if(!window.Html5Qrcode){const script=document.createElement('script');script.src='./vendor/html5-qrcode.min.js';await new Promise((resolve,reject)=>{script.onload=resolve;script.onerror=reject;document.head.append(script)});}const blob=await new Promise(r=>document.querySelector('#sync-qr').toBlob(r,'image/png'));const box=document.createElement('div');box.id='test-qr-decoder';document.body.append(box);const scanner=new Html5Qrcode(box.id);try{return await scanner.scanFile(new File([blob],'code.png',{type:'image/png'}),false);}finally{scanner.clear();box.remove();}})()`);
  assert.equal(decoded,nextCode);check('The displayed connection QR decodes with the same scanner library as MemoSuite');
  await a.page.click('#sync-start');await a.page.waitFor('document.querySelector("#sync-status").dataset.state==="ready"');await b.page.click('#sync-join-tab');await b.page.evaluate(`document.querySelector('#sync-target').value=${JSON.stringify(nextCode)}`);await b.page.click('#sync-connect');
  await b.page.waitFor('!document.querySelector("#sync-conflict").hidden',30000);await b.page.click('[data-choice="local"]');
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
  await a.page.evaluate('document.querySelector("#sync-scope").value="current";document.querySelector("#sync-scope").dispatchEvent(new Event("change"))');
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
