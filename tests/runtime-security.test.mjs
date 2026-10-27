import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {documentFor,installDOM} from './dom.mjs';
import {savedMainFrame,parseHTML,sanitizeRuntimeHTML,LOCAL_CSP,SCRIPT_CSP} from '../public/src/document.js';
import {IsolatedRuntime,needsIsolatedRuntime,privateRuntimeSource} from '../public/src/isolated-runtime.js';
import {cleanSourceStorage} from '../public/src/model.js';
import {Reader} from '../public/src/reader.js';
installDOM();
const frame=content=>`<iframe id="mainFrame" srcdoc="${content.replaceAll('&','&amp;').replaceAll('"','&quot;')}"></iframe>`;
const page=body=>'<html><head></head><body>'+body+'</body></html>';
test('only an otherwise empty saved frame shell is adopted, never a normal page with embedded media',()=>{
  const child=page('<p>Saved article</p>');
  assert.equal(savedMainFrame(documentFor(page(frame(child)))).id,'mainFrame');
  assert.ok(savedMainFrame(documentFor(page('<div>'+frame(child)+'</div><iframe hidden srcdoc=""></iframe>'))));
  for(const other of ['<p>Outer article</p>','<img src="data:,">','<svg></svg>',frame(child),'<input>'])assert.equal(savedMainFrame(documentFor(page(frame(child)+other))),null);
  assert.equal(savedMainFrame(documentFor(page('<iframe src="https://remote.invalid"></iframe>'))),null);
});
test('a main saved frame gets readable DOM but never script permission, including executable HTML imports',()=>{
  const html=page(frame(page('<p onclick="parent.attack()">Article</p><script>parent.attack()</script><iframe src="https://remote.invalid"></iframe>')));
  for(const allowScripts of [false,true]){
    const prepared=parseHTML(html,{}, {allowScripts}),outer=documentFor(prepared.html),saved=outer.querySelector('iframe'),child=documentFor(saved.getAttribute('srcdoc'));
    assert.equal(saved.getAttribute('sandbox'),'allow-same-origin');assert.equal(child.querySelector('script,[onclick],iframe'),null);
  }
});
test('ordinary embedded frames retain their own isolation rather than receiving access to the app',()=>{
  const prepared=parseHTML(page('<p>Outer article</p>'+frame(page('<p>Embedded</p>'))));
  assert.equal(documentFor(prepared.html).querySelector('iframe').getAttribute('sandbox'),'');
});
test('ordinary static HTML avoids an execution frame while scripts, handlers and executable links require isolation',()=>{
  assert.equal(needsIsolatedRuntime(documentFor(page('<p>Static</p><script type="application/json">{"value":1}</script>'))),false);
  for(const body of ['<script>run()</script>','<script src="data:text/javascript,run()"></script>','<script type="module">run()</script>','<button onclick="run()">Go</button>','<a href="java\nscript:run()">Go</a>'])assert.equal(needsIsolatedRuntime(documentFor(page(body))),true);
});
test('private notes outside the head and drawn exports never enter the source execution document',async()=>{
  const html=page('<script id="htmlmemo-data" type="application/json">{"annotations":["private body note"]}</script><p><span data-htmlmemo-mark>Visible article</span></p><svg id="htmlmemo-annotation-layer"><text>private drawn note</text></svg><script>window.sourceStillRuns=true</script>').replace('<head>','<head><meta http-equiv="Content-Security-Policy" content="script-src \'none\'">'),source=new Blob([html]),clean=privateRuntimeSource(documentFor(html),source),text=await clean.text();
  assert.doesNotMatch(text,/private body note|private drawn note|data-htmlmemo-mark|Content-Security-Policy/);assert.match(text,/Visible article/);assert.match(text,/sourceStillRuns/);assert.equal(await source.text(),html);
  const ordinary=documentFor('<html><head><script id="htmlmemo-data" type="application/json">private head metadata</script></head><body><p>Ordinary original</p></body></html>');assert.strictEqual(privateRuntimeSource(ordinary,source),source,'ordinary sources stay immutable Blobs for streaming; head metadata is replaced separately');
});
test('hostile runtime HTML is inert, strips navigations and cannot supply app annotation metadata',()=>{
  const safe=sanitizeRuntimeHTML(page('<p onclick="attack()">Text</p><script>attack()</script><script id="htmlmemo-data" type="application/json">{"annotations":["fake"]}</script><meta http-equiv="refresh" content="0;url=https://remote.invalid"><iframe src="https://remote.invalid"></iframe><form action="https://remote.invalid"><input></form><a href="javascript:attack()">Link</a>'));
  assert.equal(safe.querySelector('script,meta[http-equiv],iframe,[onclick],form[action],a[href]'),null);assert.ok(!safe.querySelector('form').hasAttribute('inert'));assert.equal(safe.querySelector('p').textContent,'Text');
});
function runtime(){
  const doc=documentFor('<html><head><script id="htmlmemo-data" type="application/json">{"annotations":["original private notes"]}</script></head><body><script id="book-volume-0" type="application/octet-stream">original compressed bytes</script></body></html>'),r=new IsolatedRuntime({host:{ownerDocument:doc},doc,source:new Blob(['source'])});let ready=0;r.resolve=()=>ready++;return {doc,r,get ready(){return ready;}};
}
const initial='<html data-htmlmemo-runtime-id="r1"><head data-htmlmemo-runtime-id="r2"></head><body data-htmlmemo-runtime-id="r3"><article data-htmlmemo-runtime-id="r4" data-section="first"><p data-htmlmemo-runtime-id="r5">Current text</p></article></body></html>';
test('first isolated snapshot preserves original private notes and opaque payloads only in the app reader',async()=>{
  const a=runtime(),payload=a.doc.getElementById('book-volume-0');await a.r.accept({type:'initial',html:initial});assert.equal(a.ready,1);
  assert.strictEqual(a.doc.getElementById('book-volume-0'),payload);assert.match(a.doc.getElementById('htmlmemo-data').textContent,/original private notes/);assert.equal(a.doc.querySelector('p').textContent,'Current text');assert.ok(a.doc.documentElement.hasAttribute('data-htmlmemo-isolated-runtime'));
});
test('content patches keep document containers, sanitize source and retain app-owned overlays',async()=>{
  const a=runtime();await a.r.accept({type:'initial',html:initial});const article=a.doc.querySelector('article'),overlay=a.doc.createElement('aside');overlay.dataset.htmlmemoUi='';article.append(overlay);
  await a.r.accept({type:'patches',patches:[{id:'r4',kind:'content',html:'<article data-htmlmemo-runtime-id="r4" data-section="second"><p data-htmlmemo-runtime-id="r6" onclick="parent.attack()">Next text</p><script>parent.attack()</script></article>'}]});
  assert.strictEqual(a.doc.querySelector('article'),article);assert.equal(article.dataset.section,'second');assert.equal(article.querySelector('p').textContent,'Next text');assert.strictEqual(article.querySelector('aside'),overlay);assert.equal(article.querySelector('script,[onclick]'),null);assert.strictEqual(a.r.nodes.get('r6'),article.querySelector('p'));assert.ok(!a.r.nodes.has('r5'));
});
test('root and content attributes update loading/section state without modifying app-owned runtime state',async()=>{
  const a=runtime();await a.r.accept({type:'initial',html:initial});
  await a.r.accept({type:'patches',patches:[{id:'r1',kind:'attributes',tag:'html',attributes:[['data-htmlmemo-runtime-id','r1'],['data-reader-ready','true'],['onclick','attack()']]},{id:'r4',kind:'attributes',tag:'article',attributes:[['data-htmlmemo-runtime-id','r4'],['data-section','second']]}]});
  assert.equal(a.doc.documentElement.dataset.readerReady,'true');assert.equal(a.doc.documentElement.hasAttribute('onclick'),false);assert.ok(a.doc.documentElement.hasAttribute('data-htmlmemo-isolated-runtime'));assert.equal(a.doc.querySelector('article').dataset.section,'second');
  await a.r.accept({type:'patches',patches:[{id:'r4',kind:'attributes',tag:'article',attributes:[['data-section','third']]}]});assert.equal(a.doc.querySelector('article').getAttribute('data-htmlmemo-runtime-id'),'r4');assert.equal(a.doc.querySelector('article').dataset.section,'third');
});
test('late source disclosure updates cannot close groups expanded by the app for search results',async()=>{
  const a=runtime();await a.r.accept({type:'initial',html:initial.replace('</article>','<details open data-htmlmemo-runtime-id="r6"><summary>Matches</summary></details></article>')});const group=a.doc.querySelector('details');group.setAttribute('data-htmlmemo-book-search-open','false');
  await a.r.accept({type:'patches',patches:[{id:'r6',kind:'attributes',tag:'details',attributes:[]}]});assert.equal(group.hasAttribute('open'),true);assert.equal(group.getAttribute('data-htmlmemo-runtime-id'),'r6');
});
test('consumed book image payloads can be released without deleting volumes, notes or arbitrary nodes',async()=>{
  const a=runtime(),asset=a.doc.createElement('script');asset.id='book-asset-0';asset.type='application/octet-stream';asset.textContent='original image bytes';a.doc.body.append(asset);await a.r.accept({type:'initial',html:initial,assets:['book-asset-0']});assert.ok(a.doc.getElementById('book-asset-0'));
  await a.r.accept({type:'released-assets',ids:['book-asset-0','book-volume-0','htmlmemo-data','r4']});assert.equal(a.doc.getElementById('book-asset-0'),null);assert.ok(a.doc.getElementById('book-volume-0'));assert.match(a.doc.getElementById('htmlmemo-data').textContent,/original private notes/);assert.ok(a.doc.querySelector('article'));
});
test('unsupported RPC operations, malformed selectors and oversized patch lists cannot modify the reader',async()=>{
  const a=runtime();await a.r.accept({type:'initial',html:initial});const before=a.doc.documentElement.outerHTML;
  await a.r.accept({type:'eval',code:'parent.attack()'});await a.r.accept({type:'file-write',path:'../outside',value:'attack'});
  await a.r.accept({type:'patches',patches:[{id:'r4"] body',kind:'content',html:'<body>attack</body>'},{id:'r9999',kind:'content',html:'<article>attack</article>'}]});
  await a.r.accept({type:'patches',patches:Array.from({length:10001},()=>({id:'r4',kind:'content',html:'<article>attack</article>'}))});assert.equal(a.doc.documentElement.outerHTML,before);
});
test('source navigation accepts only bounded local fragments after readiness and never forwards app UI clicks',async()=>{
  const a=runtime(),navigations=[];a.r.onNavigate=hash=>navigations.push(hash);
  await a.r.accept({type:'navigation',hash:'#early'});assert.deepEqual(navigations,[]);
  await a.r.accept({type:'initial',html:initial});const before=a.doc.documentElement.outerHTML;
  for(const hash of ['https://outside.invalid/','javascript:attack()','#bad\nvalue','#'+'x'.repeat(2000),{},null])await a.r.accept({type:'navigation',hash});
  assert.deepEqual(navigations,[]);assert.equal(a.doc.documentElement.outerHTML,before);
  await a.r.accept({type:'navigation',hash:'#%EC%A0%88'});assert.deepEqual(navigations,['#%EC%A0%88']);
  const host=a.doc.createElement('section'),link=a.doc.createElement('a'),sent=[];host.dataset.htmlmemoUi='';link.href='#chapter';link.setAttribute('data-htmlmemo-runtime-id','r10');host.append(link);host.addEventListener('click',event=>event.preventDefault(),true);a.doc.body.append(host);a.r.index(host);a.r.send=value=>sent.push(value);a.r.bind();link.dispatchEvent(new a.doc.defaultView.Event('click',{bubbles:true,cancelable:true}));assert.deepEqual(sent,[],'app search retains its precise keyword/annotation target');
  const sourceLink=a.doc.createElement('a');sourceLink.setAttribute('data-htmlmemo-runtime-id','r11');sourceLink.textContent='sanitized source action';a.doc.body.append(sourceLink);a.r.index(sourceLink);sourceLink.dispatchEvent(new a.doc.defaultView.Event('click',{bubbles:true,cancelable:true}));assert.deepEqual(sent,[{type:'click',id:'r11'}],'source anchors remain usable after executable hrefs have been sanitized');
  sourceLink.setAttribute('href','https://outside.invalid/');sourceLink.dispatchEvent(new a.doc.defaultView.Event('click',{bubbles:true,cancelable:true}));assert.equal(sent.length,1,'external links keep the browser handoff path');
  const movedHost=a.doc.createElement('div'),clear=a.doc.createElement('button');movedHost.dataset.htmlmemoUi='';clear.setAttribute('data-htmlmemo-runtime-id','r12');movedHost.append(clear);a.doc.body.append(movedHost);a.r.index(movedHost);clear.dispatchEvent(new a.doc.defaultView.Event('click',{bubbles:true,cancelable:true}));assert.deepEqual(sent.at(-1),{type:'click',id:'r12'},'source controls moved into the app search panel keep their original action');
  a.r.disposed=true;await a.r.accept({type:'navigation',hash:'#late'});assert.deepEqual(navigations,['#%EC%A0%88']);
});
test('source nodes cannot replace metadata or append executable content via attribute patches',async()=>{
  const a=runtime();await a.r.accept({type:'initial',html:initial});
  await a.r.accept({type:'patches',patches:[{id:'r5',kind:'attributes',tag:'script',attributes:[['src','https://remote.invalid/run.js'],['data-htmlmemo-runtime-id','r5']]},{id:'r5',kind:'content',html:'<script data-htmlmemo-runtime-id="r5">attack()</script>'}]});
  assert.equal(a.doc.querySelector('p').textContent,'Current text');assert.equal(a.doc.querySelector('script[src]'),null);assert.match(a.doc.getElementById('htmlmemo-data').textContent,/original private notes/);
});
test('document preferences remain bounded inert pairs and round-trip separately from app settings',async()=>{
  const values=[['font-size','36'],['__proto__','inert string'],['font-size','duplicate'],['not-string',{}],['oversized','x'.repeat(262145)]];
  const expected=[['font-size','36'],['__proto__','inert string']];assert.deepEqual(cleanSourceStorage(values),expected);assert.equal(cleanSourceStorage(Array.from({length:300},(_,i)=>['k'+i,'v'])).length,256);assert.deepEqual(cleanSourceStorage({secret:'app value'}),[]);
  const parsed=parseHTML('<html><head><script id="htmlmemo-data" type="application/json">'+JSON.stringify({version:1,annotations:[],view:{sourceStorage:values}})+'</script></head><body><p>Text</p></body></html>');assert.deepEqual(parsed.metadata.view.sourceStorage,expected);
  const a=runtime();let saved;a.r.onStorage=value=>saved=value;await a.r.accept({type:'storage',entries:values});assert.deepEqual(saved,expected);assert.match(a.doc.getElementById('htmlmemo-data').textContent,/original private notes/);
  const r=Object.create(Reader.prototype);Object.assign(r,{metadata:parsed.metadata,host:{hidden:false},viewport:{scrollTop:30,scrollLeft:0},zoom:1,autoFit:true,callbacks:{}});assert.equal(r.rememberPosition(),true);assert.deepEqual(r.metadata.view.sourceStorage,expected);assert.equal(r.rememberPosition(),false);
});
test('source form values are plain data, cannot target app metadata and stale responses cannot overwrite newer typing',async()=>{
  const a=runtime();await a.r.accept({type:'initial',html:initial.replace('</article>','<input id="query" data-htmlmemo-runtime-id="r6" value="draft"><input type="file" data-htmlmemo-runtime-id="r7"></article>')});const input=a.doc.getElementById('query');input.value='new typing';a.r.controlRevisions.set('r6',2);
  await a.r.accept({type:'patches',patches:[{id:'r6',kind:'control',value:'stale',revision:1}]});assert.equal(input.value,'new typing');
  await a.r.accept({type:'patches',patches:[{id:'r6',kind:'control',value:'',revision:2},{id:'r7',kind:'control',value:'/private/file',revision:2},{id:'r4',kind:'control',value:'<script>attack()</script>',revision:2}]});assert.equal(input.value,'');assert.equal(a.doc.querySelector('article').textContent,'Current text');assert.equal(a.doc.querySelector('[type=file]').getAttribute('value'),null);assert.match(a.doc.getElementById('htmlmemo-data').textContent,/original private notes/);
});
test('an explicit export restores original code only in a detached annotated clone',async()=>{
  const a=runtime(),script=a.doc.createElement('script');script.textContent='window.originalSource=true';a.r.originalScripts=[{node:script,parent:{tag:'body',path:[1]}}];a.r.originalHandlers=[{target:{tag:'p',id:'export-target',path:[]},attributes:[['onclick','sourceAction()']]}];await a.r.accept({type:'initial',html:initial.replace('<p data-','<p id="export-target" data-')});
  const exported=a.r.exportDocument();assert.match(exported.querySelector('script:not([type])').textContent,/originalSource/);assert.equal(exported.getElementById('export-target').getAttribute('onclick'),'sourceAction()');assert.equal(exported.querySelector('[data-htmlmemo-runtime-id]'),null);assert.equal(a.doc.querySelector('[onclick],script:not(#htmlmemo-data):not([type="application/octet-stream"])'),null);assert.match(exported.getElementById('htmlmemo-data').textContent,/original private notes/);
});
test('the source CSP cannot fetch or load external scripts and the display policy prohibits execution',()=>{
  assert.match(LOCAL_CSP,/script-src 'none'/);assert.match(SCRIPT_CSP,/connect-src data: blob:/);const scripts=SCRIPT_CSP.match(/script-src ([^;]+)/)[1];assert.ok(!/https?:/.test(scripts));
});
test('reader and migration never give an imported document scripts together with the app origin',async()=>{
  for(const path of ['reader.js','migrate.js']){const source=await readFile(new URL('../public/src/'+path,import.meta.url),'utf8');assert.doesNotMatch(source,/setAttribute\('sandbox',\s*'[^']*allow-scripts[^']*allow-same-origin|setAttribute\('sandbox',\s*'[^']*allow-same-origin[^']*allow-scripts/);assert.match(source,/new IsolatedRuntime/);}
  const source=await readFile(new URL('../public/src/isolated-runtime.js',import.meta.url),'utf8');assert.match(source,/setAttribute\('sandbox','allow-scripts'\)/);assert.match(source,/event\.source!==frame\.contentWindow/);assert.match(source,/value\?\.channel!==this\.channel/);
});
