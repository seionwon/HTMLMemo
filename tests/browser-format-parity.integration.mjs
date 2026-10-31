// Shared UI and user actions through the shipped app, in CI/trusted Chrome only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {root,prepareAssets,packageAssets} from '../scripts/assets.mjs';
import {pwaEntries} from '../public/src/distribution.js';
import {createServer} from '../scripts/server.mjs';
import {launchChrome,clickLibraryImport} from './chrome.mjs';
import {officeFixtures} from './office-fixtures.mjs';
import {ebookFixtures,ebookZip,epubParts} from './ebook-fixtures.mjs';
import {DOCUMENT_EXTENSIONS} from '../public/src/office-formats.js';

const host='document.querySelector(".document-host:not([hidden])")',frame=host+'.querySelector("iframe")',doc=frame+'.contentDocument';
const bar=host+'.querySelector("[data-htmlmemo-reading-controls]")';
const control=action=>'.document-host:not([hidden]) [data-action="'+action+'"]';
async function environment(){
  await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'librememo-format-parity-'));
  for(const entry of pwaEntries(await packageAssets())){const path=join(folder,entry.name);await mkdir(join(path,'..'),{recursive:true});await writeFile(path,entry.data);}
  const server=createServer(folder);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {url:process.env.HTMLMEMO_SIDEBAR_TEST_URL||`http://127.0.0.1:${server.address().port}/`,async close(){await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}};
}
async function chooseFile(page,bytes,name){
  await page.evaluate(`(async()=>{const root=await navigator.storage.getDirectory(),folder=await root.getDirectoryHandle('Parity incoming fixture',{create:true}),h=await folder.getFileHandle(${JSON.stringify(name)},{create:true}),w=await h.createWritable();await w.write(Uint8Array.from(atob(${JSON.stringify(Buffer.from(bytes).toString('base64'))}),c=>c.charCodeAt(0)));await w.close();window.showOpenFilePicker=async()=>[h];})()`);
  await clickLibraryImport(page);
  // Aliases deliberately share bytes. Use the real duplicate dialog, not a new
  // source identity or a bypass of the ordinary import path.
  await page.waitFor(`(async()=>{const rows=await(await import('./src/storage.js')).listDocuments();return !!document.querySelector('dialog[open] [data-duplicate-import]')||rows.some(r=>r.name===${JSON.stringify(name)});})()`,30000);
  if(await page.evaluate("!!document.querySelector('dialog[open] [data-duplicate-import]')"))await page.click('dialog[open] [data-duplicate-import] [value=new]');
  await saved(page,name);
}
async function saved(page,name,condition='true'){
  await page.waitFor(`(async()=>{const s=await import('./src/storage.js'),row=(await s.listDocuments()).find(r=>r.name===${JSON.stringify(name)});window.__parityRecord=row?await s.getDocument(row.id):null;return window.__parityRecord&&(${condition})&&${frame}?.style.visibility==='visible'&&!document.querySelector('.tab-dirty:not([hidden])');})()`,30000);
}
async function viewport(page,width){
  await page.send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:width<600});
  await page.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:1,y:1});
  await page.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
}
const metricCode=`const props=['fontFamily','fontSize','fontWeight','lineHeight','letterSpacing','backgroundColor','color','borderColor','borderWidth','borderRadius','paddingLeft','paddingRight','appearance'];const metric=node=>{const s=node.ownerDocument.defaultView.getComputedStyle(node),r=node.getBoundingClientRect();return {...Object.fromEntries(props.map(p=>[p,s[p]])),width:Math.round(r.width*100)/100,height:Math.round(r.height*100)/100};};`;
async function profile(page){
  return page.evaluate(`(()=>{${metricCode}const b=${bar},s=document.querySelector('#sidebar'),r=b.getBoundingClientRect();return {height:r.height,left:r.left,top:r.top,width:r.width,chrome:document.querySelector('.chrome').getBoundingClientRect().bottom,gap:getComputedStyle(b).gap,controls:[...b.querySelectorAll('button,select')].map(n=>({action:n.dataset.action||'theme',icon:n.querySelector('svg')?.outerHTML||'',...metric(n)})),floating:[...document.querySelectorAll('#toolbar button[data-action]')].map(n=>({action:n.dataset.action,width:n.getBoundingClientRect().width,height:n.getBoundingClientRect().height,font:getComputedStyle(n).fontSize})),sidebar:{height:s.querySelector('.sidebar-views').getBoundingClientRect().height,padding:getComputedStyle(s.querySelector('.sidebar-content')).padding,tabs:[...s.querySelectorAll('.sidebar-views button')].map(n=>({view:n.dataset.sidebarView||'close',icon:n.querySelector('svg')?.outerHTML||'',...metric(n)}))},overflow:document.documentElement.scrollWidth>innerWidth};})()`);
}
async function installSpeech(page){
  await page.evaluate(`(()=>{window.__paritySpoken=[];window.SpeechSynthesisUtterance=class{constructor(text){this.text=text;}};const engine=new EventTarget();engine.getVoices=()=>[];engine.cancel=()=>{};engine.speak=u=>{window.__paritySpoken.push(u.text);setTimeout(()=>u.onstart?.(),0);};Object.defineProperty(window,'speechSynthesis',{configurable:true,value:engine});})()`);
}
const html='<!doctype html><html><head><title>공통 도구 검사</title></head><body><header class="header"><strong>문서 제목</strong><form><input type="search"><button type="button">사이트 검색</button></form></header><main><h1>첫 장</h1><p>검색하는 한국어 본문입니다.</p><h2>첫 절</h2><p>두 번째 문장입니다.</p><h3>작은 절</h3><p>남겨 둘 문장입니다.</p><h1>둘째 장</h1><p>마지막 본문입니다.</p></main></body></html>';
const mhtml='MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="parity"\r\n\r\n--parity\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\nContent-Location: https://example.invalid/parity\r\n\r\n'+Buffer.from(html).toString('base64')+'\r\n--parity--\r\n';

test('real Chrome: Pages-only every format shares MemoSuite toolbar sizes, sidebar, annotations, bookmarks and TTS',{timeout:420000},async()=>{
  const env=await environment();let chrome;const results=[];
  try{
    chrome=await launchChrome();const page=chrome.page;await page.navigate(env.url);await installSpeech(page);
    const fixtures={html:Buffer.from(html),htm:Buffer.from(html+'\n'),mhtml:Buffer.from(mhtml),mht:Buffer.from(mhtml),pdf:await readFile(join(root,'tests/fixtures/unified-reader.pdf')),...await officeFixtures(),...await ebookFixtures()};
    assert.deepEqual(Object.keys(fixtures).sort(),[...DOCUMENT_EXTENSIONS].sort());
    const baseline={};
    for(const [format,bytes] of Object.entries(fixtures)){
      const name='공통 화면.'+format;await viewport(page,1280);await chooseFile(page,bytes,name);
      assert.equal(await page.evaluate(`!!${bar}?.querySelector('[data-action=previous-heading]')`),true,format+' complete toolbar');
      await page.click(control('zoom'));await page.click('#zoom-reset');await saved(page,name);
      for(const width of [1280,390,320]){
        await viewport(page,width);const actual=await profile(page);
        if(format==='html')baseline[width]=actual;
        else assert.deepEqual(actual,baseline[width],format+' shared geometry and CSS at '+width);
        assert.equal(actual.height,24);assert.equal(actual.left,0);assert.equal(actual.top,actual.chrome);assert.equal(actual.width,width);assert.equal(actual.overflow,false);
      }
      await viewport(page,1280);
      const title=await page.evaluate(`${bar}.querySelector('.reader-title').textContent`);assert.ok(title);
      // Opening the same player is always silent; only Play starts reading.
      const before=await page.evaluate('window.__paritySpoken.length');await page.click(control('speak'));await page.waitFor('!!document.querySelector(".mstts-player")');assert.equal(await page.evaluate('window.__paritySpoken.length'),before);
      if(format!=='cbz'){await page.click('.mstts-player [aria-label="소리내어 읽기"]');await page.waitFor('window.__paritySpoken.length>'+before);}
      await page.click('.mstts-player [aria-label="플레이어 닫기"]');
      // The HTML fallback, PDF and all converted formats use the same settings.
      await page.evaluate(`(()=>{const s=${bar}.querySelector('[data-reading-theme]');s.value='dark';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);await saved(page,name,'window.__parityRecord.metadata.view.readingTheme==="dark"');
      assert.equal(await page.evaluate(`${bar}.dataset.theme`),'dark');
      assert.equal(await page.evaluate(`${frame}.contentWindow.getComputedStyle(${doc}.body).backgroundColor`),format==='pdf'?'rgb(27, 30, 37)':'rgb(20, 22, 27)',format+' dark paper');
      await page.evaluate(`(()=>{const s=${bar}.querySelector('[data-reading-theme]');s.value='light';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await page.click(control('font-larger'));await saved(page,name,'window.__parityRecord.metadata.view.fontScale===1.1');assert.equal(await page.evaluate(`${bar}.getBoundingClientRect().height`),24);
      if(format!=='cbz'){
        const selected=await page.evaluate(`(async()=>{const d=${doc},{textIndex,rangeFromOffsets}=await import('./src/document.js'),index=textIndex(d),root=d.querySelector('[data-office-text],.textLayer span,article p,main p,main h1')||d.body,runs=index.nodes.filter(n=>root.contains(n.node)),run=runs.find(n=>{if(!n.node.textContent.trim())return false;const r=d.createRange();r.selectNodeContents(n.node);return r.getBoundingClientRect().height>0;});if(!run)throw Error('No selectable body text');const end=Math.min(run.start+8,runs.at(-1).end),range=rangeFromOffsets(d,run.start,end,index);d.getSelection().removeAllRanges();d.getSelection().addRange(range);d.dispatchEvent(new Event('selectionchange'));return d.getSelection().toString();})()`);assert.ok(selected);
        await page.click('#toolbar [data-action=highlight]');await saved(page,name,'window.__parityRecord.metadata.annotations.length===1');
        assert.equal(await page.evaluate('document.querySelector("#sidebar [data-sidebar-count=annotations]").textContent'),'1');
      }
      await page.click('#sidebar [data-sidebar-view=bookmarks]');await page.click('#add-bookmark');await page.evaluate("document.querySelector('#note-text').value='공통 북마크'");await page.click('.note-form button[value=save]');await saved(page,name,'window.__parityRecord.metadata.bookmarks.length===1');
      assert.equal(await page.evaluate('document.querySelector("#sidebar [data-sidebar-count=bookmarks]").textContent'),'1');
      await page.click('#sidebar [data-bookmark-group] > summary');assert.equal(await page.evaluate('document.querySelectorAll("#sidebar [data-bookmark-group][open]").length>0'),true);await page.click('#sidebar [data-sidebar-view=bookmarks]');assert.equal(await page.evaluate('document.querySelectorAll("#sidebar [data-bookmark-group][open]").length'),0);
      await page.click('#sidebar [data-sidebar-view=outline]');
      if(['html','pdf','docx','xlsx','pptx','hwpx','epub','cbz','txt'].includes(format)){
        await viewport(page,320);await writeFile(join(root,'test-results/pages-only-format-parity-'+format+'-320.png'),await page.screenshot());
      }
      results.push({format,widths:[1280,390,320],toolbar:true,sidebar:true,theme:true,font:true,annotation:format==='cbz'?'existing image drawing tests':true,bookmark:true,tts:format==='cbz'?'image only; no OCR':true});
    }
    assert.deepEqual(chrome.errors,[]);await writeFile(join(root,'test-results/pages-only-format-parity.json'),JSON.stringify({status:'pass',formats:results,baseline,errors:[]},null,2));
  }catch(error){if(chrome){await writeFile(join(root,'test-results/pages-only-format-parity-failure.png'),await chrome.page.screenshot());await writeFile(join(root,'test-results/pages-only-format-parity-failure.json'),JSON.stringify({completed:results,error:error.stack,state:await chrome.page.evaluate('({toast:document.querySelector("#toast")?.textContent,tab:document.querySelector(".tab.document.active")?.textContent})')},null,2));}throw error;}
  finally{await chrome?.close();await env.close();}
});

test('real Chrome: Pages-only common outline folding and horizontal search match HTML reading behavior',{timeout:120000},async()=>{
  const env=await environment();let chrome;
  try{
    chrome=await launchChrome();const page=chrome.page;await page.navigate(env.url);await chooseFile(page,Buffer.from(html),'계층 목차.html');
    assert.equal(await page.evaluate('document.querySelectorAll("#sidebar [data-outline-group]").length'),2);
    await page.click('#sidebar [data-heading="2"]');assert.equal(await page.evaluate(`document.querySelector('#sidebar [data-heading="2"]').getAttribute('aria-current')`),'location');
    await page.click('#sidebar [data-sidebar-view=outline]');assert.equal(await page.evaluate('document.querySelectorAll("#sidebar [data-outline-group][open]").length'),0);
    await page.click('#sidebar [data-sidebar-view=search]');await page.click('#sidebar [data-sidebar-view=outline]');assert.equal(await page.evaluate('document.querySelectorAll("#sidebar [data-outline-group][open]").length'),0);
    const arrow=await page.evaluate("(()=>{const r=document.querySelector('#sidebar [data-outline-group=\"0\"] > summary').getBoundingClientRect();return {x:r.left+8,y:r.top+r.height/2};})()");
    for(const type of ['mousePressed','mouseReleased'])await page.send('Input.dispatchMouseEvent',{type,...arrow,button:'left',clickCount:1});
    await page.click('#sidebar [data-heading="0"]');assert.equal(await page.evaluate(`document.querySelector('#sidebar [data-outline-group="0"]').open`),true,'heading navigation does not toggle disclosure');
    const csv=Array.from({length:40},(_,i)=>i===39?'숨은열검색':'열'+i).join(',')+'\n'+Array.from({length:40},(_,i)=>i).join(',');await chooseFile(page,Buffer.from(csv),'가로 검색.csv');
    await page.click('#sidebar [data-sidebar-view=search]');await page.evaluate("const i=document.querySelector('#book-search');i.value='숨은열검색';i.dispatchEvent(new Event('input'))");await page.waitFor('!!document.querySelector("[data-whole-search-index]")');await page.click('[data-whole-search-index="0"]');
    const visible=await page.evaluate(`(()=>{const d=${doc},box=d.querySelector('.office-table-scroll'),hit=d.querySelector('[data-htmlmemo-book-search-hit]').getBoundingClientRect(),r=box.getBoundingClientRect();return {left:box.scrollLeft,inside:hit.left>=r.left&&hit.right<=r.right};})()`);assert.ok(visible.left>0);assert.equal(visible.inside,true);
    await writeFile(join(root,'test-results/pages-only-format-parity-search.png'),await page.screenshot());
    assert.deepEqual(chrome.errors,[]);await writeFile(join(root,'test-results/pages-only-format-parity-navigation.json'),JSON.stringify({status:'pass',hierarchicalOutline:true,collapseRetained:true,headingClickKeepsGroup:true,horizontalSearch:visible,errors:[]},null,2));
  }finally{await chrome?.close();await env.close();}
});

test('real Chrome: Pages-only MemoSuite book and fallback sidebar share tab, search and bookmark presentation',{timeout:120000},async()=>{
  const env=await environment();let chrome;
  try{
    chrome=await launchChrome();const page=chrome.page;await viewport(page,1280);await page.navigate(env.url);
    const reference=(await readFile(join(root,'tests/fixtures/source-toolbar.html'),'utf8')).replace('<h2>목차</h2>','<h2>목차</h2><input placeholder="책 전체 검색" aria-label="책 전체 검색어">').replace('</style>','#reader-shade{display:none}body.toc-open #reader-shade{display:block;position:fixed;inset:0;z-index:5;background:#0006}</style>').replace('</body>','<button id="reader-shade" aria-label="목차 닫기"></button></body>');
    await chooseFile(page,Buffer.from(reference),'MemoSuite 도구줄.html');await page.evaluate(`${doc}.querySelector('[data-action=zoom]').click()`);await page.click('#zoom-reset');
    const native=doc+`.querySelector('[data-htmlmemo-doc-sidebar-ui]')`;
    const sidebarMetric=expression=>page.evaluate(`(()=>{${metricCode}const p=${expression};return {tabs:[...p.querySelectorAll('.sidebar-views button')].map(n=>({key:n.dataset.sidebarView||'close',...metric(n)})),fields:[...p.querySelectorAll('input')].map(metric),add:p.querySelector('.bookmark-add-button')?metric(p.querySelector('.bookmark-add-button')):null};})()`);
    await page.evaluate(`${native}.querySelector('[data-sidebar-view=search]').click()`);const nativeSearch=await sidebarMetric(native);
    assert.equal(nativeSearch.fields.length,2);assert.ok(nativeSearch.tabs.every(tab=>tab.height===24));
    await page.evaluate(`${native}.querySelector('[data-sidebar-view=bookmarks]').click()`);const nativeBookmarks=await sidebarMetric(native);
    const scaleStates=[];
    for(const width of [1280,390,320]){
      await viewport(page,width);if(width<600)await page.evaluate(`${doc}.body.classList.add('toc-open')`);
      for(const percent of [25,50,100,125,200]){
        await page.evaluate(`${doc}.querySelector('[data-action=zoom]').click()`);await page.waitFor('!document.querySelector("#tool-popover").hidden');
        await page.evaluate(`(()=>{const i=document.querySelector('#zoom-value');i.value=${JSON.stringify(String(percent))};i.dispatchEvent(new Event('change',{bubbles:true}));})()`);await page.click('[data-popover-close]');
        await page.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        const state=await page.evaluate(`(()=>{const f=${frame},d=f.contentDocument,fr=f.getBoundingClientRect(),s=fr.width/f.offsetWidth,b=d.querySelector('[data-htmlmemo-doc-topbar]').getBoundingClientRect(),n=d.querySelector('#reader-nav').getBoundingClientRect(),p=d.querySelector('[data-htmlmemo-doc-sidebar-ui] .sidebar-views').getBoundingClientRect(),button=d.querySelector('[data-action=speak]'),r=button.getBoundingClientRect();return {width:innerWidth,percent:${percent},header:b.height*s,headerWidth:b.width*s,headerLeft:fr.left+b.left*s,headerTop:fr.top+b.top*s,chrome:document.querySelector('.chrome').getBoundingClientRect().bottom,sidebar:n.width*s,tabs:p.height*s,button:r.height*s,speakReachable:d.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest('[data-action=speak]')===button};})()`);
        assert.ok(Math.abs(state.header-24)<.2,JSON.stringify(state));assert.ok(Math.abs(state.headerWidth-width)<1,JSON.stringify(state));assert.ok(Math.abs(state.headerLeft)<1,JSON.stringify(state));assert.ok(Math.abs(state.headerTop-state.chrome)<1,JSON.stringify(state));assert.ok(Math.abs(state.sidebar-Math.min(300,width-40))<1,JSON.stringify(state));assert.ok(Math.abs(state.tabs-25)<.2,JSON.stringify(state));assert.ok(Math.abs(state.button-20)<.2,JSON.stringify(state));assert.equal(state.speakReachable,true,JSON.stringify(state));scaleStates.push(state);
      }
    }
    await page.evaluate(`${doc}.body.classList.remove('toc-open')`);await viewport(page,1280);await page.evaluate(`${doc}.querySelector('[data-action=zoom]').click()`);await page.click('#zoom-reset');
    await chooseFile(page,Buffer.from(html),'공통 사이드바.html');await page.click(control('zoom'));await page.click('#zoom-reset');
    await page.click('#sidebar [data-sidebar-view=search]');const sharedSearch=await sidebarMetric('document.querySelector("#sidebar")');
    assert.deepEqual(sharedSearch,nativeSearch,'source and fallback search fields and tabs have the same dimensions, fonts and colors');
    await page.click('#sidebar [data-sidebar-view=bookmarks]');const sharedBookmarks=await sidebarMetric('document.querySelector("#sidebar")');assert.deepEqual(sharedBookmarks,nativeBookmarks);
    await writeFile(join(root,'test-results/pages-only-format-parity-sidebar-1280.png'),await page.screenshot());
    assert.deepEqual(chrome.errors,[]);await writeFile(join(root,'test-results/pages-only-format-parity-sidebar.json'),JSON.stringify({status:'pass',search:sharedSearch,bookmarks:sharedBookmarks,sourceAndFallbackMatch:true,scaleStates,errors:[]},null,2));
  }finally{await chrome?.close();await env.close();}
});
