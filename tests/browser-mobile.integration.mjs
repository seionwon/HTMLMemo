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
async function phone(page){
  await page.send('Emulation.setUserAgentOverride',{userAgent:androidUA,platform:'Android'});
  await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await page.send('Page.addScriptToEvaluateOnNewDocument',{source:phoneAPIs});
}
async function dialogFits(page){
  assert.equal(await page.evaluate(`(()=>{const d=document.querySelector('#dialog'),r=d.getBoundingClientRect();return d.open&&r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1&&d.scrollWidth<=d.clientWidth+1;})()`),true);
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
    assert.equal(await page.evaluate('document.querySelector("#folder-welcome-later,[data-dialog-close]")'),null);
    for(const type of ['keyDown','keyUp'])await page.send('Input.dispatchKeyEvent',{type,key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    assert.equal(await page.evaluate('document.querySelector("#dialog").open'),true);
    await page.evaluate(`localStorage.removeItem('htmlmemo-data-folder-welcome-v1')`);await page.navigate(url);await page.waitFor('document.querySelector("#dialog").open&&document.querySelector("[data-folder-welcome]")');await page.evaluate('navigator.serviceWorker.ready.then(()=>true)');
    assert.equal(await page.evaluate('document.querySelector("#toast.error:not([hidden])")'),null);assert.deepEqual(await page.evaluate('window.startupIssues'),[]);assert.deepEqual(chrome.errors,[]);report.repeatVisitAlsoErrorFree=true;report.status='pass';
  }catch(error){report.status='failed';report.error=error.stack;if(chrome){report.browserErrors=chrome.errors;report.state=await chrome.page.evaluate('({status:document.querySelector("#status-left")?.textContent,dialog:document.querySelector("#dialog")?.textContent,toast:document.querySelector("#toast")?.textContent,errors:window.startupIssues})').catch(()=>null);await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/pages-only-android-first-run-failure.png'),await chrome.page.screenshot());}throw error;
  }finally{await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/pages-only-android-first-run.json'),JSON.stringify(report,null,2)+'\n');await chrome?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});
