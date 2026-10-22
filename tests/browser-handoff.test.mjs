import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {DOMParser} from 'linkedom';
import {$, $$, icon, escapeHTML, normalizeURL, displayHost, uid} from '../public/src/utils.js';

const source=await readFile(new URL('../public/src/app.js',import.meta.url),'utf8');
const browserCode=source.slice(source.indexOf('async function openBrowser('),source.indexOf('async function browserHistory('));
const selectCode=source.slice(source.indexOf('async function selectTab('),source.indexOf('function updateChrome('));
const tabsCode=source.slice(source.indexOf('function renderTabs('),source.indexOf('function focusAddress('));
function app(){
  const doc=new DOMParser().parseFromString('<html><body><div id="tabs"></div><button id="library-tab"></button><button id="execution-tab"></button><div id="workspaces"></div></body></html>','text/html');
  const calls=[],remote=new Map();let serial=0,connected=true,override;
  const context=vm.createContext({document:doc,window:{open:()=>calls.push({action:'window.open'})},$:(s,r=doc)=>$(s,r),$$:(s,r=doc)=>$$(s,r),icon,esc:escapeHTML,normalizeURL,displayHost,uid,
    bridgeAvailable:()=>connected,requestAnimationFrame(){},connectionDialog(){calls.push({action:'connectionDialog'});},savePage(){},updateChrome(){},receiveCaptures:async()=>{},importFiles:async()=>{},
    safely:fn=>async(...args)=>fn(...args),
    active:()=>context.tabs.find(tab=>tab.id===context.activeId),
    activate(id){context.activeId=id;for(const tab of context.tabs)tab.host.hidden=tab.id!==id;context.renderTabs();},
    createHost(id){const host=doc.createElement('div');host.id='workspace-'+id;doc.getElementById('workspaces').append(host);return host;},
    bridge:async(action,args={})=>{
      calls.push({action,...args});if(override){const result=override(action,args);if(result!==undefined)return result;}
      if(action==='openBrowser'){const tab={id:++serial,title:'연결한 페이지',url:args.url};remote.set(tab.id,tab);return {...tab};}
      if(action==='listTabs')return [...remote.values()].map(tab=>({...tab}));
      if(action==='navigateTab'){remote.get(args.tabId).url=args.url;return true;}
      if(action==='focusTab')return true;
      throw Error('Unexpected action: '+action);
    }});
  vm.runInContext('var tabs=[],activeId="library",tabLayout="",chromeSync=null;'+tabsCode+selectCode+browserCode,context);
  return {context,doc,calls,remote,setConnected:value=>connected=value,override:fn=>override=fn};
}
test('clicking a connected app tab switches directly to its Chrome tab without another open request',async()=>{
  const a=app(),first=await a.context.openBrowser('https://example.test/first'),second=await a.context.openBrowser('https://example.test/second');
  a.context.activate('library');await a.doc.querySelector(`[data-tab="${first.id}"] .tab-select`).onclick();
  assert.equal(a.context.activeId,first.id);assert.deepEqual(a.calls.filter(c=>c.action==='focusTab'),[{action:'focusTab',tabId:first.chromeId}]);
  assert.equal(a.calls.filter(c=>c.action==='openBrowser').length,2);assert.notEqual(first.chromeId,second.chromeId);
  assert.match(a.doc.querySelector(`[data-tab="${first.id}"]`).title,/클릭하면 Chrome으로 전환/);
});
test('reopening the same URL reuses the connected tab and concurrent openings share one request',async()=>{
  const a=app();let finish;a.override(action=>action==='openBrowser'?new Promise(resolve=>finish=resolve):undefined);
  const first=a.context.openBrowser('https://example.test/'),second=a.context.openBrowser('https://example.test/');
  assert.equal(a.calls.filter(c=>c.action==='openBrowser').length,1);assert.equal(a.context.tabs.length,1);
  finish({id:30,title:'한 페이지',url:'https://example.test/'});assert.strictEqual(await first,await second);
  a.override();await a.context.openBrowser('https://example.test/');assert.equal(a.context.tabs.length,1);assert.equal(a.calls.at(-1).action,'focusTab');
  await a.context.openBrowser('https://example.test/',false);assert.equal(a.calls.at(-1).action,'focusTab');assert.equal(a.calls.some(c=>c.action==='navigateTab'),false);
});
test('returning updates the title, URL and closed state without stealing focus or creating a replacement until clicked',async()=>{
  const a=app(),tab=await a.context.openBrowser('https://example.test/');a.remote.get(tab.chromeId).url='https://example.test/next';a.remote.get(tab.chromeId).title='<새 제목>';
  await a.context.syncChromeTabs();assert.equal(tab.url,'https://example.test/next');assert.equal(tab.title,'<새 제목>');assert.equal(a.calls.some(c=>c.action==='focusTab'),false);
  assert.equal(tab.host.querySelector('.chrome-page-card h2').textContent,'<새 제목>');assert.equal(tab.host.querySelector('.chrome-page-card h2 새'),null);assert.equal(tab.host.querySelector('.chrome-page-card small').textContent,tab.url);
  a.remote.delete(tab.chromeId);await a.context.syncChromeTabs();assert.equal(tab.chromeMissing,true);assert.equal(tab.host.querySelector('[data-save-chrome]').disabled,true);assert.match(tab.host.querySelector('[data-focus-chrome]').textContent,/다시 열기/);
  assert.equal(a.calls.filter(c=>c.action==='openBrowser').length,1);await a.context.selectTab(tab.id);assert.equal(a.context.tabs.length,1);assert.equal(a.calls.filter(c=>c.action==='openBrowser').length,2);assert.equal(tab.chromeMissing,false);assert.equal(a.calls.at(-1).url,'https://example.test/next');
});
test('background sync coalesces focus/visibility/poll events and ignores stale results after navigation or a new opening',async()=>{
  const a=app(),tab=await a.context.openBrowser('https://example.test/');let finish;
  a.override(action=>action==='listTabs'?new Promise(resolve=>finish=resolve):undefined);
  const first=a.context.syncChromeTabs(),second=a.context.syncChromeTabs();assert.strictEqual(first,second);assert.equal(a.calls.filter(c=>c.action==='listTabs').length,1);
  await a.context.navigate(tab,'https://example.test/next');const newer=await a.context.openBrowser('https://example.test/new');
  finish([{id:tab.chromeId,url:'https://example.test/',title:'Stale'}]);await first;
  assert.equal(tab.url,'https://example.test/next');assert.equal(newer.chromeMissing,false);
  Object.defineProperty(a.doc,'hidden',{value:true,configurable:true});await a.context.syncChromeTabs();assert.equal(a.calls.filter(c=>c.action==='listTabs').length,1);
});
test('navigation waits for a pending Chrome open and explicitly reopens a previously closed linked page',async()=>{
  const a=app();let finish;a.override(action=>action==='openBrowser'?new Promise(resolve=>finish=resolve):undefined);
  const opening=a.context.openBrowser('https://example.test/'),tab=a.context.tabs[0],navigation=a.context.navigate(tab,'https://example.test/next');
  assert.equal(a.calls.some(c=>c.action==='navigateTab'),false);a.remote.set(40,{id:40,url:'https://example.test/'});finish({id:40,title:'처음'});await opening;await navigation;
  assert.equal(a.remote.get(40).url,'https://example.test/next');a.override();a.remote.delete(40);await a.context.syncChromeTabs();
  await a.context.navigate(tab,'https://example.test/reopen');assert.equal(tab.chromeMissing,false);assert.equal(a.calls.at(-1).action,'openBrowser');assert.equal(a.calls.at(-1).url,'https://example.test/reopen');
});
test('local tab selection and a disconnected in-app page never automatically open an external window',async()=>{
  const a=app();a.setConnected(false);const tab=await a.context.openBrowser('https://example.test/');assert.equal(tab.frame.src,'https://example.test/');await a.context.selectTab(tab.id);assert.equal(a.calls.length,0);
  const local={id:'document',type:'document',title:'문서',host:a.doc.createElement('div')};a.context.tabs.push(local);a.setConnected(true);await a.context.selectTab(local.id);assert.equal(a.calls.length,0);
});
