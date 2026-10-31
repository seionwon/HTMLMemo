import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {installDOM,documentFor} from './dom.mjs';
import {preparePDF,exportPDFHTML,readPDFArchive,verifyPDF,PDF_ARCHIVE_MARKER} from '../public/src/pdf-document.js';
import {readLocalHTML,isLocalHTMLFile,droppedHTMLFiles,findLocalDuplicates,localFileIdentity,htmlExportName} from '../public/src/local-files.js';
import {validateAnnotations,validPDFPosition} from '../public/src/model.js';
import {blobRangeSource,PdfReader} from '../public/src/pdf-reader.js';
import {PdfTextSearch,indexPdfSearchPage,findPdfPageMatches,normalizePdfQuery} from '../public/src/pdf/text-search.js';
import {PdfRenderQueue} from '../public/src/pdf/page-rendering.js';
import {PDF_SCROLL_WINDOW_HEIGHT,pdfWindowBase,pdfWindowScrollTop} from '../public/src/pdf/viewport-window.js';

installDOM();
const bytes=await readFile(new URL('fixtures/unified-reader.pdf',import.meta.url));
const file=()=>new File([bytes],'책.pdf',{type:'application/pdf'});
const mark={id:'pdf-highlight',type:'highlight',color:'#edcf67',width:3,opacity:.35,textAnchor:{start:0,end:4,quote:'text'},pdfPage:1,pdfRects:[{page:1,x:.1,y:.2,w:.3,h:.02}]};

test('PDF picker, input, drag/drop, duplicate detection and export names use the existing document path',async()=>{
  const source=file();assert.ok(isLocalHTMLFile(source));assert.deepEqual(await droppedHTMLFiles({files:[source]}),[source]);
  const local=await readLocalHTML(source,{identify:false});assert.equal(local.snapshot.pdf,source);assert.equal(local.snapshot.html,undefined);assert.equal(local.handle,null);
  const identity=await localFileIdentity(source);assert.deepEqual(await findLocalDuplicates(local,[{id:'same',name:'renamed.pdf',sourceIdentity:identity}],()=>{throw Error('must not load a known body');}),[{id:'same',name:'renamed.pdf',sourceIdentity:identity}]);
  assert.equal(htmlExportName('책.PDF',true),'책-주석.html');await assert.rejects(readLocalHTML(new File(['not PDF'],'bad.pdf')),/올바른 PDF/);
});
test('PDF annotations, bookmarks, theme and position survive a self-contained HTML archive with byte-identical source',async()=>{
  const source=file(),parsed=preparePDF(source,{title:'PDF <script> title'});parsed.metadata.annotations=[mark];parsed.metadata.bookmarks=[{id:'b',title:'돌아올 곳',top:40,left:0,pdfPosition:{page:2,y:.25}}];parsed.metadata.view={zoom:1.2,fontScale:1.1,readingTheme:'dark',pdfPosition:{page:2,y:.25}};
  const archive=await exportPDFHTML(source,parsed.metadata);assert.ok((await archive.slice(0,128).text()).startsWith(PDF_ARCHIVE_MARKER));
  const reopened=await readPDFArchive(archive);assert.deepEqual(new Uint8Array(await reopened.pdf.arrayBuffer()),new Uint8Array(bytes));assert.deepEqual(reopened.metadata.annotations,[mark]);assert.deepEqual(reopened.metadata.bookmarks,parsed.metadata.bookmarks);assert.deepEqual(reopened.metadata.view.pdfPosition,{page:2,y:.25});assert.equal(reopened.metadata.view.readingTheme,'dark');
  const local=await readLocalHTML(new File([archive],'주석.html',{type:'text/html'}));assert.deepEqual(local.snapshot.metadata.annotations,[mark]);assert.equal(local.snapshot.metadata.format,'pdf');assert.deepEqual(new Uint8Array(await local.snapshot.pdf.arrayBuffer()),new Uint8Array(bytes));
  const fresh=preparePDF(reopened.pdf,{metadata:reopened.metadata,freshAnnotations:true});assert.deepEqual(fresh.metadata.annotations,[]);assert.deepEqual(fresh.metadata.bookmarks,[]);assert.equal(reopened.metadata.annotations.length,1);
  assert.equal(documentFor(await archive.text()).querySelectorAll('script:not([type="application/json"])').length,0);
});
test('PDF archive streams across base64 chunk boundaries and rejects truncation, corrupt data and injected markup',async()=>{
  const source=new Blob([bytes,new Uint8Array(700001)]),parsed=preparePDF(source),archive=await exportPDFHTML(source,parsed.metadata),restored=await readPDFArchive(archive);
  assert.deepEqual(new Uint8Array(await restored.pdf.arrayBuffer()),new Uint8Array(await source.arrayBuffer()));
  await assert.rejects(readPDFArchive(archive.slice(0,archive.size-70)),/손상|끝부분/);
  const html=await archive.text();await assert.rejects(readPDFArchive(new Blob([html.replace('JVBERi0','<script>bad</script>')])),/손상/);
  await assert.rejects(verifyPDF(new Blob([])),/올바른 PDF/);
});
test('PDF markup and page coordinates are bounded before restore or rendering',()=>{
  assert.deepEqual(validateAnnotations([mark]),[mark]);assert.ok(validPDFPosition({page:100000,y:1}));
  for(const rect of [{page:0,x:0,y:0,w:.1,h:.1},{page:1,x:Infinity,y:0,w:.1,h:.1},{page:1,x:.9,y:.9,w:.2,h:.2},{page:1,x:0,y:0,w:0,h:.1}])assert.throws(()=>validateAnnotations([{...mark,pdfRects:[rect]}]),/PDF/);
  for(const position of [{page:-1,y:0},{page:1,y:NaN},{page:100001,y:.5}])assert.ok(!validPDFPosition(position));
});
test('PDFMemo range transport reads only requested local bytes and stops after cancellation',async()=>{
  const received=[],errors=[];class Transport{constructor(length){this.length=length;}onDataRange(start,value){received.push({start,value});}}
  const source=new Blob([bytes]),config=blobRangeSource({PDFDataRangeTransport:Transport},source,error=>errors.push(error));
  config.range.requestDataRange(13,101);await config.range.tail;assert.deepEqual(received[0],{start:13,value:new Uint8Array(bytes.subarray(13,101))});assert.equal(config.disableAutoFetch,true);
  config.range.abort();config.range.requestDataRange(200,300);await config.range.tail;assert.equal(received.length,1);assert.deepEqual(errors,[]);
  const invalid=blobRangeSource({PDFDataRangeTransport:Transport},source,error=>errors.push(error));invalid.range.requestDataRange(-1,10);await invalid.range.tail;assert.equal(errors.length,1);
});
const content=raw=>({items:[{str:raw,transform:[12,0,0,12,30,700],width:raw.length*6,height:12,fontName:'f'}],styles:{f:{ascent:NaN,descent:NaN,fontFamily:'sans-serif'}}});
const viewport={width:600,height:800,scale:1,transform:[1,0,0,-1,0,800]};
test('ported PDFMemo search normalizes Korean spacing and ligatures and creates finite text rectangles',()=>{
  assert.equal(normalizePdfQuery('한 글 \nＡ ﬃ'),'한글affi');const index=indexPdfSearchPage(content('한 글 Ａ ﬃ test test'),viewport),matches=findPdfPageMatches(index,'한글affi',1);assert.equal(matches.length,1);assert.ok(matches[0].rects.length);for(const r of matches[0].rects)assert.ok(Object.values(r).every(Number.isFinite));assert.equal(findPdfPageMatches(index,'test',1).length,2);
});
test('ported PDFMemo search reuses extracted and persisted text, while resolving geometry only for selected pages',async()=>{
  let reads=0,saved;const pdf={numPages:5,getPage:async page=>({getTextContent:async()=>{reads++;return content('Page '+page+' keyword');},getViewport:()=>viewport})},store={load:async()=>saved,save:async pages=>{saved=structuredClone(pages);}},signal=new AbortController().signal;
  const engine=new PdfTextSearch(pdf,{store});let result;await engine.run('keyword',1,signal,p=>result=p,{deferGeometry:true});assert.equal(reads,5);assert.equal(result.matches.length,5);await engine.run('Page 3',1,signal,p=>result=p,{deferGeometry:true});assert.equal(reads,5);assert.equal(result.matches[0].page,3);
  const reopened=new PdfTextSearch(pdf,{store});await reopened.run('keyword',1,signal,p=>result=p,{deferGeometry:true});assert.equal(reads,5);await reopened.locate([result.matches[4]],signal);assert.equal(reads,6);engine.clear();reopened.clear();
});
test('ported PDFMemo rendering queue keeps a visible lane available and cancels queued work',async()=>{
  const queue=new PdfRenderQueue(),order=[];let release;const gate=new Promise(resolve=>release=resolve),signal=new AbortController().signal;
  const a=queue.schedule(()=>1,signal,async()=>{order.push('neighbour');await gate;});await new Promise(resolve=>setImmediate(resolve));
  const cancelled=new AbortController(),b=queue.schedule(()=>2,cancelled.signal,async()=>order.push('cancelled'));cancelled.abort();await assert.rejects(b,{name:'AbortError'});
  const c=queue.schedule(()=>0,signal,async()=>order.push('visible'));await c;assert.deepEqual(order,['neighbour','visible']);release();await a;
});
test('ported PDFMemo window keeps a fifty-thousand-page document below the CSS height limit',()=>{
  const total=53192*1100,logical=total*.7,base=pdfWindowBase(total,logical,logical);assert.ok(base>0&&base<total);assert.ok(logical-base<PDF_SCROLL_WINDOW_HEIGHT);assert.equal(pdfWindowScrollTop(250,base,base+100,2),50);assert.equal(pdfWindowBase(1000,500),0);
});
test('PDF page identity tolerates rounded scroll positions after font scaling without choosing the preceding page',()=>{
  const state={count:4,scale:1.1,tops:Float64Array.from([0,1078.6666666667,2157.3333333333,3236,4314.6666666667])};
  for(const page of [2,3,4]){const target=state.tops[page-1]*state.scale;assert.equal(PdfReader.prototype.pageAt.call(state,Math.floor(target)),page);assert.equal(PdfReader.prototype.pageAt.call(state,target-12),page-1);}
});
