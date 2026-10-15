// Requires permission to bind localhost and launch a dedicated Chrome process.
// These are real browser checks, separate from the DOM/unit test suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { root, prepareAssets } from '../scripts/assets.mjs';
import { createServer } from '../scripts/server.mjs';
import { launchChrome } from './chrome.mjs';
import { FORMAT_VERSION } from '../public/src/model.js';
test('real Chrome: browsing, capture, local annotation, file writes, reopen and offline',{timeout:90000},async t=>{
  await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'htmlmemo-web-test-'));await cp(join(root,'public'),folder,{recursive:true});await cp(join(root,'tests/fixtures'),join(folder,'fixtures'),{recursive:true});
  const server=createServer(folder);let chrome;
  try{
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const url=`http://127.0.0.1:${server.address().port}/`;chrome=await launchChrome();const page=chrome.page;
    await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});await page.navigate(url);await page.waitFor('document.querySelector("#status-left").textContent.includes("개의 문서")');
    await t.test('browser navigation and single-file capture',async()=>{
      await page.evaluate(`document.querySelector('#address').value=${JSON.stringify(url+'fixtures/capture.html')};document.querySelector('#address-form').requestSubmit();`);
      await page.waitFor('document.querySelector(".browser-frame")?.contentDocument?.title === "캡처 검증 문서"');
      // A native OPFS FileSystemFileHandle exercises the same browser write and
      // IndexedDB structured-clone contracts as an external picked file.
      await page.evaluate(`window.showSaveFilePicker=async()=>{const root=await navigator.storage.getDirectory();return root.getFileHandle('picked-document.html',{create:true});};`);
      await page.click('#save-page');await page.waitFor('!document.querySelector("#toolbar").hidden && document.querySelector("#status-left").textContent.includes("자동 저장됨")');
      const html=await page.evaluate(`(async()=>{const root=await navigator.storage.getDirectory();return (await (await root.getFileHandle('picked-document.html')).getFile()).text();})()`);assert.match(html,/data:image\/svg\+xml;base64/);assert.match(html,/htmlmemo-data/);assert.ok(!html.includes('fixtureLoaded'));
    });
    await t.test('local annotation auto-writes to the connected HTML',async()=>{
      await page.evaluate(`(()=>{const doc=document.querySelector('.document-host:not([hidden]) iframe').contentDocument;const text=doc.querySelector('#selection').firstChild;const range=doc.createRange();range.setStart(text,0);range.setEnd(text,15);doc.getSelection().removeAllRanges();doc.getSelection().addRange(range);doc.dispatchEvent(new Event('selectionchange'));})()`);await page.click('[data-action="highlight"]');
      await page.waitFor('document.querySelector(".document-host:not([hidden]) iframe").contentDocument.querySelector("[data-htmlmemo-mark]") && document.querySelector("#status-left").textContent.includes("자동 저장됨")');
      await page.waitFor(`(async()=>{const root=await navigator.storage.getDirectory();const html=await (await (await root.getFileHandle('picked-document.html')).getFile()).text();return JSON.parse(new DOMParser().parseFromString(html,'text/html').getElementById('htmlmemo-data').textContent).annotations.length > 0;})()`);
      const annotation=await page.evaluate(`(async()=>{const root=await navigator.storage.getDirectory();const html=await (await (await root.getFileHandle('picked-document.html')).getFile()).text();return JSON.parse(new DOMParser().parseFromString(html,'text/html').getElementById('htmlmemo-data').textContent).annotations[0];})()`);assert.equal(annotation.type,'highlight');assert.ok(annotation.textAnchor.quote.length);
    });
    await t.test('local file import activates annotation independent of original website URL',async()=>{
      await page.evaluate(`window.showOpenFilePicker=async()=>{const root=await navigator.storage.getDirectory();return [await root.getFileHandle('picked-document.html')];};`);await page.click('#import-button');await page.waitFor('document.querySelectorAll(".tab.document").length === 2 && !document.querySelector("#toolbar").hidden');assert.equal(await page.evaluate('document.querySelector("#local-label").hidden'),false);assert.equal(await page.evaluate('document.querySelector(".document-host:not([hidden]) iframe").contentDocument.querySelectorAll("[data-htmlmemo-mark]").length > 0'),true);
    });
    await t.test('sidebar vertical boundary line drags down to a narrow strip and expands back',async()=>{
      const start=await page.evaluate(`(()=>{const r=document.querySelector('#desk-resizer').getBoundingClientRect(),m=document.querySelector('#main').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,mainWidth:m.width};})()`);
      await page.send('Input.dispatchMouseEvent',{type:'mousePressed',x:start.x,y:start.y,button:'left',clickCount:1});
      await page.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:4,y:start.y,button:'left',buttons:1});
      await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:4,y:start.y,button:'left',clickCount:1});
      const collapsed=await page.evaluate(`(()=>{const n=document.querySelector('.desk-nav'),m=document.querySelector('#main');return {navWidth:Math.round(n.getBoundingClientRect().width),strip:n.classList.contains('is-strip'),mainWidth:m.getBoundingClientRect().width};})()`);
      assert.equal(collapsed.navWidth,8);assert.equal(collapsed.strip,true);assert.ok(collapsed.mainWidth>start.mainWidth+160);
      await page.send('Input.dispatchMouseEvent',{type:'mousePressed',x:8,y:start.y,button:'left',clickCount:1});
      await page.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:180,y:start.y,button:'left',buttons:1});
      await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:180,y:start.y,button:'left',clickCount:1});
      const expanded=await page.evaluate(`(()=>{const n=document.querySelector('.desk-nav');return {navWidth:Math.round(n.getBoundingClientRect().width),strip:n.classList.contains('is-strip')};})()`);
      assert.equal(expanded.navWidth,180);assert.equal(expanded.strip,false);
    });
    await t.test('document fullscreen retains every compact toolbar button and saves annotations',async()=>{
      const buttons=await page.evaluate('[...document.querySelectorAll("#toolbar [data-action]")].map(button=>button.dataset.action)');
      await page.evaluate(`document.querySelector('.document-host:not([hidden]) iframe').contentDocument.body.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,button:0,cancelable:true}));`);await page.waitFor('document.querySelector("#app").classList.contains("reader-focus")');
      assert.equal(await page.evaluate('getComputedStyle(document.querySelector(".chrome")).display'), 'none');
      await page.waitFor(`(()=>{const viewport=document.querySelector('.document-host:not([hidden]) .reader-viewport'),frame=viewport.querySelector('iframe');const v=viewport.getBoundingClientRect(),f=frame.getBoundingClientRect();return Math.abs(f.left-v.left)<1 && Math.abs(f.width-viewport.clientWidth)<1;})()`);
      assert.deepEqual(await page.evaluate('[...document.querySelectorAll("#toolbar [data-action]")].map(button=>button.dataset.action)'),buttons);
      assert.equal(await page.evaluate('getComputedStyle(document.querySelector("#toolbar")).paddingTop'),'0px');
      await page.evaluate(`(()=>{const d=document.querySelector('.document-host:not([hidden]) iframe').contentDocument;const walker=d.createTreeWalker(d.body,NodeFilter.SHOW_TEXT);let node;while(walker.nextNode()){const n=walker.currentNode;if(n.parentElement.closest('p')&&!n.parentElement.closest('[data-htmlmemo-mark]')&&n.textContent.trim().length>=6){node=n;break;}}if(!node)throw Error('Missing annotation text');const range=d.createRange();range.setStart(node,0);range.setEnd(node,Math.min(12,node.textContent.length));const selection=d.getSelection();selection.removeAllRanges();selection.addRange(range);d.dispatchEvent(new Event('selectionchange'));})()`);
      await page.click('[data-action="underline"]');await page.waitFor('document.querySelector(".document-host:not([hidden]) iframe").contentDocument.querySelectorAll("[data-htmlmemo-mark]").length>1 && document.querySelector("#status-left").textContent.includes("자동 저장됨")');
      await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/reader-focus-desktop.png'),await page.screenshot());
      await page.evaluate(`document.querySelector('.document-host:not([hidden]) iframe').contentDocument.body.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,button:0,cancelable:true}));`);await page.waitFor('!document.querySelector("#app").classList.contains("reader-focus")');
      await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
      await page.evaluate(`document.querySelector('.document-host:not([hidden]) iframe').contentDocument.body.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,button:0,cancelable:true}));`);await page.waitFor('document.querySelector("#app").classList.contains("reader-focus")');
      await writeFile(join(root,'test-results/reader-focus-mobile.png'),await page.screenshot());
      await page.evaluate(`document.querySelector('.document-host:not([hidden]) iframe').contentDocument.body.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,button:0,cancelable:true}));`);await page.waitFor('!document.querySelector("#app").classList.contains("reader-focus")');
      await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
    });
    await t.test('library reopen and offline app shell',async()=>{
      await page.click('#library-tab');await page.waitFor('document.querySelectorAll(".document-card").length === 2');await page.click('[data-open]');await page.waitFor('!document.querySelector("#toolbar").hidden');
      // Fullscreen now persists zoom/position changes. Wait for every tab's
      // save indicator to clear before navigation can raise beforeunload.
      await page.waitFor('document.querySelectorAll(".tab-dirty").length === 0');
      await page.waitFor('!!navigator.serviceWorker.controller');await page.send('Network.enable');await page.send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});await page.navigate(url);await page.waitFor('document.querySelectorAll(".document-card").length === 2');await page.click('[data-open]');await page.waitFor('!document.querySelector("#toolbar").hidden');
      assert.equal(await page.evaluate('document.querySelector(".document-host:not([hidden]) iframe").contentDocument.querySelectorAll("[data-htmlmemo-mark]").length>0'),true);
    });
    await t.test('large native File import executes local JavaScript without a full file read; tools and autosave remain usable',async()=>{
      await page.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
      await page.evaluate(`(()=>{const file=new File(['<html><head><title>Native large book</title>', '<script id="htmlmemo-data" type="application/json">'+JSON.stringify({version:${FORMAT_VERSION},view:{zoom:.5,scrollTop:0,scrollLeft:0},annotations:[]})+'<'+'/script>', '</head><body><p id="first">Native first paragraph</p><script>window.localScriptExecuted=true<\\/script><div>'+ 'Book text '.repeat(500000)+'</div><p id="last">Last paragraph</p></body></html>'],'native-large.html',{type:'text/html'});file.arrayBuffer=()=>{throw Error('Whole file read is forbidden');};file.text=()=>{throw Error('Whole text read is forbidden');};const transfer=new DataTransfer();transfer.items.add(file);const input=document.querySelector('#file-input');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await page.waitFor('document.querySelector(".document-host:not([hidden]) iframe")?.contentDocument?.title === "Native large book" && !document.querySelector("#toolbar").hidden',30000);
      assert.equal(await page.evaluate('document.querySelector(".document-host:not([hidden]) iframe").contentWindow.localScriptExecuted'),true);
      assert.equal(await page.evaluate('document.querySelector(".document-host:not([hidden]) iframe").contentDocument.querySelector("#last").textContent'),'Last paragraph');
      const height=await page.evaluate('document.querySelector("#toolbar").getBoundingClientRect().height');assert.ok(height>=20&&height<=22);
      await page.waitFor('document.querySelector("#toolbar [data-action=zoom]").textContent === "50%"');
      await page.evaluate(`document.querySelector('.document-host:not([hidden]) iframe').contentDocument.body.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,button:0,cancelable:true}));`);
      await page.waitFor(`(()=>{const app=document.querySelector('#app'),viewport=document.querySelector('.document-host:not([hidden]) .reader-viewport'),frame=viewport.querySelector('iframe');const v=viewport.getBoundingClientRect(),f=frame.getBoundingClientRect();return app.classList.contains('reader-focus') && Math.abs(f.left-v.left)<1 && Math.abs(f.width-viewport.clientWidth)<1;})()`);
      await page.evaluate(`document.querySelector('.document-host:not([hidden]) iframe').contentDocument.body.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,button:0,cancelable:true}));`);await page.waitFor('!document.querySelector("#app").classList.contains("reader-focus") && document.querySelector("#toolbar [data-action=zoom]").textContent === "50%"');
      await page.evaluate(`(()=>{const doc=document.querySelector('.document-host:not([hidden]) iframe').contentDocument;const range=doc.createRange();range.selectNodeContents(doc.querySelector('#first'));const selection=doc.getSelection();selection.removeAllRanges();selection.addRange(range);doc.dispatchEvent(new Event('selectionchange'));})()`);
      await page.click('[data-action="highlight"]');await page.waitFor('document.querySelector(".document-host:not([hidden]) iframe").contentDocument.querySelector("[data-htmlmemo-mark]") && document.querySelector("#status-left").textContent.includes("자동 저장됨")',30000);
    });
    await t.test('JavaScript-generated local body becomes annotatable and its metadata survives a reopen',async()=>{
      await page.evaluate(`(()=>{const html='<html><head><title>Script generated book</title></head><body><div id="book">불러오는 중…</div><button id="change" onclick="this.textContent=123">Change</button><script>setTimeout(()=>document.getElementById("book").innerHTML="<p id=generated>Generated readable body</p>",80);<'+'/script></body></html>';const transfer=new DataTransfer();transfer.items.add(new File([html],'script-book.html',{type:'text/html'}));const input=document.querySelector('#file-input');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await page.waitFor('document.querySelector(".document-host:not([hidden]) iframe")?.contentDocument?.querySelector("#generated")?.hasAttribute("data-htmlmemo-anchor") && !document.querySelector("#toolbar").hidden',30000);
      await page.evaluate(`document.querySelector('.document-host:not([hidden]) iframe').contentDocument.querySelector('#change').click()`);assert.equal(await page.evaluate('document.querySelector(".document-host:not([hidden]) iframe").contentDocument.querySelector("#change").textContent'),'123');
      await page.evaluate(`(()=>{const doc=document.querySelector('.document-host:not([hidden]) iframe').contentDocument;const range=doc.createRange();range.selectNodeContents(doc.querySelector('#generated'));const selection=doc.getSelection();selection.removeAllRanges();selection.addRange(range);doc.dispatchEvent(new Event('selectionchange'));})()`);
      await page.click('[data-action="underline"]');await page.waitFor('document.querySelector(".document-host:not([hidden]) iframe").contentDocument.querySelector("[data-htmlmemo-mark]") && document.querySelector("#status-left").textContent.includes("자동 저장됨")',30000);
      await page.click('.tab.active .tab-close');await page.click('#library-tab');
      await page.evaluate(`(()=>{const card=[...document.querySelectorAll('.document-card')].find(card=>card.textContent.includes('Script generated book'));if(!card)throw Error('Missing saved script book');card.querySelector('[data-open]').click();})()`);
      await page.waitFor('document.querySelector(".document-host:not([hidden]) iframe")?.contentDocument?.title === "Script generated book" && !document.querySelector("#toolbar").hidden');
      await page.evaluate('new Promise(resolve=>setTimeout(resolve,800))');
      await page.waitFor('document.querySelector(".document-host:not([hidden]) iframe").contentDocument.querySelector("#generated [data-htmlmemo-mark]")');

    });
    await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/reader-desktop.png'),await page.screenshot());
    await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await writeFile(join(root,'test-results/reader-mobile.png'),await page.screenshot());assert.deepEqual(chrome.errors,[]);
  }finally{if(chrome)await chrome.close();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});

test('real Chrome: revoked file permission keeps annotations saved, retries on click, reopens and exports',{timeout:90000},async()=>{
  await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'htmlmemo-permission-test-'));await cp(join(root,'public'),folder,{recursive:true});
  const server=createServer(folder);let chrome;
  try {
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const url=`http://127.0.0.1:${server.address().port}/`;chrome=await launchChrome();const page=chrome.page;
    await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
    await page.navigate(url);await page.waitFor('document.querySelector("#status-left").textContent.includes("개의 문서")');
    await page.evaluate(`(async()=>{
      const root=await navigator.storage.getDirectory();const handle=await root.getFileHandle('source.html',{create:true});const writer=await handle.createWritable();
      await writer.write('<html><head><title>Permission recovery</title></head><body><p id="selection">Local source text survives lost write permission and later edits.</p></body></html>');await writer.close();
      window.showOpenFilePicker=async()=>[handle];window.fileAllowed=true;window.acceptPermission=false;window.permissionRequests=0;
      const originalQuery=FileSystemHandle.prototype.queryPermission;
      FileSystemHandle.prototype.queryPermission=async function(options){return this.kind==='file'&&this.name==='source.html'?(window.fileAllowed?'granted':'prompt'):originalQuery.call(this,options);};
      FileSystemHandle.prototype.requestPermission=async function(){window.permissionRequests++;window.permissionGesture=navigator.userActivation.isActive;if(window.acceptPermission){window.fileAllowed=true;return 'granted';}return 'denied';};
    })()`);
    await page.click('#import-button');await page.waitFor('document.querySelector("#status-left").textContent.includes("HTML 파일") && document.querySelector("#status-left").textContent.includes("자동 저장됨")');
    const highlight=async()=>{
      await page.evaluate(`(()=>{const doc=document.querySelector('.document-host:not([hidden]) iframe').contentDocument;const walker=doc.createTreeWalker(doc.querySelector('#selection'),NodeFilter.SHOW_TEXT);let node,last;while(node=walker.nextNode())if(node.textContent.trim().length>=8)last=node;const range=doc.createRange();range.setStart(last,0);range.setEnd(last,6);doc.getSelection().removeAllRanges();doc.getSelection().addRange(range);doc.dispatchEvent(new Event('selectionchange'));})()`);
      await page.click('[data-action="highlight"]');await page.waitFor('document.querySelector("#status-left").textContent.includes("앱에 자동 저장됨") && !!document.querySelector("#retry-save")');
    };
    await page.evaluate('window.fileAllowed=false');await highlight();
    const readState=()=>page.evaluate(`(async()=>{const {listDocuments}=await import('./src/storage.js');const record=(await listDocuments())[0];return {html:record.html,annotations:record.metadata.annotations.length,pending:record.diskPending,error:record.diskError?.name};})()`);
    const saved=await readState();assert.equal(saved.annotations,1);assert.equal(saved.pending,true);assert.equal(saved.error,'NotAllowedError');assert.equal(await page.evaluate('window.permissionRequests'),0);
    assert.ok(!await page.evaluate('document.querySelector("#status-left").textContent.includes("자동 저장 실패")'));
    await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/autosave-permission-warning.png'),await page.screenshot());
    await page.click('#retry-save');await page.waitFor('window.permissionRequests===1');assert.equal(await page.evaluate('window.permissionGesture'),true);assert.equal((await readState()).annotations,1);
    await page.click('.tab.document.active .tab-close');await page.waitFor('document.querySelectorAll(".tab.document").length===0');await page.evaluate(`document.querySelector('[data-open]').click()`);
    await page.waitFor('document.querySelector("#status-left").textContent.includes("앱에 자동 저장됨")');assert.equal((await readState()).annotations,1);
    await page.evaluate(`window.pickerRequests=0;window.showSaveFilePicker=async()=>{window.pickerRequests++;throw Error('Unexpected picker during original-file reconnect');};`);
    await page.evaluate(`document.querySelector('[data-action="more"]').click()`);await page.waitFor(`!!document.querySelector('[data-more="connect"]')`);await page.click('[data-more="connect"]');await page.waitFor('window.permissionRequests===2');
    assert.equal(await page.evaluate('window.pickerRequests'),0);assert.equal((await readState()).annotations,1);
    await page.evaluate('window.acceptPermission=true');await page.click('#retry-save');await page.waitFor('!document.querySelector("#retry-save") && document.querySelector("#status-left").textContent.includes("HTML 파일에 자동 저장됨")');
    assert.equal((await readState()).pending,false);
    const sourceAnnotations=()=>page.evaluate(`(async()=>{const root=await navigator.storage.getDirectory();const html=await (await (await root.getFileHandle('source.html')).getFile()).text();return JSON.parse(new DOMParser().parseFromString(html,'text/html').getElementById('htmlmemo-data').textContent).annotations.length;})()`);
    assert.equal(await sourceAnnotations(),1);
    await page.evaluate('window.fileAllowed=false');await highlight();assert.equal((await readState()).annotations,2);
    await page.evaluate(`window.showSaveFilePicker=async()=>{const root=await navigator.storage.getDirectory();return root.getFileHandle('exported.html',{create:true});};`);await page.click('#save-page');
    await page.waitFor('!document.querySelector("#retry-save") && document.querySelector("#status-left").textContent.includes("HTML 파일에 자동 저장됨")');
    const exported=await page.evaluate(`(async()=>{const root=await navigator.storage.getDirectory();const html=await (await (await root.getFileHandle('exported.html')).getFile()).text();return JSON.parse(new DOMParser().parseFromString(html,'text/html').getElementById('htmlmemo-data').textContent).annotations.length;})()`);
    assert.equal(exported,2);assert.equal(await sourceAnnotations(),1);assert.equal((await readState()).annotations,2);
    assert.deepEqual(chrome.errors,[]);
  } catch(error) {
    if(chrome)console.error('Autosave browser diagnostics:',await chrome.page.evaluate(`JSON.stringify({status:document.querySelector('#status-left')?.textContent,tabs:document.querySelectorAll('.tab.document').length,toast:document.querySelector('#toast')?.textContent,errors:[]})`));
    throw error;
  } finally {if(chrome)await chrome.close();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});
