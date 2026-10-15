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
    const state=()=>page.evaluate(`(async()=>{const {listDocuments,listRevisions}=await import('./src/storage.js');const record=(await listDocuments())[0];return {id:record.id,html:record.html,metadata:record.metadata,revisions:await listRevisions(record.id),pending:record.diskPending,error:record.diskError};})()`);
    const first=await state();assert.equal(first.revisions.length,1);assert.equal(first.revisions[0].annotations.length,0);
    const highlight=async()=>{
      await page.evaluate(`(()=>{const doc=document.querySelector('.document-host:not([hidden]) iframe').contentDocument;const walker=doc.createTreeWalker(doc.querySelector('#selection'),NodeFilter.SHOW_TEXT);let node,last;while(node=walker.nextNode())if(node.textContent.trim().length>=8)last=node;const range=doc.createRange();range.setStart(last,0);range.setEnd(last,6);doc.getSelection().removeAllRanges();doc.getSelection().addRange(range);doc.dispatchEvent(new Event('selectionchange'));})()`);
      await page.click('[data-action="highlight"]');
      await page.waitFor(`!document.querySelector('.tab-dirty') && document.querySelector('#status-left').textContent.includes('주석이 앱에 자동 저장됨')`);
    };
    await highlight();const second=await state();assert.equal(second.metadata.annotations.length,1);assert.equal(second.revisions.length,2);assert.equal(second.html,first.html);
    const separate=await page.evaluate(`new Promise((resolve,reject)=>{const request=indexedDB.open('HTMLMemo-v1',2);request.onsuccess=()=>{const db=request.result,tx=db.transaction(['documents','contents'],'readonly'),docs=tx.objectStore('documents').getAll(),contents=tx.objectStore('contents').getAll();tx.oncomplete=()=>{resolve({documentHasHTML:Object.hasOwn(docs.result[0],'html'),contents:contents.result.length,html:contents.result[0].html});db.close();};tx.onabort=()=>reject(tx.error);};request.onerror=()=>reject(request.error);})`);
    assert.equal(separate.documentHasHTML,false);assert.equal(separate.contents,1);assert.equal(separate.html,first.html);
    // View changes persist, but do not duplicate annotation history or serialize a new body.
    await page.evaluate(`document.querySelector('.document-host:not([hidden]) .reader-viewport').dispatchEvent(new Event('scroll'))`);
    await page.waitFor(`!document.querySelector('.tab-dirty')`);assert.equal((await state()).revisions.length,2);
    await highlight();const third=await state();assert.equal(third.metadata.annotations.length,2);assert.equal(third.revisions.length,3);assert.equal(third.html,first.html);
    assert.equal(await page.evaluate('window.permissionRequests'),0);assert.equal(await page.evaluate('!!document.querySelector("#retry-save")'),false);
    const openHistory=async()=>{await page.evaluate(`document.querySelector('[data-action="more"]').click()`);await page.waitFor(`!!document.querySelector('[data-more="history"]')`);await page.click('[data-more="history"]');await page.waitFor(`!!document.querySelector('[data-revision]')`);};
    const restore=async id=>{await openHistory();await page.click(`[data-revision="${id}"]`);await page.waitFor(`!!document.querySelector('#restore-revision')`);await page.click('#restore-revision');await page.waitFor(`!document.querySelector('#dialog').open && !document.querySelector('.tab-dirty')`);};
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
    await page.waitFor(`!document.querySelector('.tab-dirty')`);const beforeReload=await state();
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
