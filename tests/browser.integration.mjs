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
      await page.click('#reader-fullscreen');await page.waitFor('!document.querySelector("#app").classList.contains("reader-focus")');
      await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
      await page.click('#reader-fullscreen');await page.waitFor('document.querySelector("#app").classList.contains("reader-focus")');
      await writeFile(join(root,'test-results/reader-focus-mobile.png'),await page.screenshot());
      await page.click('#reader-fullscreen');await page.waitFor('!document.querySelector("#app").classList.contains("reader-focus")');
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
    await t.test('large native File import is shown without a full JavaScript file read; tools and autosave remain usable',async()=>{
      await page.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
      await page.evaluate(`(()=>{const file=new File(['<html><head><title>Native large book</title>', '<script id="htmlmemo-data" type="application/json">'+JSON.stringify({version:${FORMAT_VERSION},view:{zoom:.5,scrollTop:0,scrollLeft:0},annotations:[]})+'<'+'/script>', '<meta http-equiv="refresh" content="0;url=https://example.invalid/"></head><body><p id="first">Native first paragraph</p><script>parent.__unsafeImport=true<\\/script><div>'+ 'Book text '.repeat(500000)+'</div><p id="last">Last paragraph</p></body></html>'],'native-large.html',{type:'text/html'});file.arrayBuffer=()=>{throw Error('Whole file read is forbidden');};file.text=()=>{throw Error('Whole text read is forbidden');};const transfer=new DataTransfer();transfer.items.add(file);const input=document.querySelector('#file-input');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await page.waitFor('document.querySelector(".document-host:not([hidden]) iframe")?.contentDocument?.title === "Native large book" && !document.querySelector("#toolbar").hidden',30000);
      assert.equal(await page.evaluate('window.__unsafeImport===true'),false);
      assert.equal(await page.evaluate('document.querySelector(".document-host:not([hidden]) iframe").contentDocument.querySelector("#last").textContent'),'Last paragraph');
      const height=await page.evaluate('document.querySelector("#toolbar").getBoundingClientRect().height');assert.ok(height>=20&&height<=22);
      await page.waitFor('document.querySelector("#toolbar [data-action=zoom]").textContent === "50%"');
      await page.click('#reader-fullscreen');
      await page.waitFor(`(()=>{const app=document.querySelector('#app'),viewport=document.querySelector('.document-host:not([hidden]) .reader-viewport'),frame=viewport.querySelector('iframe');const v=viewport.getBoundingClientRect(),f=frame.getBoundingClientRect();return app.classList.contains('reader-focus') && Math.abs(f.left-v.left)<1 && Math.abs(f.width-viewport.clientWidth)<1;})()`);
      await page.click('#reader-fullscreen');await page.waitFor('!document.querySelector("#app").classList.contains("reader-focus") && document.querySelector("#toolbar [data-action=zoom]").textContent === "50%"');
      await page.evaluate(`(()=>{const doc=document.querySelector('.document-host:not([hidden]) iframe').contentDocument;const range=doc.createRange();range.selectNodeContents(doc.querySelector('#first'));const selection=doc.getSelection();selection.removeAllRanges();selection.addRange(range);doc.dispatchEvent(new Event('selectionchange'));})()`);
      await page.click('[data-action="highlight"]');await page.waitFor('document.querySelector(".document-host:not([hidden]) iframe").contentDocument.querySelector("[data-htmlmemo-mark]") && document.querySelector("#status-left").textContent.includes("자동 저장됨")',30000);
    });
    await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/reader-desktop.png'),await page.screenshot());
    await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await writeFile(join(root,'test-results/reader-mobile.png'),await page.screenshot());assert.deepEqual(chrome.errors,[]);
  }finally{if(chrome)await chrome.close();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});
