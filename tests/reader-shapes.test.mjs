import test from 'node:test';
import assert from 'node:assert/strict';
import {Reader} from '../public/src/reader.js';
import {validateAnnotations,History,DRAW_TOOLS,ANNOTATION_LABELS} from '../public/src/model.js';
import {parseHTML,serializeHTML} from '../public/src/document.js';
import {documentFor,installDOM} from './dom.mjs';
installDOM();
const points=[{x:30,y:40},{x:150,y:100}];
function reader(){const r=Object.create(Reader.prototype);Object.assign(r,{doc:documentFor('<html><head></head><body>Original text</body></html>'),color:'#edcf67',width:3,opacity:.45,rectFill:false});return r;}
const draw=(r,a,preview=false)=>r.drawAnnotation({...a,points},preview,{points,scale:1});
test('rectangles snapshot the same opacity as highlighting but keep stroke opacity opaque',()=>{
 const r=reader();r.rectFill=true;const rect=r.annotation('rect',{points,anchor:'body'}),highlight=r.annotation('highlight',{textAnchor:{start:0,end:8,quote:'Original'}});
 assert.equal(rect.type,'rect');assert.equal(rect.fill,true);assert.equal(rect.fillOpacity,highlight.opacity);assert.equal(rect.opacity,1);r.opacity=.8;assert.equal(rect.fillOpacity,.45);assert.equal(r.annotation('rect',{points}).fillOpacity,.8);
});
test('new outline and legacy rectangles remain unfilled with their original stroke attributes',()=>{
 const r=reader(),outline=r.annotation('rect',{points}),legacy={...outline};delete legacy.fill;
 assert.equal(outline.fill,false);assert.equal(Object.hasOwn(outline,'fillOpacity'),false);
 for(const annotation of [outline,legacy]){const node=draw(r,annotation);assert.equal(node.localName,'rect');assert.equal(node.getAttribute('fill'),'none');assert.equal(node.getAttribute('stroke'),r.color);assert.equal(node.getAttribute('opacity'),'1');assert.equal(node.hasAttribute('fill-opacity'),false);}
});
test('filled rectangle preview and saved rendering share an independent translucent fill and solid border',()=>{
 const r=reader();r.rectFill=true;const a=r.annotation('rect',{points,anchor:'body'});
 for(const preview of [true,false]){const node=draw(r,a,preview);assert.equal(node.getAttribute('fill'),r.color);assert.equal(node.getAttribute('fill-opacity'),'0.45');assert.equal(node.getAttribute('stroke'),r.color);assert.equal(node.getAttribute('stroke-width'),'3');assert.equal(node.getAttribute('opacity'),'1');assert.equal(node.getAttribute('width'),'120');assert.equal(node.getAttribute('height'),'60');}
});
test('circle geometry stays round for non-square and reversed drags without changing ellipses',()=>{
 const r=reader(),circle=r.annotation('circle',{points,anchor:'body'});assert.ok(DRAW_TOOLS.includes('circle'));assert.equal(ANNOTATION_LABELS.circle,'원');assert.equal(validateAnnotations([circle])[0].type,'circle');
 for(const pair of [points,[...points].reverse()]){const node=r.drawAnnotation({...circle,points:pair},true);assert.equal(node.localName,'circle');assert.equal(node.getAttribute('cx'),'90');assert.equal(node.getAttribute('cy'),'70');assert.equal(node.getAttribute('r'),'30');assert.equal(node.getAttribute('fill'),'none');}
 const ellipse=draw(r,r.annotation('ellipse',{points}));assert.equal(ellipse.getAttribute('rx'),'60');assert.equal(ellipse.getAttribute('ry'),'30');
});
test('filled rectangle metadata survives validation, undo redo and annotated HTML export/reimport',()=>{
 const r=reader();r.rectFill=true;const filled=r.annotation('rect',{points,anchor:'body'}),circle=r.annotation('circle',{points,anchor:'body'}),annotations=[filled,circle];assert.deepEqual(validateAnnotations(annotations),annotations);
 const history=new History();history.commit(annotations);assert.deepEqual(history.undo(),[]);assert.deepEqual(history.redo(),annotations);
 const parsed=parseHTML('<html><head><title>Shape export</title></head><body>Original text</body></html>');parsed.metadata.annotations=annotations;const html=serializeHTML(documentFor(parsed.html),parsed.metadata),reopened=parseHTML(html);assert.deepEqual(reopened.metadata.annotations,annotations);assert.equal(documentFor(reopened.html).body.textContent,'Original text');
});
test('malformed fill flags and opacity are rejected without losing legacy annotation support',()=>{
 const r=reader(),base=r.annotation('rect',{points,anchor:'body'});
 for(const patch of [{fill:'red'},{fill:1},{fill:{}},{fill:true},{fill:true,fillOpacity:NaN},{fill:true,fillOpacity:Infinity},{fill:true,fillOpacity:-.1},{fill:true,fillOpacity:1.1},{fill:false,fillOpacity:.4},{type:'circle',fill:true,fillOpacity:.4}])assert.throws(()=>validateAnnotations([{...base,...patch}]),/채움/);
 for(const fillOpacity of [0,.1,.45,.9,1])assert.equal(validateAnnotations([{...base,fill:true,fillOpacity}])[0].fillOpacity,fillOpacity);delete base.fill;assert.deepEqual(validateAnnotations([base]),[base]);
});
