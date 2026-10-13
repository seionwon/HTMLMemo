import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {readAloudRoot,isReadAloudChrome} from '../public/src/read-aloud.js';
const doc=html=>parseHTML('<!doctype html><html><body>'+html+'</body></html>').document;
test('TTS selects main pane instead of earlier table of contents',()=>{
 const d=doc('<aside><h2>목차</h2><article>소개</article></aside><main id="prose"><p>본문</p></main>');
 assert.equal(readAloudRoot(d).id,'prose');assert.equal(isReadAloudChrome(d.querySelector('aside h2')),true);
});
test('book prose markers and main roles are recognized',()=>{
 for(const html of ['<div class="sidebar">목차</div><div role="main" id="prose">본문</div>','<nav>목차</nav><div class="wm-doc" id="prose">본문</div>','<aside>목차</aside><div class="book-content" id="prose">본문</div>'])assert.equal(readAloudRoot(doc(html)).id,'prose');
});
test('navigation nested inside a main pane is still excluded',()=>{
 for(const marker of ['nav','aside','div role="navigation"','div class="toc"','div id="toc"','div class="sidebar"','div data-toc']){
  const d=doc('<main><'+marker+'><span>목차</span></'+marker.split(' ')[0]+'><p>본문</p></main>');
  assert.equal(isReadAloudChrome(d.querySelector('span')),true);assert.equal(isReadAloudChrome(d.querySelector('p')),false);
 }
});
test('plain HTML can still be read and hidden main panes are not chosen',()=>{
 const d=doc('<main hidden>숨김</main><main id="visible">본문</main>');assert.equal(readAloudRoot(d).id,'visible');
 const plain=doc('<p>본문만 있는 파일</p>');assert.equal(readAloudRoot(plain),plain.body);
});
