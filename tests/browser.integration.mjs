// Requires permission to bind localhost and launch a dedicated Chrome process.
// These are real browser checks, separate from the DOM/unit test suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { root, prepareAssets } from '../scripts/assets.mjs';
import { createServer } from '../scripts/server.mjs';
import { launchChrome, clickAppMenu } from './chrome.mjs';
import { FORMAT_VERSION } from '../public/src/model.js';
const appVersion=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version;
test('real Chrome: standalone book export keeps lazy chapters and released assets; incomplete copies stay recoverable', {timeout:60000}, async () => {
  await prepareAssets();
  const folder=await mkdtemp(join(tmpdir(),'htmlmemo-book-test-'));
  await cp(join(root,'public'),folder,{recursive:true});
  const server=createServer(folder);let chrome;
  try {
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    chrome=await launchChrome();const page=chrome.page;
    await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
    await page.navigate('http://127.0.0.1:'+server.address().port+'/');
    await page.waitFor('document.querySelector("#file-input")');
    await page.send('DOM.enable');
    const {root:dom}=await page.send('DOM.getDocument');
    const {nodeId}=await page.send('DOM.querySelector',{nodeId:dom.nodeId,selector:'#file-input'});
    await page.send('DOM.setFileInputFiles',{nodeId,files:[join(root,'tests/fixtures/book.html')]});
    const frame='document.querySelector(".document-host:not([hidden]) iframe")';
    await page.waitFor(`${frame}?.contentDocument?.title === 'Complete three-volume fixture' && !document.querySelector('#toolbar').hidden`);
    for(let index=0;index<3;index++) {
      const point=await page.evaluate(`(()=>{const f=${frame},groups=f.contentDocument.querySelectorAll('#reader-tree>details');for(const g of groups)g.open=false;const r=groups[${index}].querySelector('summary').getBoundingClientRect(),b=f.getBoundingClientRect();return {x:b.left+(r.left+r.width/2)*b.width/f.clientWidth,y:b.top+(r.top+r.height/2)*b.height/f.clientHeight};})()`);
      await page.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
      await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
      await page.waitFor(`${frame}.contentDocument.querySelectorAll('#reader-tree>details')[${index}].querySelectorAll('a').length===2`);
    }
    await page.evaluate(`${frame}.contentDocument.querySelector('a[href="#v2%3Alast"]').click()`);
    await page.waitFor(`${frame}.contentDocument.querySelector('#reader-content').dataset.section==='v2:last'`);
    assert.equal(await page.evaluate(`!!${frame}.contentDocument.getElementById('book-asset-0')`),false);
    await page.evaluate(`(()=>{const d=${frame}.contentDocument,p=d.querySelector('#reader-content p'),range=d.createRange();range.setStart(p.firstChild,60);range.setEnd(p.firstChild,80);const s=d.getSelection();s.removeAllRanges();s.addRange(range);d.dispatchEvent(new Event('selectionchange'));})()`);
    await page.click('#toolbar [data-action=highlight]');
    await page.waitFor(`${frame}.contentDocument.querySelector('[data-htmlmemo-mark]') && document.querySelector('#status-left').textContent.includes('자동 저장됨')`);
    await page.evaluate(`window.showSaveFilePicker=async()=>{const d=await navigator.storage.getDirectory();return d.getFileHandle('book-export.html',{create:true});};`);
    await page.click('#save-page');
    await page.waitFor(`(async()=>{const d=await navigator.storage.getDirectory(),file=await(await d.getFileHandle('book-export.html')).getFile();return file.size>0;})()`);
    const result=await page.evaluate(`(async()=>{const d=await navigator.storage.getDirectory(),file=await(await d.getFileHandle('book-export.html')).getFile(),html=await file.text(),doc=new DOMParser().parseFromString(html,'text/html');return {volumes:[0,1,2].map(i=>!!doc.getElementById('book-volume-'+i)),asset:doc.getElementById('book-asset-0')?.textContent,notes:JSON.parse(doc.getElementById('htmlmemo-data').textContent).annotations.length,metadataCount:doc.querySelectorAll('#htmlmemo-data').length};})()`);
    assert.deepEqual(result,{volumes:[true,true,true],asset:'original-image-payload',notes:1,metadataCount:1});
    await page.evaluate(`(async()=>{const d=await navigator.storage.getDirectory(),file=await(await d.getFileHandle('book-export.html')).getFile(),t=new DataTransfer();t.items.add(file);const input=document.querySelector('#file-input');input.files=t.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await page.waitFor(`document.querySelectorAll('.tab.document').length===2 && !document.querySelector('#toolbar').hidden`);
    await page.evaluate(`${frame}.contentWindow.location.hash='#v2%3Alast'`);
    await page.waitFor(`${frame}.contentDocument.querySelector('#reader-content').dataset.section==='v2:last' && ${frame}.contentDocument.querySelector('#reader-content [data-htmlmemo-mark]')`);
    // Model the reported file's structure, without copying the user's document.
    await page.evaluate(`(()=>{const html='<html><head><title>Incomplete saved book</title></head><body><nav id="reader-tree"><details><summary>입문 16</summary></details><details><summary>실전 2302</summary></details><details><summary>용어 4790</summary></details></nav><main id="reader-content"><p>Only the visible first section remains.</p></main></body></html>',t=new DataTransfer();t.items.add(new File([html],'incomplete.html',{type:'text/html'}));const input=document.querySelector('#file-input');input.files=t.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await page.waitFor(`${frame}.contentDocument.title==='Incomplete saved book' && document.querySelector('[data-book-incomplete]') && !document.querySelector('#toolbar').hidden`);
    await page.evaluate('window.pickerCalls=0;window.showSaveFilePicker=async()=>{window.pickerCalls++;throw Error("Must not export a broken book");};');
    await page.click('#save-page');
    await page.waitFor(`!document.querySelector('#toast').hidden && document.querySelector('#toast').textContent.includes('본문 데이터')`);
    assert.equal(await page.evaluate('window.pickerCalls'),0);
    assert.equal(await page.evaluate(`${frame}.contentDocument.querySelector('#reader-content p').textContent`),'Only the visible first section remains.');
    assert.deepEqual(chrome.errors,[]);
  } finally {
    if(chrome)await chrome.close();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});
  }
});
test('real Chrome: browsing, capture, local annotation, file writes, reopen and offline',{timeout:90000},async t=>{
  await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'htmlmemo-web-test-'));await cp(join(root,'public'),folder,{recursive:true});await cp(join(root,'tests/fixtures'),join(folder,'fixtures'),{recursive:true});
  const server=createServer(folder);let chrome;
  try{
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const url=`http://127.0.0.1:${server.address().port}/`;chrome=await launchChrome();const page=chrome.page;
    await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});await page.navigate(url);await page.waitFor('document.querySelector("#status-left").textContent.includes("개의 문서")');
    // The library renders before offline installation finishes. Do not interrupt
    // the first service worker's installation with the navigation below.
    await page.waitFor('!!navigator.serviceWorker.controller');
    await t.test('one address row and one dropdown preserve every action on desktop and mobile',async()=>{
      await page.evaluate("localStorage.setItem('htmlmemo-desk-nav-width-v1','360');");
      await page.navigate(url);await page.waitFor('document.querySelector("#status-left").textContent.includes("개의 문서")');
      await page.evaluate('window.importCalls=0;window.showOpenFilePicker=async()=>{window.importCalls++;return [];};');
      for(const width of [1280,800,390,320]){
        await page.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<600});
        const layout=await page.evaluate(`(()=>{const main=document.querySelector('#main').getBoundingClientRect(),header=document.querySelector('.chrome').getBoundingClientRect(),row=document.querySelector('.addressbar').getBoundingClientRect();return {left:main.left,width:main.width,viewport:innerWidth,oldNavigation:!!document.querySelector('.chrome-topline,.desk-nav,#desk-resizer'),rows:header.height-row.height,controls:['#import-button','#save-page','#app-menu-button'].map(id=>{const element=document.querySelector(id),r=element.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return {id,visible:r.width>0&&r.height>0&&r.left>=0&&r.right<=innerWidth&&element.contains(hit)};})};})()`);
        assert.equal(layout.oldNavigation,false);assert.equal(layout.left,0);assert.equal(layout.width,layout.viewport);assert.equal(layout.rows,1);
        assert.ok(layout.controls.every(control=>control.visible),JSON.stringify({width,...layout}));
        await page.click('#app-menu-button');
        const dropdown=await page.evaluate(`(()=>{const menu=document.querySelector('#app-menu'),m=menu.getBoundingClientRect(),header=document.querySelector('.chrome').getBoundingClientRect();return {anchored:m.top>=header.bottom&&m.left>=0&&m.right<=innerWidth,modal:document.querySelector('#dialog').open,items:[...menu.querySelectorAll('button')].filter(e=>!e.hidden).map(element=>{const r=element.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return element.contains(hit);})};})()`);
        assert.equal(dropdown.anchored,true);assert.equal(dropdown.modal,false);assert.ok(dropdown.items.every(Boolean));
        await clickAppMenu(page,'#about-button');await page.waitFor(`document.querySelector("#dialog").open && document.querySelector("#app-version")?.textContent===${JSON.stringify(appVersion)}`);
        assert.equal(await page.evaluate('document.querySelector(".about-brand h3").textContent'),'HTMLMemo');
        await page.click('#dialog [data-dialog-close]');
        await clickAppMenu(page,'#execution-tab');await page.waitFor('!document.querySelector("#execution").hidden');
        await clickAppMenu(page,'#new-tab');await page.waitFor('!document.querySelector("#library").hidden && document.activeElement.id==="address"');
        await clickAppMenu(page,'#execution-tab');await clickAppMenu(page,'#library-tab');await page.waitFor('!document.querySelector("#library").hidden');
        await page.click('#import-button');
      }
      assert.equal(await page.evaluate('window.importCalls'),4);
      await page.evaluate('delete window.showOpenFilePicker;');
      await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
    });
    await t.test('browser navigation and single-file capture',async()=>{
      await page.evaluate(`document.querySelector('#address').value=${JSON.stringify(url+'fixtures/capture.html')};document.querySelector('#address-form').requestSubmit();`);
      await page.waitFor('document.querySelector(".browser-frame")?.contentDocument?.title === "캡처 검증 문서"');
      // A native OPFS FileSystemFileHandle exercises the same browser write and
      // IndexedDB structured-clone contracts as an external picked file.
      await page.evaluate(`window.showSaveFilePicker=async()=>{const root=await navigator.storage.getDirectory();return root.getFileHandle('picked-document.html',{create:true});};`);
      await page.click('#save-page');await page.waitFor('!document.querySelector("#toolbar").hidden && document.querySelector("#status-left").textContent.includes("자동 저장됨")');
      const html=await page.evaluate(`(async()=>{const root=await navigator.storage.getDirectory();return (await (await root.getFileHandle('picked-document.html')).getFile()).text();})()`);assert.match(html,/data:image\/svg\+xml;base64/);assert.match(html,/htmlmemo-data/);assert.ok(!html.includes('fixtureLoaded'));
    });
    await t.test('local annotation saves internally and exports on request',async()=>{
      await page.evaluate(`(()=>{const doc=document.querySelector('.document-host:not([hidden]) iframe').contentDocument;const text=doc.querySelector('#selection').firstChild;const range=doc.createRange();range.setStart(text,0);range.setEnd(text,15);doc.getSelection().removeAllRanges();doc.getSelection().addRange(range);doc.dispatchEvent(new Event('selectionchange'));})()`);await page.click('[data-action="highlight"]');
      await page.waitFor('document.querySelector(".document-host:not([hidden]) iframe").contentDocument.querySelector("[data-htmlmemo-mark]") && document.querySelector("#status-left").textContent.includes("자동 저장됨")');
      await page.click('#save-page');
      await page.waitFor(`(async()=>{const root=await navigator.storage.getDirectory();const html=await (await (await root.getFileHandle('picked-document.html')).getFile()).text();return JSON.parse(new DOMParser().parseFromString(html,'text/html').getElementById('htmlmemo-data').textContent).annotations.length > 0;})()`);
      const annotation=await page.evaluate(`(async()=>{const root=await navigator.storage.getDirectory();const html=await (await (await root.getFileHandle('picked-document.html')).getFile()).text();return JSON.parse(new DOMParser().parseFromString(html,'text/html').getElementById('htmlmemo-data').textContent).annotations[0];})()`);assert.equal(annotation.type,'highlight');assert.ok(annotation.textAnchor.quote.length);
    });
    await t.test('local file import activates annotation independent of original website URL',async()=>{
      await page.evaluate(`window.showOpenFilePicker=async()=>{const root=await navigator.storage.getDirectory();return [await root.getFileHandle('picked-document.html')];};`);await page.click('#import-button');await page.waitFor('document.querySelectorAll(".tab.document").length === 2 && !document.querySelector("#toolbar").hidden');assert.equal(await page.evaluate('document.querySelector("#local-label").hidden'),false);assert.equal(await page.evaluate('document.querySelector(".document-host:not([hidden]) iframe").contentDocument.querySelectorAll("[data-htmlmemo-mark]").length > 0'),true);
    });
    await t.test('opened documents can be switched from the dropdown without adding a header row',async()=>{
      const previous=await page.evaluate('document.querySelector(".tab.document.active").dataset.tab');
      await clickAppMenu(page,'.tab.document:not(.active) .tab-select');
      assert.notEqual(await page.evaluate('document.querySelector(".tab.document.active").dataset.tab'),previous);
      assert.equal(await page.evaluate('document.querySelector("#app-menu").hidden'),true);
      await clickAppMenu(page,`[data-tab="${previous}"] .tab-select`);
      assert.equal(await page.evaluate('document.querySelector(".chrome").getBoundingClientRect().height'),25);
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
      await clickAppMenu(page,'#library-tab');await page.waitFor('document.querySelectorAll(".document-card").length === 2');await page.click('[data-open]');await page.waitFor('!document.querySelector("#toolbar").hidden');
      // Fullscreen now persists zoom/position changes. Wait for every tab's
      // save indicator to clear before navigation can raise beforeunload.
      await page.waitFor('document.querySelectorAll(".tab-dirty:not([hidden])").length === 0');
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
      await page.waitFor(`document.querySelector('#status-left').textContent.includes('자동 저장됨')`);
      const blobSource=await page.evaluate(`new Promise((resolve,reject)=>{const request=indexedDB.open('HTMLMemo-v1',3);request.onsuccess=()=>{const db=request.result,tx=db.transaction('contents','readonly'),r=tx.objectStore('contents').getAll();tx.oncomplete=()=>{resolve(r.result.some(source=>source.file instanceof Blob && source.file.size>4*1024*1024 && !source.html));db.close();};tx.onabort=()=>reject(tx.error);};})`);assert.equal(blobSource,true);
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
      await clickAppMenu(page,'.tab.active .tab-close');await clickAppMenu(page,'#library-tab');
      await page.evaluate(`(()=>{const card=[...document.querySelectorAll('.document-card')].find(card=>card.textContent.includes('Script generated book'));if(!card)throw Error('Missing saved script book');card.querySelector('[data-open]').click();})()`);
      await page.waitFor('document.querySelector(".document-host:not([hidden]) iframe")?.contentDocument?.title === "Script generated book" && !document.querySelector("#toolbar").hidden');
      await page.evaluate('new Promise(resolve=>setTimeout(resolve,800))');
      await page.waitFor('document.querySelector(".document-host:not([hidden]) iframe").contentDocument.querySelector("#generated [data-htmlmemo-mark]")');

    });
    await t.test('split-pane book with inner scrollable main keeps drawing annotations locked to content during scroll',async()=>{
      await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
      await page.evaluate(`(()=>{const paragraphs=Array.from({length:40},(_,i)=>'<p id="p-'+i+'" style="margin:24px 0;font-size:18px;line-height:1.8">문단 '+i+' — 스크롤 동기화 검증 본문 텍스트입니다.</p>').join('');const html='<!doctype html><html><head><title>Split scroll book</title><style>html,body{height:100vh;margin:0;overflow:hidden}.layout{display:grid;grid-template-columns:240px 1fr;height:100vh}aside.toc{overflow-y:auto;border-right:1px solid #ccc}main{overflow-y:auto;height:100vh;padding:24px}</style></head><body><div class="layout"><aside class="toc"><h2>목차</h2><a href="#p-0">1장</a></aside><main><h1 id="s1">본문</h1>'+paragraphs+'</main></div></body></html>';const transfer=new DataTransfer();transfer.items.add(new File([html],'split-scroll-book.html',{type:'text/html'}));const input=document.querySelector('#file-input');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await page.waitFor('document.querySelector(".document-host:not([hidden]) iframe")?.contentDocument?.title === "Split scroll book" && !document.querySelector("#toolbar").hidden');
      await page.click('#toolbar [data-action="pen"]');
      const targetBox=await page.evaluate(`(()=>{const frame=document.querySelector('.document-host:not([hidden]) iframe'),fr=frame.getBoundingClientRect(),p=frame.contentDocument.querySelector('#p-3'),pr=p.getBoundingClientRect();return {x1:Math.round(fr.left+pr.left+40),y1:Math.round(fr.top+pr.top+12),x2:Math.round(fr.left+pr.left+180),y2:Math.round(fr.top+pr.top+18)};})()`);
      await page.send('Input.dispatchMouseEvent',{type:'mousePressed',x:targetBox.x1,y:targetBox.y1,button:'left',clickCount:1});
      await page.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:targetBox.x2,y:targetBox.y2,button:'left',buttons:1});
      await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:targetBox.x2,y:targetBox.y2,button:'left',clickCount:1});
      await page.waitFor('document.querySelector(".document-host:not([hidden]) iframe").contentDocument.querySelectorAll("#htmlmemo-annotation-layer [data-htmlmemo-id]").length === 1');
      const syncCheck=await page.evaluate(`(()=>{const doc=document.querySelector('.document-host:not([hidden]) iframe').contentDocument,main=doc.querySelector('main'),layer=doc.getElementById('htmlmemo-annotation-layer'),stroke=layer.querySelector('[data-htmlmemo-id]'),para=doc.querySelector('#p-3');const beforePara=para.getBoundingClientRect().top,beforeStroke=stroke.getBoundingClientRect().top;main.scrollTop=320;const afterPara=para.getBoundingClientRect().top,afterStroke=stroke.getBoundingClientRect().top;return {parentTag:layer.parentElement.localName,scrollTop:main.scrollTop,paraDelta:Math.round(afterPara-beforePara),strokeDelta:Math.round(afterStroke-beforeStroke),offsetDiff:Math.abs((afterStroke-afterPara)-(beforeStroke-beforePara))};})()`);
      assert.equal(syncCheck.parentTag,'main');
      assert.equal(syncCheck.scrollTop,320);
      assert.equal(syncCheck.paraDelta,-320);
      assert.equal(syncCheck.strokeDelta,-320);
      assert.ok(syncCheck.offsetDiff<1);
    });
    await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/reader-desktop.png'),await page.screenshot());
    await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await writeFile(join(root,'test-results/reader-mobile.png'),await page.screenshot());assert.deepEqual(chrome.errors,[]);
  }finally{if(chrome)await chrome.close();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});

test('real Chrome: separate annotations, immutable source, durable history, restoration and export',{timeout:90000},async()=>{
  await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'htmlmemo-history-test-'));await cp(join(root,'public'),folder,{recursive:true});
  const server=createServer(folder);let chrome;
  try {
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const url=process.env.HTMLMEMO_AUTOSAVE_TEST_URL || `http://127.0.0.1:${server.address().port}/`;
    chrome=await launchChrome();const page=chrome.page;
    await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
    await page.navigate(url);await page.waitFor('document.querySelector("#status-left").textContent.includes("개의 문서")');
    await page.evaluate(`(async()=>{
      const root=await navigator.storage.getDirectory();const handle=await root.getFileHandle('source.html',{create:true});const writer=await handle.createWritable();
      window.sourceHTML='<html><head><title>Annotation history</title></head><body><p id="selection">Local source text remains unchanged across annotation history.</p></body></html>';
      await writer.write(window.sourceHTML);await writer.close();window.showOpenFilePicker=async()=>[handle];
      window.permissionRequests=0;const query=FileSystemHandle.prototype.queryPermission;
      FileSystemHandle.prototype.queryPermission=async function(options){if(this.name==='source.html'){window.permissionRequests++;return 'prompt';}return query.call(this,options);};
      FileSystemHandle.prototype.requestPermission=async function(){window.permissionRequests++;return 'denied';};
    })()`);
    await page.click('#import-button');await page.waitFor('document.querySelector("#status-left").textContent.includes("주석이 앱에 자동 저장됨")');
    const state=()=>page.evaluate(`(async()=>{const {listDocuments,listRevisions,getDocument}=await import('./src/storage.js');const record=await getDocument((await listDocuments())[0].id);return {id:record.id,html:record.html,metadata:record.metadata,revisions:await listRevisions(record.id),pending:record.diskPending,error:record.diskError};})()`);
    const first=await state();assert.equal(first.revisions.length,1);assert.equal(first.revisions[0].annotations.length,0);
    const highlight=async()=>{
      await page.evaluate(`(()=>{const doc=document.querySelector('.document-host:not([hidden]) iframe').contentDocument;const walker=doc.createTreeWalker(doc.querySelector('#selection'),NodeFilter.SHOW_TEXT);let node,last;while(node=walker.nextNode())if(node.textContent.trim().length>=8)last=node;const range=doc.createRange();range.setStart(last,0);range.setEnd(last,6);doc.getSelection().removeAllRanges();doc.getSelection().addRange(range);doc.dispatchEvent(new Event('selectionchange'));})()`);
      await page.click('[data-action="highlight"]');
      await page.waitFor(`!document.querySelector('.tab-dirty:not([hidden])') && document.querySelector('#status-left').textContent.includes('주석이 앱에 자동 저장됨')`);
    };
    await highlight();const second=await state();assert.equal(second.metadata.annotations.length,1);assert.equal(second.revisions.length,2);assert.equal(second.html,first.html);
    const separate=await page.evaluate(`new Promise((resolve,reject)=>{const request=indexedDB.open('HTMLMemo-v1',3);request.onsuccess=()=>{const db=request.result,tx=db.transaction(['documents','contents'],'readonly'),docs=tx.objectStore('documents').getAll(),contents=tx.objectStore('contents').getAll();tx.oncomplete=()=>{resolve({documentHasHTML:Object.hasOwn(docs.result[0],'html'),contents:contents.result.length,html:contents.result[0].html});db.close();};tx.onabort=()=>reject(tx.error);};request.onerror=()=>reject(request.error);})`);
    assert.equal(separate.documentHasHTML,false);assert.equal(separate.contents,1);assert.equal(separate.html,first.html);
    // View changes persist, but do not duplicate annotation history or serialize a new body.
    await page.evaluate(`document.querySelector('.document-host:not([hidden]) .reader-viewport').dispatchEvent(new Event('scroll'))`);
    await page.waitFor(`!document.querySelector('.tab-dirty:not([hidden])')`);assert.equal((await state()).revisions.length,2);
    await highlight();const third=await state();assert.equal(third.metadata.annotations.length,2);assert.equal(third.revisions.length,3);assert.equal(third.html,first.html);
    assert.equal(await page.evaluate('window.permissionRequests'),0);assert.equal(await page.evaluate('!!document.querySelector("#retry-save")'),false);
    const openHistory=async()=>{await page.evaluate(`document.querySelector('[data-action="more"]').click()`);await page.waitFor(`!!document.querySelector('[data-more="history"]')`);await page.click('[data-more="history"]');await page.waitFor(`!!document.querySelector('[data-revision]')`);};
    const restore=async id=>{await openHistory();await page.click(`[data-revision="${id}"]`);await page.waitFor(`!!document.querySelector('#restore-revision')`);await page.click('#restore-revision');await page.waitFor(`!document.querySelector('#dialog').open && !document.querySelector('.tab-dirty:not([hidden])')`);};
    await restore(second.revisions[1].id);const restored=await state();assert.equal(restored.metadata.annotations.length,1);assert.equal(restored.revisions.length,4);assert.equal(restored.revisions.at(-1).kind,'restore');assert.equal(restored.revisions.at(-1).restoredFrom,second.revisions[1].id);assert.equal(restored.html,first.html);
    // The two-annotation state remains available, making restoration itself reversible.
    await restore(third.revisions[2].id);assert.equal((await state()).metadata.annotations.length,2);
    await restore(first.revisions[0].id);assert.equal((await state()).metadata.annotations.length,0);
    await restore(third.revisions[2].id);
    await openHistory();await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/annotation-history-desktop.png'),await page.screenshot());
    await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await writeFile(join(root,'test-results/annotation-history-mobile.png'),await page.screenshot());
    assert.equal(await page.evaluate(`document.querySelector('#dialog').getBoundingClientRect().width <= innerWidth`),true);
    await page.evaluate(`document.querySelector('#dialog').close()`);await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
    await clickAppMenu(page,'.tab.document.active .tab-close');await page.waitFor('document.querySelectorAll(".tab.document").length===0');await page.evaluate(`document.querySelector('[data-open]').click()`);await page.waitFor(`document.querySelector('.document-host:not([hidden]) iframe')?.contentDocument?.querySelectorAll('[data-htmlmemo-mark]').length===2`);
    await page.waitFor(`!document.querySelector('.tab-dirty:not([hidden])')`);const beforeReload=await state();
    await page.navigate(url);await page.waitFor(`!!document.querySelector('[data-open]')`);await page.evaluate(`document.querySelector('[data-open]').click()`);await page.waitFor(`document.querySelector('.document-host:not([hidden]) iframe')?.contentDocument?.querySelectorAll('[data-htmlmemo-mark]').length===2`);
    assert.equal((await state()).revisions.length,beforeReload.revisions.length);
    await page.evaluate(`window.showSaveFilePicker=async()=>{const root=await navigator.storage.getDirectory();return root.getFileHandle('exported.html',{create:true});};`);await page.click('#save-page');
    await page.waitFor(`document.querySelector('#toast').textContent.includes('현재 주석을 포함한 HTML을 내보냈습니다')`);
    const exported=await page.evaluate(`(async()=>{const root=await navigator.storage.getDirectory();const source=await (await (await root.getFileHandle('source.html')).getFile()).text();const html=await (await (await root.getFileHandle('exported.html')).getFile()).text();const doc=new DOMParser().parseFromString(html,'text/html');return {source,annotations:JSON.parse(doc.getElementById('htmlmemo-data').textContent).annotations.length};})()`);
    assert.equal(exported.source,'<html><head><title>Annotation history</title></head><body><p id="selection">Local source text remains unchanged across annotation history.</p></body></html>');assert.equal(exported.annotations,2);
    // Simulate legacy v1 data and verify upgrade without losing documents or preferences.
    await clickAppMenu(page,'.tab.document.active .tab-close');await page.waitFor(`document.querySelectorAll('.tab.document').length===0`);
    await page.evaluate(`(async()=>{await new Promise((resolve,reject)=>{const r=indexedDB.deleteDatabase('HTMLMemo-v1');r.onsuccess=resolve;r.onerror=()=>reject(r.error);});await new Promise((resolve,reject)=>{const r=indexedDB.open('HTMLMemo-v1',1);r.onupgradeneeded=()=>{r.result.createObjectStore('documents',{keyPath:'id'});r.result.createObjectStore('settings');};r.onsuccess=()=>{const db=r.result,tx=db.transaction(['documents','settings'],'readwrite');tx.objectStore('documents').put({...${JSON.stringify(first)},title:'Annotation history',name:'source.html',created:Date.now(),modified:Date.now()});tx.objectStore('settings').put('legacy retained','migration-test');tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>reject(tx.error);};r.onerror=()=>reject(r.error);});})()`);
    await page.navigate(url);await page.waitFor(`!!document.querySelector('[data-open]')`);await page.evaluate(`document.querySelector('[data-open]').click()`);await page.waitFor(`!!document.querySelector('[data-action="more"]')`);
    const migrated=await state();assert.equal(migrated.id,first.id);assert.equal(migrated.html,first.html);assert.equal(migrated.revisions.length,1);
    assert.equal(await page.evaluate(`(async()=>{const {getSetting}=await import('./src/storage.js');return getSetting('migration-test');})()`),'legacy retained');
    // A failed structured clone aborts both stores; it cannot leave an orphan revision.
    const atomic=await page.evaluate(`(async()=>{const {listDocuments,listRevisions,putDocumentRevision}=await import('./src/storage.js');const record=(await listDocuments())[0];record.metadata.annotations=[{id:'rejected'}];record.uncloneable=()=>{};try{await putDocumentRevision(record);return false;}catch{}return (await listRevisions(record.id)).length===1 && (await listDocuments())[0].metadata.annotations.length===0;})()`);assert.equal(atomic,true);
    assert.deepEqual(chrome.errors,[]);
  } catch(error) {
    if(chrome)console.error('History browser diagnostics:',await chrome.page.evaluate(`JSON.stringify({status:document.querySelector('#status-left')?.textContent,toast:document.querySelector('#toast')?.textContent,dialog:document.querySelector('#dialog')?.textContent})`));throw error;
  } finally {if(chrome)await chrome.close();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});

test('real Chrome: self-observing HTML settles without overlay resize feedback or scroll jitter',{timeout:45000},async()=>{
  await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'htmlmemo-jitter-test-'));await cp(join(root,'public'),folder,{recursive:true});
  const server=createServer(folder);let chrome;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));chrome=await launchChrome();const page=chrome.page;
    const url=process.env.HTMLMEMO_JITTER_TEST_URL || `http://127.0.0.1:${server.address().port}/`;
    await page.send('Emulation.setDeviceMetricsOverride',{width:1281,height:903,deviceScaleFactor:1,mobile:false});await page.navigate(url);
    await page.waitFor('document.querySelector("#status-left").textContent.includes("개의 문서")');
    await page.evaluate(`(()=>{const source='<html><head><title>Self observing book</title><style>body{margin:0;width:1000px}main{height:3000px}::-webkit-scrollbar{width:15px;height:15px}</style></head><body><main><h1>Stable book</h1><p>Annotation layer must not trigger another document layout.</p></main><script>window.relayouts=0;new MutationObserver(()=>{window.relayouts++;document.body.style.width=window.relayouts%2?"900px":"1000px"}).observe(document.body,{childList:true});<'+'/script></body></html>';const transfer=new DataTransfer();transfer.items.add(new File([source],'self-observing.html',{type:'text/html'}));const input=document.querySelector('#file-input');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await page.waitFor(`document.querySelector('.document-host:not([hidden]) iframe')?.contentDocument?.getElementById('htmlmemo-annotation-layer') && document.querySelector('#status-left').textContent.includes('자동 저장됨')`);
    await page.evaluate(`new Promise(resolve=>setTimeout(resolve,1000))`);
    const samples=await page.evaluate(`new Promise(resolve=>{const frame=document.querySelector('.document-host:not([hidden]) iframe'),doc=frame.contentDocument,viewport=frame.closest('.reader-viewport'),layer=doc.getElementById('htmlmemo-annotation-layer');const samples=[];let replaced=0;const observer=new MutationObserver(records=>{for(const record of records)for(const node of record.addedNodes)if(node.id==='htmlmemo-annotation-layer')replaced++;});observer.observe(doc.body,{childList:true});doc.defaultView.scrollTo(0,300);function tick(){samples.push({width:doc.body.getBoundingClientRect().width,height:frame.getBoundingClientRect().height,scroll:doc.defaultView.scrollY,relayouts:doc.defaultView.relayouts});if(samples.length<90)requestAnimationFrame(tick);else{observer.disconnect();resolve({samples,replaced,sameLayer:doc.getElementById('htmlmemo-annotation-layer')===layer,overflow:getComputedStyle(viewport).overflowY});}}requestAnimationFrame(tick);})`);
    console.log('Layout measurement:',JSON.stringify({first:samples.samples[0],last:samples.samples.at(-1),replaced:samples.replaced}));
    assert.ok(Number.isFinite(samples.samples[0].relayouts));
    assert.equal(samples.replaced,0);assert.equal(samples.sameLayer,true);assert.equal(samples.overflow,'hidden');
    assert.equal(new Set(samples.samples.map(s=>s.width)).size,1);assert.equal(new Set(samples.samples.map(s=>s.height)).size,1);assert.equal(new Set(samples.samples.map(s=>s.scroll)).size,1);assert.equal(samples.samples[0].scroll,300);assert.equal(new Set(samples.samples.map(s=>s.relayouts)).size,1);
    // Actual window resizing still updates fitted width; manual zoom remains usable.
    await page.send('Emulation.setDeviceMetricsOverride',{width:1001,height:801,deviceScaleFactor:1,mobile:false});await page.evaluate(`new Promise(resolve=>setTimeout(resolve,200))`);
    await page.evaluate(`document.querySelector('[data-action="zoom"]').click()`);await page.waitFor(`!!document.querySelector('#zoom-value')`);await page.evaluate(`const input=document.querySelector('#zoom-value');input.value='125';input.dispatchEvent(new Event('change',{bubbles:true}));`);await page.waitFor(`document.querySelector('#toolbar [data-action="zoom"]').textContent==='125%'`);
    assert.deepEqual(chrome.errors,[]);
  }finally{if(chrome)await chrome.close();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});

test('real Chrome: large library and annotation autosave never deserialize book bodies',{timeout:60000},async()=>{
 await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'htmlmemo-library-test-'));await cp(join(root,'public'),folder,{recursive:true});
 const server=createServer(folder);let chrome;
 try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));chrome=await launchChrome();const page=chrome.page;
  const url=process.env.HTMLMEMO_JITTER_TEST_URL || `http://127.0.0.1:${server.address().port}/`;
  await page.send('Page.addScriptToEvaluateOnNewDocument',{source:`window.contentReads=0;const get=IDBObjectStore.prototype.get;IDBObjectStore.prototype.get=function(...args){if(this.name==='contents')window.contentReads++;return get.apply(this,args);};`});
  await page.navigate(url);await page.waitFor(`document.querySelector('#status-left').textContent.includes('개의 문서')`);
  await page.evaluate(`(async()=>{const {putDocumentRevision}=await import('./src/storage.js'),{parseHTML}=await import('./src/document.js');const metadata=parseHTML('<html><head><title>Large book</title></head><body>Source</body></html>').metadata;const html='<html><head><title>Large book</title></head><body><p id=large>Large book text</p><!--'+'x'.repeat(4*1024*1024)+'--></body></html>';for(let i=0;i<6;i++)await putDocumentRevision({id:'large-'+i,title:'Large '+i,name:'large-'+i+'.html',html,metadata:structuredClone(metadata),created:Date.now(),modified:Date.now()});})()`);
  await page.navigate(url);await page.waitFor(`document.querySelectorAll('.document-card').length===6`);
  assert.equal(await page.evaluate('window.contentReads'),0);
  const result=await page.evaluate(`(async()=>{const {listDocuments,putDocumentRevision,listRevisionSummaries,getRevision}=await import('./src/storage.js');const records=await listDocuments();const noBodies=records.every(r=>!Object.hasOwn(r,'html'));window.contentReads=0;const started=performance.now();for(let i=0;i<60;i++){records[0].metadata.view.scrollTop=i;await putDocumentRevision(records[0]);}const elapsed=performance.now()-started;for(let i=0;i<56;i++){records[0].metadata.bookmarks=[{id:'mark-'+i,title:'Mark '+i,top:i,left:0}];await putDocumentRevision(records[0]);}const first=await listRevisionSummaries(records[0].id),older=await listRevisionSummaries(records[0].id,first.at(-1).id);const version=await getRevision(first[0].id);return {noBodies,reads:window.contentReads,elapsed,headers:first.length,older:older.length,unique:new Set([...first,...older].map(v=>v.id)).size,fullHeader:first.some(v=>Object.hasOwn(v,'annotations')),versionBookmarks:version.bookmarks.length};})()`);
  assert.equal(result.noBodies,true);assert.equal(result.reads,0);assert.equal(result.headers,50);assert.equal(result.older,7);assert.equal(result.unique,57);assert.equal(result.fullHeader,false);assert.equal(result.versionBookmarks,1);
  console.log('Large-library measurement:',JSON.stringify(result));
  await page.evaluate(`document.querySelector('[data-open="large-1"]').click()`);await page.waitFor(`document.querySelector('.document-host:not([hidden]) iframe')?.contentDocument?.getElementById('large') && document.querySelector('#status-left').textContent.includes('자동 저장됨')`);
  assert.equal(await page.evaluate('window.contentReads'),1);
  await clickAppMenu(page,'.tab.document.active .tab-close');await page.waitFor(`document.querySelectorAll('.tab.document').length===0`);assert.equal(await page.evaluate('window.contentReads'),1);
  assert.deepEqual(chrome.errors,[]);
 }finally{if(chrome)await chrome.close();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});

test('real Chrome: saved date, modified date and title sort in both directions and persist across reloads',{timeout:45000},async()=>{
  await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'htmlmemo-sort-test-'));await cp(join(root,'public'),folder,{recursive:true});
  const server=createServer(folder);let chrome;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));chrome=await launchChrome();const page=chrome.page;
    const url=process.env.HTMLMEMO_SORT_TEST_URL||`http://127.0.0.1:${server.address().port}/`;
    await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
    await page.navigate(url);await page.waitFor('document.querySelector("#status-left").textContent.includes("개의 문서")');
    await page.evaluate(`(async()=>{const {putDocumentRevision}=await import('./src/storage.js'),{parseHTML}=await import('./src/document.js');const day=n=>Date.UTC(2026,0,n),html='<html><head><title>Sort fixture</title></head><body>Sort fixture</body></html>',metadata=parseHTML(html).metadata;for(const record of [{id:'a',title:'가나다',created:day(1),modified:day(6)},{id:'b',title:'나다라',created:day(3),modified:day(5)},{id:'c',title:'다라마',created:day(2),modified:day(4)}])await putDocumentRevision({...record,name:record.id+'.html',html,metadata:structuredClone(metadata)});})()`);
    await page.navigate(url);await page.waitFor('document.querySelectorAll(".document-card").length===3');
    const select=async(field,direction)=>page.evaluate(`(()=>{const sort=document.querySelector('#library-sort');sort.value=${JSON.stringify(field+':'+direction)};sort.dispatchEvent(new Event('change'));return [...document.querySelectorAll('.document-card')].map(e=>e.dataset.record);})()`);
    assert.equal(await page.evaluate('document.querySelectorAll(".library-controls select").length'),1);
    assert.equal(await page.evaluate('document.querySelectorAll("#library-sort option").length'),6);
    const cases=[['created','asc',['a','c','b']],['created','desc',['b','c','a']],['modified','asc',['c','b','a']],['modified','desc',['a','b','c']],['title','asc',['a','b','c']],['title','desc',['c','b','a']]];
    for(const view of ['card','list']){
      await page.click('#library-'+view+'-view');
      for(const [field,direction,expected] of cases){
        assert.deepEqual(await select(field,direction),expected);
        assert.match(await page.evaluate('document.querySelector(".list-date").getAttribute("title")'),field==='created'?/^저장일:/u:/^수정일:/u);
      }
    }
    await select('created','asc');await page.navigate(url);await page.waitFor('document.querySelectorAll(".document-card").length===3');
    assert.deepEqual(await page.evaluate(`({sort:document.querySelector('#library-sort').value,view:document.querySelector('#document-grid').dataset.view,order:[...document.querySelectorAll('.document-card')].map(e=>e.dataset.record)})`),{sort:'created:asc',view:'list',order:['a','c','b']});
    for(const width of [1280,800,600,390,320]){
      await page.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<600});
      const controls=await page.evaluate(`['#library-filter','#library-sort','.library-view-switch'].map(id=>{const element=document.querySelector(id),r=element.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return {id,visible:r.width>0&&r.left>=0&&r.right<=innerWidth&&element.contains(hit)};})`);
      assert.ok(controls.every(control=>control.visible),JSON.stringify({width,controls}));
      if(width===1280||width===320){await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,`test-results/library-sort-${width}.png`),await page.screenshot());}
    }
    assert.deepEqual(chrome.errors,[]);
  }finally{if(chrome)await chrome.close();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});
