import test from 'node:test';
import assert from 'node:assert/strict';
import {Reader} from '../public/src/reader.js';
import {parseHTML,serializeHTML,textIndex} from '../public/src/document.js';
import {documentFor,installDOM} from './dom.mjs';
installDOM();
function fixture(header=''){
  const outer=documentFor('<html><head></head><body><div id="host"><div class="reader-viewport"></div></div></body></html>');
  const doc=documentFor('<html><head></head><body>'+header+'<main><p data-htmlmemo-anchor="n0">본문 그대로 보존.</p></main></body></html>');
  const r=Object.create(Reader.prototype),calls=[];
  Object.assign(r,{host:outer.querySelector('#host'),doc,zoom:1.25,topbarNode:doc.querySelector('header'),metadata:{annotations:[],view:{}},callbacks:{onReadingAction:(action,node)=>calls.push({action,node})}});
  return {r,doc,outer,calls};
}
test('zoom joins native second-row controls without replacing the book TTS or its handler',()=>{
  const {r,doc,calls}=fixture('<header class="topbar"><strong>책</strong><div class="controls"><button id="native-tts" title="TTS">TTS</button></div></header>');
  const native=doc.querySelector('#native-tts'),handler=()=>{};native.onclick=handler;
  const text=textIndex(doc).text;r.setupReadingControls();
  assert.equal(r.readingControls.parentElement,doc.querySelector('.controls'));
  assert.equal(r.zoomControl.textContent,'125%');assert.equal(doc.querySelectorAll('[data-action=zoom]').length,1);
  assert.equal(doc.querySelector('[data-action=speak]'),null);assert.strictEqual(native.onclick,handler);
  assert.equal(textIndex(doc).text,text);assert.equal(r.host.classList.contains('reader-controls-row'),false);
  r.zoomControl.onclick();assert.deepEqual(calls,[{action:'zoom',node:r.zoomControl}]);
  r.setupReadingControls();assert.equal(doc.querySelectorAll('[data-htmlmemo-reading-controls]').length,1);
});
test('plain documents retain zoom and one TTS entry in an unscaled upper reading row',()=>{
  const {r,doc,outer,calls}=fixture();r.setupReadingControls();
  assert.equal(r.host.firstElementChild,r.readingControls);assert.equal(r.host.classList.contains('reader-controls-row'),true);
  assert.deepEqual([...r.readingControls.querySelectorAll('button')].map(node=>node.dataset.action),['zoom','speak']);
  assert.equal(r.readingControls.ownerDocument,outer);assert.equal(doc.querySelector('[data-htmlmemo-reading-controls]'),null);
  r.speechControl.onclick();assert.deepEqual(calls,[{action:'speak',node:r.speechControl}]);
  r.zoom=.2;r.updateReadingControls();assert.equal(r.zoomControl.textContent,'20%');
  r.zoom=8;r.updateReadingControls();assert.equal(r.zoomControl.textContent,'800%');
});
test('reading controls are restored once after a native header is replaced or removed',()=>{
  const {r,doc}=fixture('<header class="topbar"><button>TTS</button></header>');r.setupReadingControls();const old=r.readingControls;
  r.topbarNode.remove();r.setupReadingControls();assert.equal(old.isConnected,false);assert.equal(r.readingControls.ownerDocument,r.host.ownerDocument);
  assert.equal(r.readingControls.querySelectorAll('[data-action=speak]').length,1);
  const header=doc.createElement('header');header.className='topbar';header.innerHTML='<button aria-label="소리내어 읽기">▶</button>';
  doc.body.prepend(header);r.setupReadingControls();
  assert.equal(r.topbarNode,header);assert.equal(header.querySelectorAll('[data-action=zoom]').length,1);assert.equal(header.querySelector('[data-action=speak]'),null);
  r.setupReadingControls();assert.equal(header.querySelectorAll('[data-htmlmemo-reading-controls]').length,1);
});
test('native controls without TTS keep exactly one app read-aloud entry',()=>{
  const {r,doc}=fixture('<header class="topbar"><div class="controls"><button>A+</button></div></header>');r.setupReadingControls();r.setupReadingControls();
  assert.equal(doc.querySelectorAll('[data-action=speak]').length,1);
  const native=doc.createElement('button');native.className='mstts-launch';doc.querySelector('.controls').prepend(native);r.setupReadingControls();
  assert.equal(doc.querySelector('[data-action=speak]'),null);assert.equal(native.isConnected,true);
});
test('reader-only controls and styles never change export text offsets or the book toolbar',()=>{
  const {r,doc}=fixture('<header class="topbar"><button id="tts" onclick="window.bookSpeech=true">TTS</button></header>');
  const text=textIndex(doc).text;r.setupReadingControls();assert.equal(textIndex(doc).text,text);
  const saved=serializeHTML(doc,r.metadata);assert.doesNotMatch(saved,/data-htmlmemo-reading-controls|htmlmemo-reading-controls-style|data-action="zoom"/);
  const reopened=parseHTML(saved,{}, {allowScripts:true}),clean=documentFor(reopened.html);
  assert.equal(textIndex(clean).text,text);assert.equal(clean.querySelector('#tts').getAttribute('onclick'),'window.bookSpeech=true');
  assert.equal(doc.querySelector('[data-action=zoom]'),r.zoomControl,'export cleans a clone, not the active reader');
});
test('zoom label updates are safe before the reader has a document or controls',()=>{
  const r=Object.create(Reader.prototype);r.frame={getBoundingClientRect(){throw Error('not laid out');}};r.viewport=r.frame;
  assert.doesNotThrow(()=>r.updateReadingControls());
});
test('native top-row zoom stays reachable when the enlarged page is horizontally panned',()=>{
  const {r}=fixture('<header class="topbar"><button>TTS</button></header>');r.setupReadingControls();
  let left=-300;const shift=()=>Number.parseFloat(r.readingControls.style.getPropertyValue('--htmlmemo-controls-shift'))||0;
  r.frame={offsetWidth:960,getBoundingClientRect:()=>({left,width:1200})};
  r.viewport={getBoundingClientRect:()=>({left:0,right:390,width:390})};
  r.readingControls.getBoundingClientRect=()=>({left:860+shift(),right:910+shift(),width:50});
  for(left of [-300,-600,0]){
    r.updateReadingControls();const right=left+(910+shift())*1.25;
    assert.ok(right<=390&&right>=387);const previous=shift();r.updateReadingControls();assert.equal(shift(),previous,'repeated updates do not accumulate the shift');
  }
});
