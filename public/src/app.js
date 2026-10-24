import { $, $$, icon, escapeHTML as esc, uid, filename, normalizeURL, displayHost, formatDate, formatBytes, download } from './utils.js';
import { parseHTML, SCRIPT_CSP, serializeBookSource } from './document.js';
import { SaveQueue, ANNOTATION_LABELS } from './model.js';
import { openEditionProbe, migrateAnnotations } from './migrate.js';
import { Reader } from './reader.js';
import { listDocuments, getDocument, deleteDocument, getSetting, setSetting, saveDocumentHTML, listRevisionSummaries, getRevision, putDocumentRevision, putDocumentView, putDocumentSourceIdentity, writeExternalHTML } from './storage.js';
import {readWebPage,pastedPage,PASTE_LIMIT,isWebSearch,BrowserTabs} from './web.js';
import { readLocalHTML, droppedHTMLFiles, findLocalDuplicates, identifyLocalFile, htmlExportName } from './local-files.js';
import { normalizePreferences, loadPreferences, storePreferences, serializeSettings, readSettingsFile, PRESET_COLORS, PRESET_PALETTES, normalizeHexColor, hexToRgb, rgbToHex, hexToHsv, hsvToHex } from './preferences.js';
import {bundledExample} from './distribution.js';
import { InstallController, isIOS, installableLocation, installationURL, PUBLIC_APP_URL } from './install.js';
import { APP_VERSION } from './version.js';

let records = []; const tabs = []; let activeId = 'library'; let folder = null; let popoverName = ''; let sidebarMode = '';
let preferences=normalizePreferences(), settingsFileHandle=null, settingsFolderHint='';
let sharingApp=false, installController;
let readerFocused=false, nativeReaderFullscreen=false, focusBusy=false;
let tabLayout='';
let localImportQueue=Promise.resolve();
const browserTabs=new BrowserTabs(window);let lastWebTab=null;
const active = () => tabs.find(tab => tab.id === activeId);
const reader = () => active()?.reader;
const savePicker = () => typeof window.showSaveFilePicker === 'function';
const openPicker = () => typeof window.showOpenFilePicker === 'function';
const htmlTypes = [{description:'HTML 문서',accept:{'text/html':['.html','.htm']}}];
const importTypes = [{description:'HTML · MHTML 문서',accept:{'text/html':['.html','.htm'],'multipart/related':['.mhtml','.mht'],'application/x-mimearchive':['.mhtml','.mht']}}];
const safely = fn => (...args) => { try { Promise.resolve(fn(...args)).catch(showError); } catch(error) { showError(error); } };
function toast(message, error = false) { const el=$('#toast'); el.textContent=message; el.classList.toggle('error',error); el.hidden=false; clearTimeout(toast.timer); toast.timer=setTimeout(()=>el.hidden=true,error?6500:3500); }
function showError(error) { if (error?.name !== 'AbortError') toast(error?.message || String(error),true); }
function setButton(selector, name, label = '') { $(selector).innerHTML=icon(name)+(label ? `<span>${label}</span>`:''); }
function setIconButton(selector, name, label, size = 18) { const button=$(selector);button.innerHTML=icon(name,size);button.title=label;button.setAttribute('aria-label',label); }
function modal(html, bind = () => {}) {
  closeAppMenu(true); closePopover(); $('#dialog-content').innerHTML=html; const dialog=$('#dialog'); dialog.returnValue=''; if (!dialog.open) dialog.showModal();
  $$('[data-dialog-close]',dialog).forEach(button=>button.onclick=()=>dialog.close()); bind(dialog);
}
function aboutDialog() {
  modal(`<div class="dialog-heading"><h2>About</h2><button class="icon-button" data-dialog-close aria-label="닫기">${icon('close')}</button></div>${$('#about-content').innerHTML}<div class="dialog-actions"><button class="primary-button" data-dialog-close>확인</button></div>`,()=>{$('#app-version').textContent=APP_VERSION;});
}
function closeAppMenu(restoreFocus = false) {
  const menu=$('#app-menu');if(menu.hidden)return;
  const focused=menu.contains(document.activeElement);menu.hidden=true;
  $('#app-menu-button').setAttribute('aria-expanded','false');$('.chrome').classList.remove('app-menu-open');
  if(restoreFocus&&focused)$('#app-menu-button').focus();
}
function appMenuItems() { return $$('button',$('#app-menu')).filter(button=>!button.disabled&&!button.closest('[hidden]')); }
function openAppMenu(last = false) {
  $('#app-menu').hidden=false;$('#app-menu-button').setAttribute('aria-expanded','true');$('.chrome').classList.add('app-menu-open');
  const items=appMenuItems();(last?items.at(-1):items[0])?.focus();
}
function bindAppMenu() {
  const menu=$('#app-menu'),trigger=$('#app-menu-button');
  trigger.onclick=()=>menu.hidden?openAppMenu():closeAppMenu(true);
  trigger.onkeydown=event=>{if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();openAppMenu(event.key==='ArrowUp');}};
  menu.addEventListener('click',event=>{if(event.target.closest('button')&&!event.target.closest('.tab-close'))closeAppMenu(true);});
  menu.addEventListener('keydown',event=>{
    event.stopPropagation();
    if(event.key==='Escape'){event.preventDefault();closeAppMenu(true);return;}
    if(event.key==='Tab'){closeAppMenu(true);return;}
    if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
    event.preventDefault();const items=appMenuItems(),index=items.indexOf(document.activeElement);
    const next=event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length;
    items[next]?.focus();
  });
  document.addEventListener('pointerdown',event=>{if(!event.target.closest('#app-menu,#app-menu-button'))closeAppMenu();});
  window.addEventListener('blur',()=>closeAppMenu());
}
function installGuide(kind) {
  const heading=kind==='installed'?'설치된 HTMLMemo입니다.':'HTMLMemo 앱 설치';
  let content;
  if(kind==='installed')content='<p class="dialog-description">앱 아이콘으로 실행 중입니다. HTML 파일을 가져와 읽고 주석을 남겨보세요.</p>';
  else if(kind==='local')content=`<p class="dialog-description">직접 연 HTML도 읽고 주석을 남길 수 있습니다. 앱 설치는 선택 사항이며, 아래 배포 주소는 설치 없이 브라우저에서 바로 사용할 수 있습니다.</p><p><a class="primary-button" href="${esc(installationURL(location))}">설치할 HTMLMemo 열기</a></p>`;
  else if(kind==='ios')content='<p class="dialog-description">아이폰·아이패드의 Chrome에서는 아래 순서로 설치합니다. 앱 버튼만으로 공유 메뉴를 자동으로 열 수는 없습니다.</p><ol class="setup-steps"><li>Chrome 주소창의 <strong>공유</strong> 버튼을 누릅니다.</li><li><strong>홈 화면에 추가</strong>를 선택합니다.</li><li>이름을 확인하고 <strong>추가</strong>를 누릅니다.</li><li>홈 화면의 <strong>HTMLMemo</strong> 아이콘으로 앱을 엽니다.</li></ol><p class="dialog-description small">iOS 16.4 이상과 최신 Chrome을 사용하세요. 처음 설치한 뒤 앱 아이콘으로 열고 문서를 가져오세요.</p>';
  else if(/Android/.test(navigator.userAgent||''))content='<ol class="setup-steps"><li>Chrome의 <strong>메뉴(⋮)</strong>를 엽니다.</li><li><strong>홈 화면에 추가 → 설치</strong>를 선택합니다.</li><li>앱 아이콘으로 HTMLMemo를 엽니다.</li></ol><p class="dialog-description small">설치 메뉴가 보이지 않으면 첫 로딩과 오프라인 준비가 끝난 뒤 다시 시도하세요.</p>';
  else content='<ol class="setup-steps"><li>Chrome 주소창 오른쪽의 <strong>설치</strong> 아이콘을 누릅니다.</li><li>아이콘이 없다면 Chrome 메뉴의 <strong>전송, 저장 및 공유 → 페이지를 앱으로 설치</strong>를 선택합니다.</li><li>설치를 확인하고 앱 아이콘으로 HTMLMemo를 엽니다.</li></ol><p class="dialog-description small">설치 안내가 자동으로 열리는 환경에서는 앱 설치 버튼을 다시 누르면 됩니다.</p>';
  modal(`<div class="dialog-heading"><h2>${heading}</h2><button class="icon-button" data-dialog-close aria-label="닫기">${icon('close')}</button></div>${content}<p class="local-only-note">${icon('check',15)} 문서·주석·설정은 기기에만 저장합니다.</p><div class="dialog-actions"><button class="primary-button" data-dialog-close>확인</button></div>`);
}
function updateInstall(state) {
  for(const selector of ['#install-button','#execution-install']){const button=$(selector);button.hidden=selector==='#install-button'&&state.installed;button.disabled=state.busy;const label=state.busy?'설치 확인 중…':state.installed?'설치 완료':'앱 설치';if(selector==='#install-button')button.innerHTML=icon('download',16)+'<span>'+label+'</span>';else button.textContent=label;button.title=label;button.setAttribute('aria-label',label);}
  $('#install-status').textContent=state.installed?'앱으로 실행 중입니다. 문서·주석·설정은 이 기기에 저장됩니다.':!installableLocation(location)?'PWA 설치는 배포된 앱 주소에서 가능합니다. HTML 파일의 읽기·주석은 계속 사용할 수 있습니다.':isIOS(navigator)?'아이폰은 앱 설치 버튼에서 Chrome 공유 메뉴 사용 순서를 확인하세요.':'설치하지 않아도 이 URL에서 바로 사용할 수 있습니다.';
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
function webHelpDialog(tab=webContext(),message=''){
  modal(`<div class="dialog-heading"><h2>Chrome에서 탐색하고 여기서 메모하기</h2><button class="icon-button" data-dialog-close aria-label="닫기">${icon('close')}</button></div>${message?`<p class="web-notice" role="status">${esc(message)}</p>`:''}<p class="dialog-description">HTMLMemo는 이 URL만 열면 사용할 수 있습니다. 앱 설치는 선택 사항이며 추가 프로그램이나 서버 연결은 필요하지 않습니다.</p><ol class="setup-steps"><li>주소창에 검색어나 웹 주소를 입력하면 <strong>Chrome의 일반 탭</strong>에서 엽니다. 다른 브라우저로 앱을 열었다면 그 브라우저에서 열립니다.</li><li>필요한 글을 복사한 뒤 <strong>HTMLMemo 탭으로 돌아옵니다.</strong> 읽던 문서와 주석은 그대로입니다.</li><li><strong>텍스트 붙여넣기</strong>에서 글과 실제 원문 주소를 넣거나, Chrome에서 저장한 <strong>HTML 파일을 가져옵니다.</strong></li></ol><p class="dialog-description small">다른 Chrome 탭의 현재 주소·본문·로그인 정보나 클립보드를 자동으로 읽지 않습니다. 사이트가 탭 연결을 격리하거나 팝업을 막으면 직접 링크를 사용하세요. HTML은 가능한 경우 단일 파일로 저장하세요.</p><div class="web-actions">${tab?`<a class="secondary-button" href="${esc(tab.url)}" target="_blank" rel="noopener noreferrer">보낸 주소 열기 ${icon('external',14)}</a>`:''}<button id="web-help-import" class="secondary-button">HTML 파일 가져오기</button><button id="web-help-paste" class="primary-button">텍스트 붙여넣기</button></div>`,()=>{
    $('#web-help-import').onclick=safely(async()=>{$('#dialog').close();await importFiles();});
    $('#web-help-paste').onclick=()=>pasteTextDialog(tab);
  });
}
function pasteTextDialog(tab=webContext()){
  const search=tab&&isWebSearch(tab.url);
  modal(`<form id="paste-form"><div class="dialog-heading"><h2>텍스트 붙여넣기</h2><button type="button" class="icon-button" data-dialog-close aria-label="닫기">${icon('close')}</button></div><p class="dialog-description">Chrome에서 복사한 글을 아래에 붙여넣으세요. 서재에 저장한 뒤 바로 주석을 남깁니다. 서식·이미지·실행 코드는 가져오지 않습니다.</p><label class="paste-label" for="paste-title">제목</label><input id="paste-title" class="paste-title" maxlength="300" value="${esc(!search&&tab?.title||'붙여넣은 글')}"><label class="paste-label" for="paste-source">원문 주소 (선택)</label><input id="paste-source" class="paste-title" type="url" value="${esc(!search&&tab?.url||'')}" placeholder="Chrome에서 복사한 실제 글의 https:// 주소"><label class="paste-label" for="paste-text">내용</label><textarea id="paste-text" class="paste-text" maxlength="${PASTE_LIMIT}" rows="8" required placeholder="여기에 글을 붙여넣으세요."></textarea><p class="dialog-description small">최대 200,000자 · 이 기기에만 저장${search?' · 검색 주소 대신 실제 글의 주소를 넣으세요.':''}</p><div class="dialog-actions"><button type="button" class="secondary-button" data-dialog-close>취소</button><button id="paste-save" type="submit" class="primary-button">저장하고 주석 달기</button></div></form>`,()=>{
    $('#paste-form').onsubmit=safely(async event=>{
      event.preventDefault();if($('#paste-save').disabled)return;
      const snapshot=pastedPage({text:$('#paste-text').value,title:$('#paste-title').value,url:$('#paste-source').value.trim()}),button=$('#paste-save');button.disabled=true;
      try{const saved=await createDocument(snapshot,await folderFile(snapshot.title));$('#dialog').close();if(!saved?.queue?.error)toast('붙여넣은 글을 서재에 저장했습니다.');}finally{button.disabled=false;}
    });
    requestAnimationFrame(()=>$('#paste-text')?.focus());
  });
}
function settingsDialog() {
  modal(`<div class="dialog-heading"><h2>HTMLMemo 설정</h2><button class="icon-button" data-dialog-close aria-label="닫기">${icon('close')}</button></div><p class="local-only-note">${icon('check',15)} 모든 문서·주석·설정은 이 기기에만 저장됩니다.</p><div class="setting-row"><div><strong>자동 저장 폴더</strong><p>${folder?esc(folder.name):settingsFolderHint?'백업 폴더: '+esc(settingsFolderHint)+' · 다시 연결해주세요.':'앱 내부에 HTML 파일로 보관 중'}</p></div><button id="settings-folder" class="secondary-button">${folder?'변경':'폴더 연결'}</button></div><p class="dialog-description small">폴더 권한은 설정 파일로 옮길 수 없어 새 기기에서 한 번 연결해야 합니다.</p><div class="setting-row"><div><strong>화면 테마</strong><p>서재와 도구의 밝기를 선택하세요.</p></div><select id="appearance"><option value="light">밝게</option><option value="dark">어둡게</option><option value="system">시스템</option></select></div><div class="setting-row"><div><strong>툴바 위치</strong><p>옮긴 위치도 설정 파일에 보관합니다.</p></div><button id="reset-toolbar-position" class="secondary-button">가운데로</button></div><div class="settings-backup"><h3>설정 파일</h3><p class="dialog-description small">테마·정렬 기준과 방향·주석 색상·굵기·투명도·표시 시간·툴바 위치를 JSON 파일로 저장하고 다시 불러옵니다.</p><p id="settings-file-name" class="settings-file-name">${settingsFileHandle?esc(settingsFileHandle.name):'연결한 설정 파일이 없습니다.'}</p><div class="settings-file-actions"><button id="settings-save" class="secondary-button">${icon('save',15)} 설정 파일 저장</button><button id="settings-load" class="secondary-button">${icon('folder',15)} 설정 파일 불러오기</button><button id="settings-reload" class="secondary-button" ${settingsFileHandle?'':'disabled'}>${icon('reload',15)} 다시 불러오기</button></div></div><div class="setting-row"><div><strong>웹페이지 가져오기</strong><p>추가 설치 없이 사용하는 방법과 사이트 제한</p></div><button id="settings-web" class="secondary-button">사용 안내</button></div><div class="setting-row"><div><strong>기기 보관함 유지</strong><p>브라우저의 자동 공간 정리에서 보호 요청</p></div><button id="persist-storage" class="secondary-button">보관 유지</button></div><p class="dialog-description small">앱 데이터 삭제 시 내부 보관함도 지워집니다. 중요한 문서는 HTML 파일로 내보내주세요.</p>`,()=>{
    $('#settings-folder').onclick=safely(()=>chooseFolder({onConnected:settingsDialog}));$('#settings-web').onclick=()=>webHelpDialog();
    $('#appearance').value=preferences.theme; $('#appearance').onchange=safely(e=>changePreferences({theme:e.target.value}));
    $('#settings-save').onclick=safely(saveSettingsBackup);$('#settings-load').onclick=safely(importSettingsBackup);$('#settings-reload').onclick=safely(async()=>{await restoreSettings(settingsFileHandle);settingsDialog();});
    $('#reset-toolbar-position').onclick=safely(()=>{changePreferences({toolbarPosition:null});toast('툴바를 가운데로 옮겼습니다.');});
    $('#persist-storage').onclick=safely(async()=>toast(await navigator.storage.persist()?'이 기기에서 보관함을 유지합니다.':'브라우저가 보관 유지를 허용하지 않았습니다. HTML 내보내기로 파일을 보관해주세요.'));
  });
}
function applyTheme(theme) { document.documentElement.dataset.theme=theme==='system'?(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'):theme;for(const tab of tabs)if(tab.reader?.documentSidebarUI)styleNativeSidebar(tab.reader.documentSidebarUI); }
function applyToolbarPosition(){const bar=$('#toolbar'),p=preferences.toolbarPosition;if(!p){bar.style.left='50%';bar.style.top='';bar.style.bottom='';bar.style.transform='';return;}bar.style.transform='none';bar.style.bottom='auto';bar.style.left=(8+p.x*Math.max(0,innerWidth-bar.offsetWidth-16))+'px';bar.style.top=(8+p.y*Math.max(0,innerHeight-bar.offsetHeight-42))+'px';}
function changePreferences(patch){preferences=storePreferences({...preferences,...patch,annotation:{...preferences.annotation,...patch.annotation}},localStorage);applyTheme(preferences.theme);$('#library-sort').value=preferences.librarySort+':'+preferences.librarySortDirection;for(const tab of tabs)if(tab.reader)Object.assign(tab.reader,preferences.annotation);applyToolbarPosition();renderLibrary();if(reader())updateToolbarState();}
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
  const filter=$('#library-filter').value.toLocaleLowerCase(),sort=preferences.librarySort,direction=preferences.librarySortDirection==='asc'?1:-1;
  const shown=records.filter(r=>(r.title+' '+r.source+' '+r.name).toLocaleLowerCase().includes(filter)).sort((a,b)=>direction*(sort==='title'?a.title.localeCompare(b.title,'ko'):a[sort]-b[sort]));
  const dateField=sort==='created'?'created':'modified',dateLabel=dateField==='created'?'저장일':'수정일';
  const grid=$('#document-grid');grid.dataset.view=preferences.libraryView;
  $$('[data-library-view]').forEach(button=>{const active=button.dataset.libraryView===preferences.libraryView;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));});
  $('#document-count').textContent=records.length; $('#empty-library').hidden=shown.length>0;
  $('#empty-library h3').textContent=records.length?'검색 결과가 없습니다.':'첫 HTML 문서를 보관해보세요.';
  $('#empty-library p').innerHTML=records.length?'다른 제목이나 주소로 찾아보세요.':'웹에서 저장하거나, 가지고 있는 HTML 파일을 열면<br>이곳에서 계속 읽고 메모할 수 있어요.';
  $('#open-example').hidden=!!records.length;
  grid.innerHTML=shown.map(record=>{
    const count=record.metadata?.annotations?.length||0;const progress=record.metadata?.view?.scrollTop||0;
    const host=esc(displayHost(record.source)), title=esc(record.title), size=record.byteSize?formatBytes(record.byteSize):'HTML';
    const date=formatDate(record[dateField]),dateTitle=esc(dateLabel+': '+new Date(record[dateField]).toLocaleString('ko-KR'));
    // Both layouts share one title/source. A decorative preview used to repeat
    // them above the details, and list mode kept a third hidden copy.
    return `<article class="document-card" data-record="${record.id}"><button class="card-open" data-open="${record.id}"><div class="card-details"><span class="list-file-icon" aria-hidden="true">${icon('file',16)}</span><h3 class="list-title" title="${title}">${title}</h3><p class="card-source"><span class="list-host" title="${host}">${host}</span><span class="list-date" title="${dateTitle}" aria-label="${dateTitle}">${date}</span></p><div class="card-meta"><span class="list-annotations" title="주석 ${count}개" aria-label="주석 ${count}개">${icon('highlight',13)} <span>${count}</span></span><span class="list-size">${size}</span><span class="list-progress" title="${progress?'이어서 읽기':'새 문서'}">${progress?'이어서 읽기':'새 문서'} ${icon('forward',13)}</span></div></div></button><button class="card-menu icon-button" data-card-menu="${record.id}" aria-label="${title} 문서 메뉴">${icon('more',17)}</button></article>`;
  }).join('');
  $$('[data-open]').forEach(button=>button.onclick=safely(()=>openRecord(records.find(r=>r.id===button.dataset.open))));
  $$('[data-card-menu]').forEach(button=>button.onclick=()=>documentMenu(records.find(r=>r.id===button.dataset.cardMenu)));
  $('#choose-folder').innerHTML=(folder?esc(folder.name)+' 연결됨':'저장 폴더 연결')+' '+icon('external',13);
  if(activeId==='library')$('#status-left').textContent=`${records.length}개의 문서 · ${folder?folder.name+' 자동 저장':'이 기기에 보관'}`;
}
function renderTabs() {
  const container=$('#tabs'),nodes=new Map($$('[data-tab]',container).map(el=>[el.dataset.tab,el]));
  const focusId=tabs.some(tab=>tab.id===activeId)?activeId:tabs[0]?.id;
  for(const tab of tabs){
    let el=nodes.get(tab.id);
    if(!el){
      el=document.createElement('div');el.dataset.tab=tab.id;el.setAttribute('role','presentation');
      el.innerHTML=`<button class="tab-select" role="tab"><span class="tab-icon">${icon(tab.type==='document'?'file':'globe',15)}</span><span class="tab-title"></span><i class="tab-dirty" hidden></i></button><button class="tab-close" data-close="${tab.id}">${icon('close',13)}</button>`;
      $('.tab-select',el).onclick=safely(()=>selectTab(tab.id));
      $('[data-close]',el).onclick=safely(e=>{e.stopPropagation();return closeTab(tab.id);});container.append(el);
    }
    const selected=tab.id===activeId,button=$('.tab-select',el);
    el.className=`tab ${selected?'active':''} ${tab.type}`;el.title=tab.record?.name?tab.title+' · '+tab.record.name:tab.title;
    button.id='tab-'+tab.id;button.setAttribute('aria-selected',String(selected));button.setAttribute('aria-controls',tab.host.id);button.tabIndex=tab.id===focusId?0:-1;
    tab.host.setAttribute('role','tabpanel');tab.host.setAttribute('aria-labelledby',button.id);
    const title=$('.tab-title',el);if(title.textContent!==tab.title)title.textContent=tab.title;
    $('.tab-dirty',el).hidden=!tab.opening && !tab.queue?.editsPending;
    $('[data-close]',el).setAttribute('aria-label',tab.title+' 탭 닫기');
    $('[data-close]',el).title=tab.title+' 탭 닫기';$('[data-close]',el).tabIndex=selected?0:-1;
    nodes.delete(tab.id);
  }
  for(const node of nodes.values())node.remove();
  container.hidden=tabs.length===0;
  // Reveal a changed selection, without snapping back when autosave reports.
  const layout=activeId+':'+tabs.map(tab=>tab.id).join(',');
  if(layout!==tabLayout){tabLayout=layout;requestAnimationFrame(revealActiveTab);}
  $('#library-tab').classList.toggle('active',activeId==='library');
  $('#library-tab').setAttribute('aria-current',activeId==='library'?'page':'false');
  $('#execution-tab').setAttribute('aria-current',activeId==='execution'?'page':'false');
  $('#execution-tab').classList.toggle('active',activeId==='execution');
}
function revealActiveTab() {
  const container=$('#tabs'),tab=$('.tab.active',container);if(!tab||container.hidden)return;
  const bounds=container.getBoundingClientRect(),rect=tab.getBoundingClientRect();if(!bounds.width)return;
  if(rect.left<bounds.left)container.scrollLeft-=bounds.left-rect.left;
  else if(rect.right>bounds.right)container.scrollLeft+=rect.right-bounds.right;
}
function focusAddress() {
  $('.chrome').classList.add('address-editing');$('#address').focus();$('#address').select?.();
}
function bindTabs() {
  const container=$('#tabs');
  container.addEventListener('wheel',event=>{
    if(event.ctrlKey||event.metaKey||container.scrollWidth<=container.clientWidth||Math.abs(event.deltaX)>=Math.abs(event.deltaY))return;
    const unit=event.deltaMode===1?16:event.deltaMode===2?container.clientWidth:1,before=container.scrollLeft;
    container.scrollLeft+=event.deltaY*unit;
    if(container.scrollLeft!==before)event.preventDefault();
  },{passive:false});
  container.addEventListener('keydown',safely(async event=>{
    if(!event.target.matches('.tab-select'))return;
    const buttons=$$('.tab-select',$('#tabs')),index=buttons.indexOf(event.target);
    if(event.key==='Delete'){
      event.preventDefault();await closeTab(event.target.closest('[data-tab]').dataset.tab);
      ($('.tab.active .tab-select',$('#tabs'))||$('#library-tab')).focus();return;
    }
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;
    activate(buttons[next].closest('[data-tab]').dataset.tab);buttons[next].focus();
  }));
}
function activate(id) {
  if(id!==activeId)reader()?.stopSpeech();
  if(readerFocused && id!==activeId)void leaveReaderFocus();
  closeAppMenu(true); closePopover(); closeSidebar({remember:false,clearSearch:false});$('.chrome').classList.remove('address-editing');activeId=id; $('#library').hidden=id!=='library';$('#execution').hidden=id!=='execution';$('#workspace').hidden=id==='library'||id==='execution';
  tabs.forEach(tab=>tab.host.hidden=tab.id!==id);renderTabs();updateChrome();
  if(reader()){renderToolbar();restoreSidebar();if(reader().dynamicDirty)reader().scheduleDynamicRefresh();}else $('#toolbar').hidden=true;
  if(id==='library')renderLibrary();
  if(id==='execution'){$('#status-left').textContent='앱 설치 · URL 공유 · 모든 데이터는 이 기기에 저장';document.title='앱 설치 · URL 공유 · HTMLMemo';}
}
async function selectTab(id) {
  const tab=tabs.find(tab=>tab.id===id);if(!tab)return;
  activate(id);
  if(tab.external)focusBrowserTab(tab);
}
function updateChrome() {
  const tab=active(); const r=reader(); const local=tab?.type==='document';const execution=activeId==='execution';
  $('.chrome').dataset.page=local?'document':tab?'browser':activeId;
  if(!$('.chrome').classList.contains('address-editing'))$('#address').value=local?tab.record.name:tab?.url||'';
  $('#address-icon').innerHTML=icon(local?'file':'globe',15);$('#local-label').hidden=!local;
  $('#back').disabled=local?!r?.linkHistory.length:!tab||tab.external||tab.cursor<=0||!!tab.capturing;
  $('#forward').disabled=!tab||local||tab.external||tab.cursor>=tab.history.length-1||!!tab.capturing;
  $('#reload').disabled=!tab||local||tab.external||!!tab.capturing;
  setIconButton('#save-page',execution?'globe':local?'download':tab?.external?'folder':'save',execution?'URL 복사':local?'HTML 내보내기':tab?.external?'Chrome에서 가져오기':'페이지 저장',17);
  $('#save-page').disabled=execution?sharingApp:!tab||!!tab.capturing;
  if(local)saveStatus(tab); else if(tab)$('#status-left').textContent=tab.external?'웹 탐색은 브라우저 탭 · 복사한 글과 저장한 HTML은 여기서 주석 달기':tab.capturing?'읽기용 사본을 준비하는 중…':tab.readable?'페이지 저장 → 주석 달기 · 추가 설치 없음':'앱 문서를 준비하는 중…';
  document.title=tab?tab.title+' · HTMLMemo':'HTMLMemo · 나만의 웹 서재';
}
function createHost(id,type) { const host=document.createElement('div');host.id='workspace-'+id;host.className='workspace-host '+type+'-host';host.hidden=true;$('#workspaces').append(host);return host; }
async function openRecord(record, prepared = null, {deferReady = false, sourceIdentity = null} = {}) {
  const existing=tabs.find(tab=>tab.record?.id===record.id);if(existing){if(existing.closePromise){await existing.closePromise;return openRecord(record,prepared,{deferReady,sourceIdentity});}activate(existing.id);return existing;}
  if(!prepared && typeof record.html!=='string' && !record.file)record=await getDocument(record.id);
  const opened=tabs.find(tab=>tab.record?.id===record.id);if(opened){if(opened.closePromise){await opened.closePromise;return openRecord(record,prepared,{deferReady,sourceIdentity});}activate(opened.id);return opened;}
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
    // Early scrolling/edits must not save before the import identity is ready.
    if(sourceIdentity)await sourceIdentity;
    if (!tab.queue.editsPending) {
      const saved = await putDocumentView(tab.record.id, tab.reader.metadata.view);
      tab.record.metadata = saved.metadata;
      records=records.filter(r=>r.id!==record.id).concat(saved);
      return;
    }
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
    onChange:()=>{tab.queue.schedule();if(activeId===tab.id){renderToolbar();if(['annotations','bookmarks'].includes(sidebarMode))renderSidebar(sidebarMode);else updateSidebarCounts($('#sidebar'),tab.reader);tab.reader?.refreshDocumentSidebar();}},
    onPosition:()=>{tab.queue.schedule({background:true});},onView:()=>{if(activeId===tab.id){updateChrome();updateToolbarState();}},
    onTextSelection:()=>{if(activeId===tab.id)showSelectionMenu(tab.reader);},
    onSelectionDismiss:()=>{if(popoverName==='selection'||popoverName.startsWith('tool-mode-'))closePopover();},
    onLink:url=>safely(openBrowser)(url),onKey:handleKey,requestText:promptText,onError:showError,onNotice:message=>toast(message),
    onDocumentFocus:()=>{if(activeId===tab.id)void toggleReaderFocus();},
    onReadingAction:(action,button)=>{if(activeId===tab.id)toolAction(action,button);},
    onSidebarView:(mode,panel,documentReader)=>renderSidebar(mode,{panel,embedded:true,documentReader}),
    onSidebarCounts:(panel,documentReader)=>updateSidebarCounts(panel,documentReader),
    onSearchChange:documentReader=>updateSearchNavigation(documentReader),
    onSelect:id=>{if(activeId===tab.id)annotationDialog(tab,id);},
  });
  Object.assign(tab.reader,preferences.annotation);
  let baselineMetadata;
  try {
    await tab.reader.ready;
    baselineMetadata=structuredClone(tab.reader.metadata);
    if(sourceIdentity){const identity=await sourceIdentity;if(identity)tab.record.sourceIdentity=identity;}
  } catch(error) {tabs.splice(tabs.indexOf(tab),1);tab.reader.dispose();activate('library');throw error;}
  if(parsed.file){tab.record.file=parsed.file;delete tab.record.html;tab.reader.initialHTML=null;tab.record.metadata=tab.reader.metadata;tab.record.source=tab.reader.metadata.source;tab.title=tab.record.title=tab.reader.metadata.title;}
  if(activeId===tab.id)restoreSidebar();
  renderToolbar();
  updateChrome();
  // Preserve the imported/current annotation baseline before the first new edit.
  try{const saved=await putDocumentRevision({...tab.record,metadata:baselineMetadata},{baseline:true});tab.record.byteSize=saved.byteSize;delete tab.record.html;delete tab.record.file;}
  catch(error){tab.queue.schedule();try{await tab.queue.flush();}catch{showError(error);}}
  record.html=null;record.file=null;parsed.html=null;parsed.file=null;
  if(!deferReady){tab.opening=false;renderTabs();if(activeId===tab.id)updateChrome();}
  return tab;
}
function saveStatus(tab) {
  const queue=tab.queue;if(!queue)return;
  const label=queue.error?(queue.editsPending?'주석 자동 저장 실패 · ':'읽기 위치 저장 실패 · ')+queue.error.message:queue.editsPending||tab.opening?'저장 중…':'주석이 앱에 자동 저장됨';
  const status=$('#status-left');let state=$('.save-state',status);
  if(!state){status.replaceChildren();state=document.createElement('span');status.append(state);}
  const className=`save-state ${queue.error?'save-error':''}`;
  if(state.textContent.trim()!==label || state.className!==className){
    state.className=className;
    state.innerHTML=`${icon(queue.error?'more':queue.editsPending||tab.opening?'reload':'check',13)} ${esc(label)}`;
  }
  let retry=$('#retry-save');
  if(queue.error){
    if(!retry){retry=document.createElement('button');retry.id='retry-save';retry.className='text-button';status.append(retry);}
    retry.textContent='저장 재시도';retry.onclick=safely(()=>tab.queue.flush());
  }else retry?.remove();
  let bookNotice = $('[data-book-incomplete]', status);
  if (tab.reader?.bookIntegrity?.complete === false) {
    if (!bookNotice) { bookNotice = document.createElement('button'); bookNotice.className = 'text-button save-error'; bookNotice.dataset.bookIncomplete = ''; status.append(bookNotice); }
    bookNotice.textContent = '책 본문 누락 · 원본 HTML 가져오기';
    bookNotice.title = tab.reader.bookIntegrity.message;
    bookNotice.onclick = safely(importFiles);
  } else bookNotice?.remove();
}
async function closeTab(id) {
  const tab=tabs.find(t=>t.id===id);if(!tab)return;
  if(tab.closePromise)return tab.closePromise;
  tab.closing=true;
  tab.closePromise=(async()=>{
    try{
      if(tab.reader){await tab.reader.ready;tab.reader.rememberPosition();await tab.queue.flush();tab.reader.dispose();}else tab.host.remove();
      browserTabs.forget(id);if(lastWebTab===tab)lastWebTab=null;tabs.splice(tabs.indexOf(tab),1);if(activeId===id)activate(tabs.at(-1)?.id||'library');else renderTabs();await refreshLibrary();
    }finally{tab.closing=false;tab.closePromise=null;}
  })();
  return tab.closePromise;
}
async function createDocument(snapshot, handle = null, name = null, local = {}) {
  // New, size-unmatched files prepare the reader and fingerprint concurrently.
  // Attach a rejection handler now; openRecord awaits it before baseline save.
  const identity=identifyLocalFile(local);identity.catch(()=>{});
  const parsed=snapshot.file ? {...parseHTML('<html><head></head><body></body></html>',{title:snapshot.title,execution:{allowScripts:!!snapshot.allowScripts}}),file:snapshot.file,nativeScroll:true,freshAnnotations:!!local.freshAnnotations} : parseHTML(snapshot.html,{title:snapshot.title,source:snapshot.url,viewport:snapshot.viewport,warnings:snapshot.warnings},{includeMetadata:true,allowScripts:snapshot.allowScripts,freshAnnotations:!!local.freshAnnotations});
  const title=parsed.metadata.title; const record={id:uid(),title,name:name||handle?.name||filename(title),source:parsed.metadata.source,created:Date.now(),modified:Date.now(),fileHandle:handle,originalHandle:local.originalHandle||null,metadata:parsed.metadata};
  if(snapshot.file)record.file=snapshot.file;else record.html=parsed.html;
  if(local.sourceIdentity)record.sourceIdentity=local.sourceIdentity;
  if(local.diskStamp)record.diskStamp=local.diskStamp;
  else if(handle){const disk=await handle.getFile();record.diskStamp={modified:disk.lastModified,size:disk.size};}
  const {html:body,file:sourceFile,...summary}=record;records=records.filter(r=>r.id!==record.id).concat(summary);let tab;
  try{tab=await openRecord(record,parsed,{deferReady:true,sourceIdentity:identity});}catch(error){records=records.filter(r=>r.id!==record.id);renderLibrary();throw error;}
  if(tab.closing || !tabs.includes(tab)){tab.opening=false;return tab;}
  tab.queue.schedule();
  try { await tab.queue.flush(); } catch(error) { showError(error); }
  if(tab.closing || !tabs.includes(tab)){tab.opening=false;return tab;}
  if(handle && !local.originalHandle && !tab.queue.error && tab.reader.bookIntegrity?.complete !== false)await writeExternalHTML(tab.record,tab.reader.html());
  tab.opening=false;renderLibrary();activate(tab.id);
  if(tab.queue.error)return tab;
  if(tab.reader.bookIntegrity?.complete === false)toast(tab.reader.bookIntegrity.message, true);
  else if(parsed.metadata.warnings.length)toast(`페이지를 저장했습니다. ${parsed.metadata.warnings.length}개의 리소스를 보관하지 못했습니다. 문서 정보에서 확인할 수 있어요.`,true);
  else toast(local.originalHandle||name?'로컬 HTML을 주석 탭에서 열었습니다.':'서재에 저장하고 주석 탭에서 열었습니다.');
  return tab;
}
function chooseFolder({onConnected} = {}) {
  if(!window.showDirectoryPicker){toast('이 브라우저는 외부 폴더 연결을 지원하지 않습니다. 앱에 자동 저장되며 HTML 내보내기를 사용할 수 있어요.');return;}
  modal(`<div class="dialog-heading"><h2>저장 폴더 연결</h2><button class="icon-button" data-dialog-close aria-label="닫기">${icon('close')}</button></div><p class="dialog-description">문서나 다운로드 폴더 안의 <strong>HTMLMemo 전용 하위 폴더</strong>를 선택하세요.</p><p class="dialog-description"><code>문서/HTMLMemo</code> 또는 <code>다운로드/HTMLMemo</code><br>선택 창에서 HTMLMemo 폴더를 새로 만들거나 기존 하위 폴더를 선택하면 됩니다.</p><p class="dialog-description small">홈·문서·다운로드 폴더 전체와 시스템 폴더는 브라우저가 연결을 제한합니다. “Can't open this folder”가 나오면 전용 하위 폴더를 선택하세요.</p><p id="folder-connection-status" class="dialog-description" role="status">${folder?'현재 연결: '+esc(folder.name):'폴더를 연결하지 않아도 문서와 주석은 앱에 자동 저장됩니다.'}</p><div class="dialog-actions"><button class="secondary-button" data-dialog-close>닫기</button><button id="select-storage-folder" class="primary-button">폴더 선택</button></div>`,()=>{
    const button=$('#select-storage-folder'),status=$('#folder-connection-status');
    button.onclick=safely(async()=>{
      if(button.disabled)return;
      button.disabled=true;let selected;
      try{
        selected=await window.showDirectoryPicker({id:'htmlmemo-storage-v2',mode:'readwrite',startIn:folder||'documents'});
        await setSetting('folder',selected);
      }catch(error){
        if(error?.name==='AbortError')status.textContent='폴더 연결은 변경하지 않았습니다. 연결하려면 전용 하위 폴더를 선택하세요.';
        else if(selected)status.textContent='폴더 연결 정보를 저장하지 못했습니다. 기존 연결은 유지됩니다. 다시 시도해 주세요.';
        else if(['NotAllowedError','SecurityError'].includes(error?.name))status.textContent='브라우저가 폴더 연결을 허용하지 않았습니다. 문서/HTMLMemo 같은 전용 하위 폴더를 선택하세요.';
        else status.textContent='폴더를 연결하지 못했습니다. '+(error?.message||String(error));
        return;
      }finally{button.disabled=false;}
      folder=selected;renderLibrary();$('#dialog').close();if(typeof onConnected==='function')onConnected();toast(folder.name+' 폴더에 새 문서를 자동 저장합니다.');
    });
  });
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
  let handles;try{handles=await window.showOpenFilePicker({types:importTypes,multiple:true});}catch(error){if(['SecurityError','NotSupportedError'].includes(error.name)){$('#file-input').click();return;}throw error;}
  for(const handle of handles)await openLocalFile(handle);
}
function duplicateImportDialog(local, matches) {
  const choices=[...matches].sort((a,b)=>Number(!!b.metadata?.annotations?.length)-Number(!!a.metadata?.annotations?.length)||(b.modified||0)-(a.modified||0));
  const options=choices.map((record,index)=>{
    const stamp=new Date(record.modified||record.created||Date.now()).toLocaleString('ko-KR');
    return `<option value="${esc(record.id)}">${index+1}. ${esc(record.title||record.name)} · 주석 ${record.metadata?.annotations?.length||0}개 · ${esc(stamp)}</option>`;
  }).join('');
  return new Promise(resolve=>modal(`<form method="dialog" data-duplicate-import><div class="dialog-heading"><h2>이미 불러온 HTML 파일입니다</h2></div><p class="dialog-description"><strong>${esc(local.name)}</strong> 파일은 이미 보관함에 있습니다. 새롭게 열어 별도의 주석을 시작할까요?</p><p class="dialog-description small">새롭게 열면 주석과 북마크가 없는 독립 사본을 만듭니다. 기존 문서와 주석, 원본 HTML 파일은 변경하지 않습니다.</p><label class="duplicate-import-target">기존 주석 파일<select id="duplicate-import-target" aria-label="기존 주석 파일">${options}</select></label><div class="dialog-actions duplicate-import-actions"><button class="secondary-button" value="cancel" autofocus>취소</button><button class="secondary-button" value="new">새롭게 열기</button><button class="primary-button" value="existing">기존의 주석 파일로 가기</button></div></form>`,dialog=>{
    $('[data-duplicate-import]',dialog).addEventListener('keydown',event=>{if(event.key==='Escape')event.stopPropagation();});
    dialog.addEventListener('close',()=>resolve({action:['new','existing'].includes(dialog.returnValue)?dialog.returnValue:'cancel',id:$('#duplicate-import-target').value}),{once:true});
  }));
}
function openLocalFile(input) {
  // File picker, input, drop and launch events share one queue. Concurrent
  // imports must not overwrite a pending three-way choice or miss each other.
  const pending=localImportQueue.then(()=>importLocalFile(input));
  localImportQueue=pending.catch(()=>{});return pending;
}
async function importLocalFile(input) {
  try{
    $('#status-left').textContent='로컬 HTML을 읽고 중복을 확인하는 중…';
    const local=await readLocalHTML(input,{native:true,allowScripts:true,identify:false});
    const matches=await findLocalDuplicates(local,await listDocuments(),getDocument);
    if(matches.length){
      const legacy=matches.filter(record=>!record.sourceIdentity);
      if(legacy.length){
        const identity=await identifyLocalFile(local);
        for(const record of legacy){
          try{
            const saved=await putDocumentSourceIdentity(record.id,identity);
            if(saved)record.sourceIdentity=saved.sourceIdentity;
          }catch{toast('파일은 확인했지만 확인 결과를 보관하지 못했습니다. 다음에는 다시 검사합니다.',true);}
        }
      }
      const choice=await duplicateImportDialog(local,matches);
      if(choice.action==='cancel')return null;
      if(choice.action==='existing'){
        const record=matches.find(record=>record.id===choice.id);
        if(!record)throw new Error('기존 주석 문서를 선택해주세요.');
        return await openRecord(record);
      }
      local.freshAnnotations=true;
    }
    $('#status-left').textContent='HTML 문서를 준비하는 중…';
    await new Promise(resolve=>setTimeout(resolve,0));
    return await createDocument(local.snapshot,local.handle,local.name,local);
  }finally{if(activeId==='library')renderLibrary();else updateChrome();}
}
async function savePage() {
  if(activeId==='execution')return copyAppURL();
  const tab=active();if(!tab)return;
  if(tab.reader)return exportDocument(tab);
  if(tab.external)return pasteTextDialog(tab);
  return capturePage(tab);
}
async function capturePage(tab) {
  if(isWebSearch(tab.url))return pasteTextDialog(tab);
  if(tab.capturing)return tab.capturing;
  const saving=(async()=>{
    let snapshot;
    try{
      const live=browserDocument(tab);
      snapshot=live?await HTMLMemoCapture.captureDocument(live):await readWebPage(tab.url);
    }catch(error){
      webHelpDialog(tab,'직접 가져오지 못했습니다. 사이트의 읽기 제한, 로그인 또는 네트워크 상태를 확인하세요. '+(error.message||''));
      return false;
    }
    // The app's own library is sufficient. A file picker is only needed for
    // an explicit export; a previously chosen folder remains optional.
    const saved=await createDocument(snapshot,await folderFile(snapshot.title));return !saved?.queue?.error;
  })();
  tab.capturing=saving;renderBrowserState(tab);if(active()===tab)updateChrome();
  try{return await saving;}finally{tab.capturing=null;renderBrowserState(tab);if(active()===tab)updateChrome();}
}
async function exportDocument(tab) {
  if (tab.reader.bookIntegrity?.complete === false) throw new Error(tab.reader.bookIntegrity.message);
  // Invoke the picker before awaiting persistence, while the click still has user activation.
  let handle;
  if(savePicker()) {
    try { handle=await window.showSaveFilePicker({suggestedName:htmlExportName(tab.record.name,true),types:htmlTypes}); }
    catch(error){if(!['SecurityError','NotSupportedError'].includes(error.name))throw error;}
  }
  await tab.reader.ready;tab.reader.rememberPosition();await tab.queue.flush();
  const source = tab.reader.bookIntegrity?.complete ? await getDocument(tab.record.id) : null;
  const html=source ? await serializeBookSource(source.file || new Blob([source.html], {type:'text/html;charset=utf-8'}), tab.reader.metadata) : tab.reader.html();
  if(handle){const disk=await handle.getFile();await writeExternalHTML({fileHandle:handle,diskStamp:{modified:disk.lastModified,size:disk.size}},html);}
  else download(html,htmlExportName(tab.record.name));
  toast('현재 주석을 포함한 HTML을 내보냈습니다. 이후 주석은 앱에 자동 저장됩니다.');
}

function webContext(){return active()?.type==='browser'?active():tabs.includes(lastWebTab)?lastWebTab:null;}
function externalURL(url){return new URL(url).origin!==location.origin;}
function focusBrowserTab(tab){
  const state=browserTabs.open(tab.id,tab.url);lastWebTab=tab;tab.browserState=state;tab.away=state==='opened'||state==='focused';tab.returned=false;
  renderBrowserState(tab);return state;
}
function resumeBrowser(){
  if(document.hidden||!lastWebTab?.away||!tabs.includes(lastWebTab))return;
  lastWebTab.away=false;lastWebTab.returned=true;renderBrowserState(lastWebTab);
  if(reader())toast('읽던 문서로 돌아왔습니다. 복사한 글은 메뉴 → 텍스트 붙여넣기로 가져오세요.');
}
function renderExternalTab(tab){
  const search=isWebSearch(tab.url);
  tab.host.innerHTML=`<div class="browser-handoff"><div class="handoff-heading">${icon('external',32)}<p class="eyebrow">CHROME · HTMLMEMO</p><h2>${search?'검색은 Chrome에서, 메모는 여기서.':'웹 탐색은 Chrome에서, 주석은 여기서.'}</h2><p>외부 사이트는 이 앱을 연 브라우저의 일반 탭에서 엽니다.<br>웹 페이지를 하나의 파일로 저장한 다음, HTMLMemo에서 열면 됩니다.</p></div><p class="web-notice" data-web-status role="status"></p><div class="web-actions"><button class="primary-button" data-browser-focus>브라우저로 전환 ${icon('external',15)}</button><button class="secondary-button" data-browser-paste>글 붙여넣고 주석 달기</button><button class="secondary-button" data-browser-import>HTML 파일 가져오기</button></div><p class="handoff-return">Chrome 탭에서 필요한 글을 복사한 뒤 HTMLMemo 탭으로 돌아오세요.<br>읽던 문서와 주석은 그대로 유지됩니다. <kbd>Ctrl/⌘ Shift V</kbd>로 붙여넣기 창을 바로 열 수 있습니다.</p><details class="handoff-details"><summary>보낸 주소 · 직접 가져오기</summary><a data-open-external href="${esc(tab.url)}" target="_blank" rel="noopener noreferrer">${esc(tab.url)} ${icon('external',13)}</a><p>이 주소는 HTMLMemo에서 마지막으로 보낸 주소입니다. Chrome에서 이동한 현재 주소는 읽지 않습니다. 검색 결과의 글을 가져올 때는 붙여넣기 창에 실제 원문 주소를 넣으세요.</p><button class="secondary-button" data-capture${search?' disabled':''}>이 주소에서 직접 저장</button><p>검색 페이지는 직접 저장하지 않습니다. 일반 페이지도 사이트가 읽기를 허용할 때만 저장됩니다.</p></details></div>`;
  $('[data-browser-focus]',tab.host).onclick=()=>focusBrowserTab(tab);
  $('[data-browser-paste]',tab.host).onclick=()=>pasteTextDialog(tab);
  $('[data-browser-import]',tab.host).onclick=safely(importFiles);
  $('[data-capture]',tab.host).onclick=safely(()=>capturePage(tab));
}
async function openBrowser(input,forceNew=true){
  if(/^file:/i.test(input.trim())){await importFiles();return;}
  const url=normalizeURL(input),current=active(),external=externalURL(url);
  const existing=tabs.find(tab=>tab.type==='browser'&&tab.url===url);
  if(existing){if(!current?.reader)activate(existing.id);else renderTabs();if(existing.external)focusBrowserTab(existing);return existing;}
  if(!forceNew&&current?.type==='browser'&&current.external===external){await navigate(current,url);return current;}
  const tab={id:uid(),type:'browser',title:isWebSearch(url)?'웹 검색':displayHost(url),url,history:[url],cursor:0,readable:false,loading:!external,external};
  tab.host=createHost(tab.id,'browser');tabs.push(tab);
  if(external){
    renderExternalTab(tab);if(!current?.reader)activate(tab.id);else{renderTabs();updateChrome();}
    focusBrowserTab(tab);return tab;
  }
  tab.host.innerHTML=`<div class="browser-note"><span>${icon('globe',15)} 앱 문서 미리보기</span><a class="text-button" data-open-external href="${esc(url)}" target="_blank" rel="noopener noreferrer">새 탭에서 열기 ${icon('external',13)}</a><button class="text-button" data-capture>페이지 저장 ${icon('save',13)}</button><button class="text-button" data-web-help>가져오기 안내</button></div><div class="web-status" data-web-status role="status"></div><iframe class="browser-frame" title="앱 문서 미리보기" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads" referrerpolicy="no-referrer"></iframe>`;
  tab.frame=$('iframe',tab.host);
  tab.frame.addEventListener('load',()=>{
    tab.loading=false;const doc=browserDocument(tab);tab.readable=!!doc;
    if(doc){
      tab.title=doc.title||displayHost(tab.url);
      const next=doc.location.href;if(next!==tab.url){tab.url=next;tab.history.splice(tab.cursor+1);tab.history.push(next);tab.cursor++;}
      tab.boundDocs ||= new WeakSet();
      if(!tab.boundDocs.has(doc)){
        tab.boundDocs.add(doc);
        doc.addEventListener('click',event=>{
          if(event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
          const link=event.target.closest?.('a[href]');
          if(link&&/^https?:/.test(link.href)){event.preventDefault();safely(()=>link.target==='_blank'||externalURL(link.href)?openBrowser(link.href):navigate(tab,link.href))();}
        });
      }
    }
    renderBrowserState(tab);renderTabs();if(active()===tab)updateChrome();
  });
  $('[data-capture]',tab.host).onclick=safely(()=>capturePage(tab));
  $('[data-web-help]',tab.host).onclick=()=>webHelpDialog(tab);
  activate(tab.id);renderBrowserState(tab);tab.frame.src=url;return tab;
}
function browserDocument(tab){
  if(tab.external||tab.loading)return null;
  try{const doc=tab.frame?.contentDocument;return doc?.documentElement&&/^https?:/.test(doc.location?.href||'')?doc:null;}catch{return null;}
}
function renderBrowserState(tab){
  const status=$('[data-web-status]',tab.host),capture=$('[data-capture]',tab.host);if(!status)return;
  if(tab.external){
    const unavailable=tab.browserState==='blocked'||tab.browserState==='unavailable';
    status.textContent=unavailable?'탭 열기 또는 전환이 제한됐습니다. 아래 「보낸 주소」의 링크를 눌러 직접 여세요.':tab.returned?'복사한 글을 붙여넣거나 저장한 HTML을 가져오세요.':'브라우저 탭으로 보냈습니다.';
    $('[data-browser-focus]',tab.host).textContent=browserTabs.available(tab.id)?'브라우저로 전환':'브라우저에서 다시 열기';
    capture.disabled=!!tab.capturing||isWebSearch(tab.url);
    return;
  }
  status.textContent=tab.capturing?'읽기용 사본을 준비하는 중…':tab.readable?'이 페이지는 앱에서 저장할 수 있습니다. 페이지 저장 후 바로 주석을 남기세요.':'앱 문서를 준비하는 중입니다. 외부 사이트는 브라우저 탭에서 엽니다.';
  capture.disabled=!!tab.capturing;$('[data-open-external]',tab.host).href=tab.url;
}
async function navigate(tab,url){
  if(tab.capturing){toast('가져오기가 끝난 뒤 주소를 이동해주세요.');return;}
  url=normalizeURL(url);if(externalURL(url)!==tab.external)return openBrowser(url);
  tab.url=url;tab.title=isWebSearch(url)?'웹 검색':displayHost(url);tab.history.splice(tab.cursor+1);tab.history.push(url);tab.cursor++;
  if(tab.external){renderExternalTab(tab);renderTabs();updateChrome();focusBrowserTab(tab);return;}
  tab.readable=false;tab.loading=true;tab.frame.src=url;renderBrowserState(tab);renderTabs();updateChrome();
}
async function browserHistory(direction){
  const tab=active();if(!tab)return;
  if(tab.reader){if(direction<0)await tab.reader.back();updateChrome();return;}
  if(tab.external||tab.capturing)return;
  const next=tab.cursor+direction;if(next<0||next>=tab.history.length)return;
  tab.cursor=next;tab.url=tab.history[next];tab.readable=false;tab.loading=true;tab.frame.src=tab.url;renderBrowserState(tab);updateChrome();
}
function toolbarButton(action,name,label,extra='') {return `<button class="tool-button" data-action="${action}" aria-label="${label}" title="${label}" ${extra}>${icon(name,18)}</button>`;}
function annotationToolFamily(tool) {return {area:'highlight','area-underline':'underline',text:'note'}[tool]||tool;}
function annotationToolModes(group) {
  return {
    highlight:{title:'형광펜',key:'H',modes:[['highlight','highlight','글자 형광펜','선택한 글자를 따라 표시'],['area','area','영역 형광펜','원하는 영역을 드래그해 표시']]},
    underline:{title:'밑줄',key:'U',modes:[['underline','underline','글자 밑줄','선택한 글자를 따라 표시'],['area-underline','area-underline','영역 밑줄','원하는 위치에 직접 그리기']]},
    note:{title:'메모 · 텍스트',key:'N',modes:[['note','note','메모 상자','상자 안에 메모 쓰기'],['text','text','자유 텍스트','배경 상자 없이 글자만 쓰기']]},
    eraser:{title:'지우개',key:'E',modes:[['eraser','eraser','개별 주석 지우기','지울 주석을 직접 선택'],['clear','trash','주석 모두 지우기','확인한 뒤 전체 삭제 · 실행 취소 가능',true]]},
  }[group];
}
function showAnnotationToolModes(group, keyboard = false) {
  const r=reader(),definition=annotationToolModes(group);if(!r||!definition)return;
  const current=annotationToolFamily(r.tool)===group?r.tool:r.toolChoices?.[group]||group;
  showPopover('tool-mode-'+group,`<div class="popover-heading"><h3>${definition.title} 방식</h3><button type="button" class="icon-button popover-close" data-popover-close aria-label="${definition.title} 방식 닫기">${icon('close',16)}</button></div><div class="annotation-tool-modes" role="menu" aria-label="${definition.title} 방식">${definition.modes.map(([id,name,label,hint,command])=>`<button type="button" class="menu-button${command?' danger':''}" role="${command?'menuitem':'menuitemradio'}" data-tool-mode="${id}" ${command?`data-tool-command${!r.metadata.annotations.length?' disabled':''}`:`aria-checked="${id===current}"`}>${icon(name,18)}<span><strong>${label}</strong><small>${hint}</small></span>${!command&&id===current?icon('check',14):''}</button>`).join('')}</div>`,()=>{
    const pop=$('#tool-popover'),trigger=$(`[data-action="${group}"]`,$('#toolbar'));
    trigger?.setAttribute('aria-expanded','true');
    $$('[data-tool-mode]',pop).forEach(button=>button.onclick=()=>toolAction(button.dataset.toolMode));
    pop.onkeydown=event=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closePopover();trigger?.focus();return;}
      if(event.key==='Tab'){closePopover();return;}
      if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
      event.preventDefault();event.stopPropagation();const items=$$('[data-tool-mode]',pop).filter(item=>!item.disabled),at=items.indexOf(document.activeElement);
      items[event.key==='Home'?0:event.key==='End'?items.length-1:(at+(event.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();
    };
    if(keyboard)($('[aria-checked=true]',pop)||$('[data-tool-mode]',pop))?.focus();
  });
}
function renderToolbar() {
  const r=reader();if(!r||!r.doc)return;
  $('#toolbar').hidden=false;
  $('#toolbar').innerHTML=`<button class="toolbar-grip" aria-label="툴바 이동">${icon('grip',14)}</button><span class="tool-group">${toolbarButton('select','select','선택 / 읽기 (V)')}${toolbarButton('pen','pen','펜 (P)')}${toolbarButton('highlight','highlight','형광펜 (H)')}${toolbarButton('underline','underline','밑줄 (U)')}${toolbarButton('eraser','eraser','지우개 (E)')}${toolbarButton('note','note','메모 (N)')}</span><span class="toolbar-divider"></span>${toolbarButton('palette','palette','색상 · 굵기 · 투명도 설정','class="tool-button palette-button"')}<span class="tool-group toolbar-history">${toolbarButton('undo','undo','실행 취소 (Ctrl/⌘ Z)')}${toolbarButton('redo','redo','다시 실행 (Ctrl/⌘ Shift Z)')}</span><span class="toolbar-divider"></span>${toolbarButton('more','more','더 많은 도구')}`;
  $$('[data-action]',$('#toolbar')).forEach(button=>{
    const action=button.dataset.action,modes=annotationToolModes(action);
    button.onpointerdown=e=>{const selection=action==='note'?r.doc.getSelection?.():null;if(e.pointerType==='mouse'||(selection?.rangeCount&&!selection.isCollapsed))e.preventDefault();};
    button.onclick=()=>{
      // A fresh text selection must still be annotated on every click, even when
      // this tool (or its area variant) was already selected. Options remain on ↓.
      const selection=action==='note'?r.doc.getSelection?.():null;
      if(selection?.rangeCount&&!selection.isCollapsed)return toolAction(action);
      if(['highlight','underline'].includes(action)&&r.selection?.quote?.trim())return toolAction(action);
      if(modes&&annotationToolFamily(r.tool)===action)return showAnnotationToolModes(action);
      return toolAction(modes?(r.toolChoices?.[action]||action):action);
    };
    if(modes){
      button.classList.add('tool-has-modes');button.setAttribute('aria-haspopup','menu');button.setAttribute('aria-expanded','false');
      button.onkeydown=event=>{if(event.key==='ArrowDown'){event.preventDefault();event.stopPropagation();showAnnotationToolModes(action,true);}};
      button.oncontextmenu=event=>{event.preventDefault();showAnnotationToolModes(action);};
    }
  });
  bindToolbarDrag();updateToolbarState();
  applyToolbarPosition();
}
function updateToolbarState() {
  const r=reader();if(!r)return;
  $$('[data-action]',$('#toolbar')).forEach(button=>{
    const action=button.dataset.action,selected=action===annotationToolFamily(r.tool);button.classList.toggle('active',selected);
    if(['select','pen','highlight','underline','eraser','note'].includes(action))button.setAttribute('aria-pressed',String(selected));
    const definition=annotationToolModes(action);
    if(definition){
      const mode=definition.modes.find(([id])=>id===(selected?r.tool:r.toolChoices?.[action]))||definition.modes[0];
      button.innerHTML=icon(mode[1],18);button.title=`${definition.title}: ${mode[2]} (${definition.key}) · 다시 누르거나 ↓ 키로 방식 선택`;
      button.setAttribute('aria-label',button.title);
    }
  });
  const undo=$('[data-action="undo"]',$('#toolbar'));if(undo)undo.disabled=!r.history.canUndo;
  const redo=$('[data-action="redo"]',$('#toolbar'));if(redo)redo.disabled=!r.history.canRedo;
  r.updateReadingControls?.();
  const palette=$('[data-action="palette"]',$('#toolbar'));if(palette)palette.style.setProperty('--tool-color',r.color);
}
function closePopover() {popoverName='';$('#tool-popover').cancelPaletteDrag?.();$('#tool-popover').hidden=true;$('#tool-popover').onkeydown=null;$$('.tool-has-modes',$('#toolbar')).forEach(button=>button.setAttribute('aria-expanded','false'));}
function positionPopover() {
  const pop=$('#tool-popover');
  if(pop.classList.contains('palette-popover')&&pop.palettePosition){placePalettePopover(pop,pop.palettePosition);return;}
  if(pop.readingAnchor?.isConnected&&popoverName==='zoom'){
    const button=pop.readingAnchor,rect=button.getBoundingClientRect();let right=rect.right,top=rect.top,bottom=rect.bottom;
    if(button.ownerDocument!==document){
      const frame=reader()?.frame;if(!frame)return;
      const bounds=frame.getBoundingClientRect(),scale=bounds.width/frame.offsetWidth;
      right=bounds.left+right*scale;top=bounds.top+top*scale;bottom=bounds.top+bottom*scale;
    }
    pop.style.left=Math.max(10,Math.min(innerWidth-pop.offsetWidth-10,right-pop.offsetWidth))+'px';
    pop.style.top=Math.max(8,Math.min(innerHeight-pop.offsetHeight-8,bottom+6+pop.offsetHeight<=innerHeight-8?bottom+6:top-pop.offsetHeight-6))+'px';
    return;
  }
  const bar=$('#toolbar').getBoundingClientRect();pop.style.left=Math.max(10,Math.min(innerWidth-pop.offsetWidth-10,bar.left+bar.width-pop.offsetWidth))+'px';
  const above=bar.top-pop.offsetHeight-10;pop.style.top=(above>8?above:Math.min(innerHeight-pop.offsetHeight-8,bar.bottom+10))+'px';
}
function placePalettePopover(pop,position) {
  const {width,height}=pop.getBoundingClientRect();
  const x=Math.max(10,Math.min(Math.max(10,innerWidth-width-10),position.x));
  const y=Math.max(8,Math.min(Math.max(8,innerHeight-height-8),position.y));
  pop.palettePosition={x,y};pop.style.left=x+'px';pop.style.top=y+'px';
}
function bindPaletteDrag(pop) {
  if(pop.paletteDragBound)return;pop.paletteDragBound=true;
  let drag=null;
  const finish=event=>{
    if(!drag||(event&&event.pointerId!==drag.id))return;
    const id=drag.id;drag=null;pop.classList.remove('palette-dragging');
    try{if(pop.hasPointerCapture?.(id))pop.releasePointerCapture(id);}catch{/* The browser may already have released capture. */}
  };
  pop.cancelPaletteDrag=()=>finish();
  pop.addEventListener('pointerdown',event=>{
    if(drag||pop.hidden||!pop.classList.contains('palette-popover')||!event.target.closest('[data-palette-drag]')||event.target.closest('button,input,select,textarea,a')||event.button!==0||event.isPrimary===false)return;
    event.preventDefault();const rect=pop.getBoundingClientRect();drag={id:event.pointerId,x:event.clientX,y:event.clientY,left:rect.left,top:rect.top};
    pop.classList.add('palette-dragging');try{pop.setPointerCapture(event.pointerId);}catch{/* Keep pointer handling within the panel if capture is unavailable. */}
  });
  pop.addEventListener('pointermove',event=>{
    if(!drag||event.pointerId!==drag.id)return;
    placePalettePopover(pop,{x:drag.left+event.clientX-drag.x,y:drag.top+event.clientY-drag.y});
  });
  for(const type of ['pointerup','pointercancel','lostpointercapture'])pop.addEventListener(type,finish);
  pop.addEventListener('keydown',event=>{
    if(!event.target.matches('[data-palette-drag]')||!pop.classList.contains('palette-popover')||event.ctrlKey||event.metaKey||event.altKey)return;
    const direction={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];if(!direction)return;
    event.preventDefault();event.stopPropagation();const rect=pop.getBoundingClientRect(),step=event.shiftKey?40:10;
    placePalettePopover(pop,{x:rect.left+direction[0]*step,y:rect.top+direction[1]*step});
  });
}
function showPopover(name,html,bind=()=>{},readingAnchor=null) {
  if(popoverName===name){closePopover();return;}
  $('#tool-popover').cancelPaletteDrag?.();
  $('#tool-popover').onkeydown=null;$$('.tool-has-modes',$('#toolbar')).forEach(button=>button.setAttribute('aria-expanded','false'));
  $('#tool-popover').removeAttribute('aria-label');$('#tool-popover').removeAttribute('role');
  if(name==='zoom'){$('#tool-popover').setAttribute('role','dialog');$('#tool-popover').setAttribute('aria-label','확대 · 축소');}
  // A notice must not sit over the menu it just made room for; errors stay until they time out.
  if(!$('#toast').classList.contains('error'))$('#toast').hidden=true;
  popoverName=name;$('#tool-popover').readingAnchor=readingAnchor;$('#tool-popover').classList.toggle('selection',name==='selection');$('#tool-popover').classList.toggle('palette-popover',name==='palette');$('#tool-popover').innerHTML=html;$('#tool-popover').hidden=false;positionPopover();
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
  pop.cancelPaletteDrag?.();
  const activePalette = getActivePalette();
  const customPalettes = preferences.annotation.customPalettes || [];
  const isCustomPalette = customPalettes.some(p => p.id === activePalette.id);
  const customColors = preferences.annotation.customColors || [];
  const currentColor = (r.color || '#edcf67').toLowerCase();
  let pickerHsv = hexToHsv(currentColor);
  const rgb = hexToRgb(currentColor);
  pop.innerHTML = `<div class="popover-heading" data-palette-drag tabindex="0" role="group" aria-label="펜과 색상 창 이동" title="드래그하여 이동 · 방향키로 이동 (Shift: 크게)"><h3>펜과 색상</h3><button type="button" class="icon-button popover-close" data-popover-close aria-label="펜과 색상 닫기" title="닫기">${icon('close',16)}</button></div>`
    + `<label class="range-label">굵기 <output id="width-output">${r.width}px</output><input id="pen-width" type="range" min="1" max="18" value="${r.width}"></label><label class="range-label">형광펜 투명도 <output id="opacity-output">${Math.round(r.opacity*100)}%</output><input id="pen-opacity" type="range" min="10" max="90" value="${Math.round(r.opacity*100)}"></label><label class="select-label">펜 표시 시간 <select id="pen-ttl"><option value="0">영구 저장</option><option value="3">3초</option><option value="10">10초</option><option value="30">30초</option></select></label><p class="popover-hint">시간을 정한 펜은 잠깐 표시되고 저장되지 않아요.</p>`
    + `<div class="palette-section"><div class="palette-bar"><span class="palette-label">팔레트 프리셋</span><div class="palette-actions"><select id="palette-preset" aria-label="팔레트 프리셋"><optgroup label="프리셋 팔레트 (20개)">${PRESET_PALETTES.map((p, idx) => `<option value="${esc(p.id)}" ${p.id === activePalette.id ? 'selected' : ''}>${idx + 1}. ${esc(p.name)} (${p.colors.length})</option>`).join('')}</optgroup>${customPalettes.length ? `<optgroup label="사용자 팔레트 (${customPalettes.length}개)">${customPalettes.map(p => `<option value="${esc(p.id)}" ${p.id === activePalette.id ? 'selected' : ''}>★ ${esc(p.name)} (${p.colors.length})</option>`).join('')}</optgroup>` : ''}</select>${isCustomPalette ? `<button type="button" id="delete-custom-palette" class="palette-mini-btn danger" title="선택한 사용자 팔레트 삭제" aria-label="사용자 팔레트 삭제">삭제</button>` : ''}</div></div><div id="preset-swatches" class="swatches preset-swatches">${activePalette.colors.map(c => `<button type="button" data-color="${c}" style="--swatch:${c}" title="${c}" aria-label="색상 ${c}" class="swatch ${currentColor === c ? 'chosen' : ''}"></button>`).join('')}</div></div>`
    + `<div class="palette-section"><div class="palette-bar"><span class="palette-label">사용자 색상 (${customColors.length})</span><div class="palette-actions"><button type="button" id="add-custom-color" class="palette-mini-btn" title="현재 색상을 사용자 색상에 추가">+ 색상 추가</button><button type="button" id="remove-custom-color" class="palette-mini-btn" ${customColors.includes(currentColor) ? '' : 'disabled'} title="선택한 사용자 색상 삭제">− 삭제</button></div></div><div id="custom-swatches" class="swatches custom-swatches">${customColors.length ? customColors.map(c => `<button type="button" data-color="${c}" data-custom-swatch="${c}" style="--swatch:${c}" title="사용자 색상 ${c}" aria-label="사용자 색상 ${c}" class="swatch custom-swatch ${currentColor === c ? 'chosen' : ''}"></button>`).join('') : '<span class="palette-empty">색상을 고른 뒤 「+ 색상 추가」를 눌러 저장하세요.</span>'}</div><div class="custom-palette-creator"><input id="custom-palette-name" type="text" maxlength="40" placeholder="새 팔레트 이름 (예: 내 필기 세트)" aria-label="새 팔레트 이름"><button type="button" id="save-custom-palette" class="palette-mini-btn primary">+ 팔레트 저장</button></div></div>`
    + `<div class="palette-section color-picker-section"><div class="palette-bar"><span class="palette-label">컬러 피커</span><span class="color-preview-badge"><i id="color-preview-chip" style="background:${currentColor}"></i><code id="color-preview-text">${currentColor.toUpperCase()}</code></span></div><div id="color-picker-sv" class="color-picker-sv" style="--picker-hue:${pickerHsv.h}" role="slider" tabindex="0" aria-label="채도 및 명도 선택"><span id="color-picker-sv-thumb" class="color-picker-sv-thumb" style="left:${pickerHsv.s}%;top:${100 - pickerHsv.v}%"></span></div><div class="color-picker-hue-row"><input id="color-picker-hue" class="color-picker-hue" type="range" min="0" max="360" value="${pickerHsv.h}" aria-label="색상 (Hue)"><input type="color" id="custom-color" value="${currentColor}" title="시스템 색상 선택기" aria-label="사용자 색상"></div><div class="color-picker-inputs"><label class="color-input-field hex-field"><span>HEX</span><input id="color-hex" type="text" maxlength="7" value="${currentColor.toUpperCase()}" aria-label="HEX 색상 코드"></label><label class="color-input-field"><span>R</span><input id="color-r" type="number" min="0" max="255" value="${rgb.r}" aria-label="R (빨강)"></label><label class="color-input-field"><span>G</span><input id="color-g" type="number" min="0" max="255" value="${rgb.g}" aria-label="G (초록)"></label><label class="color-input-field"><span>B</span><input id="color-b" type="number" min="0" max="255" value="${rgb.b}" aria-label="B (파랑)"></label></div></div>`;
  positionPopover();bindPaletteDrag(pop);
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
  showPopover('selection',`${[['speak','읽어주기'],['webSearch','웹 검색']].map(([a,l]) => `<button data-selection="${a}">${l}</button>`).join('')}`,()=>{
    const pop=$('#tool-popover');pop.setAttribute('role','dialog');pop.setAttribute('aria-label','선택한 텍스트');
    $$('[data-selection]',pop).forEach(button=>{
      button.onpointerdown=e=>e.preventDefault();
      button.onclick=safely(async()=>{
        const action=button.dataset.selection;
        if(action==='speak'){r.selection=anchor;if(!r.speakSelection())return;}
        else if(action==='webSearch')await openBrowser('https://www.google.com/search?q='+encodeURIComponent(anchor.quote.slice(0,2000)));
        closePopover();
      });
    });
  });
}
function toolAction(action,button=null) {
  const r=reader();if(!r)return;
  if(action==='speak'){closePopover();r.toggleReadAloud();return;}
  if(action==='note'){const anchor=r.captureTextSelection?.();if(anchor?.quote?.trim()){closePopover();return safely(()=>r.addSelectionNote(anchor))();}}
  if(['select','pen','highlight','underline','eraser','note','text','rect','ellipse','arrow','area','area-underline','strike'].includes(action)){
    if(['highlight','area','underline','area-underline','note','text'].includes(action)){r.toolChoices||={};r.toolChoices[annotationToolFamily(action)]=action;}
    closePopover();r.setTool(action);updateToolbarState();return;
  }
  if(action==='undo'){r.undo();return;}if(action==='redo'){r.redo();return;}
  if(action==='palette') {
    showPopover('palette', '', () => renderPalettePopoverContent(r));
    return;
  }
  if(action==='zoom') {showPopover('zoom',`<div class="popover-heading"><h3>확대 · 축소</h3><button type="button" class="icon-button popover-close" data-popover-close aria-label="확대 · 축소 닫기" title="닫기">${icon('close',16)}</button></div><div class="zoom-controls"><button class="secondary-button" id="zoom-out">${icon('minus')}</button><input id="zoom-value" type="number" min="20" max="800" value="${Math.round(r.zoom*100)}" aria-label="확대 비율"><span>%</span><button class="secondary-button" id="zoom-in">${icon('plus')}</button></div><button id="zoom-fit" class="menu-button">화면 너비에 맞추기</button><button id="zoom-reset" class="menu-button">100% 원래 크기</button>`,()=>{
    $('#zoom-out').onclick=()=>r.setZoom(r.zoom/1.2);$('#zoom-in').onclick=()=>r.setZoom(r.zoom*1.2);$('#zoom-value').onchange=e=>r.setZoom(Number(e.target.value)/100);$('#zoom-fit').onclick=()=>{r.setZoom(1,true);closePopover();};$('#zoom-reset').onclick=()=>{r.setZoom(1);closePopover();};
  },button||r.zoomControl);return;}
  if(action==='more') {
    const items=[['rect','rect','사각형'],['ellipse','ellipse','타원'],['arrow','arrow','화살표'],['strike','strike','취소선'],['history','history','주석 저장 이력'],['migrate','file-transfer','새 판으로 주석 옮기기'],['info','info','문서 정보']];
    // Books already expose their three sidebar views. Plain HTML needs only a
    // way to reopen its closed panel, not a second copy of every sidebar tab.
    if(!r.documentSidebarUI?.isConnected && $('#sidebar').hidden)items.unshift(['sidebar','list','사이드바 열기']);
    showPopover('more',`<div class="popover-heading"><h3>문서 도구</h3><button class="icon-button popover-close" data-popover-close aria-label="문서 도구 닫기" title="닫기">${icon('close',16)}</button></div><div class="more-grid">${items.map(([id,name,label])=>`<button class="menu-button" data-more="${id}">${icon(name,16)}<span>${label}</span></button>`).join('')}</div>`,()=>{
      $('[data-popover-close]',$('#tool-popover')).onclick=closePopover;
      $$('[data-more]',$('#tool-popover')).forEach(button=>button.onclick=safely(()=>{const id=button.dataset.more;closePopover();return toolAction(id);}));
    });return;
  }
  if(action==='sidebar'){closePopover();if(r.documentSidebarUI?.isConnected)r.showDocumentSidebarView('outline');else renderSidebar(r.appSidebarMode||'search');return;}
  if(['search','outline','annotations','bookmarks'].includes(action)){closePopover();if(r.documentSidebarUI?.isConnected)r.showDocumentSidebarView(action);else renderSidebar(action);return;}
  if(action==='connect')return safely(()=>exportDocument(active()))();
  if(action==='history')return safely(()=>annotationHistory(active()))();
  if(action==='migrate')return safely(()=>migrateEdition(active()))();
  if(action==='info')return documentInfo(active());
  if(action==='bookmark')return safely(async()=>{const title=await promptText('text','읽던 위치');if(title){r.addBookmark(title);if(reader()===r){if(r.documentSidebarUI?.isConnected&&r.documentSidebarMode==='bookmarks')r.showDocumentSidebarView('bookmarks');else if(sidebarMode==='bookmarks')renderSidebar('bookmarks');}toast('북마크를 저장했습니다.');}})();
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
function closeSidebar({remember=true,clearSearch=true}={}) {
  const panel=$('#sidebar'),wasOpen=!panel.hidden,r=panel.annotationReader;
  clearTimeout(panel.sidebarSearchTimer);panel.sidebarMode='';sidebarMode='';panel.hidden=true;$('#workspace')?.removeAttribute('data-app-sidebar');
  if(wasOpen&&r){if(remember)r.appSidebarClosed=true;if(clearSearch&&r.documentSidebarMode!=='search'){r.sidebarSearchQuery='';r.search('');}}
}
function restoreSidebar() {
  const r=reader();
  if(!r?.doc||r.preparing||r.disposed||readerFocused||r.documentSidebarUI?.isConnected||r.appSidebarClosed)return;
  renderSidebar(r.appSidebarMode||'search',{focusSearch:false});
}
function updateSearchNavigation(r) {
  for(const panel of [$('#sidebar'),r.documentSidebarUI]){
    if(!panel?.isConnected||panel.annotationReader!==r||panel.sidebarMode!=='search')continue;
    const prefix=panel.hasAttribute('data-htmlmemo-doc-sidebar-ui')?'htmlmemo-native-':'',q=name=>$('#'+prefix+name,panel),total=r.searchResults?.length||0,position=r.searchPosition??-1;
    const count=q('search-count');if(!count||q('document-search')?.value!==r.searchQuery)continue;
    count.textContent=!r.searchQuery?.trim()?'검색어를 입력하세요.':total?`${position>=0?`${position+1} / `:''}${total}${total===3000?'+':''}개 결과`:'검색 결과가 없습니다.';
    q('search-prev').disabled=!total||position<=0;q('search-next').disabled=total<=1||position>=total-1;
  }
}
function updateSidebarCounts(panel,r) {
  if(!panel||!r||panel.annotationReader!==r)return;
  for(const view of ['annotations','bookmarks']){
    const button=$(`[data-sidebar-view="${view}"]`,panel),count=$(`[data-sidebar-count="${view}"]`,panel),label=view==='annotations'?'주석':'북마크';
    const total=r.metadata[view].length;if(count)count.textContent=String(total);
    if(button){button.title=`${label} · 전체 ${total}개`;button.setAttribute('aria-label',button.title);}
  }
}
function styleNativeSidebar(panel) {
  const doc=panel.ownerDocument;
  if(!doc.getElementById('htmlmemo-doc-sidebar-style')){
    // Reuse only the namespaced rules from the locally compiled Tailwind asset.
    const rules=[];
    for(const sheet of document.styleSheets||[]){try{for(const rule of sheet.cssRules||[]){if(!rule.selectorText)continue;const selectors=rule.selectorText.split(',').filter(selector=>selector.includes('[data-htmlmemo-doc-sidebar-ui]')||selector.includes('[data-htmlmemo-native-sidebar]'));if(selectors.length)rules.push(selectors.join(',')+'{'+rule.style.cssText+'}');}}catch{/* App-owned same-origin stylesheets provide these rules. */}}
    const style=doc.createElement('style');style.id='htmlmemo-doc-sidebar-style';style.setAttribute('data-htmlmemo-ui','');style.textContent=rules.join('\n')+'\n::highlight(htmlmemo-book-search){background:#f0a85b80;color:inherit}';doc.head.append(style);
  }
  const theme=getComputedStyle(document.documentElement);
  for(const name of ['--bg','--surface','--surface-muted','--text','--muted','--line','--green','--green-light','--app-font'])panel.style.setProperty(name,theme.getPropertyValue(name));
}
function renderSidebar(mode,{panel=$('#sidebar'),embedded=false,documentReader=reader(),focusSearch=true}={}) {
  const r=documentReader;if(!r)return;
  const outline=embedded?[]:r.outline();
  if(!embedded&&mode==='outline'&&!outline.length)mode='search';
  if(embedded&&$('#sidebar').annotationReader===r)closeSidebar({remember:false,clearSearch:false});
  r.annotationTreeOpen ||= new Map();
  if(panel.annotationReader===r)$$('[data-annotation-group]',panel).forEach(group=>r.annotationTreeOpen.set(group.dataset.annotationGroup,!!(group.open||group.hasAttribute('open'))));
  panel.annotationReader=r;
  clearTimeout(panel.sidebarSearchTimer);panel.sidebarMode=mode;if(!embedded){sidebarMode=mode;r.appSidebarMode=mode;r.appSidebarClosed=false;$('#workspace')?.setAttribute('data-app-sidebar','');closePopover();}else styleNativeSidebar(panel);panel.hidden=false;
  const id=name=>(embedded?'htmlmemo-native-':'')+name,q=name=>$('#'+id(name),panel);
  const title={search:'검색',outline:'목차',annotations:'주석',bookmarks:'북마크'}[mode];
  if(!$('.sidebar-views',panel)){
    const views=[['outline','list','목차'],['search','search','검색'],['annotations','note','주석'],['bookmarks','bookmark','북마크']];
    panel.innerHTML=`<h2 id="${id('sidebar-title')}" hidden></h2><div class="sidebar-views" role="group" aria-label="사이드바 보기">${views.map(([view,name,label])=>`<button type="button" data-sidebar-view="${view}" title="${label}" aria-label="${label}" aria-pressed="false" aria-controls="${id('sidebar-content')}">${icon(name,14)}${['annotations','bookmarks'].includes(view)?`<span class="sidebar-nav-count" data-sidebar-count="${view}" aria-hidden="true"></span>`:''}</button>`).join('')}${embedded?'':`<button type="button" class="icon-button" id="close-sidebar" title="패널 닫기" aria-label="패널 닫기">${icon('close',14)}</button>`}</div><div id="${id('sidebar-content')}" class="sidebar-content" role="region" aria-labelledby="${id('sidebar-title')}"></div>`;
    if(!embedded)q('close-sidebar').onclick=()=>closeSidebar();
    $$('[data-sidebar-view]',panel).forEach(button=>button.onclick=()=>{
      const view=button.dataset.sidebarView;
      // Only an explicit re-click collapses the TOC, never a view change or restore.
      if(view==='outline'&&panel.sidebarMode==='outline'){panel.annotationReader?.collapseDocumentToc?.();return;}
      return embedded?panel.annotationReader.showDocumentSidebarView(view):renderSidebar(view);
    });
  }
  q('sidebar-title').textContent=embedded&&mode==='outline'?'목차':title;panel.setAttribute('aria-labelledby',id('sidebar-title'));
  $('[data-sidebar-view="outline"]',panel).hidden=!embedded&&!outline.length;
  $$('[data-sidebar-view]',panel).forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.sidebarView===mode)));
  updateSidebarCounts(panel,r);
  const content=$('.sidebar-content',panel);content.hidden=false;
  if(mode==='search'){
    content.innerHTML=`<div class="search-field"><input id="${id('document-search')}" aria-label="불러온 부분 검색어" placeholder="불러온 부분에서 찾기" autocomplete="off"></div><div class="search-navigation loaded-search-navigation"><span id="${id('search-count')}" role="status" aria-live="polite">검색어를 입력하세요.</span><button id="${id('search-prev')}" class="icon-button" aria-label="이전 검색 결과" disabled>${icon('back')}</button><button id="${id('search-next')}" class="icon-button" aria-label="다음 검색 결과" disabled>${icon('forward')}</button></div><div id="${id('search-results')}"></div>`;
    const input=q('document-search');input.value=r.sidebarSearchQuery??r.searchQuery??'';
    const run=(resume=false)=>{
      const query=input.value,current=()=>panel.sidebarMode==='search'&&panel.annotationReader===r&&reader()===r&&input.isConnected&&input.value===query;if(!current())return;
      const show=results=>{if(!current()||!results)return;updateSearchNavigation(r);q('search-results').innerHTML=results.slice(0,150).map((result,index)=>`<button class="search-result" data-search-index="${index}">${esc(result.quote)}</button>`).join('');$$('[data-search-index]',panel).forEach(button=>button.onclick=()=>{r.searchPosition=Number(button.dataset.searchIndex)-1;r.nextSearch(1);updateSearchNavigation(r);});};
      const results=resume&&r.searchQuery===query?r.searchResults:r.searchAsync?r.searchAsync(query,!resume,current):r.search(query,!resume);
      if(results?.then){q('search-count').textContent='검색 준비 중…';q('search-prev').disabled=true;q('search-next').disabled=true;q('search-results').replaceChildren();results.then(show).catch(error=>{if(current()){q('search-count').textContent='검색을 준비하지 못했습니다. 다시 검색해 주세요.';r.callbacks?.onError?.(error);}});}else show(results);
    };
    const advance=direction=>{clearTimeout(panel.sidebarSearchTimer);if(r.searchQuery!==input.value){run();return;}r.nextSearch(direction);updateSearchNavigation(r);};
    input.oninput=()=>{r.sidebarSearchQuery=input.value;clearTimeout(panel.sidebarSearchTimer);panel.sidebarSearchTimer=setTimeout(run,120);};input.onkeydown=e=>{if(e.key==='Enter'&&!e.isComposing){e.preventDefault();advance(e.shiftKey?-1:1);}};
    q('search-prev').onclick=()=>advance(-1);q('search-next').onclick=()=>advance(1);if(focusSearch)input.focus();if(input.value)run(!focusSearch);
  }else if(mode==='outline'){
    // Native books keep their original TOC nodes below this editor-owned panel.
    content.innerHTML=embedded?'':outline.length?outline.map((item,index)=>`<button class="outline-item" style="padding-left:${12+(item.level-1)*12}px" data-heading="${index}">${esc(item.title)}</button>`).join(''):'<p class="panel-empty">이 문서에 제목 목차가 없습니다.</p>';
    $$('[data-heading]',panel).forEach(button=>button.onclick=()=>r.jump(outline[Number(button.dataset.heading)].node));
  }else if(mode==='bookmarks'){
    const marks=`${r.metadata.bookmarks.map(mark=>`<div class="bookmark-row"><button class="outline-item" data-bookmark="${esc(mark.id)}">${icon('bookmark',14)} ${esc(mark.title)}</button><button class="icon-button" data-delete-bookmark="${esc(mark.id)}" aria-label="북마크 삭제">${icon('close',13)}</button></div>`).join('')}<button id="${id('add-bookmark')}" class="text-button">+ 현재 위치 저장</button>`;
    content.innerHTML=`${r.metadata.bookmarks.length?'':'<p class="panel-empty">저장한 북마크가 없습니다.</p>'}<div class="sidebar-bookmark-list">${marks}</div>`;
    $$('[data-bookmark]',panel).forEach(button=>button.onclick=()=>{const mark=r.metadata.bookmarks.find(m=>m.id===button.dataset.bookmark);r.scrollTop=mark.top*r.zoom;r.scrollLeft=mark.left*r.zoom;});
    $$('[data-delete-bookmark]',panel).forEach(button=>button.onclick=()=>{r.metadata.bookmarks=r.metadata.bookmarks.filter(m=>m.id!==button.dataset.deleteBookmark);active().queue.schedule();if(embedded)r.showDocumentSidebarView('bookmarks');else renderSidebar('bookmarks');});q('add-bookmark').onclick=()=>toolAction('bookmark');
  }else{
    const contexts=r.annotationContexts?.()||new Map();
    const when=value=>Number.isFinite(value)?new Date(value).toLocaleString('ko-KR',{month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}):'';
    // Type alone ("펜 그림") says nothing about where an annotation is. Show the text it marks or was
    // drawn on, then the kind · the heading above it · when it was made.
    const row=a=>{const c=contexts.get(a.id)||{quote:a.textAnchor?.quote||a.anchorTarget?.quote||'',heading:''};const main=a.text||c.quote;const meta=[ANNOTATION_LABELS[a.type]||'주석',c.heading,when(a.created)].filter(Boolean).join(' · ');return `<div class="annotation-row"><button class="annotation-item" data-annotation="${esc(a.id)}" title="${esc([main,meta].filter(Boolean).join('\n'))}"><span class="annotation-type" style="color:${a.color}">${icon(a.type==='pen'?'pen':a.type==='note'?'note':a.type==='highlight'?'highlight':a.type==='underline'?'underline':'shapes',16)}</span><span class="annotation-text">${main?`<span class="annotation-main">${esc(main)}</span>`:''}${a.text&&c.quote?`<span class="annotation-context">“${esc(c.quote)}”</span>`:''}<span class="annotation-meta">${esc(meta)}</span></span></button><button class="icon-button" data-delete-annotation="${esc(a.id)}" aria-label="주석 삭제">${icon('trash',14)}</button></div>`;};
    const tree=r.annotationTree?.(contexts)||[{id:'document',title:'문서 전체',count:r.metadata.annotations.length,annotations:r.metadata.annotations,children:[]}];
    const branch=group=>`<details class="annotation-group" data-annotation-group="${esc(group.id)}"${r.annotationTreeOpen.get(group.id)?' open':''}><summary><span class="annotation-group-title">${esc(group.title)}</span><span class="annotation-group-count" aria-label="${group.count}개 주석">${group.count}</span></summary><div class="annotation-group-body">${group.children.map(branch).join('')}${group.annotations.map(row).join('')}</div></details>`;
    content.innerHTML=r.metadata.annotations.length?`<div class="annotation-tree" aria-label="목차별 주석">${tree.map(branch).join('')}</div>`:'<p class="panel-empty">아직 주석이 없어요.<br>툴바에서 도구를 골라 생각을 남겨보세요.</p>';
    $$('[data-annotation-group]',panel).forEach(group=>group.ontoggle=()=>{if(group.isConnected)r.annotationTreeOpen.set(group.dataset.annotationGroup,!!(group.open||group.hasAttribute('open')));});
    $$('[data-annotation]',panel).forEach(button=>button.onclick=()=>r.jumpAnnotation(button.dataset.annotation));$$('[data-delete-annotation]',panel).forEach(button=>button.onclick=()=>r.remove(button.dataset.deleteAnnotation));
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
function pickHTMLFile() {
  if(openPicker())return window.showOpenFilePicker({types:importTypes}).then(([handle])=>handle,error=>{if(['SecurityError','NotSupportedError'].includes(error.name))return inputFile();throw error;});
  return inputFile();
  function inputFile(){return new Promise(resolve=>{const input=document.createElement('input');input.type='file';input.accept=$('#file-input').getAttribute('accept');input.onchange=()=>resolve(input.files[0]||null);input.oncancel=()=>resolve(null);input.click();});}
}
// 「새 판으로 주석 옮기기」: the book was edited and exported again. Find every annotation of this
// document in the new file and open the new file with them. This document stays as it is.
async function migrateEdition(tab) {
  if(!tab?.reader)return;
  await tab.reader.ready;await tab.queue.flush();
  const annotations=tab.reader.metadata.annotations;
  if(!annotations.length){toast('옮길 주석이 없습니다.');return;}
  let input;
  try{input=await pickHTMLFile();}catch(error){if(error?.name==='AbortError')return;throw error;}
  if(!input)return;
  const local=await readLocalHTML(input,{native:true,allowScripts:true});
  modal(`<div class="dialog-heading"><h2>새 판으로 주석 옮기기</h2></div><p class="dialog-description" id="migrate-status" role="status">새 판을 여는 중…</p>`);
  const status=()=>$('#migrate-status');
  let result,probe;
  try{
    probe=await openEditionProbe(local.snapshot);
    result=await migrateAnnotations({annotations,oldDoc:tab.reader.doc,probe,onProgress:(done,total,phase)=>{if(status())status().textContent=`${phase==='search'?'다른 장에서 찾는 중':'새 판에서 자리를 찾는 중'}… ${done}/${total}장`;}});
  }catch(error){$('#dialog').close();throw error;}
  finally{probe?.dispose();}
  const {report}=result,lost=[...report.deleted,...report.unplaceable,...report.unchecked];
  const where=a=>{const key=a.textAnchor?.section||a.anchorTarget?.section;return key?result.oldSections.get(key)?.title||'':'';};
  const row=a=>`<li><strong>${esc(ANNOTATION_LABELS[a.type]||'주석')}</strong> ${esc((a.text||a.textAnchor?.quote||a.anchorTarget?.quote||'').slice(0,80))}${where(a)?` <span class="migrate-where">— ${esc(where(a))}</span>`:''}</li>`;
  modal(`<form method="dialog"><div class="dialog-heading"><h2>새 판으로 주석 옮기기</h2><button type="button" class="icon-button" data-dialog-close aria-label="닫기">${icon('close')}</button></div>
    <p class="dialog-description">주석 ${annotations.length}개 가운데 <strong>${result.annotations.length}개</strong>를 새 판에서 찾았습니다.</p>
    <ul class="migrate-summary"><li>그대로 있는 자리: ${report.same}개</li><li>문장이 고쳐졌거나 옮겨진 자리: ${report.changed}개</li><li>새 판에서 지워진 내용: ${report.deleted.length}개 — 옮기지 않습니다</li>${report.unplaceable.length?`<li>위치 정보가 없는 예전 메모: ${report.unplaceable.length}개 — 옮기지 않습니다</li>`:''}${report.unchecked.length?`<li>새 판의 장을 열지 못해 확인하지 못한 주석: ${report.unchecked.length}개 — 옮기지 않습니다 (${esc(report.failedSections.slice(0,3).join(' '))})</li>`:''}</ul>
    ${lost.length?`<details class="migrate-lost"><summary>옮기지 않는 주석 ${lost.length}개 보기</summary><ul>${lost.slice(0,200).map(row).join('')}</ul></details>`:''}
    <p class="dialog-description small">새 판은 새 문서로 열리고, 지금 문서와 그 주석은 서재에 그대로 남습니다.</p>
    <div class="dialog-actions"><button class="secondary-button" value="cancel">취소</button><button class="primary-button" value="confirm"${result.annotations.length?'':' disabled'}>새 판 열기</button></div></form>`,dialog=>{
    const done=safely(async()=>{dialog.removeEventListener('close',done);if(dialog.returnValue!=='confirm')return;
      const next=await createDocument(local.snapshot,local.handle,local.name,local);await next.reader.ready;
      const ids=new Set(next.reader.metadata.annotations.map(a=>a.id));
      next.reader.commit([...next.reader.metadata.annotations,...result.annotations.map(a=>ids.has(a.id)?{...a,id:uid()}:a)]);
      await next.queue.flush();
      toast(`새 판에 주석 ${result.annotations.length}개를 옮겼습니다.${lost.length?` 지워진 내용의 주석 ${lost.length}개는 옮기지 않았습니다.`:''}`);
    });
    dialog.addEventListener('close',done);
  });
}
function documentMenu(record) {
  modal(`<div class="dialog-heading"><h2>${esc(record.title)}</h2><button class="icon-button" data-dialog-close aria-label="닫기">${icon('close')}</button></div><div class="document-actions"><button class="menu-button" id="menu-open">${icon('file')} 열기</button><button class="menu-button" id="menu-export">${icon('download')} HTML 내보내기</button><button class="menu-button" id="menu-history">${icon('undo')} 주석 저장 이력</button><button class="menu-button" id="menu-migrate">${icon('file')} 새 판으로 주석 옮기기</button><button class="menu-button danger" id="menu-remove">${icon('trash')} 서재에서 삭제</button></div>`,()=>{
    $('#menu-open').onclick=safely(async()=>{$('#dialog').close();await openRecord(record);});$('#menu-export').onclick=safely(async()=>{$('#dialog').close();const tab=await openRecord(record);await exportDocument(tab);});
    $('#menu-history').onclick=safely(async()=>{$('#dialog').close();await annotationHistory(await openRecord(record));});
    $('#menu-migrate').onclick=safely(async()=>{$('#dialog').close();await migrateEdition(await openRecord(record));});
    $('#menu-remove').onclick=safely(async()=>{if(!await confirmDialog('서재에서 삭제할까요?','앱 보관함에서만 삭제합니다. 연결된 외부 HTML 파일은 남습니다.','삭제'))return;const tab=tabs.find(t=>t.record?.id===record.id);if(tab)await closeTab(tab.id);await deleteDocument(record.id);await refreshLibrary();});
  });
}
function handleKey(event) {
  const isField=/^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName)||event.target?.isContentEditable;
  if((event.ctrlKey||event.metaKey)&&event.shiftKey&&event.key.toLowerCase()==='v'&&!isField&&!$('#dialog').open){event.preventDefault();pasteTextDialog();return;}
  if(event.key==='Escape') {if(reader()?.readAloud?.escape()){event.preventDefault();return;}reader()?.stopSpeech();if($('#dialog').open)return;if(!$('#tool-popover').hidden)closePopover();else if(!$('#sidebar').hidden)closeSidebar();else if(reader()?.documentSidebarUI&&reader().documentSidebarMode!=='outline')reader().showDocumentSidebarView('outline');else if(readerFocused)void leaveReaderFocus();else if(reader())reader().setTool('select');return;}
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){event.preventDefault();if(reader())safely(()=>{const tab=active();tab.reader.rememberPosition();return tab.queue.flush();})();else safely(savePage)();return;}
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='l'){event.preventDefault();focusAddress();return;}
  if(!reader()||isField||$('#dialog').open)return;
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){event.preventDefault();event.shiftKey?reader().redo():reader().undo();return;}
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='f'){event.preventDefault();if(reader().documentSidebarUI)reader().showDocumentSidebarView('search');else renderSidebar('search');return;}
  if(event.ctrlKey||event.metaKey||event.altKey)return;
  if(event.key.toLowerCase()==='f'){event.preventDefault();void toggleReaderFocus();return;}
  const tools={v:'select',p:'pen',h:'highlight',u:'underline',e:'eraser',n:'note'};const tool=tools[event.key.toLowerCase()];if(tool){event.preventDefault();toolAction(tool);}
}
function setReaderFocus(value) {
  readerFocused=value;$('#app').classList.toggle('reader-focus',value);
  const focusedReader=reader();
  closePopover();closeSidebar({remember:false,clearSearch:false});requestAnimationFrame(()=>{if(!value)restoreSidebar();applyToolbarPosition();focusedReader?.setFocusLayout?.(value);focusedReader?.measure();});
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
  [['#new-tab','globe','웹 페이지 열기'],['#paste-button','note','텍스트 붙여넣기'],['#web-help-button','info','웹페이지 가져오기 안내'],['#execution-tab','external','실행과 앱 전달'],['#address-open','external'],['#back','back'],['#forward','forward'],['#reload','reload'],['#save-page','save'],['#app-menu-button','chevron-down','메뉴'],['#settings-button','settings','설정'],['#menu-folder','folder','저장 폴더 연결'],['#about-button','info','About'],['#library-search-icon','search'],['#empty-icon','file'],['#library-card-view','grid','카드'],['#library-list-view','list','목록']].forEach(([id,name,label])=>setButton(id,name,label));
  setIconButton('#library-tab','library','내 서재');
  bindAppMenu();bindTabs();$('#menu-folder').onclick=safely(chooseFolder);$('#about-button').onclick=aboutDialog;
  $('#library-tab').onclick=()=>activate('library');$('#new-tab').onclick=()=>{activate('library');focusAddress();};$('#browse-start').onclick=focusAddress;
  $('#execution-tab').onclick=()=>activate('execution');$('#execution-import').onclick=safely(importFiles);$('#execution-web').onclick=()=>webHelpDialog();$('#execution-settings').onclick=settingsDialog;
  $('#share-url').value=PUBLIC_APP_URL;$('#shared-app-link').href=PUBLIC_APP_URL;
  $('#share-app').onclick=safely(copyAppURL);
  installController=new InstallController({window,navigator,location,matchMedia,onChange:updateInstall,onGuide:installGuide});
  $('#install-button').onclick=$('#execution-install').onclick=safely(async()=>{const result=await installController.install();if(result==='dismissed')toast('설치를 취소했습니다. 앱 설치 버튼에서 다시 안내를 볼 수 있어요.');});
  const addressForm=$('#address-form');
  addressForm.addEventListener('focusin',()=>$('.chrome').classList.add('address-editing'));
  addressForm.addEventListener('focusout',event=>{if(!addressForm.contains(event.relatedTarget)){$('.chrome').classList.remove('address-editing');updateChrome();requestAnimationFrame(revealActiveTab);}});
  addressForm.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();$('#address').blur();$('.tab.active .tab-select',$('#tabs'))?.focus();}});
  addressForm.onsubmit=safely(async event=>{event.preventDefault();const value=$('#address').value;$('.chrome').classList.remove('address-editing');$('#address').blur();await openBrowser(value,active()?.type!=='browser');});
  $('#back').onclick=safely(()=>browserHistory(-1));$('#forward').onclick=safely(()=>browserHistory(1));$('#reload').onclick=()=>{const tab=active();if(tab?.frame&&!tab.capturing){tab.loading=true;tab.readable=false;tab.frame.src=tab.url;renderBrowserState(tab);}};
  $('#save-page').onclick=safely(savePage);$('#hero-import').onclick=safely(importFiles);$('#choose-folder').onclick=safely(chooseFolder);
  $('#file-input').onchange=safely(async event=>{const files=[...event.target.files];event.target.value='';for(const file of files)await openLocalFile(file);});
  $('#settings-file-input').onchange=safely(async event=>{const file=event.target.files[0];event.target.value='';if(file){await restoreSettings(file);settingsDialog();}});
  $('#library-filter').oninput=renderLibrary;$('#library-sort').onchange=safely(e=>{const [librarySort,librarySortDirection]=e.target.value.split(':');changePreferences({librarySort,librarySortDirection});});$$('[data-library-view]').forEach(button=>button.onclick=safely(()=>changePreferences({libraryView:button.dataset.libraryView})));$('#settings-button').onclick=settingsDialog;$('#web-help-button').onclick=()=>webHelpDialog();$('#paste-button').onclick=()=>pasteTextDialog();
  $('#open-example').onclick=safely(async()=>{let html=await bundledExample();if(html===null){const response=await fetch('./example.html');if(!response.ok)throw new Error('예제 문서를 불러오지 못했습니다.');html=await response.text();}await createDocument({html,title:'천천히 읽는다는 것',viewport:{width:960,height:800}},await folderFile('천천히 읽는다는 것'));});
  document.addEventListener('keydown',handleKey);document.addEventListener('pointerdown',event=>{if(!event.target.closest('#toolbar,#tool-popover,[data-htmlmemo-reading-controls]')&&!$('#tool-popover').hidden)closePopover();});
  $('#dialog').addEventListener('click',event=>{if(event.target===$('#dialog'))$('#dialog').close();});
  window.addEventListener('beforeunload',event=>{if(tabs.some(t=>t.opening||t.queue?.editsPending)){event.preventDefault();event.returnValue='';}});
  const savePositions=()=>{for(const tab of tabs)if(tab.reader?.doc){tab.reader.rememberPosition();tab.queue.flush().catch(()=>{});}};
  document.addEventListener('visibilitychange',()=>{if(document.hidden)savePositions();});
  window.addEventListener('pagehide',savePositions);
  window.addEventListener('online',network);window.addEventListener('offline',network);
  window.addEventListener('focus',resumeBrowser);document.addEventListener('visibilitychange',resumeBrowser);
  window.addEventListener('resize',()=>{closePopover();applyToolbarPosition();requestAnimationFrame(revealActiveTab);});
  window.addEventListener('dragover',event=>{if([...event.dataTransfer.types].includes('Files'))event.preventDefault();});window.addEventListener('drop',safely(async event=>{if(![...(event.dataTransfer.types||[])].includes('Files'))return;event.preventDefault();for(const file of await droppedHTMLFiles(event.dataTransfer))await openLocalFile(file);}));
}
function network() {$('#network-status').textContent=navigator.onLine?'온라인':'오프라인';$('#network-status').classList.toggle('offline',!navigator.onLine);}
function fitHeader() {
  const header=$('.chrome');
  if(!header || typeof ResizeObserver==='undefined')return;
  let scheduled=false;
  const update=()=>{
    if(scheduled)return;scheduled=true;
    requestAnimationFrame(()=>{
      scheduled=false;if(!header.clientWidth)return;
      document.documentElement.style.setProperty('--chrome-height',header.offsetHeight+'px');
    });
  };
  const resize=new ResizeObserver(update);resize.observe(header);
  document.fonts?.ready?.then(update);window.addEventListener('resize',update);update();
}
async function initialize() {
  try{preferences=loadPreferences(localStorage);}catch(error){toast('설정 일부를 읽지 못했습니다. 설정 파일로 복원할 수 있습니다.',true);}applyTheme(preferences.theme);bindUI();fitHeader();$('#library-sort').value=preferences.librarySort+':'+preferences.librarySortDirection;network();folder=await getSetting('folder');settingsFileHandle=await getSetting('settings-file');settingsFolderHint=await getSetting('settings-folder-hint')||'';await refreshLibrary();activate('library');
  if(installableLocation(location)&&'serviceWorker'in navigator)await navigator.serviceWorker.register('./sw.js',{updateViaCache:'none'}).then(reg=>reg?.update?.().catch(()=>{})).catch(()=>toast('오프라인 준비를 완료하지 못했습니다. 다음 접속에서 다시 준비합니다.',true));
  if('launchQueue'in window)window.launchQueue.setConsumer(safely(async params=>{for(const handle of params.files||[])await openLocalFile(handle);}));
}
initialize().catch(error=>{$('#status-left').textContent='서재를 준비하지 못했습니다.';showError(error);});
