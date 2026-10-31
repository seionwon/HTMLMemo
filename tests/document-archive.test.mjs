import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {installDOM} from './dom.mjs';
import {zipBlobs,createDocumentArchive,readDocumentArchive,readArchiveEntries,archiveName} from '../public/src/document-archive.js';
import {readLocalHTML,findLocalDuplicates,localFileIdentity,isLocalHTMLFile} from '../public/src/local-files.js';
import {parseHTML} from '../public/src/document.js';
import JSZip from 'jszip';
installDOM();
const metadata=()=>parseHTML('<html><head><title>주석 원본</title></head><body><p>본문</p></body></html>').metadata;
function state(){const m=metadata();m.annotations=[{id:'note',type:'note',color:'#edbf64',width:3,opacity:1,anchor:'n1',points:[{x:.2,y:.3}],text:'메모 <script>private</script>'}];m.bookmarks=[{id:'mark',title:'다시 읽기',top:15,left:3,anchor:'n1'}];m.view={scrollTop:15,scrollLeft:3,zoom:1.2,fontScale:1.1,readingTheme:'dark'};return m;}
test('original, current annotations, bookmarks and reading state round-trip through an ordinary ZIP',async()=>{
 const original=new File(['<!doctype html><html><head><title>원본</title></head><body>본문</body></html>'],'원본.html',{type:'text/html'}),m=state();
 const file=await createDocumentArchive({name:original.name,original,metadata:m});const result=await readDocumentArchive(file);
 assert.equal(result.manifest.format,'librememo-document');assert.equal(result.manifest.original.name,original.name);assert.equal(await result.original.text(),await original.text());assert.deepEqual(result.metadata.annotations,m.annotations);assert.deepEqual(result.metadata.bookmarks,m.bookmarks);assert.deepEqual(result.metadata.view,m.view);assert.equal(result.reading.size,original.size);
 const entries=await readArchiveEntries(file);assert.deepEqual([...entries.keys()],['manifest.json','metadata.json','original/원본.html']);assert.equal(entries.has('settings.json'),false);
 const standard=await JSZip.loadAsync(await file.arrayBuffer(),{checkCRC32:true});assert.equal(await standard.file('original/원본.html').async('string'),await original.text());
});
test('Office, ebook and MHTML originals are byte-identical while the stable rendered snapshot stays separate',async()=>{
 for(const name of ['원고.docx','책.epub','책.hwpx','표.xlsx','그림.cbz','페이지.mhtml']){
  const original=new File([Uint8Array.of(0x50,0x4b,1,2,3,4)],name),reading=new Blob(['<html><head></head><body><p>읽기 화면</p></body></html>'],{type:'text/html'});
  const output=await createDocumentArchive({name,original,reading,metadata:state()}),r=await readDocumentArchive(output);
  assert.deepEqual(new Uint8Array(await r.original.arrayBuffer()),new Uint8Array(await original.arrayBuffer()));assert.equal(r.original.name,name);assert.equal(await r.reading.text(),await reading.text());assert.equal(r.manifest.reading.path,'reading/document.html');
 }
});
test('PDF keeps the exact source, standard file signature, page positions and state',async()=>{
 const original=new File([await readFile(new URL('fixtures/unified-reader.pdf',import.meta.url))],'책.pdf',{type:'application/pdf'}),m=state();m.format='pdf';m.bookmarks[0].pdfPosition={page:2,y:.4};m.view.pdfPosition={page:2,y:.4};
 const result=await readDocumentArchive(await createDocumentArchive({name:original.name,original,metadata:m}));assert.deepEqual(new Uint8Array(await result.original.arrayBuffer()),new Uint8Array(await original.arrayBuffer()));assert.equal(result.metadata.format,'pdf');assert.deepEqual(result.metadata.bookmarks,m.bookmarks);assert.deepEqual(result.metadata.view.pdfPosition,m.view.pdfPosition);
 const local=await readLocalHTML(new File([await createDocumentArchive({name:original.name,original,metadata:m})],'restore.librememo'),{identify:false}),{documentExportBlob}=await import('../public/src/document-export.js'),again=await documentExportBlob('archive',{metadata:m,pdf:{source:local.snapshot.pdf}},{name:local.name,originalFile:local.originalFile,originalReading:local.originalReading});assert.equal(local.originalReading,true);assert.equal((await readArchiveEntries(again)).size,3,'the exact same PDF is stored only once after another import/export');
});
test('normal file import recognizes archives and preserves the source fingerprint without discarding newly received notes',async()=>{
 const original=new File(['<html><head></head><body>본문</body></html>'],'원본.html',{type:'text/html'}),base=await createDocumentArchive({name:original.name,original,metadata:state()}),file=new File([base],'원본.librememo');
 assert.equal(isLocalHTMLFile(file),true);const local=await readLocalHTML(file,{identify:false});assert.equal(local.name,original.name);assert.deepEqual(local.sourceIdentity,await localFileIdentity(original));assert.equal(local.snapshot.archiveMetadata.annotations.length,1);
 const originalRecord={id:'old',sourceIdentity:local.sourceIdentity};assert.deepEqual(await findLocalDuplicates(local,[originalRecord],()=>{throw Error('must not read unchanged source');}),[]);
 const archiveRecord={id:'archive',importArchiveIdentity:local.importArchiveIdentity};assert.deepEqual(await findLocalDuplicates(local,[archiveRecord],()=>null),[archiveRecord]);
});
test('archive HTML takes the normal UTF-16 and saved execution-policy path',async()=>{
 const text='<html><head><meta charset="utf-16le"></head><body><p>한글 원본</p></body></html>',bytes=new Uint8Array(2+text.length*2),v=new DataView(bytes.buffer);v.setUint16(0,0xfeff,true);for(let n=0;n<text.length;n++)v.setUint16(2+n*2,text.charCodeAt(n),true);
 const original=new File([bytes],'원본.html'),m=state();m.execution={allowScripts:false};
 const archive=await createDocumentArchive({name:original.name,original,metadata:m}),local=await readLocalHTML(new File([archive],'restore.librememo'),{native:true,allowScripts:true,identify:false});
 assert.match(local.snapshot.html,/한글 원본/);assert.equal(local.snapshot.allowScripts,false);assert.equal(local.snapshot.archiveMetadata.execution.allowScripts,false);assert.deepEqual(new Uint8Array(await local.originalFile.arrayBuffer()),bytes);
});
test('a legacy reading copy is never relabeled as an exact original after another import and export',async()=>{
 const source=new Blob(['<html><head></head><body>읽기 사본</body></html>']),archive=await createDocumentArchive({name:'사본.html',original:source,metadata:state(),originalExact:false}),local=await readLocalHTML(new File([archive],'사본.librememo'),{identify:false});assert.equal(local.originalExact,false);
 const {documentExportBlob}=await import('../public/src/document-export.js'),again=await documentExportBlob('archive',{metadata:local.snapshot.archiveMetadata},{name:local.name,originalFile:local.originalFile,originalExact:local.originalExact,html:local.snapshot.html});assert.equal((await readDocumentArchive(again)).manifest.original.exact,false);
});
test('damaged checksums, missing parts, wrong versions and unsafe paths are rejected before a document can be registered',async()=>{
 const original=new Blob(['<html><head></head><body>unchanged</body></html>']),valid=await createDocumentArchive({name:'book.html',original,metadata:state()});
 const broken=new Uint8Array(await valid.arrayBuffer());broken[80]^=1;await assert.rejects(readDocumentArchive(new Blob([broken])));await assert.rejects(readDocumentArchive(valid.slice(0,valid.size-7)));
 for(const name of ['../outside','/outside','a\\b','a/./b','a//b'])await assert.rejects(zipBlobs([{name,blob:new Blob(['no'])}]));
 const entries=await readArchiveEntries(valid),manifest=JSON.parse(await entries.get('manifest.json').text());
 for(const change of [{version:99},{reading:{kind:'html',path:'missing.html'}},{original:{...manifest.original,path:'../outside'}}]){
  const bad=await zipBlobs([...entries].map(([name,blob])=>({name,blob:name==='manifest.json'?new Blob([JSON.stringify({...manifest,...change})]):blob})));await assert.rejects(readDocumentArchive(bad));
 }
});
test('names are safe and a cancellation produces no partial archive',async()=>{
 assert.equal(archiveName('책.fb2.zip'),'책.librememo');assert.equal(archiveName('report.docx','pdf'),'report.pdf');
 const controller=new AbortController();controller.abort();await assert.rejects(createDocumentArchive({name:'book.html',original:new Blob(['original']),metadata:state()},{signal:controller.signal}),{name:'AbortError'});
});
test('large immutable sources are only read in bounded chunks, without an entire-source arrayBuffer',async()=>{
 const source=new Blob(['<html><head></head><body>',new Uint8Array(12*1024*1024),'</body></html>'],{type:'text/html'});source.arrayBuffer=()=>{throw Error('unbounded source read');};let progress=0;
 const file=await createDocumentArchive({name:'large.html',original:source,metadata:state()},{onProgress:()=>progress++});assert.ok(progress>10);const result=await readDocumentArchive(file);assert.equal(result.original.size,source.size);
});
