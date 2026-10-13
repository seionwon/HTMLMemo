import test from 'node:test';
import assert from 'node:assert/strict';
import { readLocalHTML, droppedHTMLFiles } from '../public/src/local-files.js';
import { parseHTML, serializeHTML } from '../public/src/document.js';
import { documentFor, installDOM } from './dom.mjs';
import { writeExternalHTML } from '../public/src/storage.js';
installDOM();
const file=(html,name='local.html')=>new File([html],name,{type:'text/html',lastModified:1234});
test('plain local HTML opens without a source URL, a browser bridge or write permission',async()=>{
  const local=await readLocalHTML(file('<html><head><title>Local</title></head><body><p>Local text</p></body></html>'));assert.equal(local.handle,null);assert.equal(local.name,'local.html');const parsed=parseHTML(local.snapshot.html);assert.equal(parsed.metadata.source,'');assert.equal(documentFor(parsed.html).body.textContent,'Local text');
});
test('read-only and denied local files stay available for annotation',async()=>{
  const raw=file('<html><head></head><body>Read-only</body></html>');let requested=0;
  const handle={kind:'file',name:raw.name,getFile:async()=>raw,queryPermission:async()=> 'prompt',requestPermission:async()=>{requested++;return 'denied';}};
  const local=await readLocalHTML(handle,{requestWrite:true});assert.equal(local.handle,null);assert.equal(local.originalHandle,handle);assert.equal(requested,1);assert.match(local.snapshot.html,/Read-only/);assert.deepEqual(local.diskStamp,{modified:1234,size:raw.size});
  handle.requestPermission=async()=>{throw new Error('User activation expired');};assert.equal((await readLocalHTML(handle,{requestWrite:true})).handle,null);
});
test('granted local handles connect to the original file for automatic writes',async()=>{
  const raw=file('<html><head><title>Writable</title></head><body>content</body></html>');const handle={kind:'file',name:raw.name,getFile:async()=>raw,queryPermission:async()=> 'granted'};const local=await readLocalHTML(handle);assert.equal(local.handle,handle);assert.equal(local.originalHandle,handle);
});
test('an imported saved web page remains a local annotated document despite its original HTTPS URL',async()=>{
  const parsed=parseHTML('<html><head><title>Saved web</title></head><body><p>Saved text</p></body></html>',{source:'https://example.test/article'});
  parsed.metadata.annotations=[{id:'note',type:'note',color:'#edcf67',width:3,opacity:1,points:[{x:20,y:30}],text:'Existing note'}];
  const local=await readLocalHTML(file(serializeHTML(documentFor(parsed.html),parsed.metadata)));const reopened=parseHTML(local.snapshot.html);assert.equal(reopened.metadata.source,'https://example.test/article');assert.equal(reopened.metadata.annotations[0].text,'Existing note');assert.equal(local.name,'local.html');
});
test('UTF-16 local documents are decoded and normalized to UTF-8 on save',async()=>{
  const bytes=Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from('<html><head><meta charset="utf-16le"><title>한글 문서</title></head><body>한글 내용</body></html>','utf16le')]);const local=await readLocalHTML(new File([bytes],'korean.htm',{type:'text/html'}));const parsed=parseHTML(local.snapshot.html);assert.equal(parsed.metadata.title,'한글 문서');assert.match(parsed.html,/charset="utf-8"/);assert.ok(!parsed.html.includes('charset="utf-16le"'));assert.equal(documentFor(parsed.html).body.textContent,'한글 내용');
});
test('drop acquires every original file handle before awaiting and falls back to ordinary files',async()=>{
  let release;const gate=new Promise(resolve=>release=resolve);let calls=0;const a={kind:'file',name:'a.html'};const b=file('b','b.htm');
  const pending=droppedHTMLFiles({items:[{kind:'file',getAsFileSystemHandle(){calls++;return gate;},getAsFile:()=>null},{kind:'file',getAsFileSystemHandle(){calls++;return Promise.reject(new Error('unsupported'));},getAsFile:()=>b}],files:[]});assert.equal(calls,2);release(a);assert.deepEqual(await pending,[a,b]);assert.equal((await droppedHTMLFiles({files:[b,file('x','x.txt')]})).length,1);
});
test('external automatic write includes annotation data and updates the conflict checkpoint',async()=>{
  let content='original';let modified=1234;const handle={queryPermission:async()=> 'granted',getFile:async()=>({lastModified:modified,size:Buffer.byteLength(content)}),createWritable:async()=>{let next;return {write:async value=>next=value,close:async()=>{content=next;modified++;},abort:async()=>{}};}};
  const record={fileHandle:handle,diskStamp:{modified:1234,size:8}};const parsed=parseHTML('<html><head></head><body>content</body></html>');parsed.metadata.annotations=[{id:'local-note',type:'note',color:'#edcf67',width:3,opacity:1,points:[{x:1,y:1}],text:'My local note'}];await writeExternalHTML(record,serializeHTML(documentFor(parsed.html),parsed.metadata));assert.equal(parseHTML(content).metadata.annotations[0].text,'My local note');assert.equal(record.diskStamp.modified,1235);
});
test('external edits and revoked permissions prevent overwriting the original local file',async()=>{
  let writes=0;const handle={queryPermission:async()=> 'granted',getFile:async()=>({lastModified:999,size:10}),createWritable:async()=>{writes++;}};await assert.rejects(writeExternalHTML({fileHandle:handle,diskStamp:{modified:123,size:10}},'changed'),/다른 프로그램/);handle.queryPermission=async()=> 'denied';await assert.rejects(writeExternalHTML({fileHandle:handle},'changed'),/쓰기 권한/);assert.equal(writes,0);
});
test('failed external writes abort without advancing the saved checkpoint',async()=>{
  let aborted=false;const handle={queryPermission:async()=> 'granted',getFile:async()=>({lastModified:123,size:10}),createWritable:async()=>({write:async()=>{throw new Error('disk full');},abort:async()=>aborted=true})};const record={fileHandle:handle,diskStamp:{modified:123,size:10}};await assert.rejects(writeExternalHTML(record,'changed'),/disk full/);assert.equal(aborted,true);assert.equal(record.diskStamp.modified,123);
});

test('large UTF-8 import streams original bytes after a CSP header without reading the entire file',async()=>{
  const raw=file('<html><head><title>Large</title></head><body>'+ 'x'.repeat(4*1024*1024)+'</body></html>');
  raw.arrayBuffer=async()=>{throw Error('Full file read must not run');};raw.text=async()=>{throw Error('Full text read must not run');};
  const local=await readLocalHTML(raw,{native:true});assert.equal(local.snapshot.html,null);assert.ok(local.snapshot.file instanceof Blob);
  const beginning=await local.snapshot.file.slice(0,1024).text();assert.match(beginning,/Content-Security-Policy/);assert.ok(beginning.indexOf("script-src 'none'")<beginning.indexOf('<title>Large'));
  assert.equal(local.snapshot.file.size>raw.size,true);assert.equal(local.handle,null);
});
test('native option leaves small and UTF-16 files on the encoding-safe import path',async()=>{
  assert.equal((await readLocalHTML(file('<body>small</body>'),{native:true})).snapshot.file,null);
  const raw=new File([Buffer.from([255,254]),Buffer.from('<html><head></head><body>'+ '한'.repeat(2200000)+'</body></html>','utf16le')],'large.htm',{type:'text/html'});
  const local=await readLocalHTML(raw,{native:true});assert.equal(local.snapshot.file,null);assert.match(local.snapshot.html,/한/);
});
test('preparing a browser-loaded document reuses its DOM and restores embedded annotations securely',()=>{
  const original=parseHTML('<html><head><title>Book</title></head><body><p>Text</p></body></html>',{}, {includeMetadata:true});
  original.metadata.annotations=[{id:'saved',type:'note',color:'#edcf67',width:3,opacity:1,points:[{x:1,y:1}],text:'Saved note'}];
  const doc=documentFor(serializeHTML(documentFor(original.html),original.metadata));
  const script=doc.createElement('script');script.textContent='window.bad=true';doc.body.append(script);doc.body.firstElementChild.setAttribute('onclick','bad()');
  const result=parseHTML(null,{title:'file.html'},{document:doc,includeMetadata:true});
  assert.equal(result.nativeScroll,true);assert.equal(result.metadata.title,'Book');assert.equal(result.metadata.annotations[0].text,'Saved note');
  assert.ok(!result.html.includes('window.bad'));assert.ok(!doc.body.firstElementChild.hasAttribute('onclick'));assert.match(result.html,/script-src 'none'/);
});

test('large local JavaScript option streams bytes with scripts, workers and data URL fetch enabled',async()=>{
  const raw=file('<html><head></head><body><script>document.body.append("ready")</script>'+ 'x'.repeat(4*1024*1024)+'</body></html>');raw.arrayBuffer=async()=>{throw Error('Full read');};
  const local=await readLocalHTML(raw,{native:true,allowScripts:true});const header=await local.snapshot.file.slice(0,1024).text();
  assert.equal(local.snapshot.allowScripts,true);assert.match(header,/script-src 'unsafe-inline' 'unsafe-eval'/);assert.match(header,/connect-src data: blob:/);assert.match(header,/document.body.append/);
});
