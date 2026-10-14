import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { documentFor, installDOM } from './dom.mjs';
import { parseHTML, prepareLoadedHTML, serializeHTML, textIndex, wrapOffsets, resolveTextAnchor, cleanAnnotations } from '../public/src/document.js';
import { Reader } from '../public/src/reader.js';
installDOM();
const annotation={id:'a-1',type:'highlight',color:'#edcf67',width:3,opacity:.35,textAnchor:{start:0,end:5,quote:'Hello',prefix:'',suffix:' world'}};
test('import disables scripts, event handlers, active embeds and executable links',()=>{
  const parsed=parseHTML('<html><head><title>Safe</title><meta http-equiv="refresh" content="0;url=https://evil.test"></head><body><script>window.pwned=true</script><img src="data:image/png;base64,eA==" onerror="steal()"><a href="java\nscript:alert(1)">x</a><form action="https://evil.test"><input autofocus></form><object data="https://evil.test"></object></body></html>');
  const doc=documentFor(parsed.html);assert.equal(doc.querySelectorAll('script,object,embed,[onerror],[autofocus],meta[http-equiv="refresh"]').length,0);assert.equal(doc.querySelector('a').hasAttribute('href'),false);assert.equal(doc.querySelector('form').hasAttribute('action'),false);assert.equal(doc.querySelector('form').hasAttribute('inert'),true);assert.match(parsed.html,/script-src 'none'/);
});
test('embedded annotations, source and viewport round trip in one HTML file',()=>{
  const parsed=parseHTML('<html><head><title>Test</title></head><body><p>Hello world</p></body></html>',{source:'https://example.test/article',viewport:{width:960,height:800}});const doc=documentFor(parsed.html);parsed.metadata.annotations=[annotation];wrapOffsets(doc,0,5,{'data-htmlmemo-mark':'','data-htmlmemo-id':'a-1'},'background:#edcf6780');
  const html=serializeHTML(doc,parsed.metadata);assert.match(html,/data-htmlmemo-mark/);assert.match(html,/id="htmlmemo-data"/);const reopened=parseHTML(html);assert.deepEqual(reopened.metadata.annotations,[annotation]);assert.equal(reopened.metadata.source,'https://example.test/article');assert.equal(reopened.metadata.viewport.width,960);assert.equal(documentFor(reopened.html).body.textContent,'Hello world');assert.equal(documentFor(reopened.html).querySelector('[data-htmlmemo-mark]'),null);
});
test('JSON metadata cannot close its script element',()=>{
  const parsed=parseHTML('<html><head></head><body><p>body</p></body></html>');parsed.metadata.annotations=[{id:'n-1',type:'note',color:'#edcf67',width:3,opacity:1,points:[{x:1,y:1}],text:'</script><img src=x onerror=steal()>'}];const html=serializeHTML(documentFor(parsed.html),parsed.metadata);assert.ok(html.includes('\\u003c/script>'));const reopened=parseHTML(html);assert.equal(reopened.metadata.annotations[0].text,'</script><img src=x onerror=steal()>');assert.equal(documentFor(html).querySelectorAll('img').length,0);
});
test('damaged or newer annotations are rejected before opening or overwriting the file',()=>{
  for(const data of ['{bad','{"version":2,"annotations":[]}','{"version":1,"annotations":[{"type":"unknown"}]}'])assert.throws(()=>parseHTML(`<html><head><script id="htmlmemo-data" type="application/json">${data}</script></head><body>original</body></html>`));
});
test('metadata from an imported file cannot introduce an executable source URL',()=>{
  const parsed=parseHTML('<html><head><script id="htmlmemo-data" type="application/json">{"version":1,"annotations":[],"source":"javascript:alert(1)","bookmarks":{}}</script></head><body>text</body></html>');assert.equal(parsed.metadata.source,'');assert.deepEqual(parsed.metadata.bookmarks,[]);
});
test('text offsets remain stable across nested and overlapping highlights',()=>{
  const doc=documentFor('<html><head><style>ignored</style></head><body><p>Hello <b>world</b> again</p><svg><text>ignored</text></svg></body></html>');assert.equal(textIndex(doc).text,'Hello world again');wrapOffsets(doc,3,9,{'data-htmlmemo-mark':'','data-htmlmemo-id':'a'});wrapOffsets(doc,6,11,{'data-htmlmemo-mark':'','data-htmlmemo-id':'b'});assert.equal(textIndex(doc).text,'Hello world again');assert.equal(doc.querySelectorAll('[data-htmlmemo-id="a"]').length,2);cleanAnnotations(doc);assert.equal(doc.querySelectorAll('[data-htmlmemo-mark]').length,0);assert.equal(textIndex(doc).text,'Hello world again');
});
test('quote anchors recover shifted content and disambiguate repeated sentences',()=>{
  const index={text:'new prefix Hello world Hello elsewhere'};assert.deepEqual(resolveTextAnchor(index,{start:0,end:5,quote:'Hello',prefix:'prefix ',suffix:' world'}),{start:11,end:16});assert.equal(resolveTextAnchor(index,{start:0,end:7,quote:'missing'}),null);
});
test('SVG pen, shapes and notes remain visible in exported HTML without running JavaScript',()=>{
  const doc=documentFor('<html><head></head><body><p>Article</p></body></html>');const r=Object.create(Reader.prototype);r.doc=doc;r.naturalWidth=960;r.naturalHeight=800;r.metadata={annotations:[]};
  for(const type of ['pen','rect','ellipse','arrow','area','area-underline','note','text'])r.metadata.annotations.push({id:type,type,color:'#276254',width:3,opacity:1,points:[{x:20,y:30},{x:100,y:80}],text:'A note <script> does not run'});
  r.renderDrawingLayer();const html=serializeHTML(doc,{version:1,annotations:r.metadata.annotations});assert.match(html,/htmlmemo-annotation-layer/);assert.equal(doc.querySelectorAll('[data-htmlmemo-id]').length,8);assert.equal(doc.querySelector('g[data-htmlmemo-id="note"] text').textContent,'A note <script> does not run');assert.match(html,/&lt;script&gt;/);const reopened=parseHTML(html);assert.equal(reopened.metadata.annotations.length,8);assert.equal(documentFor(reopened.html).querySelector('#htmlmemo-annotation-layer'),null);
});
test('search and temporary ink are excluded from the standalone saved file',()=>{
  const doc=documentFor('<html><head><style id="htmlmemo-editor-style">editor</style></head><body><p><span data-htmlmemo-search>Article</span></p><svg id="htmlmemo-annotation-layer"><path data-htmlmemo-preview d="M0 0L1 1"/></svg></body></html>');const html=serializeHTML(doc,{version:1,annotations:[]});assert.ok(!html.includes('data-htmlmemo-search'));assert.ok(!html.includes('data-htmlmemo-preview'));assert.ok(!html.includes('htmlmemo-editor-style'));assert.equal(documentFor(html).querySelector('p').textContent,'Article');
});
test('capture embeds nested styles, image URLs, canvas and input state into one HTML',async()=>{
  await import('../public/shared/capture.js');const html=await readFile(new URL('./fixtures/capture.html',import.meta.url),'utf8');const doc=documentFor(html);doc.querySelector('#text-input').value='edited value';doc.querySelector('textarea').value='edited text';let fetched=0;
  const snapshot=await HTMLMemoCapture.captureDocument(doc,{fetchResource:async url=>{fetched++;const name=new URL(url).pathname.split('/').at(-1);const bytes=await readFile(new URL('./fixtures/'+name,import.meta.url));return {bytes,type:name.endsWith('.svg')?'image/svg+xml':'text/css'};}});
  const saved=documentFor(snapshot.html);assert.equal(saved.querySelectorAll('script,link[rel="stylesheet"]').length,0);assert.match(snapshot.html,/data:image\/svg\+xml;base64,/);assert.match(snapshot.html,/data:image\/png;base64,/);assert.equal(saved.querySelector('#text-input').getAttribute('value'),'edited value');assert.equal(saved.querySelector('textarea').textContent,'edited text');assert.equal(saved.querySelector('[type="password"]').getAttribute('value'),'');assert.equal(snapshot.warnings.length,0);assert.ok(fetched>=3);assert.ok(!snapshot.html.includes('@import'));
});
test('capture reports resource failures without silently keeping network dependencies',async()=>{
  await import('../public/shared/capture.js');const doc=documentFor('<html><head><title>Failure</title><style>p{background:url(missing.svg)}</style></head><body><img src="missing.svg"><p>original text</p></body></html>');const snapshot=await HTMLMemoCapture.captureDocument(doc,{fetchResource:async()=>{throw new Error('blocked');}});assert.equal(snapshot.warnings.length,2);assert.equal(documentFor(snapshot.html).querySelector('img').hasAttribute('src'),false);assert.ok(!snapshot.html.includes('url(missing.svg)'));assert.ok(snapshot.html.includes('original text'));
});

test('local JavaScript mode preserves scripts, handlers and executable links through annotation export and reopen',()=>{
  const source='<html><head><title>Script book</title></head><body><div id="book">불러오는 중…</div><button onclick="renderBook()">Open</button><a href="javascript:renderBook()">Read</a><script>function renderBook(){document.getElementById("book").textContent="Ready";}renderBook();</script></body></html>';
  const parsed=parseHTML(source,{}, {allowScripts:true,includeMetadata:true});const doc=documentFor(parsed.html);
  assert.equal(parsed.metadata.execution.allowScripts,true);assert.equal(parsed.nativeScroll,true);assert.ok(doc.querySelector('script:not(#htmlmemo-data)'));assert.equal(doc.querySelector('button').getAttribute('onclick'),'renderBook()');assert.equal(doc.querySelector('a').getAttribute('href'),'javascript:renderBook()');assert.match(parsed.html,/script-src 'unsafe-inline' 'unsafe-eval'/);assert.match(parsed.html,/worker-src data: blob:/);
  parsed.metadata.annotations=[annotation];const saved=serializeHTML(doc,parsed.metadata);const reopened=parseHTML(saved);
  assert.equal(reopened.metadata.execution.allowScripts,true);assert.deepEqual(reopened.metadata.annotations,[annotation]);assert.ok(reopened.html.includes('function renderBook()'));
});
test('opening a local document preserves its own TOC sidebar and removes older reader TOC artifacts',async()=>{
  const source='<html><head><style id="htmlmemo-toc-toggle-style">[data-htmlmemo-toc-collapsed]>:not([data-htmlmemo-ui]){display:none!important}</style><style>.reader-toc{position:sticky;top:0;height:100vh;width:18rem}.page{min-height:100dvh}</style></head><body><aside class="reader-toc" data-htmlmemo-toc-collapsed><button data-htmlmemo-toc-toggle>‹</button><h2>목차</h2><a href="#chapter">첫 장</a></aside><main class="page"><h1 id="chapter">본문</h1></main></body></html>';
  const parsed=await prepareLoadedHTML(documentFor(source));
  const opened=documentFor(parsed.html);
  assert.equal(parsed.nativeScroll,true);
  assert.match(parsed.html,/height:100vh/);
  assert.match(parsed.html,/min-height:100dvh/);
  assert.ok(opened.querySelector('.reader-toc'));
  assert.equal(opened.querySelector('.reader-toc').hasAttribute('data-htmlmemo-toc-collapsed'),false);
  assert.equal(opened.querySelector('[data-htmlmemo-toc-toggle]'),null);
  assert.equal(opened.querySelector('#htmlmemo-toc-toggle-style'),null);
  opened.querySelector('.reader-toc').setAttribute('data-htmlmemo-toc-collapsed','');
  const oldStyle=opened.createElement('style');oldStyle.id='htmlmemo-toc-toggle-style';opened.head.append(oldStyle);
  const saved=serializeHTML(opened,parsed.metadata);
  assert.ok(!saved.includes('htmlmemo-toc-toggle-style'));
  assert.ok(!saved.includes('data-htmlmemo-toc-collapsed'));
});
