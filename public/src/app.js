import { $, $$, icon, escapeHTML as esc, uid, filename, normalizeURL, displayHost, formatDate, formatBytes, download } from './utils.js';
import { parseHTML, SCRIPT_CSP } from './document.js';
import { SaveQueue } from './model.js';
import { Reader } from './reader.js';
import { listDocuments, getDocument, deleteDocument, getSetting, setSetting, saveDocumentHTML, listRevisionSummaries, getRevision, putDocumentRevision, writeExternalHTML } from './storage.js';
import { bridge, bridgeAvailable, discoverBridge } from './bridge.js';
import { readLocalHTML, droppedHTMLFiles } from './local-files.js';
import { normalizePreferences, loadPreferences, storePreferences, serializeSettings, readSettingsFile, PRESET_COLORS, PRESET_PALETTES, normalizeHexColor, hexToRgb, rgbToHex, hexToHsv, hsvToHex } from './preferences.js';
import { distributionAssets, chromeZIP, bundledExample } from './distribution.js';
import { InstallController, isIOS, installableLocation, installationURL, PUBLIC_APP_URL } from './install.js';

let records = []; const tabs = []; let activeId = 'library'; let folder = null; let popoverName = ''; let sidebarMode = ''; let receiving = false;
let preferences=normalizePreferences(), settingsFileHandle=null, settingsFolderHint='';
let sharingApp=false, installController;
let readerFocused=false, nativeReaderFullscreen=false, focusBusy=false;
const appAddress=()=>{const url=new URL(location.href);url.search='';url.hash='';return url.href;};
const active = () => tabs.find(tab => tab.id === activeId);
const reader = () => active()?.reader;
const savePicker = () => typeof window.showSaveFilePicker === 'function';
const openPicker = () => typeof window.showOpenFilePicker === 'function';
const htmlTypes = [{description:'HTML 문서',accept:{'text/html':['.html','.htm']}}];
const safely = fn => (...args) => { try { Promise.resolve(fn(...args)).catch(showError); } catch(error) { showError(error); } };
function toast(message, error = false) { const el=$('#toast'); el.textContent=message; el.classList.toggle('error',error); el.hidden=false; clearTimeout(toast.timer); toast.timer=setTimeout(()=>el.hidden=true,error?6500:3500); }
function showError(error) { if (error?.name !== 'AbortError') toast(error?.message || String(error),true); }
function setButton(selector, name, label = '') { $(selector).innerHTML=icon(name)+(label ? `<span>${label}</span>`:''); }
function modal(html, bind = () => {}) {
  closePopover(); $('#dialog-content').innerHTML=html; const dialog=$('#dialog'); dialog.returnValue=''; if (!dialog.open) dialog.showModal();
  $$('[data-dialog-close]',dialog).forEach(button=>button.onclick=()=>dialog.close()); bind(dialog);
}
function installGuide(kind) {
  const heading=kind==='installed'?'설치된 HTMLMemo입니다.':'HTMLMemo 앱 설치';
  let content;
  if(kind==='installed')content='<p class="dialog-description">앱 아이콘으로 실행 중입니다. HTML 파일을 가져와 읽고 주석을 남겨보세요.</p>';
  else if(kind==='local')content=`<p class="dialog-description">직접 연 HTML 파일이나 확장 기능 페이지에서는 PWA를 설치할 수 없습니다. Chrome에서 아래 앱 주소를 열고 같은 앱 설치 버튼을 누르세요. 앱 소유자가 GitHub Pages 배포를 먼저 완료해야 합니다.</p><p><a class="primary-button" href="${esc(installationURL(location))}">설치할 HTMLMemo 열기</a></p>`;
  else if(kind==='ios')content='<p class="dialog-description">아이폰·아이패드의 Chrome에서는 아래 순서로 설치합니다. 앱 버튼만으로 공유 메뉴를 자동으로 열 수는 없습니다.</p><ol class="setup-steps"><li>Chrome 주소창의 <strong>공유</strong> 버튼을 누릅니다.</li><li><strong>홈 화면에 추가</strong>를 선택합니다.</li><li>이름을 확인하고 <strong>추가</strong>를 누릅니다.</li><li>홈 화면의 <strong>HTMLMemo</strong> 아이콘으로 앱을 엽니다.</li></ol><p class="dialog-description small">iOS 16.4 이상과 최신 Chrome을 사용하세요. 처음 설치한 뒤 앱 아이콘으로 열고 문서를 가져오세요.</p>';
  else if(/Android/.test(navigator.userAgent||''))content='<ol class="setup-steps"><li>Chrome의 <strong>메뉴(⋮)</strong>를 엽니다.</li><li><strong>홈 화면에 추가 → 설치</strong>를 선택합니다.</li><li>앱 아이콘으로 HTMLMemo를 엽니다.</li></ol><p class="dialog-description small">설치 메뉴가 보이지 않으면 첫 로딩과 오프라인 준비가 끝난 뒤 다시 시도하세요.</p>';
  else content='<ol class="setup-steps"><li>Chrome 주소창 오른쪽의 <strong>설치</strong> 아이콘을 누릅니다.</li><li>아이콘이 없다면 Chrome 메뉴의 <strong>전송, 저장 및 공유 → 페이지를 앱으로 설치</strong>를 선택합니다.</li><li>설치를 확인하고 앱 아이콘으로 HTMLMemo를 엽니다.</li></ol><p class="dialog-description small">설치 안내가 자동으로 열리는 환경에서는 앱 설치 버튼을 다시 누르면 됩니다.</p>';
  modal(`<div class="dialog-heading"><h2>${heading}</h2><button class="icon-button" data-dialog-close aria-label="닫기">${icon('close')}</button></div>${content}<p class="local-only-note">${icon('check',15)} 문서·주석·설정은 기기에만 저장합니다.</p><div class="dialog-actions"><button class="primary-button" data-dialog-close>확인</button></div>`);
}
function updateInstall(state) {
  for(const selector of ['#install-button','#execution-install']){const button=$(selector);button.hidden=selector==='#install-button'&&state.installed;button.disabled=state.busy;const label=state.busy?'설치 확인 중…':state.installed?'설치 완료':'앱 설치';if(selector==='#install-button')button.innerHTML=icon('download',16)+'<span>'+label+'</span>';else button.textContent=label;button.title=label;button.setAttribute('aria-label',label);}
  $('#install-status').textContent=state.installed?'앱으로 실행 중입니다. 문서·주석·설정은 이 기기에 저장됩니다.':!installableLocation(location)?'PWA 설치는 배포된 앱 주소에서 가능합니다. HTML 파일의 읽기·주석은 계속 사용할 수 있습니다.':isIOS(navigator)?'아이폰은 앱 설치 버튼에서 Chrome 공유 메뉴 사용 순서를 확인하세요.':'설치 후 앱 아이콘으로 열고 HTML 파일을 가져오세요.';
}
function promptText(type, initial = '') {
  return new Promise(resolve=>{
    modal(`<form method="dialog" class="note-form"><div class="dialog-heading"><h2>${type==='text'?'텍스트 입력':'메모 남기기'}</h2><button class="icon-button" value="cancel" aria-label="닫기">${icon('close')}</button></div><textarea id="note-text" placeholder="생각을 적어보세요…" maxlength="10000" rows="6">${esc(initial)}</textarea><div class="dialog-actions"><button class="secondary-button" value="cancel">취소</button><button class="primary-button" value="save">저장</button></div></form>`,dialog=>{
      const done=()=>{ resolve(dialog.returnValue==='save'?$('#note-text').value:null); dialog.removeEventListener('close',done); }; dialog.addEventListener('close',done); requestAnimationFrame(()=>$('#note-text').focus());
    });
  });
}
function confirmDialog(title, description, label = '확인') {
  return new Promise(resolve=>modal(`<form method="dialog"><div class="dialog-heading"><h2>${esc(title)}</h2></div><p class="dialog-description">${esc(description)}</p><div class="dialog-actions"><button class="secondary-button" value="cancel">취소</button><button class="primary-button" value="confirm">${esc(label)}</button></div></form>`,dialog=>{
    const done=()=>{resolve(dialog.returnValue==='confirm');dialog.removeEventListener('close',done);};dialog.addEventListener('close',done);
  }));
}
function connectionDialog() {
  if(isIOS(navigator)||/Android/.test(navigator.userAgent||'')){
    modal(`<div class="dialog-heading"><h2>모바일에서 사용하기</h2><button class="icon-button" data-dialog-close aria-label="닫기">${icon('close')}</button></div><p class="dialog-description">이 Chrome 연결 기능은 맥·윈도우의 Chrome 확장 프로그램입니다. 안드로이드·아이폰의 Chrome에는 설치할 수 없습니다.</p><p class="dialog-description">모바일에서도 HTML 파일을 가져와 읽고 주석을 남길 수 있습니다. 주석은 앱 안의 HTML에 자동 저장하고, HTML 내보내기로 파일을 저장합니다.</p><div class="dialog-actions"><button id="mobile-import" class="primary-button">HTML 파일 가져오기</button><button class="secondary-button" data-dialog-close>확인</button></div>`,()=>{$('#mobile-import').onclick=safely(async()=>{$('#dialog').close();await importFiles();});});return;
  }
  modal(`<div class="dialog-heading"><h2>Chrome에서 웹 페이지 저장하기</h2><button class="icon-button" data-dialog-close aria-label="닫기">${icon('close')}</button></div><p class="dialog-description">맥·윈도우에서 실제 Chrome 탭을 저장하려면 연결 기능을 한 번 추가합니다. 기본 연결 주소는 seionwon/HTMLMemo의 PWA입니다.</p><ol class="setup-steps"><li>아래 <strong>Chrome 연결 파일 저장</strong>을 누르고 ZIP의 압축을 풉니다.</li><li>Chrome 주소창에 <code>chrome://extensions</code>를 입력하고, 오른쪽 위 <strong>개발자 모드</strong>를 켭니다.</li><li><strong>압축해제된 확장 프로그램 로드</strong>를 누르고 <strong>extension</strong> 폴더를 선택합니다.</li><li>이 앱을 새로고침합니다. 주소창에서 탐색하거나 웹 페이지의 확장 기능에서 <strong>페이지 저장</strong>을 누릅니다.</li></ol><button id="download-chrome" class="secondary-button">Chrome 연결 파일 저장</button><details class="connection-advanced"><summary>현재 로컬 HTML 파일에 연결하기</summary><p class="dialog-description small">확장 기능 설정의 다른 연결 주소에 아래 주소를 입력합니다. 로컬 파일은 확장 기능의 세부정보에서 「파일 URL에 대한 액세스 허용」을 켠 뒤 다시 여세요. 직접 연 파일과 설치된 PWA의 보관함은 별도입니다.</p><div class="copy-url"><input readonly value="${esc(appAddress())}" aria-label="HTMLMemo 주소"><button class="secondary-button" id="copy-app-url">복사</button></div></details><div class="dialog-actions"><button class="secondary-button" id="check-connection">연결 확인</button><button class="primary-button" data-dialog-close>완료</button></div>`,()=>{
    $('#download-chrome').onclick=safely(async()=>{const button=$('#download-chrome');button.disabled=true;try{download(chromeZIP(await distributionAssets()),'HTMLMemo-chrome.zip','application/zip');toast('압축을 풀고 extension 폴더를 선택해주세요.');}finally{button.disabled=false;}});
    $('#copy-app-url').onclick=safely(async()=>{await navigator.clipboard.writeText(appAddress());toast('앱 주소를 복사했습니다.');});
    $('#check-connection').onclick=safely(async()=>{const ok=await discoverBridge(); updateConnection(); toast(ok?'Chrome이 연결되었습니다.':'확장 기능을 설치한 뒤 페이지를 새로고침해주세요.',!ok);if(ok)await receiveCaptures();});
  });
}
function updateConnection() { $('#connection-button').classList.toggle('connected',bridgeAvailable()); const label=bridgeAvailable()?'Chrome 연결됨':'Chrome 연결';$('#connection-button span').textContent=label;$('#connection-button').title=label;$('#connection-button').setAttribute('aria-label',label); }
function settingsDialog() {
  modal(`<div class="dialog-heading"><h2>HTMLMemo 설정</h2><button class="icon-button" data-dialog-close aria-label="닫기">${icon('close')}</button></div><p class="local-only-note">${icon('check',15)} 모든 문서·주석·설정은 이 기기에만 저장됩니다.</p><div class="setting-row"><div><strong>자동 저장 폴더</strong><p>${folder?esc(folder.name):settingsFolderHint?'백업 폴더: '+esc(settingsFolderHint)+' · 다시 연결해주세요.':'앱 내부에 HTML 파일로 보관 중'}</p></div><button id="settings-folder" class="secondary-button">${folder?'변경':'폴더 연결'}</button></div><p class="dialog-description small">폴더 권한은 설정 파일로 옮길 수 없어 새 기기에서 한 번 연결해야 합니다.</p><div class="setting-row"><div><strong>화면 테마</strong><p>서재와 도구의 밝기를 선택하세요.</p></div><select id="appearance"><option value="light">밝게</option><option value="dark">어둡게</option><option value="system">시스템</option></select></div><div class="setting-row"><div><strong>툴바 위치</strong><p>옮긴 위치도 설정 파일에 보관합니다.</p></div><button id="reset-toolbar-position" class="secondary-button">가운데로</button></div><div class="settings-backup"><h3>설정 파일</h3><p class="dialog-description small">테마·정렬·주석 색상·굵기·투명도·표시 시간·툴바 위치를 JSON 파일로 저장하고 다시 불러옵니다.</p><p id="settings-file-name" class="settings-file-name">${settingsFileHandle?esc(settingsFileHandle.name):'연결한 설정 파일이 없습니다.'}</p><div class="settings-file-actions"><button id="settings-save" class="secondary-button">${icon('save',15)} 설정 파일 저장</button><button id="settings-load" class="secondary-button">${icon('folder',15)} 설정 파일 불러오기</button><button id="settings-reload" class="secondary-button" ${settingsFileHandle?'':'disabled'}>${icon('reload',15)} 다시 불러오기</button></div></div><div class="setting-row"><div><strong>Chrome 연결</strong><p>${bridgeAvailable()?'연결되어 있습니다.':'웹 페이지를 저장하기'}</p></div><button id="settings-chrome" class="secondary-button">설정 방법</button></div><div class="setting-row"><div><strong>기기 보관함 유지</strong><p>브라우저의 자동 공간 정리에서 보호 요청</p></div><button id="persist-storage" class="secondary-button">보관 유지</button></div><p class="dialog-description small">앱 데이터 삭제 시 내부 보관함도 지워집니다. 중요한 문서는 HTML 파일로 내보내주세요.</p>`,()=>{
    $('#settings-folder').onclick=safely(async()=>{await chooseFolder();settingsDialog();});$('#settings-chrome').onclick=connectionDialog;
    $('#appearance').value=preferences.theme; $('#appearance').onchange=safely(e=>changePreferences({theme:e.target.value}));
    $('#settings-save').onclick=safely(saveSettingsBackup);$('#settings-load').onclick=safely(importSettingsBackup);$('#settings-reload').onclick=safely(async()=>{await restoreSettings(settingsFileHandle);settingsDialog();});
    $('#reset-toolbar-position').onclick=safely(()=>{changePreferences({toolbarPosition:null});toast('툴바를 가운데로 옮겼습니다.');});
    $('#persist-storage').onclick=safely(async()=>toast(await navigator.storage.persist()?'이 기기에서 보관함을 유지합니다.':'브라우저가 보관 유지를 허용하지 않았습니다. HTML 내보내기로 파일을 보관해주세요.'));
  });
}
function applyTheme(theme) { document.documentElement.dataset.theme=theme==='system'?(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'):theme; }
function applyToolbarPosition(){const bar=$('#toolbar'),p=preferences.toolbarPosition;if(!p){bar.style.left='50%';bar.style.top='';bar.style.bottom='';bar.style.transform='';return;}bar.style.transform='none';bar.style.bottom='auto';bar.style.left=(8+p.x*Math.max(0,innerWidth-bar.offsetWidth-16))+'px';bar.style.top=(8+p.y*Math.max(0,innerHeight-bar.offsetHeight-42))+'px';}
function changePreferences(patch){preferences=storePreferences({...preferences,...patch,annotation:{...preferences.annotation,...patch.annotation}},localStorage);applyTheme(preferences.theme);$('#library-sort').value=preferences.librarySort;for(const tab of tabs)if(tab.reader)Object.assign(tab.reader,preferences.annotation);applyToolbarPosition();renderLibrary();if(reader())updateToolbarState();}
async function restoreSettings(input){
  if(input?.kind==='file'&&input.queryPermission){const options={mode:'read'};if(await input.queryPermission(options)!=='granted'&&await input.requestPermission(options)!=='granted')throw new Error('설정 파일 읽기 권한이 필요합니다. 파일을 다시 선택해주세요.');}
  const backup=await readSettingsFile(input);changePreferences(backup.preferences);settingsFolderHint=backup.folderName;await setSetting('settings-folder-hint',settingsFolderHint);
  if(input?.kind==='file'){settingsFileHandle=input;await setSetting('settings-file',input);}else{settingsFileHandle=null;await setSetting('settings-file',null);}
  toast('설정을 불러와 적용했습니다.'+(settingsFolderHint&&!folder?' 저장 폴더는 다시 연결해주세요.':''));
}
async function importSettingsBackup(){
  if(openPicker()){try{const [handle]=await window.showOpenFilePicker({types:[{description:'HTMLMemo 설정',accept:{'application/json':['.json']}}]});await restoreSettings(handle);settingsDialog();return;}catch(error){if(!['SecurityError','NotSupportedError'].includes(error.name))throw error;}}
  $('#settings-file-input').click();
}
async function saveSettingsBackup(){
  const json=serializeSettings(preferences,folder?.name||settingsFolderHint);
  if(savePicker()){try{const handle=await window.showSaveFilePicker({suggestedName:settingsFileHandle?.name||'HTMLMemo-settings.json',types:[{description:'HTMLMemo 설정',accept:{'application/json':['.json']}}]});const writer=await handle.createWritable();try{await writer.write(json);await writer.close();}catch(error){await writer.abort().catch(()=>{});throw error;}settingsFileHandle=handle;await setSetting('settings-file',handle);settingsDialog();toast('설정을 로컬 파일로 저장했습니다.');return;}catch(error){if(!['SecurityError','NotSupportedError'].includes(error.name))throw error;}}
  download(json,'HTMLMemo-settings.json','application/json;charset=utf-8');toast('설정 JSON 파일을 저장했습니다. 「설정 파일 불러오기」로 다시 열 수 있어요.');
}
async function refreshLibrary() { records=await listDocuments(); renderLibrary(); }
function renderLibrary() {
  const filter=$('#library-filter').value.toLocaleLowerCase(); const sort=$('#library-sort').value;
  const shown=records.filter(r=>(r.title+' '+r.source+' '+r.name).toLocaleLowerCase().includes(filter)).sort((a,b)=>sort==='title'?a.title.localeCompare(b.title,'ko'):b[sort]-a[sort]);
  $('#document-count').textContent=records.length; $('#empty-library').hidden=shown.length>0;
  $('#empty-library h3').textContent=records.length?'검색 결과가 없습니다.':'첫 페이지를 보관해보세요.';
  $('#empty-library p').innerHTML=records.length?'다른 제목이나 주소로 찾아보세요.':'웹에서 저장하거나, 가지고 있는 HTML 파일을 열면<br>이곳에서 계속 읽고 메모할 수 있어요.';
  $('#open-example').hidden=!!records.length;
  $('#document-grid').innerHTML=shown.map(record=>{
    const count=record.metadata?.annotations?.length||0;const progress=record.metadata?.view?.scrollTop||0;
    return `<article class="document-card" data-record="${record.id}"><button class="card-open" data-open="${record.id}"><div class="card-preview"><div class="preview-host">${icon('globe',13)} ${esc(displayHost(record.source))}</div><h3>${esc(record.title)}</h3><div class="preview-lines"><i></i><i></i><i></i></div>${count?`<span class="preview-annotation">${icon('highlight',13)} ${count}개의 주석</span>`:''}</div><div class="card-details"><h3>${esc(record.title)}</h3><p>${esc(displayHost(record.source))} <span>·</span> ${formatDate(record.modified)}</p><div class="card-meta"><span>HTML <i>·</i> ${record.byteSize?formatBytes(record.byteSize):'HTML'}</span><span>${progress?'이어서 읽기':'새 문서'} ${icon('forward',13)}</span></div></div></button><button class="card-menu icon-button" data-card-menu="${record.id}" aria-label="${esc(record.title)} 문서 메뉴">${icon('more',17)}</button></article>`;
  }).join('');
  $$('[data-open]').forEach(button=>button.onclick=safely(()=>openRecord(records.find(r=>r.id===button.dataset.open))));
  $$('[data-card-menu]').forEach(button=>button.onclick=()=>documentMenu(records.find(r=>r.id===button.dataset.cardMenu)));
  $('#choose-folder').innerHTML=(folder?esc(folder.name)+' 연결됨':'저장 폴더 연결')+' '+icon('external',13);
  if(activeId==='library')$('#status-left').textContent=`${records.length}개의 문서 · ${folder?folder.name+' 자동 저장':'이 기기에 보관'}`;
}
function renderTabs() {
  const container=$('#tabs'),nodes=new Map($$('[data-tab]',container).map(el=>[el.dataset.tab,el]));
  for(const tab of tabs){
    let el=nodes.get(tab.id);
    if(!el){
      el=document.createElement('div');el.dataset.tab=tab.id;el.setAttribute('role','tab');el.tabIndex=0;
      el.innerHTML=`<span class="tab-icon">${icon(tab.type==='document'?'file':'globe',15)}</span><span class="tab-title"></span><i class="tab-dirty" hidden></i><button class="tab-close" data-close="${tab.id}">${icon('close',13)}</button>`;
      el.onclick=e=>{if(!e.target.closest('[data-close]'))activate(tab.id);};
      el.onkeydown=e=>{if(e.key==='Enter'||e.key===' ')activate(tab.id);};
      $('[data-close]',el).onclick=safely(e=>{e.stopPropagation();return closeTab(tab.id);});container.append(el);
    }
    el.className=`tab ${tab.id===activeId?'active':''} ${tab.type}`;el.title=tab.title;el.setAttribute('aria-selected',String(tab.id===activeId));
    const title=$('.tab-title',el);if(title.textContent!==tab.title)title.textContent=tab.title;
    $('.tab-dirty',el).hidden=!tab.opening && !tab.queue?.pending;
    $('[data-close]',el).setAttribute('aria-label',tab.title+' 탭 닫기');
    nodes.delete(tab.id);
  }
  for(const node of nodes.values())node.remove();
  $('#library-tab').classList.toggle('active',activeId==='library');
  $('#desk-library').setAttribute('aria-current',activeId==='library'?'page':'false');
  $('#desk-execution').setAttribute('aria-current',activeId==='execution'?'page':'false');
  $('#execution-tab').classList.toggle('active',activeId==='execution');
}
function activate(id) {
  if(id!==activeId)reader()?.stopSpeech();
  if(readerFocused && id!==activeId)void leaveReaderFocus();
  closePopover(); closeSidebar(); activeId=id; $('#library').hidden=id!=='library';$('#execution').hidden=id!=='execution';$('#workspace').hidden=id==='library'||id==='execution';
  tabs.forEach(tab=>tab.host.hidden=tab.id!==id);renderTabs();$('[data-tab="'+id+'"]')?.scrollIntoView?.({block:'nearest',inline:'nearest'});updateChrome();
  if(reader()){renderToolbar();if(reader().dynamicDirty)reader().scheduleDynamicRefresh();}else $('#toolbar').hidden=true;
  if(id==='library')renderLibrary();
  if(id==='execution'){$('#status-left').textContent='앱 설치 · URL 공유 · 모든 데이터는 이 기기에 저장';document.title='앱 설치 · URL 공유 · HTMLMemo';}
}
function updateChrome() {
  const tab=active(); const r=reader(); const local=tab?.type==='document';const execution=activeId==='execution';
  $('#address').value=local?tab.record.name:tab?.url||'';$('#address-icon').innerHTML=icon(local?'file':'globe',15);$('#local-label').hidden=!local;
  $('#back').disabled=local?!r?.linkHistory.length:!tab||!tab.chromeId&&tab.cursor<=0;
  $('#forward').disabled=!tab||local||!tab.chromeId&&tab.cursor>=tab.history.length-1;
  $('#reload').disabled=!tab||local;
  $('#save-page').innerHTML=icon(execution?'globe':local?'download':'save',17)+`<span>${execution?'URL 복사':local?'HTML 내보내기':'페이지 저장'}</span>`;
  $('#save-page').disabled=execution?sharingApp:!tab;
  if(local)saveStatus(tab); else if(tab)$('#status-left').textContent=tab.chromeId?'실제 Chrome 탭에서 탐색 중':'웹 탐색 · 로컬로 저장하면 주석을 남길 수 있어요.';
  document.title=tab?tab.title+' · HTMLMemo':'HTMLMemo · 나만의 웹 서재';
}
function createHost(id,type) { const host=document.createElement('div');host.id='workspace-'+id;host.className='workspace-host '+type+'-host';host.hidden=true;$('#workspaces').append(host);return host; }
async function openRecord(record, prepared = null, {deferReady = false} = {}) {
  const existing=tabs.find(tab=>tab.record?.id===record.id);if(existing){if(existing.closePromise){await existing.closePromise;return openRecord(record,prepared,{deferReady});}activate(existing.id);return existing;}
  if(!prepared && typeof record.html!=='string' && !record.file)record=await getDocument(record.id);
  const opened=tabs.find(tab=>tab.record?.id===record.id);if(opened){if(opened.closePromise){await opened.closePromise;return openRecord(record,prepared,{deferReady});}activate(opened.id);return opened;}
  // The library already holds a prepared, sanitized snapshot. Reopening it
  // should parse it once in the iframe, not clone the entire book in DOMParser first.
  const parsed=prepared || (record.file ? {file:record.file,metadata:structuredClone(record.metadata),nativeScroll:true,savedMetadata:true} : record.metadata ? (() => {
    const metadata = structuredClone(record.metadata);
    metadata.execution = {...(metadata.execution || {}), allowScripts: true};
    const html = typeof record.html === 'string'
      ? record.html.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy\b[^>]*>/gi, `<meta http-equiv="Content-Security-Policy" content="${SCRIPT_CSP}">`)
      : record.html;
    return {html, metadata, nativeScroll: record.nativeScroll || metadata.execution?.allowScripts || record.byteSize >= 4 * 1024 * 1024, savedMetadata: true};
  })() : parseHTML(record.html,{title:record.title,source:record.source,allowScripts:true}));
  const tab={id:uid(),type:'document',title:record.title,opening:true,record:{...record,nativeScroll:!!parsed.nativeScroll},host:null};tab.host=createHost(tab.id,'document');
  tab.queue=new SaveQueue(async()=>{
    await tab.reader.ready;
    const html=tab.record.html; const metadata=structuredClone(tab.reader.metadata);
    tab.record.html=html;tab.record.metadata=metadata;tab.record.title=metadata.title;tab.record.modified=Date.now();
    await saveDocumentHTML(tab.record, html, {revision:tab.restoredFrom?{restoredFrom:tab.restoredFrom}:undefined});
    tab.restoredFrom=null;
    const {html:body,file:sourceFile,...summary}=tab.record;
    records=records.filter(r=>r.id!==record.id).concat(summary);
    delete tab.record.html;delete tab.record.file;
  },()=>{if(activeId===tab.id)saveStatus(tab);renderTabs();});
  tabs.push(tab);activate(tab.id);
  tab.reader=new Reader(tab.host,parsed,{
    onChange:()=>{tab.queue.schedule();if(activeId===tab.id){renderToolbar();if(sidebarMode==='annotations')renderSidebar('annotations');}},
    onPosition:()=>{tab.queue.schedule();},onView:()=>{if(activeId===tab.id){updateChrome();updateToolbarState();}},
    onTextSelection:()=>{if(activeId===tab.id)showSelectionMenu(tab.reader);},
    onSelectionDismiss:()=>{if(popoverName==='selection')closePopover();},
    onLink:url=>safely(openBrowser)(url),onKey:handleKey,requestText:promptText,onError:showError,
    onDocumentFocus:()=>{if(activeId===tab.id)void toggleReaderFocus();},
    onSelect:id=>{if(activeId===tab.id)annotationDialog(tab,id);},
  });
  Object.assign(tab.reader,preferences.annotation);
  try { await tab.reader.ready; } catch(error) {tabs.splice(tabs.indexOf(tab),1);tab.reader.dispose();activate('library');throw error;}
  if(parsed.file){tab.record.file=parsed.file;delete tab.record.html;tab.reader.initialHTML=null;tab.record.metadata=tab.reader.metadata;tab.record.source=tab.reader.metadata.source;tab.title=tab.record.title=tab.reader.metadata.title;}
  renderToolbar();
  updateChrome();
  // Preserve the imported/current annotation baseline before the first new edit.
  try{const saved=await putDocumentRevision(tab.record,{baseline:true});tab.record.byteSize=saved.byteSize;delete tab.record.html;delete tab.record.file;}
  catch(error){tab.queue.schedule();try{await tab.queue.flush();}catch{showError(error);}}
  record.html=null;record.file=null;parsed.html=null;parsed.file=null;
  if(!deferReady){tab.opening=false;renderTabs();if(activeId===tab.id)updateChrome();}
  return tab;
}
function saveStatus(tab) {
  const queue=tab.queue;if(!queue)return;
  const label=queue.error?'주석 자동 저장 실패 · '+queue.error.message:queue.pending||tab.opening?'저장 중…':'주석이 앱에 자동 저장됨';
  const status=$('#status-left');let state=$('.save-state',status);
  if(!state){status.replaceChildren();state=document.createElement('span');status.append(state);}
  state.className=`save-state ${queue.error?'save-error':''}`;
  state.innerHTML=`${icon(queue.error?'more':queue.pending?'reload':'check',13)} ${esc(label)}`;
  let retry=$('#retry-save');
  if(queue.error){
    if(!retry){retry=document.createElement('button');retry.id='retry-save';retry.className='text-button';status.append(retry);}
    retry.textContent='저장 재시도';retry.onclick=safely(async()=>{tab.queue.schedule();await tab.queue.flush();});
  }else retry?.remove();
}
async function closeTab(id) {
  const tab=tabs.find(t=>t.id===id);if(!tab)return;
  if(tab.closePromise)return tab.closePromise;
  tab.closing=true;
  tab.closePromise=(async()=>{
    try{
      if(tab.reader){await tab.reader.ready;tab.reader.rememberPosition();await tab.queue.flush();tab.reader.dispose();}else tab.host.remove();
      tabs.splice(tabs.indexOf(tab),1);if(activeId===id)activate(tabs.at(-1)?.id||'library');else renderTabs();await refreshLibrary();
    }finally{tab.closing=false;tab.closePromise=null;}
  })();
  return tab.closePromise;
}
async function createDocument(snapshot, handle = null, name = null, local = {}) {
  const parsed=snapshot.file ? {...parseHTML('<html><head></head><body></body></html>',{title:snapshot.title,execution:{allowScripts:!!snapshot.allowScripts}}),file:snapshot.file,nativeScroll:true} : parseHTML(snapshot.html,{title:snapshot.title,source:snapshot.url,viewport:snapshot.viewport,warnings:snapshot.warnings},{includeMetadata:true,allowScripts:snapshot.allowScripts});
  const title=parsed.metadata.title; const record={id:uid(),title,name:name||handle?.name||filename(title),source:parsed.metadata.source,created:Date.now(),modified:Date.now(),fileHandle:handle,originalHandle:local.originalHandle||null,metadata:parsed.metadata};
  if(snapshot.file)record.file=snapshot.file;else record.html=parsed.html;
  if(local.diskStamp)record.diskStamp=local.diskStamp;
  else if(handle){const disk=await handle.getFile();record.diskStamp={modified:disk.lastModified,size:disk.size};}
  const {html:body,file:sourceFile,...summary}=record;records=records.filter(r=>r.id!==record.id).concat(summary);let tab;
  try{tab=await openRecord(record,parsed,{deferReady:true});}catch(error){records=records.filter(r=>r.id!==record.id);renderLibrary();throw error;}
  if(tab.closing || !tabs.includes(tab)){tab.opening=false;return tab;}
  tab.queue.schedule();
  try { await tab.queue.flush(); } catch(error) { showError(error); }
  if(tab.closing || !tabs.includes(tab)){tab.opening=false;return tab;}
  if(handle && !local.originalHandle && !tab.queue.error)await writeExternalHTML(tab.record,tab.reader.html());
  tab.opening=false;renderLibrary();activate(tab.id);
  if(tab.queue.error)return tab;
  if(parsed.metadata.warnings.length)toast(`페이지를 저장했습니다. ${parsed.metadata.warnings.length}개의 리소스를 보관하지 못했습니다. 문서 정보에서 확인할 수 있어요.`,true);
  else toast(local.originalHandle||name?'로컬 HTML을 주석 탭에서 열었습니다.':'HTML 파일로 저장하고 새 탭에서 열었습니다.');
  return tab;
}
async function chooseFolder() {
  if(!window.showDirectoryPicker){toast('이 브라우저는 외부 폴더 연결을 지원하지 않습니다. 앱에 자동 저장되며 HTML 내보내기를 사용할 수 있어요.');return;}
  folder=await window.showDirectoryPicker({id:'htmlmemo-storage',mode:'readwrite'});await setSetting('folder',folder);renderLibrary();toast(folder.name+' 폴더에 새 문서를 자동 저장합니다.');
}
async function folderFile(title) {
  if(!folder||!await permission(folder))return null;
  const base=filename(title);let name=base;
  for(let i=0;i<10000;i++) {
    try {await folder.getFileHandle(name);name=base.slice(0,-5)+` (${i+1}).html`;}catch(error){if(error.name!=='NotFoundError')throw error;return folder.getFileHandle(name,{create:true});}
  }
  throw new Error('같은 이름의 파일이 너무 많습니다.');
}
async function importFiles() {
  if(!openPicker()){$('#file-input').click();return;}
  let handles;try{handles=await window.showOpenFilePicker({types:htmlTypes,multiple:true});}catch(error){if(['SecurityError','NotSupportedError'].includes(error.name)){$('#file-input').click();return;}throw error;}
  for(const handle of handles)await openLocalFile(handle);
}
async function openLocalFile(input) {
  $('#status-left').textContent='로컬 HTML을 읽는 중…';
  const local=await readLocalHTML(input,{native:true,allowScripts:true});
  $('#status-left').textContent='HTML 문서를 준비하는 중…';
  await new Promise(resolve=>setTimeout(resolve,0));
  return createDocument(local.snapshot,local.handle,local.name,local);
}
async function savePage() {
  if(activeId==='execution')return copyAppURL();
  const tab=active();if(!tab)return;
  if(tab.reader)return exportDocument(tab);
  let live;
  if(!tab.chromeId) {try {live=tab.frame.contentDocument;if(!live?.documentElement)live=null;}catch{live=null;}}
  if(!live&&!bridgeAvailable()){connectionDialog();return;}
  // File pickers and requestPermission must run while this button's transient
  // activation is still valid, before capture/network work.
  let handle=null;
  if(folder){if(!await permission(folder,true))throw new Error('저장 폴더 쓰기 권한이 필요합니다.');}
  else if(savePicker()){try{handle=await window.showSaveFilePicker({suggestedName:filename(tab.title),types:htmlTypes});}catch(error){if(!['SecurityError','NotSupportedError'].includes(error.name))throw error;}}
  $('#save-page').disabled=true;$('#save-page').innerHTML=icon('reload',17)+'<span>페이지 보관 중…</span>';
  try {
    let snapshot;
    if(live)snapshot=await HTMLMemoCapture.captureDocument(live);
    else {
      if(!tab.chromeId){const result=await bridge('openBrowser',{url:tab.url,active:false});tab.chromeId=result.id;}
      snapshot=await bridge('captureTab',{tabId:tab.chromeId},180000);
    }
    if(!handle)handle=await folderFile(snapshot.title);
    await createDocument(snapshot,handle);
  } finally {updateChrome();}
}
async function exportDocument(tab) {
  // Invoke the picker before awaiting persistence, while the click still has user activation.
  let handle;
  if(savePicker()) {
    try { handle=await window.showSaveFilePicker({suggestedName:tab.record.name.replace(/\.html?$/i,'-주석.html'),types:htmlTypes}); }
    catch(error){if(!['SecurityError','NotSupportedError'].includes(error.name))throw error;}
  }
  await tab.reader.ready;await tab.queue.flush();
  const html=tab.reader.html();
  if(handle){const disk=await handle.getFile();await writeExternalHTML({fileHandle:handle,diskStamp:{modified:disk.lastModified,size:disk.size}},html);}
  else download(html,tab.record.name);
  toast('현재 주석을 포함한 HTML을 내보냈습니다. 이후 주석은 앱에 자동 저장됩니다.');
}

async function openBrowser(input, forceNew = true) {
  if(/^file:/i.test(input.trim())){await importFiles();return;}
  const url=normalizeURL(input);const current=active();
  if(!forceNew&&current?.type==='browser')return navigate(current,url);
  const tab={id:uid(),type:'browser',title:displayHost(url),url,history:[url],cursor:0,chromeId:null,host:null};tab.host=createHost(tab.id,'browser');tabs.push(tab);
  tab.host.innerHTML=`<div class="browser-note"><span>${icon('globe',15)} 웹 탐색</span><button class="text-button" data-open-chrome>Chrome에서 열기 ${icon('external',13)}</button><button class="text-button" data-capture>페이지 저장 ${icon('save',13)}</button></div><iframe class="browser-frame" title="웹 페이지" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads" referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
  tab.frame=$('iframe',tab.host);tab.frame.addEventListener('load',()=>{
    try {
      const doc=tab.frame.contentDocument;if(!doc)return;
      tab.title=doc.title||displayHost(tab.url);const next=doc.location.href;if(next!=='about:blank'&&next!==tab.url){tab.url=next;tab.history.splice(tab.cursor+1);tab.history.push(next);tab.cursor++;}
      doc.addEventListener('click',event=>{const link=event.target.closest('a[href]');if(link&&/^https?:/.test(link.href)){event.preventDefault();safely(()=>link.target==='_blank'?openBrowser(link.href):navigate(tab,link.href))();}});
      renderTabs();if(activeId===tab.id)updateChrome();
    } catch { /* Cross-origin frames remain ordinary live browsing surfaces. */ }
  });
  $('[data-open-chrome]',tab.host).onclick=safely(()=>openRealChrome(tab));$('[data-capture]',tab.host).onclick=safely(savePage);
  activate(tab.id);
  if(bridgeAvailable())await openRealChrome(tab);else {tab.frame.src=url;$('.browser-note span',tab.host).innerHTML=icon('globe',15)+'<span>표시되지 않는 사이트는 Chrome에서 열어주세요.</span>';}
  return tab;
}
async function openRealChrome(tab) {
  if(!bridgeAvailable()){window.open(tab.url,'_blank','noopener,noreferrer');connectionDialog();return;}
  if(tab.chromeId){await bridge('focusTab',{tabId:tab.chromeId});return;}
  const result=await bridge('openBrowser',{url:tab.url});tab.chromeId=result.id;tab.title=result.title||tab.title;
  tab.frame.hidden=true;
  const card=document.createElement('div');card.className='chrome-page-card';card.innerHTML=`<div class="chrome-page-icon">${icon('globe',38)}</div><p class="eyebrow">CONNECTED TO CHROME</p><h2>${esc(displayHost(tab.url))}</h2><p>이 페이지는 실제 Chrome 탭에서 열려 있습니다.<br>탐색을 마친 뒤 저장하면, 이곳에서 주석을 남길 수 있어요.</p><div><button class="primary-button" data-focus-chrome>Chrome 탭으로 이동 ${icon('external',15)}</button><button class="secondary-button" data-save-chrome>HTML로 저장</button></div><small>웹 페이지의 확장 기능에서도 바로 저장할 수 있습니다.</small>`;
  $('.chrome-page-card',tab.host)?.remove();tab.host.append(card);$('[data-focus-chrome]',card).onclick=safely(()=>bridge('focusTab',{tabId:tab.chromeId}));$('[data-save-chrome]',card).onclick=safely(savePage);renderTabs();updateChrome();
}
async function navigate(tab,url) {
  tab.url=url;tab.title=displayHost(url);tab.history.splice(tab.cursor+1);tab.history.push(url);tab.cursor++;
  if(tab.chromeId)await bridge('navigateTab',{tabId:tab.chromeId,url});else tab.frame.src=url;
  renderTabs();updateChrome();
}
async function browserHistory(direction) {
  const tab=active();if(!tab)return;
  if(tab.reader){if(direction<0)await tab.reader.back();updateChrome();return;}
  if(tab.chromeId)await bridge(direction<0?'backTab':'forwardTab',{tabId:tab.chromeId});
  else {const next=tab.cursor+direction;if(next<0||next>=tab.history.length)return;tab.cursor=next;tab.url=tab.history[next];tab.frame.src=tab.url;updateChrome();}
}
async function receiveCaptures() {
  if(receiving||!bridgeAvailable())return;receiving=true;
  try {const captures=await bridge('takeCaptures',{},30000);for(const capture of captures){const handle=await folderFile(capture.title);await createDocument(capture,handle);await bridge('ackCapture',{captureId:capture.id});}}
  finally{receiving=false;}
}
function toolbarButton(action,name,label,extra='') {return `<button class="tool-button" data-action="${action}" aria-label="${label}" title="${label}" ${extra}>${icon(name,18)}</button>`;}
function renderToolbar() {
  const r=reader();if(!r||!r.doc)return;
  $('#toolbar').hidden=false;
  $('#toolbar').innerHTML=`<button class="toolbar-grip" aria-label="툴바 이동">${icon('grip',14)}</button><span class="tool-group">${toolbarButton('select','select','선택 / 읽기 (V)')}${toolbarButton('pen','pen','펜 (P)')}${toolbarButton('highlight','highlight','형광펜 (H)')}${toolbarButton('underline','underline','밑줄 (U)')}${toolbarButton('eraser','eraser','지우개 (E)')}${toolbarButton('note','note','메모 (N)')}</span><span class="toolbar-divider"></span>${toolbarButton('palette','palette','색상 · 굵기 · 투명도 설정','class="tool-button palette-button"')}<span class="tool-group toolbar-history">${toolbarButton('undo','undo','실행 취소 (Ctrl/⌘ Z)')}${toolbarButton('redo','redo','다시 실행 (Ctrl/⌘ Shift Z)')}</span><span class="toolbar-divider"></span><button class="tool-button zoom-button" data-action="zoom" title="확대 / 축소" aria-label="확대 / 축소">${Math.round(r.zoom*100)}%</button>${toolbarButton('speak','speaker','소리내어 읽기 (TTS 툴바)')}${toolbarButton('more','more','더 많은 도구')}`;
  $$('[data-action]',$('#toolbar')).forEach(button=>{button.onpointerdown=e=>{if(e.pointerType==='mouse')e.preventDefault();};button.onclick=()=>toolAction(button.dataset.action);});
  bindToolbarDrag();updateToolbarState();
  applyToolbarPosition();
}
function updateToolbarState() {
  const r=reader();if(!r)return;
  $$('[data-action]',$('#toolbar')).forEach(button=>{const selected=button.dataset.action===r.tool;button.classList.toggle('active',selected);if(['select','pen','highlight','underline','eraser','note'].includes(button.dataset.action))button.setAttribute('aria-pressed',String(selected));});
  const undo=$('[data-action="undo"]',$('#toolbar'));if(undo)undo.disabled=!r.history.canUndo;
  const redo=$('[data-action="redo"]',$('#toolbar'));if(redo)redo.disabled=!r.history.canRedo;
  const zoom=$('.zoom-button');if(zoom)zoom.textContent=Math.round(r.zoom*100)+'%';
  const palette=$('[data-action="palette"]',$('#toolbar'));if(palette)palette.style.setProperty('--tool-color',r.color);
}
function closePopover() {popoverName='';$('#tool-popover').hidden=true;}
function positionPopover() {
  const pop=$('#tool-popover');const bar=$('#toolbar').getBoundingClientRect();pop.style.left=Math.max(10,Math.min(innerWidth-pop.offsetWidth-10,bar.left+bar.width-pop.offsetWidth))+'px';
  const above=bar.top-pop.offsetHeight-10;pop.style.top=(above>8?above:Math.min(innerHeight-pop.offsetHeight-8,bar.bottom+10))+'px';
}
function showPopover(name,html,bind=()=>{}) {
  if(popoverName===name){closePopover();return;}
  $('#tool-popover').removeAttribute('aria-label');$('#tool-popover').removeAttribute('role');
  popoverName=name;$('#tool-popover').classList.toggle('selection',name==='selection');$('#tool-popover').classList.toggle('palette-popover',name==='palette');$('#tool-popover').innerHTML=html;$('#tool-popover').hidden=false;positionPopover();
  $$('[data-popover-close]',$('#tool-popover')).forEach(button=>button.onclick=closePopover);
  bind();
}
function getAllPalettes() {
  return [...PRESET_PALETTES, ...(preferences.annotation.customPalettes || [])];
}
function getActivePalette() {
  const all = getAllPalettes();
  const id = preferences.annotation.paletteId || 'preset-1';
  return all.find(p => p.id === id) || PRESET_PALETTES[0];
}
function renderPalettePopoverContent(r) {
  const pop = $('#tool-popover');
  const activePalette = getActivePalette();
  const customPalettes = preferences.annotation.customPalettes || [];
  const isCustomPalette = customPalettes.some(p => p.id === activePalette.id);
  const customColors = preferences.annotation.customColors || [];
  const currentColor = (r.color || '#edcf67').toLowerCase();
  let pickerHsv = hexToHsv(currentColor);
  const rgb = hexToRgb(currentColor);
  pop.innerHTML = `<div class="popover-heading"><h3>펜과 색상</h3><button type="button" class="icon-button popover-close" data-popover-close aria-label="펜과 색상 닫기" title="닫기">${icon('close',16)}</button></div>`
    + `<div class="palette-section"><div class="palette-bar"><span class="palette-label">팔레트 프리셋</span><div class="palette-actions"><select id="palette-preset" aria-label="팔레트 프리셋"><optgroup label="프리셋 팔레트 (20개)">${PRESET_PALETTES.map((p, idx) => `<option value="${esc(p.id)}" ${p.id === activePalette.id ? 'selected' : ''}>${idx + 1}. ${esc(p.name)} (${p.colors.length})</option>`).join('')}</optgroup>${customPalettes.length ? `<optgroup label="사용자 팔레트 (${customPalettes.length}개)">${customPalettes.map(p => `<option value="${esc(p.id)}" ${p.id === activePalette.id ? 'selected' : ''}>★ ${esc(p.name)} (${p.colors.length})</option>`).join('')}</optgroup>` : ''}</select>${isCustomPalette ? `<button type="button" id="delete-custom-palette" class="palette-mini-btn danger" title="선택한 사용자 팔레트 삭제" aria-label="사용자 팔레트 삭제">삭제</button>` : ''}</div></div><div id="preset-swatches" class="swatches preset-swatches">${activePalette.colors.map(c => `<button type="button" data-color="${c}" style="--swatch:${c}" title="${c}" aria-label="색상 ${c}" class="swatch ${currentColor === c ? 'chosen' : ''}"></button>`).join('')}</div></div>`
    + `<div class="palette-section"><div class="palette-bar"><span class="palette-label">사용자 색상 (${customColors.length})</span><div class="palette-actions"><button type="button" id="add-custom-color" class="palette-mini-btn" title="현재 색상을 사용자 색상에 추가">+ 색상 추가</button><button type="button" id="remove-custom-color" class="palette-mini-btn" ${customColors.includes(currentColor) ? '' : 'disabled'} title="선택한 사용자 색상 삭제">− 삭제</button></div></div><div id="custom-swatches" class="swatches custom-swatches">${customColors.length ? customColors.map(c => `<button type="button" data-color="${c}" data-custom-swatch="${c}" style="--swatch:${c}" title="사용자 색상 ${c}" aria-label="사용자 색상 ${c}" class="swatch custom-swatch ${currentColor === c ? 'chosen' : ''}"></button>`).join('') : '<span class="palette-empty">색상을 고른 뒤 「+ 색상 추가」를 눌러 저장하세요.</span>'}</div><div class="custom-palette-creator"><input id="custom-palette-name" type="text" maxlength="40" placeholder="새 팔레트 이름 (예: 내 필기 세트)" aria-label="새 팔레트 이름"><button type="button" id="save-custom-palette" class="palette-mini-btn primary">+ 팔레트 저장</button></div></div>`
    + `<div class="palette-section color-picker-section"><div class="palette-bar"><span class="palette-label">컬러 피커</span><span class="color-preview-badge"><i id="color-preview-chip" style="background:${currentColor}"></i><code id="color-preview-text">${currentColor.toUpperCase()}</code></span></div><div id="color-picker-sv" class="color-picker-sv" style="--picker-hue:${pickerHsv.h}" role="slider" tabindex="0" aria-label="채도 및 명도 선택"><span id="color-picker-sv-thumb" class="color-picker-sv-thumb" style="left:${pickerHsv.s}%;top:${100 - pickerHsv.v}%"></span></div><div class="color-picker-hue-row"><input id="color-picker-hue" class="color-picker-hue" type="range" min="0" max="360" value="${pickerHsv.h}" aria-label="색상 (Hue)"><input type="color" id="custom-color" value="${currentColor}" title="시스템 색상 선택기" aria-label="사용자 색상"></div><div class="color-picker-inputs"><label class="color-input-field hex-field"><span>HEX</span><input id="color-hex" type="text" maxlength="7" value="${currentColor.toUpperCase()}" aria-label="HEX 색상 코드"></label><label class="color-input-field"><span>R</span><input id="color-r" type="number" min="0" max="255" value="${rgb.r}" aria-label="R (빨강)"></label><label class="color-input-field"><span>G</span><input id="color-g" type="number" min="0" max="255" value="${rgb.g}" aria-label="G (초록)"></label><label class="color-input-field"><span>B</span><input id="color-b" type="number" min="0" max="255" value="${rgb.b}" aria-label="B (파랑)"></label></div></div>`
    + `<label class="range-label">굵기 <output id="width-output">${r.width}px</output><input id="pen-width" type="range" min="1" max="18" value="${r.width}"></label><label class="range-label">형광펜 투명도 <output id="opacity-output">${Math.round(r.opacity*100)}%</output><input id="pen-opacity" type="range" min="10" max="90" value="${Math.round(r.opacity*100)}"></label><label class="select-label">펜 표시 시간 <select id="pen-ttl"><option value="0">영구 저장</option><option value="3">3초</option><option value="10">10초</option><option value="30">30초</option></select></label><p class="popover-hint">시간을 정한 펜은 잠깐 표시되고 저장되지 않아요.</p>`;
  positionPopover();
  $$('[data-popover-close]', pop).forEach(button => button.onclick = closePopover);
  const applyColor = (rawColor, {fromHsv = false, keepHexInput = false} = {}) => {
    const norm = normalizeHexColor(rawColor);
    if (!norm) return;
    changePreferences({annotation: {color: norm}});
    if (!fromHsv) pickerHsv = hexToHsv(norm);
    const nextRgb = hexToRgb(norm);
    $('#color-picker-sv', pop)?.style.setProperty('--picker-hue', String(pickerHsv.h));
    const thumb = $('#color-picker-sv-thumb', pop);
    if (thumb) { thumb.style.left = pickerHsv.s + '%'; thumb.style.top = (100 - pickerHsv.v) + '%'; }
    const hueInput = $('#color-picker-hue', pop);
    if (hueInput) hueInput.value = String(pickerHsv.h);
    const nativeInput = $('#custom-color', pop);
    if (nativeInput) nativeInput.value = norm;
    const hexInput = $('#color-hex', pop);
    if (hexInput && !keepHexInput) hexInput.value = norm.toUpperCase();
    const rIn = $('#color-r', pop), gIn = $('#color-g', pop), bIn = $('#color-b', pop);
    if (rIn) rIn.value = String(nextRgb.r);
    if (gIn) gIn.value = String(nextRgb.g);
    if (bIn) bIn.value = String(nextRgb.b);
    const chip = $('#color-preview-chip', pop), badgeText = $('#color-preview-text', pop);
    if (chip) chip.style.background = norm;
    if (badgeText) badgeText.textContent = norm.toUpperCase();
    $$('.swatch', pop).forEach(b => b.classList.toggle('chosen', b.dataset.color?.toLowerCase() === norm));
    const removeBtn = $('#remove-custom-color', pop);
    if (removeBtn) removeBtn.disabled = !(preferences.annotation.customColors || []).includes(norm);
  };
  $$('[data-color]', pop).forEach(button => button.onclick = safely(() => applyColor(button.dataset.color)));
  $('#palette-preset', pop).onchange = safely(e => {
    changePreferences({annotation: {paletteId: e.target.value}});
    const nextPalette = getActivePalette();
    if (nextPalette.colors.length && !nextPalette.colors.includes(r.color.toLowerCase())) {
      changePreferences({annotation: {color: nextPalette.colors[0]}});
    }
    renderPalettePopoverContent(r);
  });
  $('#add-custom-color', pop).onclick = safely(() => {
    const norm = normalizeHexColor(r.color) || '#edcf67';
    const nextCustom = [...new Set([...(preferences.annotation.customColors || []), norm])].slice(-64);
    changePreferences({annotation: {customColors: nextCustom}});
    renderPalettePopoverContent(r);
  });
  $('#remove-custom-color', pop).onclick = safely(() => {
    const norm = normalizeHexColor(r.color);
    const nextCustom = (preferences.annotation.customColors || []).filter(c => c !== norm);
    changePreferences({annotation: {customColors: nextCustom}});
    renderPalettePopoverContent(r);
  });
  $('#save-custom-palette', pop).onclick = safely(() => {
    const existing = preferences.annotation.customPalettes || [];
    const nameInput = $('#custom-palette-name', pop);
    const name = (nameInput?.value.trim() || `사용자 팔레트 ${existing.length + 1}`).slice(0, 40);
    const savedCustom = preferences.annotation.customColors || [];
    const baseColors = savedCustom.length ? [...new Set([...savedCustom, r.color.toLowerCase()])] : [...new Set([r.color.toLowerCase(), ...activePalette.colors])];
    const id = 'custom-' + uid();
    const nextPalettes = [...existing, {id, name, colors: baseColors.slice(0, 20)}].slice(-40);
    changePreferences({annotation: {customPalettes: nextPalettes, paletteId: id}});
    toast(`「${name}」 팔레트를 저장했습니다.`);
    renderPalettePopoverContent(r);
  });
  if ($('#delete-custom-palette', pop)) {
    $('#delete-custom-palette', pop).onclick = safely(() => {
      const nextPalettes = (preferences.annotation.customPalettes || []).filter(p => p.id !== activePalette.id);
      changePreferences({annotation: {customPalettes: nextPalettes, paletteId: 'preset-1'}});
      toast('사용자 팔레트를 삭제했습니다.');
      renderPalettePopoverContent(r);
    });
  }
  const svBox = $('#color-picker-sv', pop);
  const updateFromSvPointer = event => {
    const rect = svBox.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const s = Math.max(0, Math.min(100, Math.round(((event.clientX - rect.left) / rect.width) * 100)));
    const v = Math.max(0, Math.min(100, Math.round((1 - (event.clientY - rect.top) / rect.height) * 100)));
    pickerHsv = {h: pickerHsv.h, s, v};
    applyColor(hsvToHex(pickerHsv), {fromHsv: true});
  };
  svBox.onpointerdown = event => {
    if (event.button != null && event.button !== 0) return;
    event.preventDefault();
    try { svBox.setPointerCapture?.(event.pointerId); } catch { /* ignore */ }
    updateFromSvPointer(event);
    const move = e => { if (e.pointerId === event.pointerId) updateFromSvPointer(e); };
    const up = e => {
      if (e.pointerId !== event.pointerId) return;
      svBox.removeEventListener('pointermove', move);
      svBox.removeEventListener('pointerup', up);
      svBox.removeEventListener('pointercancel', up);
    };
    svBox.addEventListener('pointermove', move);
    svBox.addEventListener('pointerup', up);
    svBox.addEventListener('pointercancel', up);
  };
  svBox.onclick = event => { if (event.clientX || event.clientY) updateFromSvPointer(event); };
  svBox.onkeydown = event => {
    const step = event.shiftKey ? 10 : 2;
    if (event.key === 'ArrowRight') { event.preventDefault(); pickerHsv.s = Math.min(100, pickerHsv.s + step); applyColor(hsvToHex(pickerHsv), {fromHsv: true}); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); pickerHsv.s = Math.max(0, pickerHsv.s - step); applyColor(hsvToHex(pickerHsv), {fromHsv: true}); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); pickerHsv.v = Math.min(100, pickerHsv.v + step); applyColor(hsvToHex(pickerHsv), {fromHsv: true}); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); pickerHsv.v = Math.max(0, pickerHsv.v - step); applyColor(hsvToHex(pickerHsv), {fromHsv: true}); }
  };
  $('#color-picker-hue', pop).oninput = safely(e => {
    const h = Number(e.target.value) || 0;
    const s = pickerHsv.s === 0 && pickerHsv.v < 15 ? 80 : Math.max(pickerHsv.s, 20);
    const v = pickerHsv.v < 15 ? 85 : pickerHsv.v;
    pickerHsv = {h, s, v};
    applyColor(hsvToHex(pickerHsv), {fromHsv: true});
  });
  $('#custom-color', pop).oninput = safely(e => applyColor(e.target.value));
  $('#color-hex', pop).oninput = safely(e => {
    const raw = e.target.value.trim();
    if (/^#?[\da-f]{6}$/i.test(raw)) applyColor(raw, {keepHexInput: true});
  });
  $('#color-hex', pop).onchange = safely(e => {
    const norm = normalizeHexColor(e.target.value);
    if (norm) applyColor(norm);
    else e.target.value = r.color.toUpperCase();
  });
  for (const channel of ['#color-r', '#color-g', '#color-b']) {
    $(channel, pop).oninput = safely(() => {
      const hex = rgbToHex({r: $('#color-r', pop).value, g: $('#color-g', pop).value, b: $('#color-b', pop).value});
      applyColor(hex);
    });
  }
  $('#pen-width', pop).oninput = safely(e => { changePreferences({annotation: {width: Number(e.target.value)}}); $('#width-output', pop).textContent = r.width + 'px'; });
  $('#pen-opacity', pop).oninput = safely(e => { changePreferences({annotation: {opacity: Number(e.target.value) / 100}}); $('#opacity-output', pop).textContent = e.target.value + '%'; });
  $('#pen-ttl', pop).value = String(r.penTTL);
  $('#pen-ttl', pop).onchange = safely(e => changePreferences({annotation: {penTTL: Number(e.target.value)}}));
}
function showSelectionMenu(r) {
  const anchor=r.selection;if(!anchor)return;
  if(popoverName==='selection')closePopover();
  showPopover('selection',`${[['copy','복사'],['highlight','형광펜'],['underline','밑줄'],['note','메모'],['speak','읽어주기'],['webSearch','웹 검색']].map(([a,l]) => `<button data-selection="${a}">${l}</button>`).join('')}`,()=>{
    const pop=$('#tool-popover');pop.setAttribute('role','dialog');pop.setAttribute('aria-label','선택한 텍스트');
    $$('[data-selection]',pop).forEach(button=>{
      button.onpointerdown=e=>e.preventDefault();
      button.onclick=safely(async()=>{
        const action=button.dataset.selection;
        if(['highlight','underline'].includes(action))r.addText(action,anchor);
        else if(action==='note'){
          const text=await promptText('메모','');
          if(text?.trim())r.addText('note',anchor,text.trim());
        }
        else if(action==='copy'){try{await navigator.clipboard.writeText(anchor.quote);toast('텍스트를 복사했습니다.');}catch{toast('글자를 다시 선택한 뒤 Ctrl/⌘+C로 복사하세요.');}}
        else if(action==='speak'){r.selection=anchor;if(!r.speakSelection())return;}
        else if(action==='webSearch')window.open('https://www.google.com/search?q='+encodeURIComponent(anchor.quote.slice(0,2000)),'_blank','noopener,noreferrer');
        closePopover();
      });
    });
  });
}
function toolAction(action) {
  const r=reader();if(!r)return;
  if(action==='speak'){closePopover();r.toggleReadAloud();return;}
  if(['select','pen','highlight','underline','eraser','note','text','rect','ellipse','arrow','area','area-underline','strike'].includes(action)){
    closePopover();r.setTool(action);updateToolbarState();return;
  }
  if(action==='undo'){r.undo();return;}if(action==='redo'){r.redo();return;}
  if(action==='palette') {
    showPopover('palette', '', () => renderPalettePopoverContent(r));
    return;
  }
  if(action==='zoom') {showPopover('zoom',`<div class="popover-heading"><h3>확대 · 축소</h3><button type="button" class="icon-button popover-close" data-popover-close aria-label="확대 · 축소 닫기" title="닫기">${icon('close',16)}</button></div><div class="zoom-controls"><button class="secondary-button" id="zoom-out">${icon('minus')}</button><input id="zoom-value" type="number" min="20" max="800" value="${Math.round(r.zoom*100)}" aria-label="확대 비율"><span>%</span><button class="secondary-button" id="zoom-in">${icon('plus')}</button></div><button id="zoom-fit" class="menu-button">화면 너비에 맞추기</button><button id="zoom-reset" class="menu-button">100% 원래 크기</button>`,()=>{
    $('#zoom-out').onclick=()=>r.setZoom(r.zoom/1.2);$('#zoom-in').onclick=()=>r.setZoom(r.zoom*1.2);$('#zoom-value').onchange=e=>r.setZoom(Number(e.target.value)/100);$('#zoom-fit').onclick=()=>{r.setZoom(1,true);closePopover();};$('#zoom-reset').onclick=()=>{r.setZoom(1);closePopover();};
  });return;}
  if(action==='more') {
    const items=[['search','search','문서 검색'],['outline','list','목차 · 북마크'],['annotations','note','주석 목록'],['rect','rect','사각형'],['ellipse','ellipse','타원'],['arrow','arrow','화살표'],['area','area','영역 형광펜'],['area-underline','underline','영역 밑줄'],['strike','strike','취소선'],['text','text','텍스트'],['undo','undo','실행 취소'],['redo','redo','다시 실행'],['bookmark','bookmark','현재 위치 북마크'],['history','undo','주석 저장 이력'],['connect','save','HTML 내보내기'],['info','file','문서 정보'],['clear','trash','주석 모두 지우기']];
    showPopover('more',`<div class="popover-heading"><h3>문서 도구</h3><button class="icon-button popover-close" data-popover-close aria-label="문서 도구 닫기" title="닫기">${icon('close',16)}</button></div><div class="more-grid">${items.map(([id,name,label])=>`<button class="menu-button" data-more="${id}">${icon(name,16)}<span>${label}</span></button>`).join('')}</div>`,()=>{
      $('[data-popover-close]',$('#tool-popover')).onclick=closePopover;
      $$('[data-more]',$('#tool-popover')).forEach(button=>button.onclick=safely(()=>{const id=button.dataset.more;closePopover();return toolAction(id);}));
    });return;
  }
  if(['search','outline','annotations'].includes(action)){closePopover();renderSidebar(action);return;}
  if(action==='connect')return safely(()=>exportDocument(active()))();
  if(action==='history')return safely(()=>annotationHistory(active()))();
  if(action==='info')return documentInfo(active());
  if(action==='bookmark')return safely(async()=>{const title=await promptText('text','읽던 위치');if(title){r.addBookmark(title);toast('북마크를 저장했습니다.');}})();
  if(action==='clear')return safely(async()=>{if(await confirmDialog('주석을 모두 지울까요?',`${r.metadata.annotations.length}개의 주석을 지웁니다. 실행 취소로 복원할 수 있어요.`,'모두 지우기'))r.commit([]);})();
}
function bindToolbarDrag() {
  const bar=$('#toolbar');const grip=$('.toolbar-grip');if(!grip)return;
  grip.onpointerdown=event=>{
    event.preventDefault();const start=bar.getBoundingClientRect();const origin={x:event.clientX,y:event.clientY};grip.setPointerCapture(event.pointerId);
    const move=e=>{bar.style.transform='none';bar.style.bottom='auto';bar.style.left=Math.max(8,Math.min(innerWidth-start.width-8,start.left+e.clientX-origin.x))+'px';bar.style.top=Math.max(8,Math.min(innerHeight-start.height-34,start.top+e.clientY-origin.y))+'px';if(!$('#tool-popover').hidden)positionPopover();};
    const end=()=>{grip.removeEventListener('pointermove',move);grip.removeEventListener('pointerup',end);grip.removeEventListener('pointercancel',end);const rect=bar.getBoundingClientRect();safely(()=>changePreferences({toolbarPosition:{x:Math.max(0,Math.min(1,(rect.left-8)/Math.max(1,innerWidth-rect.width-16))),y:Math.max(0,Math.min(1,(rect.top-8)/Math.max(1,innerHeight-rect.height-42)))}}))();};grip.addEventListener('pointermove',move);grip.addEventListener('pointerup',end);grip.addEventListener('pointercancel',end);
  };
}
function closeSidebar() {sidebarMode='';$('#sidebar').hidden=true;reader()?.search('');}
function renderSidebar(mode) {
  const r=reader();if(!r)return;sidebarMode=mode;closePopover();const panel=$('#sidebar');panel.hidden=false;
  const title={search:'문서 검색',outline:'목차 · 북마크',annotations:'주석 목록'}[mode];
  panel.innerHTML=`<div class="sidebar-heading"><h2>${title}</h2><button class="icon-button" id="close-sidebar" aria-label="패널 닫기">${icon('close')}</button></div><div class="sidebar-content"></div>`;$('#close-sidebar').onclick=closeSidebar;
  const content=$('.sidebar-content',panel);
  if(mode==='search'){
    content.innerHTML='<div class="search-field"><input id="document-search" aria-label="문서 검색어" placeholder="문서 안에서 찾기" autocomplete="off"></div><div class="search-navigation"><span id="search-count">검색어를 입력하세요.</span><button id="search-prev" class="icon-button" aria-label="이전 검색 결과">'+icon('back')+'</button><button id="search-next" class="icon-button" aria-label="다음 검색 결과">'+icon('forward')+'</button></div><div id="search-results"></div>';
    $('#document-search').value=r.searchQuery||'';let searchTimer;
    const run=()=>{const query=$('#document-search').value;const results=r.search(query);$('#search-count').textContent=results.length?`${results.length}${results.length===3000?'+':''}개 결과`:'검색 결과가 없습니다.';$('#search-results').innerHTML=results.slice(0,150).map((result,index)=>`<button class="search-result" data-search-index="${index}">${esc(result.quote)}</button>`).join('');$$('[data-search-index]').forEach(button=>button.onclick=()=>{r.searchPosition=Number(button.dataset.searchIndex)-1;r.nextSearch(1);});};
    $('#document-search').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(run,120);};$('#document-search').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();r.nextSearch(e.shiftKey?-1:1);}};
    $('#search-prev').onclick=()=>r.nextSearch(-1);$('#search-next').onclick=()=>r.nextSearch(1);$('#document-search').focus();if(r.searchQuery)run();
  }else if(mode==='outline'){
    const outline=r.outline();content.innerHTML=`<p class="panel-label">목차</p>${outline.length?outline.map((item,index)=>`<button class="outline-item" style="padding-left:${12+(item.level-1)*12}px" data-heading="${index}">${esc(item.title)}</button>`).join(''):'<p class="panel-empty">이 문서에 제목 목차가 없습니다.</p>'}<p class="panel-label">북마크</p>${r.metadata.bookmarks.map(mark=>`<div class="bookmark-row"><button class="outline-item" data-bookmark="${esc(mark.id)}">${icon('bookmark',14)} ${esc(mark.title)}</button><button class="icon-button" data-delete-bookmark="${esc(mark.id)}" aria-label="북마크 삭제">${icon('close',13)}</button></div>`).join('')}<button id="add-bookmark" class="text-button">+ 현재 위치 저장</button>`;
    $$('[data-heading]').forEach(button=>button.onclick=()=>r.jump(outline[Number(button.dataset.heading)].node));
    $$('[data-bookmark]').forEach(button=>button.onclick=()=>{const mark=r.metadata.bookmarks.find(m=>m.id===button.dataset.bookmark);r.scrollTop=mark.top*r.zoom;r.scrollLeft=mark.left*r.zoom;});
    $$('[data-delete-bookmark]').forEach(button=>button.onclick=()=>{r.metadata.bookmarks=r.metadata.bookmarks.filter(m=>m.id!==button.dataset.deleteBookmark);active().queue.schedule();renderSidebar('outline');});$('#add-bookmark').onclick=()=>toolAction('bookmark');
  }else{
    content.innerHTML=r.metadata.annotations.length?r.metadata.annotations.map(a=>`<div class="annotation-row"><button class="annotation-item" data-annotation="${esc(a.id)}"><span class="annotation-type" style="color:${a.color}">${icon(a.type==='pen'?'pen':a.type==='note'?'note':a.type==='highlight'?'highlight':a.type==='underline'?'underline':'shapes',16)}</span><span>${esc(a.text||a.textAnchor?.quote||({pen:'펜 그림',rect:'사각형',ellipse:'타원',arrow:'화살표',area:'영역 강조','area-underline':'영역 밑줄',strike:'취소선'})[a.type]||'주석')}</span></button><button class="icon-button" data-delete-annotation="${esc(a.id)}" aria-label="주석 삭제">${icon('trash',14)}</button></div>`).join(''):'<p class="panel-empty">아직 주석이 없어요.<br>툴바에서 도구를 골라 생각을 남겨보세요.</p>';
    $$('[data-annotation]').forEach(button=>button.onclick=()=>r.jumpAnnotation(button.dataset.annotation));$$('[data-delete-annotation]').forEach(button=>button.onclick=()=>r.remove(button.dataset.deleteAnnotation));
  }
}
function annotationDialog(tab,id) {
  const a=tab.reader.metadata.annotations.find(a=>a.id===id);if(!a)return;
  const dialogColors=[...new Set([...PRESET_COLORS,...(preferences.annotation.customColors||[])])];
  modal(`<div class="dialog-heading"><h2>주석 편집</h2><button class="icon-button" data-dialog-close aria-label="닫기">${icon('close')}</button></div><p class="annotation-quote">${esc(a.text||a.textAnchor?.quote||'선택한 주석')}</p><div class="swatches preset-swatches">${dialogColors.map(c=>`<button type="button" data-dialog-color="${c}" style="--swatch:${c}" aria-label="색상 ${c}" class="swatch ${a.color.toLowerCase()===c?'chosen':''}"></button>`).join('')}</div><label class="select-label">색상 직접 선택 <span class="palette-actions"><input id="annotation-color-hex" class="annotation-hex-input" type="text" maxlength="7" value="${a.color.toUpperCase()}" aria-label="주석 HEX 색상 코드"><input type="color" id="annotation-color" value="${a.color}"></span></label><div class="dialog-actions">${['note','text'].includes(a.type)?'<button id="edit-note" class="secondary-button">내용 편집</button>':''}<button id="delete-selected" class="secondary-button">${icon('trash',15)} 삭제</button><button class="primary-button" data-dialog-close>완료</button></div>`,()=>{
    const setAnnotationColor=raw=>{
      const norm=normalizeHexColor(raw);if(!norm)return;
      tab.reader.commit(tab.reader.metadata.annotations.map(item=>item.id===id?{...item,color:norm}:item));
      $('#annotation-color').value=norm;$('#annotation-color-hex').value=norm.toUpperCase();
      $$('[data-dialog-color]',$('#dialog')).forEach(b=>b.classList.toggle('chosen',b.dataset.dialogColor===norm));
    };
    $$('[data-dialog-color]',$('#dialog')).forEach(button=>button.onclick=()=>setAnnotationColor(button.dataset.dialogColor));
    $('#annotation-color').oninput=e=>setAnnotationColor(e.target.value);
    $('#annotation-color').onchange=e=>setAnnotationColor(e.target.value);
    $('#annotation-color-hex').onchange=e=>setAnnotationColor(e.target.value);
    $('#delete-selected').onclick=()=>{tab.reader.remove(id);$('#dialog').close();};if($('#edit-note'))$('#edit-note').onclick=safely(async()=>{const text=await promptText(a.type,a.text);if(text?.trim())tab.reader.commit(tab.reader.metadata.annotations.map(item=>item.id===id?{...item,text:text.trim()}:item));});
  });
}
async function annotationHistory(tab, before = Infinity) {
  await tab.reader.ready;await tab.queue.flush();
  const versions=await listRevisionSummaries(tab.record.id,before);
  const stamp=value=>new Date(value).toLocaleString('ko-KR',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
  modal(`<div class="dialog-heading"><h2>주석 저장 이력</h2><button class="icon-button" data-dialog-close aria-label="닫기">${icon('close')}</button></div><p class="dialog-description">본문은 유지하고 선택한 시점의 주석과 북마크만 복원합니다. 복원 직전 상태도 이력에 남습니다.</p><p class="dialog-description small">이 기능을 사용하기 시작한 시점부터 보관합니다. 이력은 이 브라우저에 저장되며, 앱 데이터나 문서를 삭제하면 함께 삭제됩니다. HTML 내보내기에는 현재 주석만 포함됩니다.</p><div class="revision-list">${versions.map((version,index)=>`<button class="menu-button" data-revision="${version.id}"><span>${esc(stamp(version.created))} · #${version.id}<br><small>${version.kind==='restore'?'복원 저장':version.kind==='baseline'?'최초 보관':'주석 변경'} · 주석 ${version.annotationCount}개 · 북마크 ${version.bookmarkCount}개${index===0 && before===Infinity?' · 최근 저장':''}</small></span></button>`).join('') || '<p>아직 저장된 이력이 없습니다.</p>'}</div>${versions.length===50?'<button class=secondary-button id=history-older>더 이전 이력</button>':''}${before!==Infinity?'<button class=secondary-button id=history-latest>최근 이력</button>':''}`,()=>{
    if($('#history-older'))$('#history-older').onclick=safely(()=>annotationHistory(tab,versions.at(-1).id));
    if($('#history-latest'))$('#history-latest').onclick=safely(()=>annotationHistory(tab));
    $$('[data-revision]',$('#dialog')).forEach(button=>button.onclick=safely(async()=>{
      const version=await getRevision(Number(button.dataset.revision));
      if(!version || version.documentId!==tab.record.id)throw Error('저장 이력을 찾지 못했습니다.');
      modal(`<div class="dialog-heading"><h2>주석 이력 확인</h2><button class="icon-button" data-dialog-close aria-label="닫기">${icon('close')}</button></div><p>${esc(stamp(version.created))} · #${version.id}</p><p>주석 ${version.annotations.length}개 · 북마크 ${version.bookmarks.length}개</p><div class="revision-preview">${version.annotations.slice(0,100).map(a=>`<p>${esc(a.type)} · ${esc((a.text || a.textAnchor?.quote || '그림 주석').slice(0,500))}</p>`).join('') || '<p>주석 없음</p>'}${version.annotations.length>100?'<p>미리보기는 100개까지 표시합니다. 복원은 모든 주석에 적용됩니다.</p>':''}</div><div class="dialog-actions"><button class="secondary-button" id="history-back">이력 목록</button><button class="primary-button" id="restore-revision">이 시점으로 복원</button></div>`,()=>{
        $('#history-back').onclick=safely(()=>annotationHistory(tab));
        $('#restore-revision').onclick=safely(async()=>{
          // Flush current edits first, so restoration itself never destroys the state being replaced.
          await tab.queue.flush();
          tab.reader.metadata.bookmarks=structuredClone(version.bookmarks);
          tab.restoredFrom=version.id;
          tab.reader.commit(structuredClone(version.annotations));
          await tab.queue.flush();$('#dialog').close();
          if(sidebarMode)renderSidebar(sidebarMode);
          toast('HTML 본문은 유지하고 주석과 북마크를 복원했습니다.');
        });
      });
    }));
  });
}
function documentInfo(tab) {
  const m=tab.reader.metadata;
  modal(`<div class="dialog-heading"><h2>문서 정보</h2><button class="icon-button" data-dialog-close aria-label="닫기">${icon('close')}</button></div><dl class="document-info"><dt>제목</dt><dd>${esc(m.title)}</dd><dt>파일</dt><dd>${esc(tab.record.name)}</dd><dt>원본</dt><dd>${m.source?`<a href="${esc(m.source)}" target="_blank" rel="noopener noreferrer">${esc(m.source)}</a>`:'로컬 HTML 파일'}</dd><dt>저장 위치</dt><dd>앱 보관함 (원본 파일은 변경하지 않음)</dd><dt>주석</dt><dd>${m.annotations.length}개</dd></dl>${m.warnings.length?`<details class="capture-warnings"><summary>보관하지 못한 리소스 ${m.warnings.length}개</summary><ul>${m.warnings.map(w=>`<li>${esc(w)}</li>`).join('')}</ul></details>`:''}<p class="dialog-description small">본문은 보관한 상태로 유지하고 주석과 북마크를 별도로 자동 저장합니다. HTML 내보내기로 현재 주석을 포함한 사본을 만들 수 있어요.</p>`);
}
function documentMenu(record) {
  modal(`<div class="dialog-heading"><h2>${esc(record.title)}</h2><button class="icon-button" data-dialog-close aria-label="닫기">${icon('close')}</button></div><div class="document-actions"><button class="menu-button" id="menu-open">${icon('file')} 열기</button><button class="menu-button" id="menu-export">${icon('download')} HTML 내보내기</button><button class="menu-button" id="menu-history">${icon('undo')} 주석 저장 이력</button><button class="menu-button danger" id="menu-remove">${icon('trash')} 서재에서 삭제</button></div>`,()=>{
    $('#menu-open').onclick=safely(async()=>{$('#dialog').close();await openRecord(record);});$('#menu-export').onclick=safely(async()=>{$('#dialog').close();const tab=await openRecord(record);await exportDocument(tab);});
    $('#menu-history').onclick=safely(async()=>{$('#dialog').close();await annotationHistory(await openRecord(record));});
    $('#menu-remove').onclick=safely(async()=>{if(!await confirmDialog('서재에서 삭제할까요?','앱 보관함에서만 삭제합니다. 연결된 외부 HTML 파일은 남습니다.','삭제'))return;const tab=tabs.find(t=>t.record?.id===record.id);if(tab)await closeTab(tab.id);await deleteDocument(record.id);await refreshLibrary();});
  });
}
function handleKey(event) {
  const isField=/^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName)||event.target?.isContentEditable;
  if(event.key==='Escape') {if(reader()?.readAloud?.escape()){event.preventDefault();return;}reader()?.stopSpeech();if($('#dialog').open)return;if(!$('#tool-popover').hidden)closePopover();else if(!$('#sidebar').hidden)closeSidebar();else if(readerFocused)void leaveReaderFocus();else if(reader())reader().setTool('select');return;}
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){event.preventDefault();if(reader())safely(()=>active().queue.flush())();else safely(savePage)();return;}
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='l'){event.preventDefault();$('#address').focus();$('#address').select();return;}
  if(!reader()||isField||$('#dialog').open)return;
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){event.preventDefault();event.shiftKey?reader().redo():reader().undo();return;}
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='f'){event.preventDefault();renderSidebar('search');return;}
  if(event.ctrlKey||event.metaKey||event.altKey)return;
  if(event.key.toLowerCase()==='f'){event.preventDefault();void toggleReaderFocus();return;}
  const tools={v:'select',p:'pen',h:'highlight',u:'underline',e:'eraser',n:'note'};const tool=tools[event.key.toLowerCase()];if(tool){event.preventDefault();toolAction(tool);}
}
function setReaderFocus(value) {
  readerFocused=value;$('#app').classList.toggle('reader-focus',value);
  const focusedReader=reader();
  closePopover();closeSidebar();requestAnimationFrame(()=>{applyToolbarPosition();focusedReader?.setFocusLayout?.(value);focusedReader?.measure();});
}
async function leaveReaderFocus() {
  const entering=focusBusy;focusBusy=true;
  setReaderFocus(false);
  try{if(nativeReaderFullscreen && document.fullscreenElement===$('#app'))await document.exitFullscreen();}
  catch{/* The browser may already be leaving fullscreen. */}
  finally{nativeReaderFullscreen=false;if(!entering)focusBusy=false;}
}
async function toggleReaderFocus() {
  if(!reader()?.doc)return;
  if(readerFocused){await leaveReaderFocus();return;}
  if(focusBusy)return;
  focusBusy=true;setReaderFocus(true);
  try{
    // Fullscreen the reader shell, keeping annotation tools and dialogs available.
    // Browsers without this API still get a document-only, viewport-filling view.
    if($('#app').requestFullscreen){await $('#app').requestFullscreen();nativeReaderFullscreen=document.fullscreenElement===$('#app');}
  }catch{/* Keep document focus mode when browser fullscreen is unavailable. */}
  finally{focusBusy=false;if(!readerFocused && document.fullscreenElement===$('#app'))await leaveReaderFocus();}
}
async function copyAppURL(){
  if(sharingApp)return;sharingApp=true;$('#share-app').disabled=true;updateChrome();
  try{
    if(typeof navigator.clipboard?.writeText!=='function')throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(PUBLIC_APP_URL);
    $('#share-status').textContent='앱 주소를 복사했습니다. 이 주소만 보내주세요.';
  }catch{
    $('#share-url').focus();$('#share-url').select?.();
    $('#share-status').textContent='자동 복사를 사용할 수 없습니다. 위 주소를 선택해 직접 복사해 보내주세요.';
  }finally{sharingApp=false;$('#share-app').disabled=false;updateChrome();if(activeId==='execution')$('#status-left').textContent='앱 설치 · URL 공유 · 모든 데이터는 이 기기에 저장';}
}
function bindUI() {
  document.addEventListener('fullscreenchange',()=>{if(document.fullscreenElement===$('#app') && readerFocused)nativeReaderFullscreen=true;else if(nativeReaderFullscreen){nativeReaderFullscreen=false;setReaderFocus(false);}});
  [['#library-tab','library'],['#new-tab','plus'],['#back','back'],['#forward','forward'],['#reload','reload'],['#import-button','folder'],['#save-page','save'],['#app-menu-button','more'],['#settings-button','settings'],['#library-search-icon','search'],['#empty-icon','file']].forEach(([id,name])=>setButton(id,name));
  $('#desk-library').onclick=()=>activate('library');
  $('#desk-execution').onclick=()=>activate('execution');
  $('#desk-browse').onclick=()=>{activate('library');$('#address').focus();};
  $('#desk-import').onclick=safely(importFiles);
  $('#home-button').onclick=e=>{e.preventDefault();activate('library');};$('#library-tab').onclick=()=>activate('library');$('#new-tab').onclick=()=>{activate('library');$('#address').focus();};$('#browse-start').onclick=()=>$('#address').focus();
  $('#execution-tab').onclick=()=>activate('execution');$('#execution-import').onclick=safely(importFiles);$('#execution-chrome').onclick=connectionDialog;$('#execution-settings').onclick=settingsDialog;
  $('#share-url').value=PUBLIC_APP_URL;$('#shared-app-link').href=PUBLIC_APP_URL;
  $('#share-app').onclick=safely(copyAppURL);
  installController=new InstallController({window,navigator,location,matchMedia,onChange:updateInstall,onGuide:installGuide});
  $('#install-button').onclick=$('#execution-install').onclick=safely(async()=>{const result=await installController.install();if(result==='dismissed')toast('설치를 취소했습니다. 앱 설치 버튼에서 다시 안내를 볼 수 있어요.');});
  $('#address-form').onsubmit=safely(async event=>{event.preventDefault();const value=$('#address').value;await openBrowser(value,active()?.type!=='browser');});
  $('#back').onclick=safely(()=>browserHistory(-1));$('#forward').onclick=safely(()=>browserHistory(1));$('#reload').onclick=safely(async()=>{const tab=active();if(tab?.chromeId)await bridge('reloadTab',{tabId:tab.chromeId});else if(tab?.frame)tab.frame.src=tab.url;});
  $('#save-page').onclick=safely(savePage);$('#import-button').onclick=safely(importFiles);$('#hero-import').onclick=safely(importFiles);$('#choose-folder').onclick=safely(chooseFolder);
  $('#file-input').onchange=safely(async event=>{const files=[...event.target.files];event.target.value='';for(const file of files)await openLocalFile(file);});
  $('#settings-file-input').onchange=safely(async event=>{const file=event.target.files[0];event.target.value='';if(file){await restoreSettings(file);settingsDialog();}});
  $('#library-filter').oninput=renderLibrary;$('#library-sort').onchange=safely(e=>changePreferences({librarySort:e.target.value}));$('#settings-button').onclick=settingsDialog;$('#connection-button').onclick=connectionDialog;
  $('#open-example').onclick=safely(async()=>{let html=await bundledExample();if(html===null){const response=await fetch('./example.html');if(!response.ok)throw new Error('예제 문서를 불러오지 못했습니다.');html=await response.text();}await createDocument({html,title:'천천히 읽는다는 것',viewport:{width:960,height:800}},await folderFile('천천히 읽는다는 것'));});
  $('#app-menu-button').onclick=()=>modal(`<div class="dialog-heading"><h2>HTMLMemo</h2><button class="icon-button" data-dialog-close aria-label="닫기">${icon('close')}</button></div><button class="menu-button" id="menu-import">${icon('folder')} HTML 파일 열기</button><button class="menu-button" id="menu-folder">${icon('save')} 저장 폴더 연결</button><button class="menu-button" id="menu-chrome">${icon('globe')} Chrome 연결</button><button class="menu-button" id="menu-settings">${icon('settings')} 설정</button>`,()=>{
    $('#menu-import').onclick=safely(async()=>{$('#dialog').close();await importFiles();});$('#menu-folder').onclick=safely(async()=>{$('#dialog').close();await chooseFolder();});$('#menu-chrome').onclick=connectionDialog;$('#menu-settings').onclick=settingsDialog;
  });
  document.addEventListener('keydown',handleKey);document.addEventListener('pointerdown',event=>{if(!event.target.closest('#toolbar,#tool-popover')&&!$('#tool-popover').hidden)closePopover();});
  $('#dialog').addEventListener('click',event=>{if(event.target===$('#dialog'))$('#dialog').close();});
  window.addEventListener('beforeunload',event=>{if(tabs.some(t=>t.queue?.pending||t.queue?.error)){event.preventDefault();event.returnValue='';}});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)for(const tab of tabs)if(tab.reader?.doc){tab.reader.rememberPosition();tab.queue.flush().catch(()=>{});}});
  window.addEventListener('online',network);window.addEventListener('offline',network);window.addEventListener('htmlmemo-chrome-ready',()=>{updateConnection();safely(receiveCaptures)();});window.addEventListener('htmlmemo-capture-ready',safely(receiveCaptures));
  window.addEventListener('resize',()=>{closePopover();applyToolbarPosition();applyDeskNavWidth(deskNavWidth,{persist:false,snapStrip:true});});
  window.addEventListener('dragover',event=>{if([...event.dataTransfer.types].includes('Files'))event.preventDefault();});window.addEventListener('drop',safely(async event=>{if(![...(event.dataTransfer.types||[])].includes('Files'))return;event.preventDefault();for(const file of await droppedHTMLFiles(event.dataTransfer))await openLocalFile(file);}));
  bindDeskResize();
}
function network() {$('#network-status').textContent=navigator.onLine?'온라인':'오프라인';$('#network-status').classList.toggle('offline',!navigator.onLine);}
const DESK_NAV_WIDTH_KEY='htmlmemo-desk-nav-width-v1',DESK_NAV_EXPANDED_WIDTH_KEY='htmlmemo-desk-nav-expanded-width-v1',DESK_NAV_DEFAULT=180,DESK_NAV_MIN=8,DESK_NAV_STRIP_SNAP=48,DESK_NAV_MAX=360;
let deskNavWidth=DESK_NAV_DEFAULT,deskNavExpandedWidth=DESK_NAV_DEFAULT,deskDrag=null;
function maxDeskNavWidth() {
  if(deskDrag&&Number.isFinite(deskDrag.maxWidth))return deskDrag.maxWidth;
  const shellWidth=$('.desk-shell')?.clientWidth||innerWidth||1280;
  return Math.max(96,Math.min(DESK_NAV_MAX,shellWidth-160));
}
function clampDeskNavWidth(value,snapStrip=true) {
  const numeric=Number(value);
  if(!Number.isFinite(numeric))return DESK_NAV_DEFAULT;
  if(numeric<=24||(snapStrip&&numeric<DESK_NAV_STRIP_SNAP))return DESK_NAV_MIN;
  return Math.max(DESK_NAV_MIN,Math.min(maxDeskNavWidth(),Math.round(numeric)));
}
function applyDeskNavWidth(value,{persist=false,snapStrip=true}={}) {
  const nav=$('.desk-nav'),resizer=$('#desk-resizer');if(!nav)return DESK_NAV_DEFAULT;
  const width=clampDeskNavWidth(value,snapStrip),strip=width<DESK_NAV_STRIP_SNAP;
  if(!strip&&(persist||width>=96)){
    deskNavExpandedWidth=width;
    if(persist){try{localStorage?.setItem(DESK_NAV_EXPANDED_WIDTH_KEY,String(width));}catch{/* Ignore storage quota/privacy errors. */}}
  }
  const prevStrip=nav.classList.contains('is-strip');
  if(width===deskNavWidth&&!persist&&nav.style.width===width+'px'&&prevStrip===strip)return width;
  deskNavWidth=width;
  nav.style.setProperty?.('--desk-nav-width',width+'px');
  nav.style.width=width+'px';nav.style.minWidth=width+'px';nav.style.maxWidth=width+'px';
  nav.classList.toggle('is-strip',strip);
  nav.classList.toggle('is-compact',!strip&&width<136);
  nav.dataset.collapsed=strip?'true':'false';
  if(strip!==prevStrip||persist)$$('button',nav).forEach(button=>{if(strip){button.setAttribute('tabindex','-1');button.setAttribute('aria-hidden','true');}else{button.removeAttribute('tabindex');button.removeAttribute('aria-hidden');}});
  if(resizer){
    resizer.setAttribute('aria-valuenow',String(width));
    if(!deskDrag||persist)resizer.setAttribute('aria-valuemax',String(maxDeskNavWidth()));
    resizer.dataset.collapsed=strip?'true':'false';
  }
  if(persist){try{localStorage?.setItem(DESK_NAV_WIDTH_KEY,String(width));}catch{/* Ignore storage quota/privacy errors. */}}
  const r=reader();if(r?.doc){if(r.autoFit)r.zoom=r.fitZoom();if(r.nativeScroll||r.autoFit)r.applyZoom();updateToolbarState();}
  return width;
}
function bindDeskResize() {
  const nav=$('.desk-nav'),resizer=$('#desk-resizer'),main=$('#main');if(!nav||!resizer)return;
  let saved=null,savedExpanded=null;try{saved=localStorage?.getItem(DESK_NAV_WIDTH_KEY);savedExpanded=localStorage?.getItem(DESK_NAV_EXPANDED_WIDTH_KEY);}catch{saved=null;savedExpanded=null;}
  if(savedExpanded!==null&&savedExpanded!==''&&Number.isFinite(Number(savedExpanded))&&Number(savedExpanded)>=DESK_NAV_STRIP_SNAP)deskNavExpandedWidth=clampDeskNavWidth(Number(savedExpanded),true);
  applyDeskNavWidth(saved!==null&&saved!==''?Number(saved):DESK_NAV_DEFAULT,{persist:false,snapStrip:true});
  const startDrag=event=>{
    if(event.button!=null&&event.button!==0)return;
    event.preventDefault?.();
    if(deskDrag)return;
    const shellLeft=$('.desk-shell')?.getBoundingClientRect?.().left||0;
    const maxWidth=maxDeskNavWidth();
    const initialWidth=deskNavWidth;
    const startX=Number.isFinite(event.clientX)?event.clientX:shellLeft+initialWidth;
    const offset=Math.abs(startX-(shellLeft+initialWidth))<=16?startX-(shellLeft+initialWidth):0;
    const state={pointerId:event.pointerId,startX,shellLeft,maxWidth,initialWidth,offset,moved:false,target:event.currentTarget||resizer};
    deskDrag=state;
    $('#app')?.setAttribute('data-resizing-desk','');
    resizer.classList.add('is-dragging');
    try{if(event.pointerId!=null)state.target.setPointerCapture?.(event.pointerId);}catch{/* Synthetic or mouse events may not have an active pointerId. */}
    const cleanup=()=>{
      deskDrag=null;
      $('#app')?.removeAttribute('data-resizing-desk');
      resizer.classList.remove('is-dragging');
      try{if(state.pointerId!=null)state.target.releasePointerCapture?.(state.pointerId);}catch{/* Pointer capture may already be released by the browser. */}
      for(const target of [resizer,nav,document,window]){
        target?.removeEventListener?.('pointermove',move);target?.removeEventListener?.('mousemove',move);
        target?.removeEventListener?.('pointerup',end);target?.removeEventListener?.('mouseup',end);
        target?.removeEventListener?.('pointercancel',cancel);
      }
    };
    const move=e=>{
      if(deskDrag!==state)return;
      if(state.pointerId!=null&&e.pointerId!=null&&e.pointerId!==state.pointerId)return;
      if(state.moved&&e.buttons===0){end(e);return;}
      const clientX=Number.isFinite(e.clientX)?e.clientX:state.startX;
      if(Math.abs(clientX-state.startX)>=(state.initialWidth<=DESK_NAV_MIN?6:1))state.moved=true;
      if(!state.moved)return;
      const nextW=applyDeskNavWidth(clientX-state.shellLeft-state.offset,{persist:false,snapStrip:false});
      if(nextW>=DESK_NAV_STRIP_SNAP)state.expandedDuringDrag=true;
    };
    const end=e=>{
      if(deskDrag!==state)return;
      if(state.pointerId!=null&&e?.pointerId!=null&&e.pointerId!==state.pointerId)return;
      cleanup();
      let next;
      if(!state.moved)next=state.initialWidth<=DESK_NAV_MIN?Math.max(DESK_NAV_STRIP_SNAP,deskNavExpandedWidth||DESK_NAV_DEFAULT):DESK_NAV_MIN;
      else if(state.initialWidth<=DESK_NAV_MIN&&deskNavWidth<DESK_NAV_STRIP_SNAP&&!state.expandedDuringDrag)next=Math.max(DESK_NAV_STRIP_SNAP,deskNavExpandedWidth||DESK_NAV_DEFAULT);
      else next=deskNavWidth;
      applyDeskNavWidth(next,{persist:true,snapStrip:true});
      reader()?.measure?.();
    };
    const cancel=e=>{
      if(deskDrag!==state)return;
      if(state.pointerId!=null&&e?.pointerId!=null&&e.pointerId!==state.pointerId)return;
      cleanup();
      applyDeskNavWidth(state.moved?deskNavWidth:state.initialWidth,{persist:state.moved,snapStrip:true});
      reader()?.measure?.();
    };
    for(const target of [resizer,nav,document,window]){
      target?.addEventListener?.('pointermove',move);target?.addEventListener?.('mousemove',move);
      target?.addEventListener?.('pointerup',end);target?.addEventListener?.('mouseup',end);
      target?.addEventListener?.('pointercancel',cancel);
    }
  };
  resizer.onpointerdown=startDrag;
  resizer.onmousedown=startDrag;
  resizer.ondragstart=event=>event.preventDefault?.();
  const navStart=event=>{
    if(event.button!=null&&event.button!==0)return;
    const rect=nav.getBoundingClientRect?.();
    const nearEdge=rect&&rect.width>0&&Number.isFinite(event.clientX)&&event.clientX>=rect.right-10;
    if(nav.classList.contains('is-strip')||nearEdge)startDrag(event);
  };
  nav.addEventListener('pointerdown',navStart);
  nav.addEventListener('mousedown',navStart);
  const mainStart=event=>{
    if(event.button!=null&&event.button!==0)return;
    if(event.target?.closest?.('button,a,input,select,textarea,[role="tab"]'))return;
    const rect=main?.getBoundingClientRect?.();
    if(rect&&Number.isFinite(event.clientX)&&event.clientX<=rect.left+6)startDrag(event);
  };
  main?.addEventListener?.('pointerdown',mainStart);
  main?.addEventListener?.('mousedown',mainStart);
  resizer.onkeydown=event=>{
    if(event.key==='ArrowLeft'){event.preventDefault();applyDeskNavWidth(deskNavWidth-16,{persist:true,snapStrip:true});reader()?.measure?.();}
    else if(event.key==='ArrowRight'){event.preventDefault();const base=deskNavWidth<DESK_NAV_STRIP_SNAP?Math.max(DESK_NAV_STRIP_SNAP,deskNavExpandedWidth||DESK_NAV_DEFAULT):deskNavWidth+16;applyDeskNavWidth(base,{persist:true,snapStrip:true});reader()?.measure?.();}
    else if(event.key==='Home'){event.preventDefault();applyDeskNavWidth(DESK_NAV_MIN,{persist:true,snapStrip:true});reader()?.measure?.();}
    else if(event.key==='End'){event.preventDefault();applyDeskNavWidth(DESK_NAV_DEFAULT,{persist:true,snapStrip:true});reader()?.measure?.();}
    else if(event.key==='Enter'||event.key===' '){event.preventDefault();const next=deskNavWidth<=DESK_NAV_MIN?Math.max(DESK_NAV_STRIP_SNAP,deskNavExpandedWidth||DESK_NAV_DEFAULT):DESK_NAV_MIN;applyDeskNavWidth(next,{persist:true,snapStrip:true});reader()?.measure?.();}
  };
}
function fitHeader() {
  const header=$('.chrome'),row=$('.chrome-topline');
  if(!row || typeof ResizeObserver==='undefined')return;
  let scheduled=false;
  const update=()=>{
    if(scheduled)return;scheduled=true;
    requestAnimationFrame(()=>{
      scheduled=false;if(!row.clientWidth)return;
      row.dataset.layoutMeasured='true';
      document.documentElement.style.setProperty('--chrome-height',header.offsetHeight+'px');
    });
  };
  const resize=new ResizeObserver(update);resize.observe(header);
  document.fonts?.ready?.then(update);window.addEventListener('resize',update);update();
}
async function initialize() {
  try{preferences=loadPreferences(localStorage);}catch(error){toast('설정 일부를 읽지 못했습니다. 설정 파일로 복원할 수 있습니다.',true);}applyTheme(preferences.theme);bindUI();fitHeader();$('#library-sort').value=preferences.librarySort;network();folder=await getSetting('folder');settingsFileHandle=await getSetting('settings-file');settingsFolderHint=await getSetting('settings-folder-hint')||'';await refreshLibrary();activate('library');
  if(installableLocation(location)&&'serviceWorker'in navigator)await navigator.serviceWorker.register('./sw.js',{updateViaCache:'none'}).then(reg=>reg?.update?.().catch(()=>{})).catch(()=>toast('오프라인 준비를 완료하지 못했습니다. 다음 접속에서 다시 준비합니다.',true));
  if('launchQueue'in window)window.launchQueue.setConsumer(safely(async params=>{for(const handle of params.files||[])await openLocalFile(handle);}));
  if(await discoverBridge()){updateConnection();await receiveCaptures();}
  setInterval(async()=>{
    if(document.hidden||!bridgeAvailable())return;
    try{const listed=await bridge('listTabs');for(const tab of tabs.filter(t=>t.chromeId)){const found=listed.find(t=>t.id===tab.chromeId);if(found){tab.url=found.url;tab.title=found.title||displayHost(found.url);}}renderTabs();if(active()?.type==='browser')updateChrome();await receiveCaptures();}catch{/* Existing local documents keep working while the extension reconnects. */}
  },3500);
}
initialize().catch(error=>{$('#status-left').textContent='서재를 준비하지 못했습니다.';showError(error);});
