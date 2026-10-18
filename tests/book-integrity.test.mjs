import test from 'node:test';
import assert from 'node:assert/strict';
import { documentFor, installDOM } from './dom.mjs';
import { inspectBookDocument, parseHTML, serializeHTML, serializeBookSource, BOOK_DATA_MISSING } from '../public/src/document.js';
installDOM();
const note = {id:'saved-note',type:'note',color:'#edcf67',width:3,opacity:1,points:[{x:20,y:30}],text:'Kept annotation </script>'};
const body = '<nav id="reader-tree"><details><summary>입문 <small>16</small></summary></details></nav><main id="reader-content">First visible section</main>';
const manifest = {format:'memosuite-book-html-v1',volumes:[{sections:[{key:'v0:first'}]}]};
const payload = '<script id="book-manifest" type="application/json">'+JSON.stringify(manifest)+'</script><script id="book-volume-0" type="application/octet-stream">encoded-whole-volume</script><script nonce="original-nonce">window.readerReady=true;</script>';
const book = '<html><head><title>Book</title></head><body>'+body+payload+'</body></html>';

test('a saved first-page DOM with empty TOC headers is identified as an incomplete book, even with scripts allowed', () => {
  const html='<html><head></head><body>'+body+'</body></html>';
  const parsed=parseHTML(html,{}, {allowScripts:true});
  const doc=documentFor(parsed.html);
  assert.equal(inspectBookDocument(doc).complete,false);
  assert.equal(doc.querySelector('#reader-content').textContent,'First visible section');
  assert.ok(parsed.metadata.warnings.includes(BOOK_DATA_MISSING));
  assert.throws(()=>serializeHTML(doc,parsed.metadata),/본문 데이터/);
  assert.equal(inspectBookDocument(documentFor('<html><head></head><body>Ordinary page</body></html>')),null);
  assert.equal(inspectBookDocument(documentFor('<html><head><script id="book-manifest" type="application/json">{"format":"unrelated"}</script></head><body>Ordinary page</body></html>')),null);
  assert.equal(inspectBookDocument(documentFor(book.replace(JSON.stringify(manifest),'{"format":"memosuite-book-html-v1","volumes":[null]}'))).complete,false);
});

test('static sanitization and page capture cannot silently discard a standalone book runtime and unopened volumes', async () => {
  assert.throws(()=>parseHTML(book),/화면 캡처/);
  const parsed=parseHTML(book,{}, {allowScripts:true});
  assert.equal(inspectBookDocument(documentFor(parsed.html)).complete,true);
  await import('../public/shared/capture.js');
  const doc=documentFor(book),before=doc.documentElement.outerHTML;
  await assert.rejects(HTMLMemoCapture.captureDocument(doc),/원본 파일/);
  assert.equal(doc.documentElement.outerHTML,before);
  for (const missing of ['#book-manifest','#book-volume-0','script[nonce]']) {
    const damaged=documentFor(book);damaged.querySelector(missing).remove();
    assert.equal(inspectBookDocument(damaged).complete,false);
  }
});

test('book export retains unopened bodies, released image payloads and original nonce bytes while replacing annotation metadata', async () => {
  const old='<script id="htmlmemo-data" type="application/json">{"version":1,"annotations":[]}</script>';
  // Cross several read boundaries with Korean UTF-8 and preserve a BOM too.
  const head='\ufeff<html><head><meta charset="utf-8"><style>/*'+'한'.repeat(50000)+'*/</style>'+old;
  const tail='</head><body>'+body+payload+'<script id="book-asset-0" type="application/octet-stream">'+'a'.repeat(2*1024*1024)+'</script></body></html>';
  const source=new Blob([head,tail]);let read=0;
  source.arrayBuffer=source.text=()=>{throw Error('Do not read the whole book');};
  const slice=source.slice.bind(source);
  source.slice=(...args)=>{const part=slice(...args),arrayBuffer=part.arrayBuffer.bind(part);part.arrayBuffer=()=>{read+=part.size;return arrayBuffer();};return part;};
  const exported=await serializeBookSource(source,{version:1,annotations:[note],bookmarks:[]});
  const bytes=new Uint8Array(await exported.arrayBuffer()),text=await exported.text();
  assert.deepEqual([...bytes.slice(0,3)],[239,187,191]);
  assert.ok(read<head.length*3+65536);
  assert.equal(text.slice(text.indexOf('</head>')),tail);
  assert.ok(text.includes('nonce="original-nonce"'));
  const doc=documentFor(text);
  assert.equal(doc.querySelectorAll('#htmlmemo-data').length,1);
  assert.deepEqual(JSON.parse(doc.getElementById('htmlmemo-data').textContent).annotations,[note]);
  assert.equal(inspectBookDocument(doc).complete,true);
  const again=await serializeBookSource(exported,{version:1,annotations:[],bookmarks:[]});
  assert.equal(documentFor(await again.text()).querySelectorAll('#htmlmemo-data').length,1);
});
