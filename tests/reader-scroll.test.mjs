import test from 'node:test';
import assert from 'node:assert/strict';
import {Reader} from '../public/src/reader.js';

function scrollingReader(nativeScroll=false) {
  const frames=[];let frameId=0;
  const window={requestAnimationFrame(callback){frames.push({id:++frameId,callback});return frameId;},cancelAnimationFrame(id){const i=frames.findIndex(frame=>frame.id===id);if(i>=0)frames.splice(i,1);},scrollBy(...args){window.moves.push(args);},moves:[],getComputedStyle:()=>({overflowY:'visible',overflowX:'visible'})};
  const viewport={clientHeight:600,moves:[],scrollBy(...args){this.moves.push(args);}};
  const reader=Object.create(Reader.prototype);
  const root={nodeType:1,scrollHeight:2400,clientHeight:600,scrollWidth:900,clientWidth:900,scrollTop:0,scrollLeft:0,moves:[],scrollBy(...args){this.moves.push(args);}};
  const body={nodeType:1,parentElement:root,scrollHeight:600,clientHeight:600,scrollWidth:900,clientWidth:900};
  Object.assign(reader,{nativeScroll,zoom:1,doc:{body,documentElement:root,scrollingElement:root,defaultView:window},viewport,middleScroll:null,disposed:false});
  return {reader,window,viewport,root,frame(){const next=frames.shift();assert.ok(next,'animation frame was scheduled');next.callback();}};
}

test('wheel over an iframe directly scrolls its actual root in either reader mode',()=>{
  const {reader,viewport,root}=scrollingReader();let prevented=0;
  const event={deltaX:0,deltaY:3,deltaMode:1,target:reader.doc.body,preventDefault(){prevented++;}};
  reader.forwardWheel(event);
  assert.deepEqual(viewport.moves,[[{left:0,top:48,behavior:'instant'}]]);assert.equal(prevented,1);
  reader.nativeScroll=true;reader.forwardWheel(event);
  assert.deepEqual(root.moves,[[{left:0,top:48,behavior:'instant'}]]);assert.equal(prevented,2);
});

test('wheel inside a scrollable document section scrolls that section directly',()=>{
  const {reader,viewport,window}=scrollingReader();
  const section={nodeType:1,parentElement:reader.doc.body,scrollHeight:900,clientHeight:300,scrollTop:50,moves:[],scrollBy(...args){this.moves.push(args);}};
  window.getComputedStyle=()=>({overflowY:'auto',overflowX:'visible'});
  let prevented=false;
  reader.forwardWheel({deltaX:0,deltaY:30,deltaMode:0,target:section,preventDefault(){prevented=true;}});
  assert.equal(prevented,true);assert.deepEqual(section.moves,[[{left:0,top:30,behavior:'instant'}]]);assert.equal(viewport.moves.length,0);
});

test('wheel at an inner panel boundary continues to the native document root',()=>{
  const {reader,root,window}=scrollingReader(true);
  const section={nodeType:1,parentElement:reader.doc.body,scrollHeight:900,clientHeight:300,scrollTop:600,scrollLeft:0,moves:[]};
  window.getComputedStyle=node=>node===section?{overflowY:'auto',overflowX:'visible'}:{overflowY:'visible',overflowX:'visible'};
  let prevented=false;
  reader.forwardWheel({deltaX:0,deltaY:30,deltaMode:0,target:section,preventDefault(){prevented=true;}});
  assert.equal(prevented,true);assert.deepEqual(section.moves,[]);assert.deepEqual(root.moves,[[{left:0,top:30,behavior:'instant'}]]);
});

const touch=(identifier,x,y)=>({identifier,clientX:x,clientY:y});
function touches(reader,points,target=reader.doc.body){
  return {touches:points,target,cancelable:true,prevented:false,preventDefault(){this.prevented=true;},stopPropagation(){}};
}
test('two fingers cancel unfinished ink and scroll the static viewport at the visible zoom',async()=>{
  const {reader:r,viewport}=scrollingReader();let removed=0,released=0,inputs=0;
  Object.assign(r,{tool:'pen',zoom:2,callbacks:{onAnnotationInput(){inputs++;}},preview:{remove(){removed++;}},gesture:{pointerId:1,target:{releasePointerCapture(){released++;}}}});
  const start=touches(r,[touch(10,40,180),touch(20,100,180)]);r.startTouchScroll(start);
  assert.equal(start.prevented,true);assert.equal(r.gesture,null);assert.equal(r.preview,null);assert.equal(removed,1);assert.equal(released,1);
  const move=touches(r,[touch(20,94,150),touch(10,34,150)]);r.moveTouchScroll(move);
  assert.deepEqual(viewport.moves,[[{left:12,top:60,behavior:'instant'}]]);assert.equal(move.prevented,true);
  r.pointerDown({button:0,pointerType:'touch'});r.pointerMove({pointerType:'touch'});await r.pointerUp({pointerType:'touch'});assert.equal(inputs,0);assert.equal(r.gesture,null);
  r.endTouchScroll(touches(r,[touch(10,34,150)]));r.moveTouchScroll(touches(r,[touch(10,34,90)]));assert.equal(viewport.moves.length,1,'one remaining finger cannot make ink or jump the scroll');
  assert.ok(r.touchScroll);r.endTouchScroll(touches(r,[]));assert.equal(r.touchScroll,null);assert.ok(r.suppressAnnotationClick>performance.now());
});
test('two-finger scrolling uses a native inner panel and chains at its end',()=>{
  const {reader:r,root,window}=scrollingReader(true),panel={nodeType:1,parentElement:r.doc.body,scrollHeight:900,clientHeight:300,scrollTop:100,scrollLeft:0,moves:[],scrollBy(...args){this.moves.push(args);}};
  Object.assign(r,{tool:'rect',callbacks:{}});window.getComputedStyle=node=>({overflowY:node===panel?'auto':'visible',overflowX:'visible'});
  r.startTouchScroll(touches(r,[touch(1,30,200),touch(2,80,200)],panel));
  r.moveTouchScroll(touches(r,[touch(1,30,160),touch(2,80,160)],panel));assert.deepEqual(panel.moves,[[{left:0,top:40,behavior:'instant'}]]);
  panel.scrollTop=600;r.moveTouchScroll(touches(r,[touch(1,30,140),touch(2,80,140)],panel));assert.deepEqual(root.moves,[[{left:0,top:20,behavior:'instant'}]]);
});
test('scrolling the outer viewport does not reduce the next touch delta as its iframe moves',()=>{
  const {reader:r,viewport}=scrollingReader();let frameTop=80;
  Object.assign(r,{tool:'pen',zoom:2,callbacks:{},frame:{getBoundingClientRect:()=>({left:0,top:frameTop})}});
  r.startTouchScroll(touches(r,[touch(1,20,100),touch(2,80,100)]));
  r.moveTouchScroll(touches(r,[touch(1,20,90),touch(2,80,90)]));frameTop=60;
  r.moveTouchScroll(touches(r,[touch(1,20,90),touch(2,80,90)]));
  assert.deepEqual(viewport.moves,[[{left:0,top:20,behavior:'instant'}],[{left:0,top:20,behavior:'instant'}]]);
});
test('ordinary native touch selection and pinch retain browser handling',()=>{
  const {reader:r,root}=scrollingReader(true);Object.assign(r,{tool:'select',callbacks:{}});
  const one=touches(r,[touch(1,20,100)]);r.startTouchScroll(one);assert.equal(r.touchScroll,undefined);assert.equal(one.prevented,false);
  const two=touches(r,[touch(1,20,100),touch(2,80,100)]);r.startTouchScroll(two);assert.equal(two.prevented,false);
  const move=touches(r,[touch(1,10,80),touch(2,90,80)]);r.moveTouchScroll(move);assert.equal(move.prevented,false);assert.deepEqual(root.moves,[]);
});
test('touch erasing waits for release so a two-finger gesture cannot erase a saved annotation',async()=>{
  const {reader:r}=scrollingReader(true),removed=[];Object.assign(r,{tool:'eraser',callbacks:{},annotationIdAt:()=> 'saved',remove:id=>removed.push(id)});
  const pointer={button:0,pointerId:1,pointerType:'touch',target:r.doc.body,preventDefault(){}};
  r.pointerDown(pointer);assert.deepEqual(removed,[]);r.startTouchScroll(touches(r,[touch(1,20,100),touch(2,80,100)]));await r.pointerUp(pointer);r.endTouchScroll(touches(r,[]));assert.deepEqual(removed,[]);
  r.pointerDown(pointer);await r.pointerUp(pointer);assert.deepEqual(removed,['saved']);
});
test('fractional trackpad deltas scroll instantly and ctrl-wheel stays with the browser',()=>{
  const {reader:r,root}=scrollingReader(true);let prevented=0;
  const event={target:r.doc.body,deltaMode:0,deltaX:.25,deltaY:1.5,preventDefault(){prevented++;}};
  for(let i=0;i<12;i++)r.forwardWheel(event);
  assert.equal(root.moves.length,12);assert.ok(root.moves.every(([move])=>move.left===.25&&move.top===1.5&&move.behavior==='instant'));
  r.forwardWheel({...event,ctrlKey:true});assert.equal(root.moves.length,12);assert.equal(prevented,12);
});

test('middle button drags a static document and auto-scrolls a native document until toggled off',()=>{
  for(const native of [false,true]){
    const {reader,window,viewport,frame}=scrollingReader(native);
    const target={closest:()=>null,setPointerCapture(){target.captured=true;},releasePointerCapture(){target.released=true;}};let prevented=0;
    const down={button:1,pointerId:1,clientX:20,clientY:20,target,preventDefault(){prevented++;}};
    assert.equal(reader.startMiddleScroll(down),true);
    reader.moveMiddleScroll({pointerId:1,clientX:20,clientY:60});
    frame();
    assert.ok(native?window.moves[0][1]>0:viewport.moves[0][1]>0);
    assert.equal(reader.endMiddleScroll({button:1,pointerId:1,preventDefault(){prevented++;}}),true);
    assert.equal(reader.middleScroll,null);
    assert.equal(target.captured,true);assert.equal(target.released,true);
    reader.startMiddleScroll(down);
    reader.endMiddleScroll({button:1,pointerId:1,preventDefault(){}});
    assert.ok(reader.middleScroll,'plain click stays active');
    reader.startMiddleScroll(down);
    assert.equal(reader.middleScroll,null,'second middle click stops auto-scroll');
    assert.equal(prevented,4);
    assert.equal(reader.startMiddleScroll({...down,target:{closest:()=>({})}}),false,'links keep their middle-click behavior');
  }
});
