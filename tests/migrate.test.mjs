import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateRawSync} from 'node:zlib';
import {documentFor,installDOM} from './dom.mjs';
import {crc32} from '../public/src/zip.js';
import {textIndex,describeDrawingTarget,resolveTextAnchor} from '../public/src/document.js';
import {locateQuote,locateElement,unzipEntry,migrateAnnotations,similarity} from '../public/src/migrate.js';
installDOM();

// A JSZip-shaped archive: one deflated entry with sizes in the central directory.
function deflatedZip(name,text){
  const data=Buffer.from(text),packed=deflateRawSync(data),file=Buffer.from(name),local=Buffer.alloc(30),central=Buffer.alloc(46),end=Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(8,8);local.writeUInt32LE(crc32(data),14);local.writeUInt32LE(packed.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(file.length,26);
  central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(8,10);central.writeUInt32LE(crc32(data),16);central.writeUInt32LE(packed.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(file.length,28);central.writeUInt32LE(0,42);
  const offset=30+file.length+packed.length;end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(46+file.length,12);end.writeUInt32LE(offset,16);
  return new Uint8Array(Buffer.concat([local,file,packed,central,file,end]));
}
const anchorIn=(text,quote)=>{const start=text.indexOf(quote);return {start,end:start+quote.length,quote,prefix:text.slice(Math.max(0,start-40),start),suffix:text.slice(start+quote.length,start+quote.length+40)};};

test('a quote is found as is, after rewording around it, after small edits inside it, and not when it is gone',()=>{
  const old='첫 문단입니다. 에이전트는 지시를 받아 파일을 읽고 고칩니다. 마지막 문단입니다.';
  const anchor=anchorIn(old,'에이전트는 지시를 받아 파일을 읽고 고칩니다.');
  assert.deepEqual(locateQuote(old,anchor),{start:anchor.start,end:anchor.end,similarity:1,context:1});
  const moved='새로 넣은 머리말이 길게 붙었습니다. 첫 문단입니다. 에이전트는 지시를 받아 파일을 읽고 고칩니다. 끝.';
  const hit=locateQuote(moved,anchor);assert.equal(moved.slice(hit.start,hit.end),anchor.quote);assert.equal(hit.similarity,1);
  const edited='첫 문단입니다. 에이전트는 지시를 받으면 파일을 읽고 직접 고칩니다. 마지막 문단입니다.';
  const fuzzy=locateQuote(edited,anchor);assert.ok(fuzzy.similarity>=.7&&fuzzy.similarity<1);
  assert.equal(edited.slice(fuzzy.start,fuzzy.end),'에이전트는 지시를 받으면 파일을 읽고 직접 고칩니다.');
  assert.equal(locateQuote('첫 문단입니다. 전혀 다른 이야기가 들어섰습니다. 마지막 문단입니다.',anchor),null);
  // A repeated phrase is told apart by the text around it.
  const twice='A안: 설치합니다. 그다음 실행합니다. B안: 설치합니다. 그다음 검사합니다.';
  const second=anchorIn(twice,'설치합니다. 그다음 검사');const found=locateQuote('머리말. '+twice,{...second,start:0,end:0});
  assert.equal(found.start,'머리말. '.length+second.start);
  // Short marks are not guessed: they move only when unchanged.
  assert.equal(locateQuote('코드는 깃에',{quote:'커밋',prefix:'',suffix:''}),null);
  const long='가'.repeat(10)+'나다라마바사아자차카타파하'.repeat(80)+'끝';const longAnchor=anchorIn(long,long.slice(10,900));
  const longHit=locateQuote('머리 '+long.replace('나다라마','나다-라마'),longAnchor);assert.ok(longHit&&longHit.end-longHit.start>800);
  assert.ok(similarity('kitten','sitting')>.5&&similarity('abc','abc')===1);
});

test('a drawing finds its paragraph again by text, even when the paragraph was edited or moved',()=>{
  const old=documentFor('<html><body><article id="reader-content" data-section="v0:a"><h2>설치</h2><p>에이전트를 설치하는 문단입니다. 터미널을 엽니다.</p><p>다른 문단</p></article></body></html>');
  const target=describeDrawingTarget(old,old.querySelectorAll('p')[0]);
  const next=documentFor('<html><body><article id="reader-content"><p>앞에 새 문단이 생겼습니다.</p><h2>설치</h2><p>에이전트를 설치하는 문단입니다. 먼저 터미널을 엽니다.</p><p>다른 문단</p></article></body></html>');
  const hit=locateElement(next,next.getElementById('reader-content'),target);
  assert.equal(hit.element,next.querySelectorAll('p')[1]);assert.ok(hit.similarity>.8&&hit.similarity<1);
  const gone=documentFor('<html><body><article id="reader-content"><p>완전히 바뀐 본문만 남았습니다.</p></article></body></html>');
  assert.equal(locateElement(gone,gone.getElementById('reader-content'),target),null);
});

test('section bodies are read from a deflated book volume',async()=>{
  const bytes=await unzipEntry(deflatedZip('sections.json',JSON.stringify(['# 첫 장','둘째 장'])),'sections.json');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(bytes)),['# 첫 장','둘째 장']);
  assert.equal(await unzipEntry(deflatedZip('other.json','[]'),'sections.json'),null);
});

// Two editions of a packed book. The probe renders one section per show(), like the book runtime.
function book(volumes,bodies){
  const manifest={format:'memosuite-book-html-v1',volumes};
  const payloads=volumes.map((volume,i)=>`<script type="application/octet-stream" id="book-volume-${i}">${Buffer.from(deflatedZip('sections.json',JSON.stringify(volume.sections.map(s=>bodies[s.key].markdown)))).toString('base64')}</script>`).join('');
  const doc=documentFor(`<html><body><nav id="reader-nav"><div id="reader-tree">${volumes.flatMap(v=>v.sections).map(s=>`<a>${s.title}</a>`).join('')}</div></nav><div id="reader-section-label"></div><div id="reader-status"></div><article id="reader-content"></article><script id="book-manifest" type="application/json">${JSON.stringify(manifest)}</script>${payloads}</body></html>`);
  const content=doc.getElementById('reader-content');
  const show=async key=>{content.innerHTML=bodies[key].html;content.dataset.section=key;};
  return {doc,show,shown:[],async showTracked(key){this.shown.push(key);await show(key);}};
}
const section=(volume,id,title)=>({key:`v${volume}:${id}`,id,title,volume});

test('moving annotations follows sections by id, searches moved text, and drops annotations whose text was deleted',async()=>{
  const oldBook=book([{book:'vibe',sections:[section(0,'a','설치'),section(0,'b','실행')]}],{
    'v0:a':{markdown:'# 설치\n에이전트를 **설치**합니다. 터미널을 엽니다.',html:'<h1>설치</h1><p>에이전트를 <strong>설치</strong>합니다. 터미널을 엽니다.</p><p>곧 지워질 문단입니다. 이 문장은 사라집니다.</p>'},
    'v0:b':{markdown:'# 실행\n명령을 실행합니다. 결과를 확인합니다.',html:'<h1>실행</h1><p>명령을 실행합니다. 결과를 확인합니다.</p>'}});
  await oldBook.show('v0:a');
  let index=textIndex(oldBook.doc);
  const highlight={id:'h1',type:'highlight',color:'#edcf67',width:3,opacity:.35,textAnchor:{...anchorIn(index.text,'에이전트를 설치합니다.'),section:'v0:a'}};
  const doomed={id:'h2',type:'underline',color:'#334155',width:3,opacity:1,textAnchor:{...anchorIn(index.text,'곧 지워질 문단입니다. 이 문장은 사라집니다.'),section:'v0:a'}};
  const pen={id:'p1',type:'pen',color:'#d94f4f',width:3,opacity:1,anchor:'n3',anchorTarget:describeDrawingTarget(oldBook.doc,oldBook.doc.querySelector('p')),points:[{x:.1,y:.2},{x:.5,y:.6}],penBasis:{width:600,height:80,fontSize:18}};
  await oldBook.show('v0:b');index=textIndex(oldBook.doc);
  // Made before HTMLMemo recorded sections: found by searching the new edition's text.
  const legacy={id:'h3',type:'highlight',color:'#edcf67',width:3,opacity:.35,textAnchor:anchorIn(index.text,'결과를 확인합니다.')};
  const orphan={id:'n1',type:'note',color:'#334155',width:3,opacity:1,anchor:'n9',points:[{x:0,y:0}],text:'자리 정보가 없는 메모'};
  // New edition: a section was added in front (keys shift to another volume order), the install
  // sentence was reworded, the doomed paragraph removed, and 결과 moved into a new section.
  const newBook=book([{book:'intro',sections:[section(0,'z','새 장')]},{book:'vibe',sections:[section(1,'a','설치'),section(1,'c','확인')]}],{
    'v0:z':{markdown:'# 새 장\n새로 쓴 장입니다.',html:'<h1>새 장</h1><p>새로 쓴 장입니다.</p>'},
    'v1:a':{markdown:'# 설치\n에이전트를 먼저 **설치**합니다. 터미널을 엽니다.',html:'<h1>설치</h1><p>에이전트를 먼저 <strong>설치</strong>합니다. 터미널을 엽니다.</p>'},
    'v1:c':{markdown:'# 확인\n명령을 실행한 뒤 결과를 확인합니다.',html:'<h1>확인</h1><p>명령을 실행한 뒤 결과를 확인합니다.</p>'}});
  const progress=[];
  const {annotations,report}=await migrateAnnotations({annotations:[highlight,doomed,pen,legacy,orphan],oldDoc:oldBook.doc,
    probe:{doc:newBook.doc,show:key=>newBook.showTracked(key)},onProgress:(...args)=>progress.push(args)});
  assert.deepEqual(annotations.map(a=>a.id),['h1','p1','h3']);
  assert.deepEqual({same:report.same,changed:report.changed,deleted:report.deleted.map(a=>a.id),unplaceable:report.unplaceable.map(a=>a.id)},{same:1,changed:2,deleted:['h2'],unplaceable:['n1']});
  const [movedHighlight,movedPen,movedLegacy]=annotations;
  assert.equal(movedHighlight.textAnchor.quote,'에이전트를 먼저 설치합니다.');assert.equal(movedHighlight.textAnchor.section,'v1:a');
  assert.equal(movedPen.anchorTarget.section,'v1:a');assert.match(movedPen.anchorTarget.quote,/^에이전트를 먼저 설치합니다/);assert.deepEqual(movedPen.points,pen.points);
  assert.deepEqual(movedPen.penBasis,pen.penBasis);
  assert.equal(movedLegacy.textAnchor.quote,'결과를 확인합니다.');assert.equal(movedLegacy.textAnchor.section,'v1:c');
  // Only the sections that hold annotations were rendered, never the whole book.
  assert.deepEqual(newBook.shown,['v1:a','v1:c']);assert.ok(progress.length>=2);
  // The live reader resolves the moved anchor in the new edition.
  await newBook.show('v1:a');assert.deepEqual(resolveTextAnchor(textIndex(newBook.doc),movedHighlight.textAnchor),{start:movedHighlight.textAnchor.start,end:movedHighlight.textAnchor.end});
});

test('ordinary pages move in one pass over the whole page',async()=>{
  const old=documentFor('<html><body><h1>글</h1><p>바뀌지 않는 문장입니다.</p><p>그림을 그린 문단입니다.</p></body></html>');
  const text=textIndex(old).text;
  const annotations=[{id:'u1',type:'underline',color:'#334155',width:3,opacity:1,textAnchor:anchorIn(text,'바뀌지 않는 문장입니다.')},
    {id:'r1',type:'rect',color:'#334155',width:3,opacity:1,anchor:'n2',anchorTarget:describeDrawingTarget(old,old.querySelectorAll('p')[1]),points:[{x:0,y:0},{x:1,y:1}]}];
  const next=documentFor('<html><body><p>새 머리말</p><h1>글</h1><p>바뀌지 않는 문장입니다.</p><p>그림을 그린 문단입니다.</p></body></html>');
  const {annotations:moved,report}=await migrateAnnotations({annotations,oldDoc:old,probe:{doc:next,show:async()=>{}}});
  assert.equal(report.same,2);assert.equal(moved[1].anchorTarget.quote,'그림을 그린 문단입니다.');assert.equal(moved[1].anchor,'body');
});
