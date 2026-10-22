import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {DOMParser} from 'linkedom';
import {$, $$, icon, escapeHTML, normalizeURL, displayHost, uid} from '../public/src/utils.js';
import {documentFor} from './dom.mjs';

const source=await readFile(new URL('../public/src/app.js',import.meta.url),'utf8');
const browserCode=source.slice(source.indexOf('async function openBrowser('),source.indexOf('function toolbarButton('));
const saveCode=source.slice(source.indexOf('async function savePage('),source.indexOf('async function exportDocument('));
const selectCode=source.slice(source.indexOf('async function selectTab('),source.indexOf('function updateChrome('));
const tabsCode=source.slice(source.indexOf('function renderTabs('),source.indexOf('function focusAddress('));
function app(){
  const doc=new DOMParser().parseFromString('<html><body><div id="tabs"></div><button id="library-tab"></button><button id="execution-tab"></button><div id="workspaces"></div></body></html>','text/html');
  const saved=[],help=[],notices=[];let direct=0,captures=0;
  const context=vm.createContext({document:doc,window:{open(){throw Error('Unexpected external opening');}},$:(s,r=doc)=>$(s,r),$$:(s,r=doc)=>$$(s,r),icon,esc:escapeHTML,normalizeURL,displayHost,uid,
    requestAnimationFrame(){},updateChrome(){},importFiles:async()=>{},safely:fn=>async(...args)=>fn(...args),toast:message=>notices.push(message),
    active:()=>context.tabs.find(tab=>tab.id===context.activeId),
    activate(id){context.activeId=id;for(const tab of context.tabs)tab.host.hidden=tab.id!==id;context.renderTabs();},
    createHost(id){const host=doc.createElement('div');host.id='workspace-'+id;doc.getElementById('workspaces').append(host);return host;},
    folderFile:async()=>null,createDocument:async snapshot=>saved.push(snapshot),webHelpDialog:(tab,message)=>help.push({tab,message}),
    readWebPage:async url=>{direct++;return {html:'<p>직접 가져온 문장</p>',title:'직접 가져오기',url};},
    HTMLMemoCapture:{captureDocument:async d=>{captures++;return {html:d.documentElement.outerHTML,title:d.title,url:d.location.href};}}
  });
  vm.runInContext('var tabs=[],activeId="library",tabLayout="";'+tabsCode+selectCode+browserCode+saveCode,context);
  return {context,doc,saved,help,notices,get direct(){return direct;},get captures(){return captures;}};
}
test('Pages-only web tabs reuse the same URL and selecting one never opens another browser window',async()=>{
  const a=app(),first=await a.context.openBrowser('https://source.example/first');await a.context.openBrowser('https://source.example/second');
  await a.doc.querySelector('[data-tab="'+first.id+'"] .tab-select').onclick();assert.equal(a.context.activeId,first.id);
  assert.strictEqual(await a.context.openBrowser('https://source.example/first'),first);assert.equal(a.context.tabs.length,2);assert.equal(first.frame.src,'https://source.example/first');
  await a.context.openBrowser('https://source.example/second');assert.strictEqual(await a.context.openBrowser('https://source.example/first',false),first);assert.equal(a.context.tabs.length,2);
  assert.match(first.host.textContent,/가져오기 안내/);const link=first.host.querySelector('[data-open-external]');assert.equal(link.target,'_blank');assert.equal(link.getAttribute('rel'),'noopener noreferrer');
  assert.doesNotMatch(source,/bridgeAvailable|discoverBridge|chrome\.runtime|chromeId|htmlmemo-extension/);
});
test('a cross-origin frame is not misreported as readable or automatically saved; explicit save can use direct CORS reading',async()=>{
  const a=app(),tab=await a.context.openBrowser('https://source.example/');
  Object.defineProperty(tab.frame,'contentDocument',{get(){throw Error('Cross-origin');}});tab.frame.dispatchEvent(new a.doc.defaultView.Event('load'));
  assert.equal(tab.readable,false);assert.equal(a.direct,0);assert.match(tab.host.querySelector('[data-web-status]').textContent,/제한/);
  await a.context.savePage();assert.equal(a.direct,1);assert.equal(a.captures,0);assert.equal(a.saved.length,1);assert.equal(a.saved[0].url,'https://source.example/');assert.equal(tab.capturing,null);
});
test('same-origin live pages keep their title and capture directly without a file picker or direct request',async()=>{
  const a=app(),tab=await a.context.openBrowser('https://source.example/');
  const loaded=documentFor('<html><head><title>실제 제목</title></head><body><p>본문</p></body></html>','https://source.example/final');
  Object.defineProperty(tab.frame,'contentDocument',{value:loaded});tab.frame.dispatchEvent(new a.doc.defaultView.Event('load'));
  assert.equal(tab.readable,true);assert.equal(tab.title,'실제 제목');assert.equal(tab.url,'https://source.example/final');await a.context.savePage();
  assert.equal(a.captures,1);assert.equal(a.direct,0);assert.equal(a.saved[0].title,'실제 제목');
});
test('failed direct reading retains the tab and opens actionable import/paste guidance instead of extension setup',async()=>{
  const a=app(),tab=await a.context.openBrowser('https://source.example/');a.context.readWebPage=async()=>{throw Error('CORS or network blocked');};
  assert.equal(await a.context.savePage(),false);assert.equal(a.saved.length,0);assert.strictEqual(a.help[0].tab,tab);assert.match(a.help[0].message,/CORS or network/);assert.equal(tab.capturing,null);assert.equal(a.context.tabs.length,1);
});
test('concurrent save clicks share one snapshot and navigation waits for the explicit capture to finish',async()=>{
  const a=app(),tab=await a.context.openBrowser('https://source.example/');let finish,calls=0;
  a.context.readWebPage=()=>{calls++;return new Promise(resolve=>finish=resolve);};const first=a.context.savePage(),second=a.context.savePage();
  assert.equal(calls,1);assert.equal(tab.host.querySelector('[data-capture]').disabled,true);await a.context.navigate(tab,'https://source.example/next');assert.equal(tab.url,'https://source.example/');
  finish({html:'<p>완료</p>',title:'완료'});await first;await second;assert.equal(a.saved.length,1);assert.equal(tab.host.querySelector('[data-capture]').disabled,false);assert.equal(a.notices.length,1);
});
test('in-app address history and local document selection work without any extension connection',async()=>{
  const a=app(),tab=await a.context.openBrowser('https://source.example/');await a.context.openBrowser('https://source.example/next',false);
  await a.context.browserHistory(-1);assert.equal(tab.url,'https://source.example/');await a.context.browserHistory(1);assert.equal(tab.url,'https://source.example/next');
  const local={id:'local',type:'document',title:'문서',host:a.doc.createElement('div')};a.context.tabs.push(local);await a.context.selectTab('local');assert.equal(a.context.activeId,'local');
});
