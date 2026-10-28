import test from 'node:test';
import assert from 'node:assert/strict';
import { readLocalHTML, droppedHTMLFiles, localFileIdentity, localFileWithType, identifyLocalFile, sameLocalFile, findLocalDuplicates } from '../public/src/local-files.js';
import { parseHTML, serializeHTML, prepareLoadedHTML } from '../public/src/document.js';
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
  const local=await readLocalHTML(handle,{requestWrite:true});assert.equal(local.handle,null);assert.equal(local.originalHandle,handle);assert.equal(requested,0);assert.match(local.snapshot.html,/Read-only/);assert.deepEqual(local.diskStamp,{modified:1234,size:raw.size});
  handle.requestPermission=async()=>{throw new Error('User activation expired');};assert.equal((await readLocalHTML(handle,{requestWrite:true})).handle,null);
});
test('even granted source handles are read-only to the annotation autosave path',async()=>{
  const raw=file('<html><head><title>Writable</title></head><body>content</body></html>');const handle={kind:'file',name:raw.name,getFile:async()=>raw,queryPermission:async()=> 'granted'};const local=await readLocalHTML(handle);assert.equal(local.handle,null);assert.equal(local.originalHandle,handle);
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
test('file identity uses contents rather than filename, timestamps or size alone',async()=>{
  const a=file('<body>first</body>'),copy=file('<body>first</body>','renamed.htm'),different=file('<body>other</body>');
  const identity=await localFileIdentity(a);
  assert.equal(sameLocalFile(identity,await localFileIdentity(copy)),true);
  assert.equal(a.size,different.size);assert.equal(sameLocalFile(identity,await localFileIdentity(different)),false);
  assert.equal(sameLocalFile(identity,{...identity,version:2}),false);assert.equal(sameLocalFile({version:1,size:1},{version:1,size:1}),false);
});
test('identity hashes ordered bounded chunks without calling a large file full-read method',async()=>{
  const raw=file('a'.repeat(1024*1024)+'b'.repeat(1024*1024)+'c'),originalSlice=raw.slice.bind(raw);let largest=0;
  raw.arrayBuffer=raw.text=async()=>{throw Error('Full file read');};raw.slice=(start,end)=>{largest=Math.max(largest,end-start);return originalSlice(start,end);};
  const identity=await localFileIdentity(raw);assert.equal(largest,1024*1024);
  assert.equal(sameLocalFile(identity,await localFileIdentity(file('b'.repeat(1024*1024)+'a'.repeat(1024*1024)+'c'))),false);
});
test('parallel identities remain byte-for-byte compatible with serial v1 hashes, including out-of-order reads',async()=>{
  for(const contents of ['', 'small', 'a'.repeat(1024*1024)+'b'.repeat(1024*1024)+'c'.repeat(1024*1024)+'d'.repeat(1024*1024)+'end']){
    const raw=file(contents),slice=raw.slice.bind(raw);let active=0,peak=0;
    raw.slice=(start,end)=>({arrayBuffer:async()=>{peak=Math.max(peak,++active);await new Promise(resolve=>setTimeout(resolve,start===0?8:1));const bytes=await slice(start,end).arrayBuffer();active--;return bytes;}});
    const hashes=[];for(let start=0;start<raw.size;start+=1024*1024)hashes.push(new Uint8Array(await crypto.subtle.digest('SHA-256',await slice(start,start+1024*1024).arrayBuffer())));
    const prefix=new TextEncoder().encode('HTMLMemo local file v1:'+raw.size+':'),joined=new Uint8Array(prefix.length+hashes.length*32);joined.set(prefix);hashes.forEach((hash,index)=>joined.set(hash,prefix.length+index*32));
    const expected=Buffer.from(await crypto.subtle.digest('SHA-256',joined)).toString('hex');
    assert.equal((await localFileIdentity(raw)).digest,expected);assert.ok(peak<=4);if(raw.size>4*1024*1024)assert.equal(peak,4);
  }
});
test('identity reuses in-flight and completed reads only for the same immutable Blob and retries failures',async()=>{
  const raw=file('abc'),slice=raw.slice.bind(raw);let reads=0,fail=true;
  raw.slice=(start,end)=>({arrayBuffer:async()=>{reads++;if(fail)throw Error('temporary read failure');return slice(start,end).arrayBuffer();}});
  await assert.rejects(localFileIdentity(raw),/temporary/);fail=false;
  const first=localFileIdentity(raw),second=localFileIdentity(raw);assert.strictEqual(first,second);
  assert.equal(sameLocalFile(await first,await localFileIdentity(raw)),true);assert.equal(reads,2);
  assert.equal(sameLocalFile(await first,await localFileIdentity(file('xyz'))),false);
});
test('size preflight defers a new large source scan and never loads known document bodies',async()=>{
  const raw=file('<html><head></head><body><!--'+'x'.repeat(4*1024*1024)+'--></body></html>'),slice=raw.slice.bind(raw);let bytes=0;
  raw.arrayBuffer=raw.text=async()=>{throw Error('Whole source read');};raw.slice=(start,end)=>{const part=slice(start,end),read=part.arrayBuffer.bind(part);part.arrayBuffer=()=>{bytes+=part.size;return read();};return part;};
  const local=await readLocalHTML(raw,{native:true,identify:false});assert.equal(bytes,65536);assert.equal(local.sourceIdentity,null);
  const records=[{id:'larger',sourceIdentity:{version:1,size:raw.size+1,digest:'a'.repeat(64)}}];
  assert.deepEqual(await findLocalDuplicates(local,records,()=>{throw Error('No body reads');}),[]);assert.equal(bytes,65536);
  const identity=await identifyLocalFile(local);assert.equal(bytes,65536+raw.size);assert.equal(identity.size,raw.size);
  await identifyLocalFile(local);assert.equal(bytes,65536+raw.size);
  assert.equal((await findLocalDuplicates(local,[{id:'renamed',sourceIdentity:identity}],()=>{throw Error('No bodies');}))[0].id,'renamed');
});
test('known same-size sources still scan all bytes and reject a changed middle with unchanged filename and timestamps',async()=>{
  const body='x'.repeat(4*1024*1024),a=file('<body>'+body+'</body>'),b=file('<body>'+body.slice(0,2*1024*1024)+'y'+body.slice(2*1024*1024+1)+'</body>');
  const local=await readLocalHTML(b,{native:true,identify:false}),identity=await localFileIdentity(a);
  assert.equal(a.size,b.size);assert.deepEqual(await findLocalDuplicates(local,[{id:'old',name:b.name,sourceIdentity:identity}],()=>{throw Error('No body read');}),[]);
  assert.ok(local.sourceIdentity);assert.notEqual(local.sourceIdentity.digest,identity.digest);
});
test('legacy streamed size and prefix mismatches skip full scans, but matching prefixes still require exact identities',async()=>{
  const make=body=>file('<html><head><title>Legacy</title></head><body><!--'+body+'--></body></html>');
  const local=await readLocalHTML(make('x'.repeat(4*1024*1024)),{native:true,identify:false});
  let loads=0;assert.deepEqual(await findLocalDuplicates(local,[{id:'wrong-size',name:local.name,byteSize:local.snapshot.file.size+1}],()=>{loads++;}),[]);assert.equal(loads,0);
  const different=await readLocalHTML(make('y'+'x'.repeat(4*1024*1024-1)),{native:true,identify:false});
  for(const blob of [local.snapshot.file,different.snapshot.file]){const slice=blob.slice.bind(blob);blob.slice=(start,end)=>{assert.ok(end-start<=4096,'prefix mismatch must not hash entire book');return slice(start,end);};}
  const record={id:'changed',name:local.name,file:different.snapshot.file};assert.deepEqual(await findLocalDuplicates(local,[record],async()=>record),[]);
  const samePrefix=await readLocalHTML(make('x'.repeat(2*1024*1024)+'y'+'x'.repeat(2*1024*1024-1)),{native:true,identify:false});
  const fresh=await readLocalHTML(make('x'.repeat(4*1024*1024)),{native:true,identify:false});
  assert.deepEqual(await findLocalDuplicates(fresh,[{id:'middle',name:fresh.name}],async()=>({file:samePrefix.snapshot.file})),[]);
});
test('duplicate matching finds renamed copies and independent annotation records without loading bodies',async()=>{
  const local=await readLocalHTML(file('<body>same</body>'));
  const records=[{id:'one',name:'original.html',sourceIdentity:local.sourceIdentity},{id:'two',name:'another.html',sourceIdentity:local.sourceIdentity},{id:'other',name:local.name,sourceIdentity:await localFileIdentity(file('<body>else</body>'))}];
  assert.deepEqual((await findLocalDuplicates(local,records,()=>{throw Error('No body read needed');})).map(record=>record.id),['one','two']);
});
test('legacy prepared HTML matches without altering annotations, and same-name different content does not match',async()=>{
  const local=await readLocalHTML(file('<html><head><title>Old</title></head><body><p>Same text</p></body></html>'));
  const parsed=parseHTML(local.snapshot.html,{}, {allowScripts:true,includeMetadata:true});
  parsed.metadata.annotations=[{id:'kept',type:'note',text:'Keep this note',color:'#334155',width:3,opacity:1,points:[{x:1,y:2}]}];
  const stored={id:'legacy',name:local.name,html:serializeHTML(documentFor(parsed.html),parsed.metadata),metadata:parsed.metadata};
  const before=structuredClone(stored),other={id:'other',name:local.name,html:parseHTML('<body>Different content</body>',{}, {allowScripts:true}).html};
  assert.deepEqual((await findLocalDuplicates(local,[stored,other],async id=>id==='legacy'?stored:other)).map(record=>record.id),['legacy']);assert.deepEqual(stored,before);
});
test('legacy large streamed sources match without full-file or full-text reads',async()=>{
  const raw=file('<html><head><title>Large</title></head><body><!--'+'x'.repeat(4*1024*1024)+'--><p>Body</p></body></html>');
  const a=await readLocalHTML(raw,{native:true,allowScripts:true}),b=await readLocalHTML(raw,{native:true,allowScripts:true});
  a.snapshot.file.text=a.snapshot.file.arrayBuffer=b.snapshot.file.text=b.snapshot.file.arrayBuffer=async()=>{throw Error('Full read');};
  const record={id:'legacy-large',name:raw.name,file:b.snapshot.file};
  assert.deepEqual((await findLocalDuplicates(a,[record],async()=>record)).map(record=>record.id),['legacy-large']);
});
test('legacy streamed duplicate recognition survives the saved-frame CSP addition without weakening exact matching',async()=>{
  const make=body=>file('<html><head><title>Old CSP</title></head><body><!--'+body+'--><p>Body</p></body></html>'),body='x'.repeat(4*1024*1024);
  const a=await readLocalHTML(make(body),{native:true,allowScripts:true,identify:false});
  const prefix=await a.snapshot.file.slice(0,1024).text(),marker=" frame-src 'self';",offset=prefix.indexOf(marker);assert.ok(offset>=0);
  const old=new Blob([a.snapshot.file.slice(0,offset),a.snapshot.file.slice(offset+marker.length)],{type:'text/html;charset=utf-8'});
  const record={id:'old-csp',name:a.name,byteSize:old.size};assert.deepEqual((await findLocalDuplicates(a,[record],async()=>({file:old}))).map(r=>r.id),['old-csp']);
  const changed=await readLocalHTML(make(body.slice(0,2*1024*1024)+'y'+body.slice(2*1024*1024+1)),{native:true,allowScripts:true,identify:false});
  assert.deepEqual(await findLocalDuplicates(changed,[record],async()=>({file:old})),[]);
});
test('fresh annotations remove imported notes and bookmarks on both parsed and streamed DOM paths',async()=>{
  const parsed=parseHTML('<html><head><title>Saved</title></head><body><p>Original body</p><script>window.sourceKept=true</script></body></html>',{source:'https://example.test/book'}, {allowScripts:true});
  parsed.metadata.annotations=[{id:'old',type:'note',text:'Existing note',color:'#334155',width:3,opacity:1,points:[{x:1,y:2}]}];
  parsed.metadata.bookmarks=[{id:'mark',title:'Existing bookmark',top:10,left:0}];
  const html=serializeHTML(documentFor(parsed.html),parsed.metadata),before=html;
  assert.equal(parseHTML(html,{}, {allowScripts:true}).metadata.annotations.length,1);
  for(const result of [parseHTML(html,{}, {allowScripts:true,includeMetadata:true,freshAnnotations:true}),await prepareLoadedHTML(documentFor(html),{execution:{allowScripts:true}},()=>false,{freshAnnotations:true})]){
    assert.deepEqual(result.metadata.annotations,[]);assert.deepEqual(result.metadata.bookmarks,[]);assert.equal(result.metadata.title,'Saved');assert.equal(result.metadata.source,'https://example.test/book');assert.match(result.html,/Original body/);assert.match(result.html,/window.sourceKept=true/);
    assert.deepEqual(parseHTML(result.html,{}, {allowScripts:true}).metadata.annotations,[]);
  }
  assert.equal(html,before);assert.equal(parsed.metadata.annotations.length,1);assert.equal(parsed.metadata.bookmarks.length,1);
});

test('MIME-only copies reuse proof of the same complete immutable bytes',async()=>{
  const raw=file('same bytes'),slice=raw.slice.bind(raw);let reads=0;
  raw.slice=(...args)=>{const part=slice(...args),read=part.arrayBuffer.bind(part);part.arrayBuffer=()=>{reads++;return read();};return part;};
  const expected=await localFileIdentity(raw),before=reads,typed=localFileWithType(raw,'application/octet-stream');
  assert.equal(typed.type,'application/octet-stream');assert.equal(await typed.text(),'same bytes');assert.deepEqual(await localFileIdentity(typed),expected);assert.equal(reads,before);
  assert.strictEqual(localFileWithType(raw,raw.type),raw);assert.equal(sameLocalFile(await localFileIdentity(file('same byteX')),expected),false);
});
