import { zipFiles, crc32 } from './zip.js';
import { assetBytes, assetText } from './bundler.js';
export const APP_FILES=['index.html','styles.css','manifest.webmanifest','sw.js','example.html','icons/icon.svg','icons/icon-192.png','icons/icon-512.png','shared/capture.js','src/app.js','src/bridge.js','src/document.js','src/local-files.js','src/model.js','src/reader.js','src/read-aloud.js','src/storage.js','src/utils.js','src/preferences.js','src/zip.js','src/bundler.js','src/distribution.js','src/install.js','src/version.js'];
export const EXTENSION_FILES=['manifest.json','background.js','bridge.js','capture.js','popup.html','popup.js','options.html','options.js','extension.css'];
export function cleanDistribution(assets){return {app:Object.fromEntries(APP_FILES.map(name=>[name,assets.app?.[name]])),extension:Object.fromEntries(EXTENSION_FILES.map(name=>[name,assets.extension?.[name]]))};}
export async function distributionAssets() {
  const embedded=document.getElementById('htmlmemo-package-assets');if(embedded)return cleanDistribution(JSON.parse(embedded.textContent));
  if(location.protocol==='chrome-extension:'){
    const read=async path=>{const response=await fetch(chrome.runtime.getURL(path));if(!response.ok)throw new Error('Chrome 연결 파일을 읽지 못했습니다.');const bytes=new Uint8Array(await response.arrayBuffer());if(path.endsWith('.png')){let binary='';for(const b of bytes)binary+=String.fromCharCode(b);return {base64:btoa(binary)};}return {text:new TextDecoder().decode(bytes)};};
    const app={},extension={};await Promise.all(APP_FILES.map(async name=>app[name]=await read('app/'+name)));await Promise.all(EXTENSION_FILES.map(async name=>extension[name]=await read(name)));return {app,extension};
  }
  const response=await fetch('./distribution.json');if(!response.ok)throw new Error('Chrome 연결 기능이 준비되지 않았습니다. 앱을 새로고침해주세요.');return cleanDistribution(await response.json());
}
export function chromeZIP(assets) {
  assets=cleanDistribution(assets);
  return zipFiles([...EXTENSION_FILES.map(name=>({name:'extension/'+name,data:assetBytes(assets.extension[name])})),...APP_FILES.map(name=>({name:'extension/app/'+name,data:assetBytes(assets.app[name])}))]);
}
export function pwaEntries(assets) {
  assets=cleanDistribution(assets);
  const normalizedSW=assetText(assets.app['sw.js']).replace(/const CACHE = '[^']+';/,"const CACHE = 'htmlmemo-pages';");
  const app={...assets.app,'sw.js':{text:normalizedSW}};
  const version=crc32(new TextEncoder().encode(JSON.stringify({...assets,app}))).toString(16).padStart(8,'0');
  assets={...assets,app:{...app,'sw.js':{text:normalizedSW.replace("const CACHE = 'htmlmemo-pages';","const CACHE = 'htmlmemo-"+version+"';")}}};
  return [...APP_FILES.map(name=>({name,data:assetBytes(assets.app[name])})),{name:'distribution.json',data:JSON.stringify(assets)},{name:'.nojekyll',data:''},{name:'downloads/HTMLMemo-chrome.zip',data:chromeZIP(assets)}];
}
export async function bundledExample() {const data=document.getElementById('htmlmemo-package-assets');return data?assetText(JSON.parse(data.textContent).app['example.html']):null;}
