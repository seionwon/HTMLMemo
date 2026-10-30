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
import {memoryFolder,settleUntil} from './folder-fixture.mjs';
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
  for(const path of APP_FILES.filter(name=>name!=='sw.js'))assert.ok(shell.includes('./'+path),'offline resource: '+path);
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
async function fileApp({address='file:///Users/beginner/HTMLMemo.html',navigator={},documents=[],localEntries=[],settings=[],firstRun=false,waitingForUpdate=false,launchQueue,directoryPicker=async()=>{throw new DOMException('Cancelled','AbortError');}}={}){
  // Model-only feature tests invoke individual handlers without native dialog modality.
  // Dedicated first-run tests and real browser tests exercise the required setup surface.
  const html=standaloneHTML(assets),doc=new DOMParser().parseFromString(html,'text/html'),blobs=[],local=new Map([...(firstRun?[]:[['htmlmemo-data-folder-welcome-v1','1']]),...localEntries]);
  const selectPrototype=Object.getPrototypeOf(doc.querySelector('select'));Object.defineProperty(selectPrototype,'value',{configurable:true,get(){return this.getAttribute('data-test-value')??this.querySelector('option[selected]')?.value??this.querySelector('option')?.value??'';},set(value){this.setAttribute('data-test-value',value);}});
  Object.defineProperty(doc,'activeElement',{value:doc.body,writable:true,configurable:true});doc.defaultView.HTMLElement.prototype.focus=function(){this.ownerDocument.activeElement=this;};
  const dialog=doc.querySelector('#dialog');dialog.showModal=()=>dialog.open=true;dialog.close=()=>dialog.open=false;
  const stores=new Map([['documents',new Map(documents.map(record=>[record.id,record]))],['settings',new Map(settings)]]);
  const database={objectStoreNames:{contains:name=>stores.has(name)},createObjectStore:name=>{if(!stores.has(name))stores.set(name,new Map());return {createIndex(){}};},transaction:names=>{const tx={};tx.objectStore=name=>{const store=stores.get(name||names);return {getAll:()=>({result:[...store.values()]}),index:field=>({getAll:key=>({result:[...store.values()].filter(value=>value[field]===key)})}),get:key=>({result:store.get(key)}),put:(value,key)=>{store.set(key??value.id,value);return {result:key??value.id};},delete:key=>{store.delete(key);return {};}};};queueMicrotask(()=>tx.oncomplete?.());return tx;}};
  let databaseOpens=0;const indexedDB={open:()=>{databaseOpens++;const request={result:database};queueMicrotask(()=>{request.onupgradeneeded?.();request.onsuccess?.();});return request;}};
  class LocalURL extends URL{static createObjectURL(blob){blobs.push(blob);return 'blob:local-test';}static revokeObjectURL(){}}
  const events=new Map();const window={addEventListener(name,fn){if(!events.has(name))events.set(name,[]);events.get(name).push(fn);},postMessage(){},dispatchEvent(){}};
  if(directoryPicker)window.showDirectoryPicker=directoryPicker;
  if(launchQueue!==undefined)window.launchQueue=launchQueue;
  const context=vm.createContext({document:doc,window,indexedDB,localStorage:{get length(){return local.size;},key:index=>[...local.keys()][index]??null,getItem:key=>local.get(key)??null,setItem:(key,value)=>local.set(key,value)},location:new URL(address),navigator:{onLine:false,storage:{},locks:{request:async(name,action)=>action()},...navigator},URL:LocalURL,Blob,File,crypto,TextEncoder,TextDecoder,Uint8Array,DataView,atob,btoa,structuredClone,Event,DOMException,innerWidth:1200,innerHeight:850,matchMedia:()=>({matches:false}),setInterval(){},setTimeout(fn,ms){if(ms===800)queueMicrotask(fn);return 1;},clearTimeout(){},requestAnimationFrame:fn=>fn(),fetch:()=>{throw new Error('An embedded app must not fetch a server');}});
  const script=[...doc.querySelectorAll('script')].find(el=>el.type!=='application/json');new vm.Script(script.textContent).runInContext(context);await new Promise(resolve=>setImmediate(resolve));if(!firstRun&&doc.querySelector('[data-folder-welcome]'))dialog.open=false;if(waitingForUpdate)assert.equal(doc.querySelector('#status-left').textContent,'새 버전을 확인하는 중…');else assert.match(doc.querySelector('#status-left').textContent,typeof directoryPicker==='function'&&typeof context.navigator.locks?.request==='function'?/개의 문서/:/Chrome/);return {doc,context,blobs,local,get databaseOpens(){return databaseOpens;},settings:stores.get('settings'),emit:(name,event)=>events.get(name)?.forEach(fn=>fn(event))};
}
function openExecution(app){app.doc.querySelector('#settings-button').onclick();app.doc.querySelector('#settings-execution').onclick();}
test('execution shares only the canonical URL, with no app package or installation download',async()=>{
  const copied=[];const app=await fileApp({address:'https://preview.example/app/?private=secret#note',navigator:{clipboard:{writeText:async value=>copied.push(value)}}});
  assert.equal(app.doc.querySelector('#save-page').disabled,true);openExecution(app);
  assert.equal(app.doc.querySelector('#share-url').value,PUBLIC_APP_URL);assert.equal(app.doc.querySelector('#shared-app-link').getAttribute('href'),PUBLIC_APP_URL);
  for(const selector of ['#pages-package','#delivery-package','#pages-status'])assert.equal(app.doc.querySelector(selector),null);
  app.doc.querySelector('#share-app').onclick();await new Promise(resolve=>setImmediate(resolve));
  app.doc.querySelector('#save-page').onclick();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(copied,[PUBLIC_APP_URL,PUBLIC_APP_URL]);assert.equal(app.blobs.length,0);assert.match(app.doc.querySelector('#share-status').textContent,/이 주소만 보내/);
  assert.equal(app.doc.querySelector('#save-page').textContent,'');assert.equal(app.doc.querySelector('#save-page').title,'URL 복사');assert.equal(app.doc.querySelector('#save-page').getAttribute('aria-label'),'URL 복사');assert.equal(app.doc.querySelector('#save-page').disabled,false);
});
test('MHTML import filters, installed file handlers and offline packaging include the archive decoder',async()=>{
  const app=await fileApp();let options;app.context.window.showOpenFilePicker=async value=>{options=value;return [];};app.doc.querySelector('#hero-import').onclick();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(Array.from(options.types[0].accept['multipart/related']),['.mhtml','.mht']);assert.equal(options.multiple,true);
  for(const suffix of ['.html','.htm','.mhtml','.mht'])assert.ok(app.doc.querySelector('#file-input').getAttribute('accept').split(',').includes(suffix));
  const files=webFiles(assets),manifest=JSON.parse(text(files,'manifest.webmanifest'));assert.deepEqual(manifest.file_handlers[0].accept['multipart/related'],['.mhtml','.mht']);assert.ok(files.has('src/mhtml.js'));assert.match(text(files,'sw.js'),/\.\/src\/mhtml\.js/);
  assert.match(text(files,'src/app.js'),/외부 사이트는 이 앱을 연 브라우저의 일반 탭에서 엽니다\.<br>브라우저의 페이지 저장에서 <strong>Webpage, Single File<\/strong>/);assert.doesNotMatch(text(files,'src/app.js'),/HTMLMemo 안에 넣지 않아 연결 거부 화면이 나오지 않습니다\./);
});
test('clipboard absence or denial selects the visible URL and restores the share controls',async()=>{
  for(const navigator of [{},{clipboard:{writeText:async()=>{throw new Error('Clipboard denied');}}}]){
    const app=await fileApp({navigator});openExecution(app);let selected=0;
    app.doc.querySelector('#share-url').select=()=>selected++;app.doc.querySelector('#share-app').onclick();
    await new Promise(resolve=>setImmediate(resolve));assert.equal(selected,1);assert.match(app.doc.querySelector('#share-status').textContent,/직접 복사/);
    assert.equal(app.doc.querySelector('#share-app').disabled,false);assert.equal(app.doc.querySelector('#save-page').disabled,false);assert.equal(app.blobs.length,0);
  }
});
test('concurrent copy clicks request the canonical URL only once and recover both buttons',async()=>{
  let finish,calls=0;const app=await fileApp({navigator:{clipboard:{writeText:()=>{calls++;return new Promise(resolve=>finish=resolve);}}}});
  openExecution(app);const share=app.doc.querySelector('#share-app'),toolbar=app.doc.querySelector('#save-page');
  share.onclick();toolbar.onclick();assert.equal(calls,1);assert.equal(share.disabled,true);assert.equal(toolbar.disabled,true);
  finish();await new Promise(resolve=>setImmediate(resolve));assert.equal(share.disabled,false);assert.equal(toolbar.disabled,false);assert.equal(app.blobs.length,0);
});
test('the real app uses the same button for native installation and iPhone Chrome instructions',async()=>{
  const desktop=await fileApp({address:PUBLIC_APP_URL});let prompted=0;
  openExecution(desktop);assert.equal(desktop.doc.querySelector('#execution').hidden,false);
  desktop.emit('beforeinstallprompt',{preventDefault(){},prompt:async()=>prompted++,userChoice:Promise.resolve({outcome:'accepted'})});
  desktop.doc.querySelector('#execution-install').onclick();await new Promise(resolve=>setImmediate(resolve));assert.equal(prompted,1);
  desktop.emit('appinstalled');assert.equal(desktop.doc.querySelector('#execution-install').textContent,'설치 완료');
  const iphone=await fileApp({address:PUBLIC_APP_URL,navigator:{userAgent:'iPhone CriOS/140'}});openExecution(iphone);assert.equal(iphone.doc.querySelector('#execution-install').hidden,false);
  iphone.doc.querySelector('#execution-install').onclick();await new Promise(resolve=>setImmediate(resolve));assert.match(iphone.doc.querySelector('#dialog-content').textContent,/Chrome/);assert.match(iphone.doc.querySelector('#dialog-content').textContent,/공유/);assert.match(iphone.doc.querySelector('#dialog-content').textContent,/홈 화면에 추가/);
});
test('execution is the only installation entry and describes both immediate URL use and optional app installation',async()=>{
  const initial=new DOMParser().parseFromString(assets.app['index.html'].text,'text/html'),app=await fileApp({address:PUBLIC_APP_URL}),doc=app.doc;
  for(const html of [initial,doc]){
    assert.equal(!!html.querySelector('#install-button'),false);assert.equal(html.querySelectorAll('#execution-install').length,1);
    assert.ok(html.querySelector('#execution-install').closest('#execution'));assert.equal(html.querySelector('#execution-install').getAttribute('role'),null);
    assert.equal(html.querySelector('#execution h1').innerHTML,'URL로 바로 쓰고,<br>앱으로도 설치.');
    assert.match(html.querySelector('.execution-description').textContent,/필요하면 앱으로 설치/);
  }
  assert.equal(doc.querySelector('#execution').hidden,true);openExecution(app);assert.equal(doc.querySelector('#execution').hidden,false);
  assert.equal(!!doc.querySelector('#dialog').open,false);assert.equal(doc.querySelector('#execution-install').textContent,'앱 설치');assert.equal(doc.querySelector('#execution-install').getAttribute('aria-label'),'앱 설치');
  doc.querySelector('#execution-install').onclick();await new Promise(resolve=>setImmediate(resolve));assert.match(doc.querySelector('#dialog-content').textContent,/페이지를 앱으로 설치/);
  assert.equal(doc.querySelector('#share-url').value,PUBLIC_APP_URL);assert.equal(app.blobs.length,0);
});
test('execution places URL sharing before a concise installation card without numbers or duplicate links',async()=>{
  const initial=new DOMParser().parseFromString(assets.app['index.html'].text,'text/html'),app=await fileApp({address:PUBLIC_APP_URL});
  for(const doc of [initial,app.doc]){
    const cards=[...doc.querySelectorAll('.execution-cards > article')];assert.equal(cards.length,2);
    assert.ok(cards[0].querySelector('#share-url'));assert.ok(cards[1].querySelector('#execution-install'));
    assert.equal(cards[0].querySelector('h2').textContent,'앱 주소 공유하기');assert.equal(cards[1].querySelector('h2'),null);
    assert.equal(cards[1].getAttribute('aria-label'),'앱 설치');assert.equal(cards[1].firstElementChild.textContent,'홈 화면에 앱 아이콘이 필요할 때 앱 설치를 선택하면 됩니다.');
    assert.equal(doc.querySelector('.execution-step,#execution-import,#execution-settings'),null);
    assert.equal(doc.querySelector('#install-message').textContent,'설치하지 않아도 앱의 URL에서 바로 사용할 수 있습니다.');
    const status=doc.querySelector('#install-status');assert.equal(status.querySelectorAll('br').length,1);assert.equal(status.lastChild.textContent,'설치를 하면 인터넷 연결 없이도 사용 가능합니다.');
  }
  assert.doesNotMatch(assets.app['src/app.js'].text,/["']#execution-(?:import|settings)["']/);
  openExecution(app);assert.equal(app.doc.querySelector('#dialog').open,false);
});
test('the single execution installation button restores its state after dismissal or failure and can retry',async()=>{
  const app=await fileApp({address:PUBLIC_APP_URL}),doc=app.doc;openExecution(app);const button=doc.querySelector('#execution-install');let finish,calls=0;
  const offline=()=>assert.ok(doc.querySelector('#install-status').textContent.endsWith('설치를 하면 인터넷 연결 없이도 사용 가능합니다.'));
  app.emit('beforeinstallprompt',{preventDefault(){},prompt:async()=>calls++,userChoice:new Promise(resolve=>finish=resolve)});
  button.onclick();assert.equal(calls,1);assert.equal(button.disabled,true);assert.equal(button.textContent,'설치 확인 중…');assert.equal(button.getAttribute('aria-label'),'설치 확인 중…');offline();
  button.onclick();assert.equal(calls,1);finish({outcome:'dismissed'});await new Promise(resolve=>setImmediate(resolve));assert.equal(button.disabled,false);assert.equal(button.textContent,'앱 설치');assert.match(doc.querySelector('#toast').textContent,/취소/);
  app.emit('beforeinstallprompt',{preventDefault(){},prompt:async()=>{throw new Error('설치 창 오류');}});button.onclick();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(button.disabled,false);assert.equal(button.textContent,'앱 설치');assert.match(doc.querySelector('#toast').textContent,/설치 창 오류/);offline();
  app.emit('beforeinstallprompt',{preventDefault(){},prompt:async()=>calls++,userChoice:Promise.resolve({outcome:'accepted'})});button.onclick();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,2);
  app.emit('appinstalled');assert.equal(button.textContent,'설치 완료');assert.equal(button.getAttribute('aria-label'),'설치 완료');assert.equal(button.hidden,false);assert.match(doc.querySelector('#install-status').textContent,/앱으로 실행 중/);offline();
  button.onclick();await new Promise(resolve=>setImmediate(resolve));assert.match(doc.querySelector('#dialog-content').textContent,/설치된 HTMLMemo/);assert.equal(calls,2);
});
test('settings can be saved and reloaded through file input when native pickers are unavailable',async()=>{const app=await fileApp();app.doc.querySelector('#settings-button').onclick();app.doc.querySelector('#appearance').value='dark';app.doc.querySelector('#appearance').onchange({target:app.doc.querySelector('#appearance')});app.doc.querySelector('#settings-save').onclick();await new Promise(resolve=>setImmediate(resolve));assert.equal(JSON.parse(await app.blobs[0].text()).preferences.theme,'dark');const input=app.doc.querySelector('#settings-file-input');const file=new File([serializeSettings({theme:'system',librarySort:'title',annotation:{width:8}})],'settings.json');input.onchange({target:{files:[file],value:'settings.json'}});await new Promise(resolve=>setImmediate(resolve));const restored=JSON.parse(app.local.get(PREFERENCES_KEY));assert.equal(restored.theme,'system');assert.equal(restored.librarySort,'title');assert.equal(restored.annotation.width,8);assert.equal(app.doc.querySelector('#library-sort').value,'title:asc');});

test('library switches between persistent card and one-line list views',async()=>{const app=await fileApp(),grid=app.doc.querySelector('#document-grid'),card=app.doc.querySelector('#library-card-view'),list=app.doc.querySelector('#library-list-view');assert.equal(grid.dataset.view,'card');assert.equal(card.getAttribute('aria-pressed'),'true');list.onclick();assert.equal(grid.dataset.view,'list');assert.equal(list.getAttribute('aria-pressed'),'true');assert.equal(card.getAttribute('aria-pressed'),'false');assert.equal(JSON.parse(app.local.get(PREFERENCES_KEY)).libraryView,'list');card.onclick();assert.equal(grid.dataset.view,'card');assert.equal(JSON.parse(app.local.get(PREFERENCES_KEY)).libraryView,'card');});

test('empty library stays hidden until a folder is connected and still preserves search messages',async()=>{
  const heading='첫 HTML 문서를 보관해보세요.';
  const initial=new DOMParser().parseFromString(assets.app['index.html'].text,'text/html');assert.equal(initial.querySelector('#empty-library h3').textContent,heading);assert.equal(initial.querySelector('#empty-library').hidden,true);
  const empty=await fileApp({firstRun:true,directoryPicker:async()=>memoryFolder()}),hint=empty.doc.querySelector('#empty-library');assert.equal(hint.hidden,true);
  empty.doc.querySelector('#library-list-view').onclick();assert.equal(hint.hidden,true);
  empty.doc.querySelector('#select-storage-folder').onclick();await settleUntil(()=>empty.doc.documentElement.dataset.storageSetup==='ready');assert.equal(hint.hidden,false);assert.equal(hint.querySelector('h3').textContent,heading);
  const selected=memoryFolder(),app=await fileApp({firstRun:true,directoryPicker:async()=>selected,documents:[{id:'kept',title:'Kept document',name:'kept.html',source:'',html:'<html><body>Kept document</body></html>',created:1234,modified:5678,metadata:{version:1,view:{},viewport:{},annotations:[],bookmarks:[]}}]}),filter=app.doc.querySelector('#library-filter');
  app.doc.querySelector('#select-storage-folder').onclick();await settleUntil(()=>app.doc.documentElement.dataset.storageSetup==='ready');
  filter.value='no match';filter.oninput();assert.equal(app.doc.querySelector('#empty-library h3').textContent,'검색 결과가 없습니다.');assert.equal(app.doc.querySelector('#empty-library').hidden,false);
  filter.value='';filter.oninput();assert.equal(app.doc.querySelector('#empty-library').hidden,true);assert.equal(app.doc.querySelectorAll('.document-card').length,1);
});

test('reopening hides the empty hint through delayed permission and folder initialization',async()=>{
  let allow,finish;const selected=memoryFolder('Delayed storage',{onWrite:name=>name==='HTMLMemo-library.json'?new Promise(resolve=>finish=resolve):undefined});
  selected.queryPermission=()=>new Promise(resolve=>allow=value=>{selected.queryPermission=async()=>value;resolve(value);});
  const app=await fileApp({firstRun:true,settings:[['folder',selected]]}),doc=app.doc,hint=doc.querySelector('#empty-library');
  assert.equal(typeof allow,'function');assert.equal(doc.documentElement.dataset.storageSetup,'checking');assert.equal(hint.hidden,true);
  allow('granted');await settleUntil(()=>typeof finish==='function');assert.equal(hint.hidden,true);assert.equal(doc.documentElement.dataset.storageSetup,'checking');
  finish();await settleUntil(()=>doc.documentElement.dataset.storageSetup==='ready');assert.equal(hint.hidden,false);
});

test('compact cards and lists share exactly one title and source without touching stored notes',async()=>{
  const record={id:'compact',title:'로컬 LLM 학습 노트',name:'notes.html',source:'',byteSize:2048,created:1234,modified:5678,metadata:{annotations:[{id:'kept',text:'Keep this note'}],bookmarks:[{id:'mark'}],view:{scrollTop:80}}},before=structuredClone(record);
  const app=await fileApp({documents:[record]});
  for(const view of ['card','list','card']){
    app.doc.querySelector('#library-'+view+'-view').onclick();const card=app.doc.querySelector('.document-card');
    assert.equal(card.querySelectorAll('h3').length,1);assert.equal(card.querySelector('.list-title').textContent,record.title);assert.equal(card.querySelector('.list-title').title,record.title);
    assert.equal(card.querySelectorAll('.list-filename').length,1);assert.equal(card.querySelector('.list-filename').textContent,record.name);assert.equal(card.querySelector('.list-filename').title,record.name);assert.equal(card.querySelector('.list-title').nextElementSibling,card.querySelector('.list-filename'));
    assert.equal(card.querySelectorAll('.list-host').length,1);assert.equal(card.querySelector('.list-host').textContent,'로컬 HTML');assert.equal(card.textContent.split(record.title).length-1,1);assert.equal(card.textContent.split('로컬 HTML').length-1,1);
    assert.equal(card.querySelector('.card-preview, .list-details'),null);assert.equal(card.querySelector('.list-annotations').getAttribute('aria-label'),'주석 1개');assert.equal(card.querySelector('.list-bookmarks').getAttribute('aria-label'),'북마크 1개');assert.equal(card.querySelector('.list-bookmarks').title,'북마크 1개');assert.equal(card.querySelector('.list-bookmarks span').textContent,'1');
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
  assert.equal(card.querySelector('.list-annotations').getAttribute('aria-label'),'주석 0개');assert.equal(card.querySelector('.list-bookmarks').getAttribute('aria-label'),'북마크 0개');assert.equal(card.querySelector('.list-bookmarks span').textContent,'0');assert.equal(card.querySelector('.list-size').textContent,'HTML');assert.match(card.querySelector('.list-progress').textContent,/새 문서/);
  assert.equal(card.querySelector('[data-card-menu]').getAttribute('aria-label'),title+' 문서 메뉴');
});
test('library filenames preserve Unicode, whitespace, extensions and markup as plain text in both views',async()=>{
  const name=' 받은 <img src=x onerror="bad()"> & "원본" 문서.MHTML ',record={id:'filename',title:'문서 제목',name,source:'',created:1234,modified:5678,metadata:{annotations:[{id:'keep'}]}},before=structuredClone(record),app=await fileApp({documents:[record]});
  for(const view of ['card','list']){app.doc.querySelector('#library-'+view+'-view').onclick();const card=app.doc.querySelector('.document-card'),file=card.querySelector('.list-filename');assert.equal(file.textContent,name);assert.equal(file.title,name);assert.equal(file.querySelector('img'),null);assert.equal(card.querySelectorAll('.list-filename').length,1);}
  const filter=app.doc.querySelector('#library-filter');filter.value='문서.mhtml';filter.oninput();assert.equal(app.doc.querySelectorAll('.document-card').length,1);assert.deepEqual(record,before);
});
test('legacy records without a filename never show undefined, null or a fabricated original name',async()=>{
  for(const name of [undefined,null,'']){const record={id:'legacy',title:'제목만 있는 문서',name,source:'',created:1234,modified:5678,metadata:{annotations:[]}},app=await fileApp({documents:[record]});for(const view of ['card','list']){app.doc.querySelector('#library-'+view+'-view').onclick();const card=app.doc.querySelector('.document-card');assert.equal(card.querySelector('.list-filename'),null);assert.equal(card.querySelector('.list-title').textContent,record.title);assert.doesNotMatch(card.textContent,/undefined|null/);}}
});


test('cards and lists expose folders, full breadcrumbs and a collapsible hierarchy without losing filenames',async()=>{
  const folders=[{id:'books',parentId:'',name:'책 & 자료'},{id:'part',parentId:'books',name:'1부'},{id:'empty',parentId:'',name:'빈 폴더'}],record={id:'nested',title:'안쪽 문서',name:'받은 파일.mhtml',folderId:'part',source:'',created:100,modified:200,metadata:{annotations:[{id:'keep'}]}},app=await fileApp({documents:[record],settings:[['library-folders-v1',folders]]}),doc=app.doc;
  assert.equal(doc.querySelectorAll('.document-card').length,0);assert.equal(doc.querySelectorAll('.library-folder-card').length,2);assert.equal(doc.querySelector('#library-folder-tree').hidden,false);assert.match(doc.querySelector('#library-folder-tree').textContent,/전용 폴더.*root.*책 & 자료.*1부/);
  doc.querySelector('[data-folder-toggle="books"]').click();assert.equal(doc.querySelector('#library-folder-tree [data-library-folder="part"]'),null);doc.querySelector('[data-folder-toggle="books"]').click();doc.querySelector('#library-folder-tree [data-library-folder="part"]').click();
  for(const view of ['card','list']){doc.querySelector('#library-'+view+'-view').onclick();assert.equal(doc.querySelector('.list-filename').textContent,'받은 파일.mhtml');assert.equal(doc.querySelectorAll('.document-card').length,1);assert.match(doc.querySelector('#library-breadcrumbs').textContent,/전용 폴더.*책 & 자료.*1부/);}
  doc.querySelector('#library-folder-up').onclick();assert.equal(doc.querySelectorAll('.document-card').length,0);assert.equal(doc.querySelector('.library-folder-card strong').textContent,'1부');assert.deepEqual(record.metadata.annotations,[{id:'keep'}]);
  const filter=doc.querySelector('#library-filter');filter.value='받은 파일';filter.oninput();assert.equal(doc.querySelectorAll('.document-card').length,1);assert.match(doc.querySelector('.list-progress').title,/책 & 자료 \/ 1부/);assert.equal(doc.querySelector('#library-search-scope').hidden,false);
});
test('nonempty folder deletion is disabled and move destinations exclude self and descendants',async()=>{
  const folders=[{id:'books',parentId:'',name:'책'},{id:'part',parentId:'books',name:'1부'}],app=await fileApp({settings:[['library-folders-v1',folders]]}),doc=app.doc;
  doc.querySelector('[data-folder-menu="books"]').click();assert.equal(doc.querySelector('#folder-menu-delete').hasAttribute('disabled'),true);doc.querySelector('#folder-menu-move').onclick();assert.deepEqual([...doc.querySelectorAll('#library-folder-destination option')].map(o=>o.value),['']);assert.equal(doc.querySelector('#library-move-save').hasAttribute('disabled'),true);
  doc.querySelector('#dialog').close();doc.querySelector('#library-new-folder').onclick();assert.equal(doc.querySelector('#library-folder-name').getAttribute('maxlength'),'100');assert.equal(doc.querySelector('#library-folder-form').querySelector('h2').textContent,'새 폴더');
});
test('library trash keeps ordinary counts separate, shows original filenames and folders, and returns to the selected folder',async()=>{
  const folders=[{id:'part',parentId:'',name:'읽는 책'}],active={id:'active',title:'활성 문서',name:'active.html',folderId:'part',metadata:{annotations:[]}},trashed={id:'trashed',title:'삭제한 문서',name:'받은 원본.mhtml',folderId:'part',trashedAt:10000,metadata:{annotations:[{id:'kept'}],bookmarks:[{id:'mark'}]}},before=structuredClone(trashed);
  const {doc}=await fileApp({documents:[active,trashed],settings:[['library-folders-v1',folders]]});assert.equal(doc.querySelector('#document-count').textContent,'1');assert.equal(doc.querySelector('#library-trash small').textContent,'1');
  doc.querySelector('[data-library-folder=part]').click();assert.equal(doc.querySelectorAll('[data-open]').length,1);doc.querySelector('#library-trash').onclick();
  assert.equal(doc.querySelector('#library .library-heading h2').textContent,'휴지통 1');assert.equal(doc.querySelector('#library-trash').getAttribute('aria-pressed'),'true');assert.equal(doc.querySelectorAll('[data-open],[data-card-menu]').length,0);assert.equal(doc.querySelector('.document-card').getAttribute('draggable'),'false');assert.equal(doc.querySelector('.list-filename').textContent,'받은 원본.mhtml');assert.match(doc.querySelector('.list-progress').title,/읽는 책/);assert.match(doc.querySelector('.list-date').title,/삭제일/);assert.equal(doc.querySelector('#library-folder-tree').hidden,true);assert.equal(doc.querySelector('#library-new-folder').hidden,true);assert.equal(doc.querySelector('#library-trash-info').hidden,false);assert.equal(doc.querySelector('#library-sort').value,'trashedAt:desc');
  doc.querySelector('[data-trash-menu]').click();assert.ok(doc.querySelector('#trash-restore'));assert.ok(doc.querySelector('#trash-delete'));assert.match(doc.querySelector('#dialog').textContent,/주석.*북마크.*저장 이력/);doc.querySelector('#dialog').close();
  const filter=doc.querySelector('#library-filter');filter.value='원본';filter.oninput();assert.equal(doc.querySelectorAll('.document-card').length,1);filter.value='없는검색어';filter.oninput();assert.equal(doc.querySelectorAll('.document-card').length,0);
  doc.querySelector('#library-folder-up').onclick();assert.equal(doc.querySelector('#library-trash').getAttribute('aria-pressed'),'false');assert.equal(doc.querySelector('[data-open]').dataset.open,'active');assert.equal(doc.querySelector('#library-folder-tree').hidden,false);assert.deepEqual(trashed,before);
});
test('empty trash offers no example or destructive action and keeps HTML import available',async()=>{
  const {doc}=await fileApp();doc.querySelector('#library-trash').onclick();assert.equal(doc.querySelector('#empty-library h3').textContent,'휴지통이 비어 있습니다.');assert.equal(doc.querySelector('#open-example').hidden,true);assert.equal(doc.querySelector('#library-empty-trash').disabled,true);assert.equal(doc.querySelector('#hero-import').hidden,false);assert.equal(doc.querySelector('#document-count').textContent,'0');
  doc.querySelector('#library-trash').onclick();assert.equal(doc.querySelector('#library-empty-trash').hidden,true);assert.equal(doc.querySelector('#empty-library h3').textContent,'첫 HTML 문서를 보관해보세요.');
});
test('the settings icon preserves library, web opening, HTML import, app delivery and offline About without a menu',async()=>{
  const {doc}=await fileApp();
  const click=id=>doc.querySelector(id).onclick(new Event('click'));
  assert.equal(doc.querySelector('.desk-nav,#desk-resizer,.chrome-topline,#home-button'),null);
  assert.equal(!!doc.querySelector('#app-menu-button,#app-menu,#execution-tab,#about-button'),false);
  assert.equal(doc.querySelectorAll('#settings-button').length,1);
  assert.equal(doc.querySelector('#tabs').getAttribute('role'),'tablist');
  assert.ok(doc.querySelector('#tabs').closest('.addressbar'));
  assert.equal(doc.querySelector('#tabs').closest('#app-menu'),null);
  assert.equal(doc.querySelector('#open-tabs-menu'),null);
  assert.ok(doc.querySelector('#settings-button').closest('.addressbar'));
  assert.equal(doc.querySelector('#install-button'),null);
  assert.equal(!!doc.querySelector('#app-menu #web-help-button'),false);assert.ok(doc.querySelector('#library #web-help-button'));
  assert.equal(!!doc.querySelector('#new-tab,#app-menu #paste-button'),false);
  assert.equal(doc.querySelector('#import-button'),null);
  assert.equal(doc.querySelector('#save-page').previousElementSibling.id,'library-tab');
  assert.equal(doc.querySelector('#library-tab').textContent,'');assert.equal(doc.querySelector('#library-tab').title,'내 서재');
  for(const id of ['#library-tab','#settings-button','#save-page'])assert.ok(doc.querySelector(id).closest('header'));
  assert.deepEqual([...doc.querySelectorAll('#library .hero-actions button')].map(button=>button.id),['hero-import','paste-button']);
  assert.ok(doc.querySelector('#hero-import').closest('#library'));assert.equal(doc.querySelector('#hero-import').textContent,'HTML 파일 가져오기');
  assert.equal(!!doc.querySelector('#choose-folder,#menu-folder'),false);
  assert.equal(doc.querySelector('#library-tab').getAttribute('aria-current'),'page');
  click('#settings-button');
  for(const id of ['#settings-help','#settings-execution','#settings-about'])assert.ok(doc.querySelector(id).closest('#dialog'));
  assert.equal(doc.querySelector('#settings-execution').previousElementSibling.id,'settings-help');
  click('#settings-help');assert.equal(doc.querySelector('.help-browser h2').textContent,'HTMLMemo 도움말');
  const helpSearch=doc.querySelector('#help-search');helpSearch.value='데이터 복원';helpSearch.oninput({isComposing:false});assert.ok(doc.querySelector('.help-results'));
  click('#help-back-settings');assert.equal(doc.activeElement.id,'settings-help');
  click('#settings-execution');
  assert.equal(doc.querySelector('#dialog').open,false);
  assert.equal(doc.querySelector('#execution').hidden,false);
  assert.equal(doc.querySelector('#library').hidden,true);
  assert.equal(doc.querySelector('#library-tab').getAttribute('aria-current'),'false');
  click('#library-tab');assert.equal(doc.querySelector('#browse-start'),null);
  assert.equal(doc.querySelector('#library').hidden,false);
  assert.equal(doc.querySelector('#execution').hidden,true);
  openExecution({doc});click('#library-tab');
  assert.equal(doc.querySelector('#library').hidden,false);
  assert.equal(doc.querySelector('#library-tab').getAttribute('aria-current'),'page');
  let picked=false;doc.querySelector('#file-input').click=()=>picked=true;
  await click('#hero-import');assert.equal(picked,true);
  assert.equal(doc.querySelector('#save-page').textContent,'');assert.equal(doc.querySelector('#save-page').title,'페이지 저장');
  click('#settings-button');click('#settings-about');assert.equal(doc.querySelector('#dialog').open,true);
  assert.equal(doc.querySelector('.about-brand h3').textContent,'HTMLMemo');
  const {version}=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
  assert.equal(doc.querySelector('#app-version').textContent,version);
  assert.match(doc.querySelector('.about-brand img').getAttribute('src'),/^data:image\/svg\+xml;base64,/);
});

test('settings is a single labelled icon and help, delivery and About preserve existing documents and preferences',async()=>{
  const record={id:'kept-settings',title:'기존 문서',name:'kept.html',created:1234,modified:5678,metadata:{annotations:[{id:'note',text:'보존할 주석'}],bookmarks:[{id:'mark'}]}},before=structuredClone(record),app=await fileApp({documents:[record]}),{doc}=app,trigger=doc.querySelector('#settings-button');
  assert.equal(trigger.textContent,'');assert.ok(trigger.querySelector('svg'));assert.equal(trigger.title,'설정');assert.equal(trigger.getAttribute('aria-label'),'설정');assert.equal(trigger.getAttribute('aria-haspopup'),'dialog');assert.equal(trigger.getAttribute('aria-controls'),'dialog');assert.equal(trigger.getAttribute('aria-expanded'),null);
  assert.equal(trigger.previousElementSibling.id,'save-page');assert.equal(trigger.nextElementSibling,null);
  trigger.onclick();assert.equal(doc.querySelector('#dialog').open,true);assert.equal(doc.querySelector('#dialog h2').textContent,'HTMLMemo 설정');
  const group=doc.querySelector('.settings-app-actions');assert.equal(group.previousElementSibling.className,'dialog-heading');
  assert.deepEqual([...group.querySelectorAll('button')].map(button=>button.textContent.trim()),['도움말','실행과 앱 전달','About']);
  for(const button of group.querySelectorAll('button')){assert.equal(button.getAttribute('type'),'button');assert.equal(button.getAttribute('role'),null);assert.ok(button.querySelector('svg'));}
  doc.querySelector('#settings-about').onclick();assert.equal(doc.querySelector('#dialog h2').textContent,'About');assert.ok(doc.activeElement.hasAttribute('data-dialog-close'));doc.querySelector('#dialog [data-dialog-close]').onclick();
  assert.equal(doc.querySelector('#dialog').open,false);assert.equal(doc.querySelector('#library').hidden,false);
  openExecution(app);assert.equal(doc.querySelector('#dialog').open,false);assert.equal(doc.querySelector('#execution').hidden,false);assert.equal(doc.activeElement,doc.querySelector('#execution h1'));
  doc.querySelector('#library-tab').onclick();assert.deepEqual(record,before);assert.equal(doc.querySelectorAll('.document-card').length,1);
  trigger.onclick();assert.ok(doc.querySelector('#appearance'));assert.ok(doc.querySelector('#settings-folder'));assert.ok(doc.querySelector('#settings-save'));assert.equal(doc.querySelectorAll('#settings-execution,#settings-about').length,2);
});

test('library text paste is a single ordinary action that opens the editor and cancels without changing saved notes',async()=>{
  const record={id:'kept-paste',title:'기존 문서',name:'kept.html',created:1234,modified:5678,metadata:{annotations:[{id:'note',text:'보존할 주석'}],bookmarks:[{id:'mark'}]}},before=structuredClone(record),{doc}=await fileApp({documents:[record]});
  assert.equal(doc.querySelectorAll('#paste-button').length,1);const paste=doc.querySelector('#library .hero-actions #paste-button');assert.ok(paste);assert.equal(paste.getAttribute('role'),null);assert.equal(paste.textContent,'텍스트 붙여넣기');
  paste.onclick();assert.equal(doc.querySelector('#dialog').open,true);assert.equal(doc.activeElement.id,'paste-text');assert.equal(doc.querySelector('#paste-title').value,'붙여넣은 글');assert.equal(doc.querySelector('#paste-source').value,'');
  doc.querySelector('#dialog .dialog-actions [data-dialog-close]').onclick();assert.equal(doc.querySelector('#dialog').open,false);assert.equal(doc.querySelector('#library').hidden,false);assert.equal(doc.querySelectorAll('.document-card').length,1);assert.deepEqual(record,before);
});

test('library web import guide opens the existing help and retains import, paste and saved notes',async()=>{
  const record={id:'kept-guide',title:'기존 문서',name:'kept.html',created:1234,modified:5678,metadata:{annotations:[{id:'note',text:'보존할 주석'}],bookmarks:[{id:'mark'}]}},before=structuredClone(record),{doc}=await fileApp({documents:[record]});
  const guide=doc.querySelector('#library #web-help-button');assert.ok(guide);assert.equal(doc.querySelectorAll('#web-help-button').length,1);assert.equal(guide.getAttribute('role'),null);assert.equal(guide.getAttribute('aria-haspopup'),'dialog');assert.equal(guide.textContent,'웹페이지 가져오기 안내');assert.equal(guide.parentElement,doc.querySelector('#library .hero-actions').parentElement);assert.equal(guide.getAttribute('aria-label'),'웹페이지 가져오기 안내');assert.equal(guide.title,'웹페이지 가져오기 안내');assert.equal(doc.querySelector('.library-import-help'),null);
  guide.onclick();assert.equal(doc.querySelector('#dialog').open,true);assert.equal(doc.querySelector('#dialog h2').textContent,'Chrome에서 탐색하고 여기서 메모하기');assert.ok(doc.querySelector('#web-help-import'));assert.ok(doc.querySelector('#web-help-paste'));
  doc.querySelector('#web-help-paste').onclick();assert.ok(doc.querySelector('#paste-form'));doc.querySelector('#dialog .dialog-actions [data-dialog-close]').onclick();
  let picked=0;doc.querySelector('#file-input').click=()=>picked++;guide.onclick();doc.querySelector('#web-help-import').onclick();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(picked,1);assert.equal(doc.querySelector('#dialog').open,false);assert.equal(doc.querySelector('#library').hidden,false);assert.equal(doc.querySelectorAll('.document-card').length,1);assert.deepEqual(record,before);
});

test('single-file save guidance stays in library and execution help without a persistent notice or restricting HTML files',async()=>{
  const initial=new DOMParser().parseFromString(assets.app['index.html'].text,'text/html'),app=await fileApp(),doc=app.doc;
  const check=node=>{assert.ok(node);assert.equal(node.querySelector('strong').textContent,'Webpage, Single File');assert.match(node.textContent,/브라우저.*저장/);assert.match(node.textContent,/웹페이지, 단일 파일 · \.mhtml/);};
  for(const view of [initial,doc]){assert.equal(view.querySelector('#library #single-file-notice,#library [data-single-file-guide]'),null);assert.equal(view.querySelector('#hero-import').getAttribute('aria-describedby'),null);assert.ok(view.querySelector('#file-input').getAttribute('accept').includes('.html'));}
  const openers=[()=>doc.querySelector('#web-help-button').onclick(),()=>{openExecution(app);doc.querySelector('#execution-web').onclick();}];
  for(const open of openers){open();check(doc.querySelector('#dialog [data-single-file-guide]'));assert.match(doc.querySelector('#dialog').textContent,/이미 가진 HTML 파일은 그대로 가져올 수 있습니다\./);assert.ok(doc.querySelector('#web-help-import'));assert.ok(doc.querySelector('#web-help-paste'));}
});

test('export sharing help explains one HTML file, recipient import and local-only autosave without changing saved notes',async()=>{
  const record={id:'share-guide',title:'공유 안내',name:'공유.html',created:1,modified:2,metadata:{annotations:[{id:'kept',text:'기존 주석'}],bookmarks:[{id:'kept-mark'}]}},before=structuredClone(record),app=await fileApp({documents:[record]}),doc=app.doc;
  const check=guide=>{assert.ok(guide);assert.equal(guide.hasAttribute('open'),false);assert.match(guide.querySelector('summary').textContent,/주석을 포함한 HTML 파일/);assert.equal(guide.querySelectorAll('li').length,3);assert.match(guide.textContent,/HTML 파일 하나/);assert.match(guide.textContent,/방금 내보낸 \.html 파일/);assert.match(guide.textContent,/내 서재 → HTML 파일 가져오기/);assert.match(guide.textContent,/다시 내보내세요/);assert.match(guide.textContent,/Ctrl\/⌘ S/);assert.match(guide.textContent,/앱 URL만 보내면 문서·주석은 전달되지 않습니다/);assert.match(guide.textContent,/새롭게 열기는 주석 없는 사본/);assert.equal(guide.querySelector('a').getAttribute('href'),PUBLIC_APP_URL);};
  openExecution(app);check(doc.querySelector('#execution-export-guide [data-export-guide]'));
  doc.querySelector('#library-tab').onclick();doc.querySelector('[data-card-menu="share-guide"]').click();check(doc.querySelector('#dialog [data-export-guide]'));assert.ok(doc.querySelector('#menu-export'));assert.deepEqual(record,before);
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

test('first run automatically explains folder creation in three steps without opening a native picker',async()=>{
  let calls=0;const app=await fileApp({firstRun:true,directoryPicker:async()=>{calls++;return memoryFolder();}}),doc=app.doc;
  assert.equal(doc.querySelector('#dialog').open,true);assert.ok(doc.querySelector('[data-folder-welcome]'));assert.equal(doc.querySelector('#dialog').getAttribute('aria-labelledby'),'dialog-title');
  assert.match(doc.querySelector('#dialog-title').textContent,/저장 폴더/);assert.equal(doc.querySelectorAll('.folder-welcome-steps li').length,3);
  for(const text of ['Documents','하위','원하는 이름','HTMLMemo','쓰기','허용','자동 저장','이 폴더 전체','설정'])assert.ok(doc.querySelector('[data-folder-welcome]').textContent.includes(text),text);
  assert.equal(doc.activeElement.id,'create-storage-folder');assert.equal(calls,0);assert.equal(app.settings.get('folder'),undefined);assert.equal(app.local.has('htmlmemo-data-folder-welcome-v1'),false);
  assert.match(doc.querySelector('.folder-welcome-existing').textContent,/전용 폴더 자체.*자동 복원/);
});

test('first-run setup can be canceled without marking it complete or exposing document tools',async()=>{
  const app=await fileApp({firstRun:true,localEntries:[['htmlmemo-data-folder-welcome-v1','1']],directoryPicker:async()=>memoryFolder()}),doc=app.doc;
  assert.equal(doc.querySelector('#dialog').open,true);assert.equal(doc.querySelector('#folder-welcome-later'),null);assert.ok(doc.querySelector('#cancel-folder-setup'));
  assert.equal(doc.querySelector('#dialog').oncancel,null);
  doc.querySelector('#cancel-folder-setup').onclick();doc.querySelector('#dialog').onclose();
  assert.equal(doc.querySelector('#dialog').open,false);assert.equal(doc.querySelector('#app').hidden,true);assert.equal(doc.querySelector('#folder-setup-paused').hidden,false);assert.equal(doc.activeElement.id,'folder-setup-resume');
  assert.equal(app.settings.get('folder'),undefined);assert.equal(doc.documentElement.dataset.storageSetup,'paused');
  doc.querySelector('#folder-setup-resume').onclick();assert.equal(doc.querySelector('#dialog').open,true);assert.equal(doc.querySelector('#app').hidden,false);assert.equal(doc.querySelector('#folder-setup-paused').hidden,true);assert.equal(doc.documentElement.dataset.storageSetup,'required');
});

test('first-run creates a named child under Documents and connects only after a successful save',async()=>{
  const parent=memoryFolder('Documents');let options,calls=0;
  const app=await fileApp({firstRun:true,directoryPicker:async value=>{options=value;calls++;return parent;}}),doc=app.doc;
  doc.querySelector('#storage-folder-name').value='내 전용 서재';assert.equal(parent.children.size,0);
  doc.querySelector('#create-storage-folder').onclick();await settleUntil(()=>!doc.querySelector('#dialog').open);
  const child=parent.children.get('내 전용 서재');assert.equal(calls,1);assert.equal(options.startIn,'documents');assert.equal(options.id,'htmlmemo-storage-parent-v1');
  assert.equal(app.settings.get('folder'),child);assert.ok(child.children.has('HTMLMemo-library.json'));assert.equal(parent.children.has('HTMLMemo-library.json'),false);
  assert.equal(doc.documentElement.dataset.storageSetup,'ready');assert.equal(app.local.get('htmlmemo-data-folder-welcome-v1'),'1');
});

test('a failed first folder save keeps setup required and retries the same newly-created child safely',async()=>{
  const control={failWrite:'HTMLMemo-library.json'},parent=memoryFolder('Documents',control);
  const app=await fileApp({firstRun:true,directoryPicker:async()=>parent}),doc=app.doc;
  doc.querySelector('#create-storage-folder').onclick();await settleUntil(()=>!doc.querySelector('#create-storage-folder').disabled);
  const child=parent.children.get('HTMLMemo');assert.ok(child);assert.equal(doc.querySelector('#dialog').open,true);assert.equal(doc.documentElement.dataset.storageSetup,'required');assert.equal(app.local.has('htmlmemo-data-folder-welcome-v1'),false);
  control.failWrite=null;doc.querySelector('#create-storage-folder').onclick();await settleUntil(()=>!doc.querySelector('#dialog').open);
  assert.equal(app.settings.get('folder'),child);assert.equal(parent.children.size,1);assert.ok(child.children.has('HTMLMemo-library.json'));assert.equal(doc.documentElement.dataset.storageSetup,'ready');
});

test('a native file launch waits for the first complete storage connection',async()=>{
  let consumer,reads=0;const selected=memoryFolder('Chosen storage');
  const app=await fileApp({firstRun:true,launchQueue:{setConsumer:fn=>consumer=fn},directoryPicker:async()=>selected});assert.equal(typeof consumer,'function');
  consumer({files:[{kind:'file',name:'queued.html',getFile:()=>{reads++;return new Promise(()=>{});}}]});await new Promise(resolve=>setImmediate(resolve));assert.equal(reads,0);
  app.doc.querySelector('#select-storage-folder').onclick();await settleUntil(()=>reads===1);assert.equal(app.doc.documentElement.dataset.storageSetup,'ready');assert.ok(selected.children.has('HTMLMemo-library.json'));
});

test('first-run picker cancellation or denied access retains the guide and retry works without a second setup dialog',async()=>{
  let calls=0,fail='AbortError',options;const selected=memoryFolder('내 HTML 서재'),app=await fileApp({firstRun:true,directoryPicker:async value=>{calls++;options=value;if(fail)throw Object.assign(Error('Picker failure'),{name:fail});return selected;}}),doc=app.doc;
  for(const error of ['AbortError','NotAllowedError']){
    fail=error;doc.querySelector('#select-storage-folder').onclick();await settleUntil(()=>!doc.querySelector('#select-storage-folder').disabled);
    assert.equal(doc.querySelector('#dialog').open,true);assert.ok(doc.querySelector('[data-folder-welcome]'));assert.equal(app.settings.get('folder'),undefined);assert.equal(app.local.has('htmlmemo-data-folder-welcome-v1'),false);assert.equal(doc.querySelector('#create-storage-folder').disabled,false);
    assert.match(doc.querySelector('#folder-connection-status').textContent,error==='AbortError'?/취소.*다시 선택/:/쓰기를 허용/);
    assert.equal(doc.querySelector('#empty-library').hidden,true);
  }
  fail='';doc.querySelector('#select-storage-folder').onclick();assert.equal(doc.querySelector('#create-storage-folder').disabled,true);
  assert.equal(doc.querySelector('#dialog').oncancel,null);
  await settleUntil(()=>!doc.querySelector('#dialog').open);assert.equal(calls,3);assert.equal(options.startIn,'documents');assert.equal(options.mode,'readwrite');assert.equal(app.settings.get('folder'),selected);assert.equal(app.local.get('htmlmemo-data-folder-welcome-v1'),'1');assert.ok(selected.children.has('HTMLMemo-library.json'));assert.equal(doc.querySelector('#data-folder-status').textContent,'폴더 저장 완료');
});

test('native close requests leave setup canceled and cancel queued file launches until an explicit retry',async()=>{
  let consumer,reads=0;const selected=memoryFolder(),app=await fileApp({firstRun:true,directoryPicker:async()=>selected,launchQueue:{setConsumer:fn=>consumer=fn}}),doc=app.doc;
  const files=[{kind:'file',name:'cancelled.html',getFile:()=>{reads++;return new Promise(()=>{});}}];
  consumer({files});await new Promise(resolve=>setImmediate(resolve));assert.equal(reads,0);assert.equal(doc.querySelector('#dialog').oncancel,null);
  doc.querySelector('#dialog').close();doc.querySelector('#dialog').onclose();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(doc.querySelector('#dialog').open,false);assert.equal(doc.documentElement.dataset.storageSetup,'paused');assert.equal(app.local.has('htmlmemo-data-folder-welcome-v1'),false);assert.equal(app.settings.get('folder'),undefined);
  consumer({files});doc.querySelector('#file-input').onchange({target:{files,value:'cancelled.html'}});await new Promise(resolve=>setImmediate(resolve));assert.equal(reads,0);
  doc.querySelector('#folder-setup-resume').onclick();doc.querySelector('#select-storage-folder').onclick();await settleUntil(()=>doc.documentElement.dataset.storageSetup==='ready');
  assert.equal(reads,0);assert.ok(selected.children.has('HTMLMemo-library.json'));assert.equal(doc.querySelector('#folder-setup-paused').hidden,true);
});

test('canceling while a native folder picker is pending ignores its late result and permits a clean retry',async()=>{
  const selected=memoryFolder('Late folder');let finish,calls=0;const app=await fileApp({firstRun:true,directoryPicker:()=>{calls++;return new Promise(resolve=>finish=resolve);}}),doc=app.doc;
  doc.querySelector('#create-storage-folder').onclick();doc.querySelector('#cancel-folder-setup').onclick();doc.querySelector('#dialog').onclose();assert.equal(doc.documentElement.dataset.storageSetup,'paused');assert.equal(doc.querySelector('#folder-setup-resume').disabled,true);
  finish(selected);await settleUntil(()=>!doc.querySelector('#folder-setup-resume').disabled);
  assert.equal(selected.children.size,0);assert.equal(app.settings.get('folder'),undefined);assert.equal(doc.documentElement.dataset.storageSetup,'paused');assert.equal(doc.querySelector('#dialog').open,false);
  doc.querySelector('#folder-setup-resume').onclick();doc.querySelector('#select-storage-folder').onclick();finish(selected);await settleUntil(()=>doc.documentElement.dataset.storageSetup==='ready');assert.equal(calls,2);assert.equal(app.settings.get('folder'),selected);
});

test('canceling during a committed folder save finishes it safely but waits for the user before opening the app',async()=>{
  const selected=memoryFolder('Finishing storage');let release,locked=false,pickers=0;
  const app=await fileApp({firstRun:true,directoryPicker:async()=>{pickers++;return selected;},navigator:{locks:{request:async(name,action)=>{locked=true;await new Promise(resolve=>release=resolve);return action();}}}}),doc=app.doc;
  doc.querySelector('#select-storage-folder').onclick();await settleUntil(()=>locked);doc.querySelector('#cancel-folder-setup').onclick();doc.querySelector('#dialog').onclose();
  assert.equal(doc.querySelector('#folder-setup-resume').disabled,true);assert.equal(doc.activeElement.id,'folder-setup-paused-title');release();await settleUntil(()=>!doc.querySelector('#folder-setup-resume').disabled);
  assert.ok(selected.children.has('HTMLMemo-library.json'));assert.equal(app.settings.get('folder'),selected);assert.equal(doc.documentElement.dataset.storageSetup,'paused');assert.equal(doc.querySelector('#app').hidden,true);assert.equal(doc.querySelector('#dialog').open,false);
  doc.querySelector('#folder-setup-resume').onclick();assert.equal(doc.documentElement.dataset.storageSetup,'ready');assert.equal(doc.querySelector('#app').hidden,false);assert.equal(doc.querySelector('#folder-setup-paused').hidden,true);assert.equal(doc.querySelector('#dialog').open,false);assert.equal(pickers,1);
});

test('missing folder support blocks app startup with the required Chrome message even after a previous visit',async()=>{
  const text='이 앱은 구글 크롬에서만 정상적으로 작동합니다. 크롬에서 실행해주세요.';
  for(const firstRun of [true,false]){
    const original=memoryFolder('기존 보관 폴더'),app=await fileApp({firstRun,directoryPicker:null,settings:[['folder',original]],localEntries:[['untouched','saved value']]}),doc=app.doc;
    assert.equal(doc.querySelector('#dialog').open,true);assert.ok(doc.querySelector('[data-chrome-required]'));assert.equal(doc.querySelector('#chrome-required-message').textContent,text);
    assert.equal(doc.querySelector('#select-storage-folder,#folder-welcome-later,[data-dialog-close]'),null);assert.equal(doc.activeElement.id,'chrome-copy-url');
    let cancelled=false;doc.querySelector('#dialog').oncancel({preventDefault(){cancelled=true;}});assert.equal(cancelled,true);assert.equal(doc.querySelector('#dialog').open,true);
    assert.equal(doc.querySelector('#hero-import').onclick,null);assert.equal(app.databaseOpens,0);assert.equal(app.settings.get('folder'),original);assert.equal(app.local.get('untouched'),'saved value');assert.equal(original.children.size,0);
    assert.doesNotMatch(doc.querySelector('[data-chrome-required]').textContent,/Edge|엣지|나중에 연결/);
  }
});
test('the Chrome requirement copies only the public app URL and recovers after clipboard denial',async()=>{
  const copied=[],app=await fileApp({directoryPicker:null,address:'https://preview.example/app/?private=secret#note',navigator:{clipboard:{writeText:async value=>copied.push(value)}}}),doc=app.doc;
  await doc.querySelector('#chrome-copy-url').onclick();assert.deepEqual(copied,[PUBLIC_APP_URL]);assert.equal(doc.querySelector('#chrome-app-url').value,PUBLIC_APP_URL);assert.match(doc.querySelector('#chrome-copy-status').textContent,/복사했습니다/);assert.equal(doc.querySelector('#dialog').open,true);
  for(const navigator of [{},{clipboard:{writeText:async()=>{throw new Error('denied');}}}]){
    const a=await fileApp({directoryPicker:null,navigator}),input=a.doc.querySelector('#chrome-app-url');let selected=0;input.select=()=>selected++;
    await a.doc.querySelector('#chrome-copy-url').onclick();assert.equal(selected,1);assert.equal(a.doc.activeElement,input);assert.match(a.doc.querySelector('#chrome-copy-status').textContent,/직접 복사/);assert.equal(a.doc.querySelector('#chrome-copy-url').disabled,false);assert.equal(a.databaseOpens,0);
  }
});
test('a missing safe folder-write lock also shows the Chrome requirement before accessing library data',async()=>{
  const app=await fileApp({navigator:{locks:undefined}});assert.ok(app.doc.querySelector('[data-chrome-required]'));assert.equal(app.databaseOpens,0);assert.equal(app.doc.querySelector('#hero-import').onclick,null);
});

test('a saved folder resumes silently; revoked permission offers a compact screen for the same folder',async()=>{
  for(const permission of ['granted','prompt','denied']){
    const selected=memoryFolder('기존 폴더',{permission}),app=await fileApp({firstRun:true,settings:[['folder',selected]],directoryPicker:async()=>{assert.fail('Do not automatically open a picker');}});
    await settleUntil(()=>app.doc.querySelector('#data-folder-status').textContent.includes(permission==='granted'?'완료':'중단'));
    assert.equal(!!app.doc.querySelector('#dialog').open,false);assert.equal(app.doc.querySelector('#folder-reconnect').hidden,permission==='granted');assert.equal(app.settings.get('folder'),selected);
    if(permission!=='granted'){
      assert.ok(app.doc.querySelector('[data-folder-resume]'));assert.equal(app.doc.querySelector('#create-storage-folder,#storage-folder-name'),null);assert.equal(app.doc.activeElement.id,'resume-data-folder');assert.doesNotMatch(app.doc.querySelector('#dialog').textContent,/저장 폴더를 먼저 설정하세요/);
      assert.ok(app.doc.querySelector('#resume-data-folder'));assert.equal(selected.children.size,0);selected.control.permission='granted';
      app.doc.querySelector('#resume-data-folder').onclick();await settleUntil(()=>app.doc.documentElement.dataset.storageSetup==='ready');assert.equal(app.settings.get('folder'),selected);assert.equal(app.doc.querySelector('#folder-reconnect').hidden,true);assert.equal(app.doc.querySelector('#folder-reconnect').children.length,0);
    }
  }
});

test('remembered phone storage asks only for renewed permission and reopens without first setup or another picker',async()=>{
  const control={permission:'prompt'},selected=memoryFolder('<기존 & 폴더>',control),original=await selected.getFileHandle('original.html',{create:true});original.replace('Original data stays here.');
  let requests=0,pickers=0,allow=false;selected.requestPermission=async options=>{assert.equal(options.mode,'readwrite');requests++;if(allow)control.permission='granted';return allow?'granted':'denied';};
  const directoryPicker=async()=>{pickers++;throw Error('A saved folder must not open another picker');};
  const app=await fileApp({firstRun:true,settings:[['folder',selected]],directoryPicker}),doc=app.doc;
  assert.equal(requests,0);assert.equal(pickers,0);assert.ok(doc.querySelector('[data-folder-resume]'));assert.equal(doc.querySelector('#create-storage-folder,#storage-folder-name'),null);assert.equal(doc.querySelector('#folder-reconnect strong').textContent,selected.name);assert.equal(doc.querySelector('#folder-reconnect strong').children.length,0);assert.equal(!!doc.querySelector('#dialog').open,false);assert.equal(doc.querySelector('#app').hidden,true);assert.equal(doc.querySelector('#folder-reconnect details').hasAttribute('open'),false);assert.equal(doc.querySelector('#resume-data-folder').textContent,'계속');assert.equal(doc.querySelector('#toast.error:not([hidden])'),null);
  doc.querySelector('#cancel-folder-setup').onclick();assert.equal(doc.querySelector('#folder-reconnect').hidden,true);assert.equal(doc.querySelector('#folder-reconnect').children.length,0);assert.equal(doc.documentElement.dataset.storageSetup,'paused');assert.equal(app.settings.get('folder'),selected);assert.equal(selected.children.has('HTMLMemo-library.json'),false);assert.equal(requests,0);assert.equal(pickers,0);
  doc.querySelector('#folder-setup-resume').onclick();assert.ok(doc.querySelector('[data-folder-resume]'));assert.equal(doc.querySelector('#create-storage-folder'),null);
  doc.querySelector('#resume-data-folder').onclick();await settleUntil(()=>!doc.querySelector('#resume-data-folder').disabled);
  assert.equal(requests,1);assert.equal(doc.documentElement.dataset.storageSetup,'required');assert.match(doc.querySelector('#folder-connection-status').textContent,/기존 저장 폴더의 쓰기를 허용/);assert.equal(selected.children.has('HTMLMemo-library.json'),false);assert.equal(app.settings.get('folder'),selected);
  allow=true;doc.querySelector('#resume-data-folder').onclick();await settleUntil(()=>doc.documentElement.dataset.storageSetup==='ready');
  assert.equal(requests,2);assert.equal(pickers,0);assert.equal(doc.documentElement.dataset.storageSetup,'ready');
  const id=JSON.parse(await(await selected.getFileHandle('HTMLMemo-library.json')).getFile().then(f=>f.text())).id;
  for(let i=0;i<3;i++){
    const next=await fileApp({firstRun:true,settings:[...app.settings],localEntries:[...app.local],directoryPicker});
    await settleUntil(()=>next.doc.documentElement.dataset.storageSetup!=='checking');
    assert.equal(!!next.doc.querySelector('#dialog').open,false);assert.equal(next.doc.querySelector('[data-folder-resume],[data-folder-welcome]'),null);assert.equal(next.doc.documentElement.dataset.storageSetup,'ready');assert.equal(next.settings.get('folder'),selected);assert.equal(requests,2);assert.equal(pickers,0);
    assert.equal(JSON.parse(await(await selected.getFileHandle('HTMLMemo-library.json')).getFile().then(f=>f.text())).id,id);
  }
  assert.equal(await(await original.getFile()).text(),'Original data stays here.');
});

test('repeatedly reset folder permission keeps each launch compact and never selects or creates another folder',async()=>{
  const control={permission:'granted'},selected=memoryFolder('Phone storage',control),original=await selected.getFileHandle('kept.html',{create:true});original.replace('Kept document');
  let requests=0;selected.requestPermission=async()=>{requests++;control.permission='granted';return 'granted';};
  const directoryPicker=async()=>{assert.fail('A remembered folder needs no picker');};
  let app=await fileApp({firstRun:true,settings:[['folder',selected]],directoryPicker});await settleUntil(()=>app.doc.documentElement.dataset.storageSetup==='ready');
  const manifest=()=>selected.getFileHandle('HTMLMemo-library.json').then(h=>h.getFile()).then(f=>f.text()).then(JSON.parse),id=(await manifest()).id;
  for(let i=0;i<3;i++){
    control.permission='prompt';const next=await fileApp({firstRun:true,settings:[...app.settings],localEntries:[...app.local],directoryPicker}),doc=next.doc;
    assert.equal(requests,i);assert.equal(!!doc.querySelector('#dialog').open,false);assert.equal(doc.querySelector('#folder-reconnect').hidden,false);assert.equal(doc.querySelector('#app').hidden,true);assert.equal(doc.querySelector('.folder-welcome-steps,#create-storage-folder'),null);assert.equal(doc.querySelector('#folder-reconnect details').hasAttribute('open'),false);
    doc.querySelector('#resume-data-folder').onclick();await settleUntil(()=>doc.documentElement.dataset.storageSetup==='ready');assert.equal(requests,i+1);assert.equal((await manifest()).id,id);assert.equal(doc.querySelector('#folder-reconnect').children.length,0);assert.equal(doc.querySelector('#app').hidden,false);app=next;
  }
  assert.equal(await(await original.getFile()).text(),'Kept document');
});

test('canceling a remembered-folder permission request ignores a late grant until the user resumes',async()=>{
  const control={permission:'prompt'},selected=memoryFolder('Pending permission',control);let grant;
  selected.requestPermission=()=>new Promise(resolve=>{grant=()=>{control.permission='granted';resolve('granted');};});
  const app=await fileApp({firstRun:true,settings:[['folder',selected]],directoryPicker:async()=>assert.fail('No picker needed')}),doc=app.doc;
  doc.querySelector('#resume-data-folder').onclick();doc.querySelector('#cancel-folder-setup').onclick();assert.equal(doc.documentElement.dataset.storageSetup,'paused');assert.equal(doc.querySelector('#folder-setup-resume').disabled,true);
  grant();await settleUntil(()=>!doc.querySelector('#folder-setup-resume').disabled);assert.equal(selected.children.size,0);assert.equal(doc.querySelector('#app').hidden,true);assert.equal(doc.querySelector('#folder-reconnect').children.length,0);
  doc.querySelector('#folder-setup-resume').onclick();assert.equal(doc.querySelector('#folder-reconnect').hidden,false);doc.querySelector('#resume-data-folder').onclick();grant();await settleUntil(()=>doc.documentElement.dataset.storageSetup==='ready');assert.ok(selected.children.has('HTMLMemo-library.json'));
});

test('first-run guidance waits for the version check and follows it without touching the folder first',async()=>{
  let finish,pickers=0;const app=await fileApp({firstRun:true,waitingForUpdate:true,address:PUBLIC_APP_URL,directoryPicker:async()=>{pickers++;return memoryFolder();},navigator:{serviceWorker:{register:()=>new Promise(resolve=>finish=resolve)}}});
  assert.equal(!!app.doc.querySelector('#dialog').open,false);assert.equal(app.doc.querySelector('[data-folder-welcome]'),null);assert.equal(app.doc.querySelector('#app').inert,true);assert.equal(app.databaseOpens,0);assert.equal(pickers,0);
  finish(undefined);await settleUntil(()=>app.doc.documentElement.dataset.storageSetup==='required');assert.equal(app.doc.querySelector('#dialog').open,true);assert.ok(app.doc.querySelector('[data-folder-welcome]'));assert.equal(app.doc.querySelector('#app').inert,false);assert.equal(pickers,0);
});

test('folder setup guides users to a subfolder and saves a handle only after an explicit picker action',async()=>{
  const app=await fileApp(),doc=app.doc,selected=memoryFolder();let options,calls=0;
  app.context.window.showDirectoryPicker=async value=>{options=value;calls++;return selected;};
  doc.querySelector('#settings-button').onclick();doc.querySelector('#settings-folder').onclick();assert.equal(calls,0);
  assert.match(doc.querySelector('#dialog-content').textContent,/전용 하위 폴더/);assert.match(doc.querySelector('#dialog-content').textContent,/문서\/HTMLMemo/);
  doc.querySelector('#select-storage-folder').onclick();await settleUntil(()=>doc.querySelector('#dialog h2').textContent==='HTMLMemo 설정');
  assert.equal(calls,1);assert.equal(options.mode,'readwrite');assert.equal(options.startIn,'documents');assert.equal(options.id,'htmlmemo-storage-v2');
  assert.equal(app.settings.get('folder'),selected);assert.equal(doc.querySelector('#dialog').open,true);assert.equal(doc.querySelector('#dialog h2').textContent,'HTMLMemo 설정');assert.equal(doc.querySelector('#settings-folder').textContent,'관리');assert.match(doc.querySelector('#status-left').textContent,/HTMLMemo 자동 저장/);assert.match(doc.querySelector('#settings-folder-status').textContent,/폴더 자동 저장 완료/);
});

test('folder setup requests browser storage protection once after saving and skips an existing grant',async()=>{
  for(const [already,granted] of [[true,true],[false,true],[false,false]]){
    const selected=memoryFolder(),calls={checks:0,requests:0},saved=[];
    const app=await fileApp({directoryPicker:async()=>selected,navigator:{storage:{
      persisted:async()=>{calls.checks++;saved.push(selected.children.has('HTMLMemo-library.json'));return already;},
      persist:async()=>{calls.requests++;saved.push(selected.children.has('HTMLMemo-library.json'));return granted;}
    }}}),doc=app.doc;
    assert.deepEqual(calls,{checks:0,requests:0});doc.querySelector('#settings-button').onclick();
    assert.equal(doc.querySelector('#persist-storage'),null);assert.doesNotMatch(doc.querySelector('#dialog').textContent,/기기 보관함 유지/);
    doc.querySelector('#settings-folder').onclick();assert.deepEqual(calls,{checks:0,requests:0});
    doc.querySelector('#select-storage-folder').onclick();await settleUntil(()=>doc.querySelector('#dialog h2').textContent==='HTMLMemo 설정');
    assert.deepEqual(calls,{checks:1,requests:already?0:1});assert.deepEqual(saved,already?[true]:[true,true]);assert.equal(app.settings.get('folder'),selected);
    assert.equal(doc.querySelector('#data-folder-status').textContent,'폴더 저장 완료');
    assert.match(doc.querySelector('[data-folder-guide]').textContent,/브라우저가 허용하지 않아도 전용 폴더 자동 저장은 계속/);
    doc.querySelector('#settings-folder').onclick();doc.querySelector('#resume-data-folder').onclick();
    await settleUntil(()=>doc.querySelector('#dialog h2').textContent==='HTMLMemo 설정');
    assert.deepEqual(calls,{checks:1,requests:already?0:1},'a second connection does not repeat a prompt or a denied request');
  }
});

test('unsupported, rejected or unresolved browser protection never blocks a successful folder backup',async()=>{
  const denied=()=>Promise.reject(new DOMException('Unavailable','SecurityError'));
  for(const mode of ['unsupported','no-check','check-error','request-error','check-pending','request-pending']){
    let finish;const pending=new Promise(resolve=>{finish=resolve;}),selected=memoryFolder();
    const storage=mode==='unsupported'?{}:{
      ...(mode==='no-check'?{}:{persisted:mode==='check-error'?denied:mode==='check-pending'?()=>pending:async()=>false}),
      persist:mode==='request-error'?denied:mode==='request-pending'?()=>pending:async()=>true
    };
    const app=await fileApp({directoryPicker:async()=>selected,navigator:{storage}}),doc=app.doc;
    doc.querySelector('#data-folder-status').onclick();doc.querySelector('#select-storage-folder').onclick();
    await settleUntil(()=>!doc.querySelector('#dialog').open);
    assert.equal(app.settings.get('folder'),selected,mode);assert.ok(selected.children.has('HTMLMemo-library.json'),mode);
    assert.equal(doc.querySelector('#data-folder-status').textContent,'폴더 저장 완료',mode);
    assert.match(doc.querySelector('#toast').textContent,/자동 저장했습니다/);assert.equal(doc.querySelector('#toast').classList.contains('error'),false);
    finish(false);await new Promise(resolve=>setImmediate(resolve));
  }
});

test('browser protection is not requested on startup, picker cancellation, denied access or failed folder writes',async()=>{
  const previous=memoryFolder('Previous'),calls={checks:0,requests:0};let fail='AbortError';
  const app=await fileApp({settings:[['folder',previous]],directoryPicker:async()=>{throw new DOMException('Cancelled',fail);},navigator:{storage:{persisted:async()=>{calls.checks++;return false;},persist:async()=>{calls.requests++;return true;}}}}),doc=app.doc;
  await settleUntil(()=>doc.querySelector('#data-folder-status').textContent==='폴더 저장 완료');
  assert.deepEqual(calls,{checks:0,requests:0});doc.querySelector('#data-folder-status').onclick();
  for(const mode of ['AbortError','NotAllowedError']){
    fail=mode;doc.querySelector('#select-storage-folder').onclick();await settleUntil(()=>!doc.querySelector('#select-storage-folder').disabled);
    assert.deepEqual(calls,{checks:0,requests:0});assert.equal(app.settings.get('folder'),previous);
  }
  const selected=memoryFolder('Failed');app.context.window.showDirectoryPicker=async()=>selected;
  const set=app.settings.set.bind(app.settings);app.settings.set=()=>{throw Error('Storage unavailable');};
  doc.querySelector('#select-storage-folder').onclick();await settleUntil(()=>!doc.querySelector('#select-storage-folder').disabled);
  assert.deepEqual(calls,{checks:0,requests:0});assert.equal(app.settings.get('folder'),previous);
  app.settings.set=set;
});

test('folder cancellation, blocked access and failed persistence preserve the previous connection and allow retry',async()=>{
  const previous=memoryFolder('Previous'),next=memoryFolder('New HTMLMemo'),app=await fileApp({settings:[['folder',previous]]}),doc=app.doc;
  await settleUntil(()=>doc.querySelector('#data-folder-status').textContent==='폴더 저장 완료');
  let fail='AbortError';app.context.window.showDirectoryPicker=async()=>{if(fail){const error=new Error('Blocked or cancelled');error.name=fail;throw error;}return next;};
  doc.querySelector('#settings-button').onclick();doc.querySelector('#settings-folder').onclick();
  for(const name of ['AbortError','NotAllowedError']){
    fail=name;doc.querySelector('#select-storage-folder').onclick();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(app.settings.get('folder'),previous);assert.equal(doc.querySelector('#dialog').open,true);assert.equal(doc.querySelector('#select-storage-folder').disabled,false);
    assert.match(doc.querySelector('#folder-connection-status').textContent,/하위/u);assert.match(doc.querySelector('#status-left').textContent,/Previous 자동 저장/);
  }
  fail='';const set=app.settings.set.bind(app.settings);app.settings.set=()=>{throw Error('Storage unavailable');};
  doc.querySelector('#select-storage-folder').onclick();await new Promise(resolve=>setImmediate(resolve));assert.equal(app.settings.get('folder'),previous);assert.match(doc.querySelector('#folder-connection-status').textContent,/저장하지 못했습니다/);
  app.settings.set=set;doc.querySelector('#select-storage-folder').onclick();await settleUntil(()=>doc.querySelector('#dialog h2').textContent==='HTMLMemo 설정');
  assert.equal(app.settings.get('folder'),next);assert.equal(doc.querySelector('#dialog').open,true);assert.equal(doc.querySelector('#dialog h2').textContent,'HTMLMemo 설정');assert.match(doc.querySelector('#status-left').textContent,/New HTMLMemo 자동 저장/);
});

test('settings and status bar expose folder setup without a duplicate library banner, with a Chrome requirement if folder support becomes unavailable',async()=>{
  const app=await fileApp(),doc=app.doc;
  assert.equal(!!doc.querySelector('#choose-folder,#menu-folder'),false);assert.equal(doc.querySelector('.library-footer'),null);
  doc.querySelector('#settings-button').onclick();assert.equal(doc.querySelectorAll('#settings-folder').length,1);assert.equal(doc.querySelector('#settings-folder').textContent,'폴더 연결');
  app.context.window.showDirectoryPicker=undefined;doc.querySelector('#settings-folder').onclick();await new Promise(resolve=>setImmediate(resolve));assert.ok(doc.querySelector('[data-chrome-required]'));assert.match(doc.querySelector('#chrome-required-message').textContent,/구글 크롬에서만 정상적으로 작동/);assert.equal(app.settings.get('folder'),undefined);
  assert.equal(doc.querySelector('#data-folder-card,#data-folder-summary,#data-folder-description,#library-data-folder'),null);assert.ok(doc.querySelector('#data-folder-status'));assert.match(doc.querySelector('#data-folder-status').title,/브라우저 데이터 삭제 시 잃을 수 있습니다/);
});

test('a replaced library heading text node is repaired without losing the count or stored documents',async()=>{
  const app=await fileApp(),doc=app.doc,heading=doc.querySelector('.library-heading h2'),count=doc.querySelector('#document-count');heading.firstChild.remove();doc.querySelector('#library-filter').oninput();assert.match(heading.textContent,/내 서재/);assert.equal(doc.querySelector('#document-count'),count);assert.equal(count.textContent,'0');assert.equal(doc.querySelector('#toast').hidden,true);
});
