import { $, $$, icon, escapeHTML as esc, uid, filename, normalizeURL, displayHost, formatDate, formatBytes, download } from './utils.js';
import { parseHTML, serializeHTML } from './document.js';
import { SaveQueue } from './model.js';
import { Reader } from './reader.js';
import { listDocuments, putDocument, deleteDocument, getSetting, setSetting, writeInternalHTML, writeExternalHTML, permission } from './storage.js';
import { bridge, bridgeAvailable, discoverBridge } from './bridge.js';
import { readLocalHTML, droppedHTMLFiles } from './local-files.js';

let records = []; const tabs = []; let activeId = 'library'; let folder = null; let installing = null; let popoverName = ''; let sidebarMode = ''; let receiving = false;
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
  modal(`<div class="dialog-heading"><h2>Chrome과 연결하기</h2><button class="icon-button" data-dialog-close aria-label="닫기">${icon('close')}</button></div><p class="dialog-description">실제 Chrome 탭에서 웹을 탐색하고, 보고 있는 페이지를 HTMLMemo로 저장할 수 있어요. 로그인된 페이지도 현재 화면을 기준으로 저장합니다.</p><ol class="setup-steps"><li><a href="./downloads/htmlmemo-chrome.zip" download>Chrome 연결 확장 기능 다운로드 ${icon('download',15)}</a> 후 압축을 풉니다.</li><li>Chrome의 <code>chrome://extensions</code>에서 개발자 모드를 켜고, <strong>압축해제된 확장 프로그램 로드</strong>로 해당 폴더를 선택합니다.</li><li>확장 기능의 <strong>설정</strong>에서 HTMLMemo 주소를 아래 주소로 지정합니다.</li></ol><div class="copy-url"><input readonly value="${esc(location.origin+location.pathname)}" aria-label="HTMLMemo 주소"><button class="secondary-button" id="copy-app-url">복사</button></div><p class="dialog-description small">웹 페이지에서 확장 기능의 「페이지 저장」을 누르면 이 앱의 새 탭에서 열립니다. 외부 폴더에 자동 저장하려면 저장 폴더를 한 번 연결해주세요.</p><div class="dialog-actions"><button class="secondary-button" id="check-connection">연결 확인</button><button class="primary-button" data-dialog-close>완료</button></div>`,()=>{
    $('#copy-app-url').onclick=safely(async()=>{await navigator.clipboard.writeText(location.origin+location.pathname);toast('앱 주소를 복사했습니다.');});
    $('#check-connection').onclick=safely(async()=>{const ok=await discoverBridge(); updateConnection(); toast(ok?'Chrome이 연결되었습니다.':'확장 기능을 설치한 뒤 페이지를 새로고침해주세요.',!ok);if(ok)await receiveCaptures();});
  });
}
function updateConnection() { $('#connection-button').classList.toggle('connected',bridgeAvailable()); $('#connection-button span').textContent=bridgeAvailable()?'Chrome 연결됨':'Chrome 연결'; }
function settingsDialog() {
  modal(`<div class="dialog-heading"><h2>HTMLMemo 설정</h2><button class="icon-button" data-dialog-close aria-label="닫기">${icon('close')}</button></div><div class="setting-row"><div><strong>자동 저장 폴더</strong><p>${folder?esc(folder.name):'앱 내부에 HTML 파일로 보관 중'}</p></div><button id="settings-folder" class="secondary-button">${folder?'변경':'폴더 연결'}</button></div><p class="dialog-description small">폴더를 연결하면 새 페이지와 주석이 해당 HTML 파일에 자동 저장됩니다. 연결 전에 저장한 문서는 「파일 연결」로 각각 연결할 수 있습니다.</p><div class="setting-row"><div><strong>화면 테마</strong><p>서재와 도구의 밝기를 선택하세요.</p></div><select id="appearance"><option value="light">밝게</option><option value="dark">어둡게</option><option value="system">시스템</option></select></div><div class="setting-row"><div><strong>Chrome 연결</strong><p>${bridgeAvailable()?'연결되어 있습니다.':'모든 사이트를 탐색하고 저장하기'}</p></div><button id="settings-chrome" class="secondary-button">설정 방법</button></div><div class="setting-row"><div><strong>기기 보관함 유지</strong><p>브라우저의 자동 공간 정리에서 보호 요청</p></div><button id="persist-storage" class="secondary-button">보관 유지</button></div><p class="dialog-description small">앱 데이터 삭제 시 내부 보관함도 지워집니다. 연결된 외부 HTML 파일은 그대로 남습니다.</p>`,()=>{
    $('#settings-folder').onclick=safely(async()=>{await chooseFolder();settingsDialog();});$('#settings-chrome').onclick=connectionDialog;
    $('#appearance').value=localStorage.getItem('htmlmemo-theme')||'light'; $('#appearance').onchange=e=>applyTheme(e.target.value);
    $('#persist-storage').onclick=safely(async()=>toast(await navigator.storage.persist()?'이 기기에서 보관함을 유지합니다.':'브라우저가 보관 유지를 허용하지 않았습니다. HTML 내보내기로 파일을 보관해주세요.'));
  });
}
function applyTheme(theme) { localStorage.setItem('htmlmemo-theme',theme); document.documentElement.dataset.theme=theme==='system'?(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'):theme; }
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
    return `<article class="document-card" data-record="${record.id}"><button class="card-open" data-open="${record.id}"><div class="card-preview"><div class="preview-host">${icon('globe',13)} ${esc(displayHost(record.source))}</div><h3>${esc(record.title)}</h3><div class="preview-lines"><i></i><i></i><i></i></div>${count?`<span class="preview-annotation">${icon('highlight',13)} ${count}개의 주석</span>`:''}</div><div class="card-details"><h3>${esc(record.title)}</h3><p>${esc(displayHost(record.source))} <span>·</span> ${formatDate(record.modified)}</p><div class="card-meta"><span>HTML <i>·</i> ${formatBytes(new Blob([record.html]).size)}</span><span>${progress?'이어서 읽기':'새 문서'} ${icon('forward',13)}</span></div></div></button><button class="card-menu icon-button" data-card-menu="${record.id}" aria-label="${esc(record.title)} 문서 메뉴">${icon('more',17)}</button></article>`;
  }).join('');
  $$('[data-open]').forEach(button=>button.onclick=safely(()=>openRecord(records.find(r=>r.id===button.dataset.open))));
  $$('[data-card-menu]').forEach(button=>button.onclick=()=>documentMenu(records.find(r=>r.id===button.dataset.cardMenu)));
  $('#choose-folder').innerHTML=(folder?esc(folder.name)+' 연결됨':'저장 폴더 연결')+' '+icon('external',13);
  if(activeId==='library')$('#status-left').textContent=`${records.length}개의 문서 · ${folder?folder.name+' 자동 저장':'이 기기에 보관'}`;
}
function renderTabs() {
  $('#tabs').innerHTML=tabs.map(tab=>`<div class="tab ${tab.id===activeId?'active':''} ${tab.type}" role="tab" tabindex="0" aria-selected="${tab.id===activeId}" data-tab="${tab.id}" title="${esc(tab.title)}"><span class="tab-icon">${icon(tab.type==='document'?'file':'globe',15)}</span><span class="tab-title">${esc(tab.title)}</span>${tab.queue?.pending?'<i class="tab-dirty"></i>':''}<button class="tab-close" data-close="${tab.id}" aria-label="${esc(tab.title)} 탭 닫기">${icon('close',13)}</button></div>`).join('');
  $$('[data-tab]').forEach(el=>{el.onclick=e=>{if(!e.target.closest('[data-close]'))activate(el.dataset.tab);};el.onkeydown=e=>{if(e.key==='Enter'||e.key===' ')activate(el.dataset.tab);};});
  $$('[data-close]').forEach(button=>button.onclick=safely(e=>{e.stopPropagation();return closeTab(button.dataset.close);}));
  $('#library-tab').classList.toggle('active',activeId==='library');
}
function activate(id) {
  closePopover(); closeSidebar(); activeId=id; $('#library').hidden=id!=='library';$('#workspace').hidden=id==='library';
  tabs.forEach(tab=>tab.host.hidden=tab.id!==id);renderTabs(); updateChrome();
  if(reader())renderToolbar();else $('#toolbar').hidden=true;
  if(id==='library')renderLibrary();
}
function updateChrome() {
  const tab=active(); const r=reader(); const local=tab?.type==='document';
  $('#address').value=local?tab.record.name:tab?.url||'';$('#address-icon').innerHTML=icon(local?'file':'globe',15);$('#local-label').hidden=!local;
  $('#back').disabled=local?!r?.linkHistory.length:!tab||!tab.chromeId&&tab.cursor<=0;
  $('#forward').disabled=!tab||local||!tab.chromeId&&tab.cursor>=tab.history.length-1;
  $('#reload').disabled=!tab||local;
  $('#save-page').innerHTML=icon(local?'download':'save',17)+`<span>${local?'HTML 내보내기':'페이지 저장'}</span>`;
  $('#save-page').disabled=!tab;
  if(local)saveStatus(tab); else if(tab)$('#status-left').textContent=tab.chromeId?'실제 Chrome 탭에서 탐색 중':'웹 탐색 · 로컬로 저장하면 주석을 남길 수 있어요.';
  document.title=tab?tab.title+' · HTMLMemo':'HTMLMemo · 나만의 웹 서재';
}
function createHost(id,type) { const host=document.createElement('div');host.id='workspace-'+id;host.className='workspace-host '+type+'-host';host.hidden=true;$('#workspaces').append(host);return host; }
async function openRecord(record) {
  const existing=tabs.find(tab=>tab.record?.id===record.id);if(existing){activate(existing.id);return existing;}
  const parsed=parseHTML(record.html,{title:record.title,source:record.source});
  const tab={id:uid(),type:'document',title:record.title,record:{...record},host:null};tab.host=createHost(tab.id,'document');
  tab.queue=new SaveQueue(async()=>{
    const html=tab.reader.html(); const metadata=structuredClone(tab.reader.metadata);
    tab.record.html=html;tab.record.metadata=metadata;tab.record.title=metadata.title;tab.record.modified=Date.now();
    tab.record.diskPending=!!tab.record.fileHandle;
    // Commit the full standalone HTML to IndexedDB first. A failed external
    // write must leave recoverable edits in the local library.
    await putDocument(tab.record);
    await writeInternalHTML(tab.record.id,html);
    if(tab.record.fileHandle){await writeExternalHTML(tab.record,html);tab.record.diskPending=false;await putDocument(tab.record);}
    records=records.filter(r=>r.id!==record.id).concat({...tab.record});
  },()=>{if(activeId===tab.id)saveStatus(tab);renderTabs();});
  tabs.push(tab);activate(tab.id);
  tab.reader=new Reader(tab.host,parsed,{
    onChange:()=>{tab.queue.schedule();if(activeId===tab.id){renderToolbar();if(sidebarMode==='annotations')renderSidebar('annotations');}},
    onPosition:()=>tab.queue.schedule(),onView:()=>{if(activeId===tab.id){updateChrome();updateToolbarState();}},
    onLink:url=>safely(openBrowser)(url),onKey:handleKey,requestText:promptText,
    onSelect:id=>{if(activeId===tab.id)annotationDialog(tab,id);},
  });
  try { await tab.reader.ready; } catch(error) {tabs.splice(tabs.indexOf(tab),1);tab.reader.dispose();activate('library');throw error;}
  renderToolbar();updateChrome();
  // A recovery copy ahead of its external file must keep its pending status.
  if(record.diskPending) { tab.queue.schedule(); tab.queue.flush().catch(showError); }
  return tab;
}
function saveStatus(tab) {
  const queue=tab.queue;if(!queue)return;
  const label=queue.error?'자동 저장 실패 · '+queue.error.message:queue.pending?'저장 중…':tab.record.fileHandle?'HTML 파일에 자동 저장됨':'앱의 HTML 파일에 자동 저장됨';
  $('#status-left').innerHTML=`<span class="save-state ${queue.error?'save-error':''}">${icon(queue.error?'more':queue.pending?'reload':'check',13)} ${esc(label)}</span>${queue.error?'<button id="retry-save" class="text-button">저장 재시도</button>':''}`;
  if(queue.error)$('#retry-save').onclick=safely(async()=>{if(tab.record.fileHandle&&!await permission(tab.record.fileHandle,true))throw new Error('파일 쓰기 권한이 필요합니다.');await tab.queue.flush();});
}
async function closeTab(id) {
  const tab=tabs.find(t=>t.id===id);if(!tab)return;
  if(tab.reader){tab.reader.rememberPosition();await tab.queue.flush();tab.reader.dispose();}else tab.host.remove();
  tabs.splice(tabs.indexOf(tab),1);if(activeId===id)activate(tabs.at(-1)?.id||'library');else renderTabs();await refreshLibrary();
}
async function createDocument(snapshot, handle = null, name = null, local = {}) {
  const parsed=parseHTML(snapshot.html,{title:snapshot.title,source:snapshot.url,viewport:snapshot.viewport,warnings:snapshot.warnings});
  const title=parsed.metadata.title; const record={id:uid(),title,name:name||handle?.name||filename(title),source:parsed.metadata.source,created:Date.now(),modified:Date.now(),fileHandle:handle,originalHandle:local.originalHandle||null,metadata:parsed.metadata};
  const doc=new DOMParser().parseFromString(parsed.html,'text/html');record.html=serializeHTML(doc,parsed.metadata);
  if(local.diskStamp)record.diskStamp=local.diskStamp;
  else if(handle){const disk=await handle.getFile();record.diskStamp={modified:disk.lastModified,size:disk.size};}
  await putDocument(record);const tab=await openRecord(record);tab.queue.schedule();
  try { await tab.queue.flush(); } catch(error) { showError(error); }
  await refreshLibrary();activate(tab.id);
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
  const handles=await window.showOpenFilePicker({types:htmlTypes,multiple:true});
  for(const handle of handles)await openLocalFile(handle,true);
}
async function openLocalFile(input,requestWrite=false) {
  const local=await readLocalHTML(input,{requestWrite});
  return createDocument(local.snapshot,local.handle,local.name,local);
}
async function savePage() {
  const tab=active();if(!tab)return;
  if(tab.reader)return exportDocument(tab);
  let live;
  if(!tab.chromeId) {try {live=tab.frame.contentDocument;if(!live?.documentElement)live=null;}catch{live=null;}}
  if(!live&&!bridgeAvailable()){connectionDialog();return;}
  // File pickers and requestPermission must run while this button's transient
  // activation is still valid, before capture/network work.
  let handle=null;
  if(folder){if(!await permission(folder,true))throw new Error('저장 폴더 쓰기 권한이 필요합니다.');}
  else if(savePicker())handle=await window.showSaveFilePicker({suggestedName:filename(tab.title),types:htmlTypes});
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
async function connectDocumentFile(tab) {
  if(!tab.record.fileHandle&&tab.record.originalHandle) {
    if(!await permission(tab.record.originalHandle,true))throw new Error('원본 파일 쓰기 권한이 허용되지 않았습니다. 주석은 앱 보관함에 자동 저장됩니다.');
    if(tab.queue.running)await tab.queue.running.catch(()=>{});
    tab.record.fileHandle=tab.record.originalHandle;tab.queue.schedule();await tab.queue.flush();updateChrome();toast('원본 HTML 파일에 주석을 자동 저장합니다.');return;
  }
  if(!savePicker()){await tab.queue.flush();download(tab.reader.html(),tab.record.name);toast('HTML을 내보냈습니다. 이 브라우저는 내려받은 파일의 자동 갱신을 지원하지 않습니다.');return;}
  const handle=await window.showSaveFilePicker({suggestedName:tab.record.name,types:htmlTypes});
  if(tab.queue.running)await tab.queue.running.catch(()=>{});
  const disk=await handle.getFile();tab.record.fileHandle=handle;tab.record.name=handle.name;tab.record.diskStamp={modified:disk.lastModified,size:disk.size};
  tab.queue.schedule();await tab.queue.flush();updateChrome();toast('이 HTML 파일에 주석을 자동 저장합니다.');
}
async function exportDocument(tab) {
  if(savePicker())return connectDocumentFile(tab);
  await tab.queue.flush();download(tab.reader.html(),tab.record.name);toast('주석이 포함된 HTML 파일을 내보냈습니다.');
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
  $('#toolbar').innerHTML=`<button class="toolbar-grip" aria-label="툴바 이동">${icon('grip',14)}</button><span class="tool-group">${toolbarButton('select','select','선택 / 읽기 (V)')}${toolbarButton('pen','pen','펜 (P)')}${toolbarButton('highlight','highlight','형광펜 (H)')}${toolbarButton('underline','underline','밑줄 (U)')}${toolbarButton('eraser','eraser','지우개 (E)')}${toolbarButton('note','note','메모 (N)')}</span><span class="toolbar-divider"></span>${toolbarButton('palette','palette','색상 · 굵기 · 투명도 설정','class="tool-button palette-button"')}<span class="tool-group toolbar-history">${toolbarButton('undo','undo','실행 취소 (Ctrl/⌘ Z)')}${toolbarButton('redo','redo','다시 실행 (Ctrl/⌘ Shift Z)')}</span><span class="toolbar-divider"></span><button class="tool-button zoom-button" data-action="zoom" title="확대 / 축소" aria-label="확대 / 축소">${Math.round(r.zoom*100)}%</button>${toolbarButton('more','more','더 많은 도구')}`;
  $$('[data-action]',$('#toolbar')).forEach(button=>{button.onpointerdown=e=>{if(e.pointerType==='mouse')e.preventDefault();};button.onclick=()=>toolAction(button.dataset.action);});
  bindToolbarDrag();updateToolbarState();
}
function updateToolbarState() {
  const r=reader();if(!r)return;
  $$('[data-action]',$('#toolbar')).forEach(button=>{const selected=button.dataset.action===r.tool;button.classList.toggle('active',selected);if(['select','pen','highlight','underline','eraser','note'].includes(button.dataset.action))button.setAttribute('aria-pressed',selected);});
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
  popoverName=name;$('#tool-popover').innerHTML=html;$('#tool-popover').hidden=false;positionPopover();bind();
}
function toolAction(action) {
  const r=reader();if(!r)return;
  if(['select','pen','highlight','underline','eraser','note','text','rect','ellipse','arrow','area','area-underline','strike'].includes(action)){
    closePopover();r.setTool(action);toast(({pen:'드래그해서 그리세요. 터치 스크롤은 선택 도구를 사용하세요.',highlight:'텍스트를 드래그해 선택하면 강조됩니다.',underline:'텍스트를 드래그해 선택하면 밑줄이 생깁니다.',eraser:'지울 주석을 누르세요.',note:'메모를 남길 위치를 누르세요.',text:'글자를 넣을 위치를 누르세요.',rect:'드래그해서 사각형을 그리세요.',ellipse:'드래그해서 타원을 그리세요.',arrow:'드래그해서 화살표를 그리세요.',area:'이미지나 원하는 영역을 드래그해 강조하세요.','area-underline':'드래그해서 영역 밑줄을 그리세요.',strike:'텍스트를 선택해 취소선을 남기세요.'})[action]||'선택 · 스크롤 · 링크 탐색');updateToolbarState();return;
  }
  if(action==='undo'){r.undo();return;}if(action==='redo'){r.redo();return;}
  if(action==='palette') {
    const colors=['#edcf67','#77bdab','#9fc8f0','#bdace0','#f39da2','#da8b55','#366558','#374151'];
    showPopover('palette',`<h3>펜과 색상</h3><div class="swatches">${colors.map(c=>`<button data-color="${c}" style="--swatch:${c}" aria-label="색상 ${c}" class="swatch ${r.color===c?'chosen':''}"></button>`).join('')}<input type="color" id="custom-color" value="${r.color}" aria-label="사용자 색상"></div><label class="range-label">굵기 <output id="width-output">${r.width}px</output><input id="pen-width" type="range" min="1" max="18" value="${r.width}"></label><label class="range-label">형광펜 투명도 <output id="opacity-output">${Math.round(r.opacity*100)}%</output><input id="pen-opacity" type="range" min="10" max="90" value="${Math.round(r.opacity*100)}"></label><label class="select-label">펜 표시 시간 <select id="pen-ttl"><option value="0">영구 저장</option><option value="3">3초</option><option value="10">10초</option><option value="30">30초</option></select></label><p class="popover-hint">시간을 정한 펜은 잠깐 표시되고 저장되지 않아요.</p>`,()=>{
      $$('[data-color]',$('#tool-popover')).forEach(button=>button.onclick=()=>{r.color=button.dataset.color;$$('.swatch').forEach(b=>b.classList.toggle('chosen',b===button));$('#custom-color').value=r.color;updateToolbarState();});
      $('#custom-color').oninput=e=>{r.color=e.target.value;updateToolbarState();};$('#pen-width').oninput=e=>{r.width=Number(e.target.value);$('#width-output').textContent=r.width+'px';};$('#pen-opacity').oninput=e=>{r.opacity=Number(e.target.value)/100;$('#opacity-output').textContent=e.target.value+'%';};$('#pen-ttl').value=String(r.penTTL);$('#pen-ttl').onchange=e=>r.penTTL=Number(e.target.value);
    });return;
  }
  if(action==='zoom') {showPopover('zoom',`<h3>확대 · 축소</h3><div class="zoom-controls"><button class="secondary-button" id="zoom-out">${icon('minus')}</button><input id="zoom-value" type="number" min="20" max="800" value="${Math.round(r.zoom*100)}" aria-label="확대 비율"><span>%</span><button class="secondary-button" id="zoom-in">${icon('plus')}</button></div><button id="zoom-fit" class="menu-button">화면 너비에 맞추기</button><button id="zoom-reset" class="menu-button">100% 원래 크기</button>`,()=>{
    $('#zoom-out').onclick=()=>r.setZoom(r.zoom/1.2);$('#zoom-in').onclick=()=>r.setZoom(r.zoom*1.2);$('#zoom-value').onchange=e=>r.setZoom(Number(e.target.value)/100);$('#zoom-fit').onclick=()=>{r.setZoom(1,true);closePopover();};$('#zoom-reset').onclick=()=>{r.setZoom(1);closePopover();};
  });return;}
  if(action==='more') {
    const items=[['search','search','문서 검색'],['outline','list','목차 · 북마크'],['annotations','note','주석 목록'],['rect','rect','사각형'],['ellipse','ellipse','타원'],['arrow','arrow','화살표'],['area','area','영역 형광펜'],['area-underline','underline','영역 밑줄'],['strike','strike','취소선'],['text','text','텍스트'],['undo','undo','실행 취소'],['redo','redo','다시 실행'],['bookmark','bookmark','현재 위치 북마크'],['connect','save','파일 연결 / 저장 재시도'],['info','file','문서 정보'],['clear','trash','주석 모두 지우기']];
    showPopover('more',`<h3>문서 도구</h3><div class="more-grid">${items.map(([id,name,label])=>`<button class="menu-button" data-more="${id}">${icon(name,16)}<span>${label}</span></button>`).join('')}</div>`,()=>$$('[data-more]').forEach(button=>button.onclick=safely(()=>{const id=button.dataset.more;closePopover();return toolAction(id);})));return;
  }
  if(['search','outline','annotations'].includes(action)){closePopover();renderSidebar(action);return;}
  if(action==='connect')return safely(()=>connectDocumentFile(active()))();
  if(action==='info')return documentInfo(active());
  if(action==='bookmark')return safely(async()=>{const title=await promptText('text','읽던 위치');if(title){r.addBookmark(title);toast('북마크를 저장했습니다.');}})();
  if(action==='clear')return safely(async()=>{if(await confirmDialog('주석을 모두 지울까요?',`${r.metadata.annotations.length}개의 주석을 지웁니다. 실행 취소로 복원할 수 있어요.`,'모두 지우기'))r.commit([]);})();
}
function bindToolbarDrag() {
  const bar=$('#toolbar');const grip=$('.toolbar-grip');if(!grip)return;
  grip.onpointerdown=event=>{
    event.preventDefault();const start=bar.getBoundingClientRect();const origin={x:event.clientX,y:event.clientY};grip.setPointerCapture(event.pointerId);
    const move=e=>{bar.style.transform='none';bar.style.bottom='auto';bar.style.left=Math.max(8,Math.min(innerWidth-start.width-8,start.left+e.clientX-origin.x))+'px';bar.style.top=Math.max(8,Math.min(innerHeight-start.height-34,start.top+e.clientY-origin.y))+'px';if(!$('#tool-popover').hidden)positionPopover();};
    const end=()=>{grip.removeEventListener('pointermove',move);grip.removeEventListener('pointerup',end);};grip.addEventListener('pointermove',move);grip.addEventListener('pointerup',end);
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
    $$('[data-bookmark]').forEach(button=>button.onclick=()=>{const mark=r.metadata.bookmarks.find(m=>m.id===button.dataset.bookmark);r.viewport.scrollTop=mark.top*r.zoom;r.viewport.scrollLeft=mark.left*r.zoom;});
    $$('[data-delete-bookmark]').forEach(button=>button.onclick=()=>{r.metadata.bookmarks=r.metadata.bookmarks.filter(m=>m.id!==button.dataset.deleteBookmark);active().queue.schedule();renderSidebar('outline');});$('#add-bookmark').onclick=()=>toolAction('bookmark');
  }else{
    content.innerHTML=r.metadata.annotations.length?r.metadata.annotations.map(a=>`<div class="annotation-row"><button class="annotation-item" data-annotation="${esc(a.id)}"><span class="annotation-type" style="color:${a.color}">${icon(a.type==='pen'?'pen':a.type==='note'?'note':a.type==='highlight'?'highlight':a.type==='underline'?'underline':'shapes',16)}</span><span>${esc(a.text||a.textAnchor?.quote||({pen:'펜 그림',rect:'사각형',ellipse:'타원',arrow:'화살표',area:'영역 강조','area-underline':'영역 밑줄',strike:'취소선'})[a.type]||'주석')}</span></button><button class="icon-button" data-delete-annotation="${esc(a.id)}" aria-label="주석 삭제">${icon('trash',14)}</button></div>`).join(''):'<p class="panel-empty">아직 주석이 없어요.<br>툴바에서 도구를 골라 생각을 남겨보세요.</p>';
    $$('[data-annotation]').forEach(button=>button.onclick=()=>r.jumpAnnotation(button.dataset.annotation));$$('[data-delete-annotation]').forEach(button=>button.onclick=()=>r.remove(button.dataset.deleteAnnotation));
  }
}
function annotationDialog(tab,id) {
  const a=tab.reader.metadata.annotations.find(a=>a.id===id);if(!a)return;
  modal(`<div class="dialog-heading"><h2>주석 편집</h2><button class="icon-button" data-dialog-close aria-label="닫기">${icon('close')}</button></div><p class="annotation-quote">${esc(a.text||a.textAnchor?.quote||'선택한 주석')}</p><label class="select-label">색상 <input type="color" id="annotation-color" value="${a.color}"></label><div class="dialog-actions">${['note','text'].includes(a.type)?'<button id="edit-note" class="secondary-button">내용 편집</button>':''}<button id="delete-selected" class="secondary-button">${icon('trash',15)} 삭제</button><button class="primary-button" data-dialog-close>완료</button></div>`,()=>{
    $('#annotation-color').onchange=e=>tab.reader.commit(tab.reader.metadata.annotations.map(item=>item.id===id?{...item,color:e.target.value}:item));
    $('#delete-selected').onclick=()=>{tab.reader.remove(id);$('#dialog').close();};if($('#edit-note'))$('#edit-note').onclick=safely(async()=>{const text=await promptText(a.type,a.text);if(text?.trim())tab.reader.commit(tab.reader.metadata.annotations.map(item=>item.id===id?{...item,text:text.trim()}:item));});
  });
}
function documentInfo(tab) {
  const m=tab.reader.metadata;
  modal(`<div class="dialog-heading"><h2>문서 정보</h2><button class="icon-button" data-dialog-close aria-label="닫기">${icon('close')}</button></div><dl class="document-info"><dt>제목</dt><dd>${esc(m.title)}</dd><dt>파일</dt><dd>${esc(tab.record.name)}</dd><dt>원본</dt><dd>${m.source?`<a href="${esc(m.source)}" target="_blank" rel="noopener noreferrer">${esc(m.source)}</a>`:'로컬 HTML 파일'}</dd><dt>저장 위치</dt><dd>${tab.record.fileHandle?'연결된 외부 HTML 파일 + 앱 보관함':'앱 내부 HTML 파일'}</dd><dt>주석</dt><dd>${m.annotations.length}개</dd></dl>${m.warnings.length?`<details class="capture-warnings"><summary>보관하지 못한 리소스 ${m.warnings.length}개</summary><ul>${m.warnings.map(w=>`<li>${esc(w)}</li>`).join('')}</ul></details>`:''}<p class="dialog-description small">본문과 주석은 HTML 파일 하나에 들어 있습니다. 파일을 HTMLMemo에서 다시 열면 주석을 계속 편집할 수 있어요.</p>`);
}
function documentMenu(record) {
  modal(`<div class="dialog-heading"><h2>${esc(record.title)}</h2><button class="icon-button" data-dialog-close aria-label="닫기">${icon('close')}</button></div><div class="document-actions"><button class="menu-button" id="menu-open">${icon('file')} 열기</button><button class="menu-button" id="menu-export">${icon('download')} HTML 내보내기</button><button class="menu-button danger" id="menu-remove">${icon('trash')} 서재에서 삭제</button></div>`,()=>{
    $('#menu-open').onclick=safely(async()=>{$('#dialog').close();await openRecord(record);});$('#menu-export').onclick=safely(async()=>{$('#dialog').close();const tab=await openRecord(record);await exportDocument(tab);});
    $('#menu-remove').onclick=safely(async()=>{if(!await confirmDialog('서재에서 삭제할까요?','앱 보관함에서만 삭제합니다. 연결된 외부 HTML 파일은 남습니다.','삭제'))return;const tab=tabs.find(t=>t.record?.id===record.id);if(tab)await closeTab(tab.id);await deleteDocument(record.id);await refreshLibrary();});
  });
}
function handleKey(event) {
  const isField=/^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName)||event.target?.isContentEditable;
  if(event.key==='Escape') {if($('#dialog').open)return;if(!$('#tool-popover').hidden)closePopover();else if(!$('#sidebar').hidden)closeSidebar();else if(reader())reader().setTool('select');return;}
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){event.preventDefault();if(reader())safely(()=>active().queue.flush())();else safely(savePage)();return;}
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='l'){event.preventDefault();$('#address').focus();$('#address').select();return;}
  if(!reader()||isField||$('#dialog').open)return;
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){event.preventDefault();event.shiftKey?reader().redo():reader().undo();return;}
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='f'){event.preventDefault();renderSidebar('search');return;}
  if(event.ctrlKey||event.metaKey||event.altKey)return;
  const tools={v:'select',p:'pen',h:'highlight',u:'underline',e:'eraser',n:'note'};const tool=tools[event.key.toLowerCase()];if(tool){event.preventDefault();toolAction(tool);}
}
function bindUI() {
  [['#library-tab','library'],['#new-tab','plus'],['#back','back'],['#forward','forward'],['#reload','reload'],['#import-button','folder'],['#save-page','save'],['#app-menu-button','more'],['#settings-button','settings'],['#library-search-icon','search'],['#empty-icon','file']].forEach(([id,name])=>setButton(id,name));
  $('#home-button').onclick=e=>{e.preventDefault();activate('library');};$('#library-tab').onclick=()=>activate('library');$('#new-tab').onclick=()=>{activate('library');$('#address').focus();};$('#browse-start').onclick=()=>$('#address').focus();
  $('#address-form').onsubmit=safely(async event=>{event.preventDefault();const value=$('#address').value;await openBrowser(value,active()?.type!=='browser');});
  $('#back').onclick=safely(()=>browserHistory(-1));$('#forward').onclick=safely(()=>browserHistory(1));$('#reload').onclick=safely(async()=>{const tab=active();if(tab?.chromeId)await bridge('reloadTab',{tabId:tab.chromeId});else if(tab?.frame)tab.frame.src=tab.url;});
  $('#save-page').onclick=safely(savePage);$('#import-button').onclick=safely(importFiles);$('#hero-import').onclick=safely(importFiles);$('#choose-folder').onclick=safely(chooseFolder);
  $('#file-input').onchange=safely(async event=>{const files=[...event.target.files];event.target.value='';for(const file of files)await openLocalFile(file);});
  $('#library-filter').oninput=renderLibrary;$('#library-sort').onchange=renderLibrary;$('#settings-button').onclick=settingsDialog;$('#connection-button').onclick=connectionDialog;
  $('#open-example').onclick=safely(async()=>{const response=await fetch('./example.html');if(!response.ok)throw new Error('예제 문서를 불러오지 못했습니다.');await createDocument({html:await response.text(),title:'천천히 읽는다는 것',viewport:{width:960,height:800}},await folderFile('천천히 읽는다는 것'));});
  $('#app-menu-button').onclick=()=>modal(`<div class="dialog-heading"><h2>HTMLMemo</h2><button class="icon-button" data-dialog-close aria-label="닫기">${icon('close')}</button></div><button class="menu-button" id="menu-import">${icon('folder')} HTML 파일 열기</button><button class="menu-button" id="menu-folder">${icon('save')} 저장 폴더 연결</button><button class="menu-button" id="menu-chrome">${icon('globe')} Chrome 연결</button><button class="menu-button" id="menu-settings">${icon('settings')} 설정</button>`,()=>{
    $('#menu-import').onclick=safely(async()=>{$('#dialog').close();await importFiles();});$('#menu-folder').onclick=safely(async()=>{$('#dialog').close();await chooseFolder();});$('#menu-chrome').onclick=connectionDialog;$('#menu-settings').onclick=settingsDialog;
  });
  document.addEventListener('keydown',handleKey);document.addEventListener('pointerdown',event=>{if(!event.target.closest('#toolbar,#tool-popover')&&!$('#tool-popover').hidden)closePopover();});
  $('#dialog').addEventListener('click',event=>{if(event.target===$('#dialog'))$('#dialog').close();});
  window.addEventListener('beforeunload',event=>{if(tabs.some(t=>t.queue?.pending||t.queue?.error)){event.preventDefault();event.returnValue='';}});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)for(const tab of tabs)if(tab.reader){tab.reader.rememberPosition();tab.queue.flush().catch(()=>{});}});
  window.addEventListener('online',network);window.addEventListener('offline',network);window.addEventListener('htmlmemo-chrome-ready',()=>{updateConnection();safely(receiveCaptures)();});window.addEventListener('htmlmemo-capture-ready',safely(receiveCaptures));
  window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installing=event;$('#install-button').hidden=false;});$('#install-button').onclick=safely(async()=>{await installing?.prompt();$('#install-button').hidden=true;});
  window.addEventListener('resize',()=>{closePopover();const bar=$('#toolbar');if(bar.style.top){bar.style.left='50%';bar.style.top='';bar.style.bottom='';bar.style.transform='';}});
  window.addEventListener('dragover',event=>{if([...event.dataTransfer.types].includes('Files'))event.preventDefault();});window.addEventListener('drop',safely(async event=>{if(![...(event.dataTransfer.types||[])].includes('Files'))return;event.preventDefault();for(const file of await droppedHTMLFiles(event.dataTransfer))await openLocalFile(file);}));
}
function network() {$('#network-status').textContent=navigator.onLine?'온라인':'오프라인';$('#network-status').classList.toggle('offline',!navigator.onLine);}
async function initialize() {
  applyTheme(localStorage.getItem('htmlmemo-theme')||'light');bindUI();network();folder=await getSetting('folder');await refreshLibrary();activate('library');
  if('serviceWorker'in navigator)await navigator.serviceWorker.register('./sw.js').catch(()=>toast('오프라인 준비를 완료하지 못했습니다. 다음 접속에서 다시 준비합니다.',true));
  if('launchQueue'in window)window.launchQueue.setConsumer(safely(async params=>{for(const handle of params.files||[])await openLocalFile(handle);}));
  if(await discoverBridge()){updateConnection();await receiveCaptures();}
  setInterval(async()=>{
    if(document.hidden||!bridgeAvailable())return;
    try{const listed=await bridge('listTabs');for(const tab of tabs.filter(t=>t.chromeId)){const found=listed.find(t=>t.id===tab.chromeId);if(found){tab.url=found.url;tab.title=found.title||displayHost(found.url);}}renderTabs();if(active()?.type==='browser')updateChrome();await receiveCaptures();}catch{/* Existing local documents keep working while the extension reconnects. */}
  },3500);
}
initialize().catch(error=>{$('#status-left').textContent='서재를 준비하지 못했습니다.';showError(error);});
