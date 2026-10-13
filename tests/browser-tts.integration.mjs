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
test('real Chrome: browsing, capture, local annotation, file writes, reopen and offline',{timeout:90000},async t=>{
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
    await t.test('HTMLMemoEx selection menu reads only the chosen text and Escape cancels',async()=>{ try {
      await page.evaluate(`window.__speechCalls=[];void Object.defineProperty(window,'speechSynthesis',{configurable:true,value:{cancel(){window.__speechCalls.push(['cancel']);},speak(u){window.__speechCalls.push(['speak',u.text,u.lang,u.rate,u.pitch,u.volume,u.voice]);}}});`);
      await page.evaluate(`(()=>{const doc=document.querySelector('.document-host:not([hidden]) iframe').contentDocument;const text=doc.querySelector('#selection').firstChild;const range=doc.createRange();range.setStart(text,0);range.setEnd(text,15);doc.getSelection().removeAllRanges();doc.getSelection().addRange(range);doc.dispatchEvent(new Event('selectionchange'));doc.body.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,button:0}));window.__expectedQuote=range.toString();})()`);
      await page.waitFor('!document.querySelector("#tool-popover").hidden && !!document.querySelector("[data-selection=speak]")');
      assert.deepEqual(await page.evaluate('[...document.querySelectorAll("[data-selection]")].map(b=>b.textContent)'),['복사','형광펜','밑줄','메모','읽어주기','웹 검색']);
      assert.equal(await page.evaluate('!!document.querySelector("#toolbar [data-action=speak]")'),false);
      await page.click('[data-selection=speak]');
      const result=await page.evaluate('({calls:window.__speechCalls,quote:window.__expectedQuote,hidden:document.querySelector("#tool-popover").hidden})');
      assert.equal(result.calls[0][0],'cancel');assert.equal(result.calls[1][0],'speak');assert.equal(result.calls[1][1],result.quote);assert.deepEqual(result.calls[1].slice(3),[1,1,1,null]);assert.equal(result.hidden,true);
      await page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
      assert.deepEqual(await page.evaluate('window.__speechCalls.map(c=>c[0])'),['cancel','speak','cancel']);
      await page.evaluate(`(()=>{const doc=document.querySelector('.document-host:not([hidden]) iframe').contentDocument;doc.body.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,button:0}));})()`);
      await page.waitFor('!document.querySelector("#tool-popover").hidden');
      await page.click('[data-selection=note]');await page.waitFor('document.querySelector("#dialog").open');
      await page.evaluate(`document.querySelector('#note-text').value='선택 구절 메모';`);
      await page.click('#dialog button[value=save]');
      await page.waitFor('document.querySelector(".document-host:not([hidden]) iframe").contentDocument.querySelector("svg")?.textContent.includes("선택 구절 메모")');
      } catch(error) { console.error(error);throw error; }
    });
  } finally { await chrome?.close();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true}); }
});
