// Actual Chrome only in CI / trusted environments. This uses the shipped app,
// its ordinary import, toolbar, folder autosave and export paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {root,prepareAssets,packageAssets} from '../scripts/assets.mjs';
import {pwaEntries} from '../public/src/distribution.js';
import {createServer} from '../scripts/server.mjs';
import {launchChrome,clickLibraryImport} from './chrome.mjs';

const frame='document.querySelector(".document-host:not([hidden]) iframe")',doc=frame+'.contentDocument';
const ready=frame+'?.style.visibility==="visible"&&!!'+doc+'.querySelector("img[data-pdf-raster]")?.complete&&'+doc+'.querySelector("img[data-pdf-raster]").naturalWidth>0';
async function environment(){
  await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'htmlmemo-pdf-'));
  for(const entry of pwaEntries(await packageAssets())){const path=join(folder,entry.name);await mkdir(join(path,'..'),{recursive:true});await writeFile(path,entry.data);}
  const server=createServer(folder);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {url:process.env.HTMLMEMO_SIDEBAR_TEST_URL||`http://127.0.0.1:${server.address().port}/`,async close(){await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}};
}
async function chooseFile(page,bytes,name){
  await page.evaluate(`(async()=>{const root=await navigator.storage.getDirectory(),incoming=await root.getDirectoryHandle('PDF incoming fixture',{create:true}),h=await incoming.getFileHandle(${JSON.stringify(name)},{create:true}),w=await h.createWritable();await w.write(Uint8Array.from(atob(${JSON.stringify(Buffer.from(bytes).toString('base64'))}),c=>c.charCodeAt(0)));await w.close();window.showOpenFilePicker=async()=>[h];})()`);
  await clickLibraryImport(page);
}
async function saved(page,condition='true'){
  await page.waitFor(`(async()=>{const s=await import('./src/storage.js'),rows=await s.listDocuments();window.__pdfRecords=await Promise.all(rows.map(r=>s.getDocument(r.id)));return window.__pdfRecords.length&&(${condition})&&!document.querySelector('.tab-dirty:not([hidden])');})()`,30000);
}
const controls=`(()=>{const host=document.querySelector('.document-host:not([hidden])'),bar=host.querySelector('[data-htmlmemo-reading-controls]');return {actions:[...bar.querySelectorAll('button')].map(b=>b.dataset.action),themes:[...bar.querySelector('select').options].map(o=>o.text),height:bar.getBoundingClientRect().height,floating:[...document.querySelectorAll('#toolbar button[data-action]')].map(b=>b.dataset.action),sidebar:[...document.querySelectorAll('#sidebar [data-sidebar-view]')].map(b=>({view:b.dataset.sidebarView,hidden:b.hidden}))};})()`;

test('real Chrome: Pages-only PDF uses the HTML and Markdown UI, saves page annotations and exports a portable file',{timeout:180000},async()=>{
  const env=await environment();let chrome,receiver;
  try{
    chrome=await launchChrome();const page=chrome.page;await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});await page.navigate(env.url);
    const original=await readFile(new URL('fixtures/unified-reader.pdf',import.meta.url));await chooseFile(page,original,'같은 읽기 도구.pdf');await page.waitFor(ready,30000);await saved(page,"window.__pdfRecords[0].metadata.format==='pdf'");
    assert.equal(await page.evaluate("document.querySelector('[data-sidebar-view=outline]').getAttribute('aria-pressed')"),'true');assert.equal(await page.evaluate('document.querySelectorAll("#sidebar [data-heading]").length'),3);
    const pdfControls=await page.evaluate(controls);assert.equal(pdfControls.height,24);assert.deepEqual(pdfControls.actions,['toggle-sidebar','reading-back','previous-heading','next-heading','speak','font-smaller','font-larger','zoom']);
    // Pixel data plus an actual visible raster guard the hidden-iframe canvas
    // regression; a populated but unpainted canvas is insufficient.
    assert.equal(await page.evaluate(`(()=>{const image=${doc}.querySelector('[data-pdf-raster]'),canvas=${doc}.querySelector('canvas'),pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;return image.getBoundingClientRect().height>100&&pixels.some((n,i)=>i%4!==3&&n<100);})()`),true);
    await page.click('.document-host:not([hidden]) [data-action=next-heading]');await page.waitFor(doc+'.querySelector("#pdf-page-3[data-pdf-ready]")',30000);
    await page.click('.document-host:not([hidden]) [data-action=reading-back]');await page.waitFor(doc+'.querySelector("#pdf-page-1[data-pdf-ready]")');
    await page.evaluate(`(()=>{const d=${doc},span=[...d.querySelectorAll('#pdf-page-1 .textLayer span')].find(s=>s.textContent.includes('Page 1.')),r=d.createRange();r.selectNodeContents(span);d.getSelection().removeAllRanges();d.getSelection().addRange(r);d.dispatchEvent(new Event('selectionchange'));})()`);
    await page.click('#toolbar [data-action=highlight]');await page.waitFor(doc+'.querySelector("[data-htmlmemo-pdf-mark]")');await saved(page,'window.__pdfRecords[0].metadata.annotations.length===1');
    const before=await page.evaluate(`(()=>{const r=${doc}.querySelector('[data-htmlmemo-pdf-mark] rect').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()`);
    await page.click('.document-host:not([hidden]) [data-action=font-larger]');await saved(page,'window.__pdfRecords[0].metadata.view.fontScale===1.1');
    const scaled=await page.evaluate(`(()=>{const d=${doc},r=d.querySelector('[data-htmlmemo-pdf-mark] rect').getBoundingClientRect(),s=[...d.querySelectorAll('#pdf-page-1 .textLayer span')].find(s=>s.textContent.includes('Page 1.')).getBoundingClientRect();return {ratio:r.width/${before.width},alignment:Math.abs(r.top-s.top),width:Math.abs(r.width-s.width)};})()`);assert.ok(Math.abs(scaled.ratio-1.1)<.03);assert.ok(scaled.alignment<2&&scaled.width<2);
    await page.click('[data-sidebar-view=search]');assert.equal(await page.evaluate('document.querySelectorAll("#sidebar .search-field input").length'),2);
    await page.evaluate(`(()=>{const input=document.querySelector('#book-search');input.value='Page 8';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);await page.waitFor('document.querySelectorAll("[data-whole-search-index]").length===12',30000);await page.click('[data-whole-search-index="0"]');await page.waitFor(doc+'.querySelector("#pdf-page-8[data-pdf-ready]")&&'+doc+'.querySelector("[data-htmlmemo-pdf-book-search]")',30000);
    assert.equal(await page.evaluate('document.querySelector("#book-search-prev").disabled'),true);
    await page.click('[data-sidebar-view=bookmarks]');await page.click('#add-bookmark');await page.evaluate("document.querySelector('#note-text').value='PDF 여덟째 쪽'");await page.click('.note-form button[value=save]');await saved(page,'window.__pdfRecords[0].metadata.bookmarks.length===1');
    const stored=await page.evaluate('window.__pdfRecords[0]&&({format:window.__pdfRecords[0].metadata.format,notes:window.__pdfRecords[0].metadata.annotations,bookmarks:window.__pdfRecords[0].metadata.bookmarks,view:window.__pdfRecords[0].metadata.view,size:window.__pdfRecords[0].file.size})');assert.equal(stored.bookmarks[0].pdfPosition.page,8);assert.equal(stored.size,original.length);assert.equal(stored.notes[0].pdfPage,1);
    await page.waitFor('document.querySelector("#data-folder-status").textContent==="폴더 자동 저장 완료"',30000);
    assert.equal(await page.evaluate(`(async()=>{const s=await import('./src/storage.js'),folder=await s.getSetting('folder'),manifest=JSON.parse(await(await(await folder.getFileHandle('HTMLMemo-library.json')).getFile()).text());return manifest.documents.some(e=>e.source.name.endsWith('.pdf')&&e.copy.name.endsWith('.pdf'));})()`),true);
    await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/pages-only-pdf-1280.png'),await page.screenshot());
    // Same actual app UI for Markdown and ordinary HTML, including both search
    // fields and the same default outline tab.
    await page.click('#library-tab');await page.click('#paste-button');await page.evaluate("document.querySelector('#paste-title').value='UI comparison';document.querySelector('#paste-text').value='# First\\n\\nText body.\\n\\n## Next\\n\\nAnother section.'");await page.click('#paste-save');await page.waitFor(frame+'?.style.visibility==="visible"');const markdownControls=await page.evaluate(controls);assert.deepEqual(markdownControls,pdfControls);
    await chooseFile(page,Buffer.from('<!doctype html><title>HTML comparison</title><h1>First</h1><p>Text body.</p><h2>Next</h2>'),'UI comparison.html');await page.waitFor(frame+'?.style.visibility==="visible"');assert.deepEqual(await page.evaluate(controls),pdfControls);
    await page.click('#library-tab');await page.click('[data-open="'+await page.evaluate('window.__pdfRecords[0].id')+'"]');await page.waitFor(ready,30000);
    await page.evaluate(`(async()=>{const root=await navigator.storage.getDirectory();window.__pdfExport=await root.getFileHandle('PDF annotations.html',{create:true});window.showSaveFilePicker=async()=>window.__pdfExport;})()`);await page.click('#save-page');await page.waitFor("document.querySelector('#toast').textContent.includes('내보냈습니다')");
    const exported=Buffer.from(await page.evaluate(`(async()=>{const f=await window.__pdfExport.getFile(),bytes=new Uint8Array(await f.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=16384)binary+=String.fromCharCode(...bytes.subarray(i,i+16384));return btoa(binary);})()`),'base64');assert.ok(exported.length>original.length);
    receiver=await launchChrome();await receiver.page.navigate(env.url);await chooseFile(receiver.page,exported,'PDF annotations.html');await receiver.page.waitFor(ready,30000);await saved(receiver.page,'window.__pdfRecords[0].metadata.annotations.length===1&&window.__pdfRecords[0].metadata.bookmarks.length===1');assert.equal(await receiver.page.evaluate('window.__pdfRecords[0].metadata.view.fontScale'),1.1);assert.equal(await receiver.page.evaluate('window.__pdfRecords[0].metadata.bookmarks[0].pdfPosition.page'),8);
    await receiver.page.send('Emulation.setDeviceMetricsOverride',{width:320,height:640,deviceScaleFactor:1,mobile:true});await receiver.page.click('[data-sidebar-view=search]');
    const phone=await receiver.page.evaluate(`(()=>{const bar=document.querySelector('.document-host:not([hidden]) [data-htmlmemo-reading-controls]'),toolbar=document.querySelector('#toolbar');return {pageOverflow:document.documentElement.scrollWidth>innerWidth,barHeight:bar.getBoundingClientRect().height,canScroll:bar.scrollWidth>bar.clientWidth,toolbarScroll:getComputedStyle(toolbar).overflowX,fields:[...document.querySelectorAll('#sidebar .search-field input')].map(e=>({height:e.getBoundingClientRect().height,font:getComputedStyle(e).fontSize}))};})()`);assert.equal(phone.pageOverflow,false);assert.equal(phone.barHeight,24);assert.deepEqual(phone.fields[0],phone.fields[1]);await writeFile(join(root,'test-results/pages-only-pdf-320.png'),await receiver.page.screenshot());
    assert.deepEqual(chrome.errors,[]);assert.deepEqual(receiver.errors,[]);await writeFile(join(root,'test-results/pages-only-pdf-unified.json'),JSON.stringify({status:'pass',pdfControls,markdownControls,scaled,phone,sourceBytes:original.length,archiveBytes:exported.length,bookmarkPage:8,notes:1,errors:[]},null,2));
  }finally{await receiver?.close();await chrome?.close();await env.close();}
});

test('real Chrome: Pages-only PDF ignores document scripts, reports locked or damaged files and reopens offline',{timeout:150000},async()=>{
  const env=await environment();let chrome;
  try{
    chrome=await launchChrome();const page=chrome.page;await page.navigate(env.url);const bytes=await readFile(new URL('fixtures/unified-reader-actions.pdf',import.meta.url));await chooseFile(page,bytes,'actions.pdf');await page.waitFor(ready,30000);await saved(page);
    assert.equal(await page.evaluate('globalThis.__htmlmemoPdfScriptRan'),undefined);assert.equal(await page.evaluate(doc+'.querySelectorAll("script,object,embed").length'),0);
    await chooseFile(page,await readFile(new URL('fixtures/unified-reader-locked.pdf',import.meta.url)),'locked.pdf');await page.waitFor('document.querySelector("#toast").textContent.includes("암호")',30000);
    await chooseFile(page,Buffer.from('This is not a PDF'),'damaged.pdf');await page.waitFor('document.querySelector("#toast").textContent.includes("올바른 PDF")');await saved(page,'window.__pdfRecords.length===1');
    // The installed/PWA shell includes the matching worker, CMaps, standard
    // fonts and image decoders locally. Reopening does not fetch a CDN.
    await page.evaluate('navigator.serviceWorker.ready');await page.waitFor('!!navigator.serviceWorker.controller',30000);await page.send('Network.enable');await page.send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
    await page.navigate(env.url);await page.click('[data-open]');await page.waitFor(ready,30000);assert.equal(await page.evaluate(doc+'.querySelector("[data-pdf-raster]").naturalWidth>0'),true);await page.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
    assert.deepEqual(chrome.errors,[]);await writeFile(join(root,'test-results/pages-only-pdf-security-offline.json'),JSON.stringify({status:'pass',scriptsIgnored:true,lockedReported:true,invalidReported:true,offline:true,errors:[]},null,2));
  }finally{await chrome?.close();await env.close();}
});
