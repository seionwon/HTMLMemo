import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {prepareAssets,packageAssets,root} from '../scripts/assets.mjs';
import {pwaEntries} from '../public/src/distribution.js';
import {launchChrome,CDP} from './chrome.mjs';

const saved='document.querySelector("#data-folder-status").textContent==="폴더 저장 완료"';
async function seed(page){
  await page.evaluate(`(async()=>{const s=await import('./src/storage.js'),{parseHTML}=await import('./src/document.js'),p=parseHTML('<html><head><title>Update kept document</title></head><body><h1>Kept document</h1><p>Original text stays.</p></body></html>');p.metadata.annotations=[{id:'kept-note',type:'note',anchor:'body',points:[{x:20,y:20}],text:'Keep this note',color:'#334155',width:3,opacity:1}];p.metadata.bookmarks=[{id:'kept-bookmark',title:'Keep this place',top:120,left:0}];await s.putDocumentRevision({id:'update-kept',name:'kept.html',title:p.metadata.title,html:p.html,created:1000,modified:2000,metadata:p.metadata});})()`);
  await page.waitFor(saved);
}
const data=page=>page.evaluate(`(async()=>{const s=await import('./src/storage.js'),r=await s.getDocument('update-kept');return {id:r.id,html:r.html,metadata:r.metadata,history:(await s.listRevisions(r.id)).length,ids:(await s.listDocuments({includeTrashed:true})).map(r=>r.id).sort(),folder:(await s.getSetting('folder')).name};})()`);
const offered='document.querySelector("#app-update-dialog").open';
const startupOrderProbe=`(()=>{
 window.startupFolderEvents=[];window.startupFolderGets=0;window.startupFolderQueries=0;window.startupFolderRequests=0;
 const get=IDBObjectStore.prototype.get;IDBObjectStore.prototype.get=function(key){if(this.name==='settings'&&key==='folder'){window.startupFolderGets++;window.startupFolderEvents.push('folder-get');}return get.call(this,key);};
 const proto=FileSystemDirectoryHandle.prototype,query=proto.queryPermission,request=proto.requestPermission;
 proto.queryPermission=function(...args){window.startupFolderQueries++;window.startupFolderEvents.push('folder-query');if(sessionStorage.getItem('fixture-folder-prompt')==='yes'&&this.name==='Update order storage')return Promise.resolve('prompt');return query.apply(this,args);};
 proto.requestPermission=function(...args){window.startupFolderRequests++;window.startupFolderEvents.push('folder-request');return request.apply(this,args);};
 const post=ServiceWorker.prototype.postMessage;ServiceWorker.prototype.postMessage=function(message,ports){
  if(message?.type==='HTMLMEMO_UPDATE_INFO'){window.startupFolderEvents.push('update-info');if(sessionStorage.getItem('fixture-hold-update-info')==='yes'){window.releaseStartupUpdateInfo=()=>{sessionStorage.removeItem('fixture-hold-update-info');return post.call(this,message,ports);};return;}}
  if(message?.type==='HTMLMEMO_UPDATE_APPLY'){sessionStorage.setItem('fixture-update-folder-proof',JSON.stringify({gets:window.startupFolderGets,queries:window.startupFolderQueries,requests:window.startupFolderRequests}));if(sessionStorage.getItem('fixture-reject-update-apply')==='yes'){ports[0].postMessage({ok:false,error:'Fixture update apply failure'});return;}}
  return post.call(this,message,ports);
 };
})()`;

function foreground(page){
  const click=page.click.bind(page),navigate=page.navigate.bind(page);
  page.click=async selector=>{await page.send('Page.bringToFront');return click(selector);};
  page.navigate=async url=>{await page.send('Page.bringToFront');return navigate(url);};
}

test('real Chrome: PWA startup updates preserve cancellation across complete closes, save before applying and keep other windows stable',{timeout:150000},async()=>{
  await prepareAssets();const assets=await packageAssets(),releases=new Map();
  for(const version of ['0.0.1','0.0.2','0.0.3']){
    const app={...assets.app,'src/version.js':{text:`export const APP_VERSION = ${JSON.stringify(version)};\n`},'index.html':{text:assets.app['index.html'].text.replace('<html lang="ko">',`<html lang="ko" data-test-release="${version}">`)},'styles.css':{text:assets.app['styles.css'].text+`\n/* release-${version} */`}};
    releases.set(version,new Map(pwaEntries({app}).map(entry=>[entry.name,typeof entry.data==='string'?Buffer.from(entry.data):Buffer.from(entry.data)])));
  }
  let published='0.0.1',broken=false,chrome,other,otherId;
  const types={html:'text/html',js:'text/javascript',css:'text/css',json:'application/json',webmanifest:'application/manifest+json',svg:'image/svg+xml',png:'image/png'};
  const server=createServer((request,response)=>{
    const u=new URL(request.url,'http://app.test'),name=u.pathname==='/app/'?'index.html':u.pathname.slice('/app/'.length),body=releases.get(published).get(name);
    if(!u.pathname.startsWith('/app/')||!body){response.writeHead(404);response.end();return;}
    response.writeHead(200,{'Content-Type':types[name.split('.').at(-1)]||'text/plain','Cache-Control':'no-store'});response.end(broken&&name==='styles.css'?'Wrong CDN asset':body);
  });
  const report={hardwarePWAInstalled:false,simulation:'Real Chrome service workers, versioned app builds, persistent profile, OPFS folder and two windows; standalone media is simulated',layouts:[]};
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}/app/`;chrome=await launchChrome();const {page}=chrome;foreground(page);
    await page.send('Page.addScriptToEvaluateOnNewDocument',{source:`{const native=window.matchMedia.bind(window);window.matchMedia=q=>q==='(display-mode: standalone)'?{matches:true,addEventListener(){},removeEventListener(){}}:native(q);}`});
    await page.navigate(url);await page.waitFor('document.documentElement.dataset.appUpdate==="current"&&!!navigator.serviceWorker.controller');assert.equal(await page.evaluate(offered),false);await seed(page);const before=await data(page);
    const created=await page.send('Target.createTarget',{url:'about:blank'});otherId=created.targetId;
    const list=await fetch('http://'+new URL(page.socket.url).host+'/json/list').then(r=>r.json());other=await CDP.connect(list.find(t=>t.id===otherId).webSocketDebuggerUrl);await other.send('Page.enable');await other.send('Runtime.enable');foreground(other);await other.navigate(url);await other.waitFor('document.documentElement.dataset.appUpdate==="current"');await other.evaluate('window.otherUpdateSentinel=true');
    published='0.0.2';await page.evaluate(`(async()=>{await(await navigator.serviceWorker.getRegistration()).update();})()`);await page.waitFor('(async()=>!!(await navigator.serviceWorker.getRegistration()).waiting)()');
    assert.equal(await page.evaluate(offered),false);assert.equal(await other.evaluate(offered),false);report.noMidSessionPrompt=true;
    await page.navigate(url);await page.waitFor(offered);assert.equal(await page.evaluate('document.documentElement.dataset.testRelease'),'0.0.1');assert.equal(await page.evaluate('document.querySelector("#app-update-title").textContent'),'이 앱의 새 버전이 있습니다. 설치하시겠습니까?');
    await mkdir(root+'/test-results',{recursive:true});
    for(const[width,height]of [[1280,800],[320,568],[390,844],[844,390]]){
      await page.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<600});
      const fit=await page.evaluate(`(()=>{const d=document.querySelector('#app-update-dialog'),r=d.getBoundingClientRect(),b=document.querySelector('#app-update-install'),v=b.getBoundingClientRect();return d.open&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&d.scrollWidth<=d.clientWidth+1&&b.contains(document.elementFromPoint(v.left+v.width/2,v.top+v.height/2));})()`);assert.equal(fit,true);report.layouts.push({width,height,fit});await writeFile(root+`/test-results/pwa-startup-update-${width}.png`,await page.screenshot());
    }
    await page.click('#app-update-cancel');await page.waitFor('document.documentElement.dataset.appUpdate==="deferred"');assert.equal(await page.evaluate('document.documentElement.dataset.testRelease'),'0.0.1');assert.deepEqual(await data(page),before);
    // Cancelling the update releases deferred folder startup. Let both windows
    // finish that startup/save before navigation, rather than stalling on beforeunload.
    report.phase='finish folder startup after cancelling the update';
    await page.waitFor('document.documentElement.dataset.storageSetup==="ready"&&'+saved);
    await other.waitFor('document.documentElement.dataset.storageSetup==="ready"&&'+saved);
    report.phase='close both windows after their saves';
    await other.navigate('about:blank');await page.navigate('about:blank');await new Promise(resolve=>setTimeout(resolve,300));await page.navigate(url);await page.waitFor(offered);assert.equal(await page.evaluate('(async()=>!(await navigator.serviceWorker.getRegistration()).waiting)()'),true);assert.equal(await page.evaluate('document.documentElement.dataset.testRelease'),'0.0.1');report.cancellationSurvivesFullClose=true;
    // Keep a second old window live while the first window accepts the update.
    await other.navigate(url);await other.waitFor(offered);await other.click('#app-update-cancel');await other.waitFor('document.documentElement.dataset.storageSetup==="ready"&&'+saved);await other.evaluate('window.otherUpdateSentinel=true');
    // Folder access is deferred during this startup. Exercise a rejected apply
    // receipt instead, while keeping the stored document edit and explicit retry.
    await page.evaluate(`{const post=ServiceWorker.prototype.postMessage;window.restoreUpdateApply=()=>ServiceWorker.prototype.postMessage=post;ServiceWorker.prototype.postMessage=function(message,ports){if(message?.type==='HTMLMEMO_UPDATE_APPLY'){ports[0].postMessage({ok:false,error:'Fixture update apply failure'});return;}return post.call(this,message,ports);};}`);
    await page.evaluate(`(async()=>{const s=await import('./src/storage.js'),r=await s.getDocument('update-kept');r.metadata.annotations.push({id:'before-update-note',type:'note',anchor:'body',points:[{x:40,y:40}],text:'Save before updating',color:'#334155',width:2,opacity:1});await s.putDocumentRevision(r);})()`);
    await page.click('#app-update-install');await page.waitFor('document.documentElement.dataset.appUpdate==="error"');assert.equal(await page.evaluate(offered),true);assert.equal(await page.evaluate('document.documentElement.dataset.testRelease'),'0.0.1');assert.match(await page.evaluate('document.querySelector("#app-update-status").textContent'),/업데이트 적용을 확인하지 못했습니다/);report.applyFailureKeepsOldVersion=true;
    await page.evaluate('window.restoreUpdateApply()');const withNote=await data(page);await page.click('#app-update-install');await page.waitFor('document.documentElement.dataset.testRelease==="0.0.2"&&document.documentElement.dataset.appUpdate==="current"&&'+saved);assert.deepEqual(await data(page),withNote);
    assert.equal(await other.evaluate('document.documentElement.dataset.testRelease'),'0.0.1');assert.equal(await other.evaluate('window.otherUpdateSentinel'),true);assert.match(await other.evaluate(`fetch('./styles.css').then(r=>r.text())`),/release-0\.0\.1/);report.otherWindowRetainsOldAssets=true;
    // Finish the old window's folder save before leaving, rather than
    // dismissing beforeunload after the newly stored annotation.
    await other.click('#data-folder-status');await other.waitFor('document.querySelector("#resume-data-folder")');await other.click('#resume-data-folder');await other.waitFor('!document.querySelector("#dialog").open&&'+saved);await page.waitFor(saved);
    await other.navigate('about:blank');published='0.0.3';broken=true;await page.navigate(url);await page.waitFor('["current","error"].includes(document.documentElement.dataset.appUpdate)');assert.equal(await page.evaluate(offered),false);assert.equal(await page.evaluate('document.documentElement.dataset.testRelease'),'0.0.2');assert.deepEqual(await data(page),withNote);report.mixedDeploymentRejected=true;
    broken=false;await page.navigate(url);await page.waitFor(offered);for(const type of ['keyDown','keyUp'])await page.send('Input.dispatchKeyEvent',{type,key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await page.waitFor('document.documentElement.dataset.appUpdate==="deferred"');report.escapeCancels=true;
    await page.navigate('about:blank');await new Promise(resolve=>setTimeout(resolve,300));await page.send('Network.enable');await page.send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:-1,uploadThroughput:-1});await page.navigate(url);await page.waitFor(offered);assert.equal(await page.evaluate('document.documentElement.dataset.testRelease'),'0.0.2');await page.click('#app-update-install');await page.waitFor('document.documentElement.dataset.testRelease==="0.0.3"&&document.documentElement.dataset.appUpdate==="current"&&'+saved);assert.deepEqual(await data(page),withNote);report.preparedUpdateInstallsOffline=true;
    assert.deepEqual(chrome.errors,[]);report.originalsNotesBookmarksHistoryAndFolderPreserved=true;report.status='pass';
  }catch(error){report.status='failed';report.error=error.stack;if(chrome){report.errors=chrome.errors;report.state=await chrome.page.evaluate('({release:document.documentElement.dataset.testRelease,update:document.documentElement.dataset.appUpdate,dialog:document.querySelector("#app-update-dialog")?.outerHTML,status:document.querySelector("#status-left")?.textContent})').catch(()=>null);await mkdir(root+'/test-results',{recursive:true});await chrome.page.send('Page.bringToFront').catch(()=>{});const screenshot=await chrome.page.screenshot().catch(()=>null);if(screenshot)await writeFile(root+'/test-results/pwa-startup-update-failure.png',screenshot);}throw error;}
  finally{await mkdir(root+'/test-results',{recursive:true});await writeFile(root+'/test-results/pwa-startup-update.json',JSON.stringify(report,null,2));await other?.close();if(otherId&&chrome)await chrome.page.send('Target.closeTarget',{targetId:otherId}).catch(()=>{});await chrome?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('real Chrome: PWA startup updates install a waiting legacy release and recover a lost reply before activation',{timeout:150000},async()=>{
 await prepareAssets();await mkdir(root+'/test-results',{recursive:true});const assets=await packageAssets(),releases=new Map(),legacyUpdate=await readFile(new URL('./fixtures/updates-1.2.23.js',import.meta.url),'utf8'),legacyWorker=await readFile(new URL('./fixtures/sw-1.2.23.js',import.meta.url),'utf8');
 for(const version of ['1.2.23','1.2.25','1.2.26']){
  let worker=version==='1.2.23'?legacyWorker:assets.app['sw.js'].text;
  if(version==='1.2.26')worker=worker.replace('await self.skipWaiting();','await new Promise(resolve=>setTimeout(resolve,45000));await self.skipWaiting();');
  const app={...assets.app,'sw.js':{text:worker},'src/updates.js':{text:version==='1.2.23'?legacyUpdate:assets.app['src/updates.js'].text},'src/version.js':{text:`export const APP_VERSION = ${JSON.stringify(version)};\n`},'index.html':{text:assets.app['index.html'].text.replace('<html lang="ko">',`<html lang="ko" data-test-release="${version}">`)},'styles.css':{text:assets.app['styles.css'].text+`\n/* legacy-release-${version} */`}};
  releases.set(version,new Map(pwaEntries({app}).map(e=>[e.name,Buffer.from(e.data)])));
 }
 let published='1.2.23',chrome,other,otherId;const report={hardwareMacAndAndroidTested:false,checks:[],injectedFaults:'A single APPLY reply is dropped and the 1.2.26 fixture delays skipWaiting for 45 seconds after persisting selection'};
 const types={html:'text/html',js:'text/javascript',css:'text/css',json:'application/json',webmanifest:'application/manifest+json',svg:'image/svg+xml',png:'image/png'};
 const server=createServer((req,res)=>{const u=new URL(req.url,'http://fixture.test'),name=u.pathname==='/HTMLMemo/'?'index.html':u.pathname.slice(10),body=releases.get(published).get(name);if(!u.pathname.startsWith('/HTMLMemo/')||!body){res.writeHead(404);res.end();return;}res.writeHead(200,{'Content-Type':types[name.split('.').at(-1)]||'text/plain','Cache-Control':'no-store'});res.end(body);});
 try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}/HTMLMemo/`;chrome=await launchChrome();const{page}=chrome;foreground(page);await page.navigate(url);await page.waitFor('document.documentElement.dataset.appUpdate==="current"&&!!navigator.serviceWorker.controller');await seed(page);const before=await data(page);
  const created=await page.send('Target.createTarget',{url:'about:blank'});otherId=created.targetId;const targets=await fetch('http://'+new URL(page.socket.url).host+'/json/list').then(r=>r.json());other=await CDP.connect(targets.find(t=>t.id===otherId).webSocketDebuggerUrl);await other.send('Page.enable');await other.send('Runtime.enable');foreground(other);await other.navigate(url);await other.waitFor('document.documentElement.dataset.appUpdate==="current"');await other.evaluate('window.legacyUpdateSentinel=true');
  published='1.2.25';await page.navigate(url);await page.waitFor(offered);assert.equal(await page.evaluate('document.documentElement.dataset.testRelease'),'1.2.23');assert.equal(await page.evaluate('(async()=> (await navigator.serviceWorker.getRegistration()).waiting?.state)()'),'installed');await page.click('#app-update-install');await page.waitFor('document.documentElement.dataset.testRelease==="1.2.25"&&document.documentElement.dataset.appUpdate==="current"&&'+saved,30000);assert.deepEqual(await data(page),before);assert.equal(await other.evaluate('window.legacyUpdateSentinel'),true);assert.equal(await other.evaluate('document.documentElement.dataset.testRelease'),'1.2.23');assert.match(await other.evaluate("fetch('./styles.css').then(r=>r.text())"),/legacy-release-1\.2\.23/);report.checks.push('The cached 1.2.23 updater installs a waiting 1.2.25 worker without closing either old window, preserving the other window and its old CSS');
  await page.send('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{const post=ServiceWorker.prototype.postMessage;ServiceWorker.prototype.postMessage=function(message,ports){if(message?.type==='HTMLMEMO_UPDATE_APPLY'&&!sessionStorage.getItem('fixture-update-reply-dropped')){const channel=new MessageChannel();window.fixtureDiscardedUpdateReply=channel;channel.port1.onmessage=()=>sessionStorage.setItem('fixture-update-reply-dropped','yes');return post.call(this,message,[channel.port2]);}return post.call(this,message,ports);};})()`});
  published='1.2.26';await page.navigate(url);await page.waitFor(offered);assert.equal(await page.evaluate('(async()=> (await navigator.serviceWorker.getRegistration()).waiting?.state)()'),'installed');await page.click('#app-update-install');await page.waitFor('document.documentElement.dataset.testRelease==="1.2.26"&&document.documentElement.dataset.appUpdate==="current"&&'+saved,40000);assert.equal(await page.evaluate("sessionStorage.getItem('fixture-update-reply-dropped')"),'yes');assert.equal(await page.evaluate('(async()=> (await navigator.serviceWorker.getRegistration()).waiting?.state)()'),'installed');assert.deepEqual(await data(page),before);assert.equal(await other.evaluate('window.legacyUpdateSentinel'),true);report.checks.push('A lost APPLY reply is confirmed by the exact selected build; navigation succeeds while the new worker is still waiting and the other old window remains stable');
  await writeFile(root+'/test-results/pwa-startup-waiting-upgrade.png',await page.screenshot());assert.deepEqual(chrome.errors,[]);report.status='pass';
 }catch(error){report.status='failed';report.error=error.stack;if(chrome){report.state=await chrome.page.evaluate('({release:document.documentElement.dataset.testRelease,update:document.documentElement.dataset.appUpdate,status:document.querySelector("#app-update-status")?.textContent})').catch(()=>null);const screenshot=await chrome.page.screenshot().catch(()=>null);if(screenshot)await writeFile(root+'/test-results/pwa-startup-waiting-failure.png',screenshot);}throw error;}
 finally{await writeFile(root+'/test-results/pwa-startup-waiting-update.json',JSON.stringify(report,null,2));await other?.close();if(otherId&&chrome)await chrome.page.send('Target.closeTarget',{targetId:otherId}).catch(()=>{});await chrome?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('real Chrome: Pages-only PWA updater startup is silent when current and preserves the installed app offline',{timeout:90000},async()=>{
  await prepareAssets();const {createServer:staticServer}=await import('../scripts/server.mjs'),server=staticServer();let chrome;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));chrome=await launchChrome();const{page}=chrome,url=process.env.HTMLMEMO_SIDEBAR_TEST_URL||`http://127.0.0.1:${server.address().port}/`;
    await page.send('Page.addScriptToEvaluateOnNewDocument',{source:startupOrderProbe});
    await page.navigate(url);await page.waitFor('document.documentElement.dataset.appUpdate==="current"&&!!navigator.serviceWorker.controller');assert.equal(await page.evaluate(offered),false);assert.ok(await page.evaluate('startupFolderEvents.indexOf("update-info")>=0&&startupFolderEvents.indexOf("update-info")<startupFolderEvents.indexOf("folder-get")'));await seed(page);const before=await data(page);
    await page.send('Network.enable');await page.send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:-1,uploadThroughput:-1});await page.navigate(url);await page.waitFor('document.documentElement.dataset.appUpdate==="current"&&'+saved);assert.equal(await page.evaluate(offered),false);assert.ok(await page.evaluate('startupFolderEvents.indexOf("update-info")>=0&&startupFolderEvents.indexOf("update-info")<startupFolderEvents.indexOf("folder-get")&&startupFolderEvents.indexOf("update-info")<startupFolderEvents.indexOf("folder-query")'));assert.deepEqual(await data(page),before);assert.deepEqual(chrome.errors,[]);
    await mkdir(root+'/test-results',{recursive:true});await writeFile(root+'/test-results/pages-only-pwa-updater.json',JSON.stringify({url,currentStartupSilent:true,updateBeforeFolderOnColdLaunch:true,updateBeforeFolderOffline:true,offlineReload:true,documentsAndNotesPreserved:true,hardwarePWAInstalled:false,status:'pass'},null,2));
  }finally{await chrome?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('real Chrome: PWA startup updates run before folder permissions on every launch',{timeout:120000},async()=>{
 await prepareAssets();await mkdir(root+'/test-results',{recursive:true});const assets=await packageAssets(),releases=new Map();
 for(const version of ['0.4.1','0.4.2']){
  const app={...assets.app,'src/version.js':{text:`export const APP_VERSION = ${JSON.stringify(version)};\n`},'index.html':{text:assets.app['index.html'].text.replace('<html lang="ko">',`<html lang="ko" data-test-release="${version}">`)},'styles.css':{text:assets.app['styles.css'].text+`\n/* startup-order-${version} */`}};
  releases.set(version,new Map(pwaEntries({app}).map(e=>[e.name,Buffer.from(e.data)])));
 }
 let published='0.4.1',chrome;const report={checks:[],hardwarePWAInstalled:false,status:'failed'},types={html:'text/html',js:'text/javascript',css:'text/css',json:'application/json',webmanifest:'application/manifest+json',svg:'image/svg+xml',png:'image/png'};
 const server=createServer((req,res)=>{const u=new URL(req.url,'http://fixture.test'),name=u.pathname==='/HTMLMemo/'?'index.html':u.pathname.slice(10),body=releases.get(published).get(name);if(!u.pathname.startsWith('/HTMLMemo/')||!body){res.writeHead(404);res.end();return;}res.writeHead(200,{'Content-Type':types[name.split('.').at(-1)]||'text/plain','Cache-Control':'no-store'});res.end(body);});
 try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));chrome=await launchChrome({firstRun:true});const{page}=chrome,url=`http://127.0.0.1:${server.address().port}/HTMLMemo/`;foreground(page);
  await page.send('Page.addScriptToEvaluateOnNewDocument',{source:startupOrderProbe});await page.navigate(url);await page.waitFor('document.documentElement.dataset.appUpdate==="current"&&!!document.querySelector("[data-folder-welcome]")');
  const counts=()=>page.evaluate('({gets:startupFolderGets,queries:startupFolderQueries,requests:startupFolderRequests})');
  const ordered=async()=>assert.ok(await page.evaluate('startupFolderEvents.indexOf("update-info")>=0&&startupFolderEvents.indexOf("update-info")<startupFolderEvents.indexOf("folder-get")'));
  await ordered();assert.equal((await counts()).queries,0);report.checks.push('A current first launch checks the version before reading the stored folder or showing first setup');
  await page.evaluate(`window.showDirectoryPicker=async()=> (await navigator.storage.getDirectory()).getDirectoryHandle('Update order storage',{create:true})`);await page.click('#select-storage-folder');await page.waitFor(saved);await seed(page);const before=await data(page);
  await page.evaluate(`sessionStorage.setItem('fixture-folder-prompt','yes')`);published='0.4.2';await page.evaluate('(async()=>{await(await navigator.serviceWorker.getRegistration()).update();})()');await page.waitFor('(async()=>!!(await navigator.serviceWorker.getRegistration()).waiting)()');
  await page.navigate(url);await page.waitFor(offered);assert.deepEqual(await counts(),{gets:0,queries:0,requests:0});assert.equal(await page.evaluate('!!document.querySelector("[data-folder-welcome]")'),false);assert.equal(await page.evaluate('document.querySelector("#app").inert'),true);
  await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await writeFile(root+'/test-results/pwa-startup-before-folder-offer.png',await page.screenshot());
  await page.click('#app-update-cancel');await page.waitFor('!!document.querySelector("[data-folder-resume]")');await ordered();assert.ok((await counts()).queries>0);assert.equal((await counts()).requests,0);assert.deepEqual(await data(page),before);report.checks.push('Declining an update starts the remembered-folder check only after the update closes and never asks permission automatically');
  await page.click('#cancel-folder-setup');await page.waitFor('document.documentElement.dataset.storageSetup==="paused"');await page.navigate(url);await page.waitFor(offered);assert.deepEqual(await counts(),{gets:0,queries:0,requests:0});
  await page.evaluate(`sessionStorage.setItem('fixture-reject-update-apply','yes')`);await page.click('#app-update-install');await page.waitFor('document.documentElement.dataset.appUpdate==="error"');assert.equal(await page.evaluate(offered),true);assert.deepEqual(await counts(),{gets:0,queries:0,requests:0});assert.equal(await page.evaluate('!!document.querySelector("[data-folder-welcome]")'),false);
  await page.click('#app-update-cancel');await page.waitFor('!!document.querySelector("[data-folder-resume]")');await ordered();assert.equal((await counts()).requests,0);assert.deepEqual(await data(page),before);report.checks.push('A failed apply keeps folder access blocked until retry or cancel is chosen; closing the error continues folder setup');
  await page.click('#cancel-folder-setup');await page.waitFor('document.documentElement.dataset.storageSetup==="paused"');await page.evaluate(`sessionStorage.removeItem('fixture-reject-update-apply')`);await page.navigate(url);await page.waitFor(offered);assert.deepEqual(await counts(),{gets:0,queries:0,requests:0});
  await page.click('#app-update-install');await page.waitFor('document.documentElement.dataset.testRelease==="0.4.2"&&document.documentElement.dataset.appUpdate==="current"&&!!document.querySelector("[data-folder-resume]")',30000);
  assert.deepEqual(await page.evaluate('JSON.parse(sessionStorage.getItem("fixture-update-folder-proof"))'),{gets:0,queries:0,requests:0});await ordered();assert.equal((await counts()).requests,0);assert.deepEqual(await data(page),before);report.checks.push('An update installs without checking or requesting the remembered folder, then the new app checks its version before asking to resume that folder');
  await page.click('#cancel-folder-setup');await page.waitFor('document.documentElement.dataset.storageSetup==="paused"');await page.evaluate(`sessionStorage.setItem('fixture-hold-update-info','yes')`);await page.navigate(url);await page.waitFor('typeof window.releaseStartupUpdateInfo==="function"');
  assert.deepEqual(await counts(),{gets:0,queries:0,requests:0});assert.equal(await page.evaluate('document.querySelector("#app").inert'),true);assert.equal(await page.evaluate('!!document.querySelector("[data-folder-welcome]")'),false);assert.equal(await page.evaluate('document.querySelector("#status-left").textContent'),'새 버전을 확인하는 중…');
  await page.evaluate('window.releaseStartupUpdateInfo()');await page.waitFor('document.documentElement.dataset.appUpdate==="current"&&!!document.querySelector("[data-folder-resume]")');await ordered();report.checks.push('The app remains at the version check while its response is pending, without exposing folder setup or enabled app controls');
  await page.click('#cancel-folder-setup');await page.waitFor('document.documentElement.dataset.storageSetup==="paused"');await page.send('Network.enable');await page.send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:-1,uploadThroughput:-1});await page.navigate(url);await page.waitFor('document.documentElement.dataset.appUpdate==="current"&&!!document.querySelector("[data-folder-resume]")');await ordered();assert.equal((await counts()).requests,0);assert.deepEqual(await data(page),before);report.checks.push('An offline launch uses its prepared update check before folder recovery and preserves documents, notes, bookmarks and history');
  await writeFile(root+'/test-results/pwa-startup-before-folder-resume.png',await page.screenshot());assert.deepEqual(chrome.errors,[]);report.status='pass';
 }catch(error){report.error=error.stack;if(chrome){report.state=await chrome.page.evaluate('({release:document.documentElement.dataset.testRelease,update:document.documentElement.dataset.appUpdate,storage:document.documentElement.dataset.storageSetup,dialog:document.querySelector("#dialog")?.textContent,updateDialog:document.querySelector("#app-update-dialog")?.textContent,events:window.startupFolderEvents})').catch(()=>null);await writeFile(root+'/test-results/pwa-startup-before-folder-failure.png',await chrome.page.screenshot());}throw error;}
 finally{await writeFile(root+'/test-results/pwa-startup-before-folder.json',JSON.stringify(report,null,2)+'\n');await chrome?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
