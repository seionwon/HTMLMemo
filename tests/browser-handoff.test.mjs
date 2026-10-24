import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {DOMParser} from 'linkedom';
import {$,$$,icon,escapeHTML,normalizeURL,displayHost,uid} from '../public/src/utils.js';
import {BrowserTabs,isWebSearch} from '../public/src/web.js';
import {documentFor} from './dom.mjs';
const source=await readFile(new URL('../public/src/app.js',import.meta.url),'utf8');
const browserCode=source.slice(source.indexOf('function webContext('),source.indexOf('function toolbarButton('));
const saveCode=source.slice(source.indexOf('async function savePage('),source.indexOf('async function exportDocument('));
const selectCode=source.slice(source.indexOf('async function selectTab('),source.indexOf('function updateChrome('));
const tabsCode=source.slice(source.indexOf('function renderTabs('),source.indexOf('function focusAddress('));
function app(){
 const doc=new DOMParser().parseFromString('<html><body><div id="tabs"></div><button id="library-tab"></button><button id="execution-tab"></button><div id="workspaces"></div></body></html>','text/html');
 const saved=[],help=[],notices=[],pastes=[],opened=[];let direct=0,captures=0;
 const window={open(){const target={closed:false,opener:window,document:{createElement:n=>{const node=doc.createElement(n);node.click=()=>target.location.href=node.href;return node;},body:doc.createElement('body')},location:{href:'about:blank'},focus(){this.focused=(this.focused||0)+1;}};opened.push(target);return target;}};
 const context=vm.createContext({document:doc,window,URL,location:new URL('https://app.example/'),BrowserTabs,isWebSearch,$:(s,r=doc)=>$(s,r),$$:(s,r=doc)=>$$(s,r),icon,esc:escapeHTML,normalizeURL,displayHost,uid,
  requestAnimationFrame(){},updateChrome(){},importFiles:async()=>{},safely:fn=>async(...args)=>fn(...args),toast:message=>notices.push(message),reader:()=>context.active()?.reader,
  active:()=>context.tabs.find(t=>t.id===context.activeId),activate(id){context.activeId=id;for(const t of context.tabs)t.host.hidden=t.id!==id;context.renderTabs();},
  createHost(id){const host=doc.createElement('div');host.id='workspace-'+id;doc.getElementById('workspaces').append(host);return host;},
  folderFile:async()=>null,createDocument:async snapshot=>saved.push(snapshot),webHelpDialog:(tab,message)=>help.push({tab,message}),pasteTextDialog:tab=>pastes.push(tab),
  readWebPage:async url=>{direct++;return {html:'<p>본문</p>',title:'직접 가져오기',url};},HTMLMemoCapture:{captureDocument:async d=>{captures++;return {html:d.documentElement.outerHTML,title:d.title,url:d.location.href};}}
 });
 vm.runInContext('var tabs=[],activeId="library",tabLayout="",lastWebTab=null,browserTabs=new BrowserTabs(window);'+tabsCode+selectCode+browserCode+saveCode,context);
 return {context,doc,window,saved,help,notices,pastes,opened,get direct(){return direct;},get captures(){return captures;}};
}
test('search and external URLs open a browser tab synchronously and never create a blocked external iframe',async()=>{
 const a=app(),pending=a.context.openBrowser('한글 검색');assert.equal(a.opened.length,1);const tab=await pending;
 assert.equal(tab.external,true);assert.equal(tab.frame,undefined);assert.equal(tab.host.querySelector('iframe'),null);assert.equal(a.opened[0].opener,null);assert.match(a.opened[0].location.href,/google.com\/search\?q=/);
 assert.equal(a.direct,0);assert.equal(a.captures,0);assert.match(tab.host.textContent,/검색은 Chrome/);assert.equal(tab.host.querySelector('[data-capture]').disabled,true);
});
test('same URL and web tab selection focus an existing browser tab without reloading its current result',async()=>{
 const a=app(),tab=await a.context.openBrowser('https://source.example/first');a.opened[0].location.href='https://source.example/result';
 await a.context.openBrowser('https://source.example/first');await a.context.selectTab(tab.id);
 assert.equal(a.opened.length,1);assert.equal(a.opened[0].location.href,'https://source.example/result');assert.equal(a.context.tabs.length,1);
 const link=tab.host.querySelector('[data-open-external]');assert.equal(link.getAttribute('rel'),'noopener noreferrer');
 assert.doesNotMatch(source,/bridgeAvailable|discoverBridge|chrome\.runtime|chromeId|htmlmemo-extension/);
});
test('browser handoff status omits the redundant return guidance without changing return or blocked states',async()=>{
 const a=app(),tab=await a.context.openBrowser('https://source.example/'),status=tab.host.querySelector('[data-web-status]');
 assert.equal(status.textContent,'브라우저 탭으로 보냈습니다.');
 assert.doesNotMatch(tab.host.textContent,/돌아오면 읽던 문서에서 계속 작업할 수 있습니다\./);
 tab.returned=true;a.context.renderBrowserState(tab);
 assert.equal(status.textContent,'HTMLMemo로 돌아왔습니다. 복사한 글을 붙여넣거나 저장한 HTML을 가져오세요.');
 for(const state of ['blocked','unavailable']){tab.browserState=state;a.context.renderBrowserState(tab);assert.equal(status.textContent,'탭 열기 또는 전환이 제한됐습니다. 아래 「보낸 주소」의 링크를 눌러 직접 여세요.');}
});
test('blocked browser opening retains actionable fallback, text import and original URL without repeated automatic attempts',async()=>{
 const a=app();let calls=0;a.window.open=()=>{calls++;return null;};const tab=await a.context.openBrowser('https://source.example/');
 assert.match(tab.host.querySelector('[data-web-status]').textContent,/제한/);assert.equal(tab.host.querySelector('[data-open-external]').href,'https://source.example/');assert.ok(tab.host.querySelector('[data-browser-paste]'));
 a.context.resumeBrowser();assert.equal(calls,1);await a.context.savePage();assert.strictEqual(a.pastes[0],tab);assert.equal(a.direct,0);
});
test('searching from a document and returning keep the active reader, metadata and tabs without clipboard or remote reads',async()=>{
 const a=app(),local={id:'local',type:'document',title:'책',host:a.doc.createElement('div'),reader:{metadata:{annotations:[{id:'existing'}]}}};a.context.tabs.push(local);a.context.activeId='local';
 const before=structuredClone(local.reader.metadata),tab=await a.context.openBrowser('책 검색');assert.equal(a.context.activeId,'local');
 a.context.resumeBrowser();assert.equal(a.opened.length,1);assert.equal(a.context.activeId,'local');assert.deepEqual(local.reader.metadata,before);assert.equal(tab.returned,true);assert.equal(a.context.webContext(),tab);
 await a.context.selectTab('local');assert.equal(a.opened.length,1);
});
test('same-origin app preview still captures live content without a picker or remote browser tab',async()=>{
 const a=app(),tab=await a.context.openBrowser('https://app.example/example.html'),loaded=documentFor('<html><head><title>실제 제목</title></head><body><p>본문</p></body></html>','https://app.example/final');
 Object.defineProperty(tab.frame,'contentDocument',{value:loaded});tab.frame.dispatchEvent(new a.doc.defaultView.Event('load'));await a.context.savePage();
 assert.equal(tab.readable,true);assert.equal(a.opened.length,0);assert.equal(a.captures,1);assert.equal(a.saved[0].title,'실제 제목');
});
test('direct CORS reading is explicit, coalesced and disabled for search while failed reading keeps the web tab',async()=>{
 const a=app(),tab=await a.context.openBrowser('https://source.example/');let finish,calls=0;
 a.context.readWebPage=()=>{calls++;return new Promise(resolve=>finish=resolve);};const first=a.context.capturePage(tab),second=a.context.capturePage(tab);assert.equal(calls,1);
 await a.context.navigate(tab,'https://source.example/next');assert.equal(tab.url,'https://source.example/');finish({html:'<p>완료</p>',title:'완료'});await first;await second;assert.equal(a.saved.length,1);
 a.context.readWebPage=async()=>{throw Error('CORS blocked');};assert.equal(await a.context.capturePage(tab),false);assert.strictEqual(a.help[0].tab,tab);assert.match(a.help[0].message,/CORS blocked/);
 const search=await a.context.openBrowser('검색');await a.context.capturePage(search);assert.strictEqual(a.pastes.at(-1),search);assert.equal(calls,1);
});
test('only app preview history is controlled; external browser history is left to Chrome',async()=>{
 const a=app(),tab=await a.context.openBrowser('https://app.example/');await a.context.openBrowser('https://app.example/next',false);await a.context.browserHistory(-1);assert.equal(tab.url,'https://app.example/');
 const remote=await a.context.openBrowser('https://source.example/');await a.context.openBrowser('https://source.example/next',false);assert.equal(a.opened.length,1);await a.context.browserHistory(-1);assert.equal(remote.url,'https://source.example/next');
});
