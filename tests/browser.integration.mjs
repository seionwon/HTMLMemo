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
import { deflateRawSync } from 'node:zlib';
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
        const layout=await page.evaluate(`(()=>{const main=document.querySelector('#main').getBoundingClientRect(),header=document.querySelector('.chrome').getBoundingClientRect(),row=document.querySelector('.addressbar').getBoundingClientRect();return {left:main.left,width:main.width,viewport:innerWidth,oldNavigation:!!document.querySelector('.chrome-topline,.desk-nav,#desk-resizer'),rows:header.height-row.height,controls:['#library-tab','#import-button','#save-page','#app-menu-button'].map(id=>{const element=document.querySelector(id),r=element.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return {id,visible:r.width>0&&r.height>0&&r.left>=0&&r.right<=innerWidth&&element.contains(hit)};})};})()`);
        assert.equal(layout.oldNavigation,false);assert.equal(layout.left,0);assert.equal(layout.width,layout.viewport);assert.equal(layout.rows,1);
        assert.ok(layout.controls.every(control=>control.visible),JSON.stringify({width,...layout}));
        assert.deepEqual(await page.evaluate(`['#library-tab','#import-button','#save-page'].map(id=>{const element=document.querySelector(id);return {text:element.textContent,title:element.title,label:element.getAttribute('aria-label'),width:element.getBoundingClientRect().width,icon:!!element.querySelector('svg')};})`),[{text:'',title:'내 서재',label:'내 서재',width:26,icon:true},{text:'',title:'HTML 파일 가져오기',label:'HTML 파일 가져오기',width:26,icon:true},{text:'',title:'페이지 저장',label:'페이지 저장',width:26,icon:true}]);
        await page.click('#app-menu-button');
        const dropdown=await page.evaluate(`(()=>{const menu=document.querySelector('#app-menu'),m=menu.getBoundingClientRect(),header=document.querySelector('.chrome').getBoundingClientRect();return {anchored:m.top>=header.bottom&&m.left>=0&&m.right<=innerWidth,modal:document.querySelector('#dialog').open,items:[...menu.querySelectorAll('button')].filter(e=>!e.hidden).map(element=>{const r=element.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return element.contains(hit);})};})()`);
        assert.equal(dropdown.anchored,true);assert.equal(dropdown.modal,false);assert.ok(dropdown.items.every(Boolean));
        await clickAppMenu(page,'#about-button');await page.waitFor(`document.querySelector("#dialog").open && document.querySelector("#app-version")?.textContent===${JSON.stringify(appVersion)}`);
        assert.equal(await page.evaluate('document.querySelector(".about-brand h3").textContent'),'HTMLMemo');
        await page.click('#dialog [data-dialog-close]');
        await clickAppMenu(page,'#execution-tab');await page.waitFor('!document.querySelector("#execution").hidden');
        await clickAppMenu(page,'#new-tab');await page.waitFor('!document.querySelector("#library").hidden && document.activeElement.id==="address"');
        await clickAppMenu(page,'#execution-tab');await page.click('#library-tab');await page.waitFor('!document.querySelector("#library").hidden');
        await page.click('#import-button');
      }
      assert.equal(await page.evaluate('window.importCalls'),4);
      await page.evaluate('delete window.showOpenFilePicker;');
      await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
    });
    await t.test('browser navigation and single-file capture',async()=>{
      await page.evaluate(`document.querySelector('#address').value=${JSON.stringify(url+'fixtures/capture.html')};document.querySelector('#address-form').requestSubmit();`);
      await page.waitFor('document.querySelector(".browser-frame")?.contentDocument?.title === "캡처 검증 문서"');
      assert.equal(await page.evaluate('document.querySelector("#save-page").title'),'페이지 저장');
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
    await t.test('opened documents have visible tabs that switch without adding a header row',async()=>{
      assert.deepEqual(await page.evaluate(`(()=>{const button=document.querySelector('#save-page');return {text:button.textContent,title:button.title,label:button.getAttribute('aria-label')};})()`),{text:'',title:'HTML 내보내기',label:'HTML 내보내기'});
      const previous=await page.evaluate('document.querySelector(".tab.document.active").dataset.tab');
      await page.click('.tab.document:not(.active) .tab-select');
      assert.notEqual(await page.evaluate('document.querySelector(".tab.document.active").dataset.tab'),previous);
      assert.equal(await page.evaluate('document.querySelector("#app-menu").hidden'),true);
      await page.click(`[data-tab="${previous}"] .tab-select`);
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
      await page.click('#library-tab');await page.waitFor('document.querySelectorAll(".document-card").length === 2');await page.click('[data-open]');await page.waitFor('!document.querySelector("#toolbar").hidden');
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
      await page.click('.tab.active .tab-close');await page.click('#library-tab');
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
    await page.click('.tab.document.active .tab-close');await page.waitFor('document.querySelectorAll(".tab.document").length===0');await page.evaluate(`document.querySelector('[data-open]').click()`);await page.waitFor(`document.querySelector('.document-host:not([hidden]) iframe')?.contentDocument?.querySelectorAll('[data-htmlmemo-mark]').length===2`);
    await page.waitFor(`!document.querySelector('.tab-dirty:not([hidden])')`);const beforeReload=await state();
    await page.navigate(url);await page.waitFor(`!!document.querySelector('[data-open]')`);await page.evaluate(`document.querySelector('[data-open]').click()`);await page.waitFor(`document.querySelector('.document-host:not([hidden]) iframe')?.contentDocument?.querySelectorAll('[data-htmlmemo-mark]').length===2`);
    assert.equal((await state()).revisions.length,beforeReload.revisions.length);
    await page.evaluate(`window.showSaveFilePicker=async()=>{const root=await navigator.storage.getDirectory();return root.getFileHandle('exported.html',{create:true});};`);await page.click('#save-page');
    await page.waitFor(`document.querySelector('#toast').textContent.includes('현재 주석을 포함한 HTML을 내보냈습니다')`);
    const exported=await page.evaluate(`(async()=>{const root=await navigator.storage.getDirectory();const source=await (await (await root.getFileHandle('source.html')).getFile()).text();const html=await (await (await root.getFileHandle('exported.html')).getFile()).text();const doc=new DOMParser().parseFromString(html,'text/html');return {source,annotations:JSON.parse(doc.getElementById('htmlmemo-data').textContent).annotations.length};})()`);
    assert.equal(exported.source,'<html><head><title>Annotation history</title></head><body><p id="selection">Local source text remains unchanged across annotation history.</p></body></html>');assert.equal(exported.annotations,2);
    // Simulate legacy v1 data and verify upgrade without losing documents or preferences.
    await page.click('.tab.document.active .tab-close');await page.waitFor(`document.querySelectorAll('.tab.document').length===0`);
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

test('real Chrome: an annotated file is first shown with restored notes, zoom and reading position',{timeout:60000},async()=>{
  await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'htmlmemo-annotation-opening-'));await cp(join(root,'public'),folder,{recursive:true});
  const server=createServer(folder);let chrome;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));chrome=await launchChrome();const page=chrome.page;
    const url=process.env.HTMLMEMO_OPENING_TEST_URL||`http://127.0.0.1:${server.address().port}/`;
    await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});await page.navigate(url);
    await page.waitFor('document.querySelector("#status-left").textContent.includes("개의 문서")');
    await page.evaluate(`window.observeOpening=()=>{window.openingSamples=[];window.openingDone=false;let count=0;const sample=()=>{const frame=document.querySelector('.document-host:not([hidden]) iframe'),doc=frame?.contentDocument;if(doc?.title==='Restored annotations'){const style=getComputedStyle(frame);window.openingSamples.push({visible:style.visibility==='visible'&&Number(style.opacity)>0,legacy:!!doc.querySelector('#legacy-preview'),notes:doc.querySelectorAll('[data-htmlmemo-id="saved-note"]').length,marks:doc.querySelectorAll('[data-htmlmemo-mark]').length,scroll:doc.defaultView.scrollY,scale:parseFloat(frame.style.transform.slice(6))||1});}if(++count<90)requestAnimationFrame(sample);else window.openingDone=true;};requestAnimationFrame(sample);};`);
    await page.evaluate(`(()=>{
      window.observeOpening();
      const metadata={version:${FORMAT_VERSION},title:'Restored annotations',viewport:{width:1100,height:800},view:{zoom:.75,autoFit:false,scrollTop:600,scrollLeft:0},bookmarks:[],annotations:[{id:'saved-note',type:'note',anchor:'body',points:[{x:.1,y:.2}],text:'Saved note',color:'#edcf67',width:3,opacity:1},{id:'saved-highlight',type:'highlight',color:'#edcf67',width:3,opacity:.35,textAnchor:{start:0,end:7,quote:'Opening'}}]};
      const html='<html><head><title>Restored annotations</title><style>body{margin:0}main{height:6000px;background:linear-gradient(#fff,#eef3ff)}</style><script id="htmlmemo-data" type="application/json">'+JSON.stringify(metadata)+'<'+'/script></head><body><p><span data-htmlmemo-mark data-htmlmemo-id="saved-highlight">Opening</span> content keeps its original annotations.</p><main>Reading content</main><svg id="htmlmemo-annotation-layer" style="position:absolute;left:0;top:0;overflow:visible"><g data-htmlmemo-id="saved-note"><text id="legacy-preview" x="10" y="20">Saved note</text></g></svg><!--'+'x'.repeat(4*1024*1024)+'--></body></html>';
      const transfer=new DataTransfer();transfer.items.add(new File([html],'annotated-opening.html',{type:'text/html'}));const input=document.querySelector('#file-input');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
    const checkOpening=async()=>{
      await page.waitFor('window.openingDone');
      const samples=await page.evaluate('window.openingSamples'),shown=samples.filter(sample=>sample.visible);
      console.log('Annotation opening:',JSON.stringify({samples:samples.length,shown:shown.length,legacyShown:shown.filter(sample=>sample.legacy).length,first:shown[0]}));
      assert.ok(samples.length>0);assert.ok(shown.length>0);
      assert.equal(shown.some(sample=>sample.legacy),false,'the saved overlay must never paint before restoration');
      assert.ok(shown.every(sample=>sample.notes===1&&sample.marks===1&&sample.scale===.75&&Math.abs(sample.scroll-800)<1),JSON.stringify(shown.slice(0,5)));
      assert.equal(await page.evaluate('document.querySelector(".document-host:not([hidden]) .reader-viewport").getAttribute("aria-busy")'),'false');
      assert.equal(await page.evaluate('!!document.querySelector(".document-host:not([hidden]) .reader-loading")'),false);
    };
    await checkOpening();
    await page.waitFor('document.querySelector("#status-left").textContent.includes("자동 저장됨")');
    await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/annotation-opening-ready.png'),await page.screenshot());
    await page.click('#tabs .tab.active .tab-close');await page.waitFor('document.querySelectorAll("#tabs .tab").length===0');
    await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    await page.evaluate('window.observeOpening()');await page.click('[data-open]');await checkOpening();
    await writeFile(join(root,'test-results/annotation-opening-mobile.png'),await page.screenshot());
    // A preparation failure must remove the hidden document and loading state.
    await page.evaluate(`(()=>{const html='<html><head><title>Invalid annotations</title><script id="htmlmemo-data" type="application/json">{"version":999,"annotations":[]}<'+'/script></head><body>Invalid annotations<!--'+'x'.repeat(4*1024*1024)+'--></body></html>';const transfer=new DataTransfer();transfer.items.add(new File([html],'invalid-annotations.html',{type:'text/html'}));const input=document.querySelector('#file-input');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await page.waitFor('document.querySelector("#toast").textContent.includes("이 파일의 HTMLMemo 버전을 지원하지 않습니다")');
    assert.equal(await page.evaluate('!!document.querySelector(".reader-loading")'),false);
    assert.equal(await page.evaluate('document.querySelector("#library").hidden'),false);
    assert.equal(await page.evaluate('document.querySelectorAll("#tabs .tab.document").length'),1);
    assert.deepEqual(chrome.errors,[]);
  }finally{if(chrome)await chrome.close();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});

test('real Chrome: delayed annotation anchors never paint drawings stretched over the whole document',{timeout:60000},async()=>{
  await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'htmlmemo-delayed-annotations-'));await cp(join(root,'public'),folder,{recursive:true});
  const server=createServer(folder);let chrome;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));chrome=await launchChrome();const page=chrome.page;
    await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
    await page.navigate(process.env.HTMLMEMO_OPENING_TEST_URL||`http://127.0.0.1:${server.address().port}/`);
    await page.waitFor('document.querySelector("#status-left").textContent.includes("개의 문서")');
    await page.evaluate(`window.observeDelayedAnnotations=()=>{
      window.delayedSamples=[];window.delayedDone=false;let count=0;
      const sample=()=>{const frame=document.querySelector('.document-host:not([hidden]) iframe'),doc=frame?.contentDocument;
        if(doc?.title==='Delayed annotated content'){
          const stroke=doc.querySelector('[data-htmlmemo-id="delayed-stroke"]'),target=doc.getElementById('generated-note-target');
          const box=stroke?.getBoundingClientRect(),anchor=target?.getBoundingClientRect();
          window.delayedSamples.push({visible:getComputedStyle(frame).visibility==='visible',target:!!target,stroke:!!stroke,height:box?.height,relativeTop:box&&anchor?box.top-anchor.top:null});
        }
        if(++count<120)requestAnimationFrame(sample);else window.delayedDone=true;
      };requestAnimationFrame(sample);
    };window.importDelayedAnnotations=(savedAnchor=false,packedBook=false,durableTarget=false)=>{
      window.observeDelayedAnnotations();
      const text='The saved drawing belongs only to this paragraph.';
      const metadata={version:${FORMAT_VERSION},title:'Delayed annotated content',viewport:{width:1100,height:800},view:{zoom:1,autoFit:false,scrollTop:0,scrollLeft:0},annotations:[{id:'delayed-stroke',type:'pen',anchor:durableTarget?'n999':packedBook?'n2':'js0',...(durableTarget?{anchorTarget:{tag:'p',id:'generated-note-target',rootId:'content',path:[0],quote:text,section:''}}:{}),points:[{x:.2,y:.1},{x:.8,y:.9}],color:'#ef4444',width:3,opacity:1}]};
      const bookData=packedBook?'<script id="book-manifest" type="application/json">'+JSON.stringify({format:'memosuite-book-html-v1',volumes:[{sections:[{key:'v0:first'}]}]})+'<'+'/script><script id="book-volume-0" type="application/octet-stream">original compressed content<'+'/script>':'';
      const html='<html><head><title>Delayed annotated content</title><style>body{margin:0}main{height:8000px}#generated-note-target{width:400px;height:120px;margin-top:60px;background:#edf3ff}</style><script id="htmlmemo-data" type="application/json">'+JSON.stringify(metadata)+'<'+'/script>'+bookData+'</head><body><main id="content">'+(packedBook?'<article id="reader-content"></article>':'Loading section')+'</main><script>setTimeout(()=>{const target=document.createElement("p");target.id="generated-note-target";target.textContent='+JSON.stringify(text)+';'+(savedAnchor?'target.setAttribute("data-htmlmemo-anchor","js0");':'')+'document.getElementById("'+(packedBook?'reader-content':'content')+'").replaceChildren(target);document.documentElement.dataset.readerReady="true";},650);<'+'/script><!--'+'x'.repeat(4*1024*1024)+'--></body></html>';
      const transfer=new DataTransfer();transfer.items.add(new File([html],'delayed-annotations.html',{type:'text/html'}));const input=document.querySelector('#file-input');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
    };`);
    const check=async()=>{
      await page.waitFor('window.delayedDone');
      const samples=await page.evaluate('window.delayedSamples'),shown=samples.filter(sample=>sample.visible),drawn=shown.filter(sample=>sample.stroke);
      console.log('Delayed annotation geometry:',JSON.stringify({samples:samples.length,shown:shown.length,unresolvedDrawings:shown.filter(sample=>sample.stroke&&!sample.target).length,maxHeight:Math.max(...drawn.map(sample=>sample.height)),first:drawn[0],last:drawn.at(-1)}));
      assert.ok(shown.length>0);assert.ok(drawn.length>0,'the saved drawing returns when its paragraph is ready');
      assert.equal(shown.some(sample=>sample.stroke&&!sample.target),false,'an unresolved paragraph must never fall back to the full page');
      assert.ok(drawn.every(sample=>Math.abs(sample.height-96)<1&&Math.abs(sample.relativeTop-12)<1),'every displayed drawing must use its actual paragraph geometry');
    };
    await page.evaluate('window.importDelayedAnnotations()');await check();
    await page.waitFor('document.querySelector("#status-left").textContent.includes("자동 저장됨")');
    await page.click('#tabs .tab.active .tab-close');await page.waitFor('document.querySelectorAll("#tabs .tab").length===0');
    await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    await page.evaluate('window.observeDelayedAnnotations()');await page.click('[data-open]');await check();
    // A script can insert an already anchored element; this must also retry
    // pending drawings when no new anchor IDs need to be generated.
    await page.evaluate('window.importDelayedAnnotations(true)');await check();
    await page.evaluate(`(()=>{const doc=document.querySelector('.document-host:not([hidden]) iframe').contentDocument,p=doc.createElement('p');p.id='new-generated-paragraph';p.textContent='Another generated paragraph';doc.getElementById('content').prepend(p);})()`);
    await page.waitFor(`document.querySelector('.document-host:not([hidden]) iframe').contentDocument.querySelector('#new-generated-paragraph')?.hasAttribute('data-htmlmemo-anchor')`);
    assert.equal(await page.evaluate(`document.querySelector('.document-host:not([hidden]) iframe').contentDocument.querySelectorAll('[data-htmlmemo-anchor="js0"]').length`),1,'new content must not reuse a saved target ID');
    await page.evaluate('window.importDelayedAnnotations(false,true)');await check();
    assert.equal(await page.evaluate('window.delayedSamples.filter(s=>s.visible).every(s=>s.stroke)'),true,'packed books first appear only after their generated paragraph and saved drawing are ready');
    await page.evaluate('window.importDelayedAnnotations(false,false,true)');await check();
    await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/annotation-delayed-mobile.png'),await page.screenshot());
    assert.deepEqual(chrome.errors,[]);
  }finally{if(chrome)await chrome.close();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
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
  await page.click('.tab.document.active .tab-close');await page.waitFor(`document.querySelectorAll('.tab.document').length===0`);assert.equal(await page.evaluate('window.contentReads'),1);
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

test('real Chrome: visible file tabs keep one header row and preserve documents through switching and closing',{timeout:60000},async()=>{
  await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'htmlmemo-visible-tabs-'));await cp(join(root,'public'),folder,{recursive:true});
  const server=createServer(folder);let chrome;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));chrome=await launchChrome();const page=chrome.page;
    const url=process.env.HTMLMEMO_TABS_TEST_URL||`http://127.0.0.1:${server.address().port}/`;
    await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});await page.navigate(url);
    await page.waitFor('document.querySelector("#status-left").textContent.includes("개의 문서")');
    await clickAppMenu(page,'#settings-button');await page.evaluate(`(()=>{const appearance=document.querySelector('#appearance');appearance.value='dark';appearance.dispatchEvent(new Event('change'));document.querySelector('#dialog').close();})()`);
    // The native picker is simulated; actual OPFS handles exercise multi-file reading.
    await page.evaluate(`(async()=>{const root=await navigator.storage.getDirectory(),handles=[];for(const [index,title] of ['입문','실전','개발 용어','긴 이름의 문서도 탭으로 전환하고 파일 이름을 확인합니다'].entries()){const handle=await root.getFileHandle('book-'+index+'.html',{create:true}),writer=await handle.createWritable();await writer.write('<html><head><title>'+title+'</title></head><body><h1>'+title+'</h1><p id="selection">Annotations belong to this document when switching between tabs.</p><main style="height:4000px">Reading content for '+title+'</main></body></html>');await writer.close();handles.push(handle);}window.showOpenFilePicker=async options=>{window.pickerAllowsMultiple=options.multiple;return handles;};})()`);
    await page.click('#import-button');await page.waitFor('document.querySelectorAll("#tabs .tab.document").length===4&&document.querySelector("#status-left").textContent.includes("자동 저장됨")');
    assert.equal(await page.evaluate('window.pickerAllowsMultiple'),true);
    assert.equal(await page.evaluate('!!document.querySelector("#app-menu #tabs")'),false);
    assert.equal(await page.evaluate('document.querySelector("#tabs").hidden'),false);
    const ids=await page.evaluate('[...document.querySelectorAll("#tabs [data-tab]")].map(element=>element.dataset.tab)');
    const frame='document.querySelector(".document-host:not([hidden]) iframe")';
    await page.evaluate(`window.originalTabFrames=[...document.querySelectorAll('#tabs [role=tab]')].map(button=>document.getElementById(button.getAttribute('aria-controls')).querySelector('iframe'));`);
    const key=async value=>{const code={Home:36,End:35,ArrowLeft:37,ArrowRight:39,Escape:27,Delete:46}[value];await page.send('Input.dispatchKeyEvent',{type:'keyDown',key:value,code:value,windowsVirtualKeyCode:code});await page.send('Input.dispatchKeyEvent',{type:'keyUp',key:value,code:value,windowsVirtualKeyCode:code});};
    for(const width of [1280,800,390,320]){
      await page.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<600});
      await page.evaluate(`document.querySelector('#tabs .tab.active .tab-select').focus()`);
      for(const [value,id] of [['Home',ids[0]],['End',ids.at(-1)]]){
        await key(value);await page.waitFor(`document.querySelector('#tabs .tab.active').dataset.tab===${JSON.stringify(id)}`);
        await page.waitFor(`(()=>{const strip=document.querySelector('#tabs').getBoundingClientRect(),active=document.querySelector('#tabs .tab.active').getBoundingClientRect();return active.left>=strip.left-1&&active.right<=strip.right+1;})()`);
      }
      const layout=await page.evaluate(`(()=>{const header=document.querySelector('.chrome').getBoundingClientRect(),strip=document.querySelector('#tabs').getBoundingClientRect();return {height:header.height,stripVisible:strip.width>0&&strip.left>=0&&strip.right<=innerWidth,selected:document.querySelectorAll('#tabs [aria-selected=true]').length,panels:document.querySelectorAll('.workspace-host:not([hidden])').length,controls:['#library-tab','#import-button','#save-page','#app-menu-button'].every(selector=>{const element=document.querySelector(selector),r=element.getBoundingClientRect();return r.width>0&&r.right<=innerWidth&&element.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));})};})()`);
      assert.deepEqual(layout,{height:25,stripVisible:true,selected:1,panels:1,controls:true});
      assert.equal(await page.evaluate(`document.querySelector('#tabs .tab.active').title.includes('book-3.html')`),true);
      if(width===1280||width===320){await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,`test-results/visible-tabs-${width}.png`),await page.screenshot());}
    }
    assert.equal(await page.evaluate('document.querySelector("#tabs").scrollWidth>document.querySelector("#tabs").clientWidth'),true);
    await page.evaluate(`(async()=>{document.querySelector('#tabs').scrollLeft=0;${frame}.contentWindow.scrollTo(0,60);await new Promise(resolve=>setTimeout(resolve,2600));})()`);
    assert.equal(await page.evaluate('document.querySelector("#tabs").scrollLeft'),0,'background position saving must not reset tab scrolling');
    // Ctrl/Cmd+L can still edit an address without replacing the visible file tabs permanently.
    await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'l',ctrlKey:true,bubbles:true,cancelable:true}));document.querySelector('#address').value='https://example.org/typed-address';${frame}.contentWindow.scrollTo(0,100);`);
    await page.evaluate('new Promise(resolve=>setTimeout(resolve,400))');
    assert.equal(await page.evaluate('document.querySelector("#address").value'),'https://example.org/typed-address');await key('Escape');
    await page.waitFor('!document.querySelector(".chrome").classList.contains("address-editing")');
    await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
    await page.click(`[data-tab="${ids[0]}"] .tab-select`);
    await page.evaluate(`(()=>{const doc=${frame}.contentDocument,range=doc.createRange();range.setStart(doc.querySelector('#selection').firstChild,0);range.setEnd(doc.querySelector('#selection').firstChild,11);doc.getSelection().removeAllRanges();doc.getSelection().addRange(range);doc.dispatchEvent(new Event('selectionchange'));})()`);
    await page.click('[data-action="highlight"]');await page.waitFor('document.querySelector("#status-left").textContent.includes("자동 저장됨")&&!document.querySelector(".tab-dirty:not([hidden])")');
    await page.click(`[data-tab="${ids[1]}"] .tab-select`);assert.equal(await page.evaluate(`${frame}.contentDocument.querySelectorAll('[data-htmlmemo-mark]').length`),0);
    await page.click(`[data-tab="${ids[0]}"] .tab-select`);assert.equal(await page.evaluate(`${frame}.contentDocument.querySelectorAll('[data-htmlmemo-mark]').length`),1);
    assert.equal(await page.evaluate(`${frame}===window.originalTabFrames[0]`),true);
    await page.click(`[data-tab="${ids[1]}"] .tab-close`);assert.equal(await page.evaluate('document.querySelector("#tabs .tab.active").dataset.tab'),ids[0]);
    await page.evaluate(`${frame}.contentWindow.scrollTo(0,500);`);await page.click(`[data-tab="${ids[0]}"] .tab-close`);
    await page.waitFor('document.querySelectorAll("#tabs .tab.document").length===2');
    const saved=await page.evaluate(`(async()=>{const {listDocuments}=await import('./src/storage.js');return (await listDocuments()).find(record=>record.title==='입문');})()`);
    assert.equal(saved.metadata.annotations.length,1);assert.ok(saved.metadata.view.scrollTop>0);
    await page.click('#library-tab');await page.click(`[data-open="${saved.id}"]`);
    await page.waitFor(`${frame}?.contentDocument?.querySelector('[data-htmlmemo-mark]')&&${frame}.contentWindow.scrollY>=499`);
    await page.evaluate('document.querySelector("#tabs .tab.active .tab-select").focus()');await key('Delete');await page.waitFor('document.querySelectorAll("#tabs .tab.document").length===2');
    assert.equal(await page.evaluate('document.querySelector("#app-menu").hidden'),true);
    for(const remaining of [1,0]){await page.click('#tabs .tab.active .tab-close');await page.waitFor(`document.querySelectorAll('#tabs .tab').length===${remaining}`);}
    assert.equal(await page.evaluate('document.querySelector("#tabs").hidden'),true);
    assert.equal(await page.evaluate('document.querySelector("#library").hidden'),false);assert.deepEqual(chrome.errors,[]);
  }finally{if(chrome)await chrome.close();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});

test('real Chrome: scrolling saves quietly in batches, preserves annotation history and flushes the last position on close',{timeout:60000},async()=>{
  await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'htmlmemo-position-save-'));await cp(join(root,'public'),folder,{recursive:true});
  const server=createServer(folder);let chrome;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));chrome=await launchChrome();const page=chrome.page;
    const url=process.env.HTMLMEMO_POSITION_TEST_URL||`http://127.0.0.1:${server.address().port}/`;
    await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});await page.navigate(url);
    await page.waitFor('document.querySelector("#status-left").textContent.includes("개의 문서")');
    await page.evaluate(`(()=>{const html='<html><head><title>Quiet reading position</title><style>html,body{height:100vh;margin:0;overflow:hidden}main{height:100vh;overflow:auto}section{height:6000px}</style></head><body><main><p id="selection">Reading position changes are separate from annotation edits.</p><section>Long reading content</section></main></body></html>';const transfer=new DataTransfer();transfer.items.add(new File([html],'quiet-reading.html',{type:'text/html'}));const input=document.querySelector('#file-input');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await page.waitFor('document.querySelector("#status-left").textContent.includes("주석이 앱에 자동 저장됨")');
    const frame='document.querySelector(".document-host:not([hidden]) iframe")';
    const state=()=>page.evaluate(`(async()=>{const {listDocuments,getDocument,listRevisions}=await import('./src/storage.js');const record=await getDocument((await listDocuments())[0].id);return {view:record.metadata.view,modified:record.modified,annotations:record.metadata.annotations.length,html:record.html,revisions:(await listRevisions(record.id)).length};})()`);
    await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'s',ctrlKey:true,bubbles:true,cancelable:true}));`);
    await page.waitFor(`(async()=>{const {listDocuments}=await import('./src/storage.js');const record=(await listDocuments())[0];return Math.abs(record.metadata.view.zoom-parseFloat(${frame}.style.transform.slice(6)))<.00001;})()`);
    const baseline=await state();
    await page.evaluate(`(()=>{
      window.positionWrites=[];window.saveLabels=[];window.failPositionSave=false;
      const original=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value,...args){
        const viewOnly=this.name==='documents'&&this.transaction.objectStoreNames.length===1;
        if(viewOnly&&window.failPositionSave)throw new DOMException('Position storage full','QuotaExceededError');
        if(this.name==='documents')window.positionWrites.push({viewOnly,top:value.metadata.view.scrollTop});
        return original.call(this,value,...args);
      };
      new MutationObserver(()=>window.saveLabels.push(document.querySelector('#status-left').textContent)).observe(document.querySelector('#status-left'),{subtree:true,childList:true,characterData:true});
    })()`);
    await page.evaluate(`(async()=>{const main=${frame}.contentDocument.querySelector('main');for(const top of [100,200,300,400,500]){main.scrollTop=top;await new Promise(resolve=>setTimeout(resolve,400));}})()`);
    assert.deepEqual(await page.evaluate('window.positionWrites'),[]);
    assert.equal(await page.evaluate('document.querySelector("#status-left").textContent.includes("저장 중")'),false);
    assert.equal(await page.evaluate('!!document.querySelector(".tab-dirty:not([hidden])")'),false);
    assert.equal(await page.evaluate(`(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;})()`),false);
    await page.waitFor('window.positionWrites.length===1');
    const scrolled=await state();assert.ok(Math.abs(scrolled.view.scrollTop-500*scrolled.view.zoom)<1);
    assert.equal(scrolled.modified,baseline.modified);assert.equal(scrolled.revisions,baseline.revisions);assert.equal(scrolled.html,baseline.html);
    assert.equal(await page.evaluate('window.positionWrites[0].viewOnly'),true);
    assert.equal(await page.evaluate('window.saveLabels.some(label=>label.includes("저장 중"))'),false);
    // Redundant scroll events must not write or change the saved indicator.
    await page.evaluate(`(async()=>{${frame}.contentDocument.querySelector('main').dispatchEvent(new Event('scroll',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,2600));})()`);
    assert.equal(await page.evaluate('window.positionWrites.length'),1);
    // A quiet save still exposes real failures and can be retried without editing annotations.
    await page.evaluate(`window.failPositionSave=true;${frame}.contentDocument.querySelector('main').scrollTop=700;`);
    await page.waitFor('document.querySelector("#status-left").textContent.includes("읽기 위치 저장 실패")');
    await page.evaluate('window.failPositionSave=false');await page.click('#retry-save');
    await page.waitFor('!document.querySelector("#retry-save")');assert.equal((await state()).revisions,baseline.revisions);
    // Annotation saves retain their short delay even when a position save is pending.
    await page.evaluate(`(()=>{const doc=${frame}.contentDocument,range=doc.createRange();range.setStart(doc.querySelector('#selection').firstChild,0);range.setEnd(doc.querySelector('#selection').firstChild,7);doc.getSelection().removeAllRanges();doc.getSelection().addRange(range);doc.dispatchEvent(new Event('selectionchange'));})()`);
    await page.click('[data-action="highlight"]');
    assert.equal(await page.evaluate(`(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;})()`),true);
    await page.evaluate(`${frame}.contentDocument.querySelector('main').scrollTop=900;`);
    await page.waitFor(`(async()=>{const {listDocuments}=await import('./src/storage.js');return (await listDocuments())[0].metadata.annotations.length===1&&!document.querySelector('.tab-dirty:not([hidden])');})()`);
    const edited=await state();assert.equal(edited.revisions,baseline.revisions+1);assert.equal(edited.html,baseline.html);
    // Closing before the debounce expires captures the current position synchronously.
    await page.evaluate(`${frame}.contentDocument.querySelector('main').scrollTop=1400;`);
    await page.click('.tab.document.active .tab-close');await page.waitFor('document.querySelectorAll(".tab.document").length===0');
    const closed=await state();assert.ok(Math.abs(closed.view.scrollTop-1400*closed.view.zoom)<1);assert.equal(closed.revisions,edited.revisions);
    await page.click('[data-open]');await page.waitFor(`${frame}?.contentDocument?.querySelector('main')?.scrollTop>=1399`);
    // Leaving the app also bypasses the delay. The lifecycle event is simulated;
    // persistence and the document's actual scrolling are exercised in Chrome.
    await page.evaluate(`${frame}.contentDocument.querySelector('main').scrollTop=1700;window.dispatchEvent(new PageTransitionEvent('pagehide'));`);
    await page.waitFor(`(async()=>{const {listDocuments}=await import('./src/storage.js');const record=(await listDocuments())[0];return Math.abs(record.metadata.view.scrollTop-1700*record.metadata.view.zoom)<1;})()`);
    const final=await state();assert.equal(final.revisions,edited.revisions);assert.equal(final.modified,edited.modified);
    await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/quiet-position-save-desktop.png'),await page.screenshot());
    await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await writeFile(join(root,'test-results/quiet-position-save-mobile.png'),await page.screenshot());
    assert.deepEqual(chrome.errors,[]);
  }finally{if(chrome)await chrome.close();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});

test('real Chrome: native sidebar view choices are visible on open and preserve the original book tree and export',{timeout:60000},async()=>{
  await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'htmlmemo-native-sidebar-'));await cp(join(root,'public'),folder,{recursive:true});
  const server=createServer(folder);let chrome;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));chrome=await launchChrome();const page=chrome.page;
    const url=process.env.HTMLMEMO_SIDEBAR_TEST_URL||`http://127.0.0.1:${server.address().port}/`,source=await readFile(join(root,'tests/fixtures/book.html'),'utf8');
    await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});await page.navigate(url);
    await page.waitFor('document.querySelector("#status-left").textContent.includes("개의 문서")');
    await page.evaluate(`(async()=>{const {putDocumentRevision}=await import('./src/storage.js'),{parseHTML}=await import('./src/document.js');const parsed=parseHTML(${JSON.stringify(source)},{title:'원본 목차 검증'},{allowScripts:true});parsed.metadata.annotations=[{id:'native-note',type:'note',text:'책의 메모',color:'#334155',width:3,opacity:1,points:[{x:30,y:120}]}];await putDocumentRevision({id:'native-sidebar-document',title:'원본 목차 검증',name:'native-book.html',created:Date.now(),modified:Date.now(),html:parsed.html,metadata:parsed.metadata});})()`);
    await page.navigate(url);await page.waitFor('!!document.querySelector("[data-open=native-sidebar-document]")');await page.click('[data-open=native-sidebar-document]');
    const frame='document.querySelector(".document-host:not([hidden]) iframe")',doc=frame+'.contentDocument';
    await page.waitFor(`${doc}?.querySelectorAll('[data-htmlmemo-doc-sidebar-ui] [data-sidebar-view]').length===3&&!${frame}.hasAttribute('aria-hidden')`);
    assert.equal(await page.evaluate('document.querySelector("#sidebar").hidden'),true);
    assert.deepEqual(await page.evaluate(`[...${doc}.querySelectorAll('[data-htmlmemo-doc-sidebar-ui] [data-sidebar-view]')].map(button=>button.textContent)`),['목차','문서 검색','주석 목록']);
    await page.evaluate(`window.nativeSidebarTree=${doc}.querySelector('#reader-tree');`);
    for(const mode of ['search','annotations']){
      await page.click('[data-action=more]');await page.click(`[data-more=${mode}]`);
      await page.waitFor(`${doc}.querySelector('#reader-nav').dataset.htmlmemoSidebarView==='${mode}'`);
      assert.equal(await page.evaluate('document.querySelector("#sidebar").hidden'),true);
    }
    const clickNative=async selector=>{
      const point=await page.evaluate(`(()=>{const frame=${frame},element=frame.contentDocument.querySelector(${JSON.stringify(selector)});element.scrollIntoView({block:'nearest'});const f=frame.getBoundingClientRect(),r=element.getBoundingClientRect(),scale=f.width/frame.clientWidth;return {x:f.left+(r.left+r.width/2)*scale,y:f.top+(r.top+r.height/2)*scale};})()`);
      await page.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
    };
    for(const width of [1280,390]){
      await page.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<600});
      await clickNative('[data-sidebar-view=search]');await page.waitFor(`${doc}.querySelector('#reader-nav').dataset.htmlmemoSidebarView==='search'`);
      await page.evaluate(`${doc}.querySelector('input').select()`);
      await page.send('Input.insertText',{text:'Introduction'});await page.waitFor(`${doc}.querySelectorAll('[data-search-index]').length===6`);
      assert.equal(await page.evaluate(`${doc}.defaultView.getComputedStyle(${doc}.querySelector('#reader-tree')).display`),'none');
      await clickNative('[data-sidebar-view=annotations]');await page.waitFor(`!!${doc}.querySelector('[data-annotation=native-note] .annotation-main')`);assert.equal(await page.evaluate(`${doc}.querySelector('[data-annotation=native-note] .annotation-main').textContent`),'책의 메모');await clickNative('[data-annotation=native-note]');
      await clickNative('[data-sidebar-view=search]');assert.equal(await page.evaluate(`${doc}.querySelector('input').value`),'Introduction');
      await clickNative('[data-sidebar-view=outline]');assert.equal(await page.evaluate(`${doc}.querySelector('#reader-tree')===window.nativeSidebarTree`),true);
      assert.notEqual(await page.evaluate(`${doc}.defaultView.getComputedStyle(${doc}.querySelector('#reader-tree')).display`),'none');
      assert.equal(await page.evaluate(`${doc}.querySelectorAll('[data-htmlmemo-doc-sidebar-ui]').length`),1);
      await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,`test-results/sidebar-views-native-${width}.png`),await page.screenshot());
    }
    await clickNative('#reader-tree details:last-child summary');await page.waitFor(`${doc}.querySelector('#reader-tree details:last-child a')`);
    await clickNative('#reader-tree details:last-child a:last-child');await page.waitFor(`${doc}.querySelector('#reader-content').dataset.section==='v2:last'`);
    await clickNative('[data-sidebar-view=annotations]');await clickNative('[data-delete-annotation=native-note]');
    await page.waitFor(`${doc}.querySelector('.panel-empty')?.textContent.includes('아직 주석')`);
    await page.evaluate(`window.showSaveFilePicker=async()=> (await navigator.storage.getDirectory()).getFileHandle('native-sidebar-export.html',{create:true});`);await page.click('#save-page');
    const exported=await page.evaluate(`(async()=>{const root=await navigator.storage.getDirectory();let file;for(let i=0;i<50;i++){try{file=await(await root.getFileHandle('native-sidebar-export.html')).getFile();if(file.size)break;}catch{}await new Promise(resolve=>setTimeout(resolve,50));}const html=await file.text(),doc=new DOMParser().parseFromString(html,'text/html');return {runtime:!!doc.querySelector('[data-htmlmemo-doc-sidebar-ui],[data-htmlmemo-native-sidebar],[data-htmlmemo-sidebar-view],#htmlmemo-doc-sidebar-style'),volumes:[0,1,2].every(i=>!!doc.getElementById('book-volume-'+i)),notes:JSON.parse(doc.getElementById('htmlmemo-data').textContent).annotations.length};})()`);
    assert.deepEqual(exported,{runtime:false,volumes:true,notes:0});assert.equal(await page.evaluate('document.querySelector("#sidebar").hidden'),true);assert.deepEqual(chrome.errors,[]);
  }finally{if(chrome)await chrome.close();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});

test('real Chrome: sidebar view choices preserve search drafts, navigate saved notes and keep bookmarks editable',{timeout:60000},async()=>{
  await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'htmlmemo-sidebar-'));await cp(join(root,'public'),folder,{recursive:true});
  const server=createServer(folder);let chrome;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));chrome=await launchChrome();const page=chrome.page;
    const url=process.env.HTMLMEMO_SIDEBAR_TEST_URL||`http://127.0.0.1:${server.address().port}/`;
    await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});await page.navigate(url);
    await page.waitFor('document.querySelector("#status-left").textContent.includes("개의 문서")');
    await page.evaluate(`(async()=>{const {putDocumentRevision}=await import('./src/storage.js'),{parseHTML}=await import('./src/document.js');
      const parsed=parseHTML('<html lang="ko"><head><title>사이드바 검증 문서</title></head><body><h1>처음</h1><p>검색어를 찾아 두고 기억하는 문장입니다.</p><div style="height:1400px"></div><h2>다음 절</h2><p>검색어를 다시 찾습니다.</p></body></html>');
      parsed.metadata.annotations=[{id:'sidebar-note',type:'note',text:'보관한 메모',color:'#334155',width:3,opacity:1,points:[{x:30,y:120}]}];
      parsed.metadata.bookmarks=[{id:'sidebar-bookmark',title:'보관한 위치',top:300,left:0}];
      await putDocumentRevision({id:'sidebar-document',title:'사이드바 검증 문서',name:'sidebar.html',created:Date.now(),modified:Date.now(),html:parsed.html,metadata:parsed.metadata});})()`);
    await page.navigate(url);await page.waitFor('!!document.querySelector("[data-open=sidebar-document]")');await page.click('[data-open=sidebar-document]');
    await page.waitFor('!document.querySelector("#toolbar").hidden&&document.querySelector("#status-left").textContent.includes("자동 저장됨")');
    const original=await page.evaluate(`(async()=>{const {getDocument}=await import('./src/storage.js');const record=await getDocument('sidebar-document');return {html:record.html,annotations:record.metadata.annotations,bookmarks:record.metadata.bookmarks};})()`);
    await page.evaluate('window.sidebarFrame=document.querySelector(".document-host:not([hidden]) iframe")');
    await page.click('[data-action=more]');await page.click('[data-more=outline]');
    assert.deepEqual(await page.evaluate('[...document.querySelectorAll("[data-sidebar-view]")].map(button=>button.textContent)'),['목차·북마크','문서 검색','주석 목록']);
    for(const width of [1280,390,320]){
      await page.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<600});
      const visible=await page.evaluate('[...document.querySelectorAll("[data-sidebar-view]")].every(button=>{const r=button.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth&&button.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));})');assert.equal(visible,true);
      await page.click('[data-sidebar-view=search]');
      await page.evaluate(`(()=>{const input=document.querySelector('#document-search');input.value='검색어';input.dispatchEvent(new Event('input'));})()`);
      await page.waitFor('document.querySelectorAll("[data-search-index]").length===2');await page.click('[data-search-index="1"]');
      await page.click('[data-sidebar-view=annotations]');assert.equal(await page.evaluate('document.querySelector("[data-annotation=sidebar-note] .annotation-main").textContent'),'보관한 메모');await page.click('[data-annotation=sidebar-note]');
      await page.click('[data-sidebar-view=search]');assert.equal(await page.evaluate('document.querySelector("#document-search").value'),'검색어');
      await page.evaluate(`(()=>{const input=document.querySelector('#document-search');input.value='빠른 전환';input.dispatchEvent(new Event('input'));document.querySelector('[data-sidebar-view=outline]').click();})()`);
      await page.evaluate('new Promise(resolve=>setTimeout(resolve,160))');
      assert.equal(await page.evaluate('document.querySelectorAll("[data-sidebar-view][aria-pressed=true]").length'),1);
      if(width===1280||width===320){await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,`test-results/sidebar-views-${width}.png`),await page.screenshot());}
    }
    const unchanged=await page.evaluate(`(async()=>{const {getDocument}=await import('./src/storage.js');const record=await getDocument('sidebar-document');return {html:record.html,annotations:record.metadata.annotations,bookmarks:record.metadata.bookmarks};})()`);assert.deepEqual(unchanged,original);
    assert.equal(await page.evaluate('document.querySelector(".document-host:not([hidden]) iframe")===window.sidebarFrame'),true);
    await page.click('#add-bookmark');await page.evaluate(`document.querySelector('#note-text').value='새 북마크'`);await page.click('#dialog button[value=save]');
    await page.waitFor('document.querySelectorAll("[data-bookmark]").length===2&&document.querySelector("#status-left").textContent.includes("자동 저장됨")');
    await page.click('[data-delete-bookmark=sidebar-bookmark]');await page.click('[data-sidebar-view=annotations]');await page.click('[data-delete-annotation=sidebar-note]');
    await page.waitFor('document.querySelector("#sidebar .panel-empty")?.textContent.includes("아직 주석")&&document.querySelector("#status-left").textContent.includes("자동 저장됨")');
    const saved=await page.evaluate(`(async()=>{const {getDocument}=await import('./src/storage.js');const record=await getDocument('sidebar-document');return {html:record.html,annotations:record.metadata.annotations.length,bookmarks:record.metadata.bookmarks.map(mark=>mark.title)};})()`);
    assert.equal(saved.html,original.html);assert.equal(saved.annotations,0);assert.deepEqual(saved.bookmarks,['새 북마크']);
    await page.click('#close-sidebar');assert.equal(await page.evaluate('document.querySelector("#sidebar").hidden'),true);assert.deepEqual(chrome.errors,[]);
  }finally{if(chrome)await chrome.close();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});

test('real Chrome: folder setup explains subfolders and preserves connections through cancellation and retry',{timeout:45000},async()=>{
  await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'htmlmemo-folder-setup-'));await cp(join(root,'public'),folder,{recursive:true});
  const server=createServer(folder);let chrome;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));chrome=await launchChrome();const page=chrome.page;
    const url=process.env.HTMLMEMO_FOLDER_TEST_URL||`http://127.0.0.1:${server.address().port}/`;
    await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});await page.navigate(url);await page.waitFor('document.querySelector("#status-left").textContent.includes("개의 문서")');
    await clickAppMenu(page,'#settings-button');await page.evaluate(`(()=>{const appearance=document.querySelector('#appearance');appearance.value='dark';appearance.dispatchEvent(new Event('change'));document.querySelector('#dialog').close();})()`);
    // The OS restricted-folder dialog is not automated. Simulated picker outcomes
    // exercise recovery; a real OPFS handle exercises persistence and file writes.
    await page.evaluate(`window.folderPicks=0;window.cancelFolder=true;window.showDirectoryPicker=async options=>{window.folderPicks++;window.folderOptions={id:options.id,mode:options.mode,startIn:typeof options.startIn==='string'?options.startIn:options.startIn.name};if(window.cancelFolder)throw new DOMException('Cancelled','AbortError');return (await navigator.storage.getDirectory()).getDirectoryHandle('HTMLMemo',{create:true});};`);
    await page.click('#choose-folder');await page.waitFor('document.querySelector("#dialog[open] h2")?.textContent==="저장 폴더 연결"');assert.equal(await page.evaluate('window.folderPicks'),0);
    assert.match(await page.evaluate('document.querySelector("#dialog-content").textContent'),/문서\/HTMLMemo/);
    for(const width of [1280,320]){
      await page.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<600});
      const bounds=await page.evaluate(`(()=>{const r=document.querySelector('#dialog').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;})()`);assert.equal(bounds,true);
      await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,`test-results/folder-setup-${width}.png`),await page.screenshot());
    }
    await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
    await page.click('#select-storage-folder');await page.waitFor('!document.querySelector("#select-storage-folder").disabled && document.querySelector("#folder-connection-status").textContent.includes("변경하지")');
    assert.deepEqual(await page.evaluate('window.folderOptions'),{id:'htmlmemo-storage-v2',mode:'readwrite',startIn:'documents'});
    await page.evaluate('window.cancelFolder=false');await page.click('#select-storage-folder');await page.waitFor('!document.querySelector("#dialog").open && document.querySelector("#choose-folder").textContent.includes("HTMLMemo 연결됨")');
    assert.equal(await page.evaluate(`(async()=>{const {getSetting}=await import('./src/storage.js'),directory=await getSetting('folder');if(!(directory instanceof FileSystemDirectoryHandle))throw Error('Directory handle was not preserved');const file=await directory.getFileHandle('check.txt',{create:true}),writer=await file.createWritable();await writer.write('HTMLMemo directory check');await writer.close();return (await file.getFile()).text();})()`),'HTMLMemo directory check');
    await page.navigate(url);await page.waitFor('document.querySelector("#choose-folder").textContent.includes("HTMLMemo 연결됨")');
    await page.evaluate(`window.showDirectoryPicker=async()=>{throw new DOMException('Denied','NotAllowedError');};`);
    await clickAppMenu(page,'#settings-button');await page.click('#settings-folder');await page.click('#select-storage-folder');await page.waitFor('document.querySelector("#folder-connection-status").textContent.includes("허용하지")');
    assert.equal(await page.evaluate(`(async()=>{const {getSetting}=await import('./src/storage.js');return (await getSetting('folder')).name;})()`),'HTMLMemo');
    await page.evaluate(`window.showDirectoryPicker=async()=> (await navigator.storage.getDirectory()).getDirectoryHandle('New HTMLMemo',{create:true});`);await page.click('#select-storage-folder');await page.waitFor('document.querySelector("#dialog[open] h2")?.textContent==="HTMLMemo 설정"');
    assert.equal(await page.evaluate(`(async()=>{const {getSetting}=await import('./src/storage.js');return (await getSetting('folder')).name;})()`),'New HTMLMemo');
    assert.deepEqual(chrome.errors,[]);
  }finally{if(chrome)await chrome.close();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});

// Two editions of a packed book (memosuite-book-html-v1) with a minimal runtime: one section per hash.
function editionHTML(title, sections, annotations = null) {
  const crcTable = Array.from({length:256},(_,i)=>{for(let b=0;b<8;b++)i=i&1?0xedb88320^(i>>>1):i>>>1;return i>>>0;});
  const crc = bytes => {let c=0xffffffff;for(const b of bytes)c=crcTable[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0;};
  const data = Buffer.from(JSON.stringify(sections.map(s => s.markdown))), packed = deflateRawSync(data), name = Buffer.from('sections.json');
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(8,8);local.writeUInt32LE(crc(data),14);local.writeUInt32LE(packed.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);
  central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(8,10);central.writeUInt32LE(crc(data),16);central.writeUInt32LE(packed.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(name.length,28);
  end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(46+name.length,12);end.writeUInt32LE(30+name.length+packed.length,16);
  const payload = Buffer.concat([local,name,packed,central,name,end]).toString('base64');
  const manifest = {format:'memosuite-book-html-v1',title,volumes:[{book:'guide',label:title,sections:sections.map(({key,id,title:t},index)=>({key,id,title:t,volume:0,index}))}]};
  const bodies = Object.fromEntries(sections.map(s => [s.key, s.html]));
  const metadata = annotations && {version:FORMAT_VERSION,title,viewport:{width:1100,height:800},view:{zoom:1,autoFit:false,scrollTop:0,scrollLeft:0},annotations};
  const runtime = 'const m=JSON.parse(document.getElementById("book-manifest").textContent),bodies=JSON.parse(document.getElementById("test-bodies").textContent),keys=m.volumes.flatMap(v=>v.sections.map(s=>s.key)),content=document.getElementById("reader-content");'
    + 'function show(){const wanted=decodeURIComponent(location.hash.slice(1)),key=keys.includes(wanted)?wanted:keys[0];content.innerHTML=bodies[key];content.dataset.section=key;document.documentElement.dataset.readerReady="true";}addEventListener("hashchange",show);show();';
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${title}</title>${metadata ? `<script id="htmlmemo-data" type="application/json">${JSON.stringify(metadata)}</script>` : ''}<style>p{margin:16px 0;line-height:1.7}</style></head><body>`
    + `<nav id="reader-nav"><div id="reader-tree">${sections.map(s => `<a href="#${encodeURIComponent(s.key)}">${s.title}</a>`).join(' ')}</div></nav><main id="reader-main"><div id="reader-section-label"></div><div id="reader-status"></div><article id="reader-content"></article></main>`
    + `<script id="book-manifest" type="application/json">${JSON.stringify(manifest)}</script><script type="application/octet-stream" id="book-volume-0">${payload}</script>`
    + `<script id="test-bodies" type="application/json">${JSON.stringify(bodies)}</script><script>${runtime}</script></body></html>`;
}

test('real Chrome: annotations move to a new edition of a book, and annotations on deleted text are dropped',{timeout:90000},async()=>{
  await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'htmlmemo-edition-'));await cp(join(root,'public'),folder,{recursive:true});
  const server=createServer(folder);let chrome;
  const install='에이전트를 설치하고 터미널에서 처음 실행해 봅니다.',removed='이 문단은 다음 판에서 통째로 지워집니다.',result='명령을 실행한 뒤에는 결과를 꼭 확인합니다.';
  const oldEdition=editionHTML('편집되는 책',[
    {key:'v0:setup',id:'setup',title:'설치',markdown:`# 설치\n${install}\n\n${removed}`,html:`<h1>설치</h1><p>${install}</p><p>${removed}</p>`},
    {key:'v0:run',id:'run',title:'실행',markdown:`# 실행\n${result}`,html:`<h1>실행</h1><p>${result}</p>`}],[
    {id:'install-mark',type:'highlight',color:'#edcf67',width:3,opacity:.35,created:Date.now(),textAnchor:{start:0,end:install.length,quote:install,prefix:'',suffix:'',section:'v0:setup'}},
    {id:'removed-mark',type:'underline',color:'#334155',width:3,opacity:1,created:Date.now(),textAnchor:{start:0,end:removed.length,quote:removed,prefix:'',suffix:'',section:'v0:setup'}},
    {id:'install-pen',type:'pen',color:'#d94f4f',width:3,opacity:1,created:Date.now(),anchor:'body',anchorTarget:{tag:'p',id:'',rootId:'reader-content',path:[1],quote:install,section:'v0:setup'},points:[{x:.05,y:.2},{x:.6,y:.8}]},
    {id:'result-mark',type:'highlight',color:'#9fd3a8',width:3,opacity:.35,created:Date.now(),textAnchor:{start:0,end:result.length,quote:result,prefix:'',suffix:'',section:'v0:run'}}]);
  // New edition: a new first section, the install sentence reworded, the doomed paragraph removed,
  // and the run section replaced by a 「check」 section that carries the result sentence.
  const install2='에이전트를 먼저 설치하고 터미널에서 처음 실행해 봅니다.';
  const newEdition=editionHTML('편집되는 책',[
    {key:'v0:intro',id:'intro',title:'들어가며',markdown:'# 들어가며\n새로 쓴 장입니다.',html:'<h1>들어가며</h1><p>새로 쓴 장입니다.</p>'},
    {key:'v0:setup',id:'setup',title:'설치',markdown:`# 설치\n${install2}`,html:`<h1>설치</h1><p>${install2}</p>`},
    {key:'v0:check',id:'check',title:'확인',markdown:`# 확인\n${result}`,html:`<h1>확인</h1><p>${result}</p>`}]);
  try{
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    chrome=await launchChrome();const page=chrome.page;
    await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
    await page.navigate('http://127.0.0.1:'+server.address().port+'/');await page.waitFor('document.querySelector("#status-left").textContent.includes("개의 문서")');
    await page.evaluate(`(async()=>{const root=await navigator.storage.getDirectory();for(const [name,html] of Object.entries(${JSON.stringify({'edition-1.html':oldEdition,'edition-2.html':newEdition})})){const handle=await root.getFileHandle(name,{create:true});const writer=await handle.createWritable();await writer.write(html);await writer.close();}
      window.pick=name=>{window.showOpenFilePicker=async()=>[await root.getFileHandle(name)];};})()`);
    const frame='document.querySelector(".document-host:not([hidden]) iframe")';
    await page.evaluate('window.pick("edition-1.html")');await page.click('#import-button');
    await page.waitFor(`${frame}?.contentDocument?.querySelectorAll('[data-htmlmemo-mark]').length >= 2 && !document.querySelector('#toolbar').hidden && document.querySelector("#status-left").textContent.includes("자동 저장됨")`,20000);
    await page.evaluate('window.pick("edition-2.html")');
    await page.click('[data-action=more]');await page.click('[data-more=migrate]');
    try{await page.waitFor('!!document.querySelector("#dialog[open] .migrate-summary")',30000);}
    catch(error){throw new Error(error.message+' — '+JSON.stringify(await page.evaluate('({toast:document.querySelector("#toast").textContent,dialog:document.querySelector("#dialog").open&&document.querySelector("#dialog").innerText,popover:!document.querySelector("#tool-popover").hidden})'))+' '+chrome.errors.join(' | '));}
    const summary=await page.evaluate('document.querySelector("#dialog").innerText');
    assert.match(summary,/주석 4개 가운데 3개/);assert.match(summary,/그대로 있는 자리: 1개/);assert.match(summary,/고쳐졌거나 옮겨진 자리: 2개/);assert.match(summary,/지워진 내용: 1개/);
    await page.evaluate('document.querySelector("#dialog details").open=true');
    assert.match(await page.evaluate('document.querySelector("#dialog details").innerText'),/밑줄 이 문단은 다음 판에서 통째로 지워집니다\. — 설치/);
    await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/migrate-report.png'),await page.screenshot());
    await page.click('#dialog button[value=confirm]');
    await page.waitFor(`document.querySelectorAll(".tab.document").length===2 && ${frame}?.contentDocument?.querySelector('#reader-content')?.dataset.section==='v0:intro' && document.querySelector("#status-left").textContent.includes("자동 저장됨")`,30000);
    const records=await page.evaluate(`(async()=>{const {listDocuments,getDocument}=await import('./src/storage.js');const list=await listDocuments();return Promise.all(list.map(async r=>({id:r.id,annotations:(await getDocument(r.id)).metadata.annotations})));})()`);
    assert.equal(records.length,2,'the old edition stays in the library');
    const moved=records.find(r=>r.annotations.some(a=>a.textAnchor?.section==='v0:check')).annotations;
    assert.deepEqual(moved.map(a=>a.id).sort(),['install-mark','install-pen','result-mark']);
    assert.equal(moved.find(a=>a.id==='install-mark').textAnchor.quote,install2);
    assert.equal(records.find(r=>r!==records.find(x=>x.annotations===moved)).annotations.length,4,'the old document keeps every annotation');
    // The new edition shows each annotation in its own section.
    await page.evaluate(`${frame}.contentWindow.location.hash='#'+encodeURIComponent('v0:setup')`);
    await page.waitFor(`${frame}.contentDocument.querySelector('[data-htmlmemo-mark]')?.textContent===${JSON.stringify(install2)} && !!${frame}.contentDocument.querySelector('#htmlmemo-annotation-layer [data-htmlmemo-id="install-pen"]')`,15000);
    await page.evaluate(`${frame}.contentWindow.location.hash='#'+encodeURIComponent('v0:check')`);
    await page.waitFor(`${frame}.contentDocument.querySelector('[data-htmlmemo-mark]')?.textContent===${JSON.stringify(result)} && !${frame}.contentDocument.querySelector('#htmlmemo-annotation-layer [data-htmlmemo-id="install-pen"]')`,15000);
    await writeFile(join(root,'test-results/migrate-new-edition.png'),await page.screenshot());
    assert.deepEqual(chrome.errors,[]);
  }finally{if(chrome)await chrome.close();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});
