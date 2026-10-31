import test from 'node:test';
import assert from 'node:assert/strict';
import { readMHTML } from '../public/src/mhtml.js';
import { readLocalHTML, droppedHTMLFiles, isLocalHTMLFile, htmlExportName, identifyLocalFile, localFileIdentity, findLocalDuplicates } from '../public/src/local-files.js';
import { parseHTML, serializeHTML } from '../public/src/document.js';
import { documentFor, installDOM } from './dom.mjs';
installDOM();
const html=body=>'<html><head><title>한글 보관 문서</title></head><body>'+body+'</body></html>';
const base64=value=>Buffer.from(value).toString('base64');
const qp=value=>[...Buffer.from(value)].map(byte=>'='+byte.toString(16).padStart(2,'0')).join('');
const part=(type,body,extra='')=>'Content-Type: '+type+'\r\n'+extra+'\r\n'+body;
const archive=(parts,parameters='',extra='')=>'MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="boundary.+[]";\r\n type="text/html"'+parameters+'\r\n'+extra+'\r\nPreamble is ignored\r\n--boundary.+[]\r\n'+parts.join('\r\n--boundary.+[]\r\n')+'\r\n--boundary.+[]--\r\nEpilogue is ignored';
const file=(text,name='saved.mhtml',type='multipart/related')=>new File([text],name,{type,lastModified:1234});
const read=text=>readMHTML(file(text));
const textPart=(body,extra='')=>part('text/html; charset=utf-8',base64(html(body)),'Content-Transfer-Encoding: base64\r\nContent-Location: https://archive.example/articles/page.html\r\n'+extra);
const dataBytes=url=>Buffer.from(url.slice(url.indexOf(',')+1).split('#',1)[0],'base64');

test('MHTML restores UTF-8 quoted-printable text with folded headers and soft line breaks',async()=>{
  const raw=archive([part('text/html;\r\n charset="utf-8"',qp(html('<p>한글과 = 기호</p>')).replace(/(.{72})/g,'$1=\r\n'),'Content-Transfer-Encoding: quoted-printable\r\nContent-Location: https://archive.example/article\r\n')]);
  const result=await read(raw);assert.equal(documentFor(result.html).title,'한글 보관 문서');assert.equal(documentFor(result.html).body.textContent,'한글과 = 기호');assert.equal(result.url,'https://archive.example/article');assert.equal(result.allowScripts,false);assert.deepEqual(result.warnings,[]);
});
test('MHTML supports MHT, MIME-only names, file handles, read-only sources and raw duplicate identities',async()=>{
  const raw=archive([textPart('<p>원본 내용</p>')]);
  for(const name of ['saved.mhtml','saved.MHT','renamed']){
    const source=file(raw,name,name==='renamed'?'application/x-mimearchive':''),handle={kind:'file',name,getFile:async()=>source,createWritable(){throw Error('Original must never be written');}};
    const local=await readLocalHTML(handle,{native:true,allowScripts:true,identify:false});assert.match(local.snapshot.html,/원본 내용/);assert.equal(local.snapshot.allowScripts,false);assert.equal(local.snapshot.file,null);assert.equal(local.handle,null);assert.equal(local.originalHandle,handle);assert.deepEqual(local.diskStamp,{size:source.size,modified:1234});assert.equal(local.sourceIdentity,null);
    assert.deepEqual(await identifyLocalFile(local),await localFileIdentity(source));assert.equal(local.sourceIdentity.size,source.size);
    assert.equal((await findLocalDuplicates(local,[{id:'existing',name:'different.mhtml',sourceIdentity:local.sourceIdentity}],()=>{throw Error('No saved body read');}))[0].id,'existing');assert.equal(await source.text(),raw);
  }
});
test('MHTML selects a later start Content-ID, including nested multipart alternatives',async()=>{
  const nested='Content-Type: multipart/alternative; boundary=inner\r\nContent-ID: <root@archive>\r\n\r\n--inner\r\n'+part('text/plain','Plain alternative')+'\r\n--inner\r\n'+textPart('<p>정확한 본문</p>')+'\r\n--inner--';
  const result=await read(archive([textPart('Not the root'),nested],'; start="<root@archive>"'));assert.equal(documentFor(result.html).body.textContent,'정확한 본문');
});
test('MHTML converts relative image locations, percent-encoded CID and Base64 bytes without loss',async()=>{
  const bytes=Buffer.from([0,128,129,255,10,13,61,250]);
  const result=await read(archive([textPart('<img id="one" src="../images/photo.png"><img id="two" src="cid:photo%40archive">'),part('image/png',base64(bytes),'Content-Transfer-Encoding: base64\r\nContent-Location: ../images/photo.png\r\nContent-ID: <photo@archive>\r\n')]));
  const doc=documentFor(result.html);assert.deepEqual(dataBytes(doc.querySelector('#one').getAttribute('src')),bytes);assert.equal(doc.querySelector('#two').getAttribute('src'),doc.querySelector('#one').getAttribute('src'));assert.deepEqual(result.warnings,[]);
  const binary=Buffer.concat([Buffer.from('Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: binary\r\n\r\n'),Buffer.from(html('<p>실제 8bit 한글</p>'))]);assert.match((await readMHTML(new File([binary],'binary.mht'))).html,/실제 8bit 한글/);
});
test('MHTML preserves raw 8bit resource octets including bytes that Windows-1252 would remap',async()=>{
  const bytes=Buffer.from([0,128,129,255,61,250]),start=archive([textPart('<img src="cid:raw">'),part('image/png','RESOURCE-BYTES','Content-Transfer-Encoding: binary\r\nContent-ID: <raw>\r\n')]),offset=start.indexOf('RESOURCE-BYTES');
  const raw=Buffer.concat([Buffer.from(start.slice(0,offset)),bytes,Buffer.from(start.slice(offset+'RESOURCE-BYTES'.length))]);
  const result=await readMHTML(new File([raw],'raw.mhtml'));assert.deepEqual(dataBytes(documentFor(result.html).querySelector('img').getAttribute('src')),bytes);
});
test('MHTML restores external CSS, nested imports, escaped URLs, fonts, backgrounds and inline styles',async()=>{
  const source=html('<p style="background:url(../images/photo.png)">Styled</p>').replace('</head>','<link rel="stylesheet" integrity="old" crossorigin href="../styles/main.css"></head>');
  const result=await read(archive([part('text/html',base64(source),'Content-Transfer-Encoding: base64\r\nContent-Location: https://archive.example/articles/page.html\r\n'),part('text/css; charset=utf-8','@charset "utf-8"; @import "nested/type.css" screen; /* url(unused.png) */ p{background:url(../images/ph\\6f to.png);content:"url(not-a-resource)"}','Content-Location: https://archive.example/styles/main.css\r\n'),part('text/css','@font-face{font-family:Archive;src:url(../../fonts/book.woff2)}','Content-Location: https://archive.example/styles/nested/type.css\r\n'),part('font/woff2','FONT','Content-Location: https://archive.example/fonts/book.woff2\r\n'),part('image/png','IMAGE','Content-Location: https://archive.example/images/photo.png\r\n')]));
  const doc=documentFor(result.html),link=doc.querySelector('link'),css=dataBytes(link.getAttribute('href')).toString();
  assert.match(css,/@import url\("data:text\/css;charset=utf-8;base64,/);assert.match(css,/url\("data:image\/png;base64,SU1BR0U="\)/);assert.match(css,/\/\* url\(unused.png\) \*\//);assert.match(css,/content:"url\(not-a-resource\)"/);assert.ok(!css.includes('@charset'));
  const nested=dataBytes(css.match(/@import url\("([^"]+)/)[1]).toString();assert.match(nested,/data:font\/woff2;base64,Rk9OVA==/);assert.match(doc.querySelector('p').getAttribute('style'),/data:image\/png/);assert.equal(link.hasAttribute('integrity'),false);assert.equal(link.hasAttribute('crossorigin'),false);assert.deepEqual(result.warnings,[]);
});
test('MHTML uses the saved base URL, rewrites srcset and keeps navigation and document fragments',async()=>{
  const source=html('<a id="local" href="https://archive.example/articles/page.html#target">Here</a><a id="external" href="next.html">Next</a><img src="photo.png" srcset="photo.png 1x, cid:photo 2x"><p id="target">Here</p>').replace('</head>','<base href="https://archive.example/assets/"></head>');
  const result=await read(archive([part('text/html',base64(source),'Content-Transfer-Encoding: base64\r\nContent-Location: https://archive.example/articles/page.html\r\n'),part('image/png','IMAGE','Content-Location: https://archive.example/assets/photo.png\r\nContent-ID: <photo>\r\n')]));
  const doc=documentFor(result.html);assert.equal(doc.querySelector('base'),null);assert.equal(doc.querySelector('#local').getAttribute('href'),'#target');assert.equal(doc.querySelector('#external').getAttribute('href'),'https://archive.example/assets/next.html');assert.equal(doc.querySelector('img').getAttribute('srcset'),'data:image/png;base64,SU1BR0U= 1x, data:image/png;base64,SU1BR0U= 2x');assert.deepEqual(result.warnings,[]);
});
test('MHTML keeps existing data URLs in srcset and SVG fragments in CSS resource URLs',async()=>{
  const result=await read(archive([textPart('<img srcset="data:image/png;base64,SU1BR0U= 1x, cid:vector#picture 2x"><style>p{background:url(cid:vector#picture)} .local{filter:url(#filter)}</style>'),part('image/svg+xml','<svg xmlns="http://www.w3.org/2000/svg"/>','Content-ID: <vector>\r\n')]));
  const doc=documentFor(result.html);assert.match(doc.querySelector('img').getAttribute('srcset'),/^data:image\/png;base64,SU1BR0U= 1x, data:image\/svg\+xml;base64,[^ ]+#picture 2x$/);assert.match(doc.querySelector('style').textContent,/#picture/);assert.match(doc.querySelector('style').textContent,/url\("#filter"\)/);assert.deepEqual(result.warnings,[]);
});
test('MHTML restores saved iframe documents and their local assets without live remote frames',async()=>{
  const result=await read(archive([textPart('<iframe src="cid:child"></iframe>'),part('text/html',base64(html('<p>보관된 프레임</p><img src="picture.png">')),'Content-Transfer-Encoding: base64\r\nContent-ID: <child>\r\nContent-Location: https://archive.example/frame/index.html\r\n'),part('image/png','IMAGE','Content-Location: https://archive.example/frame/picture.png\r\n')]));
  const doc=documentFor(parseHTML(result.html,{source:result.url}).html),frame=doc.querySelector('iframe');assert.equal(frame.hasAttribute('src'),false);assert.equal(frame.getAttribute('sandbox'),'allow-same-origin');assert.ok(!frame.getAttribute('sandbox').includes('allow-scripts'));const nested=documentFor(frame.getAttribute('srcdoc'));assert.equal(nested.querySelector('p').textContent,'보관된 프레임');assert.match(nested.querySelector('img').getAttribute('src'),/^data:image\/png/);assert.deepEqual(result.warnings,[]);
  assert.match(doc.querySelector('meta[http-equiv="Content-Security-Policy"]').content,/frame-src 'self';/);
});
test('Chrome CID Content-Location styles resolve without Content-ID and keep each referring document base',async()=>{
  const source=html('<iframe src="cid:child"></iframe>').replace('</head>','<link rel="stylesheet" href="cid:sheet@archive"></head>'),child=html('<p>Child</p>').replace('</head>','<link rel="stylesheet" href="cid:sheet@archive"></head>');
  const result=await read(archive([part('text/html',base64(source),'Content-Transfer-Encoding: base64\r\nContent-Location: https://archive.example/articles/page.html\r\n'),part('text/html',base64(child),'Content-Transfer-Encoding: base64\r\nContent-ID: <child>\r\nContent-Location: https://archive.example/frame/index.html\r\n'),part('text/css','p{color:rgb(22,40,62);background:url(picture.png)}','Content-Location: cid:sheet@archive\r\n'),part('image/png','ROOT','Content-Location: https://archive.example/articles/picture.png\r\n'),part('image/png','CHILD','Content-Location: https://archive.example/frame/picture.png\r\n')]));
  const doc=documentFor(result.html),nested=documentFor(doc.querySelector('iframe').getAttribute('srcdoc'));
  const css=doc=>dataBytes(doc.querySelector('link').getAttribute('href')).toString();assert.match(css(doc),/data:image\/png;base64,Uk9PVA==/);assert.match(css(nested),/data:image\/png;base64,Q0hJTEQ=/);assert.match(css(nested),/color:rgb\(22,40,62\)/);assert.deepEqual(result.warnings,[]);
});
test('MHTML opens statically, strips network hints/scripts and reports only missing referenced resources',async()=>{
  const result=await read(archive([textPart('<img src="https://private.example/missing.png"><p onclick="bad()" style="background:url(missing.png)">Safe</p><script src="https://private.example/script.js"></script><iframe src="https://private.example/frame"></iframe><link rel="preconnect" href="https://private.example">')]));
  const parsed=parseHTML(result.html,{source:result.url,warnings:result.warnings},{allowScripts:result.allowScripts}),doc=documentFor(parsed.html);
  assert.equal(doc.querySelector('script,iframe,link'),null);assert.equal(doc.querySelector('p').hasAttribute('onclick'),false);assert.equal(doc.querySelector('img').hasAttribute('src'),false);assert.match(parsed.html,/script-src 'none'/);assert.equal(parsed.metadata.warnings.length,3);assert.ok(!parsed.html.includes('https://private.example/script.js'));
});
test('MHTML bounds CSS import cycles and reuses converted resources',async()=>{
  const result=await read(archive([textPart('<link rel="stylesheet" href="../a.css"><link rel="stylesheet" href="../a.css">'),part('text/css','@import "b.css"; p{color:red}','Content-Location: https://archive.example/a.css\r\n'),part('text/css','@import "a.css"; p{font-size:20px}','Content-Location: https://archive.example/b.css\r\n')]));
  const links=[...documentFor(result.html).querySelectorAll('link')];assert.equal(links[0].getAttribute('href'),links[1].getAttribute('href'));assert.equal(result.warnings.length,1);assert.ok(result.html.length<10000);
});
test('MHTML supports BOM/legacy charsets and preserves notes through self-contained HTML export',async()=>{
  const source=Buffer.concat([Buffer.from([255,254]),Buffer.from(html('<p>한글 본문</p>'),'utf16le')]);
  const result=await read(archive([part('text/html; charset=utf-16le',base64(source),'Content-Transfer-Encoding: base64\r\n')]));assert.match(result.html,/한글 본문/);assert.match(result.html,/charset="utf-8"/);
  const legacy=await read(archive([part('text/html; charset=windows-1252',base64(Buffer.from(html('<p>caf\xe9</p>'),'latin1')),'Content-Transfer-Encoding: base64\r\n')]));assert.match(legacy.html,/café/);assert.equal(legacy.url,'');
  const parsed=parseHTML(result.html);parsed.metadata.annotations=[{id:'saved',type:'note',text:'보관 주석',color:'#334155',width:3,opacity:1,points:[{x:10,y:20}]}];const exported=serializeHTML(documentFor(parsed.html),parsed.metadata);assert.equal(parseHTML(exported).metadata.annotations[0].text,'보관 주석');assert.match(exported,/한글 본문/);
});
test('MHTML preserves existing embedded HTMLMemo notes while disabling archived scripts',async()=>{
  const parsed=parseHTML(html('<p>주석이 있는 본문</p><script>window.unwanted=true</script>'),{}, {allowScripts:true});parsed.metadata.annotations=[{id:'embedded',type:'note',text:'원래 주석',color:'#334155',width:3,opacity:1,points:[{x:10,y:20}]}];
  const saved=serializeHTML(documentFor(parsed.html),parsed.metadata),result=await read(archive([part('text/html',base64(saved),'Content-Transfer-Encoding: base64\r\n')])),reopened=parseHTML(result.html,{}, {allowScripts:result.allowScripts});
  assert.equal(reopened.metadata.annotations[0].text,'원래 주석');assert.equal(reopened.metadata.execution.allowScripts,false);assert.ok(!reopened.html.includes('window.unwanted'));
});
test('malformed MHTML, missing HTML roots, broken encodings and unsupported charsets produce actionable errors',async()=>{
  for(const raw of ['',html('not MIME'),archive([part('image/png','image')]),archive([textPart('body')],'; start="<missing>"'),archive([textPart('body')]).replace('--boundary.+[]--','--not-the-closing-boundary--')])await assert.rejects(read(raw),/MHTML.*(?:구조|본문)/);
  await assert.rejects(read(archive([part('text/html','%invalid%','Content-Transfer-Encoding: base64\r\n')])),/Base64.*손상/);
  await assert.rejects(read(archive([part('text/html','content','Content-Transfer-Encoding: x-unknown\r\n')])),/지원하지 않는 MHTML 데이터 인코딩/);
  await assert.rejects(read(archive([part('text/html; charset=not-a-charset','content')])),/지원하지 않는 MHTML 문자 인코딩/);
});
test('HTML and MHTML pick/drop names and HTML export extensions stay consistent',async()=>{
  const files=['a.html','b.HTM','c.mhtml','d.MHT','x.txt'].map(name=>file('',name,''));assert.deepEqual(files.map(isLocalHTMLFile),[true,true,true,true,false]);assert.deepEqual(await droppedHTMLFiles({files}),files.slice(0,4));
  const handle={kind:'file',name:'from-picker.MHT'};assert.deepEqual(await droppedHTMLFiles({items:[{kind:'file',getAsFileSystemHandle:async()=>handle}]}),[handle]);
  for(const name of ['book.html','book.htm','book.mhtml','book.MHT']){assert.equal(htmlExportName(name),'book.html');assert.equal(htmlExportName(name,true),'book-주석.html');}
  assert.equal(htmlExportName('renamed'),'renamed.html');await assert.rejects(readLocalHTML(files[4]),/HTML, HTM, MHTML, MHT 또는 PDF/);
});
