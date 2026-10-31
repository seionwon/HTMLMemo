import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {hangulFixtures,hmlText} from './hangul-fixtures.mjs';
import {installDOM,documentFor} from './dom.mjs';
import {renderOffice} from '../public/src/office-render.js';
import {hangulPage,validateHML} from '../public/src/office-hangul.js';
import {parseHTML,textIndex,wrapOffsets,serializeHTML} from '../public/src/document.js';
import {verifyOffice} from '../public/src/office-formats.js';
import {APP_FILES} from '../public/src/distribution.js';
installDOM();const fixtures=await hangulFixtures();
test('rhwp reads each format with pages, exact Korean search text, shared highlights and export roundtrip',async()=>{
  for(const [format,bytes] of Object.entries(fixtures)){
    const parsed=parseHTML((await renderOffice(bytes,format,'한글')).html),doc=documentFor(parsed.html),index=textIndex(doc);
    assert.equal(parsed.nativeScroll,true);assert.equal(doc.querySelectorAll('.office-page').length,2);
    assert.match(index.text,/검색하는 한국어 본문입니다/);assert.match(index.text,/표 안의 검색 본문/);assert.match(index.text,/두 번째 쪽의 본문과 북마크/);
    assert.ok([...doc.querySelectorAll('text')].every(n=>n.closest('[aria-hidden="true"]')),'vector glyphs do not repeat TTS');
    const start=index.text.indexOf('한국어'),quote='한국어';assert.ok(wrapOffsets(doc,start,start+quote.length,{'data-htmlmemo-mark':'hangul'},'background:#ffaa0055',index).length);
    const metadata={...parsed.metadata,annotations:[{id:'hangul',type:'highlight',color:'#ffaa00',opacity:.3,width:2,textAnchor:{start,end:start+quote.length,quote}}],bookmarks:[{id:'bookmark',title:'둘째 쪽',top:100,left:0}]};
    const shared=parseHTML(serializeHTML(doc,metadata),{},{includeMetadata:true});assert.deepEqual(shared.metadata.annotations,metadata.annotations);assert.equal(shared.metadata.bookmarks.length,1);assert.match(textIndex(documentFor(shared.html)).text,/검색하는 한국어 본문입니다/);
  }
});
test('rhwp independently sourced HWP3, HWPX and HML corpus preserves text, shapes and HML warnings',async()=>{
  for(const [name,format,expected] of [['legacy.hwp','hwp',/별표/],['reference.hwpx','hwpx',/안녕 Hello 123/],['formatting.hml','hml',/table[\s\S]*textbox/]]){
    const bytes=await readFile('tests/fixtures/rhwp/'+name);await verifyOffice(new File([bytes],name),format);
    const result=await renderOffice(bytes,format,name),doc=documentFor(result.html);assert.match(textIndex(doc).text,expected);assert.ok(doc.querySelector('svg rect,svg path,svg ellipse'));
    if(format==='hml')assert.ok(result.warnings.some(s=>s.includes('생략')));
  }
});
test('rhwp SVG is rebuilt without scripts, event handlers, external resources or active nested HTML',()=>{
  const warnings=[],svg='<svg width="200" height="200"><script>bad()</script><foreignObject><iframe src="https://bad.invalid"/></foreignObject><image href="https://bad.invalid/track" onload="bad()"/><rect fill="url(https://bad.invalid)"/><a href="javascript:bad()"><text x="5" y="20" font-size="12" onclick="bad()">&lt;script&gt;글&lt;/script&gt;</text></a><defs><clipPath id="clip"><rect width="10" height="10"/></clipPath></defs><g clip-path="url(#clip)"><path d="M0 0L10 10"/></g></svg>';
  const html=hangulPage(svg,3,warnings),doc=documentFor('<html><body>'+html+'</body></html>');
  assert.equal(doc.querySelector('script,iframe,[onload],[onclick],[href^="http"],[href^="javascript"]'),null);assert.ok(!html.includes('https://bad.invalid'));assert.match(textIndex(doc).text,/<script>글<\/script>/);assert.ok(warnings.length);assert.match(html,/id="rhwp-3-clip"/);assert.match(html,/url\(#rhwp-3-clip\)/);
});
test('wide letter spacing uses original text offsets rather than inventing spaces inside Korean words',()=>{
  const layout={runs:[{text:'한글 문서',x:0,y:0,charX:[0,20,30,35,55,65],secIdx:0,paraIdx:0}]};
  const svg='<svg width="200" height="100">'+[['한',0],['글',20],['문',35],['서',55]].map(([text,x])=>'<text x="'+x+'" y="8.5" font-size="10" textLength="10">'+text+'</text>').join('')+'</svg>';
  const doc=documentFor('<html><body>'+hangulPage(svg,0,[],()=>10,layout)+'</body></html>');
  assert.match(textIndex(doc).text,/한글 문서/);assert.equal(doc.querySelectorAll('foreignObject').length,1);
});
test('HML encoding, root and entity checks run before WASM; mismatched extensions and malformed archives fail',async()=>{
  const utf16=new Uint8Array(Buffer.from('\ufeff'+hmlText.replace('UTF-8','UTF-16'),'utf16le'));validateHML(utf16);assert.match((await renderOffice(utf16,'hml','UTF16')).html,/office-page/);
  for(const source of ['<!DOCTYPE HWPML [<!ENTITY x SYSTEM "https://bad.invalid">]>'+hmlText,'<html>not HML</html>'])assert.throws(()=>validateHML(new TextEncoder().encode(source)),/엔터티|문서 형식/);
  assert.throws(()=>validateHML(new Uint8Array(16*1024*1024+1)),/16MB/);
  await assert.rejects(renderOffice(fixtures.hml,'hwp','wrong.hwp'),/확장자/);
  await assert.rejects(verifyOffice(new File(['bad'],'bad.hwp'),'hwp'),/손상/);
  await assert.rejects(renderOffice(new Uint8Array([0x50,0x4b,3,4]),'hwpx','bad.hwpx'));
});
test('rhwp worker and immutable local WASM engine are included in offline and portable app assets',async()=>{
  for(const name of ['src/office-hangul.js','vendor/office/rhwp/rhwp.js','vendor/office/rhwp/rhwp_bg.wasm','vendor/office/rhwp/LICENSE','vendor/office/rhwp/THIRD-PARTY-NOTICES.txt'])assert.ok(APP_FILES.includes(name));
  for(const name of ['rhwp.js','rhwp_bg.wasm'])assert.deepEqual(await readFile('public/vendor/office/rhwp/'+name),await readFile('node_modules/@rhwp/core/'+name));
});
