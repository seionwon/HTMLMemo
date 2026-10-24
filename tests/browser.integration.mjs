// Requires permission to bind localhost and launch a dedicated Chrome process.
// These are real browser checks, separate from the DOM/unit test suite.
import test from 'node:test';
import {createServer as createHTTPServer} from 'node:http';
import assert from 'node:assert/strict';
import { mkdtemp, cp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { root, prepareAssets } from '../scripts/assets.mjs';
import { createServer } from '../scripts/server.mjs';
import { launchChrome, clickAppMenu, clickLibraryImport } from './chrome.mjs';
import { FORMAT_VERSION } from '../public/src/model.js';
import { deflateRawSync } from 'node:zlib';
const appVersion=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version;
async function revealAnnotation(page,doc,id){
  await page.evaluate(`(()=>{let node=${doc}.querySelector('[data-annotation="'+${JSON.stringify(id)}+'"]');if(!node)throw Error('Missing annotation');for(node=node.parentElement;node;node=node.parentElement)if(node.matches('details[data-annotation-group]'))node.open=true;})()`);
}
async function verifyLoadedSearchEnds(page,doc,prefix,total,click,screenshotName){
  const state=()=>page.evaluate(`(()=>{const d=${doc};return {count:d.querySelector('#${prefix}search-count').textContent,prev:d.querySelector('#${prefix}search-prev').disabled,next:d.querySelector('#${prefix}search-next').disabled};})()`);
  const expected=position=>({count:`${position} / ${total}개 결과`,prev:position===1,next:position===total});
  const enter=async shift=>{await page.evaluate(`${doc}.querySelector('#${prefix}document-search').focus()`);await page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,modifiers:shift?8:0,text:'\r',unmodifiedText:'\r'});await page.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});};
  assert.deepEqual(await state(),expected(1));await click('#'+prefix+'search-prev');await enter(true);assert.deepEqual(await state(),expected(1));
  for(let position=2;position<=total;position++){await click('#'+prefix+'search-next');assert.deepEqual(await state(),expected(position));}
  const mark=await page.evaluate(`(()=>{const d=${doc},m=d.querySelector('[data-htmlmemo-search]');return {text:m?.textContent,top:m?.getBoundingClientRect().top};})()`);
  await click('#'+prefix+'search-next');await enter(false);assert.deepEqual(await state(),expected(total));assert.deepEqual(await page.evaluate(`(()=>{const d=${doc},m=d.querySelector('[data-htmlmemo-search]');return {text:m?.textContent,top:m?.getBoundingClientRect().top};})()`),mark);
  await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,`test-results/sidebar-views-search-end-${screenshotName}.png`),await page.screenshot());
  for(let position=total-1;position>=1;position--){await click('#'+prefix+'search-prev');assert.deepEqual(await state(),expected(position));}
  await enter(true);assert.deepEqual(await state(),expected(1));
  await click('[data-search-index="'+(total-1)+'"]');assert.deepEqual(await state(),expected(total));await click('[data-search-index="0"]');assert.deepEqual(await state(),expected(1));
}
test('real Chrome: MHTML import restores a Chrome archive, saves notes and exports self-contained HTML',{timeout:90000},async()=>{
  await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'htmlmemo-mhtml-'));await cp(join(root,'public'),folder,{recursive:true});
  const server=createServer(folder),requests=[];
  const site=createHTTPServer((request,response)=>{
    requests.push(request.url);
    if(request.url==='/assets/main.css'){response.setHeader('Content-Type','text/css');response.end('@import "type.css"; body{margin:0;padding:32px;font:18px/1.6 system-ui} #target{height:160px;color:rgb(22,40,62)} #photo{width:48px;height:48px}');}
    else if(request.url==='/assets/type.css'){response.setHeader('Content-Type','text/css');response.end('h1{letter-spacing:2px} #target{background-image:url(picture.svg);background-repeat:no-repeat;background-position:right}');}
    else if(request.url==='/assets/picture.svg'){response.setHeader('Content-Type','image/svg+xml');response.end('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="#f3c66b"/><path d="M10 24h28M24 10v28" stroke="#334155" stroke-width="3"/></svg>');}
    else if(request.url==='/child.html'){response.setHeader('Content-Type','text/html; charset=utf-8');response.end('<!doctype html><html><head><title>Child</title><style>p{color:rgb(22,40,62)}</style></head><body><p id="child">보관된 프레임 · Saved frame</p><img src="/assets/picture.svg"></body></html>');}
    else {response.setHeader('Content-Type','text/html; charset=utf-8');response.end('<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>MHTML 보관 검증</title><link rel="stylesheet" href="/assets/main.css"><link rel="icon" href="data:,"></head><body><h1>MHTML 보관 검증</h1><p id="target">한글 본문과 그림을 보존하고 주석을 남깁니다.</p><img id="photo" src="/assets/picture.svg"><iframe name="archived-child" title="저장된 프레임" src="/child.html"></iframe><a href="#target">본문으로</a></body></html>');}
  });let chrome;
  try{
    await Promise.all([new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)),new Promise(resolve=>site.listen(0,'127.0.0.1',resolve))]);chrome=await launchChrome();const page=chrome.page;
    await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
    const sourceURL=`http://127.0.0.1:${site.address().port}/article.html`;
    await page.navigate(sourceURL);await page.waitFor('document.querySelector("#photo")?.complete&&document.querySelector("#photo").naturalWidth===48&&document.querySelector("iframe")?.contentDocument.querySelector("#child")&&getComputedStyle(document.querySelector("#target")).color==="rgb(22, 40, 62)"');
    const {data:raw}=await page.send('Page.captureSnapshot',{format:'mhtml'});assert.match(raw,/multipart\/related/);const requestCount=requests.length;
    const url=process.env.HTMLMEMO_SIDEBAR_TEST_URL||`http://127.0.0.1:${server.address().port}/`;await page.navigate(url);await page.waitFor('document.querySelector("#status-left").textContent.includes("개의 문서")');
    await page.evaluate(`(async()=>{const root=await navigator.storage.getDirectory(),handle=await root.getFileHandle('Chrome.mhtml',{create:true}),writer=await handle.createWritable();await writer.write(${JSON.stringify(raw)});await writer.close();window.showOpenFilePicker=async options=>{window.mhtmlPickerOptions=options;return [handle];};})()`);
    const frame='document.querySelector(".document-host:not([hidden]) iframe")',doc=frame+'.contentDocument',ready=frame+'?.style.visibility==="visible"&&!document.querySelector(".tab-dirty:not([hidden])")';
    const verify=async()=>{
      await page.waitFor(ready);await page.waitFor(`${doc}.querySelector('#photo')?.complete&&${doc}.querySelector('#photo').naturalWidth===48`);
      const state=await page.evaluate(`(()=>{const d=${doc},target=d.querySelector('#target'),child=d.querySelector('iframe');return {title:d.title,text:target.textContent,color:d.defaultView.getComputedStyle(target).color,spacing:d.defaultView.getComputedStyle(d.querySelector('h1')).letterSpacing,background:d.defaultView.getComputedStyle(target).backgroundImage,image:d.querySelector('#photo').getAttribute('src'),frame:child?.getAttribute('srcdoc'),scripts:d.querySelectorAll('script:not([type="application/json"])').length};})()`);
      assert.equal(state.title,'MHTML 보관 검증');assert.match(state.text,/한글 본문/);assert.equal(state.color,'rgb(22, 40, 62)');assert.equal(state.spacing,'2px');assert.match(state.background,/data:image\/svg\+xml;base64,/);assert.match(state.image,/^data:image\/svg\+xml;base64,/);assert.match(state.frame,/보관된 프레임/);assert.equal(state.scripts,0);assert.equal(requests.length,requestCount,'opening/reopening never fetches the source website');
      // Inspect the actual sandboxed child browsing context, not just srcdoc
      // text: a CSP-blocked iframe used to retain that text but render blank.
      const {result:owner}=await page.send('Runtime.evaluate',{expression:`${doc}.querySelector('iframe')`});
      const {node}=await page.send('DOM.describeNode',{objectId:owner.objectId});
      assert.ok(node.frameId,'the archived iframe owner must have a browsing context: '+JSON.stringify(node));
      const {targetInfos}=await page.send('Target.getTargets'),outOfProcess=targetInfos.some(target=>target.type==='iframe'&&target.targetId===node.frameId);
      const sessionId=outOfProcess?(await page.send('Target.attachToTarget',{targetId:node.frameId,flatten:true})).sessionId:undefined;
      try{
        const {executionContextId}=await page.send('Page.createIsolatedWorld',{frameId:node.frameId,worldName:'htmlmemo-mhtml-verification'},sessionId);
        const {result,exceptionDetails}=await page.send('Runtime.evaluate',{contextId:executionContextId,expression:'({text:document.body.innerText,color:getComputedStyle(document.querySelector("#child")).color,image:document.querySelector("img").naturalWidth,isolated:(()=>{try{return !parent.document}catch{return true}})()})',returnByValue:true},sessionId);
        assert.equal(exceptionDetails,undefined);assert.match(result.value.text,/Saved frame/);assert.equal(result.value.color,'rgb(22, 40, 62)');assert.equal(result.value.image,48);assert.equal(result.value.isolated,true);
      }finally{if(sessionId)await page.send('Target.detachFromTarget',{sessionId});}
    };
    const rows=()=>page.evaluate(`(async()=>{return (await import('./src/storage.js')).listDocuments();})()`);
    const input=async(name,contents=raw)=>page.evaluate(`(()=>{const t=new DataTransfer();t.items.add(new File([${JSON.stringify(contents)}],${JSON.stringify(name)},{type:${JSON.stringify(/\.html?$/i.test(name)?'text/html':'multipart/related')}}));const input=document.querySelector('#file-input');input.files=t.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await clickLibraryImport(page);await verify();const original=(await rows())[0];assert.equal(original.name,'Chrome.mhtml');assert.equal(original.source,sourceURL);assert.equal(original.sourceIdentity.size,Buffer.byteLength(raw));assert.deepEqual(original.metadata.warnings,[]);assert.equal(original.metadata.execution.allowScripts,false);
    assert.equal(await page.evaluate('window.mhtmlPickerOptions.types[0].accept["multipart/related"].includes(".mhtml")&&window.mhtmlPickerOptions.types[0].accept["multipart/related"].includes(".mht")'),true);
    await page.click('#toolbar [data-action=note]');const point=await page.evaluate(`(()=>{const f=${frame},r=f.contentDocument.querySelector('#target').getBoundingClientRect(),b=f.getBoundingClientRect(),s=b.width/f.offsetWidth;return {x:b.left+(r.left+80)*s,y:b.top+(r.top+60)*s};})()`);
    await page.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',buttons:1,clickCount:1});await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',buttons:0,clickCount:1});await page.waitFor('document.querySelector("#dialog").open&&document.querySelector("#note-text")');await page.evaluate('document.querySelector("#note-text").value="MHTML에 남긴 주석"');await page.click('#dialog button[value=save]');
    await page.waitFor(`(async()=>{return (await(await import('./src/storage.js')).getDocument(${JSON.stringify(original.id)})).metadata.annotations.some(a=>a.text==='MHTML에 남긴 주석');})()`);await verify();
    await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/mhtml-import-1280.png'),await page.screenshot());
    await page.navigate(url);await page.waitFor('document.querySelector("[data-open]")');await page.click('[data-open]');await verify();assert.equal((await rows())[0].metadata.annotations[0].text,'MHTML에 남긴 주석');
    await input('renamed.MHT');await page.waitFor('document.querySelector("#dialog").open&&document.querySelector("[data-duplicate-import]")');await page.click('[data-duplicate-import] [value=existing]');await verify();assert.equal((await rows()).length,1);
    await page.evaluate(`(()=>{const t=new DataTransfer();t.items.add(new File([${JSON.stringify(raw)}],'dropped.mht'));window.dispatchEvent(new DragEvent('drop',{dataTransfer:t,cancelable:true}));})()`);await page.waitFor('document.querySelector("#dialog").open&&document.querySelector("[data-duplicate-import]")');await page.click('[data-duplicate-import] [value=cancel]');await page.waitFor('!document.querySelector("#dialog").open');
    await page.evaluate(`(async()=>{const root=await navigator.storage.getDirectory(),handle=await root.getFileHandle('exported.html',{create:true});window.showSaveFilePicker=async options=>{window.mhtmlExportOptions=options;return handle;};})()`);await page.click('#save-page');await page.waitFor('document.querySelector("#toast").textContent.includes("현재 주석을 포함한 HTML")');
    const exported=await page.evaluate(`(async()=>{return (await(await(await navigator.storage.getDirectory()).getFileHandle('exported.html')).getFile()).text();})()`);assert.match(exported,/MHTML에 남긴 주석/);assert.match(exported,/data:image\/svg\+xml;base64,/);assert.doesNotMatch(exported,/multipart\/related/);assert.equal(await page.evaluate('window.mhtmlExportOptions.suggestedName'),'Chrome-주석.html');assert.deepEqual(await page.evaluate('Object.keys(window.mhtmlExportOptions.types[0].accept)'),['text/html']);
    await input('roundtrip.html',exported);await page.waitFor('document.querySelectorAll(".tab.document").length===2&&'+ready);await verify();assert.equal((await rows()).length,2);assert.equal((await rows()).find(r=>r.name==='roundtrip.html').metadata.annotations[0].text,'MHTML에 남긴 주석');
    assert.equal(await page.evaluate(`(async()=>{return (await(await(await navigator.storage.getDirectory()).getFileHandle('Chrome.mhtml')).getFile()).text();})()`),raw);
    await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await verify();await writeFile(join(root,'test-results/mhtml-import-390.png'),await page.screenshot());
    await input('broken.mhtml','not a MIME archive');await page.waitFor('document.querySelector("#toast").classList.contains("error")&&document.querySelector("#toast").textContent.includes("MHTML")');assert.equal((await rows()).length,2);assert.deepEqual(chrome.errors,[]);
  }catch(error){if(chrome){
    const diagnostics={message:error.message,frames:await chrome.page.send('Page.getFrameTree'),app:await chrome.page.evaluate('({status:document.querySelector("#status-left")?.textContent,toast:document.querySelector("#toast")?.textContent,dialog:document.querySelector("#dialog")?.textContent,child:document.querySelector(".document-host:not([hidden]) iframe")?.contentDocument?.querySelector("iframe")?.outerHTML})')};
    await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/mhtml-import-diagnostics.json'),JSON.stringify(diagnostics,null,2));await writeFile(join(root,'test-results/mhtml-import-failure.png'),await chrome.page.screenshot());console.error('MHTML import diagnostics:',JSON.stringify(diagnostics));
  }throw error;}
  finally{await chrome?.close();await Promise.all([new Promise(resolve=>server.close(resolve)),new Promise(resolve=>site.close(resolve))]);await rm(folder,{recursive:true,force:true});}
});
test('real Chrome: duplicate HTML import offers cancel, fresh annotations or existing notes',{timeout:90000},async()=>{
  await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'htmlmemo-duplicate-import-'));await cp(join(root,'public'),folder,{recursive:true});
  const server=createServer(folder);let chrome;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));chrome=await launchChrome();const page=chrome.page;
    const url=process.env.HTMLMEMO_SIDEBAR_TEST_URL||`http://127.0.0.1:${server.address().port}/`;
    await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});await page.navigate(url);await page.waitFor('document.querySelector("#status-left").textContent.includes("개의 문서")');
    const raw=await page.evaluate(`(async()=>{const {parseHTML,serializeHTML}=await import('./src/document.js');const parsed=parseHTML('<html lang="ko"><head><title>중복 가져오기 검증</title><style>body{margin:0;padding:32px;font:18px/1.6 system-ui}#target{height:160px}</style></head><body><h1>중복 가져오기 검증</h1><p id="target">기존 주석은 보존하고 새로운 주석은 별도 문서에 남깁니다.</p></body></html>',{}, {allowScripts:true});parsed.metadata.annotations=[{id:'original-note',type:'note',text:'기존 주석을 보존합니다',color:'#334155',width:3,opacity:1,points:[{x:20,y:70}]}];parsed.metadata.bookmarks=[{id:'original-bookmark',title:'기존 북마크',top:0,left:0}];const html=serializeHTML(new DOMParser().parseFromString(parsed.html,'text/html'),parsed.metadata),root=await navigator.storage.getDirectory(),handle=await root.getFileHandle('duplicate.html',{create:true}),writer=await handle.createWritable();await writer.write(html);await writer.close();window.showOpenFilePicker=async()=>[handle];return html;})()`);
    const ready='document.querySelector(".document-host:not([hidden]) iframe")?.style.visibility==="visible"&&!document.querySelector(".tab-dirty:not([hidden])")';
    const state=()=>page.evaluate(`(async()=>{const {listDocuments,listRevisions}=await import('./src/storage.js');return Promise.all((await listDocuments()).map(async r=>({id:r.id,name:r.name,annotations:r.metadata.annotations,bookmarks:r.metadata.bookmarks,revisions:(await listRevisions(r.id)).length})));})()`);
    const input=async(name='duplicate.html',html=raw)=>page.evaluate(`(()=>{const transfer=new DataTransfer();transfer.items.add(new File([${JSON.stringify(html)}],${JSON.stringify(name)},{type:'text/html',lastModified:1234}));const input=document.querySelector('#file-input');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    const dialog='document.querySelector("#dialog").open&&document.querySelector("[data-duplicate-import]")';
    await clickLibraryImport(page);await page.waitFor(ready);
    const original=(await state())[0],originalTab=await page.evaluate('document.querySelector(".tab.document.active").dataset.tab');assert.equal(original.annotations.length,1);assert.equal(original.bookmarks.length,1);
    const originalReady='!document.querySelector("#dialog").open&&document.querySelector(".tab.document.active")?.dataset.tab==='+JSON.stringify(originalTab)+'&&'+ready;
    await clickLibraryImport(page);await page.waitFor(dialog);
    assert.deepEqual(await page.evaluate('[...document.querySelectorAll("[data-duplicate-import] button")].map(b=>b.textContent)'),['취소','새롭게 열기','기존의 주석 파일로 가기']);assert.equal(await page.evaluate('document.activeElement.value'),'cancel');
    await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/duplicate-import-1280.png'),await page.screenshot());
    await page.click('[data-duplicate-import] [value=cancel]');await page.waitFor('!document.querySelector("#dialog").open');assert.deepEqual(await state(),[original]);
    await input('renamed-copy.html');await page.waitFor(dialog);await page.click('[data-duplicate-import] [value=existing]');await page.waitFor(originalReady);assert.equal(await page.evaluate('document.querySelectorAll(".tab.document").length'),1);assert.equal(await page.evaluate('document.querySelector(".tab.document.active").dataset.tab'),originalTab);assert.deepEqual(await state(),[original]);
    // A drop uses the same serialized import path as both file pickers.
    await page.evaluate(`(()=>{const transfer=new DataTransfer();transfer.items.add(new File([${JSON.stringify(raw)}],'duplicate.html',{type:'text/html'}));window.dispatchEvent(new DragEvent('drop',{dataTransfer:transfer,cancelable:true}));})()`);await page.waitFor(dialog);await page.click('[data-duplicate-import] [value=new]');
    await page.waitFor('document.querySelectorAll(".tab.document").length===2&&'+ready);
    const fresh=(await state()).find(r=>r.id!==original.id);assert.deepEqual(fresh.annotations,[]);assert.deepEqual(fresh.bookmarks,[]);assert.deepEqual((await state()).find(r=>r.id===original.id),original);
    // Create an actual new note through the toolbar and save dialog.
    await page.click('#toolbar [data-action=note]');
    const point=await page.evaluate(`(()=>{const f=document.querySelector('.document-host:not([hidden]) iframe'),r=f.contentDocument.querySelector('#target').getBoundingClientRect(),b=f.getBoundingClientRect(),s=b.width/f.offsetWidth;return {x:b.left+(r.left+80)*s,y:b.top+(r.top+60)*s};})()`);
    await page.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',buttons:1,clickCount:1});await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',buttons:0,clickCount:1});
    await page.waitFor('document.querySelector("#dialog").open&&document.querySelector("#note-text")');await page.evaluate('document.querySelector("#note-text").value="새 사본에서 남긴 주석"');await page.click('#dialog button[value=save]');
    await page.waitFor(`(async()=>{const {getDocument}=await import('./src/storage.js');return (await getDocument(${JSON.stringify(fresh.id)})).metadata.annotations.some(a=>a.text==='새 사본에서 남긴 주석');})()`);await page.waitFor(ready);
    assert.equal((await state()).find(r=>r.id===fresh.id).annotations[0].text,'새 사본에서 남긴 주석');assert.deepEqual((await state()).find(r=>r.id===original.id),original);
    await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await input();await page.waitFor(dialog);
    assert.equal(await page.evaluate(`(()=>{const d=document.querySelector('#dialog').getBoundingClientRect();return d.left>=0&&d.right<=innerWidth&&d.top>=0&&d.bottom<=innerHeight&&[...document.querySelectorAll('[data-duplicate-import] button')].every(b=>{const r=b.getBoundingClientRect();return r.left>=d.left&&r.right<=d.right&&r.bottom<=d.bottom;});})()`),true);
    assert.equal(await page.evaluate('document.querySelectorAll("#duplicate-import-target option").length'),2);
    await writeFile(join(root,'test-results/duplicate-import-390.png'),await page.screenshot());
    await page.evaluate(`document.querySelector('#duplicate-import-target').value=${JSON.stringify(original.id)}`);await page.click('[data-duplicate-import] [value=existing]');await page.waitFor(originalReady);assert.equal(await page.evaluate('document.querySelector(".tab.document.active").dataset.tab'),originalTab);
    await page.click('.tab.document.active .tab-close');await page.waitFor('document.querySelectorAll(".tab.document").length===1');await input();await page.waitFor(dialog);
    await page.evaluate(`document.querySelector('#duplicate-import-target').value=${JSON.stringify(original.id)}`);await page.click('[data-duplicate-import] [value=existing]');await page.waitFor('document.querySelectorAll(".tab.document").length===2&&'+ready);assert.deepEqual((await state()).find(r=>r.id===original.id),original);
    await page.click('.document-host:not([hidden]) > [data-htmlmemo-reading-controls] [data-action=speak]');await page.waitFor('document.querySelector(".mstts-player")');
    await input();await page.waitFor(dialog);await page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await page.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await page.waitFor('!document.querySelector("#dialog").open');assert.equal((await state()).length,2);assert.equal(await page.evaluate('!!document.querySelector(".mstts-player")'),true);await page.click('.mstts-player [aria-label="플레이어 닫기"]');
    await page.navigate(url);await page.waitFor('document.querySelectorAll("[data-open]").length===2');await input();await page.waitFor(dialog);await page.evaluate(`document.querySelector('#duplicate-import-target').value=${JSON.stringify(original.id)}`);await page.click('[data-duplicate-import] [value=existing]');await page.waitFor(ready);assert.deepEqual((await state()).find(r=>r.id===original.id),original);
    assert.equal(await page.evaluate(`(async()=>{return (await(await(await navigator.storage.getDirectory()).getFileHandle('duplicate.html')).getFile()).text();})()`),raw,'no import choice overwrites the source file');assert.deepEqual(chrome.errors,[]);
  }catch(error){if(chrome)console.error('Duplicate import diagnostics:',await chrome.page.evaluate('({status:document.querySelector("#status-left")?.textContent,toast:document.querySelector("#toast")?.textContent,dialog:document.querySelector("#dialog")?.textContent})'));throw error;}
  finally{await chrome?.close();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});
test('real Chrome: duplicate HTML import preflights sizes and preserves exact v1 identities',{timeout:90000},async()=>{
  await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'htmlmemo-duplicate-speed-'));await cp(join(root,'public'),folder,{recursive:true});const server=createServer(folder);let chrome;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));chrome=await launchChrome();const page=chrome.page,url=process.env.HTMLMEMO_SIDEBAR_TEST_URL||`http://127.0.0.1:${server.address().port}/`;
    await page.navigate(url);await page.waitFor('document.querySelector("#status-left").textContent.includes("개의 문서")');
    const result=await page.evaluate(`(async()=>{
      const {readLocalHTML,findLocalDuplicates,identifyLocalFile,localFileIdentity}=await import('./src/local-files.js');
      const raw=new File(['<html><head><title>식별 속도 검증</title></head><body><!--','x'.repeat(32*1024*1024),'--></body></html>'],'speed.html',{type:'text/html',lastModified:1234});
      const slice=raw.slice.bind(raw);let bytes=0,reads=0,active=0,peak=0;
      raw.text=raw.arrayBuffer=()=>{throw Error('Whole file read');};
      raw.slice=(start,end)=>{const part=slice(start,end),read=part.arrayBuffer.bind(part);part.arrayBuffer=async()=>{bytes+=part.size;reads++;peak=Math.max(peak,++active);try{return await read();}finally{active--;}};return part;};
      const local=await readLocalHTML(raw,{native:true,allowScripts:true,identify:false}),headerBytes=bytes;
      await findLocalDuplicates(local,[{id:'wrong-size',sourceIdentity:{version:1,size:raw.size+1,digest:'a'.repeat(64)}}],()=>{throw Error('Unexpected body read');});
      const preflightBytes=bytes,start=performance.now(),identity=await identifyLocalFile(local),parallelMs=performance.now()-start,scanBytes=bytes-headerBytes;
      const before=reads;await Promise.all([identifyLocalFile(local),localFileIdentity(raw)]);const cachedReads=reads-before;
      const serialStart=performance.now(),hashes=[];
      for(let start=0;start<raw.size;start+=1024*1024)hashes.push(new Uint8Array(await crypto.subtle.digest('SHA-256',await slice(start,start+1024*1024).arrayBuffer())));
      const prefix=new TextEncoder().encode('HTMLMemo local file v1:'+raw.size+':'),joined=new Uint8Array(prefix.length+hashes.length*32);joined.set(prefix);hashes.forEach((hash,index)=>joined.set(hash,prefix.length+index*32));
      const serialDigest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',joined))].map(byte=>byte.toString(16).padStart(2,'0')).join(''),serialMs=performance.now()-serialStart;
      const copied=await readLocalHTML(new File([raw],'renamed.html'),{native:true,identify:false});
      const matches=await findLocalDuplicates(copied,[{id:'original',sourceIdentity:identity}],()=>{throw Error('Unexpected body read');});
      const changed=new File([slice(0,16*1024*1024),'y',slice(16*1024*1024+1)],raw.name,{lastModified:1234}),different=await readLocalHTML(changed,{native:true,identify:false});
      const wrong=await findLocalDuplicates(different,[{id:'original',sourceIdentity:identity}],()=>{throw Error('Unexpected body read');});
      return {size:raw.size,headerBytes,preflightBytes,scanBytes,cachedReads,peak,compatible:identity.digest===serialDigest,matches:matches.map(r=>r.id),wrong:wrong.length,parallelMs,serialMs};
    })()`);
    assert.equal(result.headerBytes,65536);assert.equal(result.preflightBytes,65536);assert.equal(result.scanBytes,result.size);assert.equal(result.cachedReads,0);assert.equal(result.peak,4);assert.equal(result.compatible,true);assert.deepEqual(result.matches,['original']);assert.equal(result.wrong,0);
    await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/duplicate-import-performance.json'),JSON.stringify(result,null,2));
    console.log('Duplicate import 32 MiB exact-identity benchmark:',JSON.stringify(result));assert.deepEqual(chrome.errors,[]);
  }finally{await chrome?.close();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});
test('real Chrome: duplicate HTML import clears embedded notes and upgrades legacy streamed books',{timeout:90000},async()=>{
  await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'htmlmemo-duplicate-large-'));await cp(join(root,'public'),folder,{recursive:true});const server=createServer(folder);let chrome;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));chrome=await launchChrome();const page=chrome.page,url=process.env.HTMLMEMO_SIDEBAR_TEST_URL||`http://127.0.0.1:${server.address().port}/`;
    await page.navigate(url);await page.waitFor('document.querySelector("#status-left").textContent.includes("개의 문서")');
    await page.evaluate(`(()=>{const metadata={version:${FORMAT_VERSION},title:'큰 책의 새 주석',annotations:[{id:'large-old',type:'note',text:'기존 큰 책 주석',color:'#334155',width:3,opacity:1,points:[{x:20,y:70}]}],bookmarks:[{id:'large-mark',title:'기존 북마크',top:0,left:0}]};const source=new Blob(['<html><head><title>큰 책의 새 주석</title><script type="application/json" id="htmlmemo-data">'+JSON.stringify(metadata)+'<'+'/script></head><body><p>원본 본문을 유지합니다.</p><!--'+'x'.repeat(4*1024*1024)+'--></body></html>']);window.importLargeFixture=()=>{const file=new File([source],'large-duplicate.html',{type:'text/html'});file.text=file.arrayBuffer=()=>{throw Error('Whole source read is forbidden');};const t=new DataTransfer();t.items.add(file);const input=document.querySelector('#file-input');input.files=t.files;input.dispatchEvent(new Event('change',{bubbles:true}));};window.importLargeFixture();})()`);
    const ready='document.querySelector(".document-host:not([hidden]) iframe")?.style.visibility==="visible"&&!document.querySelector(".tab-dirty:not([hidden])")',dialog='document.querySelector("#dialog").open&&document.querySelector("[data-duplicate-import]")';await page.waitFor(ready,30000);
    const original=await page.evaluate(`(async()=>{const {listDocuments}=await import('./src/storage.js');return (await listDocuments())[0];})()`);assert.equal(original.metadata.annotations.length,1);
    assert.equal(original.sourceIdentity.version,1);
    // Simulate an existing pre-identity library without rewriting its body.
    await page.evaluate(`new Promise((resolve,reject)=>{const r=indexedDB.open('HTMLMemo-v1',3);r.onsuccess=()=>{const db=r.result,tx=db.transaction('documents','readwrite'),store=tx.objectStore('documents'),get=store.get(${JSON.stringify(original.id)});get.onsuccess=()=>{const row=get.result;delete row.sourceIdentity;store.put(row);};tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);};})`);
    await page.evaluate('window.importLargeFixture()');await page.waitFor(dialog);
    const upgraded=await page.evaluate(`(async()=>{const {listDocuments,listRevisions,putDocumentRevision}=await import('./src/storage.js');const row=(await listDocuments())[0],before=(await listRevisions(row.id)).length,stale=structuredClone(row);delete stale.sourceIdentity;await putDocumentRevision(stale);return {row:(await listDocuments())[0],before,after:(await listRevisions(row.id)).length};})()`);
    assert.deepEqual(upgraded.row.sourceIdentity,original.sourceIdentity);assert.deepEqual(upgraded.row.metadata.annotations,original.metadata.annotations);assert.deepEqual(upgraded.row.metadata.bookmarks,original.metadata.bookmarks);assert.equal(upgraded.row.modified,original.modified);assert.equal(upgraded.before,upgraded.after);
    await page.click('[data-duplicate-import] [value=cancel]');await page.waitFor('!document.querySelector("#dialog").open');
    await page.evaluate('window.importLargeFixture()');await page.waitFor(dialog);await page.click('[data-duplicate-import] [value=new]');await page.waitFor('document.querySelectorAll(".tab.document").length===2&&'+ready,30000);
    const states=await page.evaluate(`(async()=>{const {listDocuments}=await import('./src/storage.js');return (await listDocuments()).map(r=>({id:r.id,annotations:r.metadata.annotations.length,bookmarks:r.metadata.bookmarks.length}));})()`);
    assert.deepEqual(states.find(r=>r.id===original.id),{id:original.id,annotations:1,bookmarks:1});const fresh=states.find(r=>r.id!==original.id);assert.equal(fresh.annotations,0);assert.equal(fresh.bookmarks,0);
    await page.click('.tab.document.active .tab-close');await page.waitFor('document.querySelectorAll(".tab.document").length===1');await page.click('#library-tab');await page.click(`[data-open="${fresh.id}"]`);await page.waitFor(ready,30000);
    assert.equal(await page.evaluate(`document.querySelector('.document-host:not([hidden]) iframe').contentDocument.querySelectorAll('[data-htmlmemo-id="large-old"]').length`),0);assert.deepEqual(chrome.errors,[]);
  }finally{await chrome?.close();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});
test('real Chrome: reading controls provide one app TTS, wait for Play and keep upper zoom usable',{timeout:90000},async()=>{
  await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'htmlmemo-reading-controls-'));await cp(join(root,'public'),folder,{recursive:true});
  const server=createServer(folder);let chrome;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));chrome=await launchChrome();const page=chrome.page;
    const url=process.env.HTMLMEMO_SIDEBAR_TEST_URL||`http://127.0.0.1:${server.address().port}/`;
    await page.navigate(url);await page.waitFor('document.querySelector("#status-left").textContent.includes("개의 문서")');
    const html='<html><head><title>상단 읽기 도구</title><style>html,body{height:100%;margin:0}body{display:flex;flex-direction:column;font:18px/1.6 system-ui}.topbar{display:flex;align-items:center;justify-content:space-between;flex:none;height:44px;padding:0 8px;background:#e2e8f0;color:#1e293b}.controls{display:flex;align-items:center;gap:4px}main{flex:1;overflow:auto;padding:24px}p{max-width:700px}button{font:inherit}</style></head><body><header class="topbar"><strong>책 읽기</strong><div class="controls"><button id="book-font" onclick="window.bookFontClicks=(window.bookFontClicks||0)+1">A−</button><button>A+</button></div></header><main><h1>상단 읽기 도구</h1><p>이 HTML에는 TTS가 없습니다. 음성 읽기와 확대 비율은 HTMLMemo의 상단 버튼으로 조작합니다.</p></main></body></html>';
    await page.evaluate(`(async()=>{const {putDocumentRevision}=await import('./src/storage.js'),{parseHTML}=await import('./src/document.js');for(const [id,source] of [['reading-native',${JSON.stringify(html)}],['reading-plain','<html><head><title>일반 HTML</title></head><body><main><p>자체 상단바 없는 문서에서도 읽기 도구를 사용합니다.</p></main></body></html>']]){const parsed=parseHTML(source,{}, {allowScripts:true});await putDocumentRevision({id,title:parsed.metadata.title,name:id+'.html',created:Date.now(),modified:Date.now(),html:parsed.html,metadata:parsed.metadata});}})()`);
    await page.navigate(url);await page.waitFor('document.querySelector("[data-open=reading-native]")');await page.click('[data-open=reading-native]');
    const frame='document.querySelector(".document-host:not([hidden]) iframe")',doc=frame+'.contentDocument';
    const nativeZoom=doc+'.querySelector("[data-htmlmemo-reading-controls] [data-action=zoom]")';
    const upperTTS=doc+'.querySelector("[data-htmlmemo-reading-controls] [data-action=speak]")';
    const playerReady='document.querySelector(".mstts-player > button")?.textContent==="▶"';
    await page.waitFor(`${frame}?.style.visibility==='visible'&&${nativeZoom}`);
    await page.evaluate(`(()=>{window.__ttsUtterances=[];window.SpeechSynthesisUtterance=class{constructor(text){this.text=text;this.rate=1;this.pitch=1;this.volume=1;this.voice=null;}};const engine=new EventTarget();engine.getVoices=()=>[];engine.cancel=()=>{};engine.speak=u=>window.__ttsUtterances.push(u);Object.defineProperty(window,'speechSynthesis',{configurable:true,value:engine});})()`);
    const point=expression=>page.evaluate(`(async()=>{await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const el=${expression},r=el.getBoundingClientRect(),f=${frame}.getBoundingClientRect(),s=f.width/${frame}.offsetWidth;return {x:f.left+(r.left+r.width/2)*s,y:f.top+(r.top+r.height/2)*s};})()`);
    const clickNative=async expression=>{const p=await point(expression);await page.send('Input.dispatchMouseEvent',{type:'mousePressed',...p,button:'left',clickCount:1});await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',...p,button:'left',clickCount:1});};
    const contained=()=>page.evaluate(`(()=>{const r=document.querySelector('#tool-popover').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;})()`);
    await mkdir(join(root,'test-results'),{recursive:true});
    for(const width of [1280,390]){
      await page.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<600});
      assert.equal(await page.evaluate('!!document.querySelector("#toolbar [data-action=speak],#toolbar [data-action=zoom]")'),false);
      assert.equal(await page.evaluate(`${doc}.querySelectorAll('[data-action=speak]').length`),1);
      assert.equal(await page.evaluate(`${nativeZoom}.closest('[data-htmlmemo-doc-topbar]')!==null`),true);
      assert.equal(await page.evaluate(`(()=>{const b=${upperTTS},font=${doc}.querySelector('#book-font'),r=b.getBoundingClientRect(),f=font.getBoundingClientRect();return !!b.querySelector('svg')&&b.textContent===''&&font.previousElementSibling.contains(b)&&r.right<=f.left&&Math.abs(r.top+r.height/2-f.top-f.height/2)<2;})()`),true,'speaker icon sits immediately left of A− in the same row');
      const fontClicks=await page.evaluate(`${doc}.defaultView.bookFontClicks||0`);await clickNative(doc+'.querySelector("#book-font")');assert.equal(await page.evaluate(`${doc}.defaultView.bookFontClicks`),fontClicks+1);
      const before=await page.evaluate('window.__ttsUtterances.length');await clickNative(upperTTS);await page.waitFor(playerReady);
      assert.equal(await page.evaluate('window.__ttsUtterances.length'),before,'opening the toolbar never starts speech');
      assert.equal(await page.evaluate(`${frame}.contentWindow.CSS.highlights.has('mstts')`),false);
      assert.equal(await page.evaluate(`(()=>{const r=document.querySelector('.mstts-player').getBoundingClientRect();return r.height===20&&r.width<185&&r.left>=0&&r.right<=innerWidth;})()`),true,'ready toolbar is 20px tall and under 185px wide');
      await writeFile(join(root,`test-results/reading-controls-tts-ready-${width}.png`),await page.screenshot());
      await page.click('.mstts-player [aria-label="소리내어 읽기"]');await page.waitFor(`window.__ttsUtterances.length===${before+1}`);
      assert.equal(await page.evaluate(`document.querySelector('.mstts-player').getBoundingClientRect().height`),20,'sentence counter does not increase toolbar height');
      await page.click('.mstts-player [aria-label="일시정지"]');await page.click('.mstts-player [aria-label="플레이어 닫기"]');
      await page.evaluate(`${upperTTS}.focus()`);assert.equal(await page.evaluate(`document.activeElement===${frame}&&${doc}.activeElement===${upperTTS}`),true);
      await page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r',unmodifiedText:'\r'});await page.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
      await page.waitFor(playerReady);assert.equal(await page.evaluate('window.__ttsUtterances.length'),before+1,'keyboard reopen after pausing does not resume speech');
      await page.click('.mstts-player [aria-label="플레이어 닫기"]');
      await clickNative(nativeZoom);await page.waitFor('!document.querySelector("#tool-popover").hidden&&document.querySelector("#zoom-value")');assert.equal(await contained(),true);
      const button=await point(nativeZoom),pop=await page.evaluate(`(()=>{const r=document.querySelector('#tool-popover').getBoundingClientRect();return {top:r.top,bottom:r.bottom};})()`);assert.ok(Math.abs(pop.top-button.y)<35,'zoom opens below the upper button, not by the floating toolbar');
      await writeFile(join(root,`test-results/reading-controls-native-${width}.png`),await page.screenshot());
      await page.evaluate(`(()=>{const input=document.querySelector('#zoom-value');input.value='125';input.dispatchEvent(new Event('change',{bubbles:true}));})()`);await page.waitFor(`${nativeZoom}.textContent==='125%'&&${frame}.style.transform==='scale(1.25)'`);
      await page.click('#zoom-out');await page.waitFor(`${nativeZoom}.textContent==='104%'`);
      await page.click('#zoom-in');await page.waitFor(`${nativeZoom}.textContent==='125%'`);
      await page.click('#zoom-reset');await page.waitFor(`${nativeZoom}.textContent==='100%'&&document.querySelector('#tool-popover').hidden`);
      await clickNative(nativeZoom);await page.waitFor('!document.querySelector("#tool-popover").hidden');await page.click('#zoom-fit');await page.waitFor(`document.querySelector('#tool-popover').hidden`);
      const fitted=await page.evaluate(`Math.round(document.querySelector('.document-host:not([hidden]) .reader-viewport').clientWidth/${frame}.offsetWidth*100)+'%'`);assert.equal(await page.evaluate(`${nativeZoom}.textContent`),fitted);
      await page.evaluate(`${doc}.body.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,button:0,cancelable:true}))`);await page.waitFor('document.querySelector("#app").classList.contains("reader-focus")');
      await clickNative(nativeZoom);await page.waitFor('!document.querySelector("#tool-popover").hidden');assert.equal(await contained(),true);await page.click('[data-popover-close]');
      await page.evaluate(`${doc}.body.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,button:0,cancelable:true}))`);await page.waitFor('!document.querySelector("#app").classList.contains("reader-focus")&&!document.fullscreenElement');
    }
    await page.evaluate(`window.showSaveFilePicker=async()=>{const root=await navigator.storage.getDirectory();return root.getFileHandle('reading-controls-export.html',{create:true});}`);await page.click('#save-page');
    await page.waitFor(`(async()=>{try{const root=await navigator.storage.getDirectory();return (await(await root.getFileHandle('reading-controls-export.html')).getFile()).size>0;}catch{return false;}})()`);
    const exported=await page.evaluate(`(async()=>{const root=await navigator.storage.getDirectory();return (await(await root.getFileHandle('reading-controls-export.html')).getFile()).text();})()`);assert.doesNotMatch(exported,/htmlmemo-reading-controls|data-action="(?:zoom|speak)"/);assert.match(exported,/bookFontClicks/);
    await page.click('#library-tab');await page.waitFor('document.querySelector("[data-open=reading-plain]")');await page.click('[data-open=reading-plain]');await page.waitFor('document.querySelector(".document-host:not([hidden]) > [data-htmlmemo-reading-controls] [data-action=zoom]")');
    const upper='.document-host:not([hidden]) > [data-htmlmemo-reading-controls]';
    assert.equal(await page.evaluate(`document.querySelectorAll('${upper} [data-action=speak]').length`),1);
    assert.equal(await page.evaluate(`!!document.querySelector('${upper} [data-action=speak] svg')`),true);
    await page.click(upper+' [data-action=zoom]');await page.waitFor('!document.querySelector("#tool-popover").hidden');assert.equal(await contained(),true);await writeFile(join(root,'test-results/reading-controls-plain-390.png'),await page.screenshot());await page.click(upper+' [data-action=zoom]');await page.waitFor('document.querySelector("#tool-popover").hidden');
    const before=await page.evaluate('window.__ttsUtterances.length');await page.click(upper+' [data-action=speak]');await page.waitFor('document.querySelector("[data-memo-readaloud]")');assert.equal(await page.evaluate('window.__ttsUtterances.length'),before);await page.click('.mstts-player [aria-label="소리내어 읽기"]');await page.waitFor(`window.__ttsUtterances.length===${before+1}`);await page.click('.mstts-player [aria-label="플레이어 닫기"]');
    assert.deepEqual(chrome.errors,[]);
  }finally{await chrome?.close();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});
test('real Chrome: TTS selection shares the main player and settings while keeping speech inside the selected range',{timeout:180000},async()=>{
  await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'htmlmemo-tts-selection-'));await cp(join(root,'public'),folder,{recursive:true});
  const server=createServer(folder);let chrome;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));chrome=await launchChrome();const page=chrome.page,url=process.env.HTMLMEMO_SIDEBAR_TEST_URL||`http://127.0.0.1:${server.address().port}/`;
    await page.navigate(url);await page.waitFor('document.querySelector("#status-left").textContent.includes("개의 문서")');
    // Real DOM ranges and native UI input; only outgoing audio is replaced for exact assertions.
    await page.evaluate(`(()=>{window.selectionUtterances=[];window.SpeechSynthesisUtterance=class{constructor(text){this.text=text;this.rate=1;}};const engine=new EventTarget();engine.getVoices=()=>[{voiceURI:'english-a',lang:'en-US',name:'Google English A'},{voiceURI:'english-b',lang:'en-US',name:'Google English B'},{voiceURI:'korean',lang:'ko-KR',name:'Google Korean'}];engine.cancel=()=>{};engine.speak=u=>{window.selectionUtterances.push(u);u.onstart?.();};Object.defineProperty(window,'speechSynthesis',{configurable:true,value:engine});})()`);
    const frame='document.querySelector(".document-host:not([hidden]) iframe")',doc=frame+'.contentDocument',ready=`${frame}?.style.visibility==='visible'&&!document.querySelector('.tab-dirty:not([hidden])')`;
    const play=()=>page.click('.mstts-player [aria-label="소리내어 읽기"]'),pause=()=>page.click('.mstts-player [aria-label="일시정지"]'),count=()=>page.evaluate('window.selectionUtterances.length'),last=()=>page.evaluate('(()=>{const u=window.selectionUtterances.at(-1);return {text:u?.text,rate:u?.rate,voice:u?.voice?.voiceURI};})()');
    const activate=async(selector,input)=>{
      if(input==='touch'){const p=await page.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);await page.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...p,id:1}]});await page.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}
      else if(input==='keyboard'){await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);await page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r',unmodifiedText:'\r'});await page.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});}
      else await page.click(selector);
    };
    const mainOpen=async()=>{
      const selector='.document-host:not([hidden]) > [data-htmlmemo-reading-controls] [data-action=speak]';
      if(await page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`))await page.click(selector);
      else {const p=await page.evaluate(`(()=>{const f=${frame},r=f.contentDocument.querySelector('[data-htmlmemo-reading-controls] [data-action=speak]').getBoundingClientRect(),b=f.getBoundingClientRect(),s=b.width/f.offsetWidth;return{x:b.left+(r.left+r.width/2)*s,y:b.top+(r.top+r.height/2)*s};})()`);await page.send('Input.dispatchMouseEvent',{type:'mousePressed',...p,button:'left',clickCount:1});await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',...p,button:'left',clickCount:1});}
      await page.waitFor('document.querySelector(".mstts-player")?.dataset.ttsScope==="document"&&document.querySelector(".mstts-player > button")?.textContent==="▶"');
    };
    const choose=async(label,text)=>{
      await page.click(`.mstts-select-trigger[aria-label="${label}"]`);const at=await page.evaluate(`[...document.querySelectorAll('[role=listbox][aria-label="${label}"] [role=option]')].findIndex(b=>b.textContent.replace('✓','')===${JSON.stringify(text)})`);assert.ok(at>=0,text);await page.click(`[role=listbox][aria-label="${label}"] [role=option]:nth-child(${at+1})`);
    };
    const select=async()=>{
      if(await page.evaluate('!document.querySelector("#sidebar").hidden'))await page.click('#close-sidebar');
      await page.evaluate(`(()=>{const d=${doc},a=d.querySelector('#tts-start').firstChild,b=d.querySelector('#tts-end').firstChild,r=d.createRange();r.setStart(a,a.data.indexOf('Alpha'));r.setEnd(b,b.data.indexOf(' Extra'));const s=d.getSelection();s.removeAllRanges();s.addRange(r);d.dispatchEvent(new d.defaultView.PointerEvent('pointerup',{bubbles:true,pointerId:1,button:0}));})()`);
      await page.waitFor('!document.querySelector("#tool-popover").hidden&&document.querySelector("#tool-popover [data-selection=speak]")');
    };
    const expected=text=>({text,rate:1.5,voice:'english-b'}),prose='<h1>Selection TTS test</h1><p id="outside-before">Outside before. Alpha selected sentence.</p><p id="selected-first">Prefix <em id="tts-start">start Alpha selected sentence.</em></p><p id="selected-last"><strong id="tts-end">Beta selected sentence. Extra outside.</strong></p><p id="outside-after">Outside after must remain silent.</p>',metrics={cases:[],bookChapterGuard:false};
    for(const mode of ['body','book']){
      await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});await page.send('Emulation.setTouchEmulationEnabled',{enabled:false,maxTouchPoints:1});
      const css='html,body{margin:0;font:18px/1.8 system-ui}main{padding:360px 24px 500px}p{margin:24px 0;max-width:650px}';
      const html=mode==='book'?editionHTML('TTS selection book',[{key:'v0:one',id:'one',title:'Selection TTS test',markdown:'# Selection TTS test\nAlpha selected sentence.\nBeta selected sentence.',html:prose},{key:'v0:two',id:'two',title:'Other chapter',markdown:'# Other chapter\nAlpha selected sentence.',html:'<h1>Other chapter</h1><p>Alpha selected sentence.</p>'}],[]).replace('<nav id="reader-nav">','<div class="layout"><nav id="reader-nav">').replace('</main>','</main></div>').replace('</style>',css+'html,body{height:100%;overflow:hidden}.layout{height:100%;display:grid;grid-template-columns:180px minmax(0,1fr)}nav,main{overflow:auto}</style>').replace('"autoFit":false','"autoFit":true'):`<!doctype html><html lang="en"><head><title>TTS selection body</title><style>${css}</style></head><body><main>${prose}</main></body></html>`;
      await page.evaluate(`(()=>{const t=new DataTransfer();t.items.add(new File([${JSON.stringify(html)}],${JSON.stringify('tts-selection-'+mode+'.html')},{type:'text/html'}));const input=document.querySelector('#file-input');input.files=t.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);await page.waitFor(`${ready}&&${doc}.querySelector('#tts-start')`);
      const savedState=`(async()=>{const{listDocuments,getDocument}=await import('./src/storage.js'),row=(await listDocuments()).find(r=>r.name===${JSON.stringify('tts-selection-'+mode+'.html')});if(!row)return null;const r=await getDocument(row.id);return {html:r.file?await r.file.text():r.html,annotations:r.metadata.annotations,bookmarks:r.metadata.bookmarks};})()`;await page.waitFor(savedState);const stored=await page.evaluate(savedState);
      await mainOpen();await page.click('.mstts-player [aria-label="낭독 설정"]');await choose('언어','English');await choose('음성','Google English B');
      for(let i=0;i<5&&await page.evaluate(`document.querySelector(${JSON.stringify('.mstts-player [aria-label="읽는 속도"]')}).textContent!=='1.5×'`);i++)await page.click('.mstts-player [aria-label="읽는 속도"]');
      for(const width of [1280,390,320]){
        await page.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<600});await page.send('Emulation.setTouchEmulationEnabled',{enabled:width===390,maxTouchPoints:1});
        await page.evaluate('window.sharedSelectionBar=document.querySelector(".mstts-player")');await select();const before=await count();await activate('#tool-popover [data-selection=speak]',width===390?'touch':width===320?'keyboard':'mouse');await page.waitFor('document.querySelector(".mstts-player[data-tts-scope=selection]")');
        assert.equal(await count(),before);assert.equal(await page.evaluate('document.querySelector(".mstts-player")===window.sharedSelectionBar&&document.querySelectorAll(".mstts-player").length===1'),true);await play();assert.deepEqual(await last(),expected('Alpha selected sentence.'));
        assert.equal(await page.evaluate(`(()=>{const d=${doc},r=[...${frame}.contentWindow.CSS.highlights.get('mstts')][0];return r.startContainer===d.querySelector('#tts-start').firstChild&&r.startOffset===6&&r.endContainer===d.querySelector('#tts-start').firstChild;})()`),true);
        await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,`test-results/tts-selection-${mode}-${width}.png`),await page.screenshot());
        await pause();const paused=await count();await page.evaluate(`(()=>{const d=${doc},r=d.createRange();r.selectNodeContents(d.querySelector('#outside-after'));const s=d.getSelection();s.removeAllRanges();s.addRange(r);d.dispatchEvent(new Event('selectionchange'));d.querySelector('main').scrollTop=500;d.defaultView.scrollTo(0,500);})()`);assert.equal(await count(),paused);await play();assert.deepEqual(await last(),expected('Alpha selected sentence.'));
        await page.click('.mstts-player [aria-label="다음 문장"]');assert.deepEqual(await last(),expected('Beta selected sentence.'));await page.click('.mstts-player [aria-label="이전 문장"]');assert.deepEqual(await last(),expected('Alpha selected sentence.'));await page.click('.mstts-player [aria-label="다음 문장"]');assert.deepEqual(await last(),expected('Beta selected sentence.'));
        const ended=await count();await page.evaluate('window.selectionUtterances.at(-1).onend()');await page.waitFor('document.querySelector(".mstts-player > button").textContent==="▶"');assert.equal(await count(),ended);
        await play();assert.deepEqual(await last(),expected('Alpha selected sentence.'));await page.evaluate('window.selectionUtterances.at(-1).onerror({error:"audio-busy"})');await page.waitFor('document.querySelector(".mstts-player > button").textContent==="▶"');await play();assert.deepEqual(await last(),expected('Alpha selected sentence.'));
        await page.click('.mstts-player [aria-label="정지"]');await play();assert.deepEqual(await last(),expected('Alpha selected sentence.'));
        const utterances=await page.evaluate(`window.selectionUtterances.slice(${before}).map(u=>({text:u.text,rate:u.rate,voice:u.voice?.voiceURI}))`);assert.equal(utterances.every(u=>['Alpha selected sentence.','Beta selected sentence.'].includes(u.text)&&u.rate===1.5&&u.voice==='english-b'),true);
        await page.click('.mstts-player [aria-label="플레이어 닫기"]');await page.evaluate(`(()=>{const d=${doc};d.getSelection().removeAllRanges();d.querySelector('main').scrollTop=0;d.defaultView.scrollTo(0,0);document.querySelector('.document-host:not([hidden]) .reader-viewport').scrollTop=0;})()`);await mainOpen();await play();const normal=await last();assert.equal(normal.text,'Selection TTS test');assert.equal(normal.rate,1.5);assert.equal(normal.voice,'english-b');
        metrics.cases.push({mode,width,input:width===390?'touch':width===320?'keyboard':'mouse',playerReused:true,noAutoplay:true,selectionBoundsPreserved:true,highlightClipped:true,pauseRetainsRange:true,stopRetainsRange:true,errorRetriesSameSentence:true,normalModeRestored:true,utterances});
      }
      assert.deepEqual(await page.evaluate(savedState),stored);
      if(mode==='book'){
        await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});await page.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await select();await activate('#tool-popover [data-selection=speak]','keyboard');await page.waitFor('document.querySelector(".mstts-player")?.dataset.ttsScope==="selection"&&document.querySelector(".mstts-player > button")?.textContent==="▶"');await play();await pause();const before=await count();
        await page.evaluate(`${doc}.defaultView.location.hash='v0:two'`);await page.waitFor(`${doc}.querySelector('#reader-content').dataset.section==='v0:two'`);await play();assert.equal(await count(),before);assert.equal(await page.evaluate('document.querySelector(".mstts-player > button").textContent'),'▶');metrics.bookChapterGuard=true;
      }
      await page.click('.mstts-player [aria-label="플레이어 닫기"]');
    }
    await writeFile(join(root,'test-results/tts-selection-results.json'),JSON.stringify(metrics,null,2));assert.deepEqual(chrome.errors,[]);
  }catch(error){
    if(chrome)try{await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/tts-selection-failure.png'),await chrome.page.screenshot());await writeFile(join(root,'test-results/tts-selection-failure.json'),JSON.stringify(await chrome.page.evaluate(`({spoken:window.selectionUtterances?.map(u=>({text:u.text,rate:u.rate,voice:u.voice?.voiceURI})),bar:document.querySelector('.mstts-player')?.outerHTML,toast:document.querySelector('#toast')?.textContent})`),null,2));}catch{}
    throw error;
  }finally{await chrome?.close();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});

test('real Chrome: TTS paused resume follows the new reading position without autoplay or stale chapter speech',{timeout:120000},async()=>{
  await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'htmlmemo-tts-resume-'));await cp(join(root,'public'),folder,{recursive:true});
  const server=createServer(folder);let chrome;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));chrome=await launchChrome();const page=chrome.page,url=process.env.HTMLMEMO_SIDEBAR_TEST_URL||`http://127.0.0.1:${server.address().port}/`;
    await page.navigate(url);await page.waitFor('document.querySelector("#status-left").textContent.includes("개의 문서")');
    // The browser's real DOM/events are used; only outgoing audio is replaced so text is deterministic.
    await page.evaluate(`(()=>{window.resumeUtterances=[];window.SpeechSynthesisUtterance=class{constructor(text){this.text=text;this.rate=1;}};const engine=new EventTarget();engine.getVoices=()=>[];engine.cancel=()=>{};engine.speak=u=>{window.resumeUtterances.push(u);u.onstart?.();};Object.defineProperty(window,'speechSynthesis',{configurable:true,value:engine});})()`);
    const frame='document.querySelector(".document-host:not([hidden]) iframe")',doc=frame+'.contentDocument',ready=`${frame}?.style.visibility==='visible'&&!document.querySelector('.tab-dirty:not([hidden])')`;
    const play=()=>page.click('.mstts-player [aria-label="소리내어 읽기"]'),pause=()=>page.click('.mstts-player [aria-label="일시정지"]');
    const count=()=>page.evaluate('window.resumeUtterances.length'),last=()=>page.evaluate('window.resumeUtterances.at(-1)?.text');
    const settle=()=>page.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const nativeClick=async(expression,text=false)=>{
      const p=await page.evaluate(`(()=>{const f=${frame},el=${expression};let r=el.getBoundingClientRect();if(${text}){const range=el.ownerDocument.createRange();range.setStart(el.firstChild,0);range.setEnd(el.firstChild,Math.min(3,el.firstChild.length));r=range.getBoundingClientRect();}const b=f.getBoundingClientRect(),scale=b.width/f.offsetWidth;return {x:b.left+(r.left+Math.min(r.width/2,${text}?5:r.width))*scale,y:b.top+(r.top+r.height/2)*scale};})()`);
      await page.send('Input.dispatchMouseEvent',{type:'mousePressed',...p,button:'left',clickCount:1});await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',...p,button:'left',clickCount:1});
    };
    const open=async()=>{
      const before=await count();
      if(await page.evaluate(`!!${doc}.querySelector('[data-htmlmemo-reading-controls] [data-action=speak]')`))await nativeClick(`${doc}.querySelector('[data-htmlmemo-reading-controls] [data-action=speak]')`);
      else await page.click('.document-host:not([hidden]) > [data-htmlmemo-reading-controls] [data-action=speak]');
      await page.waitFor('document.querySelector(".mstts-player > button")?.textContent==="▶"');assert.equal(await count(),before);
    };
    const select=async id=>{await page.evaluate(`(()=>{const d=${doc},range=d.createRange();range.selectNodeContents(d.getElementById(${JSON.stringify(id)}));const s=d.getSelection();s.removeAllRanges();s.addRange(range);d.dispatchEvent(new Event('selectionchange'));})()`);await settle();};
    const move=async(mode,id)=>{
      await page.evaluate(`(()=>{const f=${frame},d=f.contentDocument,v=document.querySelector('.document-host:not([hidden]) .reader-viewport'),r=d.getElementById(${JSON.stringify(id)}).getBoundingClientRect(),b=f.getBoundingClientRect(),scale=b.width/f.offsetWidth,delta=(b.top+r.top*scale-v.getBoundingClientRect().top-100)/scale;if(${JSON.stringify(mode)}==='inner')d.querySelector('main').scrollTop+=delta;else d.defaultView.scrollBy(0,delta);})()`);await settle();
    };
    const metrics=[];
    for(const mode of ['body','inner']){
      await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
      const prose=Array.from({length:30},(_,i)=>`<p><span class="line" id="s${i}a">첫 문장 ${i}입니다.</span> <span class="line" id="s${i}b">둘째 문장 ${i}입니다.</span></p>`).join('');
      const chapter=Array.from({length:30},(_,i)=>`<p id="chapter-${i}">새 장 문장 ${i}입니다.</p>`).join('');
      const html=`<!doctype html><html lang="ko"><head><title>TTS 이동 ${mode}</title><style>html,body{margin:0;font:18px/1.6 system-ui}nav{height:36px;padding:0 12px;background:#e2e8f0;color:#1e293b;z-index:5}nav button{height:32px}main{padding:80px 24px 600px}p{min-height:100px;margin:0 0 260px}.line{display:block}${mode==='inner'?'html,body{height:100%;overflow:hidden}body{display:flex;flex-direction:column}nav{flex:none}main{flex:1;min-height:0;overflow:auto;padding-top:44px}':'nav{position:fixed;top:0;left:0;right:0}'}</style></head><body><nav><button id="change-chapter" onclick="nextChapter()">다른 장으로 이동</button></nav><main id="prose" data-tts-root>${prose}</main><script>function nextChapter(){const p=document.getElementById('prose');p.innerHTML=${JSON.stringify(chapter)};p.scrollTop=0;window.scrollTo(0,0);}</script></body></html>`;
      await page.evaluate(`(()=>{const t=new DataTransfer();t.items.add(new File([${JSON.stringify(html)}],${JSON.stringify('tts-resume-'+mode+'.html')},{type:'text/html'}));const input=document.querySelector('#file-input');input.files=t.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await page.waitFor(`${ready}&&${doc}.title===${JSON.stringify('TTS 이동 '+mode)}`);
      if(await page.evaluate('!document.querySelector("#sidebar").hidden'))await page.click('#close-sidebar');
      // Import intentionally prepares the saved HTML (CSP, anchors, metadata).
      // Compare that stored baseline before/after TTS, not the unprepared input file.
      const savedState=`(async()=>{const {listDocuments,getDocument}=await import('./src/storage.js'),row=(await listDocuments()).find(r=>r.name===${JSON.stringify('tts-resume-'+mode+'.html')});if(!row)return null;const record=await getDocument(row.id);return {html:record.file?await record.file.text():record.html,annotations:record.metadata.annotations,bookmarks:record.metadata.bookmarks};})()`;
      await page.waitFor(savedState);const storedBefore=await page.evaluate(savedState);assert.deepEqual(storedBefore.annotations,[]);assert.deepEqual(storedBefore.bookmarks,[]);
      for(const width of [1280,390,320]){
        await page.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<600});await settle();await open();
        await play();const initial=await last();await pause();const paused=await count();
        await page.evaluate('window.resumeUtterances.at(-1).onend();window.resumeUtterances.at(-1).onerror()');assert.equal(await count(),paused);await play();assert.equal(await last(),initial);
        await pause();await move(mode,'s5a');assert.equal(await count(),paused+1);await play();assert.equal(await last(),'첫 문장 5입니다.');
        await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,`test-results/tts-resume-${mode}-${width}.png`),await page.screenshot());
        await pause();const beforeClick=await count();await page.evaluate(`${doc}.getSelection().removeAllRanges()`);await nativeClick(`${doc}.getElementById('s5b')`,true);await settle();
        assert.equal(await count(),beforeClick);assert.equal(await page.evaluate('document.querySelector(".mstts-player > button").textContent'),'▶');await play();assert.equal(await last(),'둘째 문장 5입니다.');
        await pause();await select('s5a');const beforeSelection=await count();await play();assert.equal(await count(),beforeSelection+1);assert.equal(await last(),'첫 문장 5입니다.');
        await pause();await select('s5b');await move(mode,'s8a');await play();assert.equal(await last(),'첫 문장 8입니다.');
        await pause();await move(mode,'s2a');await play();assert.equal(await last(),'첫 문장 2입니다.');
        metrics.push({mode,width,unchanged:initial,afterScroll:'첫 문장 5입니다.',afterClick:'둘째 문장 5입니다.',afterSelection:'첫 문장 5입니다.',afterStaleSelection:'첫 문장 8입니다.',afterScrollUp:await last()});
        await page.click('.mstts-player [aria-label="플레이어 닫기"]');
      }
      await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});await settle();await open();await play();await pause();
      const beforeChapter=await count();await nativeClick(`${doc}.querySelector('#change-chapter')`);await page.waitFor(`${doc}.querySelector('#chapter-0')`);await settle();assert.equal(await count(),beforeChapter);
      await play();assert.match(await last(),/^새 장 문장 /);const newChapter=await last(),afterChapter=await count();await page.evaluate('window.resumeUtterances[window.resumeUtterances.length-2].onend()');assert.equal(await count(),afterChapter);
      await pause();await page.evaluate(`${doc}.querySelector('main').replaceChildren()`);await settle();await play();assert.equal(await count(),afterChapter);assert.equal(await page.evaluate('document.querySelector(".mstts-player > button").textContent'),'▶');
      await page.click('.mstts-player [aria-label="플레이어 닫기"]');
      assert.deepEqual(await page.evaluate(savedState),storedBefore);metrics.push({mode,newChapter,sourcePreserved:true,emptyChapterSilent:true});
    }
    await writeFile(join(root,'test-results/tts-resume-results.json'),JSON.stringify(metrics,null,2));assert.deepEqual(chrome.errors,[]);
  }catch(error){
    if(chrome)try{await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/tts-resume-failure.png'),await chrome.page.screenshot());await writeFile(join(root,'test-results/tts-resume-failure.json'),JSON.stringify(await chrome.page.evaluate(`({spoken:window.resumeUtterances?.map(u=>u.text),status:document.querySelector('#status-left')?.textContent,button:document.querySelector('.mstts-player > button')?.outerHTML})`),null,2));}catch{}
    throw error;
  }finally{await chrome?.close();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});

test('real Chrome: TTS transport controls remain responsive to rapid pointer, keyboard and touch commands',{timeout:90000},async()=>{
  await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'htmlmemo-tts-controls-'));await cp(join(root,'public'),folder,{recursive:true});
  const server=createServer(folder);let chrome;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));chrome=await launchChrome();const page=chrome.page,url=process.env.HTMLMEMO_SIDEBAR_TEST_URL||`http://127.0.0.1:${server.address().port}/`;
    await page.navigate(url);await page.waitFor('document.querySelector("#status-left").textContent.includes("개의 문서")');
    // Real browser input/DOM, deterministic audio lifecycle including synchronous cancel errors.
    await page.evaluate(`(()=>{window.transportUtterances=[];window.SpeechSynthesisUtterance=class{constructor(text){this.text=text;}};const engine=window.transportEngine=new EventTarget();Object.assign(engine,{paused:true,speaking:false,pending:false,resumes:0,active:null,silent:false,fail:false});engine.getVoices=()=>[];engine.cancel=()=>{const old=engine.active;engine.active=null;engine.speaking=engine.pending=false;old?.onerror?.({error:'interrupted'});};engine.resume=()=>{engine.resumes++;engine.paused=false;engine.active?.onresume?.();};engine.speak=u=>{if(engine.fail)throw Error('Audio temporarily unavailable');window.transportUtterances.push(u);engine.active=u;engine.pending=engine.paused;engine.speaking=!engine.paused;if(!engine.silent&&!engine.paused)u.onstart?.();};Object.defineProperty(window,'speechSynthesis',{configurable:true,value:engine});})()`);
    await page.click('#open-example');await page.waitFor('!document.querySelector("#toolbar").hidden&&document.querySelector("#status-left").textContent.includes("자동 저장됨")');
    const button='.mstts-player > button:first-of-type',count=()=>page.evaluate('window.transportUtterances.length'),last=()=>page.evaluate('window.transportUtterances.at(-1).text');
    const state=playing=>page.waitFor(`(()=>{const b=document.querySelector(${JSON.stringify(button)});return b?.getAttribute('aria-label')===${JSON.stringify(playing?'일시정지':'소리내어 읽기')}&&b?.getAttribute('aria-pressed')===${JSON.stringify(String(playing))};})()`);
    const metrics=[];
    for(const width of [1280,390,320]){
      await page.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<600});
      await page.send('Emulation.setTouchEmulationEnabled',{enabled:width<600,maxTouchPoints:1});
      await page.click('.document-host:not([hidden]) > [data-htmlmemo-reading-controls] [data-action=speak]');await state(false);const initial=await count();
      await page.evaluate('window.transportEngine.paused=true');await page.click(button);await state(true);assert.equal(await count(),initial+1);assert.equal(await page.evaluate('window.transportEngine.paused'),false);
      // The same screen position remains clickable as the button changes Play/Pause.
      const point=await page.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(button)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      for(let i=0;i<24;i++){
        await page.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});await state(i%2===1);
      }
      assert.equal(await count(),initial+13);
      await page.evaluate(`document.querySelector(${JSON.stringify(button)}).focus()`);
      for(const[index,key]of [' ','Enter',' ','Enter'].entries()){
        const code=key===' '?'Space':'Enter',windowsVirtualKeyCode=key===' '?32:13;
        await page.evaluate(`window.transportPhase=${JSON.stringify({width,input:'keyboard',index,key})}`);
        await page.send('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode,text:key==='Enter'?'\r':' ',unmodifiedText:key==='Enter'?'\r':' '});await page.send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode});await state(index%2===1);
      }
      if(width<600)for(let i=0;i<8;i++){
        await page.evaluate(`window.transportPhase=${JSON.stringify({width,input:'touch',index:i})}`);
        await page.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...point,id:1}]});await page.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await state(i%2===1);
      }
      const n=await count();await page.evaluate(`(()=>{const all=window.transportUtterances;for(const u of all.slice(0,-1)){u.onend();u.onerror({error:'interrupted'});u.onstart();u.onpause();}})()`);assert.equal(await count(),n);await state(true);
      const beforeEnd=await count();await page.evaluate('window.transportFinished=window.transportUtterances.at(-1);window.transportFinished.onend();window.transportFinished.onend();window.transportFinished.onerror({error:"interrupted"})');assert.equal(await count(),beforeEnd+1);
      const sentence=await last();await page.evaluate('window.transportUtterances.at(-1).onerror({error:"audio-busy"})');await state(false);assert.equal(await count(),beforeEnd+1);
      assert.match(await page.evaluate('document.querySelector("#toast").textContent'),/같은 문장/);await page.click(button);await state(true);assert.equal(await last(),sentence);
      await page.evaluate('window.transportEngine.paused=true;window.transportUtterances.at(-1).onpause()');assert.equal(await page.evaluate('window.transportEngine.paused'),false);await state(true);
      await page.click(button);await state(false);await page.evaluate('window.transportEngine.fail=true');await page.click(button);await state(false);await page.evaluate('window.transportEngine.fail=false');await page.click(button);await state(true);assert.equal(await last(),sentence);
      if(width===1280){
        await page.click(button);await state(false);await page.evaluate('window.transportEngine.silent=true');await page.click(button);await state(true);const stalled=await count();
        await state(false);assert.equal(await count(),stalled);assert.match(await page.evaluate('document.querySelector("#toast").textContent'),/음성 시작 응답/);
        await page.evaluate('window.transportUtterances.at(-1).onstart();window.transportEngine.silent=false');await state(false);await page.click(button);await state(true);assert.equal(await last(),sentence);
      }
      await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,`test-results/tts-controls-${width}.png`),await page.screenshot());
      metrics.push({width,rapidPointerCommands:24,keyboardCommands:4,touchCommands:width<600?8:0,latestCommandWins:true,staleCallbacksIgnored:true,duplicateCompletionIgnored:true,errorRetriesSameSentence:true,nativePauseReleased:true,missingStartDetected:width===1280});
      await page.click('.mstts-player [aria-label="플레이어 닫기"]');assert.equal(await page.evaluate('!!document.querySelector(".mstts-player")'),false);
    }
    await writeFile(join(root,'test-results/tts-controls-results.json'),JSON.stringify(metrics,null,2));assert.deepEqual(chrome.errors,[]);
  }catch(error){
    if(chrome)try{await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/tts-controls-failure.png'),await chrome.page.screenshot());await writeFile(join(root,'test-results/tts-controls-failure.json'),JSON.stringify(await chrome.page.evaluate(`({phase:window.transportPhase,count:window.transportUtterances?.length,spoken:window.transportUtterances?.map(u=>u.text),button:document.querySelector('.mstts-player > button')?.outerHTML,focused:document.activeElement?.outerHTML.slice(0,600),toast:document.querySelector('#toast')?.textContent})`),null,2));}catch{}
    throw error;
  }finally{await chrome?.close();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});

test('real Chrome: palette controls stay above palettes and retain their settings and title-drag position',{timeout:60000},async()=>{
  await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'htmlmemo-palette-order-'));await cp(join(root,'public'),folder,{recursive:true});
  const server=createServer(folder);let chrome;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));chrome=await launchChrome();const page=chrome.page;
    const url=process.env.HTMLMEMO_SIDEBAR_TEST_URL||`http://127.0.0.1:${server.address().port}/`;
    await page.navigate(url);await page.waitFor('document.querySelector("#status-left").textContent.includes("개의 문서")');
    await page.click('#open-example');await page.waitFor('!document.querySelector("#toolbar").hidden&&document.querySelector("#status-left").textContent.includes("자동 저장됨")');
    const layout=()=>page.evaluate(`(()=>{
      const pop=document.querySelector('#tool-popover'),ids=['pen-width','pen-opacity','pen-ttl','palette-preset'],nodes=ids.map(id=>pop.querySelector('#'+id));
      const bounds=pop.getBoundingClientRect(),tops=nodes.map(node=>node.closest('label,.palette-section').getBoundingClientRect().top);
      return {order:[...pop.querySelectorAll('#pen-width,#pen-opacity,#pen-ttl,#palette-preset')].map(node=>node.id),unique:ids.every(id=>pop.querySelectorAll('#'+id).length===1),above:tops.every((top,i)=>i===0||top>tops[i-1]),visible:nodes.slice(0,3).every(node=>{const b=node.getBoundingClientRect();return b.top>=bounds.top&&b.bottom<=bounds.bottom&&b.left>=0&&b.right<=innerWidth;}),contained:bounds.left>=0&&bounds.right<=innerWidth&&bounds.top>=0&&bounds.bottom<=innerHeight};
    })()`);
    const expected={order:['pen-width','pen-opacity','pen-ttl','palette-preset'],unique:true,above:true,visible:true,contained:true};
    const values=()=>page.evaluate(`['#pen-width','#pen-opacity','#pen-ttl','#width-output','#opacity-output'].map(id=>{const n=document.querySelector(id);return n.value||n.textContent;})`);
    await mkdir(join(root,'test-results'),{recursive:true});
    for(const width of [1280,390,320]){
      await page.send('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:width<600});
      if(width===390){
        await clickAppMenu(page,'#settings-button');await page.waitFor('document.querySelector("#appearance")');
        await page.evaluate(`(()=>{const n=document.querySelector('#appearance');n.value='dark';n.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        await page.click('#dialog [data-dialog-close]');assert.equal(await page.evaluate('document.documentElement.dataset.theme'),'dark');
      }
      await page.click('[data-action=palette]');await page.waitFor('!document.querySelector("#tool-popover").hidden&&document.querySelector("#pen-width")');
      assert.deepEqual(await layout(),expected);
      await writeFile(join(root,`test-results/palette-controls-${width}.png`),await page.screenshot());
      if(width===1280){
        await page.evaluate(`(()=>{for(const [id,value,event] of [['pen-width','7','input'],['pen-opacity','55','input'],['pen-ttl','10','change']]){const n=document.getElementById(id);n.value=value;n.dispatchEvent(new Event(event,{bubbles:true}));}})()`);
        assert.deepEqual(await values(),['7','55','10','7px','55%']);
        await page.evaluate(`(()=>{const n=document.querySelector('#palette-preset');n.value='preset-2';n.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        assert.deepEqual(await layout(),expected);assert.deepEqual(await values(),['7','55','10','7px','55%']);
        await page.click('#add-custom-color');assert.deepEqual(await layout(),expected);assert.deepEqual(await values(),['7','55','10','7px','55%']);
      }else assert.deepEqual(await values(),['7','55','10','7px','55%']);
      await page.click('[data-popover-close]');
    }
    await page.navigate(url);await page.waitFor('document.querySelector("[data-open]")');await page.click('[data-open]');
    await page.waitFor('!document.querySelector("#toolbar").hidden');await page.click('[data-action=palette]');
    assert.deepEqual(await layout(),expected);assert.deepEqual(await values(),['7','55','10','7px','55%']);
    assert.equal(await page.evaluate(`document.querySelector('#palette-preset').value`),'preset-2');
    await page.click('[data-popover-close]');await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});await page.click('[data-action=palette]');
    const panel=()=>page.evaluate(`(()=>{const p=document.querySelector('#tool-popover').getBoundingClientRect(),h=document.querySelector('[data-palette-drag]').getBoundingClientRect();return {x:p.left,y:p.top,width:p.width,height:p.height,handle:{x:h.left+24,y:h.top+h.height/2}};})()`);
    const mouseDrag=async end=>{
      const start=(await panel()).handle;
      await page.send('Input.dispatchMouseEvent',{type:'mousePressed',...start,button:'left',buttons:1,clickCount:1});
      for(let n=1;n<=5;n++)await page.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:start.x+(end.x-start.x)*n/5,y:start.y+(end.y-start.y)*n/5,button:'left',buttons:1});
      await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',...end,button:'left',buttons:0,clickCount:1});
      assert.equal(await page.evaluate('document.querySelector("#tool-popover").classList.contains("palette-dragging")'),false);
    };
    await mouseDrag({x:0,y:0});let p=await panel();assert.equal(p.x,10);assert.equal(p.y,8);
    await mouseDrag({x:1279,y:799});p=await panel();assert.equal(p.x,1280-p.width-10);assert.equal(p.y,800-p.height-8);
    await mouseDrag({x:300+p.handle.x-p.x,y:40+p.handle.y-p.y});p=await panel();assert.equal(p.x,300);assert.equal(p.y,40);
    await page.evaluate(`(()=>{const n=document.querySelector('#palette-preset');n.value='preset-3';n.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    p=await panel();assert.equal(p.x,300);assert.equal(p.y,40);assert.deepEqual(await values(),['7','55','10','7px','55%']);
    await page.click('[data-popover-close]');await page.click('[data-action=palette]');p=await panel();assert.equal(p.x,300);assert.equal(p.y,40);
    await page.evaluate('document.querySelector("[data-palette-drag]").focus()');
    await page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39,modifiers:8});await page.send('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
    p=await panel();assert.equal(p.x,340);assert.equal(p.y,40);
    await writeFile(join(root,'test-results/palette-drag-desktop.png'),await page.screenshot());
    await page.click('[data-popover-close]');await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await page.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});await page.click('[data-action=palette]');
    p=await panel();assert.ok(p.x>=10&&p.x+p.width<=380&&p.y>=8&&p.y+p.height<=836);
    const touch=async(type,point)=>page.send('Input.dispatchTouchEvent',{type,touchPoints:point?[{...point,id:1,radiusX:1,radiusY:1,force:1}]:[]});
    await touch('touchStart',p.handle);await touch('touchMove',{x:0,y:0});await touch('touchEnd');p=await panel();assert.equal(p.x,10);assert.equal(p.y,8);
    await touch('touchStart',p.handle);await touch('touchCancel');assert.equal(await page.evaluate('document.querySelector("#tool-popover").classList.contains("palette-dragging")'),false);
    assert.deepEqual(await values(),['7','55','10','7px','55%']);await writeFile(join(root,'test-results/palette-drag-mobile.png'),await page.screenshot());
    await page.click('[data-popover-close]');assert.equal(await page.evaluate('document.querySelector("#tool-popover").hidden'),true);assert.deepEqual(chrome.errors,[]);
  }finally{if(chrome)await chrome.close();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});
test('real Chrome: toolbar mode groups preserve selected text when creating notes from the floating toolbar',{timeout:120000},async()=>{
  await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'htmlmemo-selection-note-'));await cp(join(root,'public'),folder,{recursive:true});
  const server=createServer(folder);let chrome;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));chrome=await launchChrome();const page=chrome.page,url=process.env.HTMLMEMO_SIDEBAR_TEST_URL||`http://127.0.0.1:${server.address().port}/`;
    await page.navigate(url);await page.waitFor('document.querySelector("#status-left").textContent.includes("개의 문서")');
    const quote='A selected text with inline formatting deserves its own note.',prose='<h1>Selected text notes</h1>'+[1280,390,320].map(width=>`<p id="target-${width}" style="min-height:180px">Before ${width}. A <em>selected text</em> with <strong>inline formatting</strong> deserves its own note. After ${width}.</p>`).join('');
    const frame='document.querySelector(".document-host:not([hidden]) iframe")',doc=frame+'.contentDocument',ready=`${frame}?.style.visibility==='visible'&&!document.querySelector('.tab-dirty:not([hidden])')`,metrics=[];
    const selectedTarget=`(()=>{const s=${doc}.getSelection();return s?.rangeCount?s.getRangeAt(0).startContainer.parentElement.closest('p')?.id:'';})()`,selectionAt=width=>`${doc}.getSelection().toString()===${JSON.stringify(quote)}&&${selectedTarget}===${JSON.stringify('target-'+width)}`;
    const select=async(width,mode)=>{
      await page.click('#toolbar [data-action=select]');
      if(await page.evaluate('!document.querySelector("#sidebar").hidden'))await page.click('#close-sidebar');
      const point=await page.evaluate(`(async()=>{const f=${frame},d=f.contentDocument,e=d.querySelector(${JSON.stringify('#target-'+width+' em')});e.scrollIntoView({block:'center'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const range=d.createRange();range.setStart(e.firstChild,0);range.setEnd(e.firstChild,8);const r=range.getClientRects()[0],b=f.getBoundingClientRect(),scale=b.width/f.offsetWidth;return{x:b.left+(r.left+r.width/2)*scale,y:b.top+(r.top+r.height/2)*scale};})()`);
      for(let clickCount=1;clickCount<=3;clickCount++){await page.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount});await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount});}
      await page.waitFor(selectionAt(width));
      await page.waitFor('!document.querySelector("#tool-popover").hidden&&document.querySelector("#tool-popover").classList.contains("selection")');
      assert.deepEqual(await page.evaluate('[...document.querySelectorAll("#tool-popover [data-selection]")].map(b=>[b.dataset.selection,b.textContent])'),[['speak','읽어주기'],['webSearch','웹 검색']]);
      assert.equal(await page.evaluate('(()=>{const r=document.querySelector("#tool-popover").getBoundingClientRect();return r.width<220&&r.left>=8&&r.right<=innerWidth-8&&r.top>=8&&r.bottom<=innerHeight-8;})()'),true);
      await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,`test-results/toolbar-modes-selection-menu-${mode}-${width}.png`),await page.screenshot());
    };
    const open=async width=>{
      const selector='#toolbar [data-action=note]';
      if(width===390){const point=await page.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);await page.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...point,id:1}]});await page.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}
      else if(width===320){await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);await page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r',unmodifiedText:'\r'});await page.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});}
      else await page.click(selector);
      await page.waitFor('document.querySelector("#dialog").open&&document.querySelector("#note-text")');assert.equal(await page.evaluate(`${doc}.getSelection().toString()`),quote);assert.equal(await page.evaluate(selectedTarget),'target-'+width);assert.equal(await page.evaluate(`${doc}.documentElement.hasAttribute('data-htmlmemo-drawing')`),false);
    };
    for(const mode of ['body','book']){
      await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});await page.send('Emulation.setTouchEmulationEnabled',{enabled:false,maxTouchPoints:1});
      const css='html,body{margin:0;font:18px/1.8 system-ui}main{padding:40px}p{max-width:650px}';
      const html=mode==='book'?editionHTML('Selection note book',[{key:'v0:one',id:'one',title:'Selected text notes',markdown:'# Selected text notes\n'+quote,html:prose},{key:'v0:two',id:'two',title:'Another chapter',markdown:'# Another chapter\nOther text.',html:'<h1>Another chapter</h1><p>Other text.</p>'}],[]).replace('<nav id="reader-nav">','<div class="layout"><nav id="reader-nav">').replace('</main>','</main></div>').replace('</style>',css+'html,body{height:100%;overflow:hidden}.layout{height:100%;display:grid;grid-template-columns:200px minmax(0,1fr)}nav,main{overflow:auto}nav{padding:12px}</style>').replace('"autoFit":false','"autoFit":true'):`<!doctype html><html lang="en"><head><title>Selection note body</title><style>${css}</style></head><body><main>${prose}</main></body></html>`;
      await page.evaluate(`(()=>{const files=new DataTransfer();files.items.add(new File([${JSON.stringify(html)}],${JSON.stringify('selection-note-'+mode+'.html')},{type:'text/html'}));const input=document.querySelector('#file-input');input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);await page.waitFor(`${ready}&&${doc}.querySelector('#target-1280 em')`);
      if(await page.evaluate('!document.querySelector("#sidebar").hidden'))await page.click('#close-sidebar');
      const savedState=`(async()=>{const{listDocuments,getDocument}=await import('./src/storage.js'),row=(await listDocuments()).find(r=>r.name===${JSON.stringify('selection-note-'+mode+'.html')});return row?await getDocument(row.id):null;})()`;await page.waitFor(savedState);const original=await page.evaluate(savedState);
      for(const width of [1280,390,320]){
        await page.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<600});await page.send('Emulation.setTouchEmulationEnabled',{enabled:width===390,maxTouchPoints:1});
        const before=(await page.evaluate(savedState)).metadata.annotations.length;await select(width,mode);await open(width);await page.click('#dialog .dialog-actions [value=cancel]');await page.waitFor('!document.querySelector("#dialog").open');await page.waitFor(selectionAt(width));assert.equal((await page.evaluate(savedState)).metadata.annotations.length,before);
        await open(width);await page.click('#note-text');await page.send('Input.insertText',{text:`메모 ${mode} ${width}`});await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,`test-results/toolbar-modes-selection-note-${mode}-${width}-dialog.png`),await page.screenshot());await page.click('#dialog [value=save]');
        await page.waitFor(`!document.querySelector('#dialog').open&&${ready}&&(async()=>{const r=await ${savedState};return r.metadata.annotations.length===${before+1};})()`);await page.waitFor(selectionAt(width));
        const saved=await page.evaluate(savedState),note=saved.metadata.annotations.at(-1);assert.equal(note.type,'note');assert.equal(note.text,`메모 ${mode} ${width}`);assert.equal(note.textAnchor.quote,quote);assert.equal(note.textAnchor.section,mode==='book'?'v0:one':undefined);assert.equal(note.anchorTarget.id,'target-'+width);assert.deepEqual(saved.metadata.bookmarks,original.metadata.bookmarks);
        await writeFile(join(root,`test-results/toolbar-modes-selection-note-${mode}-${width}-saved.png`),await page.screenshot());
        await open(width);await page.click('#dialog .dialog-actions [value=cancel]');await page.waitFor('!document.querySelector("#dialog").open');await page.waitFor(selectionAt(width));
        metrics.push({mode,width,input:width===390?'touch':width===320?'keyboard':'mouse',selectionMenuOnlyReadAndWebSearch:true,selectionMenuFitsItsTwoActions:true,selectionKeptInDialog:true,selectionKeptAfterSaveAndCancel:true,noteReferencesExactInlineText:true,chapterAndParagraphPreserved:true,repeatClickCreatesNoteNotModePicker:true,cancelCreatesNoNote:true});
      }
      const expected=(await page.evaluate(savedState)).metadata.annotations;await page.navigate(url);await page.waitFor(`document.querySelector('[data-open="${original.id}"]')`);await page.click(`[data-open="${original.id}"]`);await page.waitFor(`${ready}&&${doc}.querySelectorAll('[data-htmlmemo-id]').length===3`);assert.deepEqual((await page.evaluate(savedState)).metadata.annotations,expected);
    }
    await writeFile(join(root,'test-results/toolbar-modes-selection-note-results.json'),JSON.stringify(metrics,null,2));assert.deepEqual(chrome.errors,[]);
  }catch(error){
    if(chrome)try{await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/toolbar-modes-selection-note-failure.png'),await chrome.page.screenshot());await writeFile(join(root,'test-results/toolbar-modes-selection-note-failure.json'),JSON.stringify(await chrome.page.evaluate(`(()=>{const s=document.querySelector('.document-host:not([hidden]) iframe')?.contentDocument?.getSelection();return{selected:s?.toString(),paragraph:s?.rangeCount?s.getRangeAt(0).startContainer.parentElement.closest('p')?.id:null,dialog:document.querySelector('#dialog')?.open,toast:document.querySelector('#toast')?.textContent};})()`),null,2));}catch{}
    throw error;
  }finally{await chrome?.close();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});

test('real Chrome: toolbar mode groups remove semantic duplicates and keep area, underline and text annotations usable',{timeout:90000},async()=>{
  await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'htmlmemo-tool-modes-'));await cp(join(root,'public'),folder,{recursive:true});
  const server=createServer(folder);let chrome;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));chrome=await launchChrome();const page=chrome.page;
    const url=process.env.HTMLMEMO_SIDEBAR_TEST_URL||`http://127.0.0.1:${server.address().port}/`;
    await page.navigate(url);await page.waitFor('document.querySelector("#status-left").textContent.includes("개의 문서")');
    await page.evaluate(`(async()=>{const {putDocumentRevision}=await import('./src/storage.js'),{parseHTML}=await import('./src/document.js');const parsed=parseHTML('<html><head><title>도구 방식 검증</title><style>body{margin:0;font:18px/1.6 system-ui}main{padding:60px 40px}#target{max-width:600px;height:200px;padding:24px;background:#f1f5f9}</style></head><body><main><h1>도구 방식 검증</h1><p id="target">같은 도구에서 글자와 영역 방식을 고릅니다. 형광펜과 밑줄, 메모 상자와 자유 텍스트를 그대로 사용할 수 있습니다.</p></main></body></html>');await putDocumentRevision({id:'tool-modes-document',title:parsed.metadata.title,name:'tool-modes.html',created:Date.now(),modified:Date.now(),html:parsed.html,metadata:parsed.metadata});})()`);
    await page.navigate(url);await page.waitFor('document.querySelector("[data-open=tool-modes-document]")');await page.click('[data-open=tool-modes-document]');
    const frame='document.querySelector(".document-host:not([hidden]) iframe")',doc=frame+'.contentDocument';
    await page.waitFor(`${frame}?.style.visibility==='visible'&&document.querySelector('#toolbar [data-action=highlight]')`);
    const saved=()=>page.evaluate(`(async()=>{const {getDocument}=await import('./src/storage.js');return (await getDocument('tool-modes-document')).metadata.annotations;})()`);
    const choose=async(group,variant)=>{
      if(await page.evaluate(`document.querySelector('[data-action=${group}]').getAttribute('aria-pressed')!=='true'`))await page.click(`[data-action=${group}]`);
      await page.click(`[data-action=${group}]`);await page.waitFor(`!!document.querySelector('[data-tool-mode=${variant}]')`);await page.click(`[data-tool-mode=${variant}]`);
      assert.equal(await page.evaluate(`document.querySelector('[data-action=${group}]').getAttribute('aria-pressed')`),'true');
      assert.equal(await page.evaluate('document.querySelector("#tool-popover").hidden'),true);
    };
    await mkdir(join(root,'test-results'),{recursive:true});
    for(const width of [1280,390,320]){
      await page.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<600});
      // The app defaults to an explicit light theme, so a media override alone
      // would silently leave every screenshot light. Exercise the real setting.
      const theme=width<600?'dark':'light';
      await clickAppMenu(page,'#settings-button');await page.waitFor('document.querySelector("#dialog").open&&document.querySelector("#appearance")');
      await page.evaluate(`(()=>{const appearance=document.querySelector('#appearance');appearance.value=${JSON.stringify(theme)};appearance.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await page.click('#dialog [data-dialog-close]');assert.equal(await page.evaluate('document.documentElement.dataset.theme'),theme);
      for(const [group,variant] of [['highlight','area'],['underline','area-underline'],['note','text']])await choose(group,variant);
      await page.click('[data-action=highlight]');await page.click('[data-action=highlight]');
      await page.waitFor('document.querySelectorAll("[data-tool-mode]").length===2');
      assert.deepEqual(await page.evaluate('[...document.querySelectorAll("[data-tool-mode]")].map(b=>b.dataset.toolMode)'),['highlight','area']);
      await writeFile(join(root,`test-results/toolbar-modes-choice-${width}.png`),await page.screenshot());await page.click('[data-popover-close]');
      await page.click('[data-action=more]');assert.deepEqual(await page.evaluate('[...document.querySelectorAll("[data-more]")].map(b=>b.dataset.more)'),['rect','ellipse','arrow','strike','history','migrate','info']);
      assert.equal(await page.evaluate('document.querySelector("[data-more=history] svg").innerHTML===document.querySelector("[data-action=undo] svg").innerHTML'),false);
      await writeFile(join(root,`test-results/toolbar-modes-more-${width}.png`),await page.screenshot());await page.click('[data-popover-close]');
      assert.equal((await saved()).length,0,'choosing modes alone does not create annotations');
    }
    // On a narrow screen the visible sidebar is an overlay. Close it through
    // its real control before drawing on the underlying document.
    await page.click('#close-sidebar');
    await page.evaluate('document.querySelector("[data-action=underline]").focus()');
    const key=async(key,code,number)=>{await page.send('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:number});await page.send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:number});};
    await key('ArrowDown','ArrowDown',40);await page.waitFor('document.activeElement?.matches("[data-tool-mode]")');
    await key('Escape','Escape',27);assert.equal(await page.evaluate('document.activeElement?.dataset.action'),'underline');
    const pointer=async(points)=>{
      const translated=await page.evaluate(`(()=>{const f=${frame},p=f.contentDocument.querySelector('#target').getBoundingClientRect(),b=f.getBoundingClientRect();return ${JSON.stringify(points)}.map(([x,y])=>({x:b.left+(p.left+x)*b.width/f.clientWidth,y:b.top+(p.top+y)*b.height/f.clientHeight}));})()`);
      await page.send('Input.dispatchMouseEvent',{type:'mousePressed',...translated[0],button:'left',buttons:1,clickCount:1});
      for(const p of translated.slice(1))await page.send('Input.dispatchMouseEvent',{type:'mouseMoved',...p,button:'left',buttons:1});
      await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',...translated.at(-1),button:'left',buttons:0,clickCount:1});
    };
    await choose('highlight','area');await pointer([[20,20],[100,45]]);await page.waitFor(`(async()=>{const {getDocument}=await import('./src/storage.js');return (await getDocument('tool-modes-document')).metadata.annotations.length===1;})()`);
    await choose('underline','area-underline');await pointer([[120,80],[200,100]]);await page.waitFor(`(async()=>{const {getDocument}=await import('./src/storage.js');return (await getDocument('tool-modes-document')).metadata.annotations.length===2;})()`);
    for(const [variant,point,text] of [['text',[260,100],'자유 텍스트 확인'],['note',[320,130],'메모 상자 확인']]){
      await choose('note',variant);await pointer([point]);await page.waitFor('document.querySelector("#dialog").open&&document.querySelector("#note-text")');
      await page.evaluate(`document.querySelector('#note-text').value=${JSON.stringify(text)}`);await page.click('#dialog button[value=save]');
      await page.waitFor(`(async()=>{const {getDocument}=await import('./src/storage.js');return (await getDocument('tool-modes-document')).metadata.annotations.some(a=>a.type===${JSON.stringify(variant)});})()`);
    }
    const before=await saved();assert.deepEqual(before.map(a=>a.type),['area','area-underline','text','note']);
    await choose('eraser','clear');await page.waitFor('document.querySelector("#dialog").open&&document.querySelector("#dialog button[value=cancel]")');
    await page.click('#dialog button[value=cancel]');assert.deepEqual(await saved(),before,'cancelling clear-all preserves every annotation');
    await page.click('[data-action=eraser]');await page.waitFor('document.querySelector("[data-tool-mode=clear]")');
    assert.equal(await page.evaluate('document.querySelector("[data-tool-mode=clear]").getAttribute("role")'),'menuitem');
    await writeFile(join(root,'test-results/toolbar-modes-eraser-320.png'),await page.screenshot());
    await page.click('[data-tool-mode=clear]');await page.waitFor('document.querySelector("#dialog").open');await page.click('#dialog button[value=confirm]');
    await page.waitFor(`(async()=>{const {getDocument}=await import('./src/storage.js');return (await getDocument('tool-modes-document')).metadata.annotations.length===0;})()`);
    await page.click('[data-action=eraser]');await page.waitFor('document.querySelector("[data-tool-mode=clear]")');assert.equal(await page.evaluate('document.querySelector("[data-tool-mode=clear]").disabled'),true);await page.click('[data-popover-close]');
    await page.click('[data-action=undo]');await page.waitFor(`(async()=>{const {getDocument}=await import('./src/storage.js');return (await getDocument('tool-modes-document')).metadata.annotations.length===4;})()`);assert.deepEqual(await saved(),before);
    await page.navigate(url);await page.waitFor('document.querySelector("[data-open=tool-modes-document]")');await page.click('[data-open=tool-modes-document]');
    await page.waitFor(`${frame}?.style.visibility==='visible'&&${doc}?.querySelectorAll('#htmlmemo-annotation-layer [data-htmlmemo-id]').length===4`);assert.deepEqual(await saved(),before);
    await page.evaluate(`window.showSaveFilePicker=async()=> (await navigator.storage.getDirectory()).getFileHandle('tool-modes-export.html',{create:true});`);await page.click('#save-page');
    await page.waitFor(`(async()=>{try{return (await (await (await navigator.storage.getDirectory()).getFileHandle('tool-modes-export.html')).getFile()).size>0;}catch{return false;}})()`);
    const exported=await page.evaluate(`(async()=>{const html=await (await (await (await navigator.storage.getDirectory()).getFileHandle('tool-modes-export.html')).getFile()).text();return JSON.parse(new DOMParser().parseFromString(html,'text/html').getElementById('htmlmemo-data').textContent).annotations;})()`);
    assert.deepEqual(exported,before);assert.deepEqual(chrome.errors,[]);
  }finally{if(chrome)await chrome.close();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});
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
    await page.waitFor('document.querySelector("#status-left").textContent.includes("개의 문서")');
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
test('real Chrome: Pages-only URL use, safe text import, app tabs and optional installation',{timeout:60000},async()=>{
  await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'htmlmemo-pages-only-'));await cp(join(root,'public'),folder,{recursive:true});
  const server=createServer(folder);let chrome;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));chrome=await launchChrome();const page=chrome.page;
    const url=process.env.HTMLMEMO_SIDEBAR_TEST_URL||`http://127.0.0.1:${server.address().port}/`,storageURL=new URL('src/storage.js',url).href,exampleURL=new URL('example.html',url).href;
    await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
    await page.navigate(url);await page.waitFor('document.querySelector("#status-left").textContent.includes("개의 문서")');
    assert.equal(await page.evaluate('!!document.querySelector(\'meta[name="htmlmemo-app"],#connection-button,#execution-chrome\')'),false);
    await clickAppMenu(page,'#execution-tab');
    assert.match(await page.evaluate('document.querySelector("#execution").textContent'),/URL 하나로,\s*설치 없이 바로/);
    assert.match(await page.evaluate('document.querySelector("#execution").textContent'),/선택/);
    await page.click('#execution-web');await page.waitFor('document.querySelector("#dialog").open&&!!document.querySelector("#web-help-paste")');
    assert.match(await page.evaluate('document.querySelector("#dialog").textContent'),/추가 프로그램이나 서버 연결은 필요하지 않습니다/);
    assert.equal(await page.evaluate('!!document.querySelector(\'#dialog a[href*=".zip"],#dialog a[href^="chrome:"]\')'),false);
    await page.click('#dialog [data-dialog-close]');await page.click('#library-tab');
    const open=async()=>page.evaluate(`document.querySelector('#address').value=${JSON.stringify(exampleURL)};document.querySelector('#address-form').requestSubmit();`);
    await open();await page.waitFor('!!document.querySelector(".browser-frame")?.contentDocument?.body');
    await page.click('#library-tab');await open();assert.equal(await page.evaluate('document.querySelectorAll(".tab.browser").length'),1);
    assert.deepEqual(await page.evaluate('(()=>{const a=document.querySelector(".browser-host:not([hidden]) [data-open-external]");return {url:a.href,target:a.target,rel:a.rel};})()'),{url:exampleURL,target:'_blank',rel:'noopener noreferrer'});
    // Obsolete extension messages must not import a page or alter navigation.
    await page.evaluate('postMessage({channel:"htmlmemo-extension-ready"},"*");postMessage({channel:"htmlmemo-extension-capture",capture:{title:"Unrequested page",html:"<p>ignored</p>"}},"*");window.pickerCalls=0;window.showSaveFilePicker=async()=>{pickerCalls++;throw Error("No picker is needed for library import");};');
    await page.click('.browser-host:not([hidden]) [data-web-help]');await page.click('#web-help-paste');
    const text='기억할 문장과 함께 읽습니다.\n둘째 줄을 유지합니다.\n\n<script>window.pastedExecuted=true</script>';
    await page.evaluate(`document.querySelector('#paste-title').value='URL만으로 보관한 글';document.querySelector('#paste-text').value=${JSON.stringify(text)};`);
    await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/pages-only-desktop.png'),await page.screenshot());
    await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    await writeFile(join(root,'test-results/pages-only-mobile.png'),await page.screenshot());
    assert.equal(await page.evaluate('(()=>{const d=document.querySelector("#dialog").getBoundingClientRect();return d.left>=0&&d.right<=innerWidth&&d.height<=innerHeight;})()'),true);
    await page.click('#paste-save');await page.waitFor('!document.querySelector("#dialog").open&&!document.querySelector("#toolbar").hidden&&document.querySelector("#status-left").textContent.includes("자동 저장됨")');
    const frame='document.querySelector(".document-host:not([hidden]) iframe")';
    assert.equal(await page.evaluate(`${frame}.contentWindow.pastedExecuted`),undefined);
    assert.match(await page.evaluate(`${frame}.contentDocument.body.textContent`),/<script>window.pastedExecuted=true<\/script>/);
    assert.equal(await page.evaluate('window.pickerCalls'),0);
    const saved=await page.evaluate(`(async()=>{const s=await import(${JSON.stringify(storageURL)}),r=await s.listDocuments(),d=await s.getDocument(r[0].id);return {count:r.length,title:d.title,source:d.source,paragraphs:new DOMParser().parseFromString(d.html,'text/html').querySelectorAll('article>p').length};})()`);
    assert.deepEqual(saved,{count:1,title:'URL만으로 보관한 글',source:exampleURL,paragraphs:3});
    await page.evaluate(`(()=>{const d=${frame}.contentDocument,r=d.createRange();r.selectNodeContents(d.querySelector('article>p'));const s=d.getSelection();s.removeAllRanges();s.addRange(r);d.dispatchEvent(new Event('selectionchange'));})()`);
    await page.click('#toolbar [data-action=highlight]');
    await page.waitFor(`${frame}.contentDocument.querySelector('[data-htmlmemo-mark]')&&document.querySelector('#status-left').textContent.includes('자동 저장됨')`);
    await page.click('.tab.document.active .tab-close');await page.click('#library-tab');await page.click('[data-open]');
    await page.waitFor(`${frame}.contentDocument.querySelector('[data-htmlmemo-mark]')&&!document.querySelector('#toolbar').hidden`);
    assert.equal(await page.evaluate('document.querySelectorAll(".tab.browser").length'),1);
    assert.equal(await page.evaluate('window.pickerCalls'),0);assert.deepEqual(chrome.errors,[]);
  }finally{if(chrome)await chrome.close();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});

test('real Chrome: Chrome companion search has no iframe, preserves the reader and imports the actual article URL',{timeout:60000},async()=>{
  await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'htmlmemo-native-chrome-'));await cp(join(root,'public'),folder,{recursive:true});
  const server=createServer(folder);let chrome;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));chrome=await launchChrome();const page=chrome.page,url=process.env.HTMLMEMO_SIDEBAR_TEST_URL||`http://127.0.0.1:${server.address().port}/`;
    await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
    await page.navigate(url);await page.waitFor('document.querySelector("#status-left").textContent.includes("개의 문서")');await page.click('#open-example');await page.waitFor('!document.querySelector("#toolbar").hidden&&document.querySelector("#status-left").textContent.includes("자동 저장됨")');
    const id=await page.evaluate('document.querySelector(".tab.document.active").dataset.tab');
    await page.evaluate('document.dispatchEvent(new KeyboardEvent("keydown",{key:"l",ctrlKey:true,bubbles:true}));document.querySelector("#address").value="크롬 연결 검증";');await page.click('#address-open');
    await page.send('Page.bringToFront');await page.waitFor('document.querySelectorAll(".tab.browser").length===1');
    assert.equal(await page.evaluate('document.querySelector(".tab.document.active").dataset.tab'),id);
    assert.equal(await page.evaluate('document.querySelectorAll(".browser-frame").length'),0);
    assert.equal(await page.evaluate('document.querySelector(".document-host:not([hidden]) iframe").contentDocument.title'),'천천히 읽는다는 것');
    let targets=[];for(let attempt=0;attempt<100;attempt++){targets=(await page.send('Target.getTargets')).targetInfos;if(targets.some(t=>t.type==='page'&&t.url.startsWith('https://www.google.com/')))break;await new Promise(resolve=>setTimeout(resolve,50));}assert.ok(targets.some(t=>t.type==='page'&&t.url.startsWith('https://www.google.com/')));
    // No clipboard permission or clipboard read: this shortcut only opens the form.
    await page.evaluate('document.dispatchEvent(new KeyboardEvent("keydown",{key:"V",ctrlKey:true,shiftKey:true,bubbles:true}));');
    await page.waitFor('document.querySelector("#dialog").open&&!!document.querySelector("#paste-source")');assert.equal(await page.evaluate('document.querySelector("#paste-source").value'),'');
    await page.click('#dialog [data-dialog-close]');
    await page.click('.tab.browser .tab-select');await page.send('Page.bringToFront');await page.waitFor('!document.querySelector(".browser-host").hidden');
    assert.equal(await page.evaluate('document.querySelector(".handoff-heading > p:last-child").innerText'),'외부 사이트는 이 앱을 연 브라우저의 일반 탭에서 엽니다.\n웹 페이지를 하나의 파일로 저장한 다음, HTMLMemo에서 열면 됩니다.');
    assert.equal(await page.evaluate('document.querySelector(".browser-host").textContent.includes("HTMLMemo 안에 넣지 않아 연결 거부 화면이 나오지 않습니다.")'),false);
    assert.equal(await page.evaluate('document.querySelector(".browser-host").textContent.includes("돌아오면 읽던 문서에서 계속 작업할 수 있습니다.")'),false);
    assert.ok(['브라우저 탭으로 보냈습니다.','복사한 글을 붙여넣거나 저장한 HTML을 가져오세요.'].includes(await page.evaluate('document.querySelector(".browser-host [data-web-status]").textContent')));
    assert.equal(await page.evaluate('["#back","#forward","#reload"].every(s=>document.querySelector(s).disabled)'),true);
    assert.equal(await page.evaluate('document.querySelector("#save-page").getAttribute("aria-label")'),'Chrome에서 가져오기');
    await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/chrome-companion-desktop.png'),await page.screenshot());
    await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    await writeFile(join(root,'test-results/chrome-companion-mobile.png'),await page.screenshot());
    await page.click('[data-browser-paste]');await page.waitFor('document.querySelector("#paste-text")===document.activeElement');
    await page.evaluate('document.querySelector("#paste-title").value="Chrome에서 가져온 실제 글";document.querySelector("#paste-source").value="https://source.example/actual-article";document.querySelector("#paste-text").value="실제 글을 복사한 내용입니다.\\n\\n<script>window.shouldNotRun=true</script>";');
    await page.click('#paste-save');await page.waitFor('!document.querySelector("#dialog").open&&document.querySelector("#status-left").textContent.includes("자동 저장됨")');
    const stored=await page.evaluate(`(async()=>{const s=await import('./src/storage.js'),rows=await s.listDocuments(),r=rows.find(r=>r.title==='Chrome에서 가져온 실제 글');return {count:rows.length,source:r.source,oldNotes:rows.find(r=>r.title==='천천히 읽는다는 것').metadata.annotations.length};})()`);
    assert.deepEqual(stored,{count:2,source:'https://source.example/actual-article',oldNotes:0});
    assert.equal(await page.evaluate('document.querySelector(".document-host:not([hidden]) iframe").contentWindow.shouldNotRun'),undefined);
    assert.deepEqual(chrome.errors,[]);
  }finally{if(chrome)await chrome.close();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});

test('real Chrome: cross-origin CORS capture and blocked-site fallback use only the app',{timeout:60000},async()=>{
  await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'htmlmemo-cors-'));await cp(join(root,'public'),folder,{recursive:true});
  const server=createServer(folder),requests=[];
  const site=createHTTPServer((request,response)=>{
    requests.push({path:request.url,mode:request.headers['sec-fetch-mode'],origin:request.headers.origin,dest:request.headers['sec-fetch-dest'],referer:request.headers.referer,cookie:request.headers.cookie,authorization:request.headers.authorization});
    response.setHeader('X-Frame-Options','DENY');
    if(request.url!=='/blocked.html')response.setHeader('Access-Control-Allow-Origin','*');
    if(request.url.startsWith('/opened?')){response.end('ok');return;}
    if(request.url==='/assets/style.css'){response.setHeader('Content-Type','text/css');response.end('p{color:rgb(12,34,56)}');}
    else if(request.url==='/assets/picture.svg'){response.setHeader('Content-Type','image/svg+xml');response.end('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><path d="M0 0h2v2H0z"/></svg>');}
    else{response.setHeader('Content-Type','text/html; charset=utf-8');response.end('<!doctype html><title>CORS 허용 글</title><base href="/assets/"><link rel="stylesheet" href="style.css"><p id="cors-text" onclick="window.unwanted=true">서버나 확장 없이 가져온 본문입니다.</p><img src="picture.svg"><script>fetch("/opened?has-opener="+!!window.opener);window.unwanted=true</script>');}
  });let chrome;
  try{
    await Promise.all([server,site].map(s=>new Promise((resolve,reject)=>{s.once('error',reject);s.listen(0,'127.0.0.1',resolve);})));
    const url=`http://127.0.0.1:${server.address().port}/`,origin=`http://127.0.0.1:${site.address().port}`,storageURL=new URL('src/storage.js',url).href;
    chrome=await launchChrome();const page=chrome.page;
    await page.navigate(url);await page.waitFor('document.querySelector("#status-left").textContent.includes("개의 문서")');
    await page.evaluate('document.cookie="htmlmemo_cors_test=not_sent;path=/";window.pickerCalls=0;window.showSaveFilePicker=async()=>{pickerCalls++;throw Error("Library saving must not open a picker");};');
    const open=async address=>{await page.send('Page.bringToFront');await page.click('#library-tab');await page.evaluate(`document.querySelector('#address').value=${JSON.stringify(address)};document.querySelector('#address-form').requestSubmit();`);await page.send('Page.bringToFront');await page.waitFor('!!document.querySelector(".browser-host:not([hidden]) [data-capture]")');await page.evaluate('document.querySelector(".browser-host:not([hidden]) details").open=true');};
    await open(origin+'/allowed.html');
    await page.waitFor(`["브라우저 탭으로 보냈습니다.","복사한 글을 붙여넣거나 저장한 HTML을 가져오세요."].includes(document.querySelector('.browser-handoff [data-web-status]').textContent)`);
    assert.equal(await page.evaluate('document.querySelectorAll(".browser-frame").length'),0);
    for(let attempt=0;attempt<100&&!requests.some(r=>r.path==='/opened?has-opener=false');attempt++)await new Promise(resolve=>setTimeout(resolve,50));
    assert.ok(requests.some(r=>r.path==='/opened?has-opener=false'),'the real browser tab loaded with no reverse opener access');
    assert.ok(requests.some(r=>r.path==='/allowed.html'&&r.dest==='document'&&!r.referer),'the browser handoff does not disclose the app referrer');
    const beforeTargets=(await page.send('Target.getTargets')).targetInfos.filter(t=>t.type==='page'&&t.url===origin+'/allowed.html');assert.equal(beforeTargets.length,1);
    await page.click('.tab.browser .tab-select');await page.send('Page.bringToFront');assert.equal((await page.send('Target.getTargets')).targetInfos.filter(t=>t.type==='page'&&t.url===origin+'/allowed.html').length,1);
    await page.click('[data-capture]');await page.waitFor('!document.querySelector("#toolbar").hidden&&document.querySelector("#status-left").textContent.includes("자동 저장됨")');
    const frame='document.querySelector(".document-host:not([hidden]) iframe")';
    assert.equal(await page.evaluate(`${frame}.contentWindow.unwanted`),undefined);
    assert.equal(await page.evaluate(`${frame}.contentDocument.querySelector('#cors-text').hasAttribute('onclick')`),false);
    assert.match(await page.evaluate(`${frame}.contentDocument.querySelector('img').src`),/^data:image\/svg\+xml;base64,/);
    assert.equal(await page.evaluate(`getComputedStyle(${frame}.contentDocument.querySelector('#cors-text')).color`),'rgb(12, 34, 56)');
    const rows=await page.evaluate(`(async()=>{const s=await import(${JSON.stringify(storageURL)});return (await s.listDocuments()).map(r=>({source:r.source,warnings:r.metadata.warnings}));})()`);
    assert.deepEqual(rows,[{source:origin+'/allowed.html',warnings:[]}]);
    const direct=requests.filter(r=>r.mode==='cors'&&r.origin===new URL(url).origin);
    assert.ok(['/allowed.html','/assets/style.css','/assets/picture.svg'].every(path=>direct.some(r=>r.path===path)));
    assert.ok(direct.every(r=>!r.cookie&&!r.authorization));assert.equal(await page.evaluate('window.pickerCalls'),0);
    await open(origin+'/blocked.html');await page.click('.browser-host:not([hidden]) [data-capture]');await page.waitFor('document.querySelector("#dialog").open&&!!document.querySelector("#web-help-paste")');
    assert.match(await page.evaluate('document.querySelector("#dialog").textContent'),/직접 가져오지 못했습니다/);
    assert.equal(await page.evaluate('document.querySelectorAll(".tab.document").length'),1);
    assert.equal(await page.evaluate('document.querySelector("#dialog a[target=_blank]").href'),origin+'/blocked.html');
    await page.click('#web-help-paste');await page.evaluate('document.querySelector("#paste-title").value="제한된 사이트의 글";document.querySelector("#paste-text").value="필요한 글만 복사해서 읽습니다."');await page.click('#paste-save');
    await page.waitFor(`!document.querySelector('#dialog').open&&${frame}.contentDocument.title==='제한된 사이트의 글'&&document.querySelector('#status-left').textContent.includes('자동 저장됨')`);
    assert.equal(await page.evaluate(`${frame}.contentDocument.querySelector('a').href`),origin+'/blocked.html');
    assert.equal(await page.evaluate('window.pickerCalls'),0);assert.deepEqual(chrome.errors,[]);
  }finally{if(chrome)await chrome.close();await Promise.all([server,site].map(s=>new Promise(resolve=>s.close(resolve))));await rm(folder,{recursive:true,force:true});}
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
        const layout=await page.evaluate(`(()=>{const main=document.querySelector('#main').getBoundingClientRect(),header=document.querySelector('.chrome').getBoundingClientRect(),row=document.querySelector('.addressbar').getBoundingClientRect();return {left:main.left,width:main.width,viewport:innerWidth,oldNavigation:!!document.querySelector('.chrome-topline,.desk-nav,#desk-resizer'),rows:header.height-row.height,controls:['#library-tab','#save-page','#app-menu-button'].map(id=>{const element=document.querySelector(id),r=element.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return {id,visible:r.width>0&&r.height>0&&r.left>=0&&r.right<=innerWidth&&element.contains(hit)};})};})()`);
        assert.equal(layout.oldNavigation,false);assert.equal(layout.left,0);assert.equal(layout.width,layout.viewport);assert.equal(layout.rows,1);
        assert.ok(layout.controls.every(control=>control.visible),JSON.stringify({width,...layout}));
        assert.deepEqual(await page.evaluate(`['#library-tab','#save-page'].map(id=>{const element=document.querySelector(id);return {text:element.textContent,title:element.title,label:element.getAttribute('aria-label'),width:element.getBoundingClientRect().width,icon:!!element.querySelector('svg')};})`),[{text:'',title:'내 서재',label:'내 서재',width:26,icon:true},{text:'',title:'페이지 저장',label:'페이지 저장',width:26,icon:true}]);
        await page.click('#app-menu-button');
        const dropdown=await page.evaluate(`(()=>{const menu=document.querySelector('#app-menu'),m=menu.getBoundingClientRect(),header=document.querySelector('.chrome').getBoundingClientRect();return {anchored:m.top>=header.bottom&&m.left>=0&&m.right<=innerWidth,modal:document.querySelector('#dialog').open,items:[...menu.querySelectorAll('button')].filter(e=>!e.hidden).map(element=>{const r=element.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return element.contains(hit);})};})()`);
        assert.equal(dropdown.anchored,true);assert.equal(dropdown.modal,false);assert.ok(dropdown.items.every(Boolean));
        await clickAppMenu(page,'#about-button');await page.waitFor(`document.querySelector("#dialog").open && document.querySelector("#app-version")?.textContent===${JSON.stringify(appVersion)}`);
        assert.equal(await page.evaluate('document.querySelector(".about-brand h3").textContent'),'HTMLMemo');
        await page.click('#dialog [data-dialog-close]');
        await clickAppMenu(page,'#execution-tab');await page.waitFor('!document.querySelector("#execution").hidden');
        await clickAppMenu(page,'#new-tab');await page.waitFor('!document.querySelector("#library").hidden && document.activeElement.id==="address"');
        await clickAppMenu(page,'#execution-tab');await page.click('#library-tab');await page.waitFor('!document.querySelector("#library").hidden');
        await clickLibraryImport(page);
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
      const saved=await page.evaluate(`(async()=>{const s=await import('./src/storage.js'),records=await s.listDocuments(),record=await s.getDocument(records[0].id);return {count:records.length,html:record.html,annotations:record.metadata.annotations.length};})()`);assert.equal(saved.count,1);assert.equal(saved.annotations,0);assert.match(saved.html,/data:image\/svg\+xml;base64/);assert.ok(!saved.html.includes('fixtureLoaded'));
    });
    await t.test('local annotation saves internally and exports on request',async()=>{
      await page.evaluate(`(()=>{const doc=document.querySelector('.document-host:not([hidden]) iframe').contentDocument;const text=doc.querySelector('#selection').firstChild;const range=doc.createRange();range.setStart(text,0);range.setEnd(text,15);doc.getSelection().removeAllRanges();doc.getSelection().addRange(range);doc.dispatchEvent(new Event('selectionchange'));})()`);await page.click('[data-action="highlight"]');
      await page.waitFor('document.querySelector(".document-host:not([hidden]) iframe").contentDocument.querySelector("[data-htmlmemo-mark]") && document.querySelector("#status-left").textContent.includes("자동 저장됨")');
      await page.click('#save-page');
      await page.waitFor(`(async()=>{const root=await navigator.storage.getDirectory();const html=await (await (await root.getFileHandle('picked-document.html')).getFile()).text();return JSON.parse(new DOMParser().parseFromString(html,'text/html').getElementById('htmlmemo-data').textContent).annotations.length > 0;})()`);
      const annotation=await page.evaluate(`(async()=>{const root=await navigator.storage.getDirectory();const html=await (await (await root.getFileHandle('picked-document.html')).getFile()).text();return JSON.parse(new DOMParser().parseFromString(html,'text/html').getElementById('htmlmemo-data').textContent).annotations[0];})()`);assert.equal(annotation.type,'highlight');assert.ok(annotation.textAnchor.quote.length);
    });
    await t.test('local file import activates annotation independent of original website URL',async()=>{
      await page.evaluate(`window.showOpenFilePicker=async()=>{const root=await navigator.storage.getDirectory();return [await root.getFileHandle('picked-document.html')];};`);await clickLibraryImport(page);await page.waitFor('document.querySelectorAll(".tab.document").length === 2 && !document.querySelector("#toolbar").hidden');assert.equal(await page.evaluate('document.querySelector("#local-label").hidden'),false);assert.equal(await page.evaluate('document.querySelector(".document-host:not([hidden]) iframe").contentDocument.querySelectorAll("[data-htmlmemo-mark]").length > 0'),true);
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
      await page.waitFor('document.querySelector(".document-host:not([hidden]) [data-action=zoom]").textContent === "50%"');
      await page.evaluate(`document.querySelector('.document-host:not([hidden]) iframe').contentDocument.body.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,button:0,cancelable:true}));`);
      await page.waitFor(`(()=>{const app=document.querySelector('#app'),viewport=document.querySelector('.document-host:not([hidden]) .reader-viewport'),frame=viewport.querySelector('iframe');const v=viewport.getBoundingClientRect(),f=frame.getBoundingClientRect();return app.classList.contains('reader-focus') && Math.abs(f.left-v.left)<1 && Math.abs(f.width-viewport.clientWidth)<1;})()`);
      await page.evaluate(`document.querySelector('.document-host:not([hidden]) iframe').contentDocument.body.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,button:0,cancelable:true}));`);await page.waitFor('!document.querySelector("#app").classList.contains("reader-focus") && document.querySelector(".document-host:not([hidden]) [data-action=zoom]").textContent === "50%"');
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
    await clickLibraryImport(page);await page.waitFor('document.querySelector("#status-left").textContent.includes("주석이 앱에 자동 저장됨")');
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
    await page.evaluate(`document.querySelector('.document-host:not([hidden]) [data-action="zoom"]').click()`);await page.waitFor(`!!document.querySelector('#zoom-value')`);await page.evaluate(`const input=document.querySelector('#zoom-value');input.value='125';input.dispatchEvent(new Event('change',{bubbles:true}));`);await page.waitFor(`document.querySelector('.document-host:not([hidden]) [data-action="zoom"]').textContent==='125%'`);
    assert.deepEqual(chrome.errors,[]);
  }finally{if(chrome)await chrome.close();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});

test('real Chrome: compact library shares titles and sources, keeps dense views usable and preserves notes',{timeout:90000},async()=>{
  await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'htmlmemo-compact-library-'));await cp(join(root,'public'),folder,{recursive:true});
  const server=createServer(folder);let chrome;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));chrome=await launchChrome();const page=chrome.page,url=process.env.HTMLMEMO_SIDEBAR_TEST_URL||`http://127.0.0.1:${server.address().port}/`;
    await page.navigate(url);await page.waitFor('document.querySelector("#status-left").textContent.includes("개의 문서")');
    assert.equal(await page.evaluate('document.querySelector("#empty-library h3").textContent'),'첫 HTML 문서를 보관해보세요.');
    await page.evaluate(`(async()=>{const {putDocumentRevision}=await import('./src/storage.js'),{parseHTML}=await import('./src/document.js');for(let i=0;i<8;i++){const title=i===0?'로컬 LLM 학습 노트':i===1?'아주긴제목'.repeat(12)+' & <정리>':'Compact book '+i,source=i%2?'https://very-long-library-source.example.test/book/'+i:'',html='<html><head><title>Compact library</title></head><body><h1 id="compact-target">Document '+i+'</h1><p>Keep the original source and annotation records.</p></body></html>',parsed=parseHTML(html,{title,source},{allowScripts:true});parsed.metadata.title=title;if(i===0){parsed.metadata.annotations=[{id:'kept-note',type:'note',text:'기존 주석 보존',color:'#334155',width:3,opacity:1,points:[{x:20,y:30}]}];parsed.metadata.bookmarks=[{id:'kept-mark',title:'기존 북마크',top:0,left:0}];}await putDocumentRevision({id:'compact-'+i,title,name:'compact-'+i+'.html',source,created:1000+i,modified:2000+i,html:parsed.html,metadata:parsed.metadata});}})()`);
    const state=()=>page.evaluate(`(async()=>{const {listDocuments,listRevisions}=await import('./src/storage.js');return Promise.all((await listDocuments()).map(async r=>({id:r.id,title:r.title,modified:r.modified,annotations:r.metadata.annotations,bookmarks:r.metadata.bookmarks,revisions:(await listRevisions(r.id)).length})));})()`);
    const before=await state();await page.navigate(url);await page.waitFor('document.querySelectorAll(".document-card").length===8');
    for(const width of [1280,800,600,390,320]){
      await page.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<600});
      for(const view of ['card','list']){
        await page.click('#library-'+view+'-view');
        const metrics=await page.evaluate(`(()=>{const grid=document.querySelector('#document-grid'),cards=[...grid.querySelectorAll('.document-card')],rect=node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};return {view:grid.dataset.view,overflow:document.querySelector('#library').scrollWidth>innerWidth,hero:rect(document.querySelector('.hero')).height,cards:cards.map(card=>{const r=rect(card),open=card.querySelector('.card-open'),menu=card.querySelector('.card-menu'),m=rect(menu);return {height:r.height,top:r.top,titleCount:card.querySelectorAll('h3').length,sourceCount:card.querySelectorAll('.list-host').length,preview:!!card.querySelector('.card-preview,.list-details'),title:card.querySelector('.list-title').textContent,fullTitle:card.querySelector('.list-title').title,menuWidth:m.width,menuHeight:m.height,menuHit:menu.contains(document.elementFromPoint(m.left+m.width/2,m.top+m.height/2)),inside:[...open.querySelectorAll('.list-title,.list-host,.list-date,.list-annotations,.list-size,.list-progress')].every(node=>{const b=rect(node);return !b.width||b.left>=r.left&&b.right<=r.right&&b.top>=r.top&&b.bottom<=r.bottom;})};})};})()`);
        assert.equal(metrics.view,view);assert.equal(metrics.overflow,false);assert.ok(metrics.hero<=90,JSON.stringify({width,view,hero:metrics.hero}));
        assert.ok(metrics.cards.every(card=>card.titleCount===1&&card.sourceCount===1&&!card.preview&&card.title===card.fullTitle&&card.inside&&card.menuWidth>=24&&card.menuHeight>=24),JSON.stringify({width,view,metrics}));
        assert.ok(metrics.cards.every(card=>card.height<=(view==='card'?100:width<=600?34:30)),JSON.stringify({width,view,heights:metrics.cards.map(card=>card.height)}));
        if(view==='card'){const columns=metrics.cards.filter(card=>Math.abs(card.top-metrics.cards[0].top)<1).length;assert.ok(columns>=(width===1280?5:2),JSON.stringify({width,columns}));}
        // The first document and every menu in the first row remain reachable.
        assert.equal(metrics.cards[0].menuHit,true);
        if([1280,390,320].includes(width)){await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/library-compact-'+view+'-'+width+'.png'),await page.screenshot());}
      }
    }
    const filter=async value=>page.evaluate(`(()=>{const input=document.querySelector('#library-filter');input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input'));return document.querySelectorAll('.document-card').length;})()`);
    assert.equal(await filter('로컬 LLM'),1);assert.equal(await filter('no-such-document'),0);assert.equal(await page.evaluate('getComputedStyle(document.querySelector("#document-grid")).display'),'none');assert.equal(await filter(''),8);
    await page.click('[data-card-menu="compact-0"]');await page.waitFor('document.querySelector("#dialog").open');
    assert.equal(await page.evaluate('["menu-open","menu-export","menu-history","menu-migrate","menu-remove"].every(id=>!!document.getElementById(id))'),true);await page.click('#dialog [data-dialog-close]');
    await page.navigate(url);await page.waitFor('document.querySelectorAll(".document-card").length===8');assert.equal(await page.evaluate('document.querySelector("#document-grid").dataset.view'),'list');
    await page.send('Page.bringToFront');await page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await page.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await page.evaluate('(()=>{const button=document.querySelector("[data-open=compact-1]");button.addEventListener("click",()=>window.compactKeyboardActivated=true,{once:true});button.focus();})()');
    assert.equal(await page.evaluate('getComputedStyle(document.activeElement).outlineOffset'),'-2px');
    await page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r',unmodifiedText:'\r'});await page.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    try{await page.waitFor('window.compactKeyboardActivated&&document.querySelector(".document-host:not([hidden]) iframe")?.contentDocument?.querySelector("#compact-target")&&document.querySelector("#status-left").textContent.includes("자동 저장됨")');}
    catch(error){const details=await page.evaluate('(()=>{const frame=document.querySelector(".document-host:not([hidden]) iframe");return {activated:!!window.compactKeyboardActivated,focused:document.activeElement?.getAttribute("data-open"),tabs:document.querySelectorAll(".tab.document").length,status:document.querySelector("#status-left").textContent,toast:document.querySelector("#toast").textContent,frameReady:frame?.contentDocument?.readyState,frameVisible:frame?.style.visibility,body:frame?.contentDocument?.body?.textContent?.slice(0,160)};})()');await writeFile(join(root,'test-results/library-compact-open-failure.png'),await page.screenshot());throw Error(error.message+' '+JSON.stringify({details,errors:chrome.errors}));}
    assert.deepEqual(await state(),before);assert.deepEqual(chrome.errors,[]);
  }finally{await chrome?.close();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
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

test('real Chrome: adaptive file tabs shrink evenly before scrolling and preserve controls and document instances',{timeout:90000},async()=>{
  await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'htmlmemo-adaptive-tabs-'));await cp(join(root,'public'),folder,{recursive:true});
  const server=createServer(folder);let chrome;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));chrome=await launchChrome();const page=chrome.page,url=process.env.HTMLMEMO_TABS_TEST_URL||process.env.HTMLMEMO_SIDEBAR_TEST_URL||`http://127.0.0.1:${server.address().port}/`;
    await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});await page.navigate(url);
    await page.waitFor('document.querySelector("#status-left").textContent.includes("개의 문서")');
    const ready='document.querySelector(".document-host:not([hidden]) iframe")?.style.visibility==="visible"&&!document.querySelector(".tab-dirty:not([hidden])")';
    const importTo=async(count,previous)=>{
      await page.evaluate(`(()=>{const transfer=new DataTransfer();for(let i=${previous};i<${count};i++){const title='문서 '+String(i+1).padStart(2,'0')+' — 긴 제목도 같은 너비로 줄어드는 HTML 문서 탭',html='<html><head><title>'+title+'</title></head><body><h1>'+title+'</h1><p>Unique adaptive document '+i+'</p></body></html>';transfer.items.add(new File([html],'adaptive-'+i+'.html',{type:'text/html'}));}const input=document.querySelector('#file-input');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await page.waitFor(`document.querySelectorAll('#tabs .tab.document').length===${count}&&${ready}`,60000);
    };
    const measure=()=>page.evaluate(`(()=>{const strip=document.querySelector('#tabs'),r=strip.getBoundingClientRect(),active=strip.querySelector('.tab.active').getBoundingClientRect();return {count:strip.children.length,viewport:innerWidth,stripWidth:strip.clientWidth,contentWidth:strip.scrollWidth,scrollLeft:strip.scrollLeft,widths:[...strip.children].map(el=>el.getBoundingClientRect().width),activeVisible:active.left>=r.left-1&&active.right<=r.right+1,headerHeight:document.querySelector('.chrome').offsetHeight,pageOverflow:document.documentElement.scrollWidth>innerWidth,controls:['#library-tab','#save-page','#app-menu-button'].every(selector=>{const el=document.querySelector(selector),b=el.getBoundingClientRect();return b.width>0&&b.left>=0&&b.right<=innerWidth&&el.contains(document.elementFromPoint(b.left+b.width/2,b.top+b.height/2));})};})()`);
    const visible=()=>page.waitFor(`(()=>{const strip=document.querySelector('#tabs').getBoundingClientRect(),tab=document.querySelector('#tabs .tab.active').getBoundingClientRect();return tab.left>=strip.left-1&&tab.right<=strip.right+1;})()`);
    const screen=async name=>{await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,`test-results/tab-sizing-${name}.png`),await page.screenshot());};
    const metrics=[];
    assert.equal(await page.evaluate('!!document.querySelector("#import-button")'),false);
    await page.evaluate('window.libraryImportCalls=0;window.showOpenFilePicker=async()=>{window.libraryImportCalls++;return [];};');
    for(const width of [1280,390,320]){
      await page.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<600});
      await clickLibraryImport(page);
      assert.equal(await page.evaluate('document.querySelector("#hero-import").textContent'),'HTML 파일 가져오기');
      await screen('library-import-'+width);
    }
    assert.equal(await page.evaluate('window.libraryImportCalls'),3);
    await page.evaluate('delete window.showOpenFilePicker;');
    await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
    await importTo(2,0);await visible();const few=await measure();metrics.push(few);
    assert.ok(few.widths.every(width=>Math.abs(width-220)<1));assert.equal(few.contentWidth,few.stripWidth);await screen('two-1280');
    await page.evaluate(`window.adaptiveFrames=[...document.querySelectorAll('#tabs [role=tab]')].map(button=>document.getElementById(button.getAttribute('aria-controls')).querySelector('iframe'));`);
    await importTo(6,2);await visible();const medium=await measure();metrics.push(medium);
    assert.ok(medium.widths.every(width=>width>96&&width<219));assert.ok(Math.max(...medium.widths)-Math.min(...medium.widths)<1);assert.equal(medium.contentWidth,medium.stripWidth);await screen('six-1280');
    await importTo(18,6);await visible();const many=await measure();metrics.push(many);
    assert.ok(many.widths.every(width=>Math.abs(width-96)<1));assert.ok(many.contentWidth>many.stripWidth);assert.ok(many.scrollLeft>0);await screen('eighteen-1280');
    assert.equal(await page.evaluate(`window.adaptiveFrames.every((frame,i)=>frame===document.getElementById(document.querySelectorAll('#tabs [role=tab]')[i].getAttribute('aria-controls')).querySelector('iframe'))`),true);
    assert.equal(await page.evaluate('document.querySelectorAll("#tabs .tab")[0].title.includes("adaptive-0.html")'),true);
    assert.equal(await page.evaluate('document.querySelectorAll("#tabs .tab")[0].querySelector(".tab-title").scrollWidth>document.querySelectorAll("#tabs .tab")[0].querySelector(".tab-title").clientWidth'),true);
    await page.evaluate('document.querySelector("#tabs").scrollLeft=0');
    const wheel=async(deltaX,deltaY)=>{const p=await page.evaluate('(()=>{const r=document.querySelector("#tabs").getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()');await page.send('Input.dispatchMouseEvent',{type:'mouseWheel',...p,deltaX,deltaY});};
    await wheel(0,240);await page.waitFor('document.querySelector("#tabs").scrollLeft>0');
    await wheel(0,10000);await page.waitFor('document.querySelector("#tabs").scrollLeft>=document.querySelector("#tabs").scrollWidth-document.querySelector("#tabs").clientWidth-1');
    await wheel(-240,0);await page.waitFor('document.querySelector("#tabs").scrollLeft<document.querySelector("#tabs").scrollWidth-document.querySelector("#tabs").clientWidth-20');
    await wheel(0,-10000);await page.waitFor('document.querySelector("#tabs").scrollLeft===0');
    await page.evaluate('new Promise(resolve=>setTimeout(resolve,400))');assert.equal(await page.evaluate('document.querySelector("#tabs").scrollLeft'),0,'saving may not snap a manually scrolled strip back to the active tab');
    const key=async key=>{const code=key==='Home'?36:35;await page.send('Input.dispatchKeyEvent',{type:'keyDown',key,code:key,windowsVirtualKeyCode:code});await page.send('Input.dispatchKeyEvent',{type:'keyUp',key,code:key,windowsVirtualKeyCode:code});};
    for(const width of [800,390,320]){
      await page.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<600});await visible();
      const state=await measure();metrics.push(state);assert.equal(state.headerHeight,25);assert.equal(state.pageOverflow,false);assert.equal(state.controls,true);assert.equal(state.activeVisible,true);
      assert.ok(state.contentWidth>state.stripWidth);assert.ok(state.widths.every(value=>Math.abs(value-Math.min(96,state.stripWidth))<1));
      await page.evaluate('document.querySelector("#tabs .tab.active .tab-select").focus()');
      await key('Home');await page.waitFor('document.querySelector("#tabs .tab.active")===document.querySelector("#tabs .tab:first-child")');await visible();
      await key('End');await page.waitFor('document.querySelector("#tabs .tab.active")===document.querySelector("#tabs .tab:last-child")');await visible();await screen('eighteen-'+width);
      const close=await page.evaluate('(()=>{const el=document.querySelector("#tabs .tab.active .tab-close"),r=el.getBoundingClientRect();return {width:r.width,reachable:el.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))};})()');assert.equal(close.width,20);assert.equal(close.reachable,true);
    }
    await page.click('#tabs .tab.active .tab-close');await page.waitFor(`document.querySelectorAll('#tabs .tab').length===17&&${ready}`);await visible();
    await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
    await visible();
    for(let count=17;count>2;count--){await page.click('#tabs .tab.active .tab-close');await page.waitFor(`document.querySelectorAll('#tabs .tab').length===${count-1}&&${ready}`);await visible();}
    await page.waitFor(`document.querySelectorAll('#tabs .tab').length===2&&${ready}`);await visible();const expanded=await measure();metrics.push(expanded);assert.ok(expanded.widths.every(width=>Math.abs(width-220)<1));assert.equal(expanded.contentWidth,expanded.stripWidth);
    assert.equal(await page.evaluate(`(async()=>{const {listDocuments}=await import('./src/storage.js');return (await listDocuments()).filter(r=>r.name.startsWith('adaptive-')).length;})()`),18,'closing tabs must retain all saved documents');
    await writeFile(join(root,'test-results/tab-sizing-metrics.json'),JSON.stringify(metrics,null,2));assert.deepEqual(chrome.errors,[]);
  }catch(error){
    if(chrome)try{
      await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/tab-sizing-failure.png'),await chrome.page.screenshot());
      const state=await chrome.page.evaluate(`(()=>{const s=document.querySelector('#tabs');return {viewport:innerWidth,status:document.querySelector('#status-left')?.textContent,strip:s&&{width:s.clientWidth,content:s.scrollWidth,left:s.scrollLeft},tabs:[...s?.children||[]].map(el=>({width:el.getBoundingClientRect().width,flex:getComputedStyle(el).flex,min:getComputedStyle(el).minWidth,active:el.classList.contains('active')}))};})()`);
      await writeFile(join(root,'test-results/tab-sizing-failure.json'),JSON.stringify(state,null,2));
    }catch(diagnostic){console.error('Tab sizing diagnostics failed:',diagnostic.message);}
    throw error;
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
    await clickLibraryImport(page);await page.waitFor('document.querySelectorAll("#tabs .tab.document").length===4&&document.querySelector("#status-left").textContent.includes("자동 저장됨")');
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
      const layout=await page.evaluate(`(()=>{const header=document.querySelector('.chrome').getBoundingClientRect(),strip=document.querySelector('#tabs').getBoundingClientRect();return {height:header.height,stripVisible:strip.width>0&&strip.left>=0&&strip.right<=innerWidth,selected:document.querySelectorAll('#tabs [aria-selected=true]').length,panels:document.querySelectorAll('.workspace-host:not([hidden])').length,controls:['#library-tab','#save-page','#app-menu-button'].every(selector=>{const element=document.querySelector(selector),r=element.getBoundingClientRect();return r.width>0&&r.right<=innerWidth&&element.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));})};})()`);
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
    await page.click('#tabs .tab.active .tab-close');await page.waitFor('document.querySelectorAll("#tabs .tab").length===1');
    await page.evaluate('document.querySelector("#tabs .tab.active .tab-select").focus()');await key('Delete');
    await page.waitFor('document.querySelectorAll("#tabs .tab").length===0&&document.activeElement.id==="library-tab"');
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

test('real Chrome: font-scaled pen glyph alignment, padding, wrapping, thickness, legacy baselines, reopen and export',{timeout:90000},async()=>{
  await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'htmlmemo-pen-font-'));await cp(join(root,'public'),folder,{recursive:true});
  const server=createServer(folder);let chrome;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));chrome=await launchChrome();const page=chrome.page;
    const url=process.env.HTMLMEMO_SIDEBAR_TEST_URL||`http://127.0.0.1:${server.address().port}/`;
    const source=await readFile(join(root,'tests/fixtures/font-scaling.html'),'utf8');
    await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});await page.navigate(url);
    await page.waitFor('document.querySelector("#status-left").textContent.includes("개의 문서")');
    await page.evaluate(`(async()=>{
      const {putDocumentRevision}=await import('./src/storage.js'),{parseHTML,describeDrawingTarget}=await import('./src/document.js');
      const parsed=parseHTML(${JSON.stringify(source)},{viewport:{width:1000,height:800}},{allowScripts:true});
      const d=new DOMParser().parseFromString(parsed.html,'text/html'),p=d.querySelector('#fixed');
      parsed.metadata.annotations=[{id:'legacy-font-pen',type:'pen',anchor:p.dataset.htmlmemoAnchor,anchorTarget:describeDrawingTarget(d,p),points:[{x:.08,y:.15},{x:.35,y:.55}],color:'#d94f4f',width:3,opacity:1}];
      await putDocumentRevision({id:'font-pen-document',title:'펜과 글자 크기 검증',name:'pen-font.html',created:Date.now(),modified:Date.now(),html:parsed.html,metadata:parsed.metadata});
    })()`);
    await page.navigate(url);await page.waitFor('!!document.querySelector("[data-open=font-pen-document]")');await page.click('[data-open=font-pen-document]');
    const frame='document.querySelector(".document-host:not([hidden]) iframe")',doc=frame+'.contentDocument';
    await page.waitFor(`${doc}?.querySelector('[data-htmlmemo-id="legacy-font-pen"]') && ${frame}.style.visibility==='visible'`);
    const saved=()=>page.evaluate(`(async()=>{const {getDocument}=await import('./src/storage.js');return (await getDocument('font-pen-document')).metadata.annotations;})()`);
    assert.equal((await saved())[0].penBasis,undefined,'opening a legacy document does not edit its annotations');
    const clickNative=async selector=>{
      const point=await page.evaluate(`(()=>{const f=${frame},r=f.contentDocument.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(),b=f.getBoundingClientRect();return {x:b.left+(r.left+r.width/2)*b.width/f.clientWidth,y:b.top+(r.top+r.height/2)*b.height/f.clientHeight};})()`);
      await page.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
    };
    const draw=async(quote='모양')=>{
      await page.click('#toolbar [data-action=pen]');
      const points=await page.evaluate(`(async()=>{const f=${frame},d=f.contentDocument,p=d.querySelector('#flow'),main=d.querySelector('main'),range=d.createRange(),at=p.textContent.indexOf(${JSON.stringify(quote)});if(at<0)throw Error('Missing pen target');range.setStart(p.firstChild,at);range.setEnd(p.firstChild,at+1);main.scrollTop=0;let r=range.getBoundingClientRect(),m=main.getBoundingClientRect();if(r.bottom>m.bottom-30)main.scrollTop=r.bottom-m.bottom+50;await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));r=range.getBoundingClientRect();const b=f.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2;return [[-6,-7],[6,-7],[6,7],[-6,7],[-6,-7]].map(([x,y])=>({x:b.left+(cx+x)*b.width/f.clientWidth,y:b.top+(cy+y)*b.height/f.clientHeight}));})()`);
      await page.send('Input.dispatchMouseEvent',{type:'mousePressed',...points[0],button:'left',buttons:1,clickCount:1});
      for(const point of points.slice(1))await page.send('Input.dispatchMouseEvent',{type:'mouseMoved',...point,button:'left',buttons:1});
      await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',...points.at(-1),button:'left',buttons:0,clickCount:1});
      await page.waitFor('document.querySelector("#status-left").textContent.includes("자동 저장됨")');
      return (await saved()).at(-1);
    };
    const snapshot=async(id,target,pin=null)=>page.evaluate(`(()=>{const d=${doc},p=d.querySelector('[data-htmlmemo-id="'+${JSON.stringify(id)}+'"]'),r=p.getBoundingClientRect(),element=d.querySelector(${JSON.stringify(target)}),t=element.getBoundingClientRect(),pin=${JSON.stringify(pin)};let x=t.left,y=t.top;if(pin){const range=d.createRange();range.setStart(element.firstChild,pin.start);range.setEnd(element.firstChild,pin.end);const g=range.getBoundingClientRect();x=g.left+g.width/2;y=g.top+g.height/2;}return {dx:r.left-x,dy:r.top-y,width:r.width,height:r.height,stroke:Number(p.getAttribute('stroke-width'))};})()`);
    const scaled=(actual,baseline,ratio,keys=Object.keys(baseline))=>{for(const key of keys)assert.ok(Math.abs(actual[key]-baseline[key]*ratio)<.15,`${key}: ${actual[key]} vs ${baseline[key]} × ${ratio}`);};
    const pen18=await draw();assert.equal(pen18.type,'pen');assert.equal(pen18.penBasis.fontSize,18);
    const pin18=pen18.penBasis.textAnchor;assert.equal(pin18.quote,'모');assert.ok(pin18.start>30,'the stroke is attached beyond the first line');
    const smallLegacy=await snapshot('legacy-font-pen','#fixed'),smallPen=await snapshot(pen18.id,'#flow',pin18);
    const sizes=await page.evaluate(`(()=>{const d=${doc};return [d.body.clientHeight,d.querySelector('main').clientHeight,d.querySelector('#flow').clientHeight];})()`);
    await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/font-scaled-pen-18.png'),await page.screenshot());
    await clickNative('#reader-larger');await page.waitFor(`${doc}.querySelector('[data-htmlmemo-id="legacy-font-pen"]').getAttribute('stroke-width')==='6'`);
    scaled(await snapshot('legacy-font-pen','#fixed'),smallLegacy,2,['width','height','stroke']);scaled(await snapshot(pen18.id,'#flow',pin18),smallPen,2);
    const largeSizes=await page.evaluate(`(()=>{const d=${doc};return [d.body.clientHeight,d.querySelector('main').clientHeight,d.querySelector('#flow').clientHeight];})()`);
    assert.deepEqual(largeSizes.slice(0,2),sizes.slice(0,2),'fixed-size body and scroller did not notify ResizeObserver');assert.ok(largeSizes[2]>sizes[2] && Math.abs(largeSizes[2]-sizes[2]*2)>10,'fixed padding and line-height differ from uniform box scaling');
    const pen36=await draw('글자');assert.equal(pen36.penBasis.fontSize,36);const pin36=pen36.penBasis.textAnchor;assert.equal(pin36.quote,'글');const largePen=await snapshot(pen36.id,'#flow',pin36);
    await writeFile(join(root,'test-results/font-scaled-pen-36.png'),await page.screenshot());
    await clickNative('#reader-smaller');await page.waitFor(`${doc}.querySelector('[data-htmlmemo-id="legacy-font-pen"]').getAttribute('stroke-width')==='3'`);
    scaled(await snapshot('legacy-font-pen','#fixed'),smallLegacy,1,['width','height','stroke']);scaled(await snapshot(pen18.id,'#flow',pin18),smallPen,1);scaled(await snapshot(pen36.id,'#flow',pin36),largePen,.5);
    await page.evaluate(`(async()=>{const p=${doc}.querySelector('#flow');p.style.width='330px';p.style.textAlign='center';await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));})()`);
    scaled(await snapshot(pen18.id,'#flow',pin18),smallPen,1);scaled(await snapshot(pen36.id,'#flow',pin36),largePen,.5);
    await writeFile(join(root,'test-results/font-scaled-pen-reflow.png'),await page.screenshot());
    await page.evaluate(`(async()=>{const p=${doc}.querySelector('#flow');p.style.width='';p.style.textAlign='';await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));})()`);
    await page.click('#toolbar [data-action=undo]');await page.waitFor(`${doc}.querySelectorAll('#htmlmemo-annotation-layer [data-htmlmemo-id]').length===2`);
    await page.click('#toolbar [data-action=redo]');await page.waitFor(`${doc}.querySelectorAll('#htmlmemo-annotation-layer [data-htmlmemo-id]').length===3`);
    scaled(await snapshot(pen36.id,'#flow',pin36),largePen,.5);
    await clickNative('#reader-larger');await page.waitFor(`${doc}.querySelector('[data-htmlmemo-id="legacy-font-pen"]').getAttribute('stroke-width')==='6'`);
    await page.waitFor('document.querySelectorAll(".tab-dirty:not([hidden])").length===0');
    const before=await saved();assert.equal(before[0].penBasis.fontSize,18);assert.ok(before[0].penBasis.textAnchor);assert.deepEqual(before[1].points,pen18.points);
    await page.navigate(url);await page.waitFor('!!document.querySelector("[data-open=font-pen-document]")');await page.click('[data-open=font-pen-document]');
    await page.waitFor(`${frame}?.style.visibility==='visible' && ${doc}?.querySelector('[data-htmlmemo-id="legacy-font-pen"]')?.getAttribute('stroke-width')==='6'`);
    scaled(await snapshot('legacy-font-pen','#fixed'),smallLegacy,2,['width','height','stroke']);scaled(await snapshot(pen18.id,'#flow',pin18),smallPen,2);scaled(await snapshot(pen36.id,'#flow',pin36),largePen,1);
    assert.deepEqual(await saved(),before);
    await page.evaluate(`window.showSaveFilePicker=async()=>{const root=await navigator.storage.getDirectory();return root.getFileHandle('font-scaled-pen.html',{create:true});};`);
    await page.click('#save-page');
    await page.waitFor(`(async()=>{try{const root=await navigator.storage.getDirectory();return (await (await root.getFileHandle('font-scaled-pen.html')).getFile()).size>0;}catch{return false;}})()`);
    const exported=await page.evaluate(`(async()=>{const root=await navigator.storage.getDirectory(),html=await (await (await root.getFileHandle('font-scaled-pen.html')).getFile()).text();return JSON.parse(new DOMParser().parseFromString(html,'text/html').getElementById('htmlmemo-data').textContent).annotations;})()`);
    assert.deepEqual(exported,before);
    await page.evaluate(`window.showOpenFilePicker=async()=>{const root=await navigator.storage.getDirectory();return [await root.getFileHandle('font-scaled-pen.html')];};`);
    await clickLibraryImport(page);
    await page.waitFor(`document.querySelectorAll('.tab.document').length===2 && ${frame}?.style.visibility==='visible' && ${doc}?.querySelector('[data-htmlmemo-id="legacy-font-pen"]')?.getAttribute('stroke-width')==='6'`);
    scaled(await snapshot(pen18.id,'#flow',pin18),smallPen,2);scaled(await snapshot(pen36.id,'#flow',pin36),largePen,1);
    await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    await page.waitFor(`${frame}.getBoundingClientRect().width<400`);scaled(await snapshot(pen18.id,'#flow',pin18),smallPen,2);
    await writeFile(join(root,'test-results/font-scaled-pen-mobile.png'),await page.screenshot());assert.deepEqual(chrome.errors,[]);
  }finally{if(chrome)await chrome.close();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});

test('real Chrome: annotation tree follows book TOC, prunes empty branches, remembers disclosure and navigates unopened chapters',{timeout:90000},async()=>{
  await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'htmlmemo-annotation-tree-'));await cp(join(root,'public'),folder,{recursive:true});
  const server=createServer(folder);let chrome;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));chrome=await launchChrome();const page=chrome.page;
    const url=process.env.HTMLMEMO_SIDEBAR_TEST_URL||`http://127.0.0.1:${server.address().port}/`,source=await readFile(join(root,'tests/fixtures/annotation-tree.html'),'utf8');
    await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});await page.navigate(url);await page.waitFor('document.querySelector("#status-left").textContent.includes("개의 문서")');
    await page.evaluate(`(async()=>{
      const {putDocumentRevision}=await import('./src/storage.js'),{parseHTML}=await import('./src/document.js');
      const parsed=parseHTML(${JSON.stringify(source)},{viewport:{width:1100,height:800}},{allowScripts:true});
      const base={color:'#334155',width:3,opacity:1,created:Date.now()},target=section=>({tag:'p',id:'p-'+section,rootId:'reader-content',path:[],quote:'대상 문장 '+section,section});
      parsed.metadata.annotations=[{...base,id:'practice-note',type:'note',text:'실전에서 남긴 메모',anchor:'body',anchorTarget:target('v1:one'),points:[{x:.05,y:.1}]},
        {...base,id:'second-highlight',type:'highlight',textAnchor:{section:'v0:two',quote:'대상 문장 v0:two',start:0,end:12}},
        {...base,id:'intro-note',type:'note',text:'입문에서 남긴 메모',anchor:'body',anchorTarget:target('v0:one'),points:[{x:.05,y:.1}]},
        {...base,id:'intro-pen',type:'pen',anchor:'body',anchorTarget:target('v0:one'),points:[{x:.1,y:.4},{x:.7,y:.6}]}];
      window.treeOriginal=structuredClone(parsed.metadata.annotations);
      await putDocumentRevision({id:'annotation-tree-document',title:'목차별 주석 검증 책',name:'annotation-tree.html',created:Date.now(),modified:Date.now(),html:parsed.html,metadata:parsed.metadata});
    })()`);
    await page.navigate(url);await page.waitFor('!!document.querySelector("[data-open=annotation-tree-document]")');await page.click('[data-open=annotation-tree-document]');
    const frame='document.querySelector(".document-host:not([hidden]) iframe")',doc=frame+'.contentDocument',panel=doc+'.querySelector("[data-htmlmemo-doc-sidebar-ui]")';
    await page.waitFor(`${panel}?.querySelector('[data-sidebar-view=annotations]')&&!${frame}.hasAttribute('aria-hidden')`);
    const clickNative=async selector=>{
      const point=await page.evaluate(`(()=>{const f=${frame},e=f.contentDocument.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),b=f.getBoundingClientRect(),z=b.width/f.clientWidth;return {x:b.left+(r.left+r.width/2)*z,y:b.top+(r.top+r.height/2)*z};})()`);
      await page.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
    };
    const openGroup=async title=>{
      const key=await page.evaluate(`(()=>{const p=${panel},g=[...p.querySelectorAll('[data-annotation-group]')].find(g=>g.querySelector(':scope>summary>.annotation-group-title').textContent===${JSON.stringify(title)});if(!g)throw Error('Missing group');return g.dataset.annotationGroup;})()`);
      const selector='[data-annotation-group='+JSON.stringify(key)+']';
      if(!await page.evaluate(`${doc}.querySelector(${JSON.stringify(selector)}).open`))await clickNative(selector+'>summary');
      await page.waitFor(`${doc}.querySelector(${JSON.stringify(selector)}).open`);return selector;
    };
    await clickNative('[data-sidebar-view=annotations]');
    assert.deepEqual(await page.evaluate(`[...${panel}.querySelectorAll('.annotation-tree>[data-annotation-group]')].map(g=>[g.querySelector('.annotation-group-title').textContent,g.querySelector('.annotation-group-count').textContent,g.open])`),[['입문','3',false],['실전','1',false]]);
    assert.equal(await page.evaluate(`${panel}.textContent.includes('주석 없는')||${panel}.textContent.includes('빈 분류')`),false);
    assert.deepEqual(await page.evaluate(`${frame}.contentWindow.renderedSections`),['v0:one']);
    assert.equal(await page.evaluate(`${doc}.querySelectorAll('#reader-tree details[open]').length`),0);
    const intro=await openGroup('입문');await openGroup('기초');await openGroup('시작');const first=await openGroup('첫 장');
    assert.equal(await page.evaluate(`${doc}.querySelector(${JSON.stringify(first)}).querySelectorAll('[data-annotation]').length`),2);
    await clickNative(first+'>summary');await page.waitFor(`!${doc}.querySelector(${JSON.stringify(first)}).open`);await openGroup('첫 장');
    await clickNative('[data-sidebar-view=search]');await clickNative('[data-sidebar-view=annotations]');
    assert.equal(await page.evaluate(`${doc}.querySelector(${JSON.stringify(first)}).open`),true);
    await openGroup('실전');await openGroup('응용');await openGroup('도구');await openGroup('실전의 장');
    await clickNative('[data-annotation=practice-note]');await page.waitFor(`${doc}.querySelector('#reader-content').dataset.section==='v1:one'&&${doc}.querySelector('[data-htmlmemo-id=practice-note]')&&${doc}.querySelector('#reader-main').scrollTop>500`);
    assert.deepEqual(await page.evaluate(`${frame}.contentWindow.renderedSections`),['v0:one','v1:one']);
    await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/annotation-tree-desktop.png'),await page.screenshot());
    await clickNative('[data-delete-annotation=practice-note]');await page.waitFor(`${panel}.querySelectorAll('.annotation-tree>[data-annotation-group]').length===1`);
    assert.equal(await page.evaluate(`${doc}.querySelector(${JSON.stringify(intro)}).open`),true);
    await page.click('#toolbar [data-action=undo]');await page.waitFor(`${panel}.querySelectorAll('.annotation-tree>[data-annotation-group]').length===2`);
    await openGroup('다음');await openGroup('둘째 장');await clickNative('[data-annotation=second-highlight]');
    await page.waitFor(`${doc}.querySelector('#reader-content').dataset.section==='v0:two'&&${doc}.querySelector('[data-htmlmemo-mark][data-htmlmemo-id=second-highlight]')`);
    await clickNative('[data-delete-annotation=second-highlight]');await page.waitFor(`!${panel}.querySelector('[data-annotation=second-highlight]')`);
    assert.equal(await page.evaluate(`${panel}.textContent.includes('둘째 장')`),false);assert.equal(await page.evaluate(`${panel}.textContent.includes('다음')`),false);
    await page.waitFor('document.querySelectorAll(".tab-dirty:not([hidden])").length===0');
    await page.evaluate(`window.showSaveFilePicker=async()=> (await navigator.storage.getDirectory()).getFileHandle('annotation-tree-export.html',{create:true});`);await page.click('#save-page');
    await page.waitFor(`(async()=>{try{const root=await navigator.storage.getDirectory();return (await(await root.getFileHandle('annotation-tree-export.html')).getFile()).size>0;}catch{return false;}})()`);
    const exported=await page.evaluate(`(async()=>{const root=await navigator.storage.getDirectory(),html=await(await(await root.getFileHandle('annotation-tree-export.html')).getFile()).text(),d=new DOMParser().parseFromString(html,'text/html'),metadata=JSON.parse(d.getElementById('htmlmemo-data').textContent);return {ids:metadata.annotations.map(a=>a.id),ui:!!d.querySelector('[data-annotation-group],[data-htmlmemo-doc-sidebar-ui]'),volumes:[0,1,2].every(i=>!!d.getElementById('book-volume-'+i))};})()`);
    assert.deepEqual(exported,{ids:['practice-note','intro-note','intro-pen'],ui:false,volumes:true});
    await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await writeFile(join(root,'test-results/annotation-tree-mobile.png'),await page.screenshot());
    await page.navigate(url);await page.waitFor('!!document.querySelector("[data-open=annotation-tree-document]")');await page.click('[data-open=annotation-tree-document]');await page.waitFor(`${panel}?.querySelector('[data-sidebar-view=annotations]')&&!${frame}.hasAttribute('aria-hidden')`);
    await clickNative('[data-sidebar-view=annotations]');
    assert.deepEqual(await page.evaluate(`[...${panel}.querySelectorAll('.annotation-tree>[data-annotation-group]')].map(g=>[g.querySelector('.annotation-group-title').textContent,g.querySelector('.annotation-group-count').textContent,g.open])`),[['입문','2',false],['실전','1',false]]);
    assert.deepEqual(chrome.errors,[]);
  }finally{if(chrome)await chrome.close();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});

test('real Chrome: annotation tree keeps the confirmed opening and the deepest known partial location without rewriting notes',{timeout:90000},async()=>{
  await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'htmlmemo-partial-location-'));await cp(join(root,'public'),folder,{recursive:true});
  const server=createServer(folder);let chrome;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));chrome=await launchChrome();const page=chrome.page;
    const url=process.env.HTMLMEMO_SIDEBAR_TEST_URL||`http://127.0.0.1:${server.address().port}/`,quote='첫머리 공통 문장입니다.';
    const manifest={format:'memosuite-book-html-v1',title:'부분 위치 검증 책',volumes:[{label:'입문',sections:[
      {key:'v0:opening',id:'opening',title:'1부 시작',category:'1부 · 준비'},
      {key:'v0:one',id:'one',title:'(1.1) 첫 장',category:'1부 · 준비 › 첫걸음'},
      {key:'v0:two',id:'two',title:'(1.2) 다음 장',category:'1부 · 준비 › 첫걸음'},
      {key:'v0:part2',id:'part2',title:'2부 시작',category:'2부 · 진행'}]},
      {label:'실전',sections:[{key:'v1:opening',id:'opening',title:'실전 시작',category:'1부 · 활용'}]}]};
    const source=(await readFile(join(root,'tests/fixtures/annotation-tree.html'),'utf8'))
      .replace(/(<script id="book-manifest"[^>]*>)[\s\S]*?(<\/script>)/,(_,open,close)=>open+JSON.stringify(manifest)+close)
      .replace("p.textContent='대상 문장 '+section.key","p.textContent="+JSON.stringify(quote));
    await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});await page.navigate(url);await page.waitFor('document.querySelector("#status-left").textContent.includes("개의 문서")');
    await page.evaluate(`(async()=>{const {putDocumentRevision}=await import('./src/storage.js'),{parseHTML}=await import('./src/document.js');
      const parsed=parseHTML(${JSON.stringify(source)},{viewport:{width:1100,height:800}},{allowScripts:true}),base={color:'#334155',width:3,opacity:1,created:Date.now()};
      parsed.metadata.annotations=[{...base,id:'old-note',type:'note',text:'앞부분의 예전 메모',points:[{x:330,y:140}]},
        {...base,id:'old-highlight',type:'highlight',color:'#edcf67',opacity:.35,textAnchor:{quote:${JSON.stringify(quote)},start:0,end:${quote.length}}},
        {...base,id:'exact-note',type:'note',text:'정확한 다음 장 메모',anchor:'body',anchorTarget:{tag:'p',id:'p-v0:two',rootId:'reader-content',path:[],quote:${JSON.stringify(quote)},section:'v0:two'},points:[{x:.05,y:.1}]},
        {...base,id:'partial-note',type:'note',text:'부까지만 확인되는 메모',anchor:'body',anchorTarget:{tag:'p',id:'missing-paragraph',rootId:'reader-content',path:[],quote:'현재 본문에는 없는 문장',section:'v1:removed'},points:[{x:.05,y:.1}]}];
      await putDocumentRevision({id:'partial-location-document',title:'부분 위치 검증 책',name:'partial-location.html',created:Date.now(),modified:Date.now(),html:parsed.html,metadata:parsed.metadata});})()`);
    await page.navigate(url);await page.waitFor('!!document.querySelector("[data-open=partial-location-document]")');await page.click('[data-open=partial-location-document]');
    const frame='document.querySelector(".document-host:not([hidden]) iframe")',doc=frame+'.contentDocument',panel=doc+'.querySelector("[data-htmlmemo-doc-sidebar-ui]")';
    await page.waitFor(`${panel}?.querySelector('[data-sidebar-view=annotations]')&&!${frame}.hasAttribute('aria-hidden')`);
    const original=await page.evaluate(`(async()=>{const {getDocument}=await import('./src/storage.js');return (await getDocument('partial-location-document')).metadata.annotations;})()`);
    const clickNative=async selector=>{
      const point=await page.evaluate(`(()=>{const f=${frame},e=f.contentDocument.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),b=f.getBoundingClientRect(),z=b.width/f.clientWidth;return {x:b.left+(r.left+r.width/2)*z,y:b.top+(r.top+r.height/2)*z};})()`);
      await page.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
    };
    await clickNative('[data-sidebar-view=annotations]');
    const ancestorTitles=id=>page.evaluate(`(()=>{const titles=[];let e=${panel}.querySelector('[data-annotation="'+${JSON.stringify(id)}+'"]');for(e=e.parentElement;e;e=e.parentElement)if(e.matches('details[data-annotation-group]'))titles.unshift(e.querySelector(':scope>summary>.annotation-group-title').textContent);return titles;})()`);
    assert.deepEqual(await ancestorTitles('old-note'),['입문','1부 · 준비','1부 앞부분']);assert.deepEqual(await ancestorTitles('old-highlight'),['입문','1부 · 준비','1부 앞부분']);
    assert.deepEqual(await ancestorTitles('exact-note'),['입문','1부 · 준비','첫걸음','(1.2) 다음 장']);assert.deepEqual(await ancestorTitles('partial-note'),['실전','1부 · 활용','세부 위치 미확인']);
    assert.equal(await page.evaluate(`${panel}.textContent.includes('목차 위치 미확인')`),false);assert.deepEqual(await page.evaluate(`${frame}.contentWindow.renderedSections`),['v0:opening']);
    await revealAnnotation(page,doc,'exact-note');await clickNative('[data-annotation=exact-note]');await page.waitFor(`${doc}.querySelector('#reader-content').dataset.section==='v0:two'&&${doc}.querySelector('[data-htmlmemo-id=exact-note]')`);
    assert.equal(await page.evaluate(`!!${doc}.querySelector('[data-htmlmemo-id=old-highlight],[data-htmlmemo-id=old-note]')`),false,'repeated wording must not repeat the opening annotations in a later chapter');
    assert.deepEqual(await ancestorTitles('old-note'),['입문','1부 · 준비','1부 앞부분']);
    await revealAnnotation(page,doc,'old-note');await clickNative('[data-annotation=old-note]');
    await page.waitFor(`${doc}.querySelector('#reader-content').dataset.section==='v0:opening'&&${doc}.querySelector('[data-htmlmemo-id=old-note]')&&${doc}.querySelector('[data-htmlmemo-id=old-highlight]')&&!document.querySelector('#toast').hidden&&document.querySelector('#toast').textContent.includes('1부 앞부분')`);
    assert.equal(await page.evaluate('document.querySelector("#toast").classList.contains("error")'),false);
    await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/annotation-tree-partial-desktop.png'),await page.screenshot());
    await revealAnnotation(page,doc,'partial-note');await clickNative('[data-annotation=partial-note]');
    await page.waitFor(`${doc}.querySelector('#reader-content').dataset.section==='v1:opening'&&!document.querySelector('#toast').hidden&&document.querySelector('#toast').textContent.includes('1부 · 활용 내')`);
    assert.equal(await page.evaluate(`!!${doc}.querySelector('[data-htmlmemo-id=partial-note],[data-htmlmemo-id=old-note],[data-htmlmemo-id=old-highlight]')`),false);
    await page.waitFor('document.querySelectorAll(".tab-dirty:not([hidden])").length===0');
    assert.deepEqual(await page.evaluate(`(async()=>{const {getDocument}=await import('./src/storage.js');return (await getDocument('partial-location-document')).metadata.annotations;})()`),original);
    await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await writeFile(join(root,'test-results/annotation-tree-partial-mobile.png'),await page.screenshot());
    await page.navigate(url);await page.waitFor('!!document.querySelector("[data-open=partial-location-document]")');await page.click('[data-open=partial-location-document]');await page.waitFor(`${panel}?.querySelector('[data-sidebar-view=annotations]')&&!${frame}.hasAttribute('aria-hidden')`);
    await clickNative('[data-sidebar-view=annotations]');assert.deepEqual(await ancestorTitles('old-note'),['입문','1부 · 준비','1부 앞부분']);assert.deepEqual(chrome.errors,[]);
  }finally{if(chrome)await chrome.close();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});

test('real Chrome: whole-book search shows live results and jumps to highlighted keywords in unopened chapters',{timeout:90000},async()=>{
  await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'htmlmemo-book-search-'));await cp(join(root,'public'),folder,{recursive:true});
  const server=createServer(folder);let chrome;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));chrome=await launchChrome();const page=chrome.page;
    const url=process.env.HTMLMEMO_SIDEBAR_TEST_URL||`http://127.0.0.1:${server.address().port}/`,source=await readFile(join(root,'tests/fixtures/book-search.html'),'utf8');
    await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});await page.navigate(url);await page.waitFor('document.querySelector("#status-left").textContent.includes("개의 문서")');
    await page.evaluate(`(async()=>{const {putDocumentRevision}=await import('./src/storage.js'),{parseHTML}=await import('./src/document.js');const parsed=parseHTML(${JSON.stringify(source)},{},{allowScripts:true});parsed.metadata.annotations=[{id:'search-note',type:'highlight',color:'#edcf67',width:3,opacity:.35,textAnchor:{section:'v1:one',quote:'멀리 있는 본문의 바람을 찾았습니다.',start:0,end:22}}];await putDocumentRevision({id:'whole-book-search',title:'책 전체 검색 검증',name:'book-search.html',created:Date.now(),modified:Date.now(),html:parsed.html,metadata:parsed.metadata});})()`);
    await page.navigate(url);await page.waitFor('!!document.querySelector("[data-open=whole-book-search]")');await page.click('[data-open=whole-book-search]');
    const frame='document.querySelector(".document-host:not([hidden]) iframe")',doc=frame+'.contentDocument';
    await page.waitFor(`${doc}?.querySelector('[data-sidebar-view=search]')&&!${frame}.hasAttribute('aria-hidden')`);
    const clickNative=async selector=>{
      const point=await page.evaluate(`(async()=>{const f=${frame},d=f.contentDocument,el=d.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'nearest'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const b=f.getBoundingClientRect(),r=el.getBoundingClientRect(),s=b.width/f.offsetWidth;return {x:b.left+(r.left+r.width/2)*s,y:b.top+(r.top+r.height/2)*s};})()`);
      await page.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
    };
    const enterQuery=async text=>{await clickNative('#reader-search');await page.evaluate(`${doc}.querySelector('#reader-search').select()`);await page.send('Input.insertText',{text});};
    const activeHit=()=>page.evaluate(`(()=>{const d=${doc},h=d.defaultView.CSS.highlights.get('htmlmemo-book-search'),range=h&&[...h][0];if(!range)return null;const r=range.getBoundingClientRect(),m=d.querySelector('#reader-main').getBoundingClientRect();return {text:range.toString(),visible:r.top>=Math.max(0,m.top)&&r.bottom<=Math.min(m.bottom,d.defaultView.innerHeight),top:r.top,scroll:d.querySelector('#reader-main').scrollTop,status:d.querySelector('.sidebar-book-results [role=status]').textContent};})()`);
    const original=await page.evaluate(`(async()=>{const {getDocument}=await import('./src/storage.js');return (await getDocument('whole-book-search')).metadata.annotations;})()`);
    await mkdir(join(root,'test-results'),{recursive:true});
    for(const width of [1280,390]){
      await page.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<600});
      await clickNative('[data-sidebar-view=search]');await enterQuery('바람');
      await page.waitFor(`${doc}.querySelector('#reader-search-status').textContent==='3개 장 검색됨'&&${doc}.querySelectorAll('.sidebar-book-results #reader-tree a').length===3`);
      assert.equal(await page.evaluate(`${doc}.querySelector('.sidebar-book-results #reader-tree').getBoundingClientRect().height>0`),true);
      assert.equal(await page.evaluate(`[...${doc}.querySelectorAll('.sidebar-book-results details')].every(d=>d.open)`),true);
      if(width===1280){assert.deepEqual(await page.evaluate(`${doc}.defaultView.renderedSections`),['v0:opening']);assert.deepEqual(await page.evaluate(`${doc}.defaultView.decodedVolumes`),[0]);}
      await writeFile(join(root,`test-results/book-search-results-${width}.png`),await page.screenshot());
      await clickNative('.sidebar-book-results a[href="#v1%3Aone"]');
      await page.waitFor(`${doc}.querySelector('#reader-content').dataset.section==='v1:one'&&${doc}.querySelector('.sidebar-book-results [role=status]').textContent==='이 장에서 1 / 2'`);
      let hit=await activeHit();assert.equal(hit.text,'바람');assert.equal(hit.visible,true);assert.ok(hit.scroll>500,'first keyword, not just the chapter heading, is brought into view');
      assert.equal(await page.evaluate(`!!${doc}.querySelector('[data-htmlmemo-id=search-note]')`),true);
      await clickNative('[data-book-search-step="1"]');await page.waitFor(`${doc}.querySelector('.sidebar-book-results [role=status]').textContent==='이 장에서 2 / 2'`);const next=await activeHit();assert.equal(next.visible,true);assert.ok(next.scroll>hit.scroll+500);
      await clickNative('[data-book-search-step="1"]');await page.waitFor(`${doc}.querySelector('.sidebar-book-results [role=status]').textContent==='이 장에서 1 / 2'`);
      await clickNative('[data-book-search-step="-1"]');await page.waitFor(`${doc}.querySelector('.sidebar-book-results [role=status]').textContent==='이 장에서 2 / 2'`);
      await clickNative('.sidebar-book-results a[href="#v0%3Aone"]');await page.waitFor(`${doc}.querySelector('#reader-content').dataset.section==='v0:one'&&${doc}.querySelector('.sidebar-book-results [role=status]').textContent==='이 장에서 1 / 2'`);
      hit=await activeHit();assert.equal(hit.text,'바람');assert.equal(hit.visible,true,'a keyword split across inline nodes is highlighted and centered');
      await writeFile(join(root,`test-results/book-search-keyword-${width}.png`),await page.screenshot());
      await clickNative('[data-sidebar-view=annotations]');assert.equal(await page.evaluate(`${doc}.querySelector('#reader-tree').parentElement.id`),'reader-nav');
      await clickNative('[data-sidebar-view=search]');assert.equal(await page.evaluate(`${doc}.querySelector('#reader-search').value`),'바람');assert.equal(await page.evaluate(`${doc}.querySelectorAll('.sidebar-book-results a').length`),3);
      await clickNative('.sidebar-book-results a[href="#v0%3Atitle"]');await page.waitFor(`${doc}.querySelector('.sidebar-book-results [role=status]').textContent.includes('본문에서 검색어를 찾지 못했습니다')`);
      assert.equal(await page.evaluate(`[...${doc}.querySelectorAll('[data-book-search-step]')].every(b=>b.disabled)`),true);
      await enterQuery('없는키워드');await page.waitFor(`${doc}.querySelector('#reader-search-status').textContent==='0개 장 검색됨'`);assert.equal(await page.evaluate(`${doc}.querySelectorAll('.sidebar-book-results a').length`),0);
      await enterQuery('바람');await page.waitFor(`${doc}.querySelector('#reader-search-status').textContent==='3개 장 검색됨'`);
      await page.evaluate(`${doc}.querySelector('.sidebar-book-results a').focus()`);await page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r',unmodifiedText:'\r'});await page.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await page.waitFor(`${doc}.querySelector('#reader-content').dataset.section==='v0:one'&&${doc}.querySelector('.sidebar-book-results [role=status]').textContent==='이 장에서 1 / 2'`);
      await clickNative('#reader-search-clear');await page.waitFor(`${doc}.querySelector('#reader-search').value===''&&${doc}.querySelector('.sidebar-book-results').hidden`);assert.equal(await page.evaluate(`${doc}.defaultView.CSS.highlights.has('htmlmemo-book-search')`),false);
      await clickNative('[data-sidebar-view=outline]');assert.equal(await page.evaluate(`${doc}.querySelector('#reader-tree').parentElement.id`),'reader-nav');assert.equal(await page.evaluate(`[...${doc}.querySelectorAll('#reader-tree details')].every(d=>!d.open)`),true);
      assert.deepEqual(await page.evaluate(`(async()=>{const {getDocument}=await import('./src/storage.js');return (await getDocument('whole-book-search')).metadata.annotations;})()`),original);
    }
    assert.ok(await page.evaluate(`${doc}.defaultView.nativeResultClicks`)>0,'native delegated result handlers are preserved');assert.deepEqual(await page.evaluate(`${doc}.defaultView.decodedVolumes`),[0,1]);
    await clickNative('[data-sidebar-view=search]');await enterQuery('바람');await page.waitFor(`${doc}.querySelector('#reader-search-status').textContent==='3개 장 검색됨'`);
    await page.evaluate(`window.showSaveFilePicker=async()=>{const root=await navigator.storage.getDirectory();return root.getFileHandle('book-search-export.html',{create:true});}`);await page.click('#save-page');
    await page.waitFor(`(async()=>{try{const root=await navigator.storage.getDirectory();return (await(await root.getFileHandle('book-search-export.html')).getFile()).size>0;}catch{return false;}})()`);
    const exported=await page.evaluate(`(async()=>{const root=await navigator.storage.getDirectory(),html=await(await(await root.getFileHandle('book-search-export.html')).getFile()).text(),d=new DOMParser().parseFromString(html,'text/html');return {runtime:!!d.querySelector('[data-htmlmemo-doc-sidebar-ui],[data-htmlmemo-book-search-part],[data-htmlmemo-book-search-slot],[data-htmlmemo-book-search-open],.sidebar-book-results'),payloads:[0,1].every(i=>!!d.getElementById('book-volume-'+i)),input:!!d.querySelector('#reader-nav>#reader-search'),tree:!!d.querySelector('#reader-nav>#reader-tree'),notes:JSON.parse(d.getElementById('htmlmemo-data').textContent).annotations};})()`);
    assert.deepEqual(exported,{runtime:false,payloads:true,input:true,tree:true,notes:original});assert.deepEqual(chrome.errors,[]);
  }finally{if(chrome)await chrome.close();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});

test('real Chrome: sidebar view choices collapse the TOC only when reselecting the active outline',{timeout:90000},async()=>{
  await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'htmlmemo-toc-reclick-'));await cp(join(root,'public'),folder,{recursive:true});
  const server=createServer(folder);let chrome;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));chrome=await launchChrome();const page=chrome.page,url=process.env.HTMLMEMO_SIDEBAR_TEST_URL||`http://127.0.0.1:${server.address().port}/`;
    const book=await readFile(join(root,'tests/fixtures/book-search.html'),'utf8'),source=book.replace('group.append(heading);','group.open=true;group.append(heading);')
      .replace('group.append(a);count++;',"const nested=document.createElement('details'),label=document.createElement('summary');nested.open=true;label.textContent=section.title+' 하위';nested.append(label,a);group.append(nested);count++;")
      .replace('</nav>','<div class="toc-group"><button id="custom-toggle" class="toc-toggle" aria-controls="custom-items" aria-expanded="true">▼ 부록</button><ul id="custom-items"><li><a href="#v0%3Aone">부록 링크</a></li></ul></div></nav>')
      .replace('<div id="reader-status">','<details id="body-disclosure" open><summary>본문 설명</summary><p>본문 설명은 접지 않습니다.</p></details><div id="reader-status">');
    await page.navigate(url);await page.waitFor('document.querySelector("#status-left").textContent.includes("개의 문서")');
    await page.evaluate(`(()=>{const files=new DataTransfer();files.items.add(new File([${JSON.stringify(source)}],'toc-reclick.html',{type:'text/html'}));const input=document.querySelector('#file-input');input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    const frame='document.querySelector(".document-host:not([hidden]) iframe")',doc=frame+'.contentDocument',tree=doc+`.querySelector('#reader-tree')`;
    await page.waitFor(`${frame}?.style.visibility==='visible'&&${doc}.querySelector('[data-sidebar-view=outline]')&&${tree}.querySelectorAll('details').length===6&&!document.querySelector('.tab-dirty:not([hidden])')`);
    const savedState=`(async()=>{const {listDocuments,getDocument}=await import('./src/storage.js'),row=(await listDocuments()).find(r=>r.name==='toc-reclick.html');if(!row)return null;const r=await getDocument(row.id);return {html:r.file?await r.file.text():r.html,annotations:r.metadata.annotations,bookmarks:r.metadata.bookmarks};})()`;
    await page.waitFor(savedState);const before=await page.evaluate(savedState);await page.evaluate(`window.tocReselectTree=${tree}`);
    const click=async selector=>{
      const point=await page.evaluate(`(async()=>{const f=${frame},el=f.contentDocument.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'nearest'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const b=f.getBoundingClientRect(),r=el.getBoundingClientRect(),scale=b.width/f.offsetWidth;return{x:b.left+(r.left+r.width/2)*scale,y:b.top+(r.top+r.height/2)*scale};})()`);
      await page.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
    };
    const choose=async mode=>{await click(`[data-sidebar-view=${mode}]`);await page.waitFor(`${doc}.querySelector('#reader-nav').dataset.htmlmemoSidebarView===${JSON.stringify(mode)}`);};
    const expansion=()=>page.evaluate(`[...${tree}.querySelectorAll('details')].map(g=>g.open)`),metrics=[];
    for(const width of [1280,390,320]){
      await page.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<600});
      if(await page.evaluate(`${doc}.querySelector('#reader-search').value!==''`)){
        await page.evaluate(`${doc}.querySelector('#reader-search').value='';${doc}.querySelector('#reader-search').dispatchEvent(new Event('input',{bubbles:true}))`);await page.waitFor(`${doc}.querySelector('#reader-search-status').textContent===''&&${tree}.querySelectorAll('details').length===6`);
      }
      await page.evaluate(`[...${tree}.querySelectorAll('details')].forEach(g=>g.open=true)`);if(await page.evaluate(`${doc}.querySelector('#custom-items').hidden`))await click('#custom-toggle');
      assert.ok((await expansion()).every(Boolean));await choose('search');assert.ok((await expansion()).every(Boolean));
      await click('#reader-search');await page.send('Input.insertText',{text:'바람'});await page.waitFor(`${doc}.querySelector('#reader-search-status').textContent==='3개 장 검색됨'`);
      await choose('outline');assert.ok((await expansion()).every(Boolean));assert.equal(await page.evaluate(`${tree}.parentElement.id`),'reader-nav');
      for(const mode of ['annotations','bookmarks']){await choose(mode);await choose('outline');assert.ok((await expansion()).every(Boolean),mode);}
      await choose('outline');assert.ok((await expansion()).every(open=>!open));assert.equal(await page.evaluate(`${doc}.querySelector('#custom-items').hidden`),true);assert.equal(await page.evaluate(`${doc}.querySelector('#body-disclosure').open`),true);
      assert.equal(await page.evaluate(`${tree}===window.tocReselectTree`),true);assert.equal(await page.evaluate(`${doc}.querySelector('#reader-search').value`),'바람');
      await choose('outline');assert.ok((await expansion()).every(open=>!open));
      await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,`test-results/sidebar-views-collapse-${width}.png`),await page.screenshot());
      await click('#reader-tree > details:first-child > summary');assert.equal(await page.evaluate(`${tree}.querySelector('details').open`),true);assert.equal(await page.evaluate(`${tree}.querySelector('details details').open`),false);
      await click('#custom-toggle');assert.equal(await page.evaluate(`${doc}.querySelector('#custom-items').hidden`),false);assert.equal(await page.evaluate(`${doc}.querySelector('#custom-toggle').getAttribute('aria-expanded')`),'true');
      await click('#reader-tree > details:first-child details > summary');const section=await page.evaluate(`${tree}.querySelector('a').getAttribute('href').slice(1)`);await click('#reader-tree a');await page.waitFor(`${doc}.querySelector('#reader-content').dataset.section===decodeURIComponent(${JSON.stringify(section)})`);
      assert.equal(await page.evaluate(`${tree}.querySelector('details').open`),true);assert.deepEqual(await page.evaluate(savedState),before);
      metrics.push({width,otherViewsPreserveExpansion:true,activeOutlineCollapsesAllLevels:true,repeatedCollapseIsIdempotent:true,customGroupsCollapsedAndReopen:true,bodyDisclosureUnchanged:true,sourceTreeAndSearchDraftPreserved:true,chapterLinksStillWork:true,savedHTMLAndNotesUnchanged:true});
    }
    await writeFile(join(root,'test-results/sidebar-views-collapse-results.json'),JSON.stringify(metrics,null,2));assert.deepEqual(chrome.errors,[]);
  }catch(error){
    if(chrome)try{await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/sidebar-views-collapse-failure.png'),await chrome.page.screenshot());}catch{}
    throw error;
  }finally{await chrome?.close();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});

test('real Chrome: native sidebar view choices are visible on open and preserve the original book tree and export',{timeout:60000},async()=>{
  await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'htmlmemo-native-sidebar-'));await cp(join(root,'public'),folder,{recursive:true});
  const server=createServer(folder);let chrome;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));chrome=await launchChrome();const page=chrome.page;
    const url=process.env.HTMLMEMO_SIDEBAR_TEST_URL||`http://127.0.0.1:${server.address().port}/`,book=await readFile(join(root,'tests/fixtures/book.html'),'utf8');
    // Model the source book's real drawer rule: the menu is useful below 761px,
    // but hidden on wider document viewports. Reader must not force it visible.
    const source=book.replace('</style>','.reader-head{display:flex;align-items:center;gap:8px;height:44px;flex:none}body{display:flex;flex-direction:column}.layout{flex:1;height:auto;min-height:0}.nav-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:.6rem}#reader-close{display:none}@media(min-width:761px){#reader-menu{display:none}}@media(max-width:760px){.layout{grid-template-columns:minmax(0,1fr)}#reader-nav{display:none;position:fixed;top:24px;bottom:0;left:0;z-index:6;background:white}body.toc-open #reader-nav{display:block}#reader-close{display:block}}</style>')
      .replace('<body>','<body><header class="reader-head"><button id="reader-menu" aria-controls="reader-nav" aria-expanded="false" title="목차">☰</button><span class="reader-title">검증용 책</span></header><script>{const menu=document.getElementById("reader-menu");menu.addEventListener("click",()=>menu.setAttribute("aria-expanded",String(document.body.classList.toggle("toc-open"))));}</script>')
      .replace('</style>','#book-search-ui{font-size:22px;margin:11px 0 17px;padding:9px;border-bottom:2px solid red}#book-search{font:20px/2 serif;width:85%;height:65px;min-height:60px;margin:7px;padding:13px;border-width:3px}</style>')
      .replace('<h2>목차</h2>','<div class="nav-head"><strong>목차</strong><button id="reader-close" onclick="document.body.classList.remove(\'toc-open\');document.getElementById(\'reader-menu\').setAttribute(\'aria-expanded\',\'false\')">×</button></div><form id="book-search-ui" onsubmit="event.preventDefault()"><input id="book-search" placeholder="책 전체 검색" style="height:70px;font-size:24px;padding:16px" oninput="document.getElementById(\'book-search-results\').textContent=this.value?\'전체 검색: \'+this.value:\'\';document.getElementById(\'book-search-clear\').hidden=!this.value"><button type="button" id="book-search-clear" hidden onclick="document.getElementById(\'book-search\').value=\'\';document.getElementById(\'book-search-results\').textContent=\'\';this.hidden=true">지우기</button><div id="book-search-results"></div></form>');
    await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});await page.navigate(url);
    await page.waitFor('document.querySelector("#status-left").textContent.includes("개의 문서")');
    await page.evaluate(`(async()=>{const {putDocumentRevision}=await import('./src/storage.js'),{parseHTML}=await import('./src/document.js');const parsed=parseHTML(${JSON.stringify(source)},{title:'원본 목차 검증'},{allowScripts:true});parsed.metadata.annotations=[{id:'native-note',type:'note',text:'책의 메모',color:'#334155',width:3,opacity:1,points:[{x:30,y:120}]}];await putDocumentRevision({id:'native-sidebar-document',title:'원본 목차 검증',name:'native-book.html',created:Date.now(),modified:Date.now(),html:parsed.html,metadata:parsed.metadata});const narrow=structuredClone(parsed.metadata);narrow.viewport.width=720;await putDocumentRevision({id:'native-narrow-sidebar-document',title:'좁은 목차 검증',name:'narrow-book.html',created:Date.now(),modified:Date.now(),html:parsed.html,metadata:narrow});})()`);
    await page.navigate(url);await page.waitFor('!!document.querySelector("[data-open=native-sidebar-document]")');await page.click('[data-open=native-sidebar-document]');
    const frame='document.querySelector(".document-host:not([hidden]) iframe")',doc=frame+'.contentDocument';
    await page.waitFor(`${doc}?.querySelectorAll('[data-htmlmemo-doc-sidebar-ui] [data-sidebar-view]').length===4&&!${frame}.hasAttribute('aria-hidden')`);
    assert.equal(await page.evaluate('document.querySelector("#sidebar").hidden'),true);
    assert.deepEqual(await page.evaluate(`[...${doc}.querySelectorAll('[data-htmlmemo-doc-sidebar-ui] [data-sidebar-view]')].map(button=>button.textContent)`),['','','1','0']);
    assert.deepEqual(await page.evaluate(`[...${doc}.querySelectorAll('[data-htmlmemo-doc-sidebar-ui] [data-sidebar-view]')].map(button=>button.getAttribute('aria-label'))`),['목차','검색','주석 · 전체 1개','북마크 · 전체 0개']);
    assert.equal(await page.evaluate(`${doc}.defaultView.getComputedStyle(${doc}.querySelector('[data-htmlmemo-redundant-toc-title]')).display`),'none');
    assert.equal(await page.evaluate(`${doc}.querySelector('[data-htmlmemo-redundant-toc-title]')===${doc}.querySelector('#reader-nav>.nav-head>strong')`),true);
    assert.equal(await page.evaluate(`${doc}.querySelector('#reader-nav>.nav-head>strong').getBoundingClientRect().height`),0);
    assert.equal(await page.evaluate(`${doc}.defaultView.getComputedStyle(${doc}.querySelector('#reader-menu')).display`),'none');
    assert.equal(await page.evaluate(`${doc}.querySelector('#book-search').getBoundingClientRect().height`),0);
    await page.evaluate(`window.nativeSidebarTree=${doc}.querySelector('#reader-tree');window.nativeBookSearch=${doc}.querySelector('#book-search');window.nativeSidebarDblClicks=0;${doc}.addEventListener('dblclick',()=>window.nativeSidebarDblClicks++,true);`);
    const clickNative=async(selector,double=false,blank=false)=>{
      await page.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      const point=await page.evaluate(`(()=>{const frame=${frame},d=frame.contentDocument,element=d.querySelector(${JSON.stringify(selector)});element.scrollIntoView({block:'nearest'});const f=frame.getBoundingClientRect(),r=element.getBoundingClientRect(),scale=f.width/frame.clientWidth;let x=r.left+r.width/2,y=r.top+r.height/2;if(${blank}){x=r.left+20;for(y=Math.min(r.bottom,frame.clientHeight)-16;y>Math.max(0,r.top)+16;y-=8)if(d.elementFromPoint(x,y)===element)break;if(d.elementFromPoint(x,y)!==element)throw Error('No visible sidebar blank space');}return {x:f.left+x*scale,y:f.top+y*scale};})()`);
      for(const clickCount of double?[1,2]:[1]){await page.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount});await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount});}
    };
    const doubleClickNative=async(selector,blank=false)=>{const before=await page.evaluate('window.nativeSidebarDblClicks');await clickNative(selector,true,blank);await page.waitFor(`window.nativeSidebarDblClicks===${before+1}`);};
    // At 390px a view tap right after typing a search is occasionally ignored (seen before the
    // annotation list changes too); a reader taps again, so the check does the same, up to 3 times.
    const chooseNative=async view=>{
      for(let attempt=0;attempt<3;attempt++){
        await clickNative(`[data-sidebar-view=${view}]`);
        try{await page.waitFor(`${doc}.querySelector('#reader-nav').dataset.htmlmemoSidebarView===${JSON.stringify(view)}`,2000);return;}catch(error){if(attempt===2)throw error;}
      }
    };
    for(const width of [1280,390]){
      await page.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<600});
      if(width===390){await clickAppMenu(page,'#settings-button');await page.evaluate(`(()=>{const n=document.querySelector('#appearance');n.value='dark';n.dispatchEvent(new Event('change',{bubbles:true}));})()`);await page.click('#dialog [data-dialog-close]');}
      const compact=await page.evaluate(`(()=>{const d=${doc},sidebar=d.querySelector('[data-htmlmemo-native-sidebar]'),panel=d.querySelector('[data-htmlmemo-doc-sidebar-ui]'),row=panel.querySelector('.sidebar-views');sidebar.scrollTop=0;const r=row.getBoundingClientRect(),s=sidebar.getBoundingClientRect(),style=d.defaultView.getComputedStyle(sidebar);return {height:r.height,buttons:[...row.querySelectorAll('button')].map(b=>b.getBoundingClientRect().height),topGap:r.top-s.top-parseFloat(style.borderTopWidth),sidebarPadding:style.paddingTop,rowPadding:d.defaultView.getComputedStyle(row).paddingTop};})()`);
      assert.equal(compact.height,25);assert.deepEqual(compact.buttons,[24,24,24,24]);assert.equal(compact.topGap,0);assert.equal(compact.sidebarPadding,'0px');assert.equal(compact.rowPadding,'0px');
      assert.equal(await page.evaluate(`(()=>{const buttons=[...${doc}.querySelectorAll('[data-htmlmemo-doc-sidebar-ui] [data-sidebar-view]')];return buttons.every(button=>button.title&&button.querySelector('svg')&&/^\\d*$/.test(button.textContent))&&Math.max(...buttons.map(button=>button.getBoundingClientRect().top))-Math.min(...buttons.map(button=>button.getBoundingClientRect().top))<1;})()`),true);
      await page.click('[data-action=more]');
      assert.deepEqual(await page.evaluate('[...document.querySelectorAll("[data-more]")].map(b=>b.dataset.more)'),['rect','ellipse','arrow','strike','history','migrate','info']);
      await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,`test-results/sidebar-views-tools-native-${width}.png`),await page.screenshot());
      await page.click('[data-popover-close]');await page.click('#app-menu-button');
      const topLabels=await page.evaluate('[...document.querySelectorAll("#app-menu button")].map(b=>b.textContent.trim())');
      for(const duplicate of ['검색','목차 · 북마크','주석','실행 취소','다시 실행','현재 위치 북마크','HTML 내보내기','사각형','주석 저장 이력'])assert.equal(topLabels.includes(duplicate),false);
      await page.click('#app-menu-button');
      await chooseNative('search');
      assert.equal(await page.evaluate(`${doc}.querySelector('#htmlmemo-native-document-search').placeholder`),'불러온 부분에서 찾기');
      assert.equal(await page.evaluate(`${doc}.querySelector('#book-search')===window.nativeBookSearch`),true);
      assert.equal(await page.evaluate(`${doc}.querySelector('#book-search').getBoundingClientRect().bottom<${doc}.querySelector('#htmlmemo-native-document-search').getBoundingClientRect().top`),true);
      const fields=await page.evaluate(`(()=>{const d=${doc},upper=d.querySelector('#book-search'),lower=d.querySelector('#htmlmemo-native-document-search'),content=d.querySelector('[data-htmlmemo-doc-sidebar-ui] .sidebar-content'),host=d.querySelector('[data-htmlmemo-book-search]'),props=['fontFamily','fontSize','fontWeight','lineHeight','letterSpacing','paddingTop','paddingRight','paddingBottom','paddingLeft','borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth','borderRadius','boxSizing'],metrics=e=>{const s=d.defaultView.getComputedStyle(e),r=e.getBoundingClientRect();return {styles:props.map(p=>s[p]),width:r.width,height:r.height,left:r.left};},a=upper.getBoundingClientRect(),b=lower.getBoundingClientRect();return {upper:metrics(upper),lower:metrics(lower),topGap:a.top-content.getBoundingClientRect().top,betweenGap:b.top-a.bottom,separator:[host,d.querySelector('#book-search-ui')].map(e=>d.defaultView.getComputedStyle(e).borderBottomWidth)};})()`);
      assert.deepEqual(fields.upper,fields.lower,'both fields use the lower field metrics despite source ID styles');assert.equal(fields.upper.styles[1],'12px');
      assert.equal(fields.topGap,10);assert.equal(fields.betweenGap,fields.topGap);assert.deepEqual(fields.separator,['0px','0px']);
      await doubleClickNative('#htmlmemo-native-search-count');assert.equal(await page.evaluate('document.querySelector("#app").classList.contains("reader-focus")'),false);
      await writeFile(join(root,`test-results/sidebar-views-search-empty-native-${width}.png`),await page.screenshot());
      await clickNative('#book-search');await page.evaluate(`${doc}.querySelector('#book-search').select()`);await page.send('Input.insertText',{text:'용어 전체'});
      await page.waitFor(`${doc}.querySelector('#book-search-results').textContent==='전체 검색: 용어 전체'`);
      await clickNative('#htmlmemo-native-document-search');
      await page.evaluate(`${doc}.querySelector('#htmlmemo-native-document-search').select()`);
      await page.send('Input.insertText',{text:'Introduction'});await page.waitFor(`${doc}.querySelectorAll('[data-search-index]').length===6`);
      await verifyLoadedSearchEnds(page,doc,'htmlmemo-native-',6,clickNative,'native-'+width);
      await writeFile(join(root,`test-results/sidebar-views-search-native-${width}.png`),await page.screenshot());
      assert.equal(await page.evaluate(`${doc}.defaultView.getComputedStyle(${doc}.querySelector('#reader-tree')).display`),'block');
      await chooseNative('annotations');assert.equal(await page.evaluate(`${doc}.querySelector('[data-annotation=native-note] .annotation-main').textContent`),'책의 메모');await revealAnnotation(page,doc,'native-note');await clickNative('[data-annotation=native-note]');
      await chooseNative('search');assert.equal(await page.evaluate(`${doc}.querySelector('#htmlmemo-native-document-search').value`),'Introduction');assert.equal(await page.evaluate(`${doc}.querySelector('#book-search').value`),'용어 전체');
      await clickNative('#book-search-clear');assert.equal(await page.evaluate(`${doc}.querySelector('#book-search').value`),'');
      await chooseNative('outline');assert.equal(await page.evaluate(`${doc}.querySelector('#reader-tree')===window.nativeSidebarTree`),true);
      assert.notEqual(await page.evaluate(`${doc}.defaultView.getComputedStyle(${doc}.querySelector('#reader-tree')).display`),'none');
      assert.equal(await page.evaluate(`${doc}.defaultView.getComputedStyle(${doc}.querySelector('[data-htmlmemo-redundant-toc-title]')).display`),'none');
      assert.equal(await page.evaluate(`${doc}.querySelectorAll('[data-htmlmemo-doc-sidebar-ui]').length`),1);
      const groupOpen=await page.evaluate(`${doc}.querySelector('#reader-tree details').open`);
      for(const focused of [false,true]){
        if(focused){await doubleClickNative('#reader-main',true);await page.waitFor('document.querySelector("#app").classList.contains("reader-focus")');}
        await doubleClickNative('#reader-nav',true);assert.equal(await page.evaluate('document.querySelector("#app").classList.contains("reader-focus")'),focused);
        await doubleClickNative('#reader-tree details:first-child summary');assert.equal(await page.evaluate('document.querySelector("#app").classList.contains("reader-focus")'),focused);
        assert.equal(await page.evaluate(`${doc}.querySelector('#reader-tree details').open`),groupOpen,'native TOC disclosure still handles both clicks');
      }
      await doubleClickNative('#reader-main',true);await page.waitFor('!document.querySelector("#app").classList.contains("reader-focus")&&!document.fullscreenElement');
      await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,`test-results/sidebar-views-native-${width}.png`),await page.screenshot());
    }
    await clickNative('[data-sidebar-view=bookmarks]');await clickNative('#htmlmemo-native-add-bookmark');
    await page.waitFor('document.querySelector("#dialog").open&&document.querySelector("#note-text")');
    await page.evaluate('document.querySelector("#note-text").value="목차에서 남긴 북마크"');await page.click('#dialog button[value=save]');
    await page.waitFor(`${doc}.querySelectorAll('[data-bookmark]').length===1&&document.querySelector('#status-left').textContent.includes('자동 저장됨')`);
    assert.equal(await page.evaluate(`${doc}.querySelector('[data-sidebar-count=bookmarks]').textContent`),'1');assert.equal(await page.evaluate('document.querySelector("#sidebar").hidden'),true);
    await writeFile(join(root,'test-results/sidebar-views-bookmarks-native.png'),await page.screenshot());
    await clickNative('[data-delete-bookmark]');await page.waitFor(`${doc}.querySelectorAll('[data-bookmark]').length===0`);assert.equal(await page.evaluate(`${doc}.querySelector('[data-sidebar-count=bookmarks]').textContent`),'0');await clickNative('[data-sidebar-view=outline]');
    await clickNative('#reader-tree details:last-child summary');await page.waitFor(`${doc}.querySelector('#reader-tree details:last-child a')`);
    await clickNative('#reader-tree details:last-child a:last-child');await page.waitFor(`${doc}.querySelector('#reader-content').dataset.section==='v2:last'`);
    await clickNative('[data-sidebar-view=annotations]');await revealAnnotation(page,doc,'native-note');await clickNative('[data-delete-annotation=native-note]');
    await page.waitFor(`${doc}.querySelector('.panel-empty')?.textContent.includes('아직 주석')`);
    assert.equal(await page.evaluate(`${doc}.querySelector('[data-sidebar-count=annotations]').textContent`),'0');
    await page.evaluate(`window.showSaveFilePicker=async()=> (await navigator.storage.getDirectory()).getFileHandle('native-sidebar-export.html',{create:true});`);await page.click('#save-page');
    const exported=await page.evaluate(`(async()=>{const root=await navigator.storage.getDirectory();let file;for(let i=0;i<50;i++){try{file=await(await root.getFileHandle('native-sidebar-export.html')).getFile();if(file.size)break;}catch{}await new Promise(resolve=>setTimeout(resolve,50));}const html=await file.text(),doc=new DOMParser().parseFromString(html,'text/html');return {runtime:!!doc.querySelector('[data-htmlmemo-doc-sidebar-ui],[data-htmlmemo-native-sidebar],[data-htmlmemo-sidebar-view],[data-htmlmemo-redundant-toc-title],[data-htmlmemo-book-search],[data-htmlmemo-book-search-part],[data-htmlmemo-book-search-slot],#htmlmemo-doc-sidebar-style'),volumes:[0,1,2].every(i=>!!doc.getElementById('book-volume-'+i)),notes:JSON.parse(doc.getElementById('htmlmemo-data').textContent).annotations.length,title:doc.querySelector('#reader-nav>.nav-head>strong').textContent,menu:!!doc.getElementById('reader-menu'),close:!!doc.getElementById('reader-close'),search:doc.querySelector('#reader-nav>form')?.id,searchBeforeTree:doc.querySelector('#book-search-ui')?.nextElementSibling?.id,searchHandler:!!doc.querySelector('#book-search')?.getAttribute('oninput')};})()`);
    assert.deepEqual(exported,{runtime:false,volumes:true,notes:0,title:'목차',menu:true,close:true,search:'book-search-ui',searchBeforeTree:'reader-tree',searchHandler:true});assert.equal(await page.evaluate('document.querySelector("#sidebar").hidden'),true);
    await page.click('#library-tab');await page.waitFor('!!document.querySelector("[data-open=native-narrow-sidebar-document]")');await page.click('[data-open=native-narrow-sidebar-document]');
    await page.waitFor(`${doc}?.defaultView.innerWidth===720&&!${frame}.hasAttribute('aria-hidden')`);
    assert.notEqual(await page.evaluate(`${doc}.defaultView.getComputedStyle(${doc}.querySelector('#reader-menu')).display`),'none');
    assert.equal(await page.evaluate(`${doc}.defaultView.getComputedStyle(${doc}.querySelector('#reader-nav')).display`),'none');
    await clickNative('#reader-menu');await page.waitFor(`${doc}.querySelector('#reader-menu').getAttribute('aria-expanded')==='true'`);
    assert.notEqual(await page.evaluate(`${doc}.defaultView.getComputedStyle(${doc}.querySelector('#reader-nav')).display`),'none');
    assert.equal(await page.evaluate(`${doc}.defaultView.getComputedStyle(${doc}.querySelector('[data-htmlmemo-redundant-toc-title]')).display`),'none');
    assert.notEqual(await page.evaluate(`${doc}.defaultView.getComputedStyle(${doc}.querySelector('#reader-close')).display`),'none');
    await writeFile(join(root,'test-results/sidebar-views-controls-narrow.png'),await page.screenshot());
    await clickNative('#reader-close');await page.waitFor(`${doc}.defaultView.getComputedStyle(${doc}.querySelector('#reader-nav')).display==='none'`);
    await clickNative('#reader-menu');await page.waitFor(`${doc}.querySelector('#reader-menu').getAttribute('aria-expanded')==='true'`);
    await clickNative('#reader-menu');await page.waitFor(`${doc}.defaultView.getComputedStyle(${doc}.querySelector('#reader-nav')).display==='none'`);
    assert.deepEqual(chrome.errors,[]);
  }finally{if(chrome)await chrome.close();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});

test('real Chrome: long-document search index is lazy, reused, mutation-aware and responsive',{timeout:120000},async()=>{
  await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'htmlmemo-search-index-'));await cp(join(root,'public'),folder,{recursive:true});
  const server=createServer(folder);let chrome;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));chrome=await launchChrome();const page=chrome.page;
    const url=process.env.HTMLMEMO_SIDEBAR_TEST_URL||`http://127.0.0.1:${server.address().port}/`,frame='document.querySelector(".document-host:not([hidden]) iframe")',doc=frame+'.contentDocument';
    await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});await page.navigate(url);await page.waitFor('document.querySelector("#status-left").textContent.includes("개의 문서")');
    await page.evaluate(`(()=>{const chunk='Long document content for indexed literal search. '.repeat(16),rows=Array.from({length:12000},(_,i)=>'<p>'+i+' '+chunk+'</p>').join(''),html='<html lang="ko"><head><title>긴 문서 검색 검증</title><style>body{margin:0;font:16px/1.7 sans-serif}main{padding:24px}p{margin:8px 0}</style></head><body><main><p id="first">First cache-needle. 한글 검색. cross<em>node</em>. special[x].</p>'+rows+'<p id="last">Last cache-needle.</p><p id="unicode">İ then unicode-tail.</p></main></body></html>',file=new File([html],'long-search.html',{type:'text/html'}),transfer=new DataTransfer();window.searchFixtureBytes=file.size;transfer.items.add(file);document.querySelector('#file-input').files=transfer.files;document.querySelector('#file-input').dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await page.waitFor(`${frame}?.style.visibility==='visible'&&!document.querySelector('.tab-dirty:not([hidden])')&&!document.querySelector('#sidebar').hidden`,60000);
    await page.waitFor('document.querySelector("#status-left").textContent.includes("자동 저장됨")');
    await page.evaluate(`(async()=>{const d=${doc},{SearchIndexCache}=await import('./src/search-index.js'),original=SearchIndexCache.prototype.query,walker=d.createTreeWalker.bind(d),normalize=d.body.normalize.bind(d.body);window.searchMetrics={bytes:window.searchFixtureBytes,walks:0,normalizations:0,indexTicks:0,firstBuildMs:null,lookups:[]};window.searchHeartbeat=setInterval(()=>{if(window.searchIndexWalking)window.searchMetrics.indexTicks++;},0);d.createTreeWalker=function(...args){const w=walker(...args);if(args[0]!==d.body)return w;const pass=++window.searchMetrics.walks,start=performance.now();window.searchIndexWalking=true;const next=w.nextNode.bind(w);w.nextNode=()=>{const value=next();if(!value){window.searchIndexWalking=false;if(pass===1)window.searchMetrics.firstBuildMs=performance.now()-start;}return value;};return w;};d.body.normalize=()=>{window.searchMetrics.normalizations++;return normalize();};SearchIndexCache.prototype.query=function(...args){const start=performance.now(),result=original.apply(this,args);if(this.doc===d){window.searchTestCache=this;window.searchMetrics.lookups.push({query:args[0],ms:performance.now()-start});}return result;};const {listDocuments,getDocument}=await import('./src/storage.js'),record=await getDocument((await listDocuments())[0].id);window.searchOriginal={id:record.id,html:record.file?await record.file.text():record.html,annotations:record.metadata.annotations,bookmarks:record.metadata.bookmarks};})()`);
    assert.equal(await page.evaluate('window.searchMetrics.walks'),0,'opening a note-free long file does not eagerly build its text index');
    const search=async(query,total)=>{
      await page.evaluate(`(()=>{window.searchLookupStart=window.searchMetrics.lookups.length;const input=document.querySelector('#document-search');input.value=${JSON.stringify(query)};input.dispatchEvent(new Event('input'));})()`);
      await page.waitFor(`window.searchMetrics.lookups.length>window.searchLookupStart&&window.searchMetrics.lookups.at(-1).query===${JSON.stringify(query)}&&document.querySelector('#search-count').textContent===${JSON.stringify(total?'1 / '+total+'개 결과':'검색 결과가 없습니다.')}&&[...${doc}.querySelectorAll('[data-htmlmemo-search]')].map(mark=>mark.textContent).join('')===${JSON.stringify(total?query:'')}`,30000);
    };
    await search('cache-needle',2);assert.equal(await page.evaluate('window.searchMetrics.walks'),1);await verifyLoadedSearchEnds(page,'document','',2,selector=>page.click(selector),'index-1280');
    for(const [query,total] of [['crossnode',1],['special[x]',1],['한글 검색',1],['unicode-tail',1],['missing-token',0],['cache-needle',2]])await search(query,total);
    assert.equal(await page.evaluate('window.searchMetrics.walks'),1,'different queries and all hit navigation reuse the first DOM index');assert.equal(await page.evaluate('window.searchMetrics.normalizations'),0);
    await page.click('#close-sidebar');await page.click('[data-action=more]');await page.click('[data-more=sidebar]');await page.waitFor('document.querySelector("#document-search").value===""');await search('cache-needle',2);assert.equal(await page.evaluate('window.searchMetrics.walks'),1,'closing the panel clears its draft, not its reusable document index');
    for(const width of [1280,390,320]){
      await page.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<600});await search('cache-needle',2);
      await page.click('#search-next');assert.equal(await page.evaluate(`${doc}.querySelector('[data-htmlmemo-search]').textContent`),'cache-needle');await page.click('#search-prev');
      await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,`test-results/search-index-${width}.png`),await page.screenshot());
    }
    assert.equal(await page.evaluate('window.searchMetrics.walks'),1);assert.equal(await page.evaluate('window.searchMetrics.normalizations'),0);
    const mutation=await page.evaluate(`(()=>{const cache=window.searchTestCache,d=${doc},before=window.searchMetrics.walks;d.querySelector('#last').textContent='updated-new-token';const matches=cache.query('updated-new-token').results;return {walks:window.searchMetrics.walks-before,count:matches.length,old:cache.query('cache-needle').results.length};})()`);
    assert.deepEqual(mutation,{walks:1,count:1,old:1},'takeRecords catches source changes even before the observer callback runs');await search('updated-new-token',1);assert.equal(await page.evaluate(`${doc}.querySelector('[data-htmlmemo-search]').textContent`),'updated-new-token');
    const performanceResult=await page.evaluate(`(async()=>{
      const d=${doc},{textIndex}=await import('./src/document.js'),cache=window.searchTestCache,queries=['cache-needle','crossnode','special[x]','missing-token'],measurements=[];
      for(const query of queries){const start=performance.now(),index=textIndex(d),text=index.text.toLocaleLowerCase(),needle=query.toLocaleLowerCase(),expected=[];let found=text.indexOf(needle);while(found!==-1&&expected.length<3000){expected.push({start:found,end:found+query.length});found=text.indexOf(needle,found+Math.max(1,needle.length));}const oldMs=performance.now()-start,next=performance.now(),actual=cache.query(query).results.map(({start,end})=>({start,end}));measurements.push({query,legacyOnePassMs:oldMs,cachedMs:performance.now()-next,same:JSON.stringify(actual)===JSON.stringify(expected)});}
      clearInterval(window.searchHeartbeat);const {getDocument}=await import('./src/storage.js'),record=await getDocument(window.searchOriginal.id);return {...window.searchMetrics,measurements,preserved:(record.file?await record.file.text():record.html)===window.searchOriginal.html&&JSON.stringify(record.metadata.annotations)===JSON.stringify(window.searchOriginal.annotations)&&JSON.stringify(record.metadata.bookmarks)===JSON.stringify(window.searchOriginal.bookmarks),boundedQueries:cache.entry(d.body).results.size};
    })()`);
    assert.ok(performanceResult.bytes>8*1024*1024);assert.ok(performanceResult.measurements.every(result=>result.same));assert.equal(performanceResult.preserved,true);assert.ok(performanceResult.boundedQueries<=8);assert.equal(performanceResult.normalizations,0);if(performanceResult.firstBuildMs>16)assert.ok(performanceResult.indexTicks>0,'a long first index pass yields to the UI event loop');
    await writeFile(join(root,'test-results/search-index-performance.json'),JSON.stringify(performanceResult,null,2));assert.deepEqual(chrome.errors,[]);
  }catch(error){if(chrome){await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/search-index-failure.png'),await chrome.page.screenshot());console.error('Search index diagnostics:',await chrome.page.evaluate('({metrics:window.searchMetrics,status:document.querySelector("#status-left")?.textContent,search:document.querySelector("#search-count")?.textContent,toast:document.querySelector("#toast")?.textContent})'));}throw error;}
  finally{await chrome?.close();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});

test('real Chrome: sidebar view choices stay available for HTML without a TOC or headings',{timeout:90000},async()=>{
  await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'htmlmemo-no-toc-'));await cp(join(root,'public'),folder,{recursive:true});const server=createServer(folder);let chrome;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));chrome=await launchChrome();const page=chrome.page,url=process.env.HTMLMEMO_SIDEBAR_TEST_URL||`http://127.0.0.1:${server.address().port}/`;
    await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});await page.navigate(url);await page.waitFor('document.querySelector("#status-left").textContent.includes("개의 문서")');
    const raw=await page.evaluate(`(async()=>{const {parseHTML,serializeHTML}=await import('./src/document.js'),p=parseHTML('<html lang="ko"><head><title>목차 없는 HTML</title><style>body{margin:0;padding:32px;font:18px/1.8 system-ui}p{max-width:700px}#bottom{margin-top:1400px}</style></head><body><p id="target">목차 없이도 검색어를 찾고 주석과 북마크를 확인합니다.</p><p id="bottom">다음 검색어도 찾습니다.</p></body></html>');p.metadata.annotations=[{id:'no-toc-note',type:'note',text:'목차가 없어도 남아 있는 메모',color:'#334155',width:3,opacity:1,points:[{x:40,y:100}]}];p.metadata.bookmarks=[{id:'no-toc-mark',title:'읽던 위치',top:350,left:0}];return serializeHTML(new DOMParser().parseFromString(p.html,'text/html'),p.metadata);})()`);
    const input=async(contents=raw,name='no-toc.html')=>page.evaluate(`(()=>{const t=new DataTransfer();t.items.add(new File([${JSON.stringify(contents)}],${JSON.stringify(name)},{type:'text/html'}));const input=document.querySelector('#file-input');input.files=t.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    const frame='document.querySelector(".document-host:not([hidden]) iframe")',doc=frame+'.contentDocument',ready=frame+'?.style.visibility==="visible"&&!document.querySelector(".tab-dirty:not([hidden])")';
    await input();await page.waitFor(ready+'&&!document.querySelector("#sidebar").hidden');
    const tabId=await page.evaluate('document.querySelector(".tab.document.active").dataset.tab'),record=await page.evaluate(`(async()=>{return (await(await import('./src/storage.js')).listDocuments())[0];})()`);
    assert.equal(await page.evaluate(`${doc}.querySelectorAll('h1,h2,h3,h4,h5,h6,nav,aside').length`),0);assert.equal(await page.evaluate(`${doc}.querySelector('[data-htmlmemo-doc-sidebar-ui]')`),null);assert.equal(await page.evaluate('document.activeElement.id==="document-search"'),false);
    const original=await page.evaluate(`(async()=>{const r=await(await import('./src/storage.js')).getDocument(${JSON.stringify(record.id)});return {html:r.html,annotations:r.metadata.annotations,bookmarks:r.metadata.bookmarks};})()`);
    await mkdir(join(root,'test-results'),{recursive:true});
    for(const width of [1280,390,320]){
      await page.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<600});
      assert.deepEqual(await page.evaluate('[...document.querySelectorAll("#sidebar [data-sidebar-view]")].filter(b=>getComputedStyle(b).display!=="none").map(b=>b.dataset.sidebarView)'),['search','annotations','bookmarks']);
      assert.equal(await page.evaluate('document.querySelector("#sidebar [data-sidebar-count=annotations]").textContent'),'1');assert.equal(await page.evaluate('document.querySelector("#sidebar [data-sidebar-count=bookmarks]").textContent'),'1');
      assert.equal(await page.evaluate('[...document.querySelectorAll("#sidebar [data-sidebar-view]:not([hidden])")].every(b=>{const r=b.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth&&b.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));})'),true);
      if(width===1280)assert.equal(await page.evaluate('document.querySelector("#workspaces").getBoundingClientRect().right<=document.querySelector("#sidebar").getBoundingClientRect().left+1'),true);
      await page.click('#sidebar [data-sidebar-view=search]');await page.evaluate('(()=>{const i=document.querySelector("#document-search");i.value="검색어";i.dispatchEvent(new Event("input"));})()');await page.waitFor('document.querySelectorAll("#sidebar [data-search-index]").length===2');await verifyLoadedSearchEnds(page,'document','',2,selector=>page.click(selector),'no-toc-'+width);
      await page.click('#sidebar [data-sidebar-view=annotations]');await revealAnnotation(page,'document','no-toc-note');await page.click('[data-annotation=no-toc-note]');assert.equal(await page.evaluate('document.querySelector("[data-annotation=no-toc-note] .annotation-main").textContent'),'목차가 없어도 남아 있는 메모');
      await writeFile(join(root,`test-results/sidebar-views-no-toc-${width}.png`),await page.screenshot());await page.click('#sidebar [data-sidebar-view=bookmarks]');assert.ok(await page.evaluate('document.querySelector("[data-bookmark=no-toc-mark]")'));await page.click('[data-bookmark=no-toc-mark]');
    }
    const unchanged=await page.evaluate(`(async()=>{const r=await(await import('./src/storage.js')).getDocument(${JSON.stringify(record.id)});return {html:r.html,annotations:r.metadata.annotations,bookmarks:r.metadata.bookmarks};})()`);assert.deepEqual(unchanged,original);
    await page.click('#close-sidebar');await input('<html><head><title>다른 문서</title></head><body><h1>다른 문서의 제목</h1><p>본문</p></body></html>','with-heading.html');await page.waitFor('document.querySelectorAll(".tab.document").length===2&&'+ready+'&&!document.querySelector("#sidebar").hidden');
    const otherTab=await page.evaluate('document.querySelector(".tab.document.active").dataset.tab');assert.equal(await page.evaluate('document.querySelector("#sidebar [data-sidebar-view=outline]").hidden'),false);assert.equal(await page.evaluate('document.querySelector("#sidebar [data-sidebar-count=annotations]").textContent'),'0');
    await page.click(`.tab[data-tab="${tabId}"] .tab-select`);assert.equal(await page.evaluate('document.querySelector("#sidebar").hidden'),true);await page.click('[data-action=more]');await page.click('[data-more=sidebar]');assert.equal(await page.evaluate('document.querySelector("#sidebar [data-sidebar-view=bookmarks]").getAttribute("aria-pressed")'),'true');assert.equal(await page.evaluate('document.querySelector("#sidebar [data-sidebar-view=outline]").hidden'),true);
    await page.click(`.tab[data-tab="${otherTab}"] .tab-select`);await page.click('#sidebar [data-sidebar-view=bookmarks]');await page.click('#add-bookmark');await page.waitFor('document.querySelector("#note-text")');await page.evaluate('document.querySelector("#note-text").value="다른 문서의 북마크"');await page.click('#dialog button[value=save]');await page.waitFor('document.querySelector("#sidebar [data-sidebar-count=bookmarks]").textContent==="1"&&'+ready);
    await page.click(`.tab[data-tab="${tabId}"] .tab-select`);assert.equal(await page.evaluate('document.querySelector("#sidebar [data-sidebar-count=bookmarks]").textContent'),'1');assert.equal(await page.evaluate('document.querySelectorAll("#sidebar [data-bookmark]").length'),1);
    await page.click('.tab.document.active .tab-close');await page.click('#library-tab');await page.click(`[data-open="${record.id}"]`);await page.waitFor(ready+'&&!document.querySelector("#sidebar").hidden');assert.equal(await page.evaluate('document.querySelector("#sidebar [data-sidebar-view=outline]").hidden'),true);assert.equal(await page.evaluate('document.querySelector("#sidebar [data-sidebar-count=annotations]").textContent'),'1');
    await page.evaluate(`(async()=>{const root=await navigator.storage.getDirectory(),handle=await root.getFileHandle('no-toc-export.html',{create:true});window.showSaveFilePicker=async()=>handle;})()`);await page.click('#save-page');await page.waitFor('document.querySelector("#toast").textContent.includes("현재 주석을 포함한 HTML")');
    const exported=await page.evaluate(`(async()=>{const root=await navigator.storage.getDirectory(),file=await(await root.getFileHandle('no-toc-export.html')).getFile(),{parseHTML}=await import('./src/document.js'),html=await file.text(),p=parseHTML(html);return {notes:p.metadata.annotations.length,bookmarks:p.metadata.bookmarks.length,ui:html.includes('data-app-sidebar')||html.includes('data-sidebar-view')};})()`);assert.deepEqual(exported,{notes:1,bookmarks:1,ui:false});assert.deepEqual(chrome.errors,[]);
  }catch(error){if(chrome){await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/sidebar-views-no-toc-failure.png'),await chrome.page.screenshot());console.error('TOC-less sidebar diagnostics:',await chrome.page.evaluate('({status:document.querySelector("#status-left")?.textContent,toast:document.querySelector("#toast")?.textContent,sidebar:document.querySelector("#sidebar")?.innerText,dialog:document.querySelector("#dialog")?.innerText})'));}throw error;}
  finally{await chrome?.close();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
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
    assert.equal(await page.evaluate('document.querySelector("#sidebar").hidden'),false);
    await page.click('[data-action=more]');assert.equal(await page.evaluate('!!document.querySelector("[data-more=sidebar]")'),false);
    for(const removed of ['search','outline','annotations','undo','redo','bookmark','connect','area','area-underline','text','clear'])assert.equal(await page.evaluate(`!!document.querySelector('[data-more=${removed}]')`),false);
    await page.click('[data-popover-close]');
    assert.deepEqual(await page.evaluate('[...document.querySelectorAll("[data-sidebar-view]")].map(button=>button.textContent)'),['','','1','1']);
    for(const width of [1280,390,320]){
      await page.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<600});
      const compact=await page.evaluate(`(()=>{const panel=document.querySelector('#sidebar'),row=panel.querySelector('.sidebar-views'),r=row.getBoundingClientRect();return {height:r.height,buttons:[...row.querySelectorAll('button')].map(b=>b.getBoundingClientRect().height),topGap:r.top-panel.getBoundingClientRect().top,padding:getComputedStyle(row).paddingTop};})()`);
      assert.equal(compact.height,25);assert.deepEqual(compact.buttons,[24,24,24,24,24]);assert.equal(compact.topGap,0);assert.equal(compact.padding,'0px');
      const visible=await page.evaluate('[...document.querySelectorAll("[data-sidebar-view]")].every(button=>{const r=button.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth&&button.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));})');assert.equal(visible,true);
      assert.equal(await page.evaluate(`(()=>{const b=[...document.querySelectorAll('[data-sidebar-view]')];return b.every(e=>e.title&&e.querySelector('svg')&&/^\\d*$/.test(e.textContent))&&new Set(b.map(e=>e.getBoundingClientRect().top)).size===1;})()`),true);
      await page.click('[data-sidebar-view=search]');
      assert.equal(await page.evaluate('document.querySelector("#document-search").placeholder'),'불러온 부분에서 찾기');assert.equal(await page.evaluate('document.querySelector("#sidebar-title").textContent'),'검색');
      await page.evaluate(`(()=>{const input=document.querySelector('#document-search');input.value='검색어';input.dispatchEvent(new Event('input'));})()`);
      await page.waitFor('document.querySelectorAll("[data-search-index]").length===2');await verifyLoadedSearchEnds(page,'document','',2,selector=>page.click(selector),'plain-'+width);await page.click('[data-search-index="1"]');
      await page.click('[data-sidebar-view=annotations]');assert.equal(await page.evaluate('document.querySelector("[data-annotation=sidebar-note] .annotation-main").textContent'),'보관한 메모');await revealAnnotation(page,'document','sidebar-note');await page.click('[data-annotation=sidebar-note]');
      await page.click('[data-sidebar-view=search]');assert.equal(await page.evaluate('document.querySelector("#document-search").value'),'검색어');
      await page.evaluate(`(()=>{const input=document.querySelector('#document-search');input.value='빠른 전환';input.dispatchEvent(new Event('input'));document.querySelector('[data-sidebar-view=outline]').click();})()`);
      await page.evaluate('new Promise(resolve=>setTimeout(resolve,160))');
      assert.equal(await page.evaluate('document.querySelectorAll("[data-sidebar-view][aria-pressed=true]").length'),1);
      if(width===1280||width===320){await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,`test-results/sidebar-views-${width}.png`),await page.screenshot());}
    }
    await page.click('[data-action=more]');assert.equal(await page.evaluate('!!document.querySelector("[data-more=sidebar]")'),false);
    await writeFile(join(root,'test-results/sidebar-views-tools-plain-320.png'),await page.screenshot());await page.click('[data-popover-close]');
    const unchanged=await page.evaluate(`(async()=>{const {getDocument}=await import('./src/storage.js');const record=await getDocument('sidebar-document');return {html:record.html,annotations:record.metadata.annotations,bookmarks:record.metadata.bookmarks};})()`);assert.deepEqual(unchanged,original);
    assert.equal(await page.evaluate('document.querySelector(".document-host:not([hidden]) iframe")===window.sidebarFrame'),true);
    await page.click('[data-sidebar-view=bookmarks]');await page.click('#add-bookmark');await page.evaluate(`document.querySelector('#note-text').value='새 북마크'`);await page.click('#dialog button[value=save]');
    await page.waitFor('document.querySelectorAll("[data-bookmark]").length===2&&document.querySelector("#status-left").textContent.includes("자동 저장됨")');
    assert.equal(await page.evaluate('document.querySelector("[data-sidebar-count=bookmarks]").textContent'),'2');
    await page.click('[data-delete-bookmark=sidebar-bookmark]');await page.click('[data-sidebar-view=annotations]');await revealAnnotation(page,'document','sidebar-note');await page.click('[data-delete-annotation=sidebar-note]');
    await page.waitFor('document.querySelector("#sidebar .panel-empty")?.textContent.includes("아직 주석")&&document.querySelector("#status-left").textContent.includes("자동 저장됨")');
    const saved=await page.evaluate(`(async()=>{const {getDocument}=await import('./src/storage.js');const record=await getDocument('sidebar-document');return {html:record.html,annotations:record.metadata.annotations.length,bookmarks:record.metadata.bookmarks.map(mark=>mark.title)};})()`);
    assert.equal(saved.html,original.html);assert.equal(saved.annotations,0);assert.deepEqual(saved.bookmarks,['새 북마크']);
    await page.click('#close-sidebar');assert.equal(await page.evaluate('document.querySelector("#sidebar").hidden'),true);
    await page.click('[data-action=more]');await page.click('[data-more=sidebar]');assert.equal(await page.evaluate('document.querySelector("#sidebar").hidden'),false);
    assert.equal(await page.evaluate('document.querySelectorAll("#sidebar [data-sidebar-view]").length'),4);await page.click('#close-sidebar');assert.deepEqual(chrome.errors,[]);
  }finally{if(chrome)await chrome.close();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});

test('real Chrome: sidebar view choices preserve word and sentence selection with blank-only fullscreen',{timeout:90000},async()=>{
  await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'htmlmemo-text-clicks-'));await cp(join(root,'public'),folder,{recursive:true});
  const server=createServer(folder);let chrome;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));chrome=await launchChrome();const page=chrome.page;
    const url=process.env.HTMLMEMO_SIDEBAR_TEST_URL||`http://127.0.0.1:${server.address().port}/`;
    const english='A second sentence with nested formatting!',korean='두 번째 문장입니다!',wrapped='A longer sentence with wrapping across several visible lines and its original punctuation intact!';
    const source='<html lang="ko"><head><title>Text click fixture</title><style>html,body{height:100%;margin:0;overflow:hidden;font:18px/1.7 sans-serif}.layout{display:grid;grid-template-columns:220px 1fr;height:100%}nav,main{padding:12px;overflow:auto}p{max-width:620px}#wrapped{width:250px}#blank{height:220px}</style></head><body><div class="layout"><nav id="reader-nav"><h2>목차</h2><div id="reader-tree"><p>Sidebar text</p><a href="#english">Part</a></div></nav><main id="reader-main"><article id="reader-content"><p id="english">First sentence. A <em>second</em> sentence with <strong>nested formatting</strong>! Last sentence?</p><p id="korean">첫 문장입니다. <em>두 번째</em> 문장입니다! 마지막 문장입니다.</p><p id="wrapped">A longer sentence with <em>wrapping</em> across several visible lines and its original punctuation intact! A separate sentence.</p><button id="source-control">Control</button><div id="blank"></div></article></main></div></body></html>';
    await page.navigate(url);await page.waitFor('document.querySelector("#status-left").textContent.includes("개의 문서")');
    await page.evaluate(`(async()=>{const {putDocumentRevision}=await import('./src/storage.js'),{parseHTML}=await import('./src/document.js'),parsed=parseHTML(${JSON.stringify(source)});await putDocumentRevision({id:'text-click-document',title:'Text click fixture',name:'text-clicks.html',created:Date.now(),modified:Date.now(),html:parsed.html,metadata:parsed.metadata});})()`);
    await page.navigate(url);await page.waitFor('document.querySelector("[data-open=text-click-document]")');await page.click('[data-open=text-click-document]');
    const frame='document.querySelector(".document-host:not([hidden]) iframe")',doc=frame+'.contentDocument';
    await page.waitFor(`${doc}?.querySelector('[data-htmlmemo-doc-sidebar-ui]')&&${doc}.querySelector('#english')&&!${frame}.hasAttribute('aria-hidden')`);
    const clickAt=async(selector,count,{word='',corner=false}={})=>{
      await page.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      const point=await page.evaluate(`(()=>{const f=${frame},d=f.contentDocument,e=d.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});let r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;const word=${JSON.stringify(word)};if(word){const w=d.createTreeWalker(e,NodeFilter.SHOW_TEXT);let found=false;while(w.nextNode()){const n=w.currentNode,at=n.textContent.indexOf(word);if(at<0)continue;const range=d.createRange();range.setStart(n,at);range.setEnd(n,at+word.length);r=range.getClientRects()[0];x=r.left+r.width/2;y=r.top+r.height/2;found=true;break;}if(!found)throw Error('Missing text point: '+word);}else if(${corner}){x=r.right-3;y=r.bottom-2;}const b=f.getBoundingClientRect(),z=b.width/f.clientWidth;return {x:b.left+x*z,y:b.top+y*z};})()`);
      for(let clickCount=1;clickCount<=count;clickCount++){await page.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount});await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount});}
    };
    const focused=()=>page.evaluate('document.querySelector("#app").classList.contains("reader-focus")');
    const selected=()=>page.evaluate(`${doc}.getSelection().toString().trim()`);
    await mkdir(join(root,'test-results'),{recursive:true});
    for(const width of [1280,390]){
      await page.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<600});
      for(const fullscreen of [false,true]){
        if(fullscreen){await clickAt('#english',2,{corner:true});await page.waitFor('document.querySelector("#app").classList.contains("reader-focus")');}
        await clickAt('#english em',2,{word:'second'});await page.waitFor(`${doc}.getSelection().toString().trim()==='second'`);assert.equal(await focused(),fullscreen);
        await clickAt('#english em',3,{word:'second'});await page.waitFor(`${doc}.getSelection().toString().trim()===${JSON.stringify(english)}`);assert.equal(await selected(),english);assert.equal(await focused(),fullscreen);
        await clickAt('#korean em',3,{word:'번째'});await page.waitFor(`${doc}.getSelection().toString().trim()===${JSON.stringify(korean)}`);assert.equal(await focused(),fullscreen);
        await clickAt('#wrapped em',3,{word:'wrapping'});await page.waitFor(`${doc}.getSelection().toString().trim()===${JSON.stringify(wrapped)}`);assert.equal(await focused(),fullscreen);
        await writeFile(join(root,`test-results/sidebar-views-text-clicks-${width}-${fullscreen?'focused':'normal'}.png`),await page.screenshot());
        await clickAt('#reader-tree p',2,{word:'Sidebar'});assert.equal(await focused(),fullscreen);await clickAt('#source-control',2);assert.equal(await focused(),fullscreen);
      }
      await clickAt('#blank',2);await page.waitFor('!document.querySelector("#app").classList.contains("reader-focus")&&!document.fullscreenElement');
    }
    await clickAt('#english em',3,{word:'second'});await page.waitFor(`${doc}.getSelection().toString().trim()===${JSON.stringify(english)}`);await page.click('[data-action=highlight]');
    await page.waitFor(`${doc}.querySelector('[data-htmlmemo-mark]')&&document.querySelector('#status-left').textContent.includes('자동 저장됨')`);
    const saved=await page.evaluate(`(async()=>{const {getDocument}=await import('./src/storage.js'),r=await getDocument('text-click-document');return r.metadata.annotations.map(a=>({type:a.type,quote:a.textAnchor.quote}));})()`);
    assert.deepEqual(saved,[{type:'highlight',quote:english}]);assert.deepEqual(chrome.errors,[]);
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
    await page.evaluate('window.pick("edition-1.html")');await clickLibraryImport(page);
    await page.waitFor(`${frame}?.contentDocument?.querySelectorAll('[data-htmlmemo-mark]').length >= 2 && !document.querySelector('#toolbar').hidden && document.querySelector("#status-left").textContent.includes("자동 저장됨")`,20000);
    await page.evaluate('window.pick("edition-2.html")');
    await page.click('[data-action=more]');{const reach=await page.evaluate('(()=>{const b=document.querySelector("[data-more=migrate]");b.scrollIntoView({block:"center"});const r=b.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {ok:b.contains(hit),rect:[r.x,r.y,r.width,r.height].map(Math.round),view:[innerWidth,innerHeight],hit:hit&&(hit.id||hit.className||hit.localName),popover:(()=>{const p=document.querySelector("#tool-popover").getBoundingClientRect();return [p.x,p.y,p.width,p.height].map(Math.round);})()};})()');assert.ok(reach.ok,'the menu item is reachable: '+JSON.stringify(reach));}await page.click('[data-more=migrate]');
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
