import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { prepareAssets, packageAssets } from '../scripts/assets.mjs';
import { standaloneHTML, bundleModules } from '../public/src/bundler.js';
import { portableZIP, pagesZIP, chromeZIP, installationHTML, APP_FILES, EXTENSION_FILES } from '../public/src/distribution.js';
import { PUBLIC_APP_URL } from '../public/src/install.js';
import { crc32, zipFiles } from '../public/src/zip.js';
import { serializeSettings, PREFERENCES_KEY } from '../public/src/preferences.js';
import { DOMParser } from 'linkedom';
let assets;
before(async()=>{await prepareAssets();assets=await packageAssets();});
function unzip(bytes){const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),files=new Map();let offset=0;while(view.getUint32(offset,true)===0x04034b50){assert.equal(view.getUint16(offset+8,true),0);const size=view.getUint32(offset+18,true),nameLength=view.getUint16(offset+26,true),extraLength=view.getUint16(offset+28,true),name=new TextDecoder().decode(bytes.subarray(offset+30,offset+30+nameLength)),start=offset+30+nameLength+extraLength,data=bytes.subarray(start,start+size);assert.equal(crc32(data),view.getUint32(offset+14,true));assert.ok(!files.has(name));files.set(name,data);offset=start+size;}assert.equal(view.getUint32(offset,true),0x02014b50);assert.equal(view.getUint32(bytes.length-22,true),0x06054b50);assert.equal(view.getUint16(bytes.length-12,true),files.size);return files;}
const text=(files,name)=>new TextDecoder().decode(files.get(name));
test('the directly opened HTML contains all executable code without module or network imports',()=>{const doc=new DOMParser().parseFromString(standaloneHTML(assets),'text/html');assert.equal(doc.querySelectorAll('script[src],script[type=module],link[rel=stylesheet],link[rel=manifest]').length,0);assert.deepEqual(JSON.parse(doc.querySelector('#htmlmemo-package-assets').textContent),assets);const scripts=[...doc.querySelectorAll('script')].filter(script=>script.type!=='application/json');assert.equal(scripts.length,1);new vm.Script(scripts[0].textContent);assert.match(scripts[0].textContent,/const \$\$ =/);});
test('module packaging preserves dollar signs, aliases and module scope',()=>{const source=bundleModules({'src/app.js':{text:"import { $$ as select } from './helper.js';\nglobalThis.result=select();"},'src/helper.js':{text:"export const $$=()=> '$$';"}});const context={};vm.runInNewContext(source,context);assert.equal(context.result,'$$');assert.throws(()=>bundleModules({'src/app.js':{text:"import { missing } from './missing.js';"}}),/누락/);});
test('the handoff ZIP contains a runnable HTML, beginner instructions and the bundled extension app',()=>{const files=unzip(portableZIP(assets));assert.equal(files.size,2+APP_FILES.length+EXTENSION_FILES.length);assert.match(text(files,'HTMLMemo/먼저 열어주세요.html'),/href="\.\/HTMLMemo.html"/);assert.equal(text(files,'HTMLMemo/HTMLMemo.html'),standaloneHTML(assets));const manifest=JSON.parse(text(files,'HTMLMemo/extension/manifest.json'));assert.equal(manifest.manifest_version,3);assert.ok(files.has('HTMLMemo/extension/app/index.html'));assert.match(text(files,'HTMLMemo/extension/background.js'),/getURL\('app\/index.html'\)/);assert.ok(![...files.keys()].some(name=>/server|node_modules|\.env|\.git/.test(name)));});
test('private documents, settings, handles and arbitrary extra files never enter the handoff',()=>{const extra={...assets,documents:['PRIVATE-DOCUMENT'],preferences:{secret:'PRIVATE-SETTING'},fileHandle:{path:'PRIVATE-PATH'},app:{...assets.app,'private.html':{text:'PRIVATE-EXTRA'}}};const files=unzip(portableZIP(extra));assert.ok(![...files.keys()].some(name=>name.includes('private.html')));assert.ok(!text(files,'HTMLMemo/HTMLMemo.html').includes('PRIVATE-'));});
test('the ZIP writer retains Unicode filenames and refuses parent traversal',()=>{const files=unzip(zipFiles([{name:'앱/설정.json',data:'한글 $$'}]));assert.equal(text(files,'앱/설정.json'),'한글 $$');assert.throws(()=>zipFiles([{name:'../secret',data:'x'}]));});
test('the Pages package contains only publishable app files under docs, with all offline resources',()=>{
  const files=unzip(pagesZIP({...assets,documents:['PRIVATE-DOCUMENT'],token:'PRIVATE-TOKEN',app:{...assets.app,'private.html':{text:'PRIVATE-EXTRA'}}}));
  assert.equal(files.size,APP_FILES.length+2);assert.ok(files.has('docs/.nojekyll'));assert.ok(files.has('docs/index.html'));
  assert.ok([...files.keys()].every(name=>name.startsWith('docs/')));
  assert.ok(![...files.values()].some(bytes=>new TextDecoder().decode(bytes).includes('PRIVATE-')));
  const manifest=JSON.parse(text(files,'docs/manifest.webmanifest'));assert.equal(manifest.start_url,'./');assert.equal(manifest.scope,'./');
  const shell=JSON.parse(text(files,'docs/sw.js').match(/const SHELL = (\[[^;]+\]);/)[1].replaceAll("'",'"'));
  for(const path of shell)assert.ok(files.has('docs/'+(path==='./'?'index.html':path.slice(2))),path);
  const copy=JSON.parse(text(files,'docs/distribution.json'));assert.equal(copy.app['sw.js'].text,text(files,'docs/sw.js'));
});
test('Pages cache versions change with app code and repackaging the same build is stable',()=>{
  const first=unzip(pagesZIP(assets)),again=unzip(pagesZIP(JSON.parse(text(first,'docs/distribution.json'))));
  assert.equal(text(first,'docs/sw.js'),text(again,'docs/sw.js'));
  const changed={...assets,app:{...assets.app,'styles.css':{text:assets.app['styles.css'].text+'\nbody{color:red}'}}};
  assert.notEqual(text(first,'docs/sw.js').match(/const CACHE = '[^']+'/)[0],text(unzip(pagesZIP(changed)),'docs/sw.js').match(/const CACHE = '[^']+'/)[0]);
});
test('the single installation handoff is inert HTML with one HTTPS destination and no private query',()=>{
  const doc=new DOMParser().parseFromString(installationHTML(PUBLIC_APP_URL+'?token=PRIVATE#annotation'),'text/html');
  assert.equal(doc.querySelectorAll('script,iframe,form').length,0);
  for(const link of doc.querySelectorAll('a'))assert.equal(link.getAttribute('href'),PUBLIC_APP_URL);
  assert.ok(!doc.toString().includes('PRIVATE'));assert.match(doc.body.textContent,/Chrome/);assert.match(doc.body.textContent,/홈 화면에 추가/);
  for(const url of ['file:///private/app.html','javascript:alert(1)','https://name:secret@example.test/'])assert.throws(()=>installationHTML(url),/HTTPS/);
});
test('the Chrome download has the extension folder expected by its setup instructions',()=>{
  const files=unzip(chromeZIP(assets));assert.ok(files.has('extension/manifest.json'));assert.ok(files.has('extension/app/index.html'));
  const manifest=JSON.parse(text(files,'extension/manifest.json'));assert.ok(manifest.content_scripts[0].matches.includes('https://sweon.github.io/HTMLMemo/*'));
});
test('asset preparation leaves the actual Chrome download file available on disk',async()=>{
  const bytes=new Uint8Array(await readFile(new URL('../public/downloads/HTMLMemo-chrome.zip',import.meta.url)));
  const files=unzip(bytes);assert.ok(files.has('extension/manifest.json'));assert.ok(files.has('extension/app/src/install.js'));
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
test('execution export is enabled without a document and produces just the installation HTML locally',async()=>{const app=await fileApp();assert.equal(app.doc.querySelector('#save-page').disabled,true);app.doc.querySelector('#execution-tab').onclick();const button=app.doc.querySelector('#save-page');assert.equal(button.disabled,false);assert.match(button.textContent,/앱 내보내기/);button.onclick();await new Promise(resolve=>setImmediate(resolve));assert.equal(button.disabled,false);assert.equal(app.blobs.length,1);const guide=new DOMParser().parseFromString(await app.blobs[0].text(),'text/html');assert.equal(guide.querySelector('a').getAttribute('href'),PUBLIC_APP_URL);assert.match(app.doc.querySelector('#delivery-status').textContent,/파일 하나를 보내/);assert.equal(app.doc.querySelector('#delivery-html'),null);});
test('a failed handoff download restores the buttons and shows a recoverable error',async()=>{const app=await fileApp();app.doc.querySelector('#execution-tab').onclick();app.context.URL.createObjectURL=()=>{throw new Error('Download failed');};app.doc.querySelector('#delivery-package').onclick();await new Promise(resolve=>setImmediate(resolve));assert.equal(app.doc.querySelector('#save-page').disabled,false);assert.equal(app.doc.querySelector('#delivery-package').disabled,false);assert.equal(app.doc.querySelector('#pages-package').disabled,false);assert.match(app.doc.querySelector('#delivery-status').textContent,/만들지 못/);assert.equal(app.blobs.length,0);});
test('the execution tab exposes a working Pages ZIP link and restores it after export errors',async()=>{
  const app=await fileApp();app.doc.querySelector('#execution-tab').onclick();
  const link=app.doc.querySelector('#pages-package');
  assert.equal(link.tagName,'A');assert.equal(link.closest('details,[hidden]'),null);
  assert.equal(link.getAttribute('download'),'HTMLMemo-pages.zip');assert.equal(link.getAttribute('href'),'./downloads/HTMLMemo-pages.zip');
  assert.match(link.textContent,/배포 ZIP 다운로드/);assert.match(app.doc.querySelector('#pages-status').textContent,/HTMLMemo-pages\.zip/);
  let prevented=0;const click={preventDefault:()=>prevented++};
  link.onclick(click);assert.equal(link.getAttribute('aria-disabled'),'true');link.onclick(click);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(prevented,2);assert.equal(app.blobs.length,1);
  assert.equal(app.blobs[0].type,'application/zip');assert.ok(unzip(new Uint8Array(await app.blobs[0].arrayBuffer())).has('docs/index.html'));
  assert.equal(link.getAttribute('aria-disabled'),'false');
  app.doc.querySelector('#htmlmemo-package-assets').textContent='{}';link.onclick(click);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(prevented,3);assert.equal(link.disabled,false);assert.equal(link.getAttribute('aria-disabled'),'false');
  assert.match(app.doc.querySelector('#pages-status').textContent,/만들지 못/);assert.equal(app.blobs.length,1);
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
