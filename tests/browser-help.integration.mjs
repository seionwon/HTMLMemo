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
const fits=page=>page.evaluate(`(()=>{const dialog=document.querySelector('#dialog'),r=dialog.getBoundingClientRect(),body=document.querySelector('#help-content'),b=body.getBoundingClientRect(),footerNode=document.querySelector('.help-footer'),footer=footerNode.getBoundingClientRect(),end=footerNode.checkVisibility()?footer.top:r.bottom;return r.left>=-1&&r.top>=-1&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1&&dialog.scrollWidth<=dialog.clientWidth+1&&body.scrollWidth<=body.clientWidth+1&&footer.bottom<=r.bottom+1&&body.clientHeight>=60&&b.bottom<=end+1;})()`);
const helpContrast=page=>page.evaluate(`(()=>{
 const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');
 const luminance=color=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);const rgb=[...ctx.getImageData(0,0,1,1).data].slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;};
 const pairs=[['title','#help-article-title','.help-browser'],['section','.help-section h4','.help-browser'],['category','.help-article .help-eyebrow','.help-browser'],['selected','#help-nav [aria-current=page]','#help-nav [aria-current=page]'],['group','#help-nav [aria-current=page]','#help-nav'],['note','.help-note strong','.help-note'],['table','.help-content thead th','.help-content thead']];
 const checks={};for(const [name,front,back] of pairs){const f=name==='group'?document.querySelector('#help-nav [aria-current=page]')?.closest('.help-nav-group').querySelector('h3'):document.querySelector(front),b=document.querySelector(back);if(!f||!b)continue;const a=luminance(getComputedStyle(f).color),z=luminance(getComputedStyle(b).backgroundColor);checks[name]=(Math.max(a,z)+.05)/(Math.min(a,z)+.05);}
 return checks;
})()`);

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
  const colorChecks=[];
  for(const theme of ['light','dark'])for(const topic of ['first-document','speech','storage-differences','save-problems']){
   await page.evaluate(`(()=>{document.documentElement.dataset.theme=${JSON.stringify(theme)};const picker=document.querySelector('#help-topic-select');picker.value=${JSON.stringify(topic)};picker.dispatchEvent(new Event('change',{bubbles:true}));})()`);
   const ratios=await helpContrast(page);for(const [part,ratio] of Object.entries(ratios))assert.ok(ratio>=4.5,`${theme}/${topic}/${part}: contrast ${ratio}`);
   colorChecks.push({theme,topic,ratios});assert.equal(await fits(page),true);
   if(theme==='dark'&&topic==='first-document')await writeFile(root+'/test-results/pages-only-help-color-dark-1280.png',await page.screenshot());
  }
  await writeFile(root+'/test-results/pages-only-help-colors.json',JSON.stringify({checks:colorChecks,minimumTextContrast:4.5,status:'pass'},null,2)+'\n');
  await page.evaluate(`(()=>{document.documentElement.dataset.theme='light';const picker=document.querySelector('#help-topic-select');picker.value='first-document';picker.dispatchEvent(new Event('change',{bubbles:true}));})()`);
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
   await writeFile(root+`/test-results/pages-only-help-light-${width}.png`,await page.screenshot());
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
