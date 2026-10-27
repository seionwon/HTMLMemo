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
  for(const name of ['showDirectoryPicker','showOpenFilePicker','showSaveFilePicker'])Object.defineProperty(window,name,{configurable:true,value:undefined});
  Object.defineProperty(navigator,'locks',{configurable:true,value:undefined});
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
    assert.ok(await page.evaluate('document.querySelector("[data-browser-storage]")'));
    await page.click('#storage-start');await page.click('#settings-button');await page.waitFor('document.querySelector("#settings-sync")');
    await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/pages-only-cold-shell.json'),JSON.stringify({entryEvaluatedBeforeDOM:true,libraryReady:true,settingsBound:true,errors:chrome.errors},null,2));
  }finally{clearTimeout(releaseTimer);pending?.end();await chrome?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});

test('real Chrome: Pages-only mobile first-run supports folder-free reading, sync and export',{timeout:120000},async()=>{
  await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'htmlmemo-mobile-'));await cp(join(root,'public'),folder,{recursive:true});const server=createServer(folder);let chrome;
  const report={simulation:'Android user agent and touch viewport in dedicated desktop Chrome; directory/open/save pickers, write locks and launchQueue unavailable',layouts:[]};
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));chrome=await launchChrome({firstRun:true});const {page}=chrome;await phone(page);
    const url=process.env.HTMLMEMO_SIDEBAR_TEST_URL||`http://127.0.0.1:${server.address().port}/`;await page.navigate(url);await page.waitFor(ready);await page.waitFor('document.querySelector("[data-browser-storage]")');
    assert.equal(await page.evaluate('document.querySelector("#data-folder-status").textContent'),'기기 저장');assert.equal(await page.evaluate('document.querySelector("[data-chrome-required]")'),null);
    await mkdir(join(root,'test-results'),{recursive:true});
    for(const [width,height] of [[320,740],[390,844],[430,932],[844,390]]){
      await page.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true});await dialogFits(page);report.layouts.push({width,height,welcome:true});
      await writeFile(join(root,`test-results/pages-only-mobile-welcome-${width}.png`),await page.screenshot());
    }
    await page.click('#storage-start');await page.send('Emulation.setDeviceMetricsOverride',{width:320,height:740,deviceScaleFactor:1,mobile:true});await page.click('#settings-button');await page.waitFor('document.querySelector("#settings-sync")');await dialogFits(page);
    assert.equal(await page.evaluate('document.querySelector("#settings-folder").textContent'),'저장 안내');assert.equal(await page.evaluate('getComputedStyle(document.querySelector("#appearance")).fontSize'),'16px');
    await writeFile(join(root,'test-results/pages-only-mobile-settings-320.png'),await page.screenshot());await page.click('#settings-sync');await page.waitFor('document.querySelector("#sync-join-tab")');await page.click('#sync-join-tab');await dialogFits(page);
    assert.equal(await page.evaluate('getComputedStyle(document.querySelector("#sync-target")).fontSize'),'16px');
    await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:380,deviceScaleFactor:1,mobile:true});await page.evaluate('document.querySelector("#sync-target").focus();document.querySelector("#sync-target").scrollIntoView({block:"center"})');await dialogFits(page);
    await writeFile(join(root,'test-results/pages-only-mobile-sync-reduced-height.png'),await page.screenshot());await page.click('#dialog [data-dialog-close]');await page.waitFor('!document.querySelector("#dialog").open');
    await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    await page.evaluate(`(()=>{const input=document.querySelector('#file-input');window.fileInputOpens=0;input.click=()=>window.fileInputOpens++;})()`);await page.click('#hero-import');assert.equal(await page.evaluate('window.fileInputOpens'),1);
    const html='<!doctype html><html lang="ko"><head><title>폰 첫 실행 검증</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;padding:24px;font:20px/1.8 sans-serif;overflow-wrap:anywhere}p{margin-block:20px}</style></head><body><h1>폰에서 읽고 메모하기</h1><p id="mobile-prose">안드로이드에서 처음 열어도 문서를 읽고 주석을 보관합니다.</p><p>다시 열었을 때도 이 문서와 주석은 그대로입니다.</p></body></html>';
    await page.evaluate(`(()=>{const transfer=new DataTransfer();transfer.items.add(new File([${JSON.stringify(html)}],'mobile-first-run.html',{type:'text/html'}));const input=document.querySelector('#file-input');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    const frame='document.querySelector(".document-host:not([hidden]) iframe")',doc=frame+'.contentDocument',readerReady=`${frame}?.style.visibility==='visible'&&!document.querySelector('.tab-dirty:not([hidden])')`;
    await page.waitFor(readerReady);await page.waitFor(`${doc}.querySelector('#mobile-prose')`);
    await page.evaluate(`(()=>{const d=${doc},text=d.querySelector('#mobile-prose').firstChild,r=d.createRange();r.setStart(text,0);r.setEnd(text,6);d.getSelection().removeAllRanges();d.getSelection().addRange(r);d.dispatchEvent(new Event('selectionchange'));})()`);await page.click('#toolbar [data-action=highlight]');await page.waitFor(`${doc}.querySelector('[data-htmlmemo-mark]')&&${readerReady}`);
    const stored=()=>page.evaluate(`(async()=>{const s=await import('./src/storage.js'),rows=await s.listDocuments(),r=await s.getDocument(rows[0].id);return {id:r.id,html:r.file?await r.file.text():r.html,annotations:r.metadata.annotations,bookmarks:r.metadata.bookmarks,history:(await s.listRevisions(r.id)).length};})()`),before=await stored();assert.equal(before.annotations.length,1);report.savedHighlight=true;
    await page.evaluate(`(()=>{window.exportedHTML=[];const blobs=new Map(),create=URL.createObjectURL.bind(URL),click=HTMLAnchorElement.prototype.click;URL.createObjectURL=blob=>{const url=create(blob);blobs.set(url,blob);return url;};HTMLAnchorElement.prototype.click=function(){if(this.download&&blobs.has(this.href)){const name=this.download;void blobs.get(this.href).text().then(html=>exportedHTML.push({name,html}));}else click.call(this);};})()`);await page.click('#save-page');await page.waitFor('window.exportedHTML.length===1');
    const output=await page.evaluate('window.exportedHTML[0]');assert.match(output.name,/\.html$/);assert.match(output.html,/안드로이드에서/);assert.match(output.html,/data-htmlmemo-mark/);assert.deepEqual(await stored(),before);report.exportWithNotes=true;
    for(const width of [320,390,430]){await page.send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:true});assert.equal(await page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),true);await writeFile(join(root,`test-results/pages-only-mobile-reader-${width}.png`),await page.screenshot());}
    await page.navigate(url);await page.waitFor('document.querySelector("[data-open]")');assert.equal(await page.evaluate('document.querySelector("#dialog").open'),false);assert.deepEqual(await stored(),before);await page.click('[data-open]');await page.waitFor(`${readerReady}&&${doc}.querySelector('[data-htmlmemo-mark]')`);report.reloadPreservesDocumentAndNotes=true;
    assert.deepEqual(await page.evaluate('window.startupIssues'),[]);assert.deepEqual(chrome.errors,[]);assert.equal(await page.evaluate('document.querySelector("#toast.error:not([hidden])")'),null);report.status='pass';
  }catch(error){report.status='failed';report.error=error.stack;if(chrome){report.browserErrors=chrome.errors;report.state=await chrome.page.evaluate('({status:document.querySelector("#status-left")?.textContent,dialog:document.querySelector("#dialog")?.textContent,toast:document.querySelector("#toast")?.textContent,errors:window.startupIssues})').catch(()=>null);await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/pages-only-mobile-failure.png'),await chrome.page.screenshot());}throw error;
  }finally{await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/pages-only-mobile.json'),JSON.stringify(report,null,2)+'\n');await chrome?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});
