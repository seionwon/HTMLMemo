const DEFAULT_APP = 'https://sweon.github.io/HTMLMemo/';
const BUNDLED_APP = chrome.runtime.getURL('app/index.html');
const appPath = url => url.pathname.replace(/\/index\.html$/, '/');
const projectApp = url => url.protocol==='https:'&&url.host==='sweon.github.io'&&appPath(url)==='/HTMLMemo/';
const jobs = new Map();
let storageTail=Promise.resolve();
const mutateStorage=fn=>{const result=storageTail.then(fn);storageTail=result.catch(()=>{});return result;};
const allowed = new Set(['ping','openBrowser','listTabs','focusTab','navigateTab','backTab','forwardTab','reloadTab','captureTab','takeCaptures','ackCapture']);
const webURL = value => { const url=new URL(value); if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('http 또는 https 페이지를 선택해주세요.');return url.href; };
async function appURL() {const saved=(await chrome.storage.local.get('pwaUrl')).pwaUrl;if(!saved)return DEFAULT_APP;try{const url=new URL(saved);url.search='';url.hash='';const development=url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname);if(!url.username&&!url.password&&(url.href===BUNDLED_APP||projectApp(url)||url.protocol==='file:'||development))return url.href;}catch{}return DEFAULT_APP;}
async function isApp(sender) {
  if(sender.id!==chrome.runtime.id||!sender.url)return false;
  const expected=new URL(await appURL());const actual=new URL(sender.url);
  const matching=actual.protocol===expected.protocol&&actual.host===expected.host&&(projectApp(expected)?appPath(actual)===appPath(expected):actual.pathname===expected.pathname);
  return matching&&(!!sender.tab?.id||actual.href.split(/[?#]/)[0]===BUNDLED_APP);
}
async function tracked() {return (await chrome.storage.session.get('tracked')).tracked||[];}
async function track(id) {return mutateStorage(async()=>{const ids=await tracked();if(!ids.includes(id))await chrome.storage.session.set({tracked:[...ids,id]});});}
async function requireTracked(id) {if(!Number.isInteger(id)||!(await tracked()).includes(id))throw new Error('HTMLMemo에서 연결한 Chrome 탭이 아닙니다.');return chrome.tabs.get(id);}
async function waitReady(id) {
  const tab=await chrome.tabs.get(id);if(tab.status==='complete')return;
  await new Promise((resolve,reject)=>{
    const finish=()=>{clearTimeout(timer);chrome.tabs.onUpdated.removeListener(listener);};
    const listener=(tabId,change)=>{if(tabId===id&&change.status==='complete'){finish();resolve();}};
    const timer=setTimeout(()=>{finish();reject(new Error('페이지 로딩이 끝나지 않았습니다. Chrome에서 페이지를 확인한 뒤 다시 저장해주세요.'));},45000);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(id).then(current=>{if(current.status==='complete'){finish();resolve();}},error=>{finish();reject(error);});
  });
}
async function fetchResource(message,sender) {
  const job=jobs.get(message.captureId);
  if(!job||sender.tab?.id!==job.tabId)throw new Error('유효한 페이지 저장 요청이 아닙니다.');
  const url=webURL(message.url);if(++job.resources>4000)throw new Error('페이지 리소스가 너무 많습니다.');
  const response=await fetch(url,{credentials:'include',signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error('HTTP '+response.status);
  const reader=response.body.getReader();const chunks=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>25*1024*1024){await reader.cancel();throw new Error('리소스가 25MB를 초과합니다.');}chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return {data:btoa(binary),type:response.headers.get('content-type')||''};
}
async function captureTab(id) {
  const tab=await chrome.tabs.get(id);webURL(tab.url);await waitReady(id);
  const captureId=crypto.randomUUID();jobs.set(captureId,{tabId:id,resources:0});
  try {
    await chrome.scripting.executeScript({target:{tabId:id},files:['capture.js']});
    const results=await chrome.scripting.executeScript({target:{tabId:id},func:async token=>{
      return HTMLMemoCapture.captureDocument(document,{fetchResource:async url=>{
        if(url.startsWith('blob:')) {const response=await fetch(url);return {bytes:new Uint8Array(await response.arrayBuffer()),type:response.headers.get('content-type')};}
        const response=await chrome.runtime.sendMessage({action:'resource',captureId:token,url});
        if(response.error)throw new Error(response.error);
        const binary=atob(response.result.data);const bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
        return {bytes,type:response.result.type};
      }});
    },args:[captureId]});
    if(!results[0]?.result?.html)throw new Error('페이지 내용을 읽지 못했습니다.');
    return {...results[0].result,id:captureId};
  } finally {jobs.delete(captureId);}
}
async function openApp(captureId) {
  const url=await appURL();const expected=new URL(url);
  const tabs=await chrome.tabs.query({});const existing=tabs.find(tab=>{try{const current=new URL(tab.url);return current.protocol===expected.protocol&&current.host===expected.host&&(projectApp(expected)?appPath(current)===appPath(expected):current.pathname===expected.pathname);}catch{return false;}});
  if(existing){await chrome.tabs.update(existing.id,{active:true});await chrome.windows.update(existing.windowId,{focused:true});await chrome.tabs.sendMessage(existing.id,{event:'capture-ready'}).catch(()=>{});await chrome.runtime.sendMessage({event:'capture-ready'}).catch(()=>{});return;}
  expected.searchParams.set('capture',captureId);await chrome.tabs.create({url:expected.href});
}
async function dispatch(message,sender) {
  if(message.action==='resource')return fetchResource(message,sender);
  const internal=sender.id===chrome.runtime.id&&!sender.tab&&sender.url?.startsWith(chrome.runtime.getURL(''));
  if(internal&&message.action==='popupSave'){
    const pending=(await chrome.storage.local.get('captures')).captures||[];
    if(pending.length>=10)throw new Error('HTMLMemo에 전달할 페이지가 10개입니다. 먼저 앱에서 저장을 완료해주세요.');
    const snapshot=await captureTab(message.tabId);await track(message.tabId);
    await mutateStorage(async()=>{const current=(await chrome.storage.local.get('captures')).captures||[];if(current.length>=10)throw new Error('HTMLMemo에서 전달받은 페이지를 먼저 저장해주세요.');await chrome.storage.local.set({captures:[...current,snapshot]});});await openApp(snapshot.id);return {title:snapshot.title,warnings:snapshot.warnings.length};
  }
  if(internal&&message.action==='getAppURL')return appURL();
  if(!allowed.has(message.action)||!await isApp(sender))throw new Error('설정된 HTMLMemo 앱에서만 사용할 수 있습니다.');
  if(message.action==='ping')return {version:'1.0.0'};
  if(message.action==='openBrowser') {const tab=await chrome.tabs.create({url:webURL(message.url),active:message.active!==false});await track(tab.id);return {id:tab.id,title:tab.title,url:tab.url||message.url};}
  if(message.action==='listTabs'){const ids=await tracked();const listed=await chrome.tabs.query({});return listed.filter(tab=>ids.includes(tab.id)).map(tab=>({id:tab.id,title:tab.title,url:tab.url||tab.pendingUrl,status:tab.status}));}
  if(message.action==='takeCaptures')return (await chrome.storage.local.get('captures')).captures||[];
  if(message.action==='ackCapture'){await mutateStorage(async()=>{const captures=(await chrome.storage.local.get('captures')).captures||[];await chrome.storage.local.set({captures:captures.filter(c=>c.id!==message.captureId)});});return true;}
  const tab=await requireTracked(message.tabId);
  switch(message.action){
    case 'focusTab':await chrome.tabs.update(tab.id,{active:true});await chrome.windows.update(tab.windowId,{focused:true});return true;
    case 'navigateTab':await chrome.tabs.update(tab.id,{url:webURL(message.url),active:true});return true;
    case 'backTab':await chrome.tabs.goBack(tab.id);return true;
    case 'forwardTab':await chrome.tabs.goForward(tab.id);return true;
    case 'reloadTab':await chrome.tabs.reload(tab.id);return true;
    case 'captureTab':return captureTab(tab.id);
    default:throw new Error('지원하지 않는 요청입니다.');
  }
}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(!message||typeof message.action!=='string')return false;
  dispatch(message,sender).then(result=>respond({result}),error=>respond({error:error.message}));return true;
});
async function registerBridge() {
  await chrome.scripting.unregisterContentScripts({ids:['htmlmemo-custom']}).catch(()=>{});
}
chrome.runtime.onInstalled.addListener(()=>registerBridge().catch(()=>{}));
chrome.storage.onChanged.addListener(changes=>{if(changes.pwaUrl)registerBridge().catch(()=>{});});
chrome.tabs.onRemoved.addListener(id=>{mutateStorage(async()=>chrome.storage.session.set({tracked:(await tracked()).filter(value=>value!==id)})).catch(()=>{});});
