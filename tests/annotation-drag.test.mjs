import test from 'node:test';
import assert from 'node:assert/strict';
import {Reader} from '../public/src/reader.js';
import {History,validateAnnotations} from '../public/src/model.js';
import {textIndex,parseHTML,serializeHTML} from '../public/src/document.js';
import {documentFor,installDOM} from './dom.mjs';
installDOM();

function fixture(type='rect',extra={}){
  const doc=documentFor('<html><head></head><body data-htmlmemo-anchor="body"><p id="from" data-htmlmemo-anchor="n1">Original marked words.</p><p id="to" data-htmlmemo-anchor="n2">Destination words for moving.</p></body></html>'),r=Object.create(Reader.prototype);
  const from=doc.getElementById('from'),to=doc.getElementById('to');
  const rect=(left,top,width,height)=>({left,top,width,height,right:left+width,bottom:top+height});
  doc.body.getBoundingClientRect=()=>rect(0,0,1000,800);from.getBoundingClientRect=()=>rect(50,100,800,100);to.getBoundingClientRect=()=>rect(50,300,800,100);
  for(const node of [doc.body,from,to])node.getClientRects=()=>[node.getBoundingClientRect()];
  Object.defineProperty(doc,'defaultView',{value:{getComputedStyle:node=>({fontSize:node.style.fontSize||'20px',position:'static'}),scrollX:0,scrollY:0},configurable:true});
  let captured=false,caret=null,hit=to,changes=0,inputs=0;
  doc.documentElement.setPointerCapture=()=>{captured=true;};doc.documentElement.hasPointerCapture=()=>captured;doc.documentElement.releasePointerCapture=()=>{captured=false;};
  doc.elementFromPoint=()=>hit;doc.elementsFromPoint=()=>[hit,doc.body];doc.caretPositionFromPoint=()=>caret;
  doc.getSelection=()=>({rangeCount:0,isCollapsed:true,removeAllRanges(){}});
  doc.createRange=()=>({setStart(node,offset){this.startContainer=node;this.startOffset=offset;},setEnd(node,offset){this.endContainer=node;this.endOffset=offset;},getClientRects(){return [rect(50+this.startOffset*10,300,Math.max(1,(this.endOffset-this.startOffset)*10),20)];},getBoundingClientRect(){return this.getClientRects()[0];}});
  let annotation={id:'moving',type,color:'#334155',width:3,opacity:1,created:1234,points:[{x:80,y:40},{x:180,y:80}],...extra};
  if(['highlight','underline','strike'].includes(type)){const index=textIndex(doc);delete annotation.points;annotation.textAnchor={start:0,end:8,quote:index.text.slice(0,8)};}
  if(['note','text'].includes(type))annotation.text='Saved memo';
  Object.assign(r,{doc,metadata:{version:1,annotations:[annotation],view:{},bookmarks:[]},history:new History([annotation]),tool:'select',zoom:1,naturalWidth:1000,naturalHeight:800,callbacks:{onChange(){changes++;},onAnnotationInput(){inputs++;}},findAnnotationScrollHost:()=>null});
  r.render();
  return {r,doc,from,to,set hit(value){hit=value;},set caret(value){caret=value;},get changes(){return changes;},get inputs(){return inputs;},get captured(){return captured;},event(x=80,y=40,options={}){return {button:0,pointerId:1,clientX:x,clientY:y,target:doc.querySelector('[data-htmlmemo-id=moving]'),preventDefault(){},stopPropagation(){},...options};}};
}
test('all drawing and memo annotations move as one saved edit with their appearance and ID intact',async()=>{
  for(const type of ['pen','area-underline','arrow','rect','ellipse','circle','area','note','text']){
    const f=fixture(type,{fill:undefined}),{r,doc}=f,original=structuredClone(r.metadata.annotations),geometry=r.drawingGeometry(r.metadata.annotations[0]);
    r.pointerDown(f.event());r.pointerMove(f.event(120,65));assert.deepEqual(r.metadata.annotations,original);assert.equal(f.changes,0);assert.equal(f.captured,true);assert.ok(doc.querySelector('[data-htmlmemo-preview]'));assert.equal(r.preview.getAttribute('transform'),'translate(40 25)');
    await r.pointerUp(f.event(120,65));const moved=r.metadata.annotations[0];assert.equal(f.changes,1);assert.equal(r.history.entries.length,2);assert.equal(moved.id,original[0].id);assert.equal(moved.created,1234);assert.equal(moved.width,3);assert.equal(moved.anchor,'n2');assert.equal(moved.anchorTarget.id,'to');assert.deepEqual(r.drawingGeometry(moved).points,geometry.points.map(p=>({x:p.x+40,y:p.y+25})));assert.equal(moved.text,original[0].text);validateAnnotations([moved]);assert.equal(doc.querySelector('[data-htmlmemo-preview],[data-htmlmemo-drag-source]'),null);assert.equal(doc.documentElement.hasAttribute('data-htmlmemo-moving'),false);assert.equal(f.captured,false);
    r.undo();assert.deepEqual(r.metadata.annotations,original);r.redo();assert.deepEqual(r.metadata.annotations,[moved]);
  }
});
test('drag threshold uses screen pixels across zoom levels and a short click creates no edit',async()=>{
  for(const zoom of [.5,1,2]){
    const f=fixture(),{r}=f;r.zoom=zoom;const before=structuredClone(r.metadata.annotations);
    r.pointerDown(f.event());r.pointerMove(f.event(80+3/zoom,40));assert.equal(r.annotationDrag.moved,false);assert.equal(f.captured,false);await r.pointerUp(f.event(80+3/zoom,40));assert.deepEqual(r.metadata.annotations,before);assert.equal(f.changes,0);
    r.pointerDown(f.event());r.pointerMove(f.event(80+5/zoom,40));assert.equal(r.annotationDrag.moved,true);await r.pointerUp(f.event(80+5/zoom,40));assert.equal(f.changes,1);assert.ok(r.suppressAnnotationClick>performance.now());
  }
});
test('cancel, tool changes, redraws, extra pointers and returning to the start preserve the original annotation',async()=>{
  for(const action of ['cancel','tool','render','pointer','return','outside']){
    const f=fixture(),{r,doc}=f,before=structuredClone(r.metadata.annotations);r.pointerDown(f.event());r.pointerMove(f.event(120,70));
    if(action==='cancel')r.cancelAnnotationDrag();if(action==='tool')r.setTool('pen');if(action==='render')r.renderDrawingLayer();if(action==='pointer')r.pointerDown(f.event(130,80,{pointerId:2}));if(action==='return')await r.pointerUp(f.event());if(action==='outside'){f.hit=null;await r.pointerUp(f.event(120,70));}
    assert.deepEqual(r.metadata.annotations,before);assert.equal(f.changes,0);assert.equal(r.history.entries.length,1);assert.equal(r.annotationDrag,null);assert.equal(doc.querySelector('[data-htmlmemo-preview],[data-htmlmemo-drag-source]'),null);assert.equal(f.captured,false);
  }
});
test('rebasing a scaled pen keeps its rendered path and thickness and uses the new paragraph font',async()=>{
  const f=fixture('pen',{anchor:'n1',points:[{x:.1,y:.2},{x:.2,y:.3}],penBasis:{width:800,height:100,fontSize:20}}),{r,from,to}=f;
  r.capturePenTextAnchor=()=>null;from.style.fontSize='40px';r.renderDrawingLayer();const before=r.drawingGeometry(r.metadata.annotations[0]);assert.equal(before.scale,2);
  r.pointerDown(f.event());r.pointerMove(f.event(120,65));await r.pointerUp(f.event(120,65));const a=r.metadata.annotations[0],after=r.drawingGeometry(a);assert.equal(a.width,3);assert.equal(after.scale,2);assert.deepEqual(after.points,before.points.map(p=>({x:p.x+40,y:p.y+25})));assert.equal(r.doc.querySelector('[data-htmlmemo-id]').getAttribute('stroke-width'),'6');
  to.style.fontSize='30px';r.renderDrawingLayer();assert.equal(r.doc.querySelector('[data-htmlmemo-id]').getAttribute('stroke-width'),'9');validateAnnotations([a]);
});
test('text marks move to the dropped text while preserving content, type, ID and one-step undo',async()=>{
  for(const type of ['highlight','underline','strike']){
    const f=fixture(type),{r,doc,to}=f,original=structuredClone(r.metadata.annotations),body=[f.from.textContent,to.textContent],mark=doc.querySelector('[data-htmlmemo-id]');
    f.caret={offsetNode:mark.firstChild,offset:0};r.pointerDown(f.event());f.caret={offsetNode:to.firstChild,offset:2};r.pointerMove(f.event(120,320));assert.deepEqual(r.metadata.annotations,original);assert.ok(doc.querySelector('[data-htmlmemo-preview]'));
    await r.pointerUp(f.event(120,320));const moved=r.metadata.annotations[0];assert.equal(moved.textAnchor.quote,'stinatio');assert.equal(moved.id,original[0].id);assert.equal(moved.type,type);assert.equal(f.changes,1);assert.deepEqual([f.from.textContent,to.textContent],body);assert.equal(doc.querySelector('[data-htmlmemo-mark]').textContent,'stinatio');validateAnnotations([moved]);r.undo();assert.deepEqual(r.metadata.annotations,original);
  }
});
test('unavailable text targets and a changed index never commit a stale text move',async()=>{
  for(const action of ['empty','changed','same']){
    const f=fixture('highlight'),{r,doc,to}=f,original=structuredClone(r.metadata.annotations),mark=doc.querySelector('[data-htmlmemo-id]');f.caret={offsetNode:mark.firstChild,offset:0};r.pointerDown(f.event());f.caret=action==='same'?{offsetNode:mark.firstChild,offset:0}:action==='empty'?null:{offsetNode:to.firstChild,offset:0};r.pointerMove(f.event(120,320));if(action==='changed')r.searchCache().invalidate();await r.pointerUp(f.event(120,320));assert.deepEqual(r.metadata.annotations,original);assert.equal(f.changes,0);
  }
});
test('HTML export during a preview strips drag artifacts and retains the last saved metadata',()=>{
  const f=fixture('rect',{fill:true,fillOpacity:.45}),{r,doc}=f,original=structuredClone(r.metadata.annotations);r.pointerDown(f.event());r.pointerMove(f.event(120,70));const html=serializeHTML(doc,r.metadata),parsed=parseHTML(html);assert.deepEqual(parsed.metadata.annotations,original);assert.doesNotMatch(html,/data-htmlmemo-(?:moving|drag-source|preview|hit|picking)/);assert.equal(parsed.metadata.annotations[0].fillOpacity,.45);r.cancelAnnotationDrag();
});
test('changing book sections cancels an in-progress move instead of saving it into another chapter',()=>{
  const f=fixture(),{r,doc,from,to}=f,section=doc.createElement('main');section.id='reader-content';section.dataset.section='v0:one';section.append(from,to);doc.body.append(section);r.render();const before=structuredClone(r.metadata.annotations);
  r.pointerDown(f.event());r.pointerMove(f.event(120,70));section.dataset.section='v0:two';r.pointerMove(f.event(140,90));assert.equal(r.annotationDrag,null);assert.equal(f.changes,0);assert.deepEqual(r.metadata.annotations,before);assert.equal(doc.querySelector('[data-htmlmemo-preview],[data-htmlmemo-drag-source]'),null);
});
test('touch implicit capture can transfer from a mark to the root; losing root capture still cancels',()=>{
  const f=fixture(),{r,doc}=f;r.viewport=doc.createElement('div');r.setupDocumentTocResize=()=>{};r.startFontObserver=()=>{};r.bind({deferDynamicObserver:true});const before=structuredClone(r.metadata.annotations),mark=doc.querySelector('[data-htmlmemo-id]');
  r.pointerDown(f.event());r.pointerMove(f.event(120,70));const drag=r.annotationDrag;
  const lost=target=>{const event=doc.createEvent('Event');event.initEvent('lostpointercapture',true,false);Object.defineProperty(event,'pointerId',{value:1});target.dispatchEvent(event);};
  lost(mark);assert.strictEqual(r.annotationDrag,drag);assert.equal(f.captured,true);assert.ok(doc.querySelector('[data-htmlmemo-preview]'));
  lost(doc.documentElement);assert.equal(r.annotationDrag,null);assert.equal(f.captured,false);assert.deepEqual(r.metadata.annotations,before);assert.equal(f.changes,0);
});
test('a touch release saves the last visible preview even when its release coordinates differ',async()=>{
  const f=fixture(),{r}=f,before=r.drawingGeometry(r.metadata.annotations[0]);r.pointerDown(f.event(80,40,{pointerType:'touch'}));r.pointerMove(f.event(120,70,{pointerType:'touch'}));await r.pointerUp(f.event(0,0,{pointerType:'touch'}));assert.equal(f.changes,1);for(const [i,p] of r.drawingGeometry(r.metadata.annotations[0]).points.entries()){assert.ok(Math.abs(p.x-before.points[i].x-40)<1e-8);assert.ok(Math.abs(p.y-before.points[i].y-30)<1e-8);}
});
