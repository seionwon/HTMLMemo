import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer as createHTTPServer} from 'node:http';
import {mkdtemp,cp,rm,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {root,prepareAssets} from '../scripts/assets.mjs';
import {createServer} from '../scripts/server.mjs';
import {launchChrome} from './chrome.mjs';
import {auditLowResolution} from './low-resolution-fixture.mjs';

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
      if(await page.evaluate('!document.querySelector("#sidebar").hidden'))await page.click('#close-sidebar');
      assert.equal(await page.evaluate(`${viewport}.classList.contains('reader-native-scroll')`),mode!=='static');
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

test('real Chrome: Pages-only empty library waits for folder permission and restoration on startup',{timeout:90000},async()=>{
  await prepareAssets();const server=createServer();let chrome;
  const report={checks:[],hardwarePhoneTested:false,method:'Isolated Chrome with a real OPFS folder and IndexedDB; permission and folder-read delays are controlled'};
  const folderName='Empty hint startup fixture',ready='document.documentElement.dataset.storageSetup==="ready"',saved='document.querySelector("#data-folder-status").textContent==="폴더 저장 완료"';
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));chrome=await launchChrome({firstRun:true});const {page}=chrome;await phone(page);
    await page.send('Emulation.setDeviceMetricsOverride',{width:320,height:480,deviceScaleFactor:1,mobile:true});
    await page.send('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{
      const folderName=${JSON.stringify(folderName)},proto=FileSystemDirectoryHandle.prototype,query=proto.queryPermission,request=proto.requestPermission,get=proto.getFileHandle;
      window.libraryHintViolations=[];window.holdLibraryManifest=sessionStorage.getItem('fixture-hold-library-manifest')==='1';
      new MutationObserver(()=>{
        const hint=document.querySelector('#empty-library');
        if(!hint||hint.hidden||hint.querySelector('h3')?.textContent!=='첫 HTML 문서를 보관해보세요.')return;
        if(document.documentElement.dataset.storageSetup!=='ready'||sessionStorage.getItem('fixture-expect-library-document')==='1')
          if(libraryHintViolations.length<10)libraryHintViolations.push({state:document.documentElement.dataset.storageSetup,documents:document.querySelectorAll('.document-card').length});
      }).observe(document,{subtree:true,childList:true,attributes:true,attributeFilter:['hidden','data-storage-setup']});
      Object.defineProperty(proto,'queryPermission',{configurable:true,value:async function(options){
        if(this.name!==folderName)return query.call(this,options);
        if(window.holdLibraryPermission){window.holdLibraryPermission=false;await new Promise(resolve=>window.releaseLibraryPermission=resolve);}
        return sessionStorage.getItem('fixture-deny-library-permission')==='1'?'prompt':'granted';
      }});
      Object.defineProperty(proto,'requestPermission',{configurable:true,value:async function(options){return this.name===folderName?(sessionStorage.getItem('fixture-deny-library-permission')==='1'?'denied':'granted'):request.call(this,options);}});
      proto.getFileHandle=async function(name,options){
        if(this.name===folderName&&name==='HTMLMemo-library.json'&&window.holdLibraryManifest){window.holdLibraryManifest=false;await new Promise(resolve=>window.releaseLibraryManifest=resolve);}
        return get.call(this,name,options);
      };
      window.showDirectoryPicker=async()=> (await navigator.storage.getDirectory()).getDirectoryHandle(folderName,{create:true});
    })()`});
    const url=process.env.HTMLMEMO_SIDEBAR_TEST_URL||`http://127.0.0.1:${server.address().port}/`;
    const hidden=async label=>{assert.equal(await page.evaluate('document.querySelector("#empty-library").hidden'),true,label);assert.deepEqual(await page.evaluate('window.libraryHintViolations'),[],label);report.checks.push(label);};
    report.phase='first run and cancellation';await page.navigate(url);await page.waitFor('!!document.querySelector("#create-storage-folder")');await hidden('First run does not show an empty-library claim');
    await page.click('#cancel-folder-setup');await pausedSetup(page);await hidden('Canceling folder setup keeps the hint hidden');await page.click('#folder-setup-resume');
    report.phase='delayed permission and initial folder read';await page.evaluate('window.holdLibraryPermission=true;window.holdLibraryManifest=true');await page.click('#select-storage-folder');
    await page.waitFor('typeof window.releaseLibraryPermission==="function"');await hidden('Waiting for permission keeps the hint hidden');await page.evaluate('window.releaseLibraryPermission()');
    await page.waitFor('typeof window.releaseLibraryManifest==="function"');await hidden('Permission alone does not reveal the hint before folder initialization');await page.evaluate('window.releaseLibraryManifest()');
    await page.waitFor(ready+'&&'+saved+'&&!document.querySelector("#empty-library").hidden');assert.equal(await page.evaluate('document.querySelector("#empty-library").checkVisibility()'),true);assert.deepEqual(await page.evaluate('window.libraryHintViolations'),[]);report.checks.push('A confirmed empty folder shows the first-document hint');
    await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/pages-only-library-startup-empty.png'),await page.screenshot());
    report.phase='reopening with denied permission';await page.evaluate("sessionStorage.setItem('fixture-deny-library-permission','1')");await page.navigate(url);await page.waitFor('!!document.querySelector("#resume-data-folder")');await hidden('Reopening without permission keeps the hint hidden');
    await page.click('#resume-data-folder');await page.waitFor('!document.querySelector("#resume-data-folder").disabled&&document.querySelector("#folder-connection-status").textContent.includes("허용")');await hidden('Denied permission does not imply an empty folder');
    await page.evaluate("sessionStorage.removeItem('fixture-deny-library-permission')");await page.click('#resume-data-folder');await page.waitFor(ready+'&&'+saved+'&&!document.querySelector("#empty-library").hidden');
    report.phase='create a portable document';await page.evaluate(`(async()=>{
      const {parseHTML}=await import('./src/document.js'),{putDocumentRevision}=await import('./src/storage.js'),p=parseHTML('<html><head><title>폴더에서 복원할 문서</title></head><body><p>Keep this original document.</p></body></html>');
      await putDocumentRevision({id:'startup-restored-book',title:p.metadata.title,name:'saved-book.html',created:1000,modified:2000,html:p.html,metadata:p.metadata});
    })()`);
    await page.waitFor(`(async()=>{if(!(${saved}))return false;const folder=await(await navigator.storage.getDirectory()).getDirectoryHandle(${JSON.stringify(folderName)});return JSON.parse(await(await(await folder.getFileHandle('HTMLMemo-library.json')).getFile()).text()).documents.length===1;})()`);
    // Remove only this isolated fixture's browser cache, preserving its real folder.
    // Raw IDB writes intentionally avoid emitting an autosave deletion to that folder.
    await page.evaluate(`(async()=>{
      const folder=await(await import('./src/storage.js')).getSetting('folder'),db=await new Promise((resolve,reject)=>{const r=indexedDB.open('HTMLMemo-v1');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
      await new Promise((resolve,reject)=>{const tx=db.transaction([...db.objectStoreNames],'readwrite');for(const name of db.objectStoreNames)tx.objectStore(name).clear();tx.objectStore('settings').put(folder,'folder');tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});db.close();
      sessionStorage.setItem('fixture-expect-library-document','1');sessionStorage.setItem('fixture-hold-library-manifest','1');
    })()`);
    report.phase='restore a populated folder with an empty browser cache';await page.navigate(url);await page.waitFor('typeof window.releaseLibraryManifest==="function"');await hidden('An empty browser cache stays hidden while the populated folder is read');assert.equal(await page.evaluate('document.querySelectorAll(".document-card").length'),0);
    await writeFile(join(root,'test-results/pages-only-library-startup-reading.png'),await page.screenshot());await page.evaluate("sessionStorage.removeItem('fixture-hold-library-manifest');window.releaseLibraryManifest()");
    await page.waitFor(ready+'&&'+saved+'&&!!document.querySelector("[data-open=startup-restored-book]")');await hidden('Restoration shows the saved document without an empty-hint flash');
    assert.match(await page.evaluate('(async()=>(await(await import("./src/storage.js")).getDocument("startup-restored-book")).html)()'),/Keep this original document/);
    await writeFile(join(root,'test-results/pages-only-library-startup-restored.png'),await page.screenshot());await page.navigate(url);await page.waitFor(ready+'&&'+saved);await hidden('An ordinary reopen of a populated library never shows the hint');
    assert.deepEqual(chrome.errors,[]);report.status='pass';
  }catch(error){report.status='failed';report.error=error.stack;if(chrome){report.state=await chrome.page.evaluate('({setup:document.documentElement.dataset.storageSetup,hint:document.querySelector("#empty-library")?.outerHTML,status:document.querySelector("#folder-connection-status")?.textContent,violations:window.libraryHintViolations})').catch(()=>null);await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/pages-only-library-startup-failure.png'),await chrome.page.screenshot());}throw error;}
  finally{await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/pages-only-library-startup.json'),JSON.stringify(report,null,2)+'\n');await chrome?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
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
    for(const [width,height] of [[240,480],[280,560],[320,240],[320,740],[390,844],[430,932],[844,390]]){
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
    assert.equal(await page.evaluate('document.querySelector("#folder-reconnect h1").textContent'),'이어서 사용하기');assert.equal(await page.evaluate('document.querySelector("#dialog").open'),false);assert.equal(await page.evaluate('document.querySelector("#folder-reconnect details").open'),false);assert.equal(await page.evaluate('document.querySelector("#resume-data-folder").textContent'),'계속');report.noRepeatedModal=true;
    assert.equal(await page.evaluate('document.querySelector("#create-storage-folder,#storage-folder-name")'),null);assert.equal(await page.evaluate('document.activeElement.id'),'resume-data-folder');
    assert.equal(await page.evaluate('window.phonePickerCalls+window.folderResumeRequests'),0);assert.equal(await page.evaluate('document.querySelector("#toast.error:not([hidden])")'),null);
    await page.click('#cancel-folder-setup');await pausedSetup(page);assert.deepEqual(await state(),before);assert.equal(await manifest(),diskBefore);assert.equal(await page.evaluate('window.phonePickerCalls+window.folderResumeRequests'),0);report.cancelPreservesData=true;
    await page.click('#folder-setup-resume');await page.waitFor('!document.querySelector("#folder-reconnect").hidden&&document.querySelector("[data-folder-resume]")');assert.equal(await page.evaluate('document.querySelector("#create-storage-folder,#storage-folder-name")'),null);
    await mkdir(join(root,'test-results'),{recursive:true});
    for(const [width,height] of [[320,568],[390,844],[844,390]]){
      await page.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true});assert.equal(await page.evaluate(`(()=>{const d=document.querySelector('#folder-reconnect'),r=d.querySelector('section').getBoundingClientRect();return !d.hidden&&!document.querySelector('#dialog').open&&r.left>=0&&r.right<=innerWidth+1&&d.scrollWidth<=d.clientWidth+1;})()`),true);
      await page.evaluate(`document.querySelector('#resume-data-folder').scrollIntoView({block:'center'})`);
      assert.equal(await page.evaluate(`(()=>{const b=document.querySelector('#resume-data-folder'),r=b.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&b.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));})()`),true);
      await page.evaluate('scrollTo(0,0)');await writeFile(join(root,`test-results/pages-only-android-folder-resume-${width}.png`),await page.screenshot());report.layouts.push({width,height,reachable:true});
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
    report.permissionResetReopens=0;
    for(let i=0;i<3;i++){
      await page.evaluate(`localStorage.setItem(${JSON.stringify(grantKey)},'prompt')`);await page.navigate(url);await page.waitFor('!document.querySelector("#folder-reconnect").hidden&&document.querySelector("#resume-data-folder")');
      assert.equal(await page.evaluate('document.querySelector("#dialog").open'),false);assert.equal(await page.evaluate('document.querySelector("#folder-reconnect details").open'),false);assert.equal(await page.evaluate('window.phonePickerCalls+window.folderResumeRequests'),0);assert.deepEqual(await state(),before);
      await page.click('#resume-data-folder');await page.waitFor('document.documentElement.dataset.storageSetup==="ready"&&'+saved);assert.equal(await page.evaluate('window.phonePickerCalls'),0);assert.equal(await page.evaluate('window.folderResumeRequests'),1);assert.deepEqual(await page.evaluate('window.folderResumeActivations'),[true]);assert.equal(await page.evaluate('document.querySelector("#folder-reconnect").children.length'),0);assert.deepEqual(await state(),before);report.permissionResetReopens++;
    }
    report.noRepeatedSetup=true;report.originalNotesBookmarksAndHistoryPreserved=true;assert.deepEqual(chrome.errors,[]);report.status='pass';
  }catch(error){report.status='failed';report.error=error.stack;if(chrome){report.browserErrors=chrome.errors;report.state=await chrome.page.evaluate('({status:document.querySelector("#status-left")?.textContent,dialog:document.querySelector("#dialog")?.textContent,issues:window.startupIssues})').catch(()=>null);await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/pages-only-android-folder-resume-failure.png'),await chrome.page.screenshot());}throw error;
  }finally{await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/pages-only-android-folder-resume.json'),JSON.stringify(report,null,2)+'\n');await chrome?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});

test('real Chrome: Pages-only touch and pen text marking highlights and underlines with scrolling and durable quotes',{timeout:180000},async()=>{
 await prepareAssets();const server=createServer();let chrome,desktop;const report={cases:[],desktopCases:[],progress:[],hardwareAndroidTested:false,input:'Trusted Chrome CDP touch and pen events with an Android user agent; actual caret hit-testing, DOM selection and saved annotations'};
 try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));chrome=await launchChrome();const {page}=chrome,url=process.env.HTMLMEMO_SIDEBAR_TEST_URL||`http://127.0.0.1:${server.address().port}/`;
  await page.send('Emulation.setUserAgentOverride',{userAgent:androidUA,platform:'Android'});await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await page.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:3});await page.navigate(url);await page.waitFor(ready);
  // A phone and a Mac use independent browser profiles. Do not switch an active
  // mobile touch-emulation session into a desktop native-selection session.
  desktop=await launchChrome();await desktop.page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});await desktop.page.navigate(url);await desktop.page.waitFor(ready);
  const frame='document.querySelector(".document-host:not([hidden]) iframe.document-frame")',doc=frame+'.contentDocument',viewport='document.querySelector(".document-host:not([hidden]) .reader-viewport")',settled=`${frame}?.style.visibility==='visible'&&!document.querySelector('.tab-dirty:not([hidden])')`;
  const saved=(id,inputPage=page)=>inputPage.evaluate(`(async()=>(await(await import('./src/storage.js')).getDocument(${JSON.stringify(id)})).metadata.annotations)()`);
  const reset=async(inputPage=page)=>{await inputPage.evaluate(`(()=>{const d=${doc};for(const n of [d.scrollingElement,d.querySelector('main'),${viewport}])n.scrollTo({left:0,top:0,behavior:'instant'});d.getSelection().removeAllRanges();})()`);await inputPage.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');};
  const tool=async(name,inputPage=page)=>{await inputPage.click('#toolbar [data-action='+name+']');if(await inputPage.evaluate('!document.querySelector("#tool-popover").hidden')){const mode='[data-tool-mode="'+name+'"]';if(await inputPage.evaluate('!!document.querySelector('+JSON.stringify(mode)+')'))await inputPage.click(mode);else await inputPage.click('[data-popover-close]');}};
  const point=(id,offset,inputPage=page,edge=.5)=>inputPage.evaluate(`(()=>{const f=${frame},d=f.contentDocument,root=d.getElementById(${JSON.stringify(id)}),walk=d.createTreeWalker(root,NodeFilter.SHOW_TEXT);let at=${offset},node;while(walk.nextNode()){if(at<walk.currentNode.length){node=walk.currentNode;break;}at-=walk.currentNode.length;}const range=d.createRange();range.setStart(node,at);range.setEnd(node,at+1);const r=range.getClientRects()[0],b=f.getBoundingClientRect(),s=b.width/f.offsetWidth;return {x:b.left+(r.left+r.width*${edge})*s,y:b.top+(r.top+r.height/2)*s};})()`);
  const touch=(type,points=[])=>page.send('Input.dispatchTouchEvent',{type,touchPoints:points.map((p,i)=>({id:i+1,radiusX:2,radiusY:2,force:1,...p}))});
  const drag=async(input,a,b,inputPage=page)=>{
   if(input==='touch'){await touch('touchStart',[a]);for(let i=1;i<=6;i++)await touch('touchMove',[{x:a.x+(b.x-a.x)*i/6,y:a.y+(b.y-a.y)*i/6}]);await touch('touchEnd');}
   else{const pressure=input==='pen'?{force:.5}:{};await inputPage.send('Input.dispatchMouseEvent',{type:'mouseMoved',...a,button:'none',buttons:0,pointerType:input,force:0});await inputPage.send('Input.dispatchMouseEvent',{type:'mousePressed',...a,button:'left',buttons:1,clickCount:1,pointerType:input,...pressure});for(let i=1;i<=6;i++)await inputPage.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:a.x+(b.x-a.x)*i/6,y:a.y+(b.y-a.y)*i/6,button:'left',buttons:1,pointerType:input,...pressure});await inputPage.send('Input.dispatchMouseEvent',{type:'mouseReleased',...b,button:'left',buttons:0,clickCount:1,pointerType:input,force:0});}
  };
  for(const mode of ['static','root','inner']){
   const id='phone-text-'+mode;await page.evaluate('window.phoneTextDocumentId='+JSON.stringify(id));
   await page.evaluate(`(async()=>{const {parseHTML}=await import('./src/document.js'),s=await import('./src/storage.js'),mode=${JSON.stringify(mode)},html='<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Phone text '+mode+'</title><style>html,body{margin:0;font:20px/1.7 monospace}main{padding:20px;box-sizing:border-box}article{min-height:2600px}p{margin:0 0 14px;max-width:300px}'+(mode==='inner'?'html,body{height:100%;overflow:hidden}main{height:100%;overflow:auto}':'')+'</style></head><body><main'+(mode==='inner'?' id="reader-content" data-section="phone:one"':'')+'><article><p id="single">Finger highlights and pen underlines.</p><p id="wrapped">First <em>formatted words across a wrapped line</em> and the ending.</p><p id="next">Second paragraph for multiline selection.</p><p><button id="kept-control">A document control</button></p><div style="height:2200px">Scroll area</div></article></main></body></html>',p=parseHTML(html,{viewport:{width:390,height:844}},{allowScripts:mode!=='static'});p.metadata.view={zoom:1,autoFit:false,scrollTop:0,scrollLeft:0};await s.putDocumentRevision({id:${JSON.stringify(id)},title:p.metadata.title,name:${JSON.stringify(id+'.html')},html:p.html,nativeScroll:p.nativeScroll,created:Date.now(),modified:Date.now(),metadata:p.metadata});document.querySelector('#library-tab').click();})()`);
   await page.waitFor('!!document.querySelector("[data-open='+id+']")');await page.click('[data-open='+id+']');await page.waitFor(settled);
   if(await page.evaluate('!document.querySelector("#sidebar").hidden'))await page.click('#close-sidebar');
   await page.evaluate(`${doc}.defaultView.phoneInputTypes=[];${doc}.addEventListener('pointerdown',e=>${doc}.defaultView.phoneInputTypes.push(e.pointerType),true)`);
   for(const input of ['touch','pen'])for(const name of ['highlight','underline']){
    await tool(name);await reset();const before=(await saved(id)).length,a=await point('single',7),b=await point('single',16);
    assert.equal(await page.evaluate(`${doc}.defaultView.getComputedStyle(${doc}.body).touchAction`),'none');
    await drag(input,input==='pen'?b:a,input==='pen'?a:b);
    await page.waitFor(`(async()=>(await(await import('./src/storage.js')).getDocument(${JSON.stringify(id)})).metadata.annotations.length===${before+1})()`);await page.waitFor(settled);
    const mark=(await saved(id)).at(-1);assert.equal(mark.type,name);assert.equal(mark.textAnchor.quote,'highlights');if(mode==='inner')assert.equal(mark.textAnchor.section,'phone:one');report.progress.push({mode,input,type:name,quote:mark.textAnchor.quote});
   }
   await tool('highlight');await reset();let count=(await saved(id)).length;await drag('touch',await point('wrapped',6),await point('next',5));
   await page.waitFor(`(async()=>(await(await import('./src/storage.js')).getDocument(${JSON.stringify(id)})).metadata.annotations.length===${count+1})()`);assert.equal((await saved(id)).at(-1).textAnchor.quote,'formatted words across a wrapped line and the ending.Second');
   await reset();const a=await point('single',7),b=await point('single',16),beforeCancel=await saved(id);await touch('touchStart',[a]);await touch('touchMove',[b]);await touch('touchCancel');assert.deepEqual(await saved(id),beforeCancel);
   await touch('touchStart',[a]);await touch('touchMove',[b]);await touch('touchStart',[b,{x:b.x+45,y:b.y}]);for(let i=1;i<=5;i++)await touch('touchMove',[{x:b.x,y:b.y-i*12},{x:b.x+45,y:b.y-i*12}]);await touch('touchEnd',[{x:b.x,y:b.y-60}]);await touch('touchEnd');
   assert.deepEqual(await saved(id),beforeCancel);assert.ok(await page.evaluate(`Math.max(${doc}.scrollingElement.scrollTop,${doc}.querySelector('main').scrollTop,${viewport}.scrollTop)>30`));
   await reset();await tool('select');assert.equal(await page.evaluate(`${doc}.documentElement.hasAttribute('data-htmlmemo-text-marking')`),false);await page.send('Input.synthesizeScrollGesture',{x:200,y:430,yDistance:-60,speed:180,preventFling:true,gestureSourceType:'touch'});assert.deepEqual(await saved(id),beforeCancel);
   const types=await page.evaluate(`${doc}.defaultView.phoneInputTypes`);assert.ok(types.includes('touch'));assert.ok(types.includes('pen'));await page.waitFor(settled);const durable=await saved(id);
   const original=await page.evaluate(`(async()=>{const r=await(await import('./src/storage.js')).getDocument(${JSON.stringify(id)});return {html:r.html,nativeScroll:r.nativeScroll,title:r.title,name:r.name,metadata:{...r.metadata,annotations:[],bookmarks:[],view:{zoom:1,autoFit:false,scrollTop:0,scrollLeft:0}}};})()`),desktopId='desktop-text-'+mode,mouse=desktop.page;await mouse.evaluate('window.desktopTextDocumentId='+JSON.stringify(desktopId));
   await mouse.evaluate(`(async()=>{await(await import('./src/storage.js')).putDocumentRevision({...${JSON.stringify(original)},id:${JSON.stringify(desktopId)},created:Date.now(),modified:Date.now()});document.querySelector('#library-tab').click();})()`);await mouse.waitFor('!!document.querySelector("[data-open='+desktopId+']")');await mouse.click('[data-open='+desktopId+']');await mouse.waitFor(settled);if(await mouse.evaluate('!document.querySelector("#sidebar").hidden'))await mouse.click('#close-sidebar');
   await mouse.evaluate(`${doc}.defaultView.desktopMouseTypes=[];${doc}.addEventListener('pointerdown',e=>${doc}.defaultView.desktopMouseTypes.push(e.pointerType),true)`);await tool('underline',mouse);await reset(mouse);const mouseStart=await point('single',7,mouse,.1),mouseEnd=await point('single',16,mouse,.9);assert.ok(mouseStart.y>=0&&mouseEnd.y>=0&&mouseStart.y<900&&mouseEnd.y<900,'Desktop text must be visible before the mouse drag');await drag('mouse',mouseStart,mouseEnd,mouse);
   await mouse.waitFor(`(async()=>(await(await import('./src/storage.js')).getDocument(${JSON.stringify(desktopId)})).metadata.annotations.length===1)()`);const desktopMark=(await saved(desktopId,mouse))[0];assert.equal(desktopMark.type,'underline');assert.equal(desktopMark.textAnchor.quote,'highlights');assert.ok((await mouse.evaluate(`${doc}.defaultView.desktopMouseTypes`)).includes('mouse'));report.desktopCases.push({mode,nativeMouseSelection:true,exactQuote:desktopMark.textAnchor.quote});await mouse.waitFor(settled);await mouse.click('.tab.document.active .tab-close');await mouse.waitFor('!document.querySelector(".tab.document")');
   await reset();await writeFile(join(root,`test-results/pages-only-touch-text-${mode}-390.png`),await page.screenshot());
   await page.click('.tab.document.active .tab-close');await page.waitFor('!document.querySelector(".tab.document")');await page.click('[data-open='+id+']');await page.waitFor(settled);assert.deepEqual(await saved(id),durable);assert.ok(await page.evaluate(`${doc}.querySelectorAll('[data-htmlmemo-mark]').length>0`));
   report.cases.push({mode,types:[...new Set(types)],annotations:durable.length,exactQuotes:true,cancelledGesturePreserved:true,twoFingerScroll:true,desktopProfileVerified:true,reopened:true});await page.click('.tab.document.active .tab-close');await page.waitFor('!document.querySelector(".tab.document")');
  }
  assert.deepEqual(chrome.errors,[]);assert.deepEqual(desktop.errors,[]);report.status='pass';
 }catch(error){report.status='failed';report.error=error.stack;if(chrome){report.state=await chrome.page.evaluate(`(async()=>{const f=document.querySelector('.document-host:not([hidden]) iframe.document-frame'),d=f?.contentDocument,r=await(await import('./src/storage.js')).getDocument(window.phoneTextDocumentId);return {annotations:r?.metadata.annotations.map(a=>({type:a.type,quote:a.textAnchor?.quote})),rootFlags:d?.documentElement.outerHTML.slice(0,240),userSelect:d?.defaultView.getComputedStyle(d.body).userSelect,status:document.querySelector('#status-left')?.textContent,toast:document.querySelector('#toast')?.textContent,frame:f?.getBoundingClientRect().toJSON(),outer:document.querySelector('.document-host:not([hidden]) .reader-viewport')?.scrollTop,inner:d?.scrollingElement?.scrollTop,selected:d?.getSelection()?.toString(),types:d?.defaultView.phoneInputTypes};})()`).catch(()=>null);await writeFile(join(root,'test-results/pages-only-touch-text-failure.png'),await chrome.page.screenshot());}if(desktop){report.desktopState=await desktop.page.evaluate(`(async()=>{const f=document.querySelector('.document-host:not([hidden]) iframe.document-frame'),d=f?.contentDocument,r=await(await import('./src/storage.js')).getDocument(window.desktopTextDocumentId);return {annotations:r?.metadata.annotations.map(a=>({type:a.type,quote:a.textAnchor?.quote})),rootFlags:d?.documentElement.outerHTML.slice(0,240),userSelect:d?.defaultView.getComputedStyle(d.body).userSelect,selected:d?.getSelection()?.toString(),types:d?.defaultView.desktopMouseTypes,frame:f?.getBoundingClientRect().toJSON()};})()`).catch(()=>null);await writeFile(join(root,'test-results/pages-only-touch-text-desktop-failure.png'),await desktop.page.screenshot());}throw error;}
 finally{await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/pages-only-touch-text.json'),JSON.stringify(report,null,2)+'\n');await chrome?.close();await desktop?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('real Chrome: Pages-only low-resolution screens keep controls reachable and the toolbar scrolls by touch',{timeout:240000},async()=>{
  await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'htmlmemo-small-screen-'));await cp(join(root,'public'),folder,{recursive:true});const server=createServer(folder);let chrome;
  const report={hardwarePhoneTested:false,method:'Real isolated Chrome with Android user agent, viewport resizing and CDP touch input',layouts:[]};
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));chrome=await launchChrome();const {page}=chrome;
    await page.send('Emulation.setUserAgentOverride',{userAgent:androidUA,platform:'Android'});
    await page.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:2});
    await page.send('Emulation.setDeviceMetricsOverride',{width:320,height:480,deviceScaleFactor:1,mobile:true});
    await page.navigate(process.env.HTMLMEMO_SIDEBAR_TEST_URL||`http://127.0.0.1:${server.address().port}/`);await page.waitFor(ready);
    await mkdir(join(root,'test-results'),{recursive:true});
    for(const [width,height] of [[240,480],[280,560],[320,480],[360,640],[568,280],[320,240]]){
      await page.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true});
      await page.evaluate(`window.smallScreenResult=null;window.smallScreenError=null;(${auditLowResolution.toString()})(window).then(r=>window.smallScreenResult=r).catch(e=>window.smallScreenError=e.stack);void 0`);
      await page.waitFor("window.smallScreenResult||window.smallScreenError",60000);
      assert.equal(await page.evaluate("window.smallScreenError"),null);report.layouts.push(await page.evaluate("window.smallScreenResult"));
      await writeFile(join(root,`test-results/pages-only-low-resolution-${width}-${height}.png`),await page.screenshot());
    }
    const failures=report.layouts.flatMap(layout=>layout.failures.map(f=>({...f,width:layout.width,height:layout.height})));
    // Collect all layouts before failing, so a small-screen regression is diagnosable in one run.
    assert.deepEqual(failures,[]);
    await page.send('Emulation.setDeviceMetricsOverride',{width:240,height:480,deviceScaleFactor:1,mobile:true});await page.click('.tab.document .tab-select');
    await page.evaluate('document.querySelector("#toolbar").scrollLeft=0');
    const bounds=await page.evaluate('document.querySelector("#toolbar").getBoundingClientRect().toJSON()');
    const send=(type,points=[])=>page.send('Input.dispatchTouchEvent',{type,touchPoints:points.map(p=>({id:1,radiusX:2,radiusY:2,force:1,...p}))});
    const pan=async(x,y,dx,dy)=>{await send('touchStart',[{x,y}]);for(let i=1;i<=8;i++)await send('touchMove',[{x:x+dx*i/8,y:y+dy*i/8}]);await send('touchEnd');};
    await pan(bounds.right-24,bounds.top+bounds.height/2,-Math.min(180,bounds.width-48),0);
    await page.waitFor('document.querySelector("#toolbar").scrollLeft>0');
    assert.equal(await page.evaluate(`(()=>{const b=document.querySelector('#toolbar'),r=b.getBoundingClientRect(),last=b.querySelector('[data-action=more]').getBoundingClientRect();return last.right<=r.right+1&&last.left>=r.left&&!document.querySelector('#tool-popover:not([hidden])')&&b.querySelector('[data-action=select]').classList.contains('active');})()`),true,'finger pan reveals the rightmost tool without activating a tool');
    await page.click('#toolbar [data-action=more]');await page.waitFor('!!document.querySelector("#tool-popover:not([hidden]) [data-more=info]")');await page.click('[data-popover-close]');
    await page.evaluate(`document.querySelector('#toolbar').scrollLeft=0;document.querySelector('#toolbar [data-action=more]').focus()`);
    assert.equal(await page.evaluate(`(()=>{const b=document.querySelector('#toolbar'),r=b.getBoundingClientRect(),last=document.activeElement.getBoundingClientRect();return b.scrollLeft>0&&last.left>=r.left&&last.right<=r.right+1;})()`),true,'keyboard focus also reveals a clipped tool');
    report.toolbarTouchAndKeyboard=true;
    await page.click('#toolbar [data-action=palette]');
    await page.evaluate(`document.querySelector('#color-hex').focus()`);
    await page.send('Emulation.setDeviceMetricsOverride',{width:320,height:240,deviceScaleFactor:1,mobile:true});
    await page.waitFor(`(()=>{const p=document.querySelector('#tool-popover'),r=p.getBoundingClientRect();return !p.hidden&&r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;})()`);
    assert.equal(await page.evaluate('document.activeElement.id'),'color-hex');
    report.openPaletteSurvivesViewportChange=true;await page.click('[data-popover-close]');
    await page.click('.document-host:not([hidden]) > [data-htmlmemo-reading-controls] [data-action=speak]');
    await page.evaluate(`const b=document.querySelector('.mstts-player');b.style.left=(innerWidth-b.offsetWidth-4)+'px';b.style.top='110px';b.style.bottom='auto';`);
    await page.click('[data-tts-gear]');
    const panel=await page.evaluate(`(()=>{const p=document.querySelector('.mstts-panel');return {rect:p.getBoundingClientRect().toJSON(),scrollHeight:p.scrollHeight,height:p.clientHeight};})()`);
    assert.ok(panel.scrollHeight>panel.height,'short-screen settings must scroll vertically');
    await pan(panel.rect.left+10,panel.rect.bottom-12,0,-45);await page.waitFor('document.querySelector(".mstts-panel").scrollTop>0');report.ttsSettingsTouchScroll=true;
    await writeFile(join(root,'test-results/pages-only-low-resolution-tts.png'),await page.screenshot());
    await page.click('[data-tts-gear]');await page.click('.mstts-player > button:last-of-type');
    assert.equal(await page.evaluate('document.querySelector(".mstts-panel")'),null);
    // A long TOC reaches the toolbar even in portrait. Its last row and tools must both work.
    await page.send('Emulation.setDeviceMetricsOverride',{width:320,height:480,deviceScaleFactor:1,mobile:true});
    await page.evaluate(`(()=>{const html='<html><head><title>Long mobile outline</title><style>body{font:18px/1.6 system-ui;margin:24px}section{min-height:100px}</style></head><body><h1>Long mobile outline</h1>'+Array.from({length:40},(_,i)=>'<section><h2 id="mobile-section-'+(i+1)+'">Section '+(i+1)+'</h2><p>Reading content '+i+'</p></section>').join('')+'</body></html>',transfer=new DataTransfer();transfer.items.add(new File([html],'long-outline.html',{type:'text/html'}));const input=document.querySelector('#file-input');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await page.waitFor('document.querySelector(".tab.document.active .tab-title")?.textContent==="Long mobile outline"&&document.querySelector(".document-host:not([hidden]) iframe.document-frame")?.style.visibility==="visible"');
    assert.equal(await page.evaluate(`document.querySelector('.document-host:not([hidden]) iframe.document-frame').contentDocument.querySelector('#mobile-section-40')?.textContent`),'Section 40');
    if(await page.evaluate('document.querySelector("#sidebar").hidden')){await page.click('#toolbar [data-action=more]');await page.click('[data-more=sidebar]');}
    await page.click('#sidebar [data-sidebar-view=outline]');await page.click('#sidebar [data-heading]:last-child');
    await page.waitFor(`(()=>{const host=document.querySelector('.document-host:not([hidden])'),f=host.querySelector('iframe.document-frame'),v=host.querySelector('.reader-viewport'),d=f.contentDocument,r=d.querySelector('#mobile-section-40').getBoundingClientRect(),b=f.getBoundingClientRect(),edge=v.getBoundingClientRect(),scale=b.width/f.offsetWidth,top=b.top+r.top*scale,bottom=b.top+r.bottom*scale,scroll=Math.max(v.scrollTop,d.scrollingElement.scrollTop);window.longOutlineProof={scroll,top,bottom,viewportTop:edge.top,viewportBottom:edge.bottom};return scroll>100&&top>=edge.top-1&&bottom<=edge.bottom+1;})()`);
    report.longOutlineTarget=await page.evaluate('window.longOutlineProof');
    await page.click('#toolbar [data-action=palette]');await page.waitFor('!document.querySelector("#tool-popover").hidden&&!!document.querySelector("#pen-width")');
    report.longOutlineAndToolbar=true;await writeFile(join(root,'test-results/pages-only-low-resolution-long-outline.png'),await page.screenshot());
    await page.click('[data-popover-close]');await page.waitFor('document.querySelector("#data-folder-status").textContent==="폴더 저장 완료"');assert.deepEqual(chrome.errors,[]);report.status='pass';
  }catch(error){report.status='failed';report.error=error.stack;if(chrome){report.errors=chrome.errors;report.state=await chrome.page.evaluate('({dialog:document.querySelector("#dialog")?.textContent,popover:document.querySelector("#tool-popover")?.textContent,longOutline:window.longOutlineProof})').catch(()=>null);await writeFile(join(root,'test-results/pages-only-low-resolution-failure.png'),await chrome.page.screenshot());}throw error;}
  finally{await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/pages-only-low-resolution.json'),JSON.stringify(report,null,2));await chrome?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});
