import { $, $$, icon, escapeHTML as esc, uid, filename, normalizeURL, displayHost, formatDate, formatBytes, download } from './utils.js';
import { parseHTML, SCRIPT_CSP, serializeBookSource } from './document.js';
import { SaveQueue, AnnotationCheckpoints, ANNOTATION_LABELS } from './model.js';
import { openEditionProbe, migrateAnnotations } from './migrate.js';
import { Reader } from './reader.js';
import { listDocuments, getDocument, trashDocument, restoreDocument, deleteDocument, deleteTrashedDocuments, getSetting, setSetting, saveDocumentHTML, listRevisionPeriods, listRevisionDay, adjacentRevisionDay, getRevision, putDocumentRevision, checkpointAnnotations, putDocumentView, putDocumentSourceIdentity, writeExternalHTML, updateLibraryFolders, onStorageChange, readLibrary } from './storage.js';
import {readWebPage,pastedPage,PASTE_LIMIT,isWebSearch,BrowserTabs} from './web.js';
import { readLocalHTML, droppedHTMLFiles, findLocalDuplicates, identifyLocalFile, htmlExportName } from './local-files.js';
import { normalizePreferences, loadPreferences, storePreferences, serializeSettings, readSettingsFile, PRESET_COLORS, PRESET_PALETTES, normalizeHexColor, hexToRgb, rgbToHex, hexToHsv, hsvToHex } from './preferences.js';
import {bundledExample} from './distribution.js';
import { InstallController, isIOS, installableLocation, installationURL, PUBLIC_APP_URL } from './install.js';
import { APP_VERSION } from './version.js';
import { DataFolder, supportsDataFolder, CHROME_REQUIRED_MESSAGE } from './data-folder.js';
import {validateFolders,folderPath,folderDescendants,editLibraryFolders,LibraryIndex} from './library-folders.js';

let records = []; const tabs = []; let activeId = 'library'; let folder = null; let popoverName = ''; let sidebarMode = '';
let libraryFolders=[],libraryFolderId='',libraryCollapsed=new Set(),libraryRefresh=0,libraryRead=null,libraryReloadTimer;
let trashRecords=[],libraryTrash=false,trashSort='trashedAt:desc',trashBusy=false;
const trashIndex=new LibraryIndex();
const libraryIndex=new LibraryIndex();let libraryIndexVersion=0,libraryTreeVersion=0,libraryTreeState='',libraryGridState=null;
let libraryFolderById=new Map(),libraryFolderChildren=new Map(),libraryFolderCounts=new Map();
let preferences=normalizePreferences(), settingsFileHandle=null, settingsFolderHint='';
let dataFolder, browserStorageProtection;
const FOLDER_WELCOME_KEY='htmlmemo-data-folder-welcome-v1';
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
  closePopover(); $('#dialog-content').innerHTML=html; const dialog=$('#dialog'); dialog.returnValue='';dialog.oncancel=null;
  const heading=$('h2',dialog);if(heading){heading.id='dialog-title';dialog.setAttribute('aria-labelledby',heading.id);}else dialog.removeAttribute('aria-labelledby');
  if (!dialog.open) dialog.showModal();
  $$('[data-dialog-close]',dialog).forEach(button=>button.onclick=()=>dialog.close()); bind(dialog);
}
function annotationExportGuide() {
  return `<details class="export-guide" data-export-guide><summary>주석을 포함한 HTML 파일 저장·보내는 방법</summary>${$('#export-guide-content').innerHTML}</details>`;
}
function aboutDialog() {
  modal(`<div class="dialog-heading"><h2>About</h2><button class="icon-button" data-dialog-close aria-label="닫기">${icon('close')}</button></div>${$('#about-content').innerHTML}<div class="dialog-actions"><button class="primary-button" data-dialog-close>확인</button></div>`,()=>{$('#app-version').textContent=APP_VERSION;});
  $('#dialog [data-dialog-close]').focus();
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
  const button=$('#execution-install'),label=state.busy?'설치 확인 중…':state.installed?'설치 완료':'앱 설치';button.disabled=state.busy;button.textContent=label;button.title=label;button.setAttribute('aria-label',label);
  $('#install-message').textContent=state.installed?'앱으로 실행 중입니다. 문서·주석·설정은 이 기기에 저장됩니다.':!installableLocation(location)?'PWA 설치는 배포된 앱 주소에서 가능합니다. HTML 파일의 읽기·주석은 계속 사용할 수 있습니다.':isIOS(navigator)?'아이폰은 앱 설치 버튼에서 Chrome 공유 메뉴 사용 순서를 확인하세요.':'설치하지 않아도 앱의 URL에서 바로 사용할 수 있습니다.';
}
function promptText(type, initial = '') {
  const inputTab=active();
  return new Promise(resolve=>{
    modal(`<form method="dialog" class="note-form"><div class="dialog-heading"><h2>${type==='text'?'텍스트 입력':'메모 남기기'}</h2><button class="icon-button" value="cancel" aria-label="닫기">${icon('close')}</button></div><textarea id="note-text" placeholder="생각을 적어보세요…" maxlength="10000" rows="6">${esc(initial)}</textarea><div class="dialog-actions"><button class="secondary-button" value="cancel">취소</button><button class="primary-button" value="save">저장</button></div></form>`,dialog=>{
      $('#note-text').oninput=()=>inputTab?.checkpoints?.activity();
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
  modal(`<div class="dialog-heading"><h2>Chrome에서 탐색하고 여기서 메모하기</h2><button class="icon-button" data-dialog-close aria-label="닫기">${icon('close')}</button></div>${message?`<p class="web-notice" role="status">${esc(message)}</p>`:''}<p class="dialog-description">HTMLMemo는 이 URL만 열면 사용할 수 있습니다. 앱 설치는 선택 사항이며 추가 프로그램이나 서버 연결은 필요하지 않습니다.</p><p class="dialog-description small" data-single-file-guide>브라우저에서 웹페이지를 저장할 때는 <strong>Webpage, Single File</strong>(웹페이지, 단일 파일 · .mhtml) 형식을 선택하세요. 이미지·스타일을 하나의 파일에 함께 보관합니다.</p><ol class="setup-steps"><li>주소창에 검색어나 웹 주소를 입력하면 <strong>Chrome의 일반 탭</strong>에서 엽니다. </li><li>필요한 글을 복사한 뒤 <strong>HTMLMemo 탭으로 돌아옵니다.</strong> 읽던 문서와 주석은 그대로입니다.</li><li><strong>텍스트 붙여넣기</strong>에서 글과 실제 원문 주소를 넣거나, Chrome에서 저장한 <strong>HTML 파일을 가져옵니다.</strong></li></ol><p class="dialog-description small">다른 Chrome 탭의 현재 주소·본문·로그인 정보나 클립보드를 자동으로 읽지 않습니다. 사이트가 탭 연결을 격리하거나 팝업을 막으면 직접 링크를 사용하세요. 이미 가진 HTML 파일은 그대로 가져올 수 있습니다.</p><div class="web-actions">${tab?`<a class="secondary-button" href="${esc(tab.url)}" target="_blank" rel="noopener noreferrer">보낸 주소 열기 ${icon('external',14)}</a>`:''}<button id="web-help-import" class="secondary-button">HTML 파일 가져오기</button><button id="web-help-paste" class="primary-button">텍스트 붙여넣기</button></div>`,()=>{
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
      try{const saved=await createDocument(snapshot);$('#dialog').close();if(!saved?.queue?.error)toast('붙여넣은 글을 서재에 저장했습니다.');}finally{button.disabled=false;}
    });
    requestAnimationFrame(()=>$('#paste-text')?.focus());
  });
}
function settingsDialog() {
  modal(`<div class="dialog-heading"><h2>HTMLMemo 설정</h2><button class="icon-button" data-dialog-close aria-label="닫기">${icon('close')}</button></div><div class="settings-app-actions" role="group" aria-label="앱 실행과 정보"><button id="settings-execution" class="secondary-button" type="button">${icon('external',15)} 실행과 앱 전달</button><button id="settings-about" class="secondary-button" type="button" aria-haspopup="dialog">${icon('info',15)} About</button></div><p class="local-only-note">${icon('check',15)} 문서·주석·설정은 기기에 저장하며 서버로 보내지 않습니다.</p><div class="setting-row"><div><strong>데이터 폴더</strong><p id="settings-folder-status">${esc(folderStatusText())}</p></div><button id="settings-folder" class="secondary-button">${folder?'관리':'폴더 연결'}</button></div>${dataFolderGuide()}<div class="setting-row"><div><strong>화면 테마</strong><p>서재와 도구의 밝기를 선택하세요.</p></div><select id="appearance"><option value="light">밝게</option><option value="dark">어둡게</option><option value="system">시스템</option></select></div><details class="settings-backup"><summary>이전 설정 JSON 파일 사용 (선택 사항)</summary><p class="dialog-description small">데이터 폴더를 연결했다면 설정 파일을 따로 저장하거나 불러올 필요가 없습니다. 예전에 저장한 설정 JSON을 옮길 때만 사용하세요.</p><p id="settings-file-name" class="settings-file-name">${settingsFileHandle?esc(settingsFileHandle.name):'연결한 설정 파일이 없습니다.'}</p><div class="settings-file-actions"><button id="settings-save" class="secondary-button">${icon('save',15)} 설정 파일 저장</button><button id="settings-load" class="secondary-button">${icon('folder',15)} 설정 파일 불러오기</button><button id="settings-reload" class="secondary-button" ${settingsFileHandle?'':'disabled'}>${icon('reload',15)} 다시 불러오기</button></div></details><p class="dialog-description small">브라우저 데이터가 삭제돼도 전용 폴더의 파일은 남습니다. 폴더를 다시 선택하면 복원됩니다. 폴더 자체 삭제·기기 고장까지 막는 것은 아니므로 중요한 데이터는 폴더 전체를 다른 저장장치에도 복사하세요.</p>`,()=>{
    $('#settings-execution').onclick=()=>{$('#dialog').close();activate('execution');$('#execution h1').focus({preventScroll:true});};$('#settings-about').onclick=aboutDialog;
    $('#settings-folder').onclick=safely(()=>chooseFolder({onConnected:settingsDialog}));
    $('#appearance').value=preferences.theme; $('#appearance').onchange=safely(e=>changePreferences({theme:e.target.value}));
    $('#settings-save').onclick=safely(saveSettingsBackup);$('#settings-load').onclick=safely(importSettingsBackup);$('#settings-reload').onclick=safely(async()=>{await restoreSettings(settingsFileHandle);settingsDialog();});
  });
}
function applyTheme(theme) { document.documentElement.dataset.theme=theme==='system'?(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'):theme;stopAppSidebarResize();applyAppSidebarWidth();for(const tab of tabs)if(tab.reader?.documentSidebarUI)styleNativeSidebar(tab.reader.documentSidebarUI); }
function applyToolbarPosition(){const bar=$('#toolbar'),p=preferences.toolbarPosition;if(!p){bar.style.left='50%';bar.style.top='';bar.style.bottom='';bar.style.transform='';return;}bar.style.transform='none';bar.style.bottom='auto';bar.style.left=(8+p.x*Math.max(0,innerWidth-bar.offsetWidth-16))+'px';bar.style.top=(8+p.y*Math.max(0,innerHeight-bar.offsetHeight-42))+'px';}
function changePreferences(patch){preferences=storePreferences({...preferences,...patch,annotation:{...preferences.annotation,...patch.annotation}},localStorage);dataFolder?.schedule({settingsOnly:true});applyTheme(preferences.theme);$('#library-sort').value=preferences.librarySort+':'+preferences.librarySortDirection;for(const tab of tabs)if(tab.reader)Object.assign(tab.reader,preferences.annotation);applyToolbarPosition();renderLibrary();if(reader())updateToolbarState();}
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
function cacheLibraryDocument(record) {
  records=records.filter(item=>item.id!==record.id);trashRecords=trashRecords.filter(item=>item.id!==record.id);
  if(record.trashedAt)trashRecords.push(record);else records.push(record);
}
async function refreshLibrary() {
  clearTimeout(libraryReloadTimer);libraryRefresh++;
  if(!libraryRead)libraryRead=(async()=>{
    let refresh,snapshot;
    do{refresh=libraryRefresh;snapshot=await readLibrary();}while(refresh!==libraryRefresh);
    trashRecords=snapshot.documents.filter(record=>record.trashedAt);records=trashRecords.length?snapshot.documents.filter(record=>!record.trashedAt):snapshot.documents;libraryFolders=validateFolders(snapshot.folders);
    if(libraryFolderId&&!libraryFolders.some(f=>f.id===libraryFolderId))libraryFolderId='';renderLibrary();
  })().finally(()=>{libraryRead=null;});
  return libraryRead;
}
function renderLibrary() {
  indexLibraryFolders();
  if(activeId!=='library')return;
  const filter=$('#library-filter').value.toLocaleLowerCase(),[sort,direction]=libraryTrash?trashSort.split(':'):[preferences.librarySort,preferences.librarySortDirection];
  if(libraryTrash)trashIndex.update(trashRecords,libraryFolders,folder?.name||'전용 폴더');
  const result=(libraryTrash?trashIndex:libraryIndex).select({filter,folderId:libraryFolderId,sort,direction,allFolders:libraryTrash}),{documents:shown,folders:shownFolders}=result;
  const dateField=sort==='created'?'created':sort==='trashedAt'?'trashedAt':'modified',dateLabel=dateField==='created'?'저장일':dateField==='trashedAt'?'삭제일':'수정일';
  const sortControl=$('#library-sort');
  if(libraryTrash&&!$('[data-trash-sort]',sortControl))sortControl.insertAdjacentHTML('afterbegin','<option value="trashedAt:desc" data-trash-sort>삭제일 · 최신순</option><option value="trashedAt:asc" data-trash-sort>삭제일 · 오래된순</option>');
  if(!libraryTrash)$$('[data-trash-sort]',sortControl).forEach(option=>option.remove());sortControl.value=sort+':'+direction;
  $('#library .library-heading h2').firstChild.nodeValue=libraryTrash?'휴지통 ':'내 서재 ';
  $('#library-trash').innerHTML=icon('trash',15)+'<span>휴지통</span><small>'+trashRecords.length+'</small>';
  $('#library-trash').setAttribute('aria-pressed',String(libraryTrash));$('#library-trash').title=libraryTrash?'내 서재로 돌아가기':'휴지통 · '+trashRecords.length+'개';$('#library-trash').setAttribute('aria-label',$('#library-trash').title);
  $('#library-empty-trash').hidden=!libraryTrash;$('#library-empty-trash').disabled=!trashRecords.length;
  $('#library-trash-info').hidden=!libraryTrash;
  const grid=$('#document-grid');grid.dataset.view=preferences.libraryView;
  $$('[data-library-view]').forEach(button=>{const active=button.dataset.libraryView===preferences.libraryView;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));});
  $('#document-count').textContent=libraryTrash?trashRecords.length:records.length; $('#empty-library').hidden=shown.length+shownFolders.length>0;
  $('#empty-library h3').textContent=filter?'검색 결과가 없습니다.':libraryTrash?'휴지통이 비어 있습니다.':libraryFolderId?'이 폴더는 비어 있습니다.':records.length||libraryFolders.length?'이 위치에는 문서가 없습니다.':'첫 HTML 문서를 보관해보세요.';
  $('#empty-library p').innerHTML=filter?'다른 제목·파일명·폴더 이름으로 찾아보세요.':libraryTrash?'내 서재에서 삭제한 문서는 이곳에서 복원할 수 있습니다.':libraryFolderId||records.length||libraryFolders.length?'HTML 파일을 가져오거나 문서 메뉴의 「폴더로 이동」을 사용하세요.':'웹에서 저장하거나, 가지고 있는 HTML 파일을 열면<br>이곳에서 계속 읽고 메모할 수 있어요.';
  $('#open-example').hidden=libraryTrash||!!records.length||!!filter;
  $('#empty-icon').innerHTML=icon(libraryTrash?'trash':'file');
  // A theme/tool change or a repeated input event must not rebuild identical cards.
  if(libraryGridState!==result){
  grid.innerHTML=shownFolders.map(item=>`<article class="library-folder-card" data-library-item="folder" data-library-id="${item.id}" data-folder-target="${item.id}" draggable="true"><button class="library-folder-open" data-library-folder="${item.id}" title="${esc(libraryPathLabel(item.id))}">${icon('folder',22)}<span><strong>${esc(item.name)}</strong><small>${folderDocumentCount(item.id)}개 문서 · ${libraryFolderChildren.get(item.id)?.length||0}개 하위 폴더</small></span></button><button class="icon-button card-menu" data-folder-menu="${item.id}" aria-label="${esc(item.name)} 폴더 메뉴">${icon('more',17)}</button></article>`).join('')+shown.map(record=>{
    const count=record.metadata?.annotations?.length||0;const progress=record.metadata?.view?.scrollTop||0;
    const host=esc(displayHost(record.source)), title=esc(record.title), originalName=typeof record.name==='string'?esc(record.name):'', size=record.byteSize?formatBytes(record.byteSize):'HTML';
    const date=formatDate(record[dateField]),dateTitle=esc(dateLabel+': '+formatDate(record[dateField],true));
    // Both layouts share one title/source. A decorative preview used to repeat
    // them above the details, and list mode kept a third hidden copy.
    const place=esc(libraryPathLabel(record.folderId||'')),progressLabel=libraryTrash||filter?place:progress?'이어서 읽기':'새 문서';
    return `<article class="document-card" data-record="${record.id}" ${libraryTrash?'':`data-library-item="document" data-library-id="${record.id}"`} draggable="${!libraryTrash}"><button class="card-open" ${libraryTrash?'data-trash-menu':'data-open'}="${record.id}" ${libraryTrash?`aria-label="${title} 복원 또는 영구 삭제"`:''}><div class="card-details"><span class="list-file-icon" aria-hidden="true">${icon(libraryTrash?'trash':'file',16)}</span><div class="library-title"><h3 class="list-title" title="${title}">${title}</h3>${originalName?`<span class="list-filename" title="${originalName}">${originalName}</span>`:''}</div><p class="card-source"><span class="list-host" title="${host}">${host}</span><span class="list-date" title="${dateTitle}" aria-label="${dateTitle}">${date}</span></p><div class="card-meta"><span class="list-annotations" title="주석 ${count}개" aria-label="주석 ${count}개">${icon('highlight',13)} <span>${count}</span></span><span class="list-size">${size}</span><span class="list-progress" title="${progressLabel}">${progressLabel} ${icon(libraryTrash?'undo':'forward',13)}</span></div></div></button><button class="card-menu icon-button" ${libraryTrash?'data-trash-menu':'data-card-menu'}="${record.id}" aria-label="${title} ${libraryTrash?'휴지통':'문서'} 메뉴">${icon('more',17)}</button></article>`;
  }).join('');
  libraryGridState=result;
  }
  renderLibraryFolders();
  if(activeId==='library')$('#status-left').textContent=libraryTrash?`휴지통 ${trashRecords.length}개의 문서 · 복원 가능`:`${records.length}개의 문서 · ${folder?folder.name+' 자동 저장':'이 기기에 보관'}`;
  renderFolderState();
}
function indexLibraryFolders() {
  if(!libraryIndex.update(records,libraryFolders,folder?.name||'전용 폴더'))return;
  libraryFolderById=libraryIndex.byId;libraryFolderChildren=libraryIndex.children;libraryFolderCounts=libraryIndex.counts;libraryIndexVersion++;
}
function folderDocumentCount(id){return libraryFolderCounts.get(id)||0;}
function libraryPathLabel(id) {
  return libraryIndex.label(id);
}
function navigateLibraryFolder(id) {
  if(id&&!libraryFolderById.has(id))throw Error('폴더가 변경되었습니다. 다시 선택해주세요.');
  libraryTrash=false;libraryFolderId=id;$('#library-filter').value='';for(const item of folderPath(libraryFolders,id,libraryFolderById))libraryCollapsed.delete(item.id);libraryTreeVersion++;renderLibrary();
}
function toggleLibraryTrash(){libraryTrash=!libraryTrash;$('#library-filter').value='';libraryTreeVersion++;renderLibrary();}
function renderLibraryFolders() {
  const state=JSON.stringify([libraryIndexVersion,libraryFolderId,libraryTreeVersion,!!$('#library-filter').value,libraryTrash]);
  if(libraryTreeState===state)return;libraryTreeState=state;
  const path=folderPath(libraryFolders,libraryFolderId,libraryFolderById),root=folder?.name||'전용 폴더';
  $('#library-folder-up').innerHTML=icon('back',16);$('#library-folder-up').disabled=!libraryTrash&&!libraryFolderId;$('#library-folder-up').title=libraryTrash?'내 서재로 돌아가기':'상위 폴더';$('#library-folder-up').setAttribute('aria-label',$('#library-folder-up').title);
  $('#library-folder-help').innerHTML=icon('info',15);
  $('#library-new-folder').innerHTML=icon('folder',15)+'<span>새 폴더</span>';
  $('#library-new-folder').hidden=libraryTrash;$('#library-folder-help').hidden=libraryTrash;
  $('#library-breadcrumbs').innerHTML=[{id:'',name:root},...path].map(item=>`<button type="button" data-library-folder="${item.id}" data-folder-target="${item.id}" title="${esc(libraryPathLabel(item.id))}" ${item.id===libraryFolderId?'aria-current="page"':''}>${item.id?'':icon('folder',15)}<span>${esc(item.name)}</span></button>`).join('<span class="breadcrumb-divider" aria-hidden="true">/</span>');
  if(libraryTrash)$('#library-breadcrumbs').innerHTML='<span class="library-trash-location">휴지통</span>';
  const tree=$('#library-folder-tree');tree.hidden=libraryTrash||!libraryFolders.length;$('#library-layout').classList.toggle('has-folders',!libraryTrash&&!!libraryFolders.length);$('#library-search-scope').hidden=libraryTrash||!$('#library-filter').value;
  const branch=(id,depth)=> (libraryFolderChildren.get(id)||[]).map(item=>{
    const children=libraryFolderChildren.get(item.id)?.length,collapsed=libraryCollapsed.has(item.id);
    return `<div class="library-tree-row ${item.id===libraryFolderId?'active':''}" style="--folder-depth:${depth}" data-folder-target="${item.id}">${children?`<button class="library-tree-toggle" type="button" data-folder-toggle="${item.id}" aria-label="${esc(item.name)} ${collapsed?'펼치기':'접기'}" aria-expanded="${!collapsed}">${icon(collapsed?'forward':'down',12)}</button>`:'<span class="library-tree-spacer"></span>'}<button class="library-tree-open" type="button" data-library-folder="${item.id}" title="${esc(libraryPathLabel(item.id))}">${icon('folder',14)}<span>${esc(item.name)}</span><small>${folderDocumentCount(item.id)}</small></button></div>${!collapsed?branch(item.id,depth+1):''}`;
  }).join('');
  tree.innerHTML=`<div class="library-tree-root ${libraryFolderId?'':'active'}" data-folder-target=""><button class="library-tree-open" type="button" data-library-folder="" title="${esc(root)} · 최상위 폴더(root)">${icon('folder',15)}<span>${esc(root)}</span><small>root</small></button></div>${branch('',0)}`;
}
async function changeLibraryFolder(change) {
  await updateLibraryFolders((folders,documents)=>editLibraryFolders(folders,documents,change));
  await refreshLibrary();
  try{await dataFolder?.flush();}catch(error){showError(error);return;}
  toast(folder?'폴더와 문서 위치를 전용 폴더에 저장했습니다.':'서재에 저장했습니다. 데이터 폴더를 연결하면 폴더 구조도 함께 보관됩니다.');
}
function libraryFolderNameDialog(item=null) {
  const parentId=libraryFolderId;
  modal(`<form id="library-folder-form"><div class="dialog-heading"><h2>${item?'폴더 이름 변경':'새 폴더'}</h2><button class="icon-button" type="button" data-dialog-close aria-label="닫기">${icon('close')}</button></div><p class="dialog-description small">위치: ${esc(libraryPathLabel(item?item.parentId:parentId))}</p><label class="paste-label" for="library-folder-name">폴더 이름</label><input id="library-folder-name" class="paste-title" maxlength="100" required value="${esc(item?.name||'')}" autocomplete="off"><p class="dialog-description small">전용 폴더 아래에 실제 하위 폴더를 만듭니다. 같은 위치의 이름은 겹칠 수 없습니다.</p><p id="library-folder-error" class="folder-form-error" role="alert"></p><div class="dialog-actions"><button type="button" class="secondary-button" data-dialog-close>취소</button><button id="library-folder-save" class="primary-button" type="submit">${item?'변경':'만들기'}</button></div></form>`,dialog=>{
    $('#library-folder-form').onsubmit=safely(async event=>{event.preventDefault();const button=$('#library-folder-save');if(button.disabled)return;button.disabled=true;
      try{await changeLibraryFolder(item?{type:'rename',id:item.id,name:$('#library-folder-name').value}:{type:'create',id:uid(),parentId,name:$('#library-folder-name').value});dialog.close();}
      catch(error){$('#library-folder-error').textContent=error.message;}finally{button.disabled=false;}
    });requestAnimationFrame(()=>{$('#library-folder-name').focus();$('#library-folder-name').select?.();});
  });
}
function libraryFolderMenu(id) {
  const item=libraryFolderById.get(id);if(!item)return;
  const occupied=(libraryFolderChildren.get(id)?.length||0)||records.some(r=>r.folderId===id);
  modal(`<div class="dialog-heading"><h2>${esc(item.name)}</h2><button class="icon-button" data-dialog-close aria-label="닫기">${icon('close')}</button></div><p class="dialog-description small">${esc(libraryPathLabel(id))}</p><div class="document-actions"><button id="folder-menu-open" class="menu-button">${icon('folder')} 폴더 열기</button><button id="folder-menu-rename" class="menu-button">${icon('pen')} 이름 변경</button><button id="folder-menu-move" class="menu-button">${icon('forward')} 다른 폴더로 이동</button><button id="folder-menu-delete" class="menu-button danger" ${occupied?'disabled':''} title="${occupied?'문서와 하위 폴더를 먼저 옮기세요.':'비어 있는 폴더 삭제'}">${icon('trash')} 빈 폴더 삭제</button></div><p class="dialog-description small">비어 있는 폴더만 삭제할 수 있습니다. 앱에 등록되지 않은 외부 파일은 이동·삭제하지 않습니다.</p>`,dialog=>{
    $('#folder-menu-open').onclick=()=>{dialog.close();navigateLibraryFolder(id);};$('#folder-menu-rename').onclick=()=>libraryFolderNameDialog(item);$('#folder-menu-move').onclick=()=>libraryMoveDialog('folder',item);
    $('#folder-menu-delete').onclick=safely(async()=>{if(!await confirmDialog('빈 폴더를 삭제할까요?',libraryPathLabel(id)+' · 문서와 주석은 삭제하지 않습니다.','삭제'))return;await changeLibraryFolder({type:'delete',id});});
  });
}
function libraryMoveDialog(type,item) {
  const forbidden=type==='folder'?folderDescendants(libraryFolders,item.id):new Set(),current=type==='folder'?item.parentId:item.folderId||'';
  const destinations=[{id:'',label:libraryPathLabel('')+' (root)'},...libraryFolders.map(f=>({id:f.id,label:libraryPathLabel(f.id)})).sort((a,b)=>a.label.localeCompare(b.label,'ko'))].filter(f=>!forbidden.has(f.id));
  const available=destinations.some(f=>f.id!==current),initial=destinations.find(f=>f.id!==current)?.id;
  modal(`<form id="library-move-form"><div class="dialog-heading"><h2>${type==='folder'?'폴더':'문서'} 이동</h2><button type="button" class="icon-button" data-dialog-close aria-label="닫기">${icon('close')}</button></div><p class="dialog-description"><strong>${esc(item.title||item.name)}</strong></p><p class="dialog-description small">현재 위치: ${esc(libraryPathLabel(current))}</p><label class="paste-label" for="library-folder-destination">옮길 폴더</label><select id="library-folder-destination" class="folder-destination">${destinations.map(f=>`<option value="${f.id}" ${f.id===current?'disabled':''} ${f.id===initial?'selected':''}>${esc(f.label)}</option>`).join('')}</select><p class="dialog-description small">${available?'주석·북마크·읽기 위치·저장 이력은 그대로 유지합니다.': '이동할 수 있는 다른 폴더가 없습니다. 먼저 서재에서 새 폴더를 만드세요.'}</p><p id="library-move-error" class="folder-form-error" role="alert"></p><div class="dialog-actions"><button class="secondary-button" type="button" data-dialog-close>취소</button><button id="library-move-save" class="primary-button" type="submit" ${available?'':'disabled'}>이동</button></div></form>`,dialog=>{
    $('#library-move-form').onsubmit=safely(async event=>{event.preventDefault();const button=$('#library-move-save');if(button.disabled)return;button.disabled=true;
      try{const parentId=$('#library-folder-destination').value;await changeLibraryFolder(type==='folder'?{type:'move',id:item.id,parentId}:{type:'move-documents',ids:[item.id],parentId});dialog.close();}
      catch(error){$('#library-move-error').textContent=error.message;}finally{button.disabled=false;}
    });$('#library-folder-destination').focus();
  });
}
function bindLibraryFolderDrag() {
  const library=$('#library'),mime='application/x-htmlmemo-library-item';let dragged=null;
  library.addEventListener('click',safely(event=>{
    const button=event.target.closest('[data-open],[data-card-menu],[data-trash-menu],[data-folder-menu],[data-library-folder],[data-folder-toggle]');if(!button)return;
    if(button.hasAttribute('data-trash-menu'))return trashDocumentMenu(trashRecords.find(r=>r.id===button.dataset.trashMenu));
    if(button.hasAttribute('data-open'))return openRecord(records.find(r=>r.id===button.dataset.open));
    if(button.hasAttribute('data-card-menu'))return documentMenu(records.find(r=>r.id===button.dataset.cardMenu));
    if(button.hasAttribute('data-folder-menu'))return libraryFolderMenu(button.dataset.folderMenu);
    if(button.hasAttribute('data-library-folder'))return navigateLibraryFolder(button.dataset.libraryFolder);
    const id=button.dataset.folderToggle;if(libraryCollapsed.has(id))libraryCollapsed.delete(id);else libraryCollapsed.add(id);libraryTreeVersion++;renderLibraryFolders();
  }));
  const clear=()=>$$('.folder-drop-target',library).forEach(el=>el.classList.remove('folder-drop-target'));
  library.addEventListener('dragstart',event=>{const item=event.target.closest('[data-library-item]');if(!item)return;dragged={type:item.dataset.libraryItem,id:item.dataset.libraryId};event.dataTransfer.setData(mime,JSON.stringify(dragged));event.dataTransfer.effectAllowed='move';});
  library.addEventListener('dragover',event=>{const target=event.target.closest('[data-folder-target]');if(!target||!dragged||![...event.dataTransfer.types].includes(mime))return;
    if(dragged.type==='folder'&&folderDescendants(libraryFolders,dragged.id).has(target.dataset.folderTarget))return;
    event.preventDefault();event.dataTransfer.dropEffect='move';clear();target.classList.add('folder-drop-target');
  });
  library.addEventListener('dragleave',event=>{if(!library.contains(event.relatedTarget))clear();});library.addEventListener('dragend',()=>{dragged=null;clear();});
  library.addEventListener('drop',safely(async event=>{const target=event.target.closest('[data-folder-target]');if(!target||!dragged||![...event.dataTransfer.types].includes(mime))return;event.preventDefault();const item=dragged;dragged=null;clear();const parentId=target.dataset.folderTarget;
    await changeLibraryFolder(item.type==='folder'?{type:'move',id:item.id,parentId}:{type:'move-documents',ids:[item.id],parentId});
  }));
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
  closePopover(); closeSidebar({remember:false,clearSearch:false});$('.chrome').classList.remove('address-editing');activeId=id; $('#library').hidden=id!=='library';$('#execution').hidden=id!=='execution';$('#workspace').hidden=id==='library'||id==='execution';
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
  const tab=active(); const local=tab?.type==='document';const execution=activeId==='execution';
  $('.chrome').dataset.page=local?'document':tab?'browser':activeId;
  if(!$('.chrome').classList.contains('address-editing'))$('#address').value=local?tab.record.name:tab?.url||'';
  $('#address-icon').innerHTML=icon(local?'file':'globe',15);$('#local-label').hidden=!local;
  setIconButton('#save-page',execution?'globe':local?'download':tab?.external?'folder':'save',execution?'URL 복사':local?'HTML 내보내기':tab?.external?'Chrome에서 가져오기':'페이지 저장',17);
  if(local){$('#save-page').title='HTML 내보내기 · 본문·주석·북마크를 HTML 파일 하나로 저장';$('#save-page').setAttribute('aria-description','현재 주석을 포함한 HTML 파일을 저장해 다른 사람에게 보낼 수 있습니다.');}
  else $('#save-page').removeAttribute('aria-description');
  $('#save-page').disabled=execution?sharingApp:!tab||!!tab.capturing;
  if(local)saveStatus(tab); else if(tab)$('#status-left').textContent=tab.external?'웹 탐색은 브라우저 탭 · 복사한 글과 저장한 HTML은 여기서 주석 달기':tab.capturing?'읽기용 사본을 준비하는 중…':tab.readable?'페이지 저장 → 주석 달기 · 추가 설치 없음':'앱 문서를 준비하는 중…';
  document.title=tab?tab.title+' · HTMLMemo':'HTMLMemo · 나만의 웹 서재';
}
function createHost(id,type) { const host=document.createElement('div');host.id='workspace-'+id;host.className='workspace-host '+type+'-host';host.hidden=true;$('#workspaces').append(host);return host; }
async function openRecord(record, prepared = null, {deferReady = false, sourceIdentity = null} = {}) {
  if(!record||record.trashedAt)throw Error('휴지통의 문서는 먼저 복원한 뒤 열어주세요.');
  libraryTrash=false;
  const existing=tabs.find(tab=>tab.record?.id===record.id);if(existing){if(existing.closePromise){await existing.closePromise;return openRecord(record,prepared,{deferReady,sourceIdentity});}activate(existing.id);return existing;}
  if(!prepared && typeof record.html!=='string' && !record.file)record=await getDocument(record.id);
  if(!record||record.trashedAt)throw Error('문서가 휴지통으로 이동했거나 삭제되었습니다. 서재를 다시 확인해주세요.');
  const opened=tabs.find(tab=>tab.record?.id===record.id);if(opened){if(opened.closePromise){await opened.closePromise;return openRecord(record,prepared,{deferReady,sourceIdentity});}activate(opened.id);return opened;}
  // The library already holds a prepared, sanitized snapshot. Reopening it
  // should parse it once in the iframe, not clone the entire book in DOMParser first.
  const parsed=prepared || (record.file ? {file:record.file,metadata:structuredClone(record.metadata),nativeScroll:true,savedMetadata:true} : record.metadata ? (() => {
    const metadata = structuredClone(record.metadata);
    metadata.execution = {...(metadata.execution || {}), allowScripts: metadata.execution?.allowScripts===true};
    const html = typeof record.html === 'string'
      ? record.html.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy\b[^>]*>/gi, `<meta http-equiv="Content-Security-Policy" content="${SCRIPT_CSP}">`)
      : record.html;
    return {html, metadata, nativeScroll: record.nativeScroll || metadata.execution?.allowScripts || record.byteSize >= 4 * 1024 * 1024, savedMetadata: true};
  })() : parseHTML(record.html,{title:record.title,source:record.source,allowScripts:true}));
  const tab={id:uid(),type:'document',title:record.title,opening:true,persisted:!prepared,record:{...record,nativeScroll:!!parsed.nativeScroll},host:null};tab.host=createHost(tab.id,'document');
  tab.queue=new SaveQueue(async()=>{
    await tab.reader.ready;
    // Early scrolling/edits must not save before the import identity is ready.
    if(sourceIdentity)await sourceIdentity;
    if (!tab.queue.editsPending) {
      const saved = await putDocumentView(tab.record.id, tab.reader.metadata.view);
      tab.record.metadata = saved.metadata;tab.record.folderId=saved.folderId||'';
      cacheLibraryDocument(saved);
      return;
    }
    const html=tab.record.html; const metadata=structuredClone(tab.reader.metadata);
    tab.record.html=html;tab.record.metadata=metadata;tab.record.title=metadata.title;tab.record.modified=Date.now();
    await saveDocumentHTML(tab.record, html, {revision:{mustExist:tab.persisted,checkpoint:!!tab.restoredFrom,...(tab.restoredFrom?{restoredFrom:tab.restoredFrom}:{})}});
    tab.persisted=true;
    tab.restoredFrom=null;
    const {html:body,file:sourceFile,originalFile,...summary}=tab.record;
    cacheLibraryDocument(summary);
    delete tab.record.html;delete tab.record.file;delete tab.record.originalFile;
  },()=>{if(activeId===tab.id)saveStatus(tab);renderTabs();renderFolderState();});
  tab.checkpoints=new AnnotationCheckpoints(async()=>{await tab.queue.flush();await checkpointAnnotations(tab.record.id);},()=>{if(activeId===tab.id)saveStatus(tab);});
  tabs.push(tab);activate(tab.id);
  tab.reader=new Reader(tab.host,parsed,{
    onChange:()=>{tab.queue.schedule();tab.checkpoints.schedule();if(activeId===tab.id){renderToolbar();if(['annotations','bookmarks'].includes(sidebarMode))renderSidebar(sidebarMode);else updateSidebarCounts($('#sidebar'),tab.reader);tab.reader?.refreshDocumentSidebar();}},
    onAnnotationInput:()=>tab.checkpoints.activity(),
    onPosition:()=>{tab.queue.schedule({background:true});renderFolderState();},onSourceSettings:()=>{tab.queue.schedule({background:true});void tab.queue.flush().catch(showError);},onView:()=>{if(activeId===tab.id){updateChrome();updateToolbarState();}},
    onPreferenceChange:()=>dataFolder?.schedule({settingsOnly:true}),
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
  } catch(error) {tabs.splice(tabs.indexOf(tab),1);tab.checkpoints.dispose();tab.reader.dispose();activate('library');throw error;}
  if(parsed.file){tab.record.file=parsed.file;delete tab.record.html;tab.reader.initialHTML=null;tab.record.metadata=tab.reader.metadata;tab.record.source=tab.reader.metadata.source;tab.title=tab.record.title=tab.reader.metadata.title;}
  if(activeId===tab.id)restoreSidebar();
  renderToolbar();
  updateChrome();
  // Preserve the imported/current annotation baseline before the first new edit.
  try{const saved=await putDocumentRevision({...tab.record,metadata:baselineMetadata},{baseline:true,mustExist:tab.persisted});tab.persisted=true;tab.record.byteSize=saved.byteSize;tab.record.folderId=saved.folderId||'';delete tab.record.html;delete tab.record.file;delete tab.record.originalFile;}
  catch(error){tab.queue.schedule();try{await tab.queue.flush();}catch{showError(error);}}
  record.html=null;record.file=null;record.originalFile=null;parsed.html=null;parsed.file=null;
  if(!deferReady){tab.opening=false;renderTabs();if(activeId===tab.id)updateChrome();}
  return tab;
}
function saveStatus(tab) {
  const queue=tab.queue;if(!queue)return;
  const failure=queue.error||tab.checkpoints?.error;
  const label=queue.error?(queue.editsPending?'주석 자동 저장 실패 · ':'읽기 위치 저장 실패 · ')+queue.error.message:tab.checkpoints?.error?'주석은 자동 저장됨 · 이력 저장 실패 · '+tab.checkpoints.error.message:queue.editsPending||tab.opening?'저장 중…':'주석이 앱에 자동 저장됨';
  const status=$('#status-left');let state=$('.save-state',status);
  if(!state){status.replaceChildren();state=document.createElement('span');status.append(state);}
  const className=`save-state ${failure?'save-error':''}`;
  if(state.textContent.trim()!==label || state.className!==className){
    state.className=className;
    state.innerHTML=`${icon(failure?'more':queue.editsPending||tab.opening?'reload':'check',13)} ${esc(label)}`;
  }
  let retry=$('#retry-save');
  if(failure){
    if(!retry){retry=document.createElement('button');retry.id='retry-save';retry.className='text-button';status.append(retry);}
    retry.textContent='저장 재시도';retry.onclick=safely(async()=>{await tab.queue.flush();await tab.checkpoints?.flush({force:true});});
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
      if(tab.reader){await tab.reader.ready;tab.reader.rememberPosition();await tab.queue.flush();await tab.checkpoints.flush({force:true});tab.checkpoints.dispose();tab.reader.dispose();}else tab.host.remove();
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
  const title=parsed.metadata.title; const record={id:uid(),title,name:name||handle?.name||filename(title),source:parsed.metadata.source,created:Date.now(),modified:Date.now(),folderId:local.libraryFolderId??libraryFolderId,fileHandle:handle,originalHandle:local.originalHandle||null,metadata:parsed.metadata};
  if(snapshot.file)record.file=snapshot.file;else record.html=parsed.html;
  if(local.originalFile)record.originalFile=local.originalFile;
  if(local.sourceIdentity)record.sourceIdentity=local.sourceIdentity;
  if(local.diskStamp)record.diskStamp=local.diskStamp;
  else if(handle){const disk=await handle.getFile();record.diskStamp={modified:disk.lastModified,size:disk.size};}
  const {html:body,file:sourceFile,originalFile,...summary}=record;records=records.filter(r=>r.id!==record.id).concat(summary);let tab;
  try{tab=await openRecord(record,parsed,{deferReady:true,sourceIdentity:identity});}catch(error){records=records.filter(r=>r.id!==record.id);renderLibrary();throw error;}
  if(tab.closing || !tabs.includes(tab)){tab.opening=false;return tab;}
  tab.queue.schedule();
  try { await tab.queue.flush(); } catch(error) { showError(error); }
  if(tab.closing || !tabs.includes(tab)){tab.opening=false;return tab;}
  tab.opening=false;renderLibrary();activate(tab.id);
  if(tab.queue.error)return tab;
  if(tab.reader.bookIntegrity?.complete === false)toast(tab.reader.bookIntegrity.message, true);
  else if(parsed.metadata.warnings.length)toast(`페이지를 저장했습니다. ${parsed.metadata.warnings.length}개의 리소스를 보관하지 못했습니다. 문서 정보에서 확인할 수 있어요.`,true);
  else toast(local.originalHandle||name?'로컬 HTML을 주석 탭에서 열었습니다.':'서재에 저장하고 주석 탭에서 열었습니다.');
  return tab;
}
function dataFolderGuide() {
  return `<details class="export-guide" data-folder-guide><summary>전용 폴더 자동 저장과 새 기기로 옮기는 방법</summary><p>Documents(문서) 안에 <strong>이름을 정한 전용 하위 폴더 하나</strong>를 만들고 읽기·쓰기를 허용하세요. 예: <code>문서/HTMLMemo</code>. 브라우저 선택 창의 새 폴더 기능을 사용합니다.</p><p>연결하면 기존 서재와 앞으로 가져오는 모든 HTML·MHTML 문서의 복사본, 주석·북마크·주석 이력·읽기 위치·앱 설정을 자동 보관합니다. 원래 파일을 이동·삭제해도 보관한 문서는 열 수 있습니다. <strong>설정 파일을 따로 저장할 필요가 없습니다.</strong></p><p>폴더 연결 시 브라우저 내부 데이터의 자동 삭제 방지도 함께 요청합니다. 브라우저가 허용하지 않아도 전용 폴더 자동 저장은 계속됩니다.</p><p>평소에는 원본 복사본과 주석을 분리해 저장하며 원본에 새 주석을 합치지 않습니다. <strong>다른 사람에게 주석까지 보내려면 문서를 열고 상단의 HTML 내보내기로 .html 파일을 새로 저장한 뒤 그 파일을 보내세요.</strong> 원본 파일만 보내면 앱에서 추가한 주석은 전달되지 않습니다. 받는 분도 HTMLMemo의 HTML 파일 가져오기로 엽니다.</p><ol><li>새 기기로 옮기기 전에 <strong>폴더 자동 저장 완료</strong> 표시를 확인하고 앱을 닫습니다.</li><li><strong>전용 폴더 전체를 하위 폴더·파일 빠짐없이</strong> 새 기기의 Documents(문서) 폴더로 복사합니다. 일부 HTML만 옮기면 주석·설정이 빠집니다.</li><li>새 기기의 HTMLMemo에서 <strong>설정 → 데이터 폴더 → 폴더 연결</strong>로 옮긴 폴더를 선택하고 쓰기를 허용하면 모두 자동 복원됩니다.</li></ol><p>브라우저가 권한을 회수하거나 폴더를 옮겼다면 다시 연결해야 합니다. 권한·용량·저장 오류는 화면 아래와 설정에 계속 표시하며 변경은 앱에 남겨둡니다. 저장이 끝나기 전에 앱을 강제 종료하지 마세요. 서로 다른 기기의 동시 편집을 실시간 동기화하지는 않습니다.</p></details>`;
}
function folderStatusText() {
  if(!folder)return '데이터 폴더 미연결 · 브라우저 데이터 삭제 시 잃을 수 있습니다.';
  if(dataFolder?.state==='error')return '폴더 저장 중단 · '+folder.name+' · 다시 연결 필요';
  if(tabs.some(t=>t.queue?.error))return '앱 저장 실패 · 폴더가 최신 상태가 아닙니다.';
  if(dataFolder?.pending||tabs.some(t=>t.opening||t.queue?.pending))return '폴더 자동 저장 중… · '+folder.name;
  return '폴더 자동 저장 완료 · '+folder.name;
}
function renderFolderState() {
  const status=folderStatusText(),error=!!folder&&(dataFolder?.state==='error'||tabs.some(t=>t.queue?.error)),button=$('#data-folder-status');
  if(!button)return;
  button.textContent=folder?(error?'폴더 저장 중단':dataFolder?.pending||tabs.some(t=>t.opening||t.queue?.pending)?'폴더 저장 중…':'폴더 저장 완료'):'폴더 미연결';
  button.title=status;button.setAttribute('aria-label',status+' · 저장 위치 관리');button.classList.toggle('save-error',error||!!folder&&tabs.some(t=>t.queue?.error));
  if($('#settings-folder-status'))$('#settings-folder-status').textContent=status;
}
async function flushInternalDocuments() { for(const tab of tabs)if(tab.reader){await tab.reader.ready;tab.reader.rememberPosition();await tab.queue.flush();await tab.checkpoints.flush({force:true});} }
// Ask once per page, after an explicit folder connection has actually saved.
// This optional browser permission must not delay or fail the folder backup.
function protectBrowserStorage() {
  return browserStorageProtection ||= (async()=>{
    try{
      const storage=navigator.storage;
      if(typeof storage?.persist!=='function')return false;
      if(typeof storage.persisted==='function'&&await storage.persisted())return true;
      return await storage.persist();
    }catch{return false;}
  })();
}
async function connectDataFolder(selected,onConnected) {
  await flushInternalDocuments();
  await dataFolder.connect(selected);folder=dataFolder.handle;void protectBrowserStorage();await refreshLibrary();
  rememberFolderWelcome();
  $('#dialog').close();if(typeof onConnected==='function')onConnected();toast('문서·주석·설정을 '+folder.name+' 폴더에 자동 저장했습니다. 새 기기로는 폴더 전체를 옮기세요.');
}
function rememberFolderWelcome() { try{localStorage.setItem(FOLDER_WELCOME_KEY,'1');}catch{/* The unconnected reminder remains visible if this device cannot retain the choice. */} }
function needsFolderWelcome() { if(folder)return false;try{return !localStorage.getItem(FOLDER_WELCOME_KEY);}catch{return true;} }
function chromeRequiredDialog() {
  $('#status-left').textContent='Chrome에서 실행해주세요.';
  modal(`<section class="folder-welcome" data-chrome-required><div class="dialog-heading"><h2>Google Chrome에서 실행해주세요</h2></div><p id="chrome-required-message" class="folder-welcome-intro"><strong>${esc(CHROME_REQUIRED_MESSAGE)}</strong></p><p class="dialog-description">Chrome에서 아래 앱 주소를 열어주세요. 전용 저장 폴더를 지원하는 최신 Chrome이 필요합니다.</p><label class="paste-label" for="chrome-app-url">HTMLMemo 주소</label><input id="chrome-app-url" class="paste-title" type="url" readonly value="${esc(PUBLIC_APP_URL)}"><p id="chrome-copy-status" class="dialog-description small" role="status" aria-live="polite"></p><div class="dialog-actions folder-welcome-actions"><button id="chrome-copy-url" class="primary-button" type="button">앱 주소 복사</button><a class="secondary-button" href="https://www.google.com/chrome/" target="_blank" rel="noopener noreferrer">Chrome 다운로드</a></div></section>`,dialog=>{
    dialog.setAttribute('aria-describedby','chrome-required-message');dialog.oncancel=event=>event.preventDefault();
    const button=$('#chrome-copy-url'),input=$('#chrome-app-url'),status=$('#chrome-copy-status');
    button.onclick=async()=>{
      if(button.disabled)return;button.disabled=true;
      try{await navigator.clipboard.writeText(PUBLIC_APP_URL);status.textContent='앱 주소를 복사했습니다. Chrome 주소창에 붙여넣어 실행해주세요.';}
      catch{input.focus();input.select();status.textContent='선택된 앱 주소를 직접 복사해 Chrome 주소창에 붙여넣어주세요.';}
      finally{button.disabled=false;}
    };
    button.focus();
  });
}
function folderWelcomeDialog() {
  if(!supportsDataFolder(window,navigator))return chromeRequiredDialog();
  modal(`<section class="folder-welcome" data-folder-welcome><div class="dialog-heading"><h2>먼저, 전용 폴더를 만들어요</h2></div><p class="folder-welcome-intro">처음 한 번 연결하면 <strong>문서·주석·설정을 이 폴더에 자동 저장</strong>합니다. 저장할 때마다 파일이나 위치를 고를 필요가 없어요.</p><ol class="folder-welcome-steps"><li><strong>문서(Documents) 폴더를 여세요.</strong><p>아래 <b>폴더 선택 창 열기</b> 버튼을 누르면 시작합니다.</p></li><li><strong>새 폴더를 만들고 이름을 정하세요.</strong><p>선택 창의 <b>새 폴더</b>로 <b>HTMLMemo</b>처럼 원하는 이름을 짓고, 그 폴더를 선택하세요. 문서 폴더 전체가 아닌, 방금 만든 폴더입니다.</p></li><li><strong>폴더 사용과 쓰기를 허용하세요.</strong><p><b>폴더 선택</b>(또는 <b>열기</b>) 후 권한 창에서 <b>허용</b>을 누르세요. <b>방문할 때마다 허용</b>이 있으면 선택하세요.</p></li></ol><details class="folder-welcome-existing"><summary>다른 기기에서 옮겨 온 폴더가 있나요?</summary><p>새로 만들지 말고 <b>같은 버튼</b>으로 옮겨 온 전용 폴더를 선택하세요. 그 안의 문서·주석·설정이 자동 복원됩니다.</p></details><p class="folder-welcome-move">새 기기로 옮길 때는 <strong>이 폴더 전체</strong>를 복사하면 됩니다.</p><p id="folder-connection-status" class="folder-welcome-status" role="status" aria-live="polite">폴더 선택 창은 버튼을 누른 뒤에만 열립니다.</p><div class="dialog-actions folder-welcome-actions"><button id="select-storage-folder" class="primary-button" type="button">폴더 선택 창 열기</button><button id="folder-welcome-later" class="secondary-button" type="button">나중에 연결</button></div><p class="folder-welcome-warning">나중에 연결하면 당분간 브라우저 안에만 저장됩니다. 브라우저 데이터를 지우면 문서와 주석을 잃을 수 있어요. <b>설정 → 데이터 폴더 → 폴더 연결</b>에서 다시 시작할 수 있습니다.</p></section>`,dialog=>{
    $('#folder-welcome-later').onclick=()=>{rememberFolderWelcome();dialog.close();$('#settings-button').focus();};
    dialog.oncancel=event=>{if($('#select-storage-folder')?.disabled){event.preventDefault();return;}rememberFolderWelcome();requestAnimationFrame(()=>$('#settings-button').focus());};
    bindFolderConnection();
    $('#select-storage-folder').focus();
  });
}
function bindFolderConnection(onConnected) {
  const button=$('#select-storage-folder'),status=$('#folder-connection-status');
  const connect=async(usePrevious=false)=>{
    if(button.disabled)return;
    button.disabled=true;const resume=$('#resume-data-folder'),later=$('#folder-welcome-later');if(resume)resume.disabled=true;if(later)later.disabled=true;let selected;
    try{
      // The native picker/permission request must be the first operation in the user's click.
      if(usePrevious){selected=folder;await selected.requestPermission?.({mode:'readwrite'});}
      else selected=await window.showDirectoryPicker({id:'htmlmemo-storage-v2',mode:'readwrite',startIn:folder||'documents'});
      status.textContent='문서·주석·설정을 복원하고 폴더에 저장하는 중… 앱을 닫지 마세요.';
      await connectDataFolder(selected,onConnected);
    }catch(error){
      folder=dataFolder.handle||folder;renderFolderState();
      if(error?.name==='AbortError')status.textContent=later?'폴더 선택을 취소했습니다. 아래 버튼을 눌러 다시 시작하거나 나중에 연결할 수 있어요.':'폴더 연결은 변경하지 않았습니다. 연결하려면 전용 하위 폴더를 선택하세요.';
      else if(['NotAllowedError','SecurityError'].includes(error?.name))status.textContent='브라우저가 폴더 연결을 허용하지 않았습니다. 문서/HTMLMemo 같은 전용 하위 폴더를 선택하고 쓰기를 허용하세요.';
      else status.textContent='폴더에 저장하지 못했습니다. 기존 문서는 유지됩니다. '+(error?.message||String(error));
    }finally{button.disabled=false;if(resume)resume.disabled=false;if(later)later.disabled=false;}
  };
  button.onclick=safely(()=>connect());if($('#resume-data-folder'))$('#resume-data-folder').onclick=safely(()=>connect(true));
}
function chooseFolder({onConnected} = {}) {
  if(!supportsDataFolder(window,navigator)){chromeRequiredDialog();return;}
  modal(`<div class="dialog-heading"><h2>저장 폴더 연결</h2><button class="icon-button" data-dialog-close aria-label="닫기">${icon('close')}</button></div><p class="dialog-description">Documents(문서) 안의 <strong>HTMLMemo 전용 하위 폴더</strong>를 선택하세요. 선택 창에서 <strong>원하는 이름의 새 폴더</strong>를 만들 수 있습니다. 예: <code>문서/HTMLMemo</code>.</p><p class="dialog-description small">홈·문서·다운로드 폴더 전체와 시스템 폴더는 브라우저가 연결을 제한합니다. “Can't open this folder”가 나오면 전용 하위 폴더를 선택하세요. 읽기·쓰기 권한을 허용하며, “방문할 때마다 허용” 선택지가 있으면 선택하세요.</p><p class="dialog-description">기존 서재도 이곳에 복사하며 이후 가져오는 문서·주석·설정은 자동 저장합니다. <strong>옮겨 온 데이터 폴더를 선택하면 자동 복원</strong>합니다. 기존 문서와 충돌하는 복원본은 별도 사본으로 남겨 덮어쓰지 않습니다.</p><p class="dialog-description"><strong>새 기기로는 이 폴더 전체를 옮기세요.</strong> 설정 JSON을 별도로 저장할 필요가 없습니다. 모든 하위 파일을 함께 복사해야 합니다.</p>${dataFolderGuide()}<p id="folder-connection-status" class="dialog-description" role="status">${esc(folderStatusText())}</p><div class="dialog-actions"><button class="secondary-button" data-dialog-close>닫기</button>${folder?'<button id="resume-data-folder" class="secondary-button">다시 연결</button>':''}<button id="select-storage-folder" class="primary-button">${folder?'다른 폴더 선택':'폴더 선택'}</button></div>`,()=>{
    bindFolderConnection(onConnected);
  });
}
async function importFiles() {
  const parentId=libraryFolderId;
  if(!openPicker()){$('#file-input').click();return;}
  let handles;try{handles=await window.showOpenFilePicker({types:importTypes,multiple:true});}catch(error){if(['SecurityError','NotSupportedError'].includes(error.name)){$('#file-input').click();return;}throw error;}
  for(const handle of handles)await openLocalFile(handle,parentId);
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
function openLocalFile(input,parentId=libraryFolderId) {
  // File picker, input, drop and launch events share one queue. Concurrent
  // imports must not overwrite a pending three-way choice or miss each other.
  const pending=localImportQueue.then(()=>importLocalFile(input,parentId));
  localImportQueue=pending.catch(()=>{});return pending;
}
async function importLocalFile(input,parentId) {
  try{
    $('#status-left').textContent='로컬 HTML을 읽고 중복을 확인하는 중…';
    const local=await readLocalHTML(input,{native:true,allowScripts:true,identify:false});
    local.libraryFolderId=parentId;
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
    const saved=await createDocument(snapshot);return !saved?.queue?.error;
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
  toast('현재 주석을 포함한 HTML을 내보냈습니다. 저장한 .html 파일을 보내세요.');
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
  if(reader())toast('읽던 문서로 돌아왔습니다. 복사한 글은 내 서재 → 텍스트 붙여넣기로 가져오세요.');
}
function renderExternalTab(tab){
  const search=isWebSearch(tab.url);
  tab.host.innerHTML=`<div class="browser-handoff"><div class="handoff-heading">${icon('external',32)}<p class="eyebrow">CHROME · HTMLMEMO</p><h2>${search?'검색은 Chrome에서, 메모는 여기서.':'웹 탐색은 Chrome에서, 주석은 여기서.'}</h2><p data-single-file-guide>외부 사이트는 이 앱을 연 브라우저의 일반 탭에서 엽니다.<br>브라우저의 페이지 저장에서 <strong>Webpage, Single File</strong>(웹페이지, 단일 파일 · .mhtml) 형식을 선택한 다음, HTMLMemo에서 여세요.</p></div><p class="web-notice" data-web-status role="status"></p><div class="web-actions"><button class="primary-button" data-browser-focus>브라우저로 전환 ${icon('external',15)}</button><button class="secondary-button" data-browser-paste>글 붙여넣고 주석 달기</button><button class="secondary-button" data-browser-import>HTML 파일 가져오기</button></div><p class="handoff-return">Chrome 탭에서 필요한 글을 복사한 뒤 HTMLMemo 탭으로 돌아오세요.<br>읽던 문서와 주석은 그대로 유지됩니다. <kbd>Ctrl/⌘ Shift V</kbd>로 붙여넣기 창을 바로 열 수 있습니다.</p><details class="handoff-details"><summary>보낸 주소 · 직접 가져오기</summary><a data-open-external href="${esc(tab.url)}" target="_blank" rel="noopener noreferrer">${esc(tab.url)} ${icon('external',13)}</a><p>이 주소는 HTMLMemo에서 마지막으로 보낸 주소입니다. Chrome에서 이동한 현재 주소는 읽지 않습니다. 검색 결과의 글을 가져올 때는 붙여넣기 창에 실제 원문 주소를 넣으세요.</p><button class="secondary-button" data-capture${search?' disabled':''}>이 주소에서 직접 저장</button><p>검색 페이지는 직접 저장하지 않습니다. 일반 페이지도 사이트가 읽기를 허용할 때만 저장됩니다.</p></details></div>`;
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
  tab.host.innerHTML=`<div class="browser-note"><span>${icon('globe',15)} 앱 문서 미리보기</span><a class="text-button" data-open-external href="${esc(url)}" target="_blank" rel="noopener noreferrer">새 탭에서 열기 ${icon('external',13)}</a><button class="text-button" data-capture>페이지 저장 ${icon('save',13)}</button><button class="text-button" data-web-help>가져오기 안내</button></div><div class="web-status" data-web-status role="status"></div><iframe class="browser-frame" title="앱 문서 미리보기" sandbox="allow-same-origin" referrerpolicy="no-referrer"></iframe>`;
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
function toolbarButton(action,name,label,extra='',content=icon(name,18)) {return `<button class="tool-button" data-action="${action}" aria-label="${label}" title="${label}" ${extra}>${content}</button>`;}
function penSettingsButton() {return toolbarButton('palette','palette','펜과 색상','','<span class="pen-settings-lines" aria-hidden="true"><span class="pen-settings-stroke"></span><span class="pen-settings-duration"><span class="pen-settings-alpha"></span></span></span>');}
function annotationToolFamily(tool) {return {area:'highlight','area-underline':'underline',text:'note','rect-filled':'rect'}[tool]||tool;}
function annotationToolMode(r) {return r.tool==='rect'&&r.rectFill?'rect-filled':r.tool;}
function annotationToolModes(group) {
  return {
    highlight:{title:'형광펜',key:'H',modes:[['highlight','highlight','글자 형광펜','선택한 글자를 따라 표시'],['area','area','영역 형광펜','원하는 영역을 드래그해 표시']]},
    underline:{title:'밑줄',key:'U',modes:[['underline','underline','글자 밑줄','선택한 글자를 따라 표시'],['area-underline','area-underline','영역 밑줄','원하는 위치에 직접 그리기']]},
    note:{title:'메모 · 텍스트',key:'N',modes:[['note','note','메모 상자','상자 안에 메모 쓰기'],['text','text','자유 텍스트','배경 상자 없이 글자만 쓰기']]},
    rect:{title:'사각형',key:'R',modes:[['rect','rect','채움 없음','테두리만 그리기'],['rect-filled','rect-filled','채움 있음','형광펜/채움 투명도로 내부 채우기']]},
    eraser:{title:'지우개',key:'E',modes:[['eraser','eraser','개별 주석 지우기','지울 주석을 직접 선택'],['clear','trash','주석 모두 지우기','확인한 뒤 전체 삭제 · 실행 취소 가능',true]]},
  }[group];
}
function showAnnotationToolModes(group, keyboard = false) {
  const r=reader(),definition=annotationToolModes(group);if(!r||!definition)return;
  const current=annotationToolFamily(r.tool)===group?annotationToolMode(r):r.toolChoices?.[group]||group;
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
  $('#toolbar').innerHTML=`<button class="toolbar-grip" aria-label="툴바 이동">${icon('grip',14)}</button><span class="tool-group">${toolbarButton('select','select','선택 / 읽기 (V) · 주석을 드래그해 이동')}${toolbarButton('pen','pen','펜 (P)')}${toolbarButton('highlight','highlight','형광펜 (H)')}${toolbarButton('underline','underline','밑줄 (U)')}${toolbarButton('rect','rect','사각형 (R)')}${toolbarButton('eraser','eraser','지우개 (E)')}${toolbarButton('note','note','메모 (N)')}${penSettingsButton()}<span class="tool-group toolbar-history">${toolbarButton('undo','undo','실행 취소 (Ctrl/⌘ Z)')}${toolbarButton('redo','redo','다시 실행 (Ctrl/⌘ Shift Z)')}</span>${toolbarButton('more','more','더 많은 도구')}</span>`;
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
    if(['select','pen','highlight','underline','rect','eraser','note'].includes(action))button.setAttribute('aria-pressed',String(selected));
    const definition=annotationToolModes(action);
    if(definition){
      const mode=definition.modes.find(([id])=>id===(selected?annotationToolMode(r):r.toolChoices?.[action]))||definition.modes[0];
      button.innerHTML=icon(mode[1],18);button.title=`${definition.title}: ${mode[2]} (${definition.key}) · 다시 누르거나 ↓ 키로 방식 선택`;
      button.setAttribute('aria-label',button.title);
    }
  });
  const undo=$('[data-action="undo"]',$('#toolbar'));if(undo)undo.disabled=!r.history.canUndo;
  const redo=$('[data-action="redo"]',$('#toolbar'));if(redo)redo.disabled=!r.history.canRedo;
  r.updateReadingControls?.();
  const palette=$('[data-action="palette"]',$('#toolbar'));
  if(palette){
    palette.style.setProperty('--tool-color',r.color);palette.style.setProperty('--tool-opacity',r.opacity);palette.style.setProperty('--tool-width-preview',(1+(Math.min(18,Math.max(1,r.width))-1)*5/17).toFixed(2)+'px');
    palette.style.setProperty('--tool-time-preview',({0:100,3:25,10:50,30:75}[r.penTTL]??100)+'%');
    palette.title=`펜과 색상 · 색상 ${r.color.toUpperCase()} · 굵기 ${r.width}px · 형광펜/채움 투명도 ${Math.round(r.opacity*100)}% · 펜 표시 시간 ${r.penTTL?r.penTTL+'초':'영구 저장'}`;
    palette.setAttribute('aria-label',palette.title);
  }
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
    + `<label class="range-label">굵기 <output id="width-output">${r.width}px</output><input id="pen-width" type="range" min="1" max="18" value="${r.width}"></label><label class="range-label">형광펜/채움 투명도 <output id="opacity-output">${Math.round(r.opacity*100)}%</output><input id="pen-opacity" type="range" min="10" max="90" value="${Math.round(r.opacity*100)}"></label><label class="select-label">펜 표시 시간 <select id="pen-ttl"><option value="0">영구 저장</option><option value="3">3초</option><option value="10">10초</option><option value="30">30초</option></select></label><p class="popover-hint">시간을 정한 펜은 잠깐 표시되고 저장되지 않아요.</p>`
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
  if(['select','pen','highlight','underline','eraser','note','text','rect','rect-filled','circle','ellipse','arrow','area','area-underline','strike'].includes(action)){
    if(['highlight','area','underline','area-underline','note','text','rect','rect-filled'].includes(action)){r.toolChoices||={};r.toolChoices[annotationToolFamily(action)]=action;}
    if(action==='rect'||action==='rect-filled')r.rectFill=action==='rect-filled';
    closePopover();r.setTool(action==='rect-filled'?'rect':action);updateToolbarState();return;
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
    const items=[['circle','circle','원'],['ellipse','ellipse','타원'],['arrow','arrow','화살표'],['strike','strike','취소선'],['history','history','주석 저장 이력'],['migrate','file-transfer','새 판으로 주석 옮기기'],['info','info','문서 정보']];
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
  stopAppSidebarResize();
  const panel=$('#sidebar'),wasOpen=!panel.hidden,r=panel.annotationReader;
  clearTimeout(panel.sidebarSearchTimer);panel.sidebarMode='';sidebarMode='';panel.hidden=true;$('#workspace')?.removeAttribute('data-app-sidebar');
  if(wasOpen&&r){if(remember)r.appSidebarClosed=true;if(clearSearch&&r.documentSidebarMode!=='search'){r.sidebarSearchQuery='';r.search('');}}
}
function appSidebarMaxWidth() {return Math.max(8,Math.min(640,innerWidth-(innerWidth>720?240:40)));}
function applyAppSidebarWidth(value=preferences.sidebarWidth) {
  const width=Math.round(Math.max(8,Math.min(appSidebarMaxWidth(),Number(value)||300))),root=document.documentElement,handle=$('#sidebar-resizer');
  if(root.style.getPropertyValue('--app-sidebar-width')!==width+'px')root.style.setProperty('--app-sidebar-width',width+'px');
  $('#sidebar')?.toggleAttribute('data-app-sidebar-strip',width===8);
  if(handle)for(const [name,value] of Object.entries({'aria-valuemin':8,'aria-valuemax':appSidebarMaxWidth(),'aria-valuenow':width,'aria-valuetext':width+'픽셀'}))handle.setAttribute(name,String(value));
  return width;
}
function saveAppSidebarWidth(width) {
  try{changePreferences({sidebarWidth:width});}catch(error){applyAppSidebarWidth();showError(error);}
}
function stopAppSidebarResize({cancel=true}={}) {
  const panel=$('#sidebar'),gesture=panel?.sidebarResize;if(!gesture)return false;panel.sidebarResize=null;
  gesture.cleanup();document.documentElement.removeAttribute('data-app-sidebar-resizing');
  try{if(gesture.handle.hasPointerCapture?.(gesture.pointerId))gesture.handle.releasePointerCapture(gesture.pointerId);}catch{/* A cancelled pointer may already be released. */}
  if(cancel)applyAppSidebarWidth();else if(gesture.current!==gesture.width)saveAppSidebarWidth(gesture.current);
  return true;
}
function bindAppSidebarResize(panel) {
  let handle=$('#sidebar-resizer',panel);
  if(!handle){handle=document.createElement('div');handle.id='sidebar-resizer';handle.className='sidebar-resizer';handle.setAttribute('role','separator');handle.setAttribute('aria-orientation','vertical');handle.setAttribute('aria-controls','sidebar');handle.setAttribute('aria-label','사이드바 폭 조절');handle.setAttribute('tabindex','0');handle.title='드래그하거나 ←/→ 키로 폭 조절 · 두 번 클릭하면 기본 폭';panel.append(handle);}
  applyAppSidebarWidth();
  handle.onpointerdown=event=>{
    if(event.button!==0)return;if(panel.sidebarResize){stopAppSidebarResize();return;}
    event.preventDefault();event.stopPropagation();handle.focus?.({preventScroll:true});
    const width=applyAppSidebarWidth(),gesture={handle,pointerId:event.pointerId,startX:event.clientX,width,current:width};panel.sidebarResize=gesture;document.documentElement.setAttribute('data-app-sidebar-resizing','');
    const move=e=>{if(e.pointerId!==gesture.pointerId)return;e.preventDefault();gesture.current=applyAppSidebarWidth(gesture.width+e.clientX-gesture.startX);};
    const up=e=>{if(e.pointerId!==gesture.pointerId)return;if(e.pointerType!=='touch')move(e);stopAppSidebarResize({cancel:false});};
    const cancel=e=>{if(e.pointerId==null||e.pointerId===gesture.pointerId)stopAppSidebarResize();};
    gesture.cleanup=()=>{document.removeEventListener('pointermove',move,true);document.removeEventListener('pointerup',up,true);document.removeEventListener('pointercancel',cancel,true);handle.removeEventListener('lostpointercapture',cancel);window.removeEventListener('blur',cancel);};
    document.addEventListener('pointermove',move,{capture:true,passive:false});document.addEventListener('pointerup',up,true);document.addEventListener('pointercancel',cancel,true);handle.addEventListener('lostpointercapture',cancel);window.addEventListener('blur',cancel);
    try{handle.setPointerCapture?.(event.pointerId);}catch{/* Document listeners also track a mouse over the reader. */}
  };
  handle.onkeydown=event=>{
    if(event.key==='Escape'&&panel.sidebarResize){event.preventDefault();event.stopPropagation();stopAppSidebarResize();return;}
    if(!['ArrowLeft','ArrowRight','Home','End','Enter'].includes(event.key))return;
    event.preventDefault();event.stopPropagation();stopAppSidebarResize();
    const width=applyAppSidebarWidth(),next=event.key==='Home'?8:event.key==='End'?appSidebarMaxWidth():event.key==='Enter'?300:Math.max(8,Math.min(appSidebarMaxWidth(),width+(event.key==='ArrowRight'?1:-1)*(event.shiftKey?40:10)));
    saveAppSidebarWidth(next);applyAppSidebarWidth();
  };
  handle.ondblclick=event=>{event.preventDefault();event.stopPropagation();stopAppSidebarResize();saveAppSidebarWidth(300);applyAppSidebarWidth();};
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
  if(!embedded)stopAppSidebarResize();
  const outline=embedded?[]:r.outline();
  if(!embedded&&mode==='outline'&&!outline.length)mode='search';
  if(embedded&&$('#sidebar').annotationReader===r)closeSidebar({remember:false,clearSearch:false});
  for(const type of ['annotation','bookmark']){
    r[type+'TreeOpen'] ||= new Map();
    if(panel.annotationReader===r)$$(`[data-${type}-group]`,panel).forEach(group=>r[type+'TreeOpen'].set(group.getAttribute(`data-${type}-group`),!!(group.open||group.hasAttribute('open'))));
  }
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
      if(['annotations','bookmarks'].includes(view)&&panel.sidebarMode===view){
        const type=view==='annotations'?'annotation':'bookmark';
        panel.annotationReader?.[type+'TreeOpen']?.clear();
        for(const group of $$(`[data-${type}-group]`,panel)){group.open=false;group.removeAttribute('open');}
        return;
      }
      return embedded?panel.annotationReader.showDocumentSidebarView(view):renderSidebar(view);
    });
  }
  if(!embedded)bindAppSidebarResize(panel);
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
    const row=mark=>`<div class="bookmark-row"><button class="outline-item" data-bookmark="${esc(mark.id)}" title="${esc(mark.title)}">${icon('bookmark',14)} ${esc(mark.title)}</button><button class="icon-button" data-delete-bookmark="${esc(mark.id)}" aria-label="북마크 삭제">${icon('close',13)}</button></div>`;
    const tree=r.bookmarkTree?.()||[{id:'document',title:'문서 전체',count:r.metadata.bookmarks.length,bookmarks:r.metadata.bookmarks,children:[]}];
    const branch=group=>`<details class="annotation-group" data-bookmark-group="${esc(group.id)}"${r.bookmarkTreeOpen.get(group.id)?' open':''}><summary><span class="annotation-group-title">${esc(group.title)}</span><span class="annotation-group-count" aria-label="${group.count}개 북마크">${group.count}</span></summary><div class="annotation-group-body">${group.children.map(branch).join('')}${group.bookmarks.map(row).join('')}</div></details>`;
    content.innerHTML=`<div class="sidebar-bookmark-list">${r.metadata.bookmarks.length?`<div class="annotation-tree bookmark-tree" aria-label="목차별 북마크">${tree.map(branch).join('')}</div>`:'<p class="panel-empty">저장한 북마크가 없습니다.</p>'}<button id="${id('add-bookmark')}" class="text-button">+ 현재 위치 저장</button></div>`;
    $$('[data-bookmark-group]',panel).forEach(group=>group.ontoggle=()=>{if(group.isConnected)r.bookmarkTreeOpen.set(group.dataset.bookmarkGroup,!!(group.open||group.hasAttribute('open')));});
    $$('[data-bookmark]',panel).forEach(button=>button.onclick=()=>r.jumpBookmark(button.dataset.bookmark));
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
async function annotationHistory(tab, selection = {}, valid = () => true) {
  await tab.reader.ready;await tab.queue.flush();
  const id=tab.record.id,years=await listRevisionPeriods(id);
  const year=years.find(row=>String(row.value)===String(selection.year))?.value??years[0]?.value;
  const months=year===undefined||year==='unknown'?[]:await listRevisionPeriods(id,year);
  const month=months.find(row=>row.value===Number(selection.month))?.value??months[0]?.value;
  const days=month===undefined?[]:await listRevisionPeriods(id,year,month);
  const day=days.find(row=>row.value===Number(selection.day))?.value??days[0]?.value;
  const state={...selection,year,month,day,pages:selection.pages||[]};
  const [{rows:versions,next},previousDay,nextDay]=year===undefined?[{rows:[],next:null},null,null]:await Promise.all([listRevisionDay(id,state,state.before),adjacentRevisionDay(id,state,'previous'),adjacentRevisionDay(id,state,'next')]);
  if(!valid())return;
  const total=years.reduce((sum,row)=>sum+row.count,0),count=year==='unknown'?years.find(row=>row.value==='unknown')?.count||0:days.find(row=>row.value===day)?.count||0;
  const latest=year===years[0]?.value&&month===months[0]?.value&&day===days[0]?.value&&!state.before;
  const dateLabel=year==='unknown'?'날짜 미확인':`${year}년 ${month}월 ${day}일`;
  const options=(rows,unit)=>rows.map(row=>`<option value="${row.value}">${row.value==='unknown'?'날짜 미확인':row.value+unit} (${row.count.toLocaleString('ko-KR')}개)</option>`).join('');
  const stamp=value=>value===null||!Number.isFinite(new Date(value).getTime())?'날짜 미확인':new Date(value).toLocaleString('ko-KR',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
  modal(`<div class="revision-browser"><div class="dialog-heading"><h2>주석 저장 이력</h2><button class="icon-button" data-dialog-close aria-label="닫기">${icon('close')}</button></div><p class="dialog-description">본문은 유지하고 선택한 시점의 주석과 북마크만 복원합니다. 복원 직전 상태도 이력에 남습니다.</p><div class="revision-calendar" aria-label="이력 날짜 선택"><label>연도<select id="history-year"${years.length?'':' disabled'}>${options(years,'년')}</select></label><label>월<select id="history-month"${months.length?'':' disabled'}>${options(months,'월')}</select></label><label>일<select id="history-day"${days.length?'':' disabled'}>${options(days,'일')}</select></label></div><div class="revision-date-nav"><button id="history-prev-day" class="secondary-button"${previousDay?'':' disabled'}>이전 날짜</button><button id="history-latest" class="secondary-button"${latest||!total?' disabled':''}>최근 이력</button><button id="history-next-day" class="secondary-button"${nextDay?'':' disabled'}>다음 날짜</button></div><p id="history-summary" class="dialog-description small" role="status">전체 ${total.toLocaleString('ko-KR')}개${total?` · ${dateLabel} · ${count.toLocaleString('ko-KR')}개 중 ${state.pages.length*50+1}–${state.pages.length*50+versions.length}개`:''}</p><div class="revision-list" aria-label="선택한 날짜의 저장 이력">${versions.map((version,index)=>`<button class="menu-button" data-revision="${version.id}"><span>${esc(stamp(version.created))} · #${version.id}<br><small>${version.kind==='restore'?'복원 저장':version.kind==='baseline'?'최초 보관':'주석 변경'} · 주석 ${version.annotationCount}개 · 북마크 ${version.bookmarkCount}개${index===0&&latest?' · 최근 저장':''}</small></span></button>`).join('') || '<p>아직 저장된 이력이 없습니다.</p>'}</div>${state.pages.length||next?`<div class="revision-page-nav"><button class="secondary-button" id="history-newer"${state.pages.length?'':' disabled'}>앞 50개</button><button class="secondary-button" id="history-older"${next?'':' disabled'}>이전 이력 50개</button></div>`:''}<details class="revision-help"><summary>자동 저장·이력 보관 안내</summary><p id="history-save-policy" class="dialog-description small">작업은 빠르게 자동 저장합니다. 이력은 변경이 있을 때 5분마다 또는 주석 입력을 멈춘 뒤 1분이 지났을 때 중 먼저 해당하는 시점에 묶어 보관합니다. 문서를 닫을 때도 남기며, 같은 내용은 중복 보관하지 않습니다.</p><p class="dialog-description small">이력이 있는 연·월·일만 표시합니다. 날짜는 이 기기의 시간대를 따르며, 선택한 날짜의 이력을 50개씩 불러옵니다. 이력은 이 기기에 보관하며 데이터 폴더를 연결하면 함께 자동 저장합니다. HTML 내보내기에는 현재 주석만 포함됩니다.</p></details></div>`,dialog=>{
    const root=$('.revision-browser',dialog),list=$('.revision-list',root);list.scrollTop=state.scroll||0;
    $('#history-year').value=year??'';$('#history-month').value=month??'';$('#history-day').value=day??'';
    let busy=false;
    const load=async(nextSelection,focus)=>{
      if(busy)return;busy=true;root.setAttribute('aria-busy','true');
      const controls=$$('select,button:not([data-dialog-close])',root),disabled=controls.map(button=>button.disabled);controls.forEach(button=>button.disabled=true);
      try{await annotationHistory(tab,nextSelection,()=>dialog.open&&dialog.contains(root));if(dialog.open&&focus)$(focus,dialog)?.focus();}
      finally{if(root.isConnected){root.removeAttribute('aria-busy');controls.forEach((button,index)=>button.disabled=disabled[index]);busy=false;}}
    };
    $('#history-year').onchange=safely(event=>load({year:event.target.value},'#history-year'));
    $('#history-month').onchange=safely(event=>load({year,month:Number(event.target.value)},'#history-month'));
    $('#history-day').onchange=safely(event=>load({year,month,day:Number(event.target.value)},'#history-day'));
    $('#history-prev-day').onclick=safely(()=>load(previousDay,'#history-prev-day'));
    $('#history-next-day').onclick=safely(()=>load(nextDay,'#history-next-day'));
    $('#history-latest').onclick=safely(()=>load({},'#history-latest'));
    if($('#history-older'))$('#history-older').onclick=safely(()=>load({...state,before:next,pages:[...state.pages,state.before||null],scroll:0},'#history-newer'));
    if($('#history-newer'))$('#history-newer').onclick=safely(()=>load({...state,before:state.pages.at(-1),pages:state.pages.slice(0,-1),scroll:0},'#history-older'));
    $$('[data-revision]',root).forEach(button=>button.onclick=safely(async()=>{
      if(busy)return;
      const version=await getRevision(Number(button.dataset.revision));
      if(!dialog.open||!dialog.contains(root))return;
      if(!version || version.documentId!==tab.record.id)throw Error('저장 이력을 찾지 못했습니다.');
      const back={...state,scroll:list.scrollTop};
      modal(`<div class="dialog-heading"><h2>주석 이력 확인</h2><button class="icon-button" data-dialog-close aria-label="닫기">${icon('close')}</button></div><p>${esc(stamp(version.created))} · #${version.id}</p><p>주석 ${version.annotations.length}개 · 북마크 ${version.bookmarks.length}개</p><div class="revision-preview">${version.annotations.slice(0,100).map(a=>`<p>${esc(a.type)} · ${esc((a.text || a.textAnchor?.quote || '그림 주석').slice(0,500))}</p>`).join('') || '<p>주석 없음</p>'}${version.annotations.length>100?'<p>미리보기는 100개까지 표시합니다. 복원은 모든 주석에 적용됩니다.</p>':''}</div><div class="dialog-actions"><button class="secondary-button" id="history-back">이력 목록</button><button class="primary-button" id="restore-revision">이 시점으로 복원</button></div>`,()=>{
        const preview=$('.revision-preview',dialog);
        $('#history-back').onclick=safely(async()=>{await annotationHistory(tab,back,()=>dialog.open&&dialog.contains(preview));if(dialog.open)$(`[data-revision="${version.id}"]`,dialog)?.focus({preventScroll:true});});
        $('#restore-revision').onclick=safely(async()=>{
          // Flush current edits first, so restoration itself never destroys the state being replaced.
          await tab.queue.flush();
          tab.reader.metadata.bookmarks=structuredClone(version.bookmarks);
          tab.restoredFrom=version.id;
          tab.reader.commit(structuredClone(version.annotations));
          await tab.queue.flush();await tab.checkpoints.flush();$('#dialog').close();
          if(sidebarMode)renderSidebar(sidebarMode);
          toast('HTML 본문은 유지하고 주석과 북마크를 복원했습니다.');
        });
      });
    }));
  });
}
function documentInfo(tab) {
  const m=tab.reader.metadata;
  modal(`<div class="dialog-heading"><h2>문서 정보</h2><button class="icon-button" data-dialog-close aria-label="닫기">${icon('close')}</button></div><dl class="document-info"><dt>제목</dt><dd>${esc(m.title)}</dd><dt>파일</dt><dd>${esc(tab.record.name)}</dd><dt>원본</dt><dd>${m.source?`<a href="${esc(m.source)}" target="_blank" rel="noopener noreferrer">${esc(m.source)}</a>`:'로컬 HTML 파일'}</dd><dt>저장 위치</dt><dd>앱 보관함 (원본 파일은 변경하지 않음)</dd><dt>주석</dt><dd>${m.annotations.length}개</dd></dl>${m.warnings.length?`<details class="capture-warnings"><summary>보관하지 못한 리소스 ${m.warnings.length}개</summary><ul>${m.warnings.map(w=>`<li>${esc(w)}</li>`).join('')}</ul></details>`:''}<p class="dialog-description small">작업은 이 기기의 서재에 자동 저장됩니다. 다른 사람에게 주석을 보내려면 HTML 내보내기로 저장한 .html 파일을 보내세요.</p>${annotationExportGuide()}`);
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
async function finishTrashChange(message) {
  await refreshLibrary();
  try{await dataFolder?.flush();}catch(error){showError(error);return;}
  toast(message);
}
async function moveLibraryDocumentToTrash(record) {
  if(trashBusy||!record)return;
  if(!await confirmDialog('휴지통으로 옮길까요?','본문·주석·북마크·저장 이력을 보관합니다. 내 서재의 휴지통에서 복원할 수 있습니다.','휴지통으로 이동'))return;
  if(trashBusy)return;trashBusy=true;
  try{
    const tab=tabs.find(tab=>tab.record?.id===record.id);if(tab)await closeTab(tab.id);
    await trashDocument(record.id);await finishTrashChange('휴지통으로 옮겼습니다. 내 서재의 휴지통에서 복원할 수 있습니다.');
  }finally{trashBusy=false;}
}
function trashDocumentMenu(record) {
  if(!record)return;
  modal(`<div class="dialog-heading"><h2>${esc(record.title)}</h2><button class="icon-button" data-dialog-close aria-label="닫기">${icon('close')}</button></div><p class="dialog-description small">${esc(record.name)}<br>복원 위치: ${esc(libraryPathLabel(record.folderId||''))}<br>삭제일: ${esc(formatDate(record.trashedAt,true))}</p><p class="dialog-description">본문·주석·북마크·저장 이력을 함께 복원합니다.</p><div class="document-actions"><button id="trash-restore" class="menu-button">${icon('undo')} 복원</button><button id="trash-delete" class="menu-button danger">${icon('trash')} 영구 삭제</button></div>`,dialog=>{
    $('#trash-restore').onclick=safely(async()=>{
      if(trashBusy)return;trashBusy=true;
      try{const restored=await restoreDocument(record.id);dialog.close();await finishTrashChange('복원했습니다. 위치: '+libraryPathLabel(restored.folderId||''));}finally{trashBusy=false;}
    });
    $('#trash-delete').onclick=safely(async()=>{
      if(trashBusy)return;
      if(!await confirmDialog('영구 삭제할까요?',record.title+' · 문서·주석·북마크·저장 이력을 앱에서 복원할 수 없게 됩니다. 가져오기 전의 원본 파일은 삭제하지 않습니다.','영구 삭제'))return;
      if(trashBusy)return;trashBusy=true;
      try{await deleteDocument(record.id);await finishTrashChange('휴지통에서 영구 삭제했습니다.');}finally{trashBusy=false;}
    });
  });
}
async function emptyLibraryTrash() {
  if(trashBusy||!trashRecords.length)return;
  const ids=trashRecords.map(record=>record.id);
  if(!await confirmDialog('휴지통을 비울까요?',ids.length+'개 문서와 주석·북마크·저장 이력을 영구 삭제합니다. 앱에서 복원할 수 없습니다. 가져오기 전의 원본 파일은 삭제하지 않습니다.','휴지통 비우기'))return;
  if(trashBusy)return;trashBusy=true;
  try{await deleteTrashedDocuments(ids);await finishTrashChange('휴지통을 비웠습니다.');}finally{trashBusy=false;}
}
function documentMenu(record) {
  modal(`<div class="dialog-heading"><h2>${esc(record.title)}</h2><button class="icon-button" data-dialog-close aria-label="닫기">${icon('close')}</button></div><div class="document-actions"><button class="menu-button" id="menu-open">${icon('file')} 열기</button><button class="menu-button" id="menu-export">${icon('download')} HTML 내보내기</button><button class="menu-button" id="menu-history">${icon('undo')} 주석 저장 이력</button><button class="menu-button" id="menu-migrate">${icon('file')} 새 판으로 주석 옮기기</button><button class="menu-button danger" id="menu-remove">${icon('trash')} 휴지통으로 이동</button></div><p class="dialog-description small">HTML 내보내기는 본문·현재 주석·북마크를 HTML 파일 하나로 저장합니다.</p>${annotationExportGuide()}`,()=>{
    $('#menu-open').onclick=safely(async()=>{$('#dialog').close();await openRecord(record);});$('#menu-export').onclick=safely(async()=>{$('#dialog').close();const tab=await openRecord(record);await exportDocument(tab);});
    $('#menu-history').onclick=safely(async()=>{$('#dialog').close();await annotationHistory(await openRecord(record));});
    $('#menu-migrate').onclick=safely(async()=>{$('#dialog').close();await migrateEdition(await openRecord(record));});
    $('#menu-remove').onclick=safely(()=>moveLibraryDocumentToTrash(record));
  });
  const actions=$('#dialog .document-actions'),button=document.createElement('button');button.className='menu-button';button.id='menu-folder-move';button.innerHTML=icon('folder')+' 폴더로 이동';actions.insertBefore(button,$('#menu-remove'));button.onclick=()=>libraryMoveDialog('document',record);
  const location=document.createElement('p');location.className='dialog-description small';location.textContent='위치: '+libraryPathLabel(record.folderId||'');actions.before(location);
}
function handleKey(event) {
  const isField=/^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName)||event.target?.isContentEditable;
  if(event.key==='Escape'&&reader()?.cancelAnnotationDrag?.()){event.preventDefault();return;}
  if((event.ctrlKey||event.metaKey)&&event.shiftKey&&event.key.toLowerCase()==='v'&&!isField&&!$('#dialog').open){event.preventDefault();pasteTextDialog();return;}
  if(event.key==='Escape') {if(reader()?.readAloud?.escape()){event.preventDefault();return;}reader()?.stopSpeech();if($('#dialog').open)return;if(!$('#tool-popover').hidden)closePopover();else if(!$('#sidebar').hidden)closeSidebar();else if(reader()?.documentSidebarUI&&reader().documentSidebarMode!=='outline')reader().showDocumentSidebarView('outline');else if(readerFocused)void leaveReaderFocus();else if(reader())reader().setTool('select');return;}
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){event.preventDefault();if(reader())safely(async()=>{const tab=active();tab.reader.rememberPosition();await tab.queue.flush();await dataFolder?.flush();})();else safely(savePage)();return;}
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='l'){event.preventDefault();focusAddress();return;}
  if(!reader()||isField||$('#dialog').open)return;
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){event.preventDefault();event.shiftKey?reader().redo():reader().undo();return;}
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='f'){event.preventDefault();if(reader().documentSidebarUI)reader().showDocumentSidebarView('search');else renderSidebar('search');return;}
  if(event.ctrlKey||event.metaKey||event.altKey)return;
  if(event.key.toLowerCase()==='f'){event.preventDefault();void toggleReaderFocus();return;}
  const tools={v:'select',p:'pen',h:'highlight',u:'underline',r:'rect',e:'eraser',n:'note'};const tool=tools[event.key.toLowerCase()];if(tool){event.preventDefault();toolAction(tool);}
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
  [['#web-help-button','info','웹페이지 가져오기 안내'],['#address-open','external'],['#save-page','save'],['#library-search-icon','search'],['#empty-icon','file'],['#library-card-view','grid','카드'],['#library-list-view','list','목록']].forEach(([id,name,label])=>setButton(id,name,label));
  setIconButton('#library-tab','library','내 서재');
  setIconButton('#settings-button','settings','설정');bindTabs();
  $('#execution-export-guide').innerHTML=annotationExportGuide();
  $('#data-folder-status').onclick=()=>chooseFolder();
  $('#library-tab').onclick=()=>activate('library');
  $('#execution-web').onclick=()=>webHelpDialog();
  $('#share-url').value=PUBLIC_APP_URL;$('#shared-app-link').href=PUBLIC_APP_URL;
  $('#share-app').onclick=safely(copyAppURL);
  installController=new InstallController({window,navigator,location,matchMedia,onChange:updateInstall,onGuide:installGuide});
  $('#execution-install').onclick=safely(async()=>{const result=await installController.install();if(result==='dismissed')toast('설치를 취소했습니다. 앱 설치 버튼에서 다시 안내를 볼 수 있어요.');});
  const addressForm=$('#address-form');
  addressForm.addEventListener('focusin',()=>$('.chrome').classList.add('address-editing'));
  addressForm.addEventListener('focusout',event=>{if(!addressForm.contains(event.relatedTarget)){$('.chrome').classList.remove('address-editing');updateChrome();requestAnimationFrame(revealActiveTab);}});
  addressForm.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();$('#address').blur();$('.tab.active .tab-select',$('#tabs'))?.focus();}});
  addressForm.onsubmit=safely(async event=>{event.preventDefault();const value=$('#address').value;$('.chrome').classList.remove('address-editing');$('#address').blur();await openBrowser(value,active()?.type!=='browser');});
  $('#save-page').onclick=safely(savePage);$('#hero-import').onclick=safely(importFiles);
  $('#file-input').onchange=safely(async event=>{const files=[...event.target.files],parentId=libraryFolderId;event.target.value='';for(const file of files)await openLocalFile(file,parentId);});
  $('#settings-file-input').onchange=safely(async event=>{const file=event.target.files[0];event.target.value='';if(file){await restoreSettings(file);settingsDialog();}});
  $('#library-filter').oninput=renderLibrary;$('#library-sort').onchange=safely(e=>{if(libraryTrash){trashSort=e.target.value;renderLibrary();return;}const [librarySort,librarySortDirection]=e.target.value.split(':');changePreferences({librarySort,librarySortDirection});});$$('[data-library-view]').forEach(button=>button.onclick=safely(()=>changePreferences({libraryView:button.dataset.libraryView})));$('#settings-button').onclick=settingsDialog;$('#web-help-button').onclick=()=>webHelpDialog();$('#paste-button').onclick=()=>pasteTextDialog();
  $('#library-trash').onclick=toggleLibraryTrash;$('#library-empty-trash').onclick=safely(emptyLibraryTrash);$('#library-new-folder').onclick=()=>libraryFolderNameDialog();$('#library-folder-up').onclick=()=>libraryTrash?toggleLibraryTrash():navigateLibraryFolder(libraryFolderById.get(libraryFolderId)?.parentId||'');$('#library-folder-help').onclick=()=>modal(`<div class="dialog-heading"><h2>서재 폴더 사용 안내</h2><button class="icon-button" data-dialog-close aria-label="닫기">${icon('close')}</button></div>${$('#library-folder-help-content').innerHTML}<div class="dialog-actions"><button class="primary-button" data-dialog-close>확인</button></div>`);bindLibraryFolderDrag();
  $('#open-example').onclick=safely(async()=>{let html=await bundledExample();if(html===null){const response=await fetch('./example.html');if(!response.ok)throw new Error('예제 문서를 불러오지 못했습니다.');html=await response.text();}await createDocument({html,title:'천천히 읽는다는 것',viewport:{width:960,height:800}});});
  document.addEventListener('keydown',handleKey);document.addEventListener('pointerdown',event=>{if(!event.target.closest('#toolbar,#tool-popover,[data-htmlmemo-reading-controls]')&&!$('#tool-popover').hidden)closePopover();});
  $('#dialog').addEventListener('click',event=>{if(event.target===$('#dialog')&&!$('#dialog [data-chrome-required]'))$('#dialog').close();});
  window.addEventListener('beforeunload',event=>{if(tabs.some(t=>t.opening||t.queue?.editsPending||t.checkpoints?.error||!!folder&&t.queue?.pending)||dataFolder?.pending){event.preventDefault();event.returnValue='';}});
  const savePositions=(checkpoint=false)=>{Promise.all(tabs.filter(t=>t.reader?.doc).map(async tab=>{tab.reader.rememberPosition();await tab.queue.flush();if(checkpoint)await tab.checkpoints.flush({force:true});})).then(()=>dataFolder?.flush()).catch(()=>{});};
  document.addEventListener('visibilitychange',()=>{if(document.hidden)savePositions();});
  window.addEventListener('pagehide',()=>savePositions(true));
  window.addEventListener('online',network);window.addEventListener('offline',network);
  window.addEventListener('focus',resumeBrowser);document.addEventListener('visibilitychange',resumeBrowser);
  window.addEventListener('storage',()=>{try{preferences=loadPreferences(localStorage);applyTheme(preferences.theme);renderLibrary();dataFolder?.schedule({settingsOnly:true});}catch(error){showError(error);}});
  window.addEventListener('resize',()=>{stopAppSidebarResize();applyAppSidebarWidth();closePopover();applyToolbarPosition();requestAnimationFrame(revealActiveTab);});
  window.addEventListener('dragover',event=>{if([...event.dataTransfer.types].includes('Files'))event.preventDefault();});window.addEventListener('drop',safely(async event=>{if(![...(event.dataTransfer.types||[])].includes('Files'))return;event.preventDefault();const parentId=libraryFolderId;for(const file of await droppedHTMLFiles(event.dataTransfer))await openLocalFile(file,parentId);}));
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
  if(!supportsDataFolder(window,navigator)){chromeRequiredDialog();return;}
  try{preferences=loadPreferences(localStorage);}catch(error){toast('설정 일부를 읽지 못했습니다. 연결한 데이터 폴더로 복원할 수 있습니다.',true);}
  dataFolder=new DataFolder({storage:localStorage,report:state=>{if(state.handle)folder=state.handle;renderFolderState();},onRestored:async result=>{preferences=loadPreferences(localStorage);applyTheme(preferences.theme);$('#library-sort').value=preferences.librarySort+':'+preferences.librarySortDirection;for(const tab of tabs)if(tab.reader)Object.assign(tab.reader,preferences.annotation);applyToolbarPosition();await refreshLibrary();if(result.recovered)toast('이전의 온전한 폴더 저장본에서 복원했습니다. 최신 변경 일부가 빠졌을 수 있습니다.',true);}});
  applyTheme(preferences.theme);bindUI();fitHeader();$('#library-sort').value=preferences.librarySort+':'+preferences.librarySortDirection;network();folder=await getSetting('folder');settingsFileHandle=await getSetting('settings-file');settingsFolderHint=await getSetting('settings-folder-hint')||'';await refreshLibrary();activate('library');
  onStorageChange(()=>{if(activeId==='library'){clearTimeout(libraryReloadTimer);libraryReloadTimer=setTimeout(()=>{if(activeId==='library')refreshLibrary().catch(showError);},30);}});
  if(folder){try{await dataFolder.connect(folder,{resume:true});await refreshLibrary();}catch(error){renderFolderState();showError(error);}}
  if(needsFolderWelcome()&&!$('#dialog').open)folderWelcomeDialog();
  if(installableLocation(location)&&'serviceWorker'in navigator)await navigator.serviceWorker.register('./sw.js',{updateViaCache:'none'}).then(reg=>reg?.update?.().catch(()=>{})).catch(()=>toast('오프라인 준비를 완료하지 못했습니다. 다음 접속에서 다시 준비합니다.',true));
  if('launchQueue'in window)window.launchQueue.setConsumer(safely(async params=>{const parentId=libraryFolderId;for(const handle of params.files||[])await openLocalFile(handle,parentId);}));
}
initialize().catch(error=>{$('#status-left').textContent='서재를 준비하지 못했습니다.';showError(error);});
