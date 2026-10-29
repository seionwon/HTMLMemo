import test from 'node:test';
import assert from 'node:assert/strict';
import {History} from '../public/src/model.js';
import {Reader} from '../public/src/reader.js';
import {textIndex,selectionAnchor,wrapOffsets,rangeFromOffsets} from '../public/src/document.js';
import {readAloudPosition} from '../public/src/read-aloud.js';
import {documentFor,installDOM} from './dom.mjs';
installDOM();

const stroke=id=>({id,type:'pen',color:'#334155',width:2,opacity:1,points:Array.from({length:100},(_,i)=>({x:i/100,y:i/200}))});
test('long undo histories retain unchanged pen coordinates once while preserving all 100 undo steps',()=>{
  const initial=Array.from({length:120},(_,i)=>stroke('pen'+i)),history=new History(initial);let current=initial;
  for(let i=0;i<120;i++)current=history.commit([...current,{id:'note'+i,text:'메모 '+i,points:[{x:i,y:i}]}]);
  assert.equal(history.entries.length,101);
  const retained=new Set(history.entries.flatMap(entry=>entry.filter(a=>a.type==='pen').map(a=>a.points)));
  assert.equal(retained.size,120,'undo snapshots must not multiply large unchanged point arrays');
  current[0].points[0].x=999;initial[0].points[1].y=999;
  assert.deepEqual(history.current[0],stroke('pen0'));
  for(let i=0;i<100;i++)history.undo();
  assert.equal(history.canUndo,false);assert.equal(history.current.length,140);
  for(let i=0;i<100;i++)history.redo();
  assert.equal(history.canRedo,false);assert.equal(history.current.length,240);
});

test('undo sharing detects nested edits and restores removed, reordered and reused annotation IDs after branching',()=>{
  const history=new History([stroke('a'),stroke('b')]),original=history.current;
  let current=history.current;current[0].points[3].x=42;current=history.commit(current);
  current[0].points[3].x=99;assert.equal(history.current[0].points[3].x,42);
  history.commit([current[1],{id:'a',text:'replacement',points:[{x:2,y:3}]}]);
  assert.deepEqual(history.undo().map(a=>a.id),['a','b']);assert.equal(history.current[0].points[3].x,42);
  assert.deepEqual(history.undo(),original);
  history.commit([original[1]]);assert.equal(history.canRedo,false);
  assert.deepEqual(history.undo(),original);assert.deepEqual(history.redo(),[original[1]]);
});

test('history does not coalesce different object shapes, negative zero, dates or cyclic data',()=>{
  const first={id:'shape',value:-0},h=new History([first]);h.commit([{id:'shape',value:0,extra:undefined}]);
  assert.ok(Object.is(h.undo()[0].value,-0));assert.equal(Object.hasOwn(h.current[0],'extra'),false);assert.equal(Object.hasOwn(h.redo()[0],'extra'),true);
  const cycle={id:'cycle',date:new Date(0)};cycle.self=cycle;h.commit([cycle]);const returned=h.current;assert.strictEqual(returned[0].self,returned[0]);returned[0].date.setTime(9);assert.equal(h.current[0].date.getTime(),0);
  const changed=h.current;changed[0].date=new Date(1);h.commit(changed);assert.equal(h.undo()[0].date.getTime(),0);assert.equal(h.redo()[0].date.getTime(),1);
});

function selectionFixture(body){
  const doc=documentFor('<html><head></head><body>'+body+'</body></html>');let walks=0,intersections=0,range;
  const walk=doc.createTreeWalker.bind(doc);doc.createTreeWalker=(...args)=>{walks++;return walk(...args);};
  doc.createRange=()=>({setStart(node,offset){this.startContainer=node;this.startOffset=offset;},setEnd(node,offset){this.endContainer=node;this.endOffset=offset;},intersectsNode(){intersections++;throw Error('Ordinary text boundaries must use the retained index');}});
  const reader=Object.assign(Object.create(Reader.prototype),{doc});doc.getSelection=()=>({rangeCount:1,isCollapsed:false,getRangeAt:()=>range});
  return {doc,reader,choose(a,from,b,to){range=doc.createRange();range.setStart(a,from);range.setEnd(b,to);return range;},get walks(){return walks;},get intersections(){return intersections;}};
}
test('repeated selections in a long document reuse the search index without whole-document range probes',()=>{
  const f=selectionFixture(Array.from({length:10000},(_,i)=>`<p>문단 ${i}의 🧠 선택한 글입니다.</p>`).join('')),nodes=[...f.doc.querySelectorAll('p')].map(p=>p.firstChild);
  for(let i=0;i<50;i++){const node=nodes[i*199],from=node.textContent.indexOf('🧠');f.choose(node,from,node,from+6);assert.equal(f.reader.captureTextSelection().quote,'🧠 선택한');}
  assert.equal(f.walks,1);assert.equal(f.intersections,0);
  assert.equal(f.reader.searchCache().query('선택한').results.length,3000);assert.equal(f.walks,1);f.reader.searchCache().dispose();
});
test('selection lookup stays correct after overlapping marks split previously indexed text nodes',()=>{
  const f=selectionFixture('<p>0123456789</p><p>가나다라마바사</p>'),index=textIndex(f.doc);
  f.choose(index.nodes[0].node,1,index.nodes[1].node,3);assert.equal(selectionAnchor(f.doc,f.doc.getSelection().getRangeAt(0),index).quote,'123456789가나다');
  for(const [start,end]of [[2,12],[0,5],[4,15]])wrapOffsets(f.doc,start,end,{'data-htmlmemo-mark':''},'',index);
  for(const [start,end]of [[0,2],[2,4],[3,13],[5,17]])assert.deepEqual(selectionAnchor(f.doc,rangeFromOffsets(f.doc,start,end,index),index),{start,end,quote:index.text.slice(start,end),prefix:index.text.slice(Math.max(0,start-40),start),suffix:index.text.slice(end,end+40)});
});
test('element and excluded boundaries retain the range-intersection fallback',()=>{
  const f=selectionFixture('<p>앞 글<script>제외</script><em>뒷 글</em></p>'),index=textIndex(f.doc),p=f.doc.querySelector('p');
  let probes=0;const range={startContainer:p,startOffset:0,endContainer:p,endOffset:3,intersectsNode(node){probes++;return p.contains(node);}};
  assert.equal(selectionAnchor(f.doc,range,index).quote,'앞 글뒷 글');assert.equal(probes,2);
  const excluded=f.doc.querySelector('script').firstChild;assert.equal(selectionAnchor(f.doc,{startContainer:excluded,startOffset:0,endContainer:excluded,endOffset:2,intersectsNode:()=>false},index),null);
});
test('a queued source replacement invalidates cached selection offsets before the next capture',()=>{
  const f=selectionFixture('<p>원래 본문</p>'),observers=[];
  Object.defineProperty(f.doc,'defaultView',{value:{MutationObserver:class{constructor(){this.records=[];observers.push(this);}observe(){}disconnect(){this.records=[];}takeRecords(){return this.records.splice(0);}}}});
  const p=f.doc.querySelector('p'),old=p.firstChild;f.choose(old,0,old,2);assert.equal(f.reader.captureTextSelection().quote,'원래');
  p.textContent='바뀐 본문';observers[0].records.push({type:'childList',target:p,addedNodes:[p.firstChild],removedNodes:[old]});f.choose(p.firstChild,0,p.firstChild,2);
  assert.equal(f.reader.captureTextSelection().quote,'바뀐');assert.equal(f.walks,2);f.reader.searchCache().dispose();
});

function previousPosition(parts,offset,isEnd){for(let i=parts.length-1;i>=0;i--){const p=parts[i];if(isEnd?offset>p.start:offset>=p.start)return {node:p.node,offset:p.offset+Math.max(0,Math.min(offset-p.start,p.length)),part:i};}return parts.length?{node:parts[0].node,offset:parts[0].offset,part:0}:null;}
test('TTS binary lookup preserves starts, ends, excluded gaps and selection-relative offsets',()=>{
  const parts=[{node:'a',start:0,offset:3,length:4},{node:'b',start:4,offset:0,length:7},{node:'c',start:12,offset:2,length:8}];
  for(const offset of [-1,0,1,3,4,5,11,12,13,20,30,NaN])for(const isEnd of [false,true])assert.deepEqual(readAloudPosition(parts,offset,isEnd),previousPosition(parts,offset,isEnd));
  assert.equal(readAloudPosition([],0),null);
});
test('TTS positions in a large chapter use logarithmic probes for each sentence',()=>{
  let reads=0;const parts=Array.from({length:20000},(_,i)=>({node:i,get start(){reads++;return i*12;},offset:0,length:11}));
  for(let i=0;i<2000;i++)assert.equal(readAloudPosition(parts,i*12+3).node,i);
  assert.ok(reads<2000*18,`Too many TTS position reads: ${reads}`);
});
