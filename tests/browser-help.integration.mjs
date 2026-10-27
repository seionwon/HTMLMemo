import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createServer} from '../scripts/server.mjs';
import {prepareAssets,root} from '../scripts/assets.mjs';
import {launchChrome} from './chrome.mjs';

async function setup(){
 await prepareAssets();const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await launchChrome(),page=browser.page,url=process.env.HTMLMEMO_SIDEBAR_TEST_URL||'http://127.0.0.1:'+server.address().port;
 await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});await page.navigate(url);
 await page.evaluate(`(async()=>{const s=await import('./src/storage.js');await s.putDocumentRevision({id:'help-preserved',title:'도움말 뒤에도 남는 문서',name:'kept.html',html:'<h1>Kept document</h1><p>Safe content</p>',created:1000,modified:2000,metadata:{version:1,title:'Kept document',source:'',viewport:{width:1000,height:800},view:{scrollTop:0},annotations:[{id:'keep-note',type:'note',anchor:'body',points:[{x:20,y:20}],text:'보존할 메모',color:'#556677',width:2,opacity:1}],bookmarks:[{id:'keep-bookmark',title:'중요한 북마크',top:12,left:0}],execution:{allowScripts:false}}});})()`);
 await page.waitFor('document.querySelector("#data-folder-status").textContent==="폴더 저장 완료"');
 return {page,browser,url,async close(){await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
const preserved=page=>page.evaluate(`(async()=>{const s=await import('./src/storage.js'),record=await s.getDocument('help-preserved');return {id:record.id,title:record.title,html:record.html,annotations:record.metadata.annotations,bookmarks:record.metadata.bookmarks,revisions:(await s.listRevisions(record.id)).length};})()`);
const openHelp=async page=>{await page.click('#settings-button');await page.click('#settings-help');await page.waitFor('document.querySelector(".help-browser h2")?.textContent==="HTMLMemo 도움말"');};
const search=async(page,value)=>page.evaluate(`(()=>{const input=document.querySelector('#help-search');input.value=${JSON.stringify(value)};input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'}));})()`);
const fits=page=>page.evaluate(`(()=>{const dialog=document.querySelector('#dialog'),r=dialog.getBoundingClientRect(),body=document.querySelector('#help-content'),b=body.getBoundingClientRect(),footer=document.querySelector('.help-footer').getBoundingClientRect();return r.left>=-1&&r.top>=-1&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1&&dialog.scrollWidth<=dialog.clientWidth+1&&body.scrollWidth<=body.clientWidth+1&&footer.bottom<=r.bottom+1&&b.bottom<=footer.top+1;})()`);

test('real Chrome: Pages-only searchable help keeps navigation, mobile layouts and document data intact',{timeout:90000},async()=>{
 const f=await setup(),{page}=f;
 try{
  await page.waitFor('!!document.querySelector("[data-open=help-preserved]")');await page.click('[data-open="help-preserved"]');await page.waitFor('!!document.querySelector(".document-host:not([hidden]) iframe")&&document.querySelector("#status-left").textContent.includes("자동 저장됨")');await page.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'s',ctrlKey:true,bubbles:true,cancelable:true}))");await page.waitFor('document.querySelector("#data-folder-status").textContent==="폴더 저장 완료"');
  const before=await preserved(page);await page.click('#settings-button');
  const position=await page.evaluate(`(()=>{const help=document.querySelector('#settings-help'),next=document.querySelector('#settings-execution'),a=help.getBoundingClientRect(),b=next.getBoundingClientRect();return {previous:next.previousElementSibling.id,left:a.left<b.left,sameRow:Math.abs(a.top-b.top)<2};})()`);
  assert.deepEqual(position,{previous:'settings-help',left:true,sameRow:true});await page.click('#settings-help');assert.equal(await fits(page),true);
  assert.equal(await page.evaluate('document.activeElement.id'),'help-article-title');assert.equal(await page.evaluate('document.querySelectorAll(".help-nav-group").length'),4);
  assert.equal(await page.evaluate(`(()=>{const pane=document.querySelector('#help-content');pane.scrollTop=pane.scrollHeight;const bottom=document.querySelector('.help-page-nav').getBoundingClientRect().bottom,edge=pane.getBoundingClientRect().bottom;const ok=pane.scrollTop>0&&bottom<=edge;pane.scrollTop=0;return ok;})()`),true);
  await mkdir(root+'/test-results',{recursive:true});await writeFile(root+'/test-results/pages-only-help-desktop.png',await page.screenshot());
  await search(page,'원본 생략');await page.click('.help-results [data-help-open="device-sync"]');assert.match(await page.evaluate('document.querySelector("#help-article-title").textContent'),/동기화/);
  assert.equal(await page.evaluate('document.querySelector("#help-search").value'),'원본 생략');assert.ok(await page.evaluate('document.querySelectorAll(".help-article mark").length>0'));
  await page.click('#help-results-back');assert.ok(await page.evaluate('!!document.querySelector(".help-results")'));
  await search(page,'<img src=x onerror="window.helpUnsafe=true">');assert.equal(await page.evaluate('!!document.querySelector(".help-results img")||!!window.helpUnsafe'),false);await page.click('#help-empty-clear');
  await page.evaluate('document.querySelector("#help-article-title").focus()');await page.send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'f',code:'KeyF',modifiers:2});await page.send('Input.dispatchKeyEvent',{type:'keyUp',key:'f',code:'KeyF'});assert.equal(await page.evaluate('document.activeElement.id'),'help-search');
  await page.send('Emulation.setUserAgentOverride',{userAgent:'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36'});await page.send('Emulation.setTouchEmulationEnabled',{enabled:true});
  for(const [width,height] of [[390,844],[320,568],[844,390]]){
   await page.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true});
   await page.evaluate(`(()=>{const picker=document.querySelector('#help-topic-select');picker.value='storage-differences';picker.dispatchEvent(new Event('change',{bubbles:true}));})()`);
   if(width<=640)assert.equal(await page.evaluate('getComputedStyle(document.querySelector("#help-nav")).display'),'none');
   assert.equal(await fits(page),true);assert.equal(await page.evaluate('document.querySelector(".help-content table tbody").rows.length'),5);
   await page.evaluate("document.documentElement.dataset.theme='dark'");await writeFile(root+`/test-results/pages-only-help-dark-${width}.png`,await page.screenshot());await page.evaluate("document.documentElement.dataset.theme='light'");
  }
  await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await search(page,'데이터 복원');await writeFile(root+'/test-results/pages-only-help-phone-search.png',await page.screenshot());
  await page.click('.help-results [data-help-open="backup-restore"]');assert.match(await page.evaluate('document.querySelector(".help-article").textContent'),/서버에서 대신 복구/);assert.equal(await fits(page),true);
  await page.click('#help-back-settings');assert.equal(await page.evaluate('document.activeElement.id'),'settings-help');await page.click('#settings-help');await page.click('.help-header [data-dialog-close]');await page.waitFor('!document.querySelector("#dialog").open');
  assert.equal(await page.evaluate('document.activeElement.id'),'settings-button');assert.equal(await page.evaluate('document.querySelectorAll(".tab.document").length'),1);assert.deepEqual(await preserved(page),before);assert.deepEqual(f.browser.errors,[]);
  await writeFile(root+'/test-results/pages-only-help.json',JSON.stringify({url:f.url,topics:32,widths:[1280,390,320,844],search:true,backAndClose:true,preserved:true,hardwareAndroidTested:false,status:'pass'},null,2)+'\n');
 }finally{await f.close();}
});

test('real Chrome: Pages-only help and search reopen offline after a complete app reload',{timeout:90000},async()=>{
 const f=await setup(),{page}=f;
 try{
  const before=await preserved(page);await page.waitFor('!!navigator.serviceWorker?.controller',30000);
  await page.evaluate('window.helpBeforeReload=true');await page.send('Network.enable');await page.send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:-1,uploadThroughput:-1});
  await page.navigate(f.url);assert.equal(await page.evaluate('window.helpBeforeReload'),undefined);await openHelp(page);await search(page,'휴지통 영구 삭제');await page.click('.help-results [data-help-open="trash"]');
  assert.match(await page.evaluate('document.querySelector(".help-article").textContent'),/되돌릴 수 없습니다/);assert.equal(await fits(page),true);assert.deepEqual(await preserved(page),before);
  await mkdir(root+'/test-results',{recursive:true});await writeFile(root+'/test-results/pages-only-help-offline.png',await page.screenshot());assert.deepEqual(f.browser.errors,[]);
 }finally{await f.close();}
});
