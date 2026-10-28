import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer as createHTTPServer} from 'node:http';
import {mkdtemp,cp,rm,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {root,prepareAssets} from '../scripts/assets.mjs';
import {createServer} from '../scripts/server.mjs';
import {launchChrome} from './chrome.mjs';

const phoneAPIs=`
  window.startupIssues=[];
  addEventListener('error',e=>startupIssues.push(e.error?.stack||e.message));
  addEventListener('unhandledrejection',e=>startupIssues.push(e.reason?.stack||String(e.reason)));
  window.phonePickerCalls=0;
  window.showDirectoryPicker=async()=>{window.phonePickerCalls++;throw new DOMException('Cancelled','AbortError');};
  Object.defineProperty(window,'launchQueue',{configurable:true,value:null});
`;
const androidUA='Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
const ready='document.querySelector("#status-left")?.textContent.includes("개의 문서")';

test('real Chrome: Pages-only two-finger scrolling cancels ink and annotation drags without changing saved marks',{timeout:180000},async()=>{
  await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'htmlmemo-two-finger-'));await cp(join(root,'public'),folder,{recursive:true});const server=createServer(folder);let chrome;
  const report={cases:[],hardwareMacAndAndroidTested:false,input:'Chrome CDP touch and trackpad-style wheel events in an isolated profile'};
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));chrome=await launchChrome();const {page}=chrome,url=process.env.HTMLMEMO_SIDEBAR_TEST_URL||`http://127.0.0.1:${server.address().port}/`;
    await page.send('Emulation.setUserAgentOverride',{userAgent:androidUA,platform:'Android'});
    await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    await page.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:3});await page.navigate(url);await page.waitFor(ready);
    const frame='document.querySelector(".document-host:not([hidden]) iframe.document-frame")',doc=frame+'.contentDocument',viewport='document.querySelector(".document-host:not([hidden]) .reader-viewport")';
    const settled=`${frame}?.style.visibility==='visible'&&!document.querySelector('.tab-dirty:not([hidden])')`;
    const send=(type,points=[])=>page.send('Input.dispatchTouchEvent',{type,touchPoints:points.map((p,i)=>({id:i+1,radiusX:2,radiusY:2,force:1,...p}))});
    const snapshot=id=>page.evaluate(`(async()=>JSON.stringify((await(await import('./src/storage.js')).getDocument(${JSON.stringify(id)})).metadata.annotations))()`);
    const tool=async name=>{await page.click('#toolbar [data-action='+name+']');if(await page.evaluate('!document.querySelector("#tool-popover").hidden'))await page.click('[data-popover-close]');};
    const scroll=()=>page.evaluate(`(()=>{const d=${doc};return {root:d.scrollingElement.scrollTop,inner:d.querySelector('main').scrollTop,outer:${viewport}.scrollTop};})()`);
    const reset=async()=>{await page.evaluate(`(()=>{const d=${doc};for(const node of [d.scrollingElement,d.querySelector('main'),${viewport}])node.scrollTo({top:0,left:0,behavior:'instant'});})()`);await page.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');};
    const point=()=>page.evaluate(`(()=>{const f=${frame},r=f.getBoundingClientRect();return {x:Math.max(90,r.left+100),y:Math.max(r.top+150,Math.min(r.bottom-180,390))};})()`);
    const pan=async(p,{preview=false}={})=>{
      await send('touchStart',[p]);
      if(preview)await send('touchMove',[{x:p.x+8,y:p.y}]);
      const first={x:p.x+(preview?8:0),y:p.y},second={x:first.x+65,y:first.y};
      await send('touchStart',[first,second]);
      for(let step=1;step<=6;step++)await send('touchMove',[{x:first.x,y:first.y-step*12},{x:second.x,y:second.y-step*12}]);
      await send('touchEnd',[{x:first.x,y:first.y-72}]);
      await send('touchMove',[{x:first.x+15,y:first.y-90}]);await send('touchEnd');
      await page.waitFor(`${doc}.querySelector('[data-htmlmemo-preview],[data-htmlmemo-drag-source]')===null`);
    };
    for(const mode of ['static','root','inner']){
      const id='two-finger-'+mode;
      await page.evaluate(`(async()=>{
        const {parseHTML}=await import('./src/document.js'),{putDocumentRevision}=await import('./src/storage.js');
        const mode=${JSON.stringify(mode)},html='<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Two finger '+mode+'</title><style>html,body{margin:0;font:18px/1.6 system-ui;scroll-behavior:smooth}main{padding:22px;box-sizing:border-box;scroll-behavior:smooth}article{min-height:3000px}p{margin:0 0 100px}'+(mode==='inner'?'html,body{height:100%;overflow:hidden}main{height:100%;overflow:auto}':'')+'</style></head><body><main><article><h1>Two finger '+mode+'</h1>'+Array.from({length:24},(_,i)=>'<p>Reading paragraph '+i+'. Scroll without changing your annotations.</p>').join('')+'</article></main></body></html>';
        const parsed=parseHTML(html,{viewport:{width:390,height:844}},{allowScripts:mode!=='static'});await putDocumentRevision({id:${JSON.stringify(id)},title:parsed.metadata.title,name:${JSON.stringify(id+'.html')},kind:'import',html:parsed.html,nativeScroll:parsed.nativeScroll,metadata:parsed.metadata});document.querySelector('#library-tab').click();
      })()`);
      await page.waitFor('document.querySelector("[data-open='+id+']")');await page.click('[data-open='+id+']');await page.waitFor(settled);
      await tool('pen');await reset();let p=await point();
      // A normal single-finger stroke still creates one mark.
      await send('touchStart',[p]);await send('touchMove',[{x:p.x+28,y:p.y+5}]);await send('touchEnd');
      await page.waitFor(`(async()=>(await(await import('./src/storage.js')).getDocument(${JSON.stringify(id)})).metadata.annotations.length===1)()`);await page.waitFor(settled);
      const saved=await snapshot(id),before=await scroll();await pan(p,{preview:true});
      await page.waitFor(`(()=>{const d=${doc};return Math.max(d.scrollingElement.scrollTop,d.querySelector('main').scrollTop,${viewport}.scrollTop)>50;})()`);const after=await scroll();assert.equal(await snapshot(id),saved,'scrolling must not commit unfinished ink');
      await tool('select');await reset();
      const markPoint=()=>page.evaluate(`(()=>{const f=${frame},d=f.contentDocument,n=d.querySelector('[data-htmlmemo-hit]'),r=n.getBoundingClientRect(),b=f.getBoundingClientRect(),s=b.width/f.offsetWidth;return {x:b.left+(r.left+r.width/2)*s,y:b.top+(r.top+r.height/2)*s};})()`);
      p=await markPoint();await pan(p,{preview:true});assert.equal(await snapshot(id),saved,'a second finger cancels the annotation move');
      const movedScroll=await scroll();assert.ok(Math.max(...Object.values(movedScroll))>50);assert.equal(await page.evaluate('document.querySelector("#dialog").open'),false);
      await tool('eraser');await reset();p=await markPoint();await pan(p);assert.equal(await snapshot(id),saved,'two-finger scrolling cannot erase the initial mark');
      await tool('pen');await reset();p=await point();await send('touchStart',[p]);await send('touchMove',[{x:p.x+26,y:p.y+6}]);await send('touchEnd');
      await page.waitFor(`(async()=>(await(await import('./src/storage.js')).getDocument(${JSON.stringify(id)})).metadata.annotations.length===2)()`);
      // A cancel event clears the gesture and leaves saved annotations intact.
      await page.waitFor(settled);const beforeCancel=await snapshot(id);await send('touchStart',[p,{x:p.x+65,y:p.y}]);await send('touchCancel');assert.equal(await snapshot(id),beforeCancel);
      await reset();await page.send('Emulation.setTouchEmulationEnabled',{enabled:false});await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
      p=await point();for(let n=0;n<8;n++)await page.send('Input.dispatchMouseEvent',{type:'mouseWheel',...p,deltaX:.25,deltaY:12});
      const wheel=await scroll();assert.ok(Math.max(...Object.values(wheel))>=90,'a burst of small wheel deltas must not repeatedly restart smooth scrolling');
      const unchanged=await snapshot(id);assert.equal(unchanged,beforeCancel);await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,`test-results/pages-only-two-finger-${mode}-1280.png`),await page.screenshot());
      await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await page.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:3});
      await writeFile(join(root,`test-results/pages-only-two-finger-${mode}-390.png`),await page.screenshot());
      report.cases.push({mode,before,after,annotationDragScroll:movedScroll,wheel,savedMarksPreserved:true,singleFingerDrawingResumes:true,touchCancel:true});
      await page.waitFor(settled);await page.click('.tab.document.active .tab-close');await page.waitFor('!document.querySelector(".tab.document")');
    }
    assert.deepEqual(chrome.errors,[]);report.status='pass';report.errors=chrome.errors;
  }catch(error){report.status='failed';report.error=error.stack;if(chrome){report.errors=chrome.errors;report.state=await chrome.page.evaluate('({dialog:document.querySelector("#dialog")?.textContent,toast:document.querySelector("#toast")?.textContent,status:document.querySelector("#status-left")?.textContent})').catch(()=>null);await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/pages-only-two-finger-failure.png'),await chrome.page.screenshot());}throw error;}
  finally{await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/pages-only-two-finger.json'),JSON.stringify(report,null,2));await chrome?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});
async function phone(page){
  await page.send('Emulation.setUserAgentOverride',{userAgent:androidUA,platform:'Android'});
  await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await page.send('Page.addScriptToEvaluateOnNewDocument',{source:phoneAPIs});
}
async function dialogFits(page){
  assert.equal(await page.evaluate(`(()=>{const d=document.querySelector('#dialog'),r=d.getBoundingClientRect();return d.open&&r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1&&d.scrollWidth<=d.clientWidth+1;})()`),true);
}
async function pausedSetup(page){
  await page.waitFor('document.documentElement.dataset.storageSetup==="paused"&&!document.querySelector("#dialog").open');
  assert.deepEqual(await page.evaluate(`(()=>{const b=document.querySelector('#folder-setup-resume'),r=b.getBoundingClientRect();return {appHidden:document.querySelector('#app').hidden,waiting:!document.querySelector('#folder-setup-paused').hidden,focused:document.activeElement===b,inside:r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight,reachable:b.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))};})()`),{appHidden:true,waiting:true,focused:true,inside:true,reachable:true});
}

test('real Chrome: cold startup waits for a streamed document before binding UI',{timeout:60000},async()=>{
  await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'htmlmemo-cold-shell-'));await cp(join(root,'public'),folder,{recursive:true});
  const staticServer=createServer(folder),html=await readFile(join(folder,'index.html'),'utf8');let pending,releaseTimer,chrome;
  const early=html.replace('<script type="module" src="./src/app.js"></script>',`<script>import('./src/app.js').then(()=>{window.entryReadyState=document.readyState;return fetch('./release-shell')})</script>`),split=early.indexOf('<body>');
  const server=createHTTPServer((request,response)=>{
    if(request.url==='/early.html'){
      response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});response.write(early.slice(0,split));pending=response;
      releaseTimer=setTimeout(()=>{if(pending){pending.end(early.slice(split));pending=null;}},10000);
    }else if(request.url==='/release-shell'){
      clearTimeout(releaseTimer);pending?.end(early.slice(split));pending=null;response.writeHead(200);response.end('ready');
    }else staticServer.emit('request',request,response);
  });
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));chrome=await launchChrome({firstRun:true});const {page}=chrome;await phone(page);
    await page.navigate(`http://127.0.0.1:${server.address().port}/early.html`);await page.waitFor(ready);
    assert.equal(await page.evaluate('window.entryReadyState'),'loading','the actual entry evaluated before its controls were parsed');
    assert.deepEqual(await page.evaluate('window.startupIssues'),[]);assert.deepEqual(chrome.errors,[]);
    assert.ok(await page.evaluate('document.querySelector("[data-folder-welcome]")'));
    await page.evaluate(`window.showDirectoryPicker=async()=> (await navigator.storage.getDirectory()).getDirectoryHandle('Cold startup storage',{create:true})`);await page.click('#select-storage-folder');await page.waitFor('!document.querySelector("#dialog").open');await page.click('#settings-button');await page.waitFor('document.querySelector("#settings-sync")');
    await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/pages-only-cold-shell.json'),JSON.stringify({entryEvaluatedBeforeDOM:true,libraryReady:true,settingsBound:true,errors:chrome.errors},null,2));
  }finally{clearTimeout(releaseTimer);pending?.end();await chrome?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});

test('real Chrome: Pages-only Android first-run folder welcome is error-free and fits phone screens',{timeout:90000},async()=>{
  await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'htmlmemo-android-welcome-'));await cp(join(root,'public'),folder,{recursive:true});const server=createServer(folder);let chrome;
  const report={simulation:'Android user agent and touch viewports in dedicated desktop Chrome; an explicit folder picker stub and a null optional launchQueue',layouts:[]};
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));chrome=await launchChrome({firstRun:true});const {page}=chrome;await phone(page);
    const url=process.env.HTMLMEMO_SIDEBAR_TEST_URL||`http://127.0.0.1:${server.address().port}/`;await page.navigate(url);await page.waitFor(ready);await page.waitFor('document.querySelector("[data-folder-welcome]")');
    await page.evaluate('navigator.serviceWorker.ready.then(()=>true)');
    assert.equal(await page.evaluate('window.phonePickerCalls'),0,'opening the app does not prompt for a folder');
    assert.equal(await page.evaluate('document.querySelector("#toast.error:not([hidden])")'),null,'no raw startup error after offline preparation');
    await mkdir(join(root,'test-results'),{recursive:true});
    for(const [width,height] of [[320,740],[390,844],[430,932],[844,390]]){
      await page.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true});await dialogFits(page);report.layouts.push({width,height,welcome:true});
      const button=await page.evaluate(`(()=>{const b=document.querySelector('#select-storage-folder');b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect();return {inside:r.left>=0&&r.right<=innerWidth,reachable:b.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))};})()`);assert.deepEqual(button,{inside:true,reachable:true});
      await page.evaluate('document.querySelector("#dialog").scrollTop=0');await writeFile(join(root,`test-results/pages-only-android-first-run-${width}.png`),await page.screenshot());
    }
    await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    await page.click('#select-storage-folder');await page.waitFor('!document.querySelector("#select-storage-folder").disabled&&document.querySelector("#folder-connection-status").textContent.includes("취소")');assert.equal(await page.evaluate('window.phonePickerCalls'),1);
    await page.evaluate(`window.showDirectoryPicker=async()=>{throw new DOMException('Denied','NotAllowedError')}`);await page.click('#select-storage-folder');await page.waitFor('document.querySelector("#folder-connection-status").textContent.includes("쓰기를 허용")');
    assert.equal(await page.evaluate('document.querySelector("#toast.error:not([hidden])")'),null);report.cancelAndPermissionHandled=true;
    assert.equal(await page.evaluate('document.querySelector("#folder-welcome-later")'),null);assert.ok(await page.evaluate('document.querySelector("#cancel-folder-setup")'));
    const historyBefore=await page.send('Page.getNavigationHistory');
    for(const type of ['keyDown','keyUp'])await page.send('Input.dispatchKeyEvent',{type,key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await pausedSetup(page);assert.equal(await page.evaluate(`(async()=> (await import('./src/storage.js')).getSetting('folder'))()`),undefined);report.escapeCancelsWithoutReopening=true;
    for(const [width,height] of [[320,568],[390,844],[844,390]]){
      await page.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true});await pausedSetup(page);await writeFile(join(root,`test-results/pages-only-android-folder-cancel-${width}.png`),await page.screenshot());
    }
    await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    await page.click('#folder-setup-resume');await page.waitFor('document.querySelector("#dialog").open');await page.evaluate(`document.querySelector('#dialog').requestClose()`);await pausedSetup(page);report.nativeBackCloseRequestAllowed=true;
    await page.click('#folder-setup-resume');await page.waitFor('document.querySelector("#dialog").open');await page.click('#cancel-folder-setup');await pausedSetup(page);report.explicitCancelWorks=true;
    await page.click('#folder-setup-resume');await page.waitFor('document.querySelector("#dialog").open');await page.click('[aria-label="저장 폴더 연결 취소"]');await pausedSetup(page);report.closeButtonWorks=true;
    const historyAfter=await page.send('Page.getNavigationHistory');assert.equal(historyAfter.entries.length,historyBefore.entries.length);assert.equal(historyAfter.currentIndex,historyBefore.currentIndex);report.noHistoryTrap=true;
    const previous=historyAfter.entries[historyAfter.currentIndex-1];assert.ok(previous);await page.send('Page.navigateToHistoryEntry',{entryId:previous.id});await page.waitFor(`location.href===${JSON.stringify(previous.url)}`);report.browserBackLeavesApp=true;
    await page.navigate(url);await page.waitFor('document.querySelector("#dialog").open&&document.querySelector("[data-folder-welcome]")');await page.evaluate('navigator.serviceWorker.ready.then(()=>true)');
    assert.equal(await page.evaluate('document.querySelector("#toast.error:not([hidden])")'),null);assert.deepEqual(await page.evaluate('window.startupIssues'),[]);assert.deepEqual(chrome.errors,[]);report.repeatVisitAlsoErrorFree=true;report.status='pass';
  }catch(error){report.status='failed';report.error=error.stack;if(chrome){report.browserErrors=chrome.errors;report.state=await chrome.page.evaluate('({status:document.querySelector("#status-left")?.textContent,dialog:document.querySelector("#dialog")?.textContent,toast:document.querySelector("#toast")?.textContent,errors:window.startupIssues})').catch(()=>null);await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/pages-only-android-first-run-failure.png'),await chrome.page.screenshot());}throw error;
  }finally{await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/pages-only-android-first-run.json'),JSON.stringify(report,null,2)+'\n');await chrome?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});

test('real Chrome: Pages-only Android saved folder resumes across launches without repeating first setup',{timeout:120000},async()=>{
  await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'htmlmemo-phone-folder-resume-'));await cp(join(root,'public'),folder,{recursive:true});const server=createServer(folder);let chrome;
  const report={simulation:'Android user agent and touch viewports in desktop Chrome; controlled permission states on a real OPFS directory stored in IndexedDB',hardwareAndroidTested:false,externalPermissionDialogTested:false,layouts:[],reopens:0};
  const folderName='Phone resume storage',grantKey='test-phone-folder-grant',denyKey='test-phone-folder-deny';
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));chrome=await launchChrome({firstRun:true});const {page}=chrome;await phone(page);
    await page.send('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{
      window.folderResumeRequests=0;window.folderResumeActivations=[];
      const proto=FileSystemDirectoryHandle.prototype,nativeQuery=proto.queryPermission,nativeRequest=proto.requestPermission;
      Object.defineProperty(proto,'queryPermission',{configurable:true,value:async function(options){return this.name===${JSON.stringify(folderName)}?(localStorage.getItem(${JSON.stringify(grantKey)})==='granted'?'granted':'prompt'):nativeQuery.call(this,options);}});
      Object.defineProperty(proto,'requestPermission',{configurable:true,value:async function(options){
        if(this.name!==${JSON.stringify(folderName)})return nativeRequest.call(this,options);
        window.folderResumeRequests++;window.folderResumeActivations.push(navigator.userActivation.isActive);
        if(localStorage.getItem(${JSON.stringify(denyKey)})==='1')return 'denied';
        localStorage.setItem(${JSON.stringify(grantKey)},'granted');return 'granted';
      }});
    })()`});
    const url=process.env.HTMLMEMO_SIDEBAR_TEST_URL||`http://127.0.0.1:${server.address().port}/`;await page.navigate(url);await page.waitFor('document.querySelector("#create-storage-folder")');
    assert.equal(await page.evaluate('!!document.querySelector("[data-folder-resume]")'),false);
    await page.evaluate(`window.showDirectoryPicker=async()=>{window.phonePickerCalls++;localStorage.setItem(${JSON.stringify(grantKey)},'granted');return(await navigator.storage.getDirectory()).getDirectoryHandle(${JSON.stringify(folderName)},{create:true});}`);
    await page.click('#select-storage-folder');await page.waitFor('document.documentElement.dataset.storageSetup==="ready"');
    assert.equal(await page.evaluate('window.phonePickerCalls'),1);assert.equal(await page.evaluate('window.folderResumeRequests'),0);
    await page.evaluate(`(async()=>{const {parseHTML}=await import('./src/document.js'),{putDocumentRevision}=await import('./src/storage.js'),p=parseHTML('<html><head><title>Phone kept book</title></head><body><p>Original phone document.</p></body></html>');p.metadata.annotations=[{id:'phone-kept-note',type:'note',anchor:'body',points:[{x:.1,y:.2}],text:'Keep this note',color:'#334155',width:3,opacity:1}];p.metadata.bookmarks=[{id:'phone-kept-mark',title:'Keep this place',top:120,left:0}];await putDocumentRevision({id:'phone-kept-book',title:p.metadata.title,name:'received-phone-book.html',created:1000,modified:2000,html:p.html,metadata:p.metadata});})()`);
    const saved=`document.querySelector('#data-folder-status').textContent==='폴더 저장 완료'`;
    const manifest=()=>page.evaluate(`(async()=>{const d=await(await navigator.storage.getDirectory()).getDirectoryHandle(${JSON.stringify(folderName)});return(await(await d.getFileHandle('HTMLMemo-library.json')).getFile()).text();})()`);
    await page.waitFor(`(async()=>{if(!(${saved}))return false;const d=await(await navigator.storage.getDirectory()).getDirectoryHandle(${JSON.stringify(folderName)});return JSON.parse(await(await(await d.getFileHandle('HTMLMemo-library.json')).getFile()).text()).documents.some(r=>r.id==='phone-kept-book');})()`);
    const state=()=>page.evaluate(`(async()=>{const s=await import('./src/storage.js'),r=await s.getDocument('phone-kept-book');return {id:r.id,html:r.html,metadata:r.metadata,revisions:(await s.listRevisions(r.id)).length,documents:(await s.listDocuments({includeTrashed:true})).map(d=>d.id).sort()};})()`),before=await state(),diskBefore=await manifest();
    await page.evaluate(`localStorage.setItem(${JSON.stringify(grantKey)},'prompt')`);await page.navigate(url);await page.waitFor('document.querySelector("[data-folder-resume]")');
    assert.equal(await page.evaluate('document.querySelector("#dialog h2").textContent'),'저장 폴더 연결 확인');
    assert.equal(await page.evaluate('document.querySelector("#create-storage-folder,#storage-folder-name")'),null);assert.equal(await page.evaluate('document.activeElement.id'),'resume-data-folder');
    assert.equal(await page.evaluate('window.phonePickerCalls+window.folderResumeRequests'),0);assert.equal(await page.evaluate('document.querySelector("#toast.error:not([hidden])")'),null);
    await page.click('#cancel-folder-setup');await pausedSetup(page);assert.deepEqual(await state(),before);assert.equal(await manifest(),diskBefore);assert.equal(await page.evaluate('window.phonePickerCalls+window.folderResumeRequests'),0);report.cancelPreservesData=true;
    await page.click('#folder-setup-resume');await page.waitFor('document.querySelector("#dialog").open&&document.querySelector("[data-folder-resume]")');assert.equal(await page.evaluate('document.querySelector("#create-storage-folder,#storage-folder-name")'),null);
    await mkdir(join(root,'test-results'),{recursive:true});
    for(const [width,height] of [[320,568],[390,844],[844,390]]){
      await page.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true});await dialogFits(page);
      await page.evaluate(`document.querySelector('#resume-data-folder').scrollIntoView({block:'center'})`);
      assert.equal(await page.evaluate(`(()=>{const b=document.querySelector('#resume-data-folder'),r=b.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&b.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));})()`),true);
      await page.evaluate('document.querySelector("#dialog").scrollTop=0');await writeFile(join(root,`test-results/pages-only-android-folder-resume-${width}.png`),await page.screenshot());report.layouts.push({width,height,reachable:true});
    }
    await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    await page.evaluate(`localStorage.setItem(${JSON.stringify(denyKey)},'1')`);await page.click('#resume-data-folder');await page.waitFor('!document.querySelector("#resume-data-folder").disabled&&document.querySelector("#folder-connection-status").textContent.includes("쓰기를 허용")');
    assert.equal(await page.evaluate('document.documentElement.dataset.storageSetup'),'required');assert.equal(await page.evaluate('window.phonePickerCalls'),0);assert.equal(await page.evaluate('window.folderResumeRequests'),1);assert.deepEqual(await state(),before);assert.equal(await manifest(),diskBefore);report.denialPreservesData=true;
    await page.evaluate(`localStorage.removeItem(${JSON.stringify(denyKey)})`);await page.click('#resume-data-folder');await page.waitFor('!document.querySelector("#dialog").open&&document.documentElement.dataset.storageSetup==="ready"&&'+saved);
    assert.equal(await page.evaluate('window.phonePickerCalls'),0);assert.equal(await page.evaluate('window.folderResumeRequests'),2);assert.deepEqual(await page.evaluate('window.folderResumeActivations'),[true,true]);assert.deepEqual(await state(),before);report.reconnectUsesOriginalHandle=true;report.permissionRequestedOnlyOnClick=true;
    assert.equal(await page.evaluate(`(async()=>{return(await(await import('./src/storage.js')).getSetting('folder')).isSameEntry(await(await navigator.storage.getDirectory()).getDirectoryHandle(${JSON.stringify(folderName)}));})()`),true);
    for(let i=0;i<3;i++){
      await page.navigate(url);await page.waitFor('document.documentElement.dataset.storageSetup==="ready"&&'+saved);
      assert.equal(await page.evaluate('!!document.querySelector("[data-folder-welcome],[data-folder-resume]")'),false);assert.equal(await page.evaluate('window.phonePickerCalls+window.folderResumeRequests'),0);assert.deepEqual(await state(),before);assert.deepEqual(await page.evaluate('window.startupIssues'),[]);report.reopens++;
    }
    report.noRepeatedSetup=true;report.originalNotesBookmarksAndHistoryPreserved=true;assert.deepEqual(chrome.errors,[]);report.status='pass';
  }catch(error){report.status='failed';report.error=error.stack;if(chrome){report.browserErrors=chrome.errors;report.state=await chrome.page.evaluate('({status:document.querySelector("#status-left")?.textContent,dialog:document.querySelector("#dialog")?.textContent,issues:window.startupIssues})').catch(()=>null);await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/pages-only-android-folder-resume-failure.png'),await chrome.page.screenshot());}throw error;
  }finally{await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/pages-only-android-folder-resume.json'),JSON.stringify(report,null,2)+'\n');await chrome?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});
