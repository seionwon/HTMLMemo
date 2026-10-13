// Requires permission to bind localhost and launch a dedicated Chrome process.
// These are real browser checks, separate from the DOM/unit test suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { root, prepareAssets } from '../scripts/assets.mjs';
import { createServer } from '../scripts/server.mjs';
import { launchChrome } from './chrome.mjs';
import { FORMAT_VERSION } from '../public/src/model.js';
test('real Chrome: MemoSuite TTS toolbar in HTMLMemo',{timeout:90000},async t=>{
  await prepareAssets();const folder=await mkdtemp(join(tmpdir(),'htmlmemo-web-test-'));await cp(join(root,'public'),folder,{recursive:true});await cp(join(root,'tests/fixtures'),join(folder,'fixtures'),{recursive:true});
  const server=createServer(folder);let chrome;
  try{
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const url=`http://127.0.0.1:${server.address().port}/`;chrome=await launchChrome();const page=chrome.page;
    await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});await page.navigate(url);await page.waitFor('document.querySelector("#status-left").textContent.includes("개의 문서")');
    await t.test('browser navigation and single-file capture',async()=>{
      await page.evaluate(`document.querySelector('#address').value=${JSON.stringify(url+'fixtures/capture.html')};document.querySelector('#address-form').requestSubmit();`);
      await page.waitFor('document.querySelector(".browser-frame")?.contentDocument?.title === "캡처 검증 문서"');
      // A native OPFS FileSystemFileHandle exercises the same browser write and
      // IndexedDB structured-clone contracts as an external picked file.
      await page.evaluate(`window.showSaveFilePicker=async()=>{const root=await navigator.storage.getDirectory();return root.getFileHandle('picked-document.html',{create:true});};`);
      await page.click('#save-page');await page.waitFor('!document.querySelector("#toolbar").hidden && document.querySelector("#status-left").textContent.includes("자동 저장됨")');
      const html=await page.evaluate(`(async()=>{const root=await navigator.storage.getDirectory();return (await (await root.getFileHandle('picked-document.html')).getFile()).text();})()`);assert.match(html,/data:image\/svg\+xml;base64/);assert.match(html,/htmlmemo-data/);assert.ok(!html.includes('fixtureLoaded'));
    });
    await t.test('MemoSuite toolbar opens without speech and retains original controls and styling',async()=>{try {
      await page.evaluate(`window.__speechCalls=[];window.__utterances=[];window.SpeechSynthesisUtterance=class{constructor(text){this.text=text;this.rate=1;this.pitch=1;this.volume=1;this.voice=null;}};const engine=new EventTarget();engine.getVoices=()=>[{voiceURI:'ko-test',name:'Google 한국어',lang:'ko-KR',localService:false},{voiceURI:'junk',name:'eSpeak',lang:'ko-KR',localService:true},{voiceURI:'en-test',name:'Google English',lang:'en-US',localService:false}];engine.cancel=()=>window.__speechCalls.push(['cancel']);engine.speak=u=>{window.__utterances.push(u);window.__speechCalls.push(['speak',u.text,u.lang,u.rate]);};void Object.defineProperty(window,'speechSynthesis',{configurable:true,value:engine});`);
      await page.click('#toolbar [data-action=speak]');
      await page.waitFor('!!document.querySelector("[data-memo-readaloud]")');
      assert.deepEqual(await page.evaluate('window.__speechCalls'),[]);
      assert.deepEqual(await page.evaluate('[...document.querySelectorAll(".mstts-player > button")].map(b=>b.textContent)'),['▶','⏮','⏭','1×','⚙','⏹','✕']);
      assert.deepEqual(await page.evaluate(`(()=>{const s=getComputedStyle(document.querySelector('.mstts-player'));return [s.padding,s.gap,s.borderRadius,s.fontSize,s.fontWeight,s.position];})()`),['4px 10px 4px 6px','2px','999px','12px','600','fixed']);
      await page.click('.mstts-player [aria-label="낭독 설정"]');
      await page.waitFor('!!document.querySelector(".mstts-panel")');
      await page.click('.mstts-select-trigger[aria-label="음성"]');
      assert.deepEqual(await page.evaluate('[...document.querySelectorAll("[role=option]")].map(b=>b.textContent.replace("✓",""))'),['자동 (UI 언어)','Google 한국어']);
      await page.evaluate(`document.querySelectorAll('[role=option]')[1].click();`);
      assert.equal(await page.evaluate('localStorage.getItem("msuite_tts_voice_ko")'),'ko-test');
      await writeFile('/tmp/htmlmemo-tts-toolbar-desktop.png',await page.screenshot());
      await page.click('.mstts-player [aria-label="소리내어 읽기"]');
      await page.waitFor('window.__utterances.length===1');
      assert.equal(await page.evaluate('window.__utterances[0].voice.voiceURI'),'ko-test');
      assert.equal(await page.evaluate('!!document.querySelector(".mstts-panel")'),false);
      assert.equal(await page.evaluate('!!document.querySelector(".document-host:not([hidden]) iframe").contentWindow.CSS.highlights.get("mstts")'),true);
      const first=await page.evaluate('window.__utterances[0].text');
      await page.click('.mstts-player [aria-label="일시정지"]');
      await page.evaluate('window.__utterances[0].onend()');
      assert.equal(await page.evaluate('window.__utterances.length'),1);
      await page.click('.mstts-player [aria-label="소리내어 읽기"]');
      assert.equal(await page.evaluate('window.__utterances.at(-1).text'),first);
      await page.click('.mstts-player [aria-label="다음 문장"]');
      assert.notEqual(await page.evaluate('window.__utterances.at(-1).text'),first);
      await page.click('.mstts-player [aria-label="이전 문장"]');
      assert.equal(await page.evaluate('window.__utterances.at(-1).text'),first);
      await page.click('.mstts-player [aria-label="읽는 속도"]');
      assert.equal(await page.evaluate('localStorage.getItem("msuite_tts_rate")'),'1.25');
      await page.click('.mstts-player [aria-label="정지"]');
      assert.equal(await page.evaluate('!!document.querySelector(".mstts-player")'),true);
      assert.equal(await page.evaluate('!!document.querySelector(".document-host:not([hidden]) iframe").contentWindow.CSS.highlights.get("mstts")'),false);
      await page.click('.mstts-player [aria-label="낭독 설정"]');
      await page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
      assert.equal(await page.evaluate('!!document.querySelector(".mstts-panel")'),false);
      assert.equal(await page.evaluate('!!document.querySelector(".mstts-player")'),true);
      await page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
      assert.equal(await page.evaluate('!!document.querySelector(".mstts-player")'),false);
      await page.click('#toolbar [data-action=speak]');
      assert.equal(await page.evaluate(`document.querySelector('.mstts-player [aria-label="읽는 속도"]').textContent`),'1.25×');
      await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
      await page.click('.mstts-player [aria-label="낭독 설정"]');
      await writeFile('/tmp/htmlmemo-tts-toolbar-mobile.png',await page.screenshot());
      assert.equal(await page.evaluate(`(()=>{const r=document.querySelector('.mstts-player').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;})()`),true);
      await page.click('.mstts-player [aria-label="낭독 설정"]');
      // Real pointer drag, not a CSS-only position change.
      const grip=await page.evaluate(`(()=>{const r=document.querySelector('.mstts-grip').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      await page.send('Input.dispatchMouseEvent',{type:'mousePressed',x:grip.x,y:grip.y,button:'left',clickCount:1});
      await page.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:grip.x+32,y:150,button:'left',buttons:1});
      await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:grip.x+32,y:150,button:'left',clickCount:1});
      const moved=await page.evaluate('document.querySelector(".mstts-player").getBoundingClientRect().top');
      assert.ok(moved<200);
      await page.click('.mstts-player [aria-label="플레이어 닫기"]');await page.click('#toolbar [data-action=speak]');
      assert.equal(await page.evaluate('document.querySelector(".mstts-player").getBoundingClientRect().top'),moved);
      await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
      await page.evaluate(`document.querySelector('.document-host:not([hidden]) iframe').contentDocument.body.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,button:0,cancelable:true}));`);
      await page.waitFor('document.querySelector("#app").classList.contains("reader-focus")');
      assert.equal(await page.evaluate('document.querySelector("#app").contains(document.querySelector(".mstts-player"))'),true);
      await page.click('.mstts-player [aria-label="소리내어 읽기"]');
      const count=await page.evaluate('window.__utterances.length');
      await page.click('.mstts-player [aria-label="플레이어 닫기"]');
      await page.evaluate('window.__utterances.at(-1).onend()');assert.equal(await page.evaluate('window.__utterances.length'),count);
      await page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
      await page.waitFor('!document.querySelector("#app").classList.contains("reader-focus")');
      await page.click('#toolbar [data-action=speak]');await page.click('#library-tab');
      assert.equal(await page.evaluate('!!document.querySelector(".mstts-player")'),false);
      assert.equal(chrome.errors.length,0,chrome.errors.join('\n'));
      }catch(error){console.error(error,chrome.errors,await page.evaluate('({toast:document.querySelector("#toast")?.textContent,bar:document.querySelector(".mstts-player")?.outerHTML,calls:window.__speechCalls})'));throw error;}
    });
  } finally { await chrome?.close();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true}); }
});
