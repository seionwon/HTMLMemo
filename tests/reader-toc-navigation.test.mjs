import test from 'node:test';
import assert from 'node:assert/strict';
import {Reader} from '../public/src/reader.js';
import {IsolatedRuntime} from '../public/src/isolated-runtime.js';
import {documentFor,installDOM} from './dom.mjs';

function navigation({isolated=true}={}){
  installDOM();const doc=documentFor('<html><head></head><body><nav id="toc"><a href="#chapter" data-htmlmemo-runtime-id="r1">첫 장</a><a href="#%EC%A0%88" data-htmlmemo-runtime-id="r2">다음 절</a><details><summary><a href="#children" data-htmlmemo-runtime-id="r3">분류</a></summary><div id="children">하위 목차</div></details></nav><main><h1 id="chapter">첫 장</h1><h2 id="절">다음 절</h2><a href="#chapter" data-htmlmemo-runtime-id="r4">본문 링크</a></main></body></html>');
  const sent=[],jumps=[],r=Object.create(Reader.prototype);Object.assign(r,{doc,viewport:doc.createElement('div'),metadata:{annotations:[],bookmarks:[],execution:{allowScripts:isolated}},callbacks:{},linkHistory:[],tool:'select',zoom:1,scrollTop:0,scrollLeft:0});
  // Keep the real reader and isolation click listeners; geometry and observers
  // are outside this event-routing check.
  for(const name of ['setupDocumentTocResize','startFontObserver','startDynamicObserver'])r[name]=()=>{};
  r.baseEditorStyle=()=>'';r.jump=node=>jumps.push(node.id);
  if(isolated){r.runtime=new IsolatedRuntime({doc,host:{ownerDocument:doc},source:new Blob(['fixture'])});r.runtime.index(doc.documentElement);r.runtime.send=value=>sent.push(value);r.runtime.bind();}
  r.bind();
  const click=selector=>{const e=new doc.defaultView.Event('click',{bubbles:true,cancelable:true});doc.querySelector(selector).dispatchEvent(e);return e;};
  return {doc,r,sent,jumps,click};
}
test('isolated source TOC links reach existing content anchors while preserving their original click dispatch',()=>{
  const a=navigation();a.click('nav a[href="#chapter"]');assert.deepEqual(a.jumps,['chapter']);assert.deepEqual(a.sent,[{type:'click',id:'r1'}]);
  a.r.tool='pen';a.click('nav a[href="#%EC%A0%88"]');assert.deepEqual(a.jumps,['chapter','절']);assert.equal(a.sent.at(-1).id,'r2');
  a.click('summary a');assert.deepEqual(a.jumps,['chapter','절'],'a TOC disclosure target is not a body destination');
});
test('ordinary HTML anchor navigation and source-prevented body links retain their existing behavior',()=>{
  const plain=navigation({isolated:false});plain.click('nav a[href="#chapter"]');assert.deepEqual(plain.jumps,['chapter']);
  const isolated=navigation();isolated.click('main a');assert.deepEqual(isolated.jumps,[],'the TOC exception must not override source-owned body interactions');assert.equal(isolated.sent.at(-1).id,'r4');
  const search=navigation(),host=search.doc.createElement('section');host.setAttribute('data-htmlmemo-ui','');search.doc.querySelector('nav').append(host);host.append(search.doc.querySelector('nav a'));search.click('section a');assert.deepEqual(search.jumps,[],'app-owned whole-book search retains its own keyword navigation');
});
test('re-clicking the current book chapter returns the visible reader to its beginning after a bookmark jump',async()=>{
  const a=navigation(),script=a.doc.createElement('script');script.id='book-manifest';script.type='application/json';script.textContent=JSON.stringify({format:'memosuite-book-html-v1',volumes:[{label:'책',sections:[{key:'v0:one',title:'첫 장'}]}]});a.doc.head.append(script);
  const content=a.doc.querySelector('main');content.id='reader-content';content.dataset.section='v0:one';a.doc.querySelector('nav a').setAttribute('href','#v0%3Aone');a.r.viewport.scrollTop=400;a.r.viewport.scrollLeft=20;
  a.click('nav a');assert.equal(a.r.scrollTop,0);assert.equal(a.r.scrollLeft,0);assert.deepEqual(a.sent,[{type:'click',id:'r1'}]);assert.equal(await a.r.jumpOutlineSection('missing'),false);
});
