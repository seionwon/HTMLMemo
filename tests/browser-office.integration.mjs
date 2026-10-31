// Executed only by CI or the trusted Chrome test environment, never sandbox Chrome.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {root,prepareAssets,packageAssets} from '../scripts/assets.mjs';
import {pwaEntries} from '../public/src/distribution.js';
import {createServer} from '../scripts/server.mjs';
import {launchChrome,clickLibraryImport} from './chrome.mjs';
import {officeFixtures} from './office-fixtures.mjs';
const frame='document.querySelector(".document-host:not([hidden]) iframe")',doc=frame+'.contentDocument';
async function environment(){
  await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'librememo-office-'));
  for(const entry of pwaEntries(await packageAssets())){const path=join(folder,entry.name);await mkdir(join(path,'..'),{recursive:true});await writeFile(path,entry.data);}
  const server=createServer(folder);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {url:process.env.HTMLMEMO_SIDEBAR_TEST_URL||`http://127.0.0.1:${server.address().port}/`,async close(){await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}};
}
async function chooseFile(page,bytes,name){
  await page.evaluate(`(async()=>{const root=await navigator.storage.getDirectory(),incoming=await root.getDirectoryHandle('Office incoming fixture',{create:true}),h=await incoming.getFileHandle(${JSON.stringify(name)},{create:true}),w=await h.createWritable();await w.write(Uint8Array.from(atob(${JSON.stringify(Buffer.from(bytes).toString('base64'))}),c=>c.charCodeAt(0)));await w.close();window.showOpenFilePicker=async()=>[h];})()`);await clickLibraryImport(page);
}
async function saved(page,name,condition='true'){
  await page.waitFor(`(async()=>{const s=await import('./src/storage.js'),rows=await s.listDocuments(),summary=rows.find(r=>r.name===${JSON.stringify(name)});window.__officeRecord=summary?await s.getDocument(summary.id):null;return window.__officeRecord&&(${condition})&&!document.querySelector('.tab-dirty:not([hidden])');})()`,30000);
}
const controls=`(()=>{const bar=document.querySelector('.document-host:not([hidden]) [data-htmlmemo-reading-controls]');return {actions:[...bar.querySelectorAll('button')].map(b=>b.dataset.action),height:bar.getBoundingClientRect().height,floating:[...document.querySelectorAll('#toolbar button[data-action]')].map(b=>b.dataset.action),sidebar:[...document.querySelectorAll('#sidebar [data-sidebar-view]')].map(b=>b.dataset.sidebarView)};})()`;
test('real Chrome: Pages-only GenOffice opens every format read-only with the existing HTML UI',{timeout:240000},async()=>{
  const env=await environment();let chrome;
  try{
    chrome=await launchChrome();const page=chrome.page;await page.navigate(env.url);
    await chooseFile(page,Buffer.from('<!doctype html><title>Baseline</title><h1>첫 장</h1><p>본문</p>'),'baseline.html');await saved(page,'baseline.html');const baseline=await page.evaluate(controls),results=[];
    for(const [format,bytes] of Object.entries(await officeFixtures())){
      const name='읽기 전용.'+format;await chooseFile(page,bytes,name);
      // .md and .markdown intentionally share exact bytes. Exercise the normal
      // duplicate choice instead of waiting for a record the user has not chosen.
      if(format==='markdown'){await page.waitFor('document.querySelector("[data-duplicate-import]")');await page.click('[data-duplicate-import] [value=new]');}
      await saved(page,name);await page.waitFor(frame+'?.style.visibility==="visible"');
      assert.deepEqual(await page.evaluate(controls),baseline,format+' has identical controls');
      const info=await page.evaluate(`(async()=>{const r=window.__officeRecord,{textIndex}=await import('./src/document.js'),bytes=new Uint8Array(await r.originalFile.arrayBuffer());return {name:r.name,text:textIndex(${doc}).text,unsafe:${doc}.querySelectorAll('script,object,embed,[contenteditable]').length,script:r.metadata.execution.allowScripts,original:Array.from(bytes)};})()`);
      assert.match(info.text,/본문|한국어/,format);assert.equal(info.unsafe,0);assert.equal(info.script,false);assert.deepEqual(info.original,[...bytes]);results.push({format,originalBytes:bytes.length,searchable:true,readOnly:true});
      assert.equal(await page.evaluate("document.querySelector('[data-sidebar-view=outline]').getAttribute('aria-pressed')"),'true');
    }
    await page.waitFor('document.querySelector("#data-folder-status").textContent==="폴더 저장 완료"',30000);
    const copies=await page.evaluate(`(async()=>{const s=await import('./src/storage.js'),folder=await s.getSetting('folder'),manifest=JSON.parse(await(await(await folder.getFileHandle('HTMLMemo-library.json')).getFile()).text());return manifest.documents.map(e=>({original:e.original.name,copy:e.copy.name,source:e.source.name}));})()`);
    for(const format of Object.keys(await officeFixtures()))assert.ok(copies.some(c=>c.original.endsWith('.'+format)&&c.copy.endsWith('.'+format)&&c.source.endsWith('.html')),format+' retains original extension');
    assert.deepEqual(chrome.errors,[]);await writeFile(join(root,'test-results/pages-only-office-formats.json'),JSON.stringify({status:'pass',results,controls:baseline,folderCopies:copies.length,errors:[]},null,2));
  }catch(error){if(chrome){await writeFile(join(root,'test-results/pages-only-office-formats-failure.png'),await chrome.page.screenshot());console.error('Office import diagnostic',await chrome.page.evaluate('({toast:document.querySelector("#toast")?.textContent,tab:document.querySelector(".tab.active")?.textContent})'));}throw error;}finally{await chrome?.close();await env.close();}
});
test('real Chrome: Pages-only Office annotations, bookmarks, slide scaling, export, mobile and offline import',{timeout:210000},async()=>{
  const env=await environment(),fixtures=await officeFixtures();let chrome,receiver;
  try{
    chrome=await launchChrome();const page=chrome.page;await page.navigate(env.url);
    for(const [format,selector] of [['docx','.office-word p span'],['xlsx','#office-cell-0-A2'],['pptx','[data-office-text]']]){
      const name='주석.'+format;await chooseFile(page,fixtures[format],name);await saved(page,name);
      await page.evaluate(`(()=>{const d=${doc},node=d.querySelector(${JSON.stringify(selector)}),range=d.createRange();range.selectNodeContents(node);d.getSelection().removeAllRanges();d.getSelection().addRange(range);d.dispatchEvent(new Event('selectionchange'));})()`);
      await page.click('#toolbar [data-action=highlight]');await saved(page,name,'window.__officeRecord.metadata.annotations.length===1');assert.equal(await page.evaluate(doc+'.querySelectorAll("[data-htmlmemo-mark]").length>0'),true);
      await page.click('[data-sidebar-view=bookmarks]');await page.click('#add-bookmark');await page.evaluate("document.querySelector('#note-text').value='Office 돌아올 곳'");await page.click('.note-form button[value=save]');await saved(page,name,'window.__officeRecord.metadata.bookmarks.length===1');
    }
    const width=await page.evaluate(doc+'.querySelector(".office-slide>svg").getBoundingClientRect().width');await page.click('.document-host:not([hidden]) [data-action=font-larger]');await saved(page,'주석.pptx','window.__officeRecord.metadata.view.fontScale===1.1');const ratio=await page.evaluate(doc+'.querySelector(".office-slide>svg").getBoundingClientRect().width/'+width);assert.ok(Math.abs(ratio-1.1)<.03,'slide zoom '+ratio);
    for(let i=0;i<4;i++)await page.click('.document-host:not([hidden]) [data-action=font-larger]');
    const overflow=await page.evaluate(`(()=>{const d=${doc};d.defaultView.scrollTo(100000,0);return {width:d.documentElement.scrollWidth,viewport:d.documentElement.clientWidth,left:d.defaultView.scrollX};})()`);assert.ok(overflow.width>overflow.viewport&&overflow.left>0,'large slide zoom must remain horizontally reachable: '+JSON.stringify(overflow));
    for(let i=0;i<4;i++)await page.click('.document-host:not([hidden]) [data-action=font-smaller]');await page.evaluate(doc+'.defaultView.scrollTo(0,0)');
    await page.click('[data-sidebar-view=search]');await page.evaluate("const input=document.querySelector('#book-search');input.value='검색';input.dispatchEvent(new Event('input',{bubbles:true}));");await page.waitFor('document.querySelector("[data-whole-search-index]")',30000);await page.click('[data-whole-search-index="0"]');
    await page.evaluate(`(async()=>{const root=await navigator.storage.getDirectory();window.__officeExport=await root.getFileHandle('Office annotations.html',{create:true});window.showSaveFilePicker=async()=>window.__officeExport;})()`);await page.click('#save-page');await page.waitFor("document.querySelector('#toast').textContent.includes('내보냈습니다')");
    const exported=Buffer.from(await page.evaluate(`(async()=>{const f=await window.__officeExport.getFile(),bytes=new Uint8Array(await f.arrayBuffer());let s='';for(let i=0;i<bytes.length;i+=16384)s+=String.fromCharCode(...bytes.subarray(i,i+16384));return btoa(s);})()`),'base64');
    receiver=await launchChrome();await receiver.page.navigate(env.url);await chooseFile(receiver.page,exported,'Office annotations.html');await saved(receiver.page,'Office annotations.html','window.__officeRecord.metadata.annotations.length===1&&window.__officeRecord.metadata.bookmarks.length===1');
    await page.send('Emulation.setDeviceMetricsOverride',{width:320,height:640,deviceScaleFactor:1,mobile:true});const mobile=await page.evaluate(`({overflow:document.documentElement.scrollWidth>innerWidth,toolbar:getComputedStyle(document.querySelector('#toolbar')).overflowX})`);assert.equal(mobile.overflow,false);await writeFile(join(root,'test-results/pages-only-office-320.png'),await page.screenshot());
    await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});await writeFile(join(root,'test-results/pages-only-office-1280.png'),await page.screenshot());
    await page.evaluate('navigator.serviceWorker.ready');await page.waitFor('!!navigator.serviceWorker.controller',30000);await page.send('Network.enable');await page.send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});await chooseFile(page,fixtures.odt,'offline.odt');await saved(page,'offline.odt');
    await chooseFile(page,Buffer.from('invalid'),'damaged.docx');await page.waitFor('document.querySelector("#toast").textContent.includes("손상")');assert.equal(await page.evaluate('(async()=>{const s=await import("./src/storage.js");return(await s.listDocuments()).some(r=>r.name==="damaged.docx");})()'),false);
    assert.deepEqual(chrome.errors,[]);assert.deepEqual(receiver.errors,[]);await writeFile(join(root,'test-results/pages-only-office-annotations.json'),JSON.stringify({status:'pass',annotated:['docx','xlsx','pptx'],bookmarks:true,slideScale:ratio,exportBytes:exported.length,mobile,offline:true,errors:[]},null,2));
  }catch(error){if(chrome){await writeFile(join(root,'test-results/pages-only-office-annotations-failure.png'),await chrome.page.screenshot());console.error('Office annotation diagnostic',await chrome.page.evaluate('({toast:document.querySelector("#toast")?.textContent,sidebar:document.querySelector("#sidebar")?.textContent})'));}throw error;}finally{await receiver?.close();await chrome?.close();await env.close();}
});
