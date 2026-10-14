import test from 'node:test';
import assert from 'node:assert/strict';
import {Reader} from '../public/src/reader.js';

function scrollingReader(nativeScroll=false) {
  const frames=[];let frameId=0;
  const window={requestAnimationFrame(callback){frames.push({id:++frameId,callback});return frameId;},cancelAnimationFrame(id){const i=frames.findIndex(frame=>frame.id===id);if(i>=0)frames.splice(i,1);},scrollBy(...args){window.moves.push(args);},moves:[],getComputedStyle:()=>({overflowY:'visible',overflowX:'visible'})};
  const viewport={clientHeight:600,moves:[],scrollBy(...args){this.moves.push(args);}};
  const reader=Object.create(Reader.prototype);
  Object.assign(reader,{nativeScroll,zoom:1,doc:{body:{},defaultView:window},viewport,middleScroll:null,disposed:false});
  return {reader,window,viewport,frame(){const next=frames.shift();assert.ok(next,'animation frame was scheduled');next.callback();}};
}

test('wheel over a static iframe scrolls its outer pane, while native documents keep browser scrolling',()=>{
  const {reader,viewport}=scrollingReader();let prevented=0;
  const event={deltaX:0,deltaY:3,deltaMode:1,target:reader.doc.body,preventDefault(){prevented++;}};
  reader.forwardWheel(event);
  assert.deepEqual(viewport.moves,[[{left:0,top:48}]]);assert.equal(prevented,1);
  reader.nativeScroll=true;reader.forwardWheel(event);
  assert.equal(prevented,1);
});

test('wheel inside a scrollable document section keeps scrolling that section',()=>{
  const {reader,viewport,window}=scrollingReader();
  const section={nodeType:1,parentElement:reader.doc.body,scrollHeight:900,clientHeight:300,scrollTop:50};
  window.getComputedStyle=()=>({overflowY:'auto',overflowX:'visible'});
  let prevented=false;
  reader.forwardWheel({deltaX:0,deltaY:30,deltaMode:0,target:section,preventDefault(){prevented=true;}});
  assert.equal(prevented,false);assert.equal(viewport.moves.length,0);
});

test('middle button drags a static document and auto-scrolls a native document until toggled off',()=>{
  for(const native of [false,true]){
    const {reader,window,viewport,frame}=scrollingReader(native);
    const target={closest:()=>null};let prevented=0;
    const down={button:1,pointerId:1,clientX:20,clientY:20,target,preventDefault(){prevented++;}};
    assert.equal(reader.startMiddleScroll(down),true);
    reader.moveMiddleScroll({pointerId:1,clientX:20,clientY:60});
    frame();
    assert.ok(native?window.moves[0][1]>0:viewport.moves[0][1]>0);
    assert.equal(reader.endMiddleScroll({button:1,pointerId:1,preventDefault(){prevented++;}}),true);
    assert.equal(reader.middleScroll,null);
    reader.startMiddleScroll(down);
    reader.endMiddleScroll({button:1,pointerId:1,preventDefault(){}});
    assert.ok(reader.middleScroll,'plain click stays active');
    reader.startMiddleScroll(down);
    assert.equal(reader.middleScroll,null,'second middle click stops auto-scroll');
    assert.equal(prevented,4);
    assert.equal(reader.startMiddleScroll({...down,target:{closest:()=>({})}}),false,'links keep their middle-click behavior');
  }
});
