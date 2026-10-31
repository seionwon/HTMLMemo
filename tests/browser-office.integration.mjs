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
import {ebookFixtures,ebookZip,epubParts} from './ebook-fixtures.mjs';
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
async function exportEbook(page){
  await page.evaluate(`(async()=>{const root=await navigator.storage.getDirectory();window.__ebookExport=await root.getFileHandle('전자책 주석.html',{create:true});window.showSaveFilePicker=async()=>window.__ebookExport;})()`);await page.click('#save-page');await page.waitFor("document.querySelector('#toast').textContent.includes('내보냈습니다')");
  return Buffer.from(await page.evaluate(`(async()=>{const bytes=new Uint8Array(await(await window.__ebookExport.getFile()).arrayBuffer());let s='';for(let i=0;i<bytes.length;i+=16384)s+=String.fromCharCode(...bytes.subarray(i,i+16384));return btoa(s);})()`),'base64');
}

test('real Chrome: Pages-only foliate opens all ebook formats with shared HTML controls and original folder copies',{timeout:210000},async()=>{
  const env=await environment();let chrome;
  try{
    chrome=await launchChrome();const page=chrome.page;await page.navigate(env.url);await chooseFile(page,Buffer.from('<!doctype html><h1>Baseline</h1><p>본문</p>'),'ebook-baseline.html');await saved(page,'ebook-baseline.html');const baseline=await page.evaluate(controls),results=[],seen=new Set();
    for(const [format,bytes] of Object.entries(await ebookFixtures())){
      const name='전자책.'+format,key=Buffer.from(bytes).toString('base64');await chooseFile(page,bytes,name);if(seen.has(key)){await page.waitFor('document.querySelector("dialog[open] [data-duplicate-import]")');await page.click('dialog[open] [data-duplicate-import] [value=new]');}seen.add(key);
      await saved(page,name);await page.waitFor(frame+'?.style.visibility==="visible"&&'+doc+'?.querySelector("article[data-ebook]")');assert.deepEqual(await page.evaluate(controls),baseline,format);
      const info=await page.evaluate(`(async()=>{const r=window.__officeRecord,d=${doc},{textIndex}=await import('./src/document.js');return {text:textIndex(d).text,original:Array.from(new Uint8Array(await r.originalFile.arrayBuffer())),toc:[...document.querySelectorAll('#sidebar [data-heading]')].map(n=>n.textContent),unsafe:d.querySelectorAll('script,iframe,object,embed,[contenteditable]').length,execution:r.metadata.execution.allowScripts,images:[...d.querySelectorAll('img')].every(n=>n.complete&&n.naturalWidth>0)};})()`);
      assert.deepEqual(info.original,[...bytes]);assert.ok(info.toc.length>=2);assert.equal(info.unsafe,0);assert.equal(info.execution,false);assert.equal(info.images,true,format+' local images decoded');
      if(format==='cbz')assert.deepEqual(info.toc,['page2.png','page10.png']);else assert.match(info.text,format==='azw3'?/Alice|ALICE/:/검색하는 한국어/);
      results.push({format,originalBytes:bytes.length,outlineItems:info.toc.length,readOnly:true,sharedUI:true,images:true});
    }
    await page.waitFor('document.querySelector("#data-folder-status").textContent==="폴더 저장 완료"',30000);
    const copies=await page.evaluate(`(async()=>{const s=await import('./src/storage.js'),folder=await s.getSetting('folder'),manifest=JSON.parse(await(await(await folder.getFileHandle('HTMLMemo-library.json')).getFile()).text());return manifest.documents.map(e=>({original:e.original.name,copy:e.copy.name,source:e.source.name}));})()`);
    for(const format of Object.keys(await ebookFixtures()))assert.ok(copies.some(c=>c.original.endsWith('.'+format)&&c.copy.endsWith('.'+format)&&c.source.endsWith('.html')),format);
    assert.deepEqual(chrome.errors,[]);await writeFile(join(root,'test-results/pages-only-ebook-formats.json'),JSON.stringify({status:'pass',results,controls:baseline,folderCopies:copies.length,errors:[]},null,2));
  }catch(error){if(chrome){await writeFile(join(root,'test-results/pages-only-ebook-formats-failure.png'),await chrome.page.screenshot());console.error('Ebook format diagnostic',await chrome.page.evaluate('({toast:document.querySelector("#toast")?.textContent,sidebar:document.querySelector("#sidebar")?.textContent})'));}throw error;}finally{await chrome?.close();await env.close();}
});

test('real Chrome: Pages-only foliate annotations, hierarchical TOC, cross-links, search, export, mobile and offline',{timeout:240000},async()=>{
  const env=await environment(),fixtures=await ebookFixtures();let chrome,receiver;
  try{
    chrome=await launchChrome();receiver=await launchChrome();const page=chrome.page;await page.navigate(env.url);await receiver.page.navigate(env.url);const results=[];
    // Extra paragraphs make navigation visibly measurable in the shared scroller.
    const parts=epubParts();parts['OEBPS/chapter1.xhtml']=parts['OEBPS/chapter1.xhtml'].replace('</body>','<p>'+'첫 장의 긴 본문입니다. '.repeat(500)+'</p></body>');const epub=await ebookZip(parts);
    for(const [format,bytes] of [['epub',epub],['mobi',fixtures.mobi],['fb2',fixtures.fb2],['azw3',fixtures.azw3]]){
      const name='전자책 주석.'+format;await chooseFile(page,bytes,name);await saved(page,name);await page.waitFor(frame+'?.style.visibility==="visible"&&'+doc+'?.querySelector("article[data-ebook]")');
      const quote=format==='azw3'?'Alice':'한국어',selected=await page.evaluate(`(()=>{const d=${doc},{body}=d;const walk=d.createTreeWalker(body,NodeFilter.SHOW_TEXT);let n;while(n=walk.nextNode()){if(n.parentElement.closest('style,template')||!n.textContent.includes(${JSON.stringify(quote)}))continue;const start=n.textContent.indexOf(${JSON.stringify(quote)}),range=d.createRange();range.setStart(n,start);range.setEnd(n,start+${quote.length});n.parentElement.scrollIntoView({block:'center'});d.getSelection().removeAllRanges();d.getSelection().addRange(range);d.dispatchEvent(new Event('selectionchange'));return d.getSelection().toString();}})()`);assert.equal(selected,quote);
      await page.click('#toolbar [data-action=highlight]');await saved(page,name,'window.__officeRecord.metadata.annotations.length===1');assert.equal(await page.evaluate(doc+'.querySelectorAll("[data-htmlmemo-mark]").length>0'),true);
      if(format==='epub'){
        // @scope retains body class styling while confining sibling selectors.
        assert.equal(await page.evaluate('getComputedStyle('+doc+'.querySelector("#ebook-0-2")).lineHeight'),'28.8px');
        await page.click('[data-sidebar-view=outline]');assert.deepEqual(await page.evaluate('[...document.querySelectorAll("#sidebar [data-heading]")].map(n=>n.textContent)'),['첫 장','첫 절','둘째 장']);
        await page.click('#sidebar [data-heading="2"]');await page.waitFor(doc+'.defaultView.scrollY>300');
        await page.click('#sidebar [data-heading="0"]');await page.waitFor(doc+'.defaultView.scrollY<200');
        await page.click('#toolbar [data-action=select]');
        const point=await page.evaluate(`(()=>{const f=${frame},d=f.contentDocument,a=[...d.querySelectorAll('section a')].find(n=>n.textContent==='다음 장으로');a.scrollIntoView({block:'center'});const b=f.getBoundingClientRect(),r=a.getBoundingClientRect(),scale=b.width/f.offsetWidth;return{x:b.left+(r.left+r.width/2)*scale,y:b.top+(r.top+r.height/2)*scale};})()`);
        await page.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});await page.waitFor(doc+'.defaultView.scrollY>300');
        await page.click('.document-host:not([hidden]) [data-action=previous-heading]');await page.waitFor(doc+'.defaultView.scrollY<300');
        await page.click('.document-host:not([hidden]) [data-action=next-heading]');
      }
      await page.click('[data-sidebar-view=bookmarks]');await page.click('#add-bookmark');await page.evaluate("document.querySelector('#note-text').value='전자책 돌아올 곳'");await page.click('.note-form button[value=save]');await saved(page,name,'window.__officeRecord.metadata.bookmarks.length===1');
      await page.click('[data-sidebar-view=search]');await page.evaluate(`(()=>{const input=document.querySelector('#book-search');input.value=${JSON.stringify(quote)};input.dispatchEvent(new Event('input',{bubbles:true}));})()`);await page.waitFor('document.querySelector("[data-whole-search-index]")');await page.click('[data-whole-search-index="0"]');
      const exported=await exportEbook(page);await chooseFile(receiver.page,exported,format+'-ebook-shared.html');await saved(receiver.page,format+'-ebook-shared.html','window.__officeRecord.metadata.annotations.length===1&&window.__officeRecord.metadata.bookmarks.length===1');await receiver.page.click('[data-sidebar-view=outline]');assert.ok(await receiver.page.evaluate('document.querySelectorAll("#sidebar [data-heading]").length>=2'));
      results.push({format,selected,annotations:true,bookmarks:true,search:true,exportBytes:exported.length});
    }
    await page.send('Emulation.setDeviceMetricsOverride',{width:320,height:640,deviceScaleFactor:1,mobile:true});await page.click('#close-sidebar');await page.evaluate(doc+'.defaultView.scrollTo(0,0)');assert.equal(await page.evaluate('document.documentElement.scrollWidth>innerWidth'),false);await writeFile(join(root,'test-results/pages-only-ebook-320.png'),await page.screenshot());
    await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});await page.evaluate(doc+'.defaultView.scrollTo(0,0)');await writeFile(join(root,'test-results/pages-only-ebook-1280.png'),await page.screenshot());
    await page.evaluate('navigator.serviceWorker.ready');await page.waitFor('!!navigator.serviceWorker.controller',45000);await page.send('Network.enable');await page.send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});await chooseFile(page,fixtures.epub,'offline.epub');await saved(page,'offline.epub');
    await chooseFile(page,Buffer.from('invalid'),'damaged.epub');await page.waitFor('document.querySelector("#toast").textContent.includes("손상")');assert.equal(await page.evaluate('(async()=>{const s=await import("./src/storage.js");return(await s.listDocuments()).some(r=>r.name==="damaged.epub");})()'),false);
    assert.deepEqual(chrome.errors,[]);assert.deepEqual(receiver.errors,[]);await writeFile(join(root,'test-results/pages-only-ebook-annotations.json'),JSON.stringify({status:'pass',results,outline:true,crossLinks:true,mobile:320,offline:true,errors:[]},null,2));
  }catch(error){if(chrome){await writeFile(join(root,'test-results/pages-only-ebook-annotations-failure.png'),await chrome.page.screenshot());console.error('Ebook annotation diagnostic',await chrome.page.evaluate('({toast:document.querySelector("#toast")?.textContent,sidebar:document.querySelector("#sidebar")?.textContent})'));}throw error;}finally{await receiver?.close();await chrome?.close();await env.close();}
});

test('real Chrome: Pages-only foliate fixed EPUB scales annotations and CBZ supports pen and bookmarks',{timeout:150000},async()=>{
  const env=await environment(),fixtures=await ebookFixtures();let chrome;
  try{
    chrome=await launchChrome();const page=chrome.page;await page.navigate(env.url);await chooseFile(page,await ebookZip(epubParts({fixed:true})),'fixed.epub');await saved(page,'fixed.epub');await page.waitFor(doc+'?.querySelector(".ebook-fixed-page")');
    await page.evaluate(`(()=>{const d=${doc},p=d.querySelector('#ebook-0-2'),range=d.createRange();range.selectNodeContents(p);d.getSelection().removeAllRanges();d.getSelection().addRange(range);d.dispatchEvent(new Event('selectionchange'));})()`);await page.click('#toolbar [data-action=highlight]');await saved(page,'fixed.epub','window.__officeRecord.metadata.annotations.length===1');
    const bounds=`(()=>{const d=${doc};return {page:d.querySelector('.ebook-fixed-page>svg').getBoundingClientRect().width,mark:d.querySelector('[data-htmlmemo-mark]').getBoundingClientRect().width};})()`,before=await page.evaluate(bounds);await page.click('.document-host:not([hidden]) [data-action=font-larger]');await saved(page,'fixed.epub','window.__officeRecord.metadata.view.fontScale===1.1');const after=await page.evaluate(bounds);assert.ok(Math.abs(after.page/before.page-1.1)<.03);assert.ok(Math.abs(after.mark/before.mark-1.1)<.03);
    await chooseFile(page,fixtures.cbz,'comic.cbz');await saved(page,'comic.cbz');await page.waitFor(doc+'?.querySelector(".ebook-comic-page img")?.naturalWidth>0');await page.click('#toolbar [data-action=pen]');
    const start=await page.evaluate(`(()=>{const f=${frame},image=f.contentDocument.querySelector('img').getBoundingClientRect(),r=f.getBoundingClientRect(),s=r.width/f.offsetWidth;return{x:r.left+(image.left+60)*s,y:r.top+(image.top+60)*s};})()`);await page.send('Input.dispatchMouseEvent',{type:'mousePressed',...start,button:'left',buttons:1,clickCount:1});await page.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:start.x+70,y:start.y+30,button:'left',buttons:1});await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:start.x+70,y:start.y+30,button:'left',buttons:0,clickCount:1});await saved(page,'comic.cbz','window.__officeRecord.metadata.annotations.length===1');
    await page.click('[data-sidebar-view=bookmarks]');await page.click('#add-bookmark');await page.evaluate("document.querySelector('#note-text').value='만화 북마크'");await page.click('.note-form button[value=save]');await saved(page,'comic.cbz','window.__officeRecord.metadata.bookmarks.length===1');
    assert.deepEqual(chrome.errors,[]);await writeFile(join(root,'test-results/pages-only-ebook-fixed-comic.json'),JSON.stringify({status:'pass',scale:{page:after.page/before.page,annotation:after.mark/before.mark},comicPen:true,comicBookmark:true,errors:[]},null,2));
  }catch(error){if(chrome)await writeFile(join(root,'test-results/pages-only-ebook-fixed-comic-failure.png'),await chrome.page.screenshot());throw error;}finally{await chrome?.close();await env.close();}
});
test('real Chrome: Pages-only GenOffice opens every format read-only with the existing HTML UI',{timeout:240000},async()=>{
  const env=await environment();let chrome;
  try{
    chrome=await launchChrome();const page=chrome.page;await page.navigate(env.url);
    await chooseFile(page,Buffer.from('<!doctype html><title>Baseline</title><h1>첫 장</h1><p>본문</p>'),'baseline.html');await saved(page,'baseline.html');const baseline=await page.evaluate(controls),results=[];
    for(const [format,bytes] of Object.entries(await officeFixtures())){
      const name='읽기 전용.'+format;await chooseFile(page,bytes,name);
      // .md and .markdown intentionally share exact bytes. Exercise the normal
      // duplicate choice instead of waiting for a record the user has not chosen.
      if(format==='markdown'){await page.waitFor('document.querySelector("dialog[open] [data-duplicate-import]")');await page.click('dialog[open] [data-duplicate-import] [value=new]');}
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

test('real Chrome: Pages-only rhwp Korean selection, annotations, pages, scaling, sharing and offline import',{timeout:210000},async()=>{
  const env=await environment(),fixtures=await officeFixtures();let chrome,receiver;
  try{
    chrome=await launchChrome();receiver=await launchChrome();const page=chrome.page;await page.navigate(env.url);await receiver.page.navigate(env.url);const results=[];
    for(const format of ['hml','hwpx','hwp']){
      const name='한글 주석.'+format;await chooseFile(page,fixtures[format],name);await saved(page,name);await page.waitFor(frame+'?.style.visibility==="visible"');
      const before=await page.evaluate(`(()=>{const d=${doc},p=d.querySelector('[data-office-text]'),range=d.createRange();range.selectNodeContents(p);d.getSelection().removeAllRanges();d.getSelection().addRange(range);d.dispatchEvent(new Event('selectionchange'));return {text:d.getSelection().toString(),pages:d.querySelectorAll('.office-page').length};})()`);
      assert.match(before.text,/검색하는 한국어 본문입니다/);assert.equal(before.pages,2);
      await page.click('#toolbar [data-action=highlight]');await saved(page,name,'window.__officeRecord.metadata.annotations.length===1');
      assert.match(await page.evaluate('[...'+doc+'.querySelectorAll("[data-htmlmemo-mark]")].map(n=>n.textContent).join("")'),/검색하는 한국어/);
      await page.click('[data-sidebar-view=bookmarks]');await page.click('#add-bookmark');await page.evaluate("document.querySelector('#note-text').value='한글 돌아올 곳'");await page.click('.note-form button[value=save]');await saved(page,name,'window.__officeRecord.metadata.bookmarks.length===1');
      await page.click('[data-sidebar-view=search]');await page.evaluate("(()=>{const input=document.querySelector('#book-search');input.value='한국어';input.dispatchEvent(new Event('input',{bubbles:true}));})()");await page.waitFor('document.querySelector("[data-whole-search-index]")');await page.click('[data-whole-search-index="0"]');
      await page.evaluate(`(async()=>{const root=await navigator.storage.getDirectory();window.__hangulExport=await root.getFileHandle('한글 주석.html',{create:true});window.showSaveFilePicker=async()=>window.__hangulExport;})()`);await page.click('#save-page');await page.waitFor("document.querySelector('#toast').textContent.includes('내보냈습니다')");
      const exported=Buffer.from(await page.evaluate(`(async()=>{const f=await window.__hangulExport.getFile(),bytes=new Uint8Array(await f.arrayBuffer());let s='';for(let i=0;i<bytes.length;i+=16384)s+=String.fromCharCode(...bytes.subarray(i,i+16384));return btoa(s);})()`),'base64');
      await chooseFile(receiver.page,exported,format+'-shared.html');await saved(receiver.page,format+'-shared.html','window.__officeRecord.metadata.annotations.length===1&&window.__officeRecord.metadata.bookmarks.length===1');
      results.push({format,selected:before.text,pages:before.pages,annotations:true,bookmarks:true,exportBytes:exported.length});
    }
    // Same scale governs original glyphs, HTML selection rectangles and annotations.
    const bounds=`(()=>{const d=${doc};return {page:d.querySelector('.office-page>svg').getBoundingClientRect().width,mark:d.querySelector('[data-htmlmemo-mark]').getBoundingClientRect().width};})()`;
    const first=await page.evaluate(bounds);await page.click('.document-host:not([hidden]) [data-action=font-larger]');await saved(page,'한글 주석.hwp','window.__officeRecord.metadata.view.fontScale===1.1');const enlarged=await page.evaluate(bounds);
    assert.ok(Math.abs(enlarged.page/first.page-1.1)<.03);assert.ok(Math.abs(enlarged.mark/first.mark-1.1)<.03);
    await page.click('.document-host:not([hidden]) [data-action=next-heading]');await page.waitFor(doc+'.defaultView.scrollY>100');
    await page.click('.document-host:not([hidden]) [data-action=previous-heading]');
    await page.send('Emulation.setDeviceMetricsOverride',{width:320,height:640,deviceScaleFactor:1,mobile:true});await page.click('#close-sidebar');await page.evaluate(doc+'.defaultView.scrollTo(0,0)');await page.waitFor(doc+'.querySelector(".office-page>svg").getBoundingClientRect().width>100');await writeFile(join(root,'test-results/pages-only-hangul-320.png'),await page.screenshot());assert.equal(await page.evaluate('document.documentElement.scrollWidth>innerWidth'),false);
    await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});await page.evaluate(doc+'.defaultView.scrollTo(0,0)');await writeFile(join(root,'test-results/pages-only-hangul-1280.png'),await page.screenshot());
    await page.evaluate('navigator.serviceWorker.ready');await page.waitFor('!!navigator.serviceWorker.controller',45000);await page.send('Network.enable');await page.send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
    await chooseFile(page,fixtures.hwpx,'offline.hwpx');await page.waitFor('document.querySelector("dialog[open] [data-duplicate-import]")');await page.click('dialog[open] [data-duplicate-import] [value=new]');await saved(page,'offline.hwpx');
    await chooseFile(page,Buffer.from('<html>not HML</html>'),'damaged.hml');await page.waitFor('document.querySelector("#toast").textContent.includes("HWPML")');assert.equal(await page.evaluate('(async()=>{const s=await import("./src/storage.js");return(await s.listDocuments()).some(r=>r.name==="damaged.hml");})()'),false);
    assert.deepEqual(chrome.errors,[]);assert.deepEqual(receiver.errors,[]);await writeFile(join(root,'test-results/pages-only-hangul.json'),JSON.stringify({status:'pass',results,scale:{page:enlarged.page/first.page,annotation:enlarged.mark/first.mark},navigation:true,mobile:320,offline:true,errors:[]},null,2));
  }catch(error){if(chrome){await writeFile(join(root,'test-results/pages-only-hangul-failure.png'),await chrome.page.screenshot());console.error('Hangul diagnostic',await chrome.page.evaluate('({toast:document.querySelector("#toast")?.textContent,sidebar:document.querySelector("#sidebar")?.textContent})'));}throw error;}finally{await receiver?.close();await chrome?.close();await env.close();}
});
