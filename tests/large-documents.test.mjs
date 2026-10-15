import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser as Parser } from 'linkedom';
import { installDOM, documentFor } from './dom.mjs';
import { parseHTML, prepareLoadedHTML, serializeHTML, DATA_ID } from '../public/src/document.js';
import { Reader } from '../public/src/reader.js';
installDOM();

test('a 50,001-page local book retains its last page and safe standalone metadata', () => {
  const pages = Array.from({length:50001}, (_, i) => `<section id="page-${i}"><h2>페이지 ${i+1}</h2><p>${'책 내용 한글 English '.repeat(16)}</p></section>`).join('');
  const parsed = parseHTML(`<html><head><title>큰 책</title></head><body>${pages}<script>steal()</script></body></html>`, {}, {includeMetadata:true});
  assert.equal(parsed.nativeScroll, true);
  const doc = new Parser().parseFromString(parsed.html, 'text/html');
  assert.equal(doc.querySelectorAll('section').length, 50001);
  assert.equal(doc.querySelector('#page-50000 h2').textContent, '페이지 50001');
  assert.equal(doc.querySelector('#page-50000').getAttribute('data-htmlmemo-anchor'), 'n150000');
  assert.equal(doc.querySelectorAll('script').length, 1);
  assert.equal(JSON.parse(doc.getElementById(DATA_ID).textContent).title, '큰 책');
  assert.ok(!parsed.html.includes('steal()'));
});

test('small HTML keeps its original reader and prepared metadata escapes markup', () => {
  const parsed = parseHTML('<html><head><title>&lt;/script&gt;</title></head><body><p>Hello</p></body></html>', {}, {includeMetadata:true});
  assert.equal(parsed.nativeScroll, false);
  assert.match(parsed.html, /\\u003c\/script>/);
  const reopened = parseHTML(parsed.html);
  assert.equal(reopened.metadata.title, '</script>');
  assert.equal(reopened.metadata.annotations.length, 0);
  assert.equal(documentFor(reopened.html).body.textContent, 'Hello');
});

function nativeReader() {
  const r = Object.create(Reader.prototype);
  r.nativeScroll = true; r.zoom = 1; r.naturalWidth = 1100;
  r.viewport = {clientHeight:700, clientWidth:1000, scrollTop:0, scrollLeft:0};
  r.frame = {style:{}}; r.sizer = {style:{}};
  const view = {scrollY:12000, scrollX:0, scrollTo(x,y){this.scrollX=x;this.scrollY=y;}};
  r.doc = {body:{scrollHeight:50000000, get children(){throw new Error('Must not measure 50,001 children');}}, documentElement:{scrollHeight:50000000}, defaultView:view};
  r.metadata = {view:{}, bookmarks:[], annotations:[]};r.callbacks = {};
  return r;
}

test('a fifty-million-pixel book uses a bounded iframe and restores reading position across zoom', () => {
  const r = nativeReader();r.measure();
  assert.equal(r.frame.style.height, '700px');assert.equal(r.sizer.style.height, '700px');
  assert.equal(r.naturalHeight, 50000000);
  r.scrollTop = 20000;assert.equal(r.doc.defaultView.scrollY, 20000);
  r.setZoom(2);
  assert.equal(r.frame.style.height, '350px');assert.equal(r.sizer.style.height, '700px');
  assert.equal(r.doc.defaultView.scrollY, 20175);
  assert.equal(r.metadata.view.scrollTop, 40350);assert.equal(r.metadata.view.zoom, 2);
  r.addBookmark('읽던 곳');assert.equal(r.metadata.bookmarks[0].top, 20175);
  r.scrollTop = 0;r.scrollTop = r.metadata.bookmarks[0].top*r.zoom;
  assert.equal(r.doc.defaultView.scrollY, 20175);
});

test('native scrolling keeps drawing anchors in document coordinates and exported notes reopen', () => {
  const r = nativeReader();
  r.doc = documentFor('<html><head></head><body><p data-htmlmemo-anchor="n0">본문</p></body></html>');
  Object.defineProperty(r.doc, 'defaultView', {value:{scrollX:40,scrollY:12000},configurable:true});
  const target = r.doc.querySelector('p');target.getBoundingClientRect = () => ({left:10,top:100,width:200,height:80});
  assert.deepEqual(r.elementAnchor(target), {key:'n0',x:50,y:12100,width:200,height:80});
  const note = {id:'large-note',type:'note',anchor:'n0',points:[{x:.5,y:.5}],color:'#edcf67',width:3,opacity:1,text:'읽던 곳 메모'};
  r.metadata.annotations = [note];
  assert.deepEqual(r.absolutePoints(note), [{x:150,y:12140}]);
  r.renderDrawingLayer();assert.equal(r.layer.getAttribute('height'), '1');
  assert.equal(r.layer.querySelector('rect').getAttribute('y'), '12140');
  const reopened = parseHTML(serializeHTML(r.doc,r.metadata));
  assert.deepEqual(reopened.metadata.annotations, [note]);
});

test('native outline and internal-link jumps use current document scroll, and back returns to the prior position', async () => {
  const r = nativeReader();const target = {getBoundingClientRect:() => ({top:800,left:0,width:100,height:60})};
  const before = r.scrollTop;r.linkHistory = [{top:before,left:0}];r.jump(target);
  assert.equal(r.doc.defaultView.scrollY, 12480);
  assert.equal(await r.back(), true);assert.equal(r.doc.defaultView.scrollY, 12000);
});

test('disposing a large reader releases its local Blob URL without touching files', () => {
  const r = nativeReader();const url = URL.createObjectURL(new Blob(['local HTML']));
  r.documentURL = url;r.host = {remove(){}};r.dispose();
  assert.equal(r.documentURL, null);assert.equal(r.disposed, true);
});


test('native preparation yields between batches, retains annotation anchors, and supports cancellation',async()=>{
  const doc=documentFor('<html><head><title>Batched book</title></head><body>'+ '<p onclick="bad()">Page</p>'.repeat(4000)+'</body></html>');
  let tick=false;setTimeout(()=>{tick=true;},0);
  const prepared=await prepareLoadedHTML(doc);assert.equal(tick,true);assert.equal(prepared.metadata.title,'Batched book');
  assert.equal(doc.body.lastElementChild.getAttribute('data-htmlmemo-anchor'),'n3999');assert.ok(!prepared.html.includes('onclick'));
  await assert.rejects(prepareLoadedHTML(documentFor('<html><head></head><body>Cancelled</body></html>'),{},()=>true),{name:'AbortError'});
});

test('late generated content receives stable anchors without unnecessary annotation autosaves',async()=>{
  const r=Object.create(Reader.prototype);r.doc=documentFor('<html><head></head><body><p>Late content</p><p data-htmlmemo-anchor="existing">Keep</p></body></html>');r.dynamicAnchor=0;r.metadata={execution:{allowScripts:true},annotations:[]};
  let saved=0,rendered=0;r.measure=()=>{};r.render=()=>{rendered++;};r.callbacks={onChange(){saved++;}};
  await r.refreshDynamicDocument();assert.equal(r.doc.querySelector('p').getAttribute('data-htmlmemo-anchor'),'js0');assert.equal(r.doc.body.lastElementChild.getAttribute('data-htmlmemo-anchor'),'existing');assert.equal(saved,0);assert.equal(rendered,1);
  await r.refreshDynamicDocument();assert.equal(r.doc.querySelector('p').getAttribute('data-htmlmemo-anchor'),'js0');assert.equal(r.dynamicAnchor,1);
});

test('a packed JavaScript book expands its gzip payload and the generated paragraphs become annotatable',async()=>{
  const {gzipSync}=await import('node:zlib');const vm=await import('node:vm');
  const packed=gzipSync(Buffer.from('<p id="expanded">압축에서 복원된 본문</p>')).toString('base64');
  const source=`<html><head></head><body><div id="book">불러오는 중…</div><script>globalThis.finished=(async()=>{const response=await fetch('data:application/gzip;base64,${packed}');const text=await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).text();document.getElementById('book').innerHTML=text;})();</script></body></html>`;
  const parsed=parseHTML(source,{}, {allowScripts:true});const doc=documentFor(parsed.html);const context=vm.createContext({document:doc,fetch,Response,DecompressionStream});
  vm.runInContext(doc.querySelector('script').textContent,context);await context.finished;
  assert.equal(doc.querySelector('#expanded').textContent,'압축에서 복원된 본문');
  const r=Object.create(Reader.prototype);r.doc=doc;r.metadata=parsed.metadata;r.dynamicAnchor=0;r.measure=()=>{};r.render=()=>{};r.callbacks={};await r.refreshDynamicDocument();
  assert.ok(doc.querySelector('#expanded').hasAttribute('data-htmlmemo-anchor'));
  const saved=serializeHTML(doc,r.metadata);assert.equal(parseHTML(saved).metadata.execution.allowScripts,true);assert.ok(saved.includes(packed));assert.ok(saved.includes('압축에서 복원된 본문'));
});
