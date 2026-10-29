import test from 'node:test';
import assert from 'node:assert/strict';
import {Reader} from '../public/src/reader.js';
import {textIndex,serializeHTML} from '../public/src/document.js';
import {documentFor,installDOM} from './dom.mjs';

function fixture(){
 installDOM();const doc=documentFor('<html><head></head><body><p id="a">First <em>formatted</em> line.</p><p id="b">Second line.</p><aside><p>Outline</p></aside><button>Control</button></body></html>'),reader=Object.create(Reader.prototype),calls=[],selection={ranges:[],removeAllRanges(){this.ranges=[];},addRange(range){this.ranges=[range];},get rangeCount(){return this.ranges.length;},get isCollapsed(){return !this.ranges.length;},getRangeAt(){return this.ranges[0];}};
 doc.getSelection=()=>selection;
 // LinkeDOM reports both text-node directions as preceding. Model the browser
 // contract here; actual caret geometry and DOM ordering are checked in Chrome.
 const walker=doc.createTreeWalker(doc.body,4),ordered=[];while(walker.nextNode())ordered.push(walker.currentNode);
 for(const [i,node]of ordered.entries())node.compareDocumentPosition=other=>other===node?0:ordered.indexOf(other)>i?4:2;
 doc.createRange=()=>({setStart(node,offset){this.startContainer=node;this.startOffset=offset;},setEnd(node,offset){this.endContainer=node;this.endOffset=offset;},intersectsNode(node){const nodes=textIndex(doc).nodes.map(n=>n.node);return nodes.indexOf(node)>=nodes.indexOf(this.startContainer)&&nodes.indexOf(node)<=nodes.indexOf(this.endContainer);}});
 const captures=[];doc.documentElement.setPointerCapture=id=>captures.push(['set',id]);doc.documentElement.releasePointerCapture=id=>captures.push(['release',id]);
 Object.assign(reader,{doc,tool:'highlight',callbacks:{},host:{hidden:false},metadata:{annotations:[]},addText:(type,anchor)=>calls.push({type,anchor}),textAtClick:event=>event.hit||null,syncAnnotationPicking(){}});
 const event=(hit,x=10,extra={})=>({button:0,pointerType:'touch',pointerId:1,isPrimary:true,target:hit?.node?.parentElement||doc.body,clientX:x,clientY:20,hit,preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;},...extra});
 return {reader,doc,selection,calls,captures,event,first:{node:doc.querySelector('#a').firstChild,offset:0},last:{node:doc.querySelector('#b').firstChild,offset:5}};
}
test('finger and pen drags create text highlights and underlines in either direction',async()=>{
 for(const pointerType of ['touch','pen'])for(const type of ['highlight','underline','strike'])for(const reverse of [false,true]){
  const f=fixture(),r=f.reader;r.tool=type;const first={node:f.first.node,offset:1},last={node:f.first.node,offset:4},start=reverse?last:first,end=reverse?first:last;
  r.pointerDown(f.event(start,20,{pointerType}));r.pointerMove(f.event(end,60,{pointerType}));assert.equal(f.selection.rangeCount,1);assert.ok(r.textMarkGesture);
  await r.pointerUp(f.event(end,60,{pointerType}));assert.equal(f.calls.length,1);assert.equal(f.calls[0].type,type);assert.equal(f.calls[0].anchor.quote,'irst');assert.equal(r.textMarkGesture,null);assert.equal(f.selection.rangeCount,0);assert.deepEqual(f.captures,[['set',1],['release',1]]);
 }
});
test('text dragging spans inline markup and paragraphs without rebuilding a book index during preview',async()=>{
 const f=fixture(),r=f.reader;const walker=f.doc.createTreeWalker;f.doc.createTreeWalker=()=>assert.fail('A pointer move must not index the full book');
 r.pointerDown(f.event(f.first));r.pointerMove(f.event(f.last,80));assert.equal(r.captureTextSelection(),null);assert.equal(f.selection.rangeCount,1);
 f.doc.createTreeWalker=walker;await r.pointerUp(f.event(f.last,80));assert.equal(f.calls[0].anchor.quote,'First formatted line.Second');
});
test('a touch release uses the last visible range even if release coordinates are zero',async()=>{
 const f=fixture(),r=f.reader;r.pointerDown(f.event(f.first));r.pointerMove(f.event({node:f.first.node,offset:4},50));await r.pointerUp(f.event(null,0,{clientY:0}));assert.equal(f.calls[0].anchor.quote,'First');
});
test('taps, wrong pointers and starts on blank space or controls do not create text marks',async()=>{
 const f=fixture(),r=f.reader;for(const hit of [null,{node:f.doc.querySelector('button').firstChild,offset:1},{node:f.doc.querySelector('aside p').firstChild,offset:1}]){r.pointerDown(f.event(hit));await r.pointerUp(f.event(hit));assert.equal(f.calls.length,0);}
 r.pointerDown(f.event(f.first));r.pointerMove(f.event(f.last,80,{pointerId:2}));await r.pointerUp(f.event(f.last,80,{pointerId:2}));assert.equal(f.calls.length,0);await r.pointerUp(f.event(f.first,11));assert.equal(f.calls.length,0);assert.equal(r.textMarkGesture,null);
});
test('mode changes, cancellation and section changes discard an unfinished text mark',async()=>{
 for(const cancel of ['mode','cancel','section','removed']){
  const f=fixture(),r=f.reader;r.pointerDown(f.event(f.first));r.pointerMove(f.event({node:f.first.node,offset:4},50));
  if(cancel==='mode')r.setTool('select');else if(cancel==='cancel')r.cancelTextMarkGesture();else if(cancel==='section'){const content=f.doc.createElement('div');content.id='reader-content';content.dataset.section='new-section';f.doc.body.append(content);}else f.first.node.parentElement.remove();
  await r.pointerUp(f.event(null));assert.equal(f.calls.length,0);assert.equal(r.textMarkGesture,null);assert.equal(f.selection.rangeCount,0);
 }
});
test('a second finger cancels text marking and enables two-finger native scrolling',async()=>{
 const f=fixture(),r=f.reader;Object.assign(r,{nativeScroll:true,zoom:1,frame:{getBoundingClientRect:()=>({left:0,top:0})},scrollDocumentBy:(target,left,top)=>f.calls.push({left,top})});
 r.pointerDown(f.event(f.first));r.pointerMove(f.event({node:f.first.node,offset:4},50));
 const touch=(id,y)=>({identifier:id,clientX:20+id*20,clientY:y,target:f.doc.body});const multi=points=>({touches:points,target:f.doc.body,cancelable:true,preventDefault(){this.prevented=true;},stopPropagation(){}});
 r.startTouchScroll(multi([touch(1,100),touch(2,100)]));assert.equal(r.textMarkGesture,null);assert.equal(r.touchScroll.manual,true);r.moveTouchScroll(multi([touch(1,70),touch(2,70)]));assert.deepEqual(f.calls,[{left:0,top:30}]);
 await r.pointerUp(f.event(f.last,80));r.endTouchScroll(multi([touch(1,70)]));await r.pointerUp(f.event(f.last,80));assert.equal(f.calls.length,1);r.endTouchScroll(multi([]));assert.equal(r.touchScroll,null);
});
test('text marking mode reserves touch scrolling but leaves desktop mouse selection native',async()=>{
 const f=fixture(),r=f.reader;r.setTool('underline');assert.equal(f.doc.documentElement.hasAttribute('data-htmlmemo-text-marking'),true);assert.equal(f.doc.documentElement.hasAttribute('data-htmlmemo-drawing'),false);assert.match(r.textMarkingStyle(),/touch-action:none/);
 const down=f.event(f.first,10,{pointerType:'mouse'});r.pointerDown(down);assert.equal(down.prevented,undefined);assert.equal(r.textMarkGesture,undefined);r.setTool('select');assert.equal(f.doc.documentElement.hasAttribute('data-htmlmemo-text-marking'),false);
});
test('a moving pointer may reach line-end whitespace but an empty start never snaps to a word',async()=>{
 const f=fixture(),r=f.reader;f.doc.caretPositionFromPoint=()=>({offsetNode:f.first.node,offset:f.first.node.length});r.pointerDown(f.event(null));assert.equal(r.textMarkGesture,undefined);
 r.pointerDown(f.event(f.first));r.pointerMove(f.event(null,100));await r.pointerUp(f.event(null,0));assert.equal(f.calls[0].anchor.quote,'First ');
});
test('export leaves active text marking in the reader and removes its touch policy from the shared file',()=>{
 const f=fixture();f.reader.setTool('highlight');const html=serializeHTML(f.doc,{version:1,annotations:[],bookmarks:[],view:{},viewport:{width:390,height:844}});assert.doesNotMatch(html,/data-htmlmemo-text-marking/);assert.equal(f.doc.documentElement.hasAttribute('data-htmlmemo-text-marking'),true);
});
