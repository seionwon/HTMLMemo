import { zipFiles } from './zip.js';
import { assetBytes, assetText, standaloneHTML } from './bundler.js';
export const APP_FILES=['index.html','styles.css','manifest.webmanifest','sw.js','example.html','icons/icon.svg','icons/icon-192.png','icons/icon-512.png','shared/capture.js','src/app.js','src/bridge.js','src/document.js','src/local-files.js','src/model.js','src/reader.js','src/storage.js','src/utils.js','src/preferences.js','src/zip.js','src/bundler.js','src/distribution.js'];
export const EXTENSION_FILES=['manifest.json','background.js','bridge.js','capture.js','popup.html','popup.js','options.html','options.js','extension.css'];
export function cleanDistribution(assets){return {app:Object.fromEntries(APP_FILES.map(name=>[name,assets.app?.[name]])),extension:Object.fromEntries(EXTENSION_FILES.map(name=>[name,assets.extension?.[name]]))};}
export function welcomeHTML(){return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>HTMLMemo 시작하기</title><style>body{font:16px/1.8 system-ui,sans-serif;background:#f5f5f1;color:#303b35;max-width:680px;margin:50px auto;padding:24px}h1{color:#276254}a{color:#276254}.start{display:inline-block;background:#276254;color:white;padding:13px 24px;border-radius:8px;text-decoration:none}li{margin:12px 0}details{margin-top:30px;border-top:1px solid #ddd;padding-top:20px}</style><h1>HTMLMemo에 오신 것을 환영합니다.</h1><p>압축을 풀었다면 준비가 끝났습니다. 아래 버튼으로 앱을 여세요.</p><p><a class="start" href="./HTMLMemo.html">HTMLMemo 실행</a></p><p>앱에서 「HTML 파일 가져오기」를 누르면 바로 읽고 메모할 수 있습니다.<br>문서·주석·설정은 이 컴퓨터에만 저장됩니다. 인터넷 연결이나 서버 실행은 필요 없습니다.</p><details><summary>웹 페이지도 저장하고 싶어요</summary><ol><li>Chrome에서 주소창에 <code>chrome://extensions</code>를 입력합니다.</li><li>오른쪽 위 「개발자 모드」를 켭니다.</li><li>「압축해제된 확장 프로그램 로드」를 누르고 함께 받은 <strong>extension</strong> 폴더를 선택합니다.</li><li>Chrome의 확장 기능 목록에서 HTMLMemo를 열고 「HTMLMemo 열기」를 누릅니다.</li></ol><p>연결 주소를 설정할 필요가 없습니다. 확장 기능에 앱이 들어 있어 서버 없이 실행됩니다. 기본 앱과 확장 기능 앱은 보관함이 따로 있으므로, 문서는 HTML로 내보내 이동하세요.</p></details><details><summary>설정을 옮기거나 다시 불러오고 싶어요</summary><p>앱의 설정에서 「설정 파일 저장」을 누르세요. 다음에는 「설정 파일 불러오기」로 같은 JSON 파일을 선택하면 됩니다. 파일 쓰기 권한과 저장 폴더는 새 기기에서 한 번 연결해주세요.</p></details><p><small>HTML 파일은 Chrome으로 열어주세요. 직접 실행하는 파일은 Chrome의 PWA 설치 메뉴 대상이 아니지만, 로컬 읽기·주석·설정·전달 기능은 사용할 수 있습니다.</small></p></html>`;}
export async function distributionAssets() {
  const embedded=document.getElementById('htmlmemo-package-assets');if(embedded)return cleanDistribution(JSON.parse(embedded.textContent));
  if(location.protocol==='chrome-extension:'){
    const read=async path=>{const response=await fetch(chrome.runtime.getURL(path));if(!response.ok)throw new Error('전달할 앱 파일을 읽지 못했습니다.');const bytes=new Uint8Array(await response.arrayBuffer());if(path.endsWith('.png')){let binary='';for(const b of bytes)binary+=String.fromCharCode(b);return {base64:btoa(binary)};}return {text:new TextDecoder().decode(bytes)};};
    const app={},extension={};await Promise.all(APP_FILES.map(async name=>app[name]=await read('app/'+name)));await Promise.all(EXTENSION_FILES.map(async name=>extension[name]=await read(name)));return {app,extension};
  }
  const response=await fetch('./distribution.json');if(!response.ok)throw new Error('전달 파일이 준비되지 않았습니다. 최신 HTMLMemo 실행 파일을 열어주세요.');return cleanDistribution(await response.json());
}
export function portableEntries(assets) {
  assets=cleanDistribution(assets);
  const entries=[{name:'HTMLMemo/먼저 열어주세요.html',data:welcomeHTML()},{name:'HTMLMemo/HTMLMemo.html',data:standaloneHTML(assets)}];
  for(const name of EXTENSION_FILES){if(!assets.extension?.[name])throw new Error('Chrome 연결 파일이 누락되었습니다: '+name);entries.push({name:'HTMLMemo/extension/'+name,data:assetBytes(assets.extension[name])});}
  for(const name of APP_FILES){if(!assets.app?.[name])throw new Error('앱 파일이 누락되었습니다: '+name);entries.push({name:'HTMLMemo/extension/app/'+name,data:assetBytes(assets.app[name])});}
  return entries;
}
export const portableZIP = assets => zipFiles(portableEntries(assets));
export async function bundledExample() {const data=document.getElementById('htmlmemo-package-assets');return data?assetText(JSON.parse(data.textContent).app['example.html']):null;}
