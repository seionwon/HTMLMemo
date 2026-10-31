import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {ebookFixtures,ebookZip,epubParts,fb2Source,ebookText} from './ebook-fixtures.mjs';
import {installDOM,documentFor} from './dom.mjs';
import {renderOffice} from '../public/src/office-render.js';
import {officeFormat} from '../public/src/office-formats.js';
import {validateMOBI,validateFB2} from '../public/src/office-ebook.js';
import {resourceBlobs} from '../public/vendor/ebook/foliate.js';
import {readLocalHTML,htmlExportName,localFileIdentity,findLocalDuplicates} from '../public/src/local-files.js';
import {parseHTML,textIndex,wrapOffsets,serializeHTML} from '../public/src/document.js';
import {Reader} from '../public/src/reader.js';
import {APP_FILES} from '../public/src/distribution.js';

const fixtures=await ebookFixtures();
async function rendered(bytes,format){const result=await renderOffice(bytes,format,'전자책.'+format);installDOM();return result;}
function outline(doc){return Reader.prototype.outline.call({doc});}
for(const [format,bytes] of Object.entries(fixtures))test('foliate read-only import, original identity and common searchable document: '+format,async()=>{
  const source=new File([bytes],'전자책.'+format),local=await readLocalHTML(source,{identify:false});
  assert.equal(officeFormat(source),format);assert.equal(local.snapshot.office,source);assert.equal(local.originalFile,source);assert.equal(htmlExportName(source.name,true),'전자책-주석.html');
  const identity=await localFileIdentity(source);assert.deepEqual(await findLocalDuplicates(local,[{id:'same',sourceIdentity:identity}],()=>{throw Error('unexpected source reload');}),[{id:'same',sourceIdentity:identity}]);
  const result=await rendered(bytes,format),parsed=parseHTML(result.html),doc=documentFor(parsed.html),entries=outline(doc),text=textIndex(doc).text;
  assert.equal(parsed.nativeScroll,true);assert.equal(result.allowScripts,false);assert.equal(doc.querySelector('script,iframe,object,embed,[contenteditable]'),null);
  assert.ok(entries.length>=2);assert.ok(entries.every(e=>e.node.isConnected));assert.equal(new Set([...doc.querySelectorAll('[id]')].map(n=>n.id)).size,doc.querySelectorAll('[id]').length);
  if(format==='cbz'){assert.deepEqual(entries.map(x=>x.title),['page2.png','page10.png']);assert.equal(doc.querySelectorAll('img[src^="data:image/"]').length,2);assert.ok(result.warnings.some(s=>s.includes('OCR')));}
  else if(format==='azw3'){assert.match(text,/Alice|ALICE/);assert.ok(doc.querySelector('img[src^="data:image/"],image[href^="data:image/"]'));}
  else{assert.match(text,new RegExp(ebookText));assert.ok(doc.querySelector('img[src^="data:image/"]'));}
  assert.deepEqual(new Uint8Array(await source.arrayBuffer()),bytes);
});
test('EPUB 2 NCX and EPUB 3 nested navigation preserve cross-chapter links and duplicate source IDs',async()=>{
  for(const version of [2,3]){
    const doc=documentFor((await rendered(await ebookZip(epubParts({version})),'epub')).html),entries=outline(doc);
    assert.deepEqual(entries.map(e=>[e.title,e.level]),[['첫 장',1],['첫 절',2],['둘째 장',1]]);
    const link=[...doc.querySelectorAll('section a')].find(a=>a.textContent==='다음 장으로'),target=doc.getElementById(link.getAttribute('href').slice(1));assert.equal(target.textContent,'둘째 장');assert.notEqual(entries[0].node.id,entries[2].node.id);
    assert.equal(doc.querySelector('svg use').getAttribute('href'),'#'+doc.querySelector('svg circle').id);
    assert.match(doc.querySelector('article style').textContent,/@scope \(#ebook-section-0\)/);
  }
});
test('fixed-layout EPUB uses the existing scalable SVG/HTML text surface, keeping search and highlights',async()=>{
  const parsed=parseHTML((await rendered(await ebookZip(epubParts({fixed:true})),'epub')).html),doc=documentFor(parsed.html),index=textIndex(doc);
  assert.equal(doc.querySelectorAll('.ebook-fixed-page>svg').length,2);assert.equal(doc.querySelector('.ebook-fixed-page>svg').getAttribute('viewBox'),'0 0 600 800');assert.ok(doc.querySelector('foreignObject [data-office-text]'));assert.match(index.text,/검색하는 한국어/);
});
test('EPUB, FB2, MOBI and real KF8 share saved annotations, bookmarks and TOC through exported HTML',async()=>{
  for(const format of ['epub','fb2','mobi','azw3']){
    const parsed=parseHTML((await rendered(fixtures[format],format)).html),doc=documentFor(parsed.html),index=textIndex(doc),quote=format==='azw3'?'Alice':'한국어',start=index.text.indexOf(quote);
    assert.ok(start>=0);assert.ok(wrapOffsets(doc,start,start+quote.length,{'data-htmlmemo-mark':'ebook-highlight'},'background:#ff05',index).length);
    const metadata={...parsed.metadata,annotations:[{id:'ebook-highlight',type:'highlight',color:'#ffee00',opacity:.3,width:2,textAnchor:{start,end:start+quote.length,quote}}],bookmarks:[{id:'ebook-bookmark',title:'이어서',top:100,left:0}]};
    const before=outline(doc).map(e=>[e.title,e.level,e.node.id]),shared=parseHTML(serializeHTML(doc,metadata),{},{includeMetadata:true}),restored=documentFor(shared.html);
    assert.deepEqual(shared.metadata.annotations,metadata.annotations);assert.equal(shared.metadata.bookmarks.length,1);assert.deepEqual(outline(restored).map(e=>[e.title,e.level,e.node.id]),before);assert.equal(textIndex(restored).text,index.text);
  }
});
test('FB2 UTF-16 and embedded notes survive namespace conversion',async()=>{
  const bytes=new Uint8Array(Buffer.from('\ufeff'+fb2Source().replace('UTF-8','UTF-16'),'utf16le')),doc=documentFor((await rendered(bytes,'fb2')).html);
  assert.match(textIndex(doc).text,/각주 내용입니다/);const link=[...doc.querySelectorAll('section a[href]')].find(n=>n.textContent==='주석');assert.ok(doc.getElementById(link.getAttribute('href').slice(1)));
});
test('ebook content cannot introduce scripts, external resources, app metadata or chapter style escapes',async()=>{
  const parts=epubParts();parts['OEBPS/chapter1.xhtml']=parts['OEBPS/chapter1.xhtml'].replace('</body>','<script>steal()</script><iframe src="https://evil.invalid"/><form><input/></form><img src="https://evil.invalid/a" onerror="steal()"/><a href="javascript:steal()">bad</a><template data-ebook-outline><a href="#htmlmemo-data">forged</a></template><div id="htmlmemo-data" data-htmlmemo-ui="true">safe text</div><svg xmlns="http://www.w3.org/2000/svg"><foreignObject><iframe src="https://evil.invalid"/></foreignObject><rect fill="url(https://evil.invalid/x)"/></svg></body>');parts['OEBPS/book.css']+='\n@import "https://evil.invalid/track";body + section{color:red}p{background:url(https://evil.invalid/x);position:fixed;pointer-events:none}';
  const result=await rendered(await ebookZip(parts),'epub'),doc=documentFor(result.html);
  assert.equal(doc.querySelector('script,iframe,form,input,[onerror],[data-htmlmemo-ui],#htmlmemo-data,[href^="javascript:"],[src^="http"]'),null);assert.equal(doc.querySelectorAll('template[data-ebook-outline]').length,1);assert.ok(!result.html.includes('evil.invalid'));assert.match(doc.body.textContent,/safe text/);assert.ok(result.warnings.length);
  for(const style of doc.querySelectorAll('article style')){assert.match(style.textContent,/@scope/);assert.doesNotMatch(style.textContent,/position:fixed|pointer-events/);}
});
test('DRM, malformed, entity expansion and unsafe ebook ZIP paths fail with no leaked resources',async()=>{
  const initial=resourceBlobs.size;
  const parts=epubParts();parts['META-INF/encryption.xml']='<encryption><EncryptedData><EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes256-cbc"/></EncryptedData></encryption>';
  await assert.rejects(rendered(await ebookZip(parts),'epub'),/DRM|암호/);
  const mobi=fixtures.mobi.slice(),view=new DataView(mobi.buffer);view.setUint16(view.getUint32(78)+12,2);assert.throws(()=>validateMOBI(mobi),/DRM/);
  view.setUint16(view.getUint32(78)+12,0);view.setUint32(view.getUint32(78)+4,65*1024*1024);assert.throws(()=>validateMOBI(mobi),/너무 큽/);
  for(const format of ['mobi','azw3','epub','fb2','cbz'])await assert.rejects(rendered(new Uint8Array([1,2,3,4]),format));
  for(const content of ['<!DOCTYPE FictionBook [<!ENTITY x SYSTEM "file:///private">]>'+fb2Source(),'<html>not FB2</html>'])assert.throws(()=>validateFB2(new TextEncoder().encode(content)),/엔터티|형식/);
  for(const [name,content] of [['../bad.xml','<x/>'],['OEBPS/chapter1.xhtml','<!DOCTYPE html [<!ENTITY x "oops">]><html/>']])await assert.rejects(rendered(await ebookZip({...epubParts(),[name]:content}),'epub'),/경로|엔터티/);
  await assert.rejects(rendered(await ebookZip({'a.fb2':fixtures.fb2,'b.fb2':fixtures.fb2}),'fbz'),/하나/);
  assert.equal(resourceBlobs.size,initial);
});
test('MIT and every exact bundled foliate dependency notice travel with offline app assets',async()=>{
  assert.deepEqual(await readFile('LICENSE'),await readFile('public/LICENSE.txt'));assert.equal(JSON.parse(await readFile('package.json')).license,'MIT');
  for(const name of ['LICENSE.txt','src/office-ebook.js','vendor/ebook/foliate.js','vendor/ebook/foliate.js.LEGAL.txt','vendor/ebook/FOLIATE-LICENSE.txt','vendor/ebook/THIRD-PARTY-NOTICES.txt','vendor/ebook/UPSTREAM.json'])assert.ok(APP_FILES.includes(name));
  const upstream=JSON.parse(await readFile('public/vendor/ebook/UPSTREAM.json')),notices=await readFile('public/vendor/ebook/THIRD-PARTY-NOTICES.txt','utf8');
  assert.equal(upstream.commit,'78914aef4466eb960965702401634c2cb348e9b1');assert.ok(upstream.bundledDependencies.length>=14);
  for(const dep of upstream.bundledDependencies){assert.ok(['MIT','ISC','BSD-2-Clause','BSD-3-Clause','Apache-2.0'].includes(dep.license));assert.ok(notices.includes(dep.name+' '+dep.version));}
  for(const file of upstream.files)assert.equal(createHash('sha256').update(await readFile('vendor-src/foliate-js/'+file.path)).digest('hex'),file.sha256);
});
