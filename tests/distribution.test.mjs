import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareAssets, packageAssets } from '../scripts/assets.mjs';
import { compileDesign } from '../scripts/design.mjs';
import { standaloneHTML, bundleModules, assetBytes } from '../public/src/bundler.js';
import {pwaEntries,APP_FILES} from '../public/src/distribution.js';
import { PUBLIC_APP_URL } from '../public/src/install.js';
import { crc32, zipFiles } from '../public/src/zip.js';
import { serializeSettings, PREFERENCES_KEY } from '../public/src/preferences.js';
import { DOMParser } from 'linkedom';
let assets;
before(async()=>{await compileDesign();await prepareAssets();assets=await packageAssets();});
function unzip(bytes){const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),files=new Map();let offset=0;while(view.getUint32(offset,true)===0x04034b50){assert.equal(view.getUint16(offset+8,true),0);const size=view.getUint32(offset+18,true),nameLength=view.getUint16(offset+26,true),extraLength=view.getUint16(offset+28,true),name=new TextDecoder().decode(bytes.subarray(offset+30,offset+30+nameLength)),start=offset+30+nameLength+extraLength,data=bytes.subarray(start,start+size);assert.equal(crc32(data),view.getUint32(offset+14,true));assert.ok(!files.has(name));files.set(name,data);offset=start+size;}assert.equal(view.getUint32(offset,true),0x02014b50);assert.equal(view.getUint32(bytes.length-22,true),0x06054b50);assert.equal(view.getUint16(bytes.length-12,true),files.size);return files;}
const text=(files,name)=>new TextDecoder().decode(files.get(name));
const webFiles=input=>new Map(pwaEntries(input).map(entry=>[entry.name,typeof entry.data==='string'?new TextEncoder().encode(entry.data):entry.data]));
test('the development HTML contains all executable code without module or network imports',()=>{const doc=new DOMParser().parseFromString(standaloneHTML(assets),'text/html');assert.equal(doc.querySelectorAll('script[src],script[type=module],link[rel=stylesheet],link[rel=manifest]').length,0);assert.deepEqual(JSON.parse(doc.querySelector('#htmlmemo-package-assets').textContent),assets);const scripts=[...doc.querySelectorAll('script')].filter(script=>script.type!=='application/json');assert.equal(scripts.length,1);new vm.Script(scripts[0].textContent);assert.match(scripts[0].textContent,/const \$\$ =/);});
test('module packaging preserves dollar signs, aliases and module scope',()=>{const source=bundleModules({'src/app.js':{text:"import { $$ as select } from './helper.js';\nglobalThis.result=select();"},'src/helper.js':{text:"export const $$=()=> '$$';"}});const context={};vm.runInNewContext(source,context);assert.equal(context.result,'$$');assert.throws(()=>bundleModules({'src/app.js':{text:"import { missing } from './missing.js';"}}),/누락/);});
test('private documents, settings, handles and arbitrary files never enter the published app',()=>{
  const extra={...assets,documents:['PRIVATE-DOCUMENT'],preferences:{secret:'PRIVATE-SETTING'},fileHandle:{path:'PRIVATE-PATH'},app:{...assets.app,'private.html':{text:'PRIVATE-EXTRA'}}};
  const files=webFiles(extra);assert.ok(!files.has('private.html'));
  assert.ok(![...files.values()].some(bytes=>new TextDecoder().decode(bytes).includes('PRIVATE-')));
});
test('the ZIP utility retains Unicode filenames and refuses parent traversal',()=>{const files=unzip(zipFiles([{name:'앱/설정.json',data:'한글 $$'}]));assert.equal(text(files,'앱/설정.json'),'한글 $$');assert.throws(()=>zipFiles([{name:'../secret',data:'x'}]));});
test('the PWA is published at the app root with every offline resource and no installer files',()=>{
  const files=webFiles(assets);assert.equal(files.size,APP_FILES.length+2);assert.ok(files.has('.nojekyll'));assert.ok(files.has('index.html'));
  assert.ok(![...files.keys()].some(name=>/^(docs|pages)\//.test(name)||/HTMLMemo-(pages\.zip|install\.html|local\.zip)|HTMLMemo\.html/.test(name)));
  const manifest=JSON.parse(text(files,'manifest.webmanifest'));assert.equal(manifest.start_url,'./');assert.equal(manifest.scope,'./');
  const shell=JSON.parse(text(files,'sw.js').match(/const SHELL = (\[[^;]+\]);/)[1].replaceAll("'",'"'));
  for(const path of shell)assert.ok(files.has(path==='./'?'index.html':path.slice(2)),path);
  const copy=JSON.parse(text(files,'distribution.json'));assert.equal(copy.app['sw.js'].text,text(files,'sw.js'));
});
test('PWA cache versions cover app changes while retired extension input is ignored',()=>{
  const first=webFiles(assets),again=webFiles(JSON.parse(text(first,'distribution.json')));
  assert.equal(text(first,'sw.js'),text(again,'sw.js'));
  for(const changed of [
    {...assets,app:{...assets.app,'styles.css':{text:assets.app['styles.css'].text+'\nbody{color:red}'}}},
    {...assets,app:{...assets.app,'src/web.js':{text:assets.app['src/web.js'].text+'\n// Changed direct reading'}}}
  ])assert.notEqual(text(first,'sw.js').match(/const CACHE = '[^']+'/)[0],text(webFiles(changed),'sw.js').match(/const CACHE = '[^']+'/)[0]);
});
test('Pages publishes no extension transport, package, active marker or legacy extension data',()=>{
  const files=webFiles({...assets,extension:{'background.js':{text:'DO-NOT-PUBLISH-EXTENSION'}}});
  assert.equal(files.has('src/bridge.js'),false);assert.equal(files.has('downloads/HTMLMemo-chrome.zip'),false);assert.equal(JSON.parse(text(files,'distribution.json')).extension,undefined);
  assert.doesNotMatch(text(files,'index.html'),/htmlmemo-app-v1|connection-button|execution-chrome/);assert.doesNotMatch(text(files,'src/app.js'),/chrome\.runtime|bridgeAvailable|discoverBridge|htmlmemo-extension/);
  assert.ok(![...files.values()].some(bytes=>new TextDecoder().decode(bytes).includes('DO-NOT-PUBLISH-EXTENSION')));
});
test('asset preparation removes the retired extension download without requiring extension sources',async()=>{
  await writeFile(new URL('../public/downloads/HTMLMemo-chrome.zip',import.meta.url),'retired');await prepareAssets();
  await assert.rejects(access(new URL('../public/downloads/HTMLMemo-chrome.zip',import.meta.url)),{code:'ENOENT'});assert.equal(assets.extension,undefined);
});
test('a real build removes retired distribution artifacts and writes the Pages web root only',async()=>{
  await mkdir(new URL('../dist/pages/docs/',import.meta.url),{recursive:true});await mkdir(new URL('../dist/downloads/',import.meta.url),{recursive:true});
  for(const name of ['dist/downloads/HTMLMemo-pages.zip','dist/downloads/HTMLMemo-install.html','dist/pages/docs/index.html','public/downloads/HTMLMemo-pages.zip','public/downloads/HTMLMemo-install.html'])
    await writeFile(new URL('../'+name,import.meta.url),'retired');
  await promisify(execFile)(process.execPath,[new URL('../scripts/build.mjs',import.meta.url).pathname]);
  const app=await readFile(new URL('../dist/src/app.js',import.meta.url),'utf8');assert.match(app,/async function copyAppURL/);
  const script=await readFile(new URL('../dist/sw.js',import.meta.url),'utf8');
  const copy=JSON.parse(await readFile(new URL('../dist/distribution.json',import.meta.url),'utf8'));assert.equal(copy.app['sw.js'].text,script);
  for(const name of ['dist/downloads/HTMLMemo-pages.zip','dist/downloads/HTMLMemo-install.html','dist/pages','dist/HTMLMemo.html','public/downloads/HTMLMemo-pages.zip','public/downloads/HTMLMemo-install.html'])
    await assert.rejects(access(new URL('../'+name,import.meta.url)),{code:'ENOENT'});
  await assert.rejects(access(new URL('../dist/downloads/HTMLMemo-chrome.zip',import.meta.url)),{code:'ENOENT'});
  for(const name of APP_FILES)if(name!=='sw.js')assert.deepEqual(new Uint8Array(await readFile(new URL('../dist/'+name,import.meta.url))),assetBytes(assets.app[name]));
});

// Executes the real standalone bundle with a DOM model and local IndexedDB
// contract. It verifies event handlers, not Chrome rendering or OS file dialogs.
async function fileApp({address='file:///Users/beginner/HTMLMemo.html',navigator={},documents=[],localEntries=[],settings=[]}={}){
  const html=standaloneHTML(assets),doc=new DOMParser().parseFromString(html,'text/html'),blobs=[],local=new Map(localEntries);
  const selectPrototype=Object.getPrototypeOf(doc.querySelector('select'));Object.defineProperty(selectPrototype,'value',{configurable:true,get(){return this.getAttribute('data-test-value')??this.querySelector('option[selected]')?.value??this.querySelector('option')?.value??'';},set(value){this.setAttribute('data-test-value',value);}});
  Object.defineProperty(doc,'activeElement',{value:doc.body,writable:true,configurable:true});doc.defaultView.HTMLElement.prototype.focus=function(){this.ownerDocument.activeElement=this;};
  const dialog=doc.querySelector('#dialog');dialog.showModal=()=>dialog.open=true;dialog.close=()=>dialog.open=false;
  const stores=new Map([['documents',new Map(documents.map(record=>[record.id,record]))],['settings',new Map(settings)]]);
  const database={objectStoreNames:{contains:name=>stores.has(name)},createObjectStore:name=>{if(!stores.has(name))stores.set(name,new Map());return {createIndex(){}};},transaction:name=>{const tx={};tx.objectStore=()=>{const store=stores.get(name);return {getAll:()=>({result:[...store.values()]}),get:key=>({result:store.get(key)}),put:(value,key)=>{store.set(key??value.id,value);return {result:key??value.id};},delete:key=>{store.delete(key);return {};}};};queueMicrotask(()=>tx.oncomplete?.());return tx;}};
  const indexedDB={open:()=>{const request={result:database};queueMicrotask(()=>{request.onupgradeneeded?.();request.onsuccess?.();});return request;}};
  class LocalURL extends URL{static createObjectURL(blob){blobs.push(blob);return 'blob:local-test';}static revokeObjectURL(){}}
  const events=new Map();const window={addEventListener(name,fn){if(!events.has(name))events.set(name,[]);events.get(name).push(fn);},postMessage(){},dispatchEvent(){}};
  const context=vm.createContext({document:doc,window,indexedDB,localStorage:{getItem:key=>local.get(key)??null,setItem:(key,value)=>local.set(key,value)},location:new URL(address),navigator:{onLine:false,storage:{},...navigator},URL:LocalURL,Blob,File,crypto,TextEncoder,TextDecoder,Uint8Array,DataView,atob,btoa,structuredClone,Event,innerWidth:1200,innerHeight:850,matchMedia:()=>({matches:false}),setInterval(){},setTimeout(fn,ms){if(ms===800)queueMicrotask(fn);return 1;},clearTimeout(){},requestAnimationFrame:fn=>fn(),fetch:()=>{throw new Error('An embedded app must not fetch a server');}});
  const script=[...doc.querySelectorAll('script')].find(el=>el.type!=='application/json');new vm.Script(script.textContent).runInContext(context);await new Promise(resolve=>setImmediate(resolve));assert.match(doc.querySelector('#status-left').textContent,/개의 문서/);return {doc,context,blobs,local,settings:stores.get('settings'),emit:(name,event)=>events.get(name)?.forEach(fn=>fn(event))};
}
test('execution shares only the canonical URL, with no app package or installation download',async()=>{
  const copied=[];const app=await fileApp({address:'https://preview.example/app/?private=secret#note',navigator:{clipboard:{writeText:async value=>copied.push(value)}}});
  assert.equal(app.doc.querySelector('#save-page').disabled,true);app.doc.querySelector('#execution-tab').onclick();
  assert.equal(app.doc.querySelector('#share-url').value,PUBLIC_APP_URL);assert.equal(app.doc.querySelector('#shared-app-link').getAttribute('href'),PUBLIC_APP_URL);
  for(const selector of ['#pages-package','#delivery-package','#pages-status'])assert.equal(app.doc.querySelector(selector),null);
  app.doc.querySelector('#share-app').onclick();await new Promise(resolve=>setImmediate(resolve));
  app.doc.querySelector('#save-page').onclick();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(copied,[PUBLIC_APP_URL,PUBLIC_APP_URL]);assert.equal(app.blobs.length,0);assert.match(app.doc.querySelector('#share-status').textContent,/이 주소만 보내/);
  assert.equal(app.doc.querySelector('#save-page').textContent,'');assert.equal(app.doc.querySelector('#save-page').title,'URL 복사');assert.equal(app.doc.querySelector('#save-page').getAttribute('aria-label'),'URL 복사');assert.equal(app.doc.querySelector('#save-page').disabled,false);
});
test('clipboard absence or denial selects the visible URL and restores the share controls',async()=>{
  for(const navigator of [{},{clipboard:{writeText:async()=>{throw new Error('Clipboard denied');}}}]){
    const app=await fileApp({navigator});app.doc.querySelector('#execution-tab').onclick();let selected=0;
    app.doc.querySelector('#share-url').select=()=>selected++;app.doc.querySelector('#share-app').onclick();
    await new Promise(resolve=>setImmediate(resolve));assert.equal(selected,1);assert.match(app.doc.querySelector('#share-status').textContent,/직접 복사/);
    assert.equal(app.doc.querySelector('#share-app').disabled,false);assert.equal(app.doc.querySelector('#save-page').disabled,false);assert.equal(app.blobs.length,0);
  }
});
test('concurrent copy clicks request the canonical URL only once and recover both buttons',async()=>{
  let finish,calls=0;const app=await fileApp({navigator:{clipboard:{writeText:()=>{calls++;return new Promise(resolve=>finish=resolve);}}}});
  app.doc.querySelector('#execution-tab').onclick();const share=app.doc.querySelector('#share-app'),toolbar=app.doc.querySelector('#save-page');
  share.onclick();toolbar.onclick();assert.equal(calls,1);assert.equal(share.disabled,true);assert.equal(toolbar.disabled,true);
  finish();await new Promise(resolve=>setImmediate(resolve));assert.equal(share.disabled,false);assert.equal(toolbar.disabled,false);assert.equal(app.blobs.length,0);
});
test('the real app uses the same button for native installation and iPhone Chrome instructions',async()=>{
  const desktop=await fileApp({address:PUBLIC_APP_URL});let prompted=0;
  desktop.emit('beforeinstallprompt',{preventDefault(){},prompt:async()=>prompted++,userChoice:Promise.resolve({outcome:'accepted'})});
  desktop.doc.querySelector('#execution-install').onclick();await new Promise(resolve=>setImmediate(resolve));assert.equal(prompted,1);
  desktop.emit('appinstalled');assert.equal(desktop.doc.querySelector('#execution-install').textContent,'설치 완료');
  const iphone=await fileApp({address:PUBLIC_APP_URL,navigator:{userAgent:'iPhone CriOS/140'}});assert.equal(iphone.doc.querySelector('#install-button').hidden,false);
  iphone.doc.querySelector('#install-button').onclick();await new Promise(resolve=>setImmediate(resolve));assert.match(iphone.doc.querySelector('#dialog-content').textContent,/Chrome/);assert.match(iphone.doc.querySelector('#dialog-content').textContent,/공유/);assert.match(iphone.doc.querySelector('#dialog-content').textContent,/홈 화면에 추가/);
});
test('settings can be saved and reloaded through file input when native pickers are unavailable',async()=>{const app=await fileApp();app.doc.querySelector('#settings-button').onclick();app.doc.querySelector('#appearance').value='dark';app.doc.querySelector('#appearance').onchange({target:app.doc.querySelector('#appearance')});app.doc.querySelector('#settings-save').onclick();await new Promise(resolve=>setImmediate(resolve));assert.equal(JSON.parse(await app.blobs[0].text()).preferences.theme,'dark');const input=app.doc.querySelector('#settings-file-input');const file=new File([serializeSettings({theme:'system',librarySort:'title',annotation:{width:8}})],'settings.json');input.onchange({target:{files:[file],value:'settings.json'}});await new Promise(resolve=>setImmediate(resolve));const restored=JSON.parse(app.local.get(PREFERENCES_KEY));assert.equal(restored.theme,'system');assert.equal(restored.librarySort,'title');assert.equal(restored.annotation.width,8);assert.equal(app.doc.querySelector('#library-sort').value,'title:asc');});

test('library switches between persistent card and one-line list views',async()=>{const app=await fileApp(),grid=app.doc.querySelector('#document-grid'),card=app.doc.querySelector('#library-card-view'),list=app.doc.querySelector('#library-list-view');assert.equal(grid.dataset.view,'card');assert.equal(card.getAttribute('aria-pressed'),'true');list.onclick();assert.equal(grid.dataset.view,'list');assert.equal(list.getAttribute('aria-pressed'),'true');assert.equal(card.getAttribute('aria-pressed'),'false');assert.equal(JSON.parse(app.local.get(PREFERENCES_KEY)).libraryView,'list');card.onclick();assert.equal(grid.dataset.view,'card');assert.equal(JSON.parse(app.local.get(PREFERENCES_KEY)).libraryView,'card');});

test('compact cards and lists share exactly one title and source without touching stored notes',async()=>{
  const record={id:'compact',title:'로컬 LLM 학습 노트',name:'notes.html',source:'',byteSize:2048,created:1234,modified:5678,metadata:{annotations:[{id:'kept',text:'Keep this note'}],bookmarks:[{id:'mark'}],view:{scrollTop:80}}},before=structuredClone(record);
  const app=await fileApp({documents:[record]});
  for(const view of ['card','list','card']){
    app.doc.querySelector('#library-'+view+'-view').onclick();const card=app.doc.querySelector('.document-card');
    assert.equal(card.querySelectorAll('h3').length,1);assert.equal(card.querySelector('.list-title').textContent,record.title);assert.equal(card.querySelector('.list-title').title,record.title);
    assert.equal(card.querySelectorAll('.list-host').length,1);assert.equal(card.querySelector('.list-host').textContent,'로컬 HTML');assert.equal(card.textContent.split(record.title).length-1,1);assert.equal(card.textContent.split('로컬 HTML').length-1,1);
    assert.equal(card.querySelector('.card-preview, .list-details'),null);assert.equal(card.querySelector('.list-annotations').getAttribute('aria-label'),'주석 1개');
    assert.equal(card.querySelector('.list-size').textContent,'2 KB');assert.match(card.querySelector('.list-progress').textContent,/이어서 읽기/);
    assert.equal(card.querySelectorAll('[data-open]').length,1);assert.equal(card.querySelectorAll('[data-card-menu]').length,1);
  }
  assert.deepEqual(record,before);
});
test('compact library escapes full titles and sources and keeps unknown sizes and zero-note states meaningful',async()=>{
  const title='<img src=x onerror="bad()"> 아주 긴 제목 & "메모"',record={id:'escaped',title,name:'escaped.html',source:'https://www.example.test/book',created:1234,modified:5678,metadata:{annotations:[]}};
  const app=await fileApp({documents:[record]}),card=app.doc.querySelector('.document-card');
  assert.equal(card.querySelector('img'),null);assert.equal(card.querySelector('.list-title').textContent,title);assert.equal(card.querySelector('.list-title').title,title);
  assert.equal(card.querySelector('.list-host').textContent,'example.test');assert.equal(card.querySelector('.list-host').title,'example.test');
  assert.equal(card.querySelector('.list-annotations').getAttribute('aria-label'),'주석 0개');assert.equal(card.querySelector('.list-size').textContent,'HTML');assert.match(card.querySelector('.list-progress').textContent,/새 문서/);
  assert.equal(card.querySelector('[data-card-menu]').getAttribute('aria-label'),title+' 문서 메뉴');
});


test('the single header menu preserves library, web opening, HTML import, app delivery and offline About',async()=>{
  const {doc}=await fileApp();
  const click=id=>doc.querySelector(id).onclick(new Event('click'));
  assert.equal(doc.querySelector('.desk-nav,#desk-resizer,.chrome-topline,#home-button'),null);
  assert.equal(doc.querySelectorAll('#app-menu-button').length,1);
  assert.equal(doc.querySelector('#tabs').getAttribute('role'),'tablist');
  assert.ok(doc.querySelector('#tabs').closest('.addressbar'));
  assert.equal(doc.querySelector('#tabs').closest('#app-menu'),null);
  assert.equal(doc.querySelector('#open-tabs-menu'),null);
  for(const id of ['#execution-tab','#new-tab','#install-button','#web-help-button','#paste-button','#settings-button','#about-button'])assert.ok(doc.querySelector(id).closest('#app-menu'));
  assert.equal(doc.querySelector('#import-button').previousElementSibling.id,'library-tab');
  assert.equal(doc.querySelector('#library-tab').textContent,'');assert.equal(doc.querySelector('#library-tab').title,'내 서재');
  for(const id of ['#library-tab','#execution-tab','#new-tab','#import-button'])assert.ok(doc.querySelector(id).closest('header'));
  assert.equal(doc.querySelector('#library-tab').getAttribute('aria-current'),'page');
  click('#execution-tab');
  assert.equal(doc.querySelector('#execution').hidden,false);
  assert.equal(doc.querySelector('#library').hidden,true);
  assert.equal(doc.querySelector('#execution-tab').getAttribute('aria-current'),'page');
  assert.equal(doc.querySelector('#library-tab').getAttribute('aria-current'),'false');
  let focused=false;doc.querySelector('#address').focus=()=>focused=true;
  click('#new-tab');assert.equal(focused,true);
  assert.equal(doc.querySelector('#library').hidden,false);
  assert.equal(doc.querySelector('#execution').hidden,true);
  click('#execution-tab');click('#library-tab');
  assert.equal(doc.querySelector('#library').hidden,false);
  assert.equal(doc.querySelector('#library-tab').getAttribute('aria-current'),'page');
  let picked=false;doc.querySelector('#file-input').click=()=>picked=true;
  await click('#import-button');assert.equal(picked,true);
  assert.equal(doc.querySelector('#import-button').textContent,'');assert.equal(doc.querySelector('#import-button').title,'HTML 파일 가져오기');
  assert.equal(doc.querySelector('#save-page').textContent,'');assert.equal(doc.querySelector('#save-page').title,'페이지 저장');
  click('#about-button');assert.equal(doc.querySelector('#dialog').open,true);
  assert.equal(doc.querySelector('.about-brand h3').textContent,'HTMLMemo');
  const {version}=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
  assert.equal(doc.querySelector('#app-version').textContent,version);
  assert.match(doc.querySelector('.about-brand img').getAttribute('src'),/^data:image\/svg\+xml;base64,/);
});

test('the dropdown opens without a modal and supports keyboard navigation, Escape and outside click',async()=>{
  const {doc}=await fileApp(),menu=doc.querySelector('#app-menu'),trigger=doc.querySelector('#app-menu-button');
  const key=value=>{const event=new doc.defaultView.Event('keydown',{bubbles:true,cancelable:true});event.key=value;doc.activeElement.dispatchEvent(event);};
  assert.equal(menu.hidden,true);trigger.onclick();
  assert.equal(menu.hidden,false);assert.equal(trigger.getAttribute('aria-expanded'),'true');assert.ok(!doc.querySelector('#dialog').open);
  assert.equal(doc.activeElement.id,'new-tab');key('ArrowDown');assert.equal(doc.activeElement.id,'paste-button');key('ArrowDown');assert.equal(doc.activeElement.id,'execution-tab');
  key('End');assert.equal(doc.activeElement.id,'about-button');key('Home');assert.equal(doc.activeElement.id,'new-tab');
  key('Escape');assert.equal(menu.hidden,true);assert.equal(trigger.getAttribute('aria-expanded'),'false');assert.equal(doc.activeElement,trigger);
  trigger.onclick();doc.body.dispatchEvent(new doc.defaultView.Event('pointerdown',{bubbles:true}));assert.equal(menu.hidden,true);
  trigger.onclick();doc.querySelector('#new-tab').click();assert.equal(menu.hidden,true);assert.equal(doc.activeElement.id,'address');
});

test('card and list views sort by both directions for saved date, modified date and title, and restore the selection',async()=>{
  const day=n=>Date.UTC(2026,0,n),documents=[
    {id:'a',title:'가나다',created:day(1),modified:day(6)},
    {id:'b',title:'나다라',created:day(3),modified:day(5)},
    {id:'c',title:'다라마',created:day(2),modified:day(4)}
  ].map(record=>({...record,name:record.id+'.html',source:'',metadata:{annotations:[]}}));
  const app=await fileApp({documents}),doc=app.doc;
  const select=(id,value)=>{const element=doc.querySelector(id);element.value=value;element.onchange({target:element});};
  const order=()=>[...doc.querySelectorAll('.document-card')].map(element=>element.dataset.record);
  const cases=[['created','asc',['a','c','b']],['created','desc',['b','c','a']],['modified','asc',['c','b','a']],['modified','desc',['a','b','c']],['title','asc',['a','b','c']],['title','desc',['c','b','a']]];
  for(const view of ['card','list']){
    doc.querySelector('#library-'+view+'-view').onclick();
    for(const [field,direction,expected] of cases){
      select('#library-sort',field+':'+direction);assert.deepEqual(order(),expected);
      assert.match(doc.querySelector('.list-date').getAttribute('title'),field==='created'?/^저장일:/u:/^수정일:/u);
    }
  }
  const restored=await fileApp({documents,localEntries:[...app.local]});
  assert.equal(restored.doc.querySelector('#library-sort').value,'title:desc');
  assert.equal(restored.doc.querySelector('#library-sort-direction'),null);
  assert.equal(restored.doc.querySelectorAll('#library-sort option').length,6);
  assert.equal(restored.doc.querySelector('#document-grid').dataset.view,'list');
  assert.deepEqual([...restored.doc.querySelectorAll('.document-card')].map(element=>element.dataset.record),['c','b','a']);
});

test('folder setup guides users to a subfolder and saves a handle only after an explicit picker action',async()=>{
  const app=await fileApp(),doc=app.doc,selected={kind:'directory',name:'HTMLMemo'};let options,calls=0;
  app.context.window.showDirectoryPicker=async value=>{options=value;calls++;return selected;};
  doc.querySelector('#choose-folder').onclick();assert.equal(calls,0);
  assert.match(doc.querySelector('#dialog-content').textContent,/전용 하위 폴더/);assert.match(doc.querySelector('#dialog-content').textContent,/문서\/HTMLMemo/);
  doc.querySelector('#select-storage-folder').onclick();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,1);assert.equal(options.mode,'readwrite');assert.equal(options.startIn,'documents');assert.equal(options.id,'htmlmemo-storage-v2');
  assert.equal(app.settings.get('folder'),selected);assert.equal(doc.querySelector('#dialog').open,false);assert.match(doc.querySelector('#choose-folder').textContent,/HTMLMemo 연결됨/);
});

test('folder cancellation, blocked access and failed persistence preserve the previous connection and allow retry',async()=>{
  const previous={kind:'directory',name:'Previous'},next={kind:'directory',name:'New HTMLMemo'},app=await fileApp({settings:[['folder',previous]]}),doc=app.doc;
  let fail='AbortError';app.context.window.showDirectoryPicker=async()=>{if(fail){const error=new Error('Blocked or cancelled');error.name=fail;throw error;}return next;};
  doc.querySelector('#menu-folder').onclick();
  for(const name of ['AbortError','NotAllowedError']){
    fail=name;doc.querySelector('#select-storage-folder').onclick();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(app.settings.get('folder'),previous);assert.equal(doc.querySelector('#dialog').open,true);assert.equal(doc.querySelector('#select-storage-folder').disabled,false);
    assert.match(doc.querySelector('#folder-connection-status').textContent,/하위/u);assert.match(doc.querySelector('#choose-folder').textContent,/Previous 연결됨/);
  }
  fail='';const set=app.settings.set.bind(app.settings);app.settings.set=()=>{throw Error('Storage unavailable');};
  doc.querySelector('#select-storage-folder').onclick();await new Promise(resolve=>setImmediate(resolve));assert.equal(app.settings.get('folder'),previous);assert.match(doc.querySelector('#folder-connection-status').textContent,/저장하지 못했습니다/);
  app.settings.set=set;doc.querySelector('#select-storage-folder').onclick();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(app.settings.get('folder'),next);assert.equal(doc.querySelector('#dialog').open,false);assert.match(doc.querySelector('#choose-folder').textContent,/New HTMLMemo 연결됨/);
});
