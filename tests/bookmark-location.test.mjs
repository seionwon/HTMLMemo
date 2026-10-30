import test from 'node:test';
import assert from 'node:assert/strict';
import {documentFor,installDOM} from './dom.mjs';
import {textIndex,parseHTML,serializeHTML} from '../public/src/document.js';
import {bookmarkTextAnchor,bookmarkTextLocation,captureBookmarkLocations,findBookmarkText} from '../public/src/bookmark-location.js';
import {locateBookmarkText} from '../public/src/migrate.js';
import {Reader} from '../public/src/reader.js';
installDOM();

function geometry(text){
  const doc=documentFor(`<html><body><p id="long"></p></body></html>`),block=doc.getElementById('long');block.textContent=text;
  const layout={columns:40,line:20,top:100};
  const rect=(start,end)=>{const top=layout.top+Math.floor(start/layout.columns)*layout.line,bottom=layout.top+(Math.floor(Math.max(start,end-1)/layout.columns)+1)*layout.line,left=10+(start%layout.columns)*8,width=end-start>layout.columns?320:Math.max(8,(end-start)*8);return {top,bottom,left,right:left+width,width,height:bottom-top};};
  block.getBoundingClientRect=()=>({top:layout.top,left:10,width:320,height:Math.ceil(text.length/layout.columns)*layout.line});
  doc.createRange=()=>({start:0,end:0,selectNodeContents(node){this.start=0;this.end=node.length;},setStart(node,start){this.start=start;},setEnd(node,end){this.end=end;},getBoundingClientRect(){return rect(this.start,this.end);}});
  return {doc,layout};
}
test('bookmarks record the visible character far beyond a paragraph opening, with bounded context and reusable indices',()=>{
  const text='머리말입니다. '.repeat(50)+'이곳부터 다시 읽을 문장입니다. '+'계속되는 본문입니다. '.repeat(60),{doc}=geometry(text);
  const marks=[{id:'one',title:'읽던 곳',top:500,left:0},{id:'two',title:'뒤쪽',top:600,left:0}],before=structuredClone(marks);let builds=0;
  const captured=captureBookmarkLocations(doc,marks,{top:0,left:0},{getIndex:()=>{builds++;return textIndex(doc);}});
  assert.equal(builds,1);assert.deepEqual(marks,before);
  for(const [i,mark] of captured.entries()){
    assert.ok(bookmarkTextAnchor(mark));assert.equal(mark.textAnchor.start+mark.textPoint,800+i*200);assert.equal(mark.textOffsetY,0);assert.ok(mark.textAnchor.start>160);assert.ok(mark.textAnchor.quote.length<=192);assert.ok(mark.textAnchor.prefix.length<=80);assert.ok(mark.textAnchor.suffix.length<=80);
  }
  assert.deepEqual(parseHTML(serializeHTML(doc,{title:'책',annotations:[],bookmarks:captured})).metadata.bookmarks,captured);
});
test('precise bookmarks follow the same character after narrower layout and larger text, replacing a stale fallback notice',async()=>{
  const text='앞의 긴 문장. '.repeat(80)+'표시할 지점. '+'뒤의 문장. '.repeat(80),{doc,layout}=geometry(text);
  const mark=captureBookmarkLocations(doc,[{id:'one',title:'위치',top:500,left:0}],{top:0,left:0})[0];mark.editionPosition='text';
  const before=structuredClone(mark),notices=['이전 북마크의 정확한 본문 위치는 확인하지 못했습니다.'],r=Object.create(Reader.prototype);
  Object.assign(r,{doc,zoom:2,metadata:{annotations:[],bookmarks:[mark]},viewport:{scrollTop:0,scrollLeft:0},callbacks:{onNotice:message=>notices.push(message)},layerOrigin:()=>({top:0,left:0}),searchCache:()=>({get:()=>textIndex(doc)})});
  layout.columns=20;layout.line=32;
  assert.equal(await r.jumpBookmark(mark.id),true);assert.equal(r.scrollTop,(100+40*32)*2);assert.equal(notices.at(-1),'북마크의 본문 위치로 이동했습니다.');assert.deepEqual(mark,before);
});
test('surrounding context distinguishes identical passages and ignores stale character offsets',()=>{
  const quote='같은 문장이 반복되어도 읽던 곳을 기억합니다.',old='첫 번째 항목의 설명. '+quote+' 첫 항목 끝.\n두 번째 항목의 다른 설명. '+quote+' 둘째 항목 끝.';
  const start=old.lastIndexOf(quote),point=start+12,mark={...bookmarkTextLocation({text:old},point,'',0,{from:start,to:start+quote.length})};
  const next='새로 추가한 머리말입니다.\n'+old,hit=findBookmarkText(next,mark);assert.ok(hit&&!hit.ambiguous);assert.equal(hit.point,next.lastIndexOf(quote)+12);
  const ambiguous={...mark,textAnchor:{...mark.textAnchor,prefix:'',suffix:''}};assert.deepEqual(findBookmarkText(next,ambiguous),{ambiguous:true});assert.deepEqual(locateBookmarkText(next,ambiguous),{ambiguous:true});
});
test('whitespace, inline markup and regexp characters retain the same text point across editions',()=>{
  const old='[검색] A+B (예제)를 읽습니다.\n다음 줄에서 계속합니다. 😀 마지막 문장입니다.',point=old.indexOf('다음'),mark=bookmarkTextLocation({text:old},point);
  const next='새 앞부분 '+old.replace('A+B ','A+B\n  ').replace('\n다음','    다음');
  const hit=findBookmarkText(next,mark);assert.ok(hit&&!hit.ambiguous);assert.equal(hit.point,next.indexOf('다음'));
  const emoji='가'.repeat(63)+'😀'+'나'.repeat(300),unicode=bookmarkTextLocation({text:emoji},128);assert.ok(bookmarkTextAnchor(unicode));assert.ok(findBookmarkText(emoji,unicode));assert.ok(unicode.textAnchor.quote.length<=192);
});
test('small edits before a bookmark preserve the focused word while equally likely copies remain unresolved',()=>{
  const text='설치가 끝나면 터미널에서 첫 번째 명령을 실행하고 결과를 확인한 뒤 중요한 내용을 기록합니다. 오류가 있으면 원인을 살펴봅니다.',point=text.indexOf('중요한'),mark=bookmarkTextLocation({text},point);
  const edited=text.replace('첫 번째','새로운 첫 번째'),hit=locateBookmarkText(edited,mark);assert.ok(hit&&!hit.ambiguous);assert.equal(hit.point,edited.indexOf('중요한'));assert.ok(hit.similarity<1);
  assert.deepEqual(locateBookmarkText(edited+'\n\n'+edited,mark),{ambiguous:true});
});
test('an approximate chapter bookmark never invents precise text from the chapter beginning',()=>{
  const {doc}=geometry('여기는 원래 북마크 위치라는 증거가 없는 장 시작입니다.');
  const mark={id:'approximate',title:'위치',top:0,left:0,editionPosition:'section'},before=structuredClone(mark);
  assert.deepEqual(captureBookmarkLocations(doc,[mark],{top:0,left:0}),[before]);assert.equal(bookmarkTextAnchor(mark),null);
});
test('a bookmark in a large blank gap keeps its coordinates instead of inventing a distant text position',async()=>{
  const {doc}=geometry('짧은 문단 뒤에는 긴 여백이 있습니다.'),mark={id:'blank',title:'빈 곳',top:400,left:0},before=structuredClone(mark);
  const [saved]=captureBookmarkLocations(doc,[mark],{top:0,left:0});assert.deepEqual(saved,before);
  const reader=Object.create(Reader.prototype);Object.assign(reader,{doc,zoom:1,metadata:{bookmarks:[saved]},viewport:{scrollTop:0,scrollLeft:0},callbacks:{}});
  assert.equal(await reader.jumpBookmark(mark.id),true);assert.equal(reader.scrollTop,400);
  // Preparing migration again must not manufacture an anchor from a clamped paragraph end.
  assert.deepEqual(captureBookmarkLocations(doc,[saved],{top:0,left:0}),[before]);
});
test('malformed text anchors are rejected before matching or constructing a search pattern',()=>{
  const mark=bookmarkTextLocation({text:'기억할 본문 위치입니다.'},4);assert.ok(bookmarkTextAnchor(mark));
  for(const patch of [{textPoint:-1},{textPoint:10000},{locationVersion:0},{textAnchor:{...mark.textAnchor,quote:'x'.repeat(200)}},{textAnchor:{...mark.textAnchor,prefix:'x'.repeat(81)}},{textAnchor:{...mark.textAnchor,start:NaN}}]){
    const invalid={...mark,...patch};assert.equal(bookmarkTextAnchor(invalid),null);assert.equal(findBookmarkText('기억할 본문 위치입니다.',invalid),null);
  }
});
