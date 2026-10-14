import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareAssets, packageAssets } from '../scripts/assets.mjs';
import { compileDesign } from '../scripts/design.mjs';
import { standaloneHTML, bundleModules, assetBytes } from '../public/src/bundler.js';
import { pwaEntries, chromeZIP, APP_FILES, EXTENSION_FILES } from '../public/src/distribution.js';
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
test('the Chrome ZIP writer retains Unicode filenames and refuses parent traversal',()=>{const files=unzip(zipFiles([{name:'앱/설정.json',data:'한글 $$'}]));assert.equal(text(files,'앱/설정.json'),'한글 $$');assert.throws(()=>zipFiles([{name:'../secret',data:'x'}]));});
test('the PWA is published at the app root with every offline resource and no installer files',()=>{
  const files=webFiles(assets);assert.equal(files.size,APP_FILES.length+3);assert.ok(files.has('.nojekyll'));assert.ok(files.has('index.html'));
  assert.ok(![...files.keys()].some(name=>/^(docs|pages)\//.test(name)||/HTMLMemo-(pages\.zip|install\.html|local\.zip)|HTMLMemo\.html/.test(name)));
  const manifest=JSON.parse(text(files,'manifest.webmanifest'));assert.equal(manifest.start_url,'./');assert.equal(manifest.scope,'./');
  const shell=JSON.parse(text(files,'sw.js').match(/const SHELL = (\[[^;]+\]);/)[1].replaceAll("'",'"'));
  for(const path of shell)assert.ok(files.has(path==='./'?'index.html':path.slice(2)),path);
  const copy=JSON.parse(text(files,'distribution.json'));assert.equal(copy.app['sw.js'].text,text(files,'sw.js'));
});
test('PWA cache versions cover app and extension changes while the same build stays stable',()=>{
  const first=webFiles(assets),again=webFiles(JSON.parse(text(first,'distribution.json')));
  assert.equal(text(first,'sw.js'),text(again,'sw.js'));
  for(const changed of [
    {...assets,app:{...assets.app,'styles.css':{text:assets.app['styles.css'].text+'\nbody{color:red}'}}},
    {...assets,extension:{...assets.extension,'background.js':{text:assets.extension['background.js'].text+'\n// New extension build'}}}
  ])assert.notEqual(text(first,'sw.js').match(/const CACHE = '[^']+'/)[0],text(webFiles(changed),'sw.js').match(/const CACHE = '[^']+'/)[0]);
});
test('the optional Chrome connection has the extension folder expected by its setup instructions',()=>{
  const files=unzip(chromeZIP(assets));assert.equal(files.size,APP_FILES.length+EXTENSION_FILES.length);
  assert.ok(files.has('extension/manifest.json'));assert.ok(files.has('extension/app/index.html'));
  const manifest=JSON.parse(text(files,'extension/manifest.json'));assert.ok(manifest.content_scripts[0].matches.includes('https://seionwon.github.io/HTMLMemo/*'));assert.ok(!manifest.content_scripts[0].matches.some(pattern=>pattern.includes('sweon.github.io')));
});
test('asset preparation leaves the optional Chrome download available on disk',async()=>{
  const bytes=new Uint8Array(await readFile(new URL('../public/downloads/HTMLMemo-chrome.zip',import.meta.url)));
  const files=unzip(bytes);assert.ok(files.has('extension/manifest.json'));assert.ok(files.has('extension/app/src/install.js'));
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
  const extension=unzip(new Uint8Array(await readFile(new URL('../dist/downloads/HTMLMemo-chrome.zip',import.meta.url))));
  assert.ok(extension.has('extension/manifest.json'));
  for(const name of APP_FILES)if(name!=='sw.js')assert.deepEqual(new Uint8Array(await readFile(new URL('../dist/'+name,import.meta.url))),assetBytes(assets.app[name]));
});

// Executes the real standalone bundle with a DOM model and local IndexedDB
// contract. It verifies event handlers, not Chrome rendering or OS file dialogs.
async function fileApp({address='file:///Users/beginner/HTMLMemo.html',navigator={}}={}){
  const html=standaloneHTML(assets),doc=new DOMParser().parseFromString(html,'text/html'),blobs=[],local=new Map();
  const selectPrototype=Object.getPrototypeOf(doc.querySelector('select'));Object.defineProperty(selectPrototype,'value',{configurable:true,get(){return this.getAttribute('data-test-value')??this.querySelector('option[selected]')?.value??this.querySelector('option')?.value??'';},set(value){this.setAttribute('data-test-value',value);}});
  const dialog=doc.querySelector('#dialog');dialog.showModal=()=>dialog.open=true;dialog.close=()=>dialog.open=false;
  const stores=new Map([['documents',new Map()],['settings',new Map()]]);
  const database={createObjectStore:name=>{if(!stores.has(name))stores.set(name,new Map());},transaction:name=>{const tx={};tx.objectStore=()=>{const store=stores.get(name);return {getAll:()=>({result:[...store.values()]}),get:key=>({result:store.get(key)}),put:(value,key)=>{store.set(key??value.id,value);return {result:key??value.id};},delete:key=>{store.delete(key);return {};}};};queueMicrotask(()=>tx.oncomplete?.());return tx;}};
  const indexedDB={open:()=>{const request={result:database};queueMicrotask(()=>{request.onupgradeneeded?.();request.onsuccess?.();});return request;}};
  class LocalURL extends URL{static createObjectURL(blob){blobs.push(blob);return 'blob:local-test';}static revokeObjectURL(){}}
  const events=new Map();const window={addEventListener(name,fn){if(!events.has(name))events.set(name,[]);events.get(name).push(fn);},postMessage(){},dispatchEvent(){}};
  const context=vm.createContext({document:doc,window,indexedDB,localStorage:{getItem:key=>local.get(key)??null,setItem:(key,value)=>local.set(key,value)},location:new URL(address),navigator:{onLine:false,storage:{},...navigator},URL:LocalURL,Blob,File,crypto,TextEncoder,TextDecoder,Uint8Array,DataView,atob,btoa,structuredClone,Event,innerWidth:1200,innerHeight:850,matchMedia:()=>({matches:false}),setInterval(){},setTimeout(fn,ms){if(ms===800)queueMicrotask(fn);return 1;},clearTimeout(){},requestAnimationFrame:fn=>fn(),fetch:()=>{throw new Error('An embedded app must not fetch a server');}});
  const script=[...doc.querySelectorAll('script')].find(el=>el.type!=='application/json');new vm.Script(script.textContent).runInContext(context);await new Promise(resolve=>setImmediate(resolve));assert.match(doc.querySelector('#status-left').textContent,/개의 문서/);return {doc,context,blobs,local,emit:(name,event)=>events.get(name)?.forEach(fn=>fn(event))};
}
test('execution shares only the canonical URL, with no app package or installation download',async()=>{
  const copied=[];const app=await fileApp({address:'https://preview.example/app/?private=secret#note',navigator:{clipboard:{writeText:async value=>copied.push(value)}}});
  assert.equal(app.doc.querySelector('#save-page').disabled,true);app.doc.querySelector('#execution-tab').onclick();
  assert.equal(app.doc.querySelector('#share-url').value,PUBLIC_APP_URL);assert.equal(app.doc.querySelector('#shared-app-link').getAttribute('href'),PUBLIC_APP_URL);
  for(const selector of ['#pages-package','#delivery-package','#pages-status'])assert.equal(app.doc.querySelector(selector),null);
  app.doc.querySelector('#share-app').onclick();await new Promise(resolve=>setImmediate(resolve));
  app.doc.querySelector('#save-page').onclick();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(copied,[PUBLIC_APP_URL,PUBLIC_APP_URL]);assert.equal(app.blobs.length,0);assert.match(app.doc.querySelector('#share-status').textContent,/이 주소만 보내/);
  assert.match(app.doc.querySelector('#save-page').textContent,/URL 복사/);assert.equal(app.doc.querySelector('#save-page').disabled,false);
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
test('settings can be saved and reloaded through file input when native pickers are unavailable',async()=>{const app=await fileApp();app.doc.querySelector('#settings-button').onclick();app.doc.querySelector('#appearance').value='dark';app.doc.querySelector('#appearance').onchange({target:app.doc.querySelector('#appearance')});app.doc.querySelector('#settings-save').onclick();await new Promise(resolve=>setImmediate(resolve));assert.equal(JSON.parse(await app.blobs[0].text()).preferences.theme,'dark');const input=app.doc.querySelector('#settings-file-input');const file=new File([serializeSettings({theme:'system',librarySort:'title',annotation:{width:8}})],'settings.json');input.onchange({target:{files:[file],value:'settings.json'}});await new Promise(resolve=>setImmediate(resolve));const restored=JSON.parse(app.local.get(PREFERENCES_KEY));assert.equal(restored.theme,'system');assert.equal(restored.librarySort,'title');assert.equal(restored.annotation.width,8);assert.equal(app.doc.querySelector('#library-sort').value,'title');});


test('Library Desk navigation preserves routes, file import and offline brand icon',async()=>{
  const {doc}=await fileApp();
  const click=id=>doc.querySelector(id).onclick(new Event('click'));
  assert.equal(doc.querySelector('#desk-library').getAttribute('aria-current'),'page');
  click('#desk-execution');
  assert.equal(doc.querySelector('#execution').hidden,false);
  assert.equal(doc.querySelector('#library').hidden,true);
  assert.equal(doc.querySelector('#desk-execution').getAttribute('aria-current'),'page');
  click('#desk-library');
  assert.equal(doc.querySelector('#library').hidden,false);
  assert.equal(doc.querySelector('#execution').hidden,true);
  let focused=false;doc.querySelector('#address').focus=()=>focused=true;
  click('#desk-browse');assert.equal(focused,true);
  let picked=false;doc.querySelector('#file-input').click=()=>picked=true;
  await click('#desk-import');assert.equal(picked,true);
  assert.match(doc.querySelector('.brand-icon img').getAttribute('src'),/^data:image\/svg\+xml;base64,/);
});

test('Library Desk vertical boundary line can be dragged with the mouse down to a narrow strip and expanded back',async()=>{
  const {doc,local}=await fileApp();
  const nav=doc.querySelector('.desk-nav'),resizer=doc.querySelector('#desk-resizer'),appRoot=doc.querySelector('#app');
  const makeEvent=(type,props={})=>Object.assign(new doc.defaultView.Event(type,{bubbles:true,cancelable:true}),props);
  assert.ok(resizer);
  assert.equal(resizer.getAttribute('role'),'separator');
  assert.equal(resizer.getAttribute('aria-orientation'),'vertical');
  assert.equal(nav.style.width,'180px');
  assert.equal(nav.classList.contains('is-strip'),false);

  // Drag the boundary line wider (180px -> 240px)
  resizer.onpointerdown({button:0,pointerId:1,clientX:180,currentTarget:resizer,preventDefault(){}});
  assert.equal(appRoot.hasAttribute('data-resizing-desk'),true);
  assert.equal(resizer.classList.contains('is-dragging'),true);
  resizer.dispatchEvent(makeEvent('pointermove',{pointerId:1,clientX:240}));
  assert.equal(nav.style.width,'240px');
  resizer.dispatchEvent(makeEvent('pointerup',{pointerId:1,clientX:240}));
  assert.equal(appRoot.hasAttribute('data-resizing-desk'),false);
  assert.equal(resizer.classList.contains('is-dragging'),false);
  assert.equal(local.get('htmlmemo-desk-nav-width-v1'),'240');

  // Drag the boundary line all the way to the left -> collapses to 8px narrow strip
  resizer.onpointerdown({button:0,pointerId:2,clientX:240,currentTarget:resizer,preventDefault(){}});
  resizer.dispatchEvent(makeEvent('pointermove',{pointerId:2,clientX:4}));
  assert.equal(nav.style.width,'8px');
  assert.equal(nav.classList.contains('is-strip'),true);
  assert.equal(nav.dataset.collapsed,'true');
  resizer.dispatchEvent(makeEvent('pointerup',{pointerId:2,clientX:4}));
  assert.equal(nav.style.width,'8px');
  assert.equal(resizer.getAttribute('aria-valuenow'),'8');
  assert.equal(local.get('htmlmemo-desk-nav-width-v1'),'8');
  for(const button of nav.querySelectorAll('button')){
    assert.equal(button.getAttribute('tabindex'),'-1');
    assert.equal(button.getAttribute('aria-hidden'),'true');
  }

  // Drag from the narrow strip itself back to the right -> expands to 165px
  nav.dispatchEvent(makeEvent('mousedown',{button:0,clientX:6}));
  doc.dispatchEvent(makeEvent('mousemove',{clientX:163}));
  doc.dispatchEvent(makeEvent('mouseup',{clientX:163}));
  assert.equal(nav.style.width,'165px');
  assert.equal(nav.classList.contains('is-strip'),false);
  assert.equal(nav.dataset.collapsed,'false');
  for(const button of nav.querySelectorAll('button')){
    assert.equal(button.hasAttribute('tabindex'),false);
    assert.equal(button.hasAttribute('aria-hidden'),false);
  }

  // Stationary click and keyboard separator controls toggle and step cleanly
  resizer.onpointerdown({button:0,pointerId:3,clientX:165,currentTarget:resizer,preventDefault(){}});
  resizer.dispatchEvent(makeEvent('pointerup',{pointerId:3,clientX:165}));
  assert.equal(nav.style.width,'8px');
  assert.equal(nav.classList.contains('is-strip'),true);
  resizer.onpointerdown({button:0,pointerId:4,clientX:8,currentTarget:resizer,preventDefault(){}});
  resizer.dispatchEvent(makeEvent('pointerup',{pointerId:4,clientX:8}));
  assert.equal(nav.style.width,'165px');
  assert.equal(nav.classList.contains('is-strip'),false);
  resizer.onkeydown({key:'Home',preventDefault(){}});
  assert.equal(nav.style.width,'8px');
  resizer.onkeydown({key:'End',preventDefault(){}});
  assert.equal(nav.style.width,'180px');
});
