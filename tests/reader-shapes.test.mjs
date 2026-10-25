import test from 'node:test';
import assert from 'node:assert/strict';
import {Reader} from '../public/src/reader.js';
import {validateAnnotations,History,DRAW_TOOLS,ANNOTATION_LABELS} from '../public/src/model.js';
import {parseHTML,serializeHTML} from '../public/src/document.js';
import {documentFor,installDOM} from './dom.mjs';
installDOM();
const points=[{x:30,y:40},{x:150,y:100}];
const shapes=['rect','circle','ellipse'];
function reader(){const r=Object.create(Reader.prototype);Object.assign(r,{doc:documentFor('<html><head></head><body>Original text</body></html>'),color:'#edcf67',width:3,opacity:.45,rectFill:false});return r;}
const draw=(r,a,preview=false)=>r.drawAnnotation({...a,points},preview,{points,scale:1});
test('rectangles, circles and ellipses snapshot the shared rectangle fill mode and highlight opacity',()=>{
 const r=reader();r.rectFill=true;const filled=shapes.map(type=>r.annotation(type,{points,anchor:'body'})),highlight=r.annotation('highlight',{textAnchor:{start:0,end:8,quote:'Original'}});
 for(const [index,a] of filled.entries()){assert.equal(a.type,shapes[index]);assert.equal(a.fill,true);assert.equal(a.fillOpacity,highlight.opacity);assert.equal(a.opacity,1);}
 r.opacity=.8;for(const type of shapes)assert.equal(r.annotation(type,{points}).fillOpacity,.8);
 r.rectFill=false;for(const type of shapes){const a=r.annotation(type,{points});assert.equal(a.fill,false);assert.equal(Object.hasOwn(a,'fillOpacity'),false);}
 for(const a of filled){assert.equal(a.fill,true);assert.equal(a.fillOpacity,.45);}
 for(const type of ['pen','arrow','area','area-underline']){r.rectFill=true;const a=r.annotation(type,{points});assert.equal(Object.hasOwn(a,'fill'),false);assert.equal(Object.hasOwn(a,'fillOpacity'),false);}
});
test('new outline and legacy rectangles, circles and ellipses keep their original unfilled stroke attributes',()=>{
 const r=reader();for(const type of shapes){const outline=r.annotation(type,{points}),legacy={...outline};delete legacy.fill;
 assert.equal(outline.fill,false);assert.equal(Object.hasOwn(outline,'fillOpacity'),false);
 r.rectFill=true;for(const annotation of [outline,legacy]){const node=draw(r,annotation);assert.equal(node.localName,type);assert.equal(node.getAttribute('fill'),'none');assert.equal(node.getAttribute('stroke'),r.color);assert.equal(node.getAttribute('opacity'),'1');assert.equal(node.hasAttribute('fill-opacity'),false);}r.rectFill=false;}
});
test('all three filled shapes share a translucent fill and solid border in previews and saved rendering',()=>{
 const r=reader();r.rectFill=true;for(const type of shapes){const a=r.annotation(type,{points,anchor:'body'});r.rectFill=false;r.opacity=.8;
 for(const preview of [true,false]){const node=draw(r,a,preview);assert.equal(node.localName,type);assert.equal(node.getAttribute('fill'),r.color);assert.equal(node.getAttribute('fill-opacity'),'0.45');assert.equal(node.getAttribute('stroke'),r.color);assert.equal(node.getAttribute('stroke-width'),'3');assert.equal(node.getAttribute('opacity'),'1');if(type==='rect'){assert.equal(node.getAttribute('width'),'120');assert.equal(node.getAttribute('height'),'60');}if(type==='circle')assert.equal(node.getAttribute('r'),'30');if(type==='ellipse'){assert.equal(node.getAttribute('rx'),'60');assert.equal(node.getAttribute('ry'),'30');}}
 r.rectFill=true;r.opacity=.45;}
});
test('circle geometry stays round for non-square and reversed drags without changing ellipses',()=>{
 const r=reader(),circle=r.annotation('circle',{points,anchor:'body'});assert.ok(DRAW_TOOLS.includes('circle'));assert.equal(ANNOTATION_LABELS.circle,'원');assert.equal(validateAnnotations([circle])[0].type,'circle');
 for(const pair of [points,[...points].reverse()]){const node=r.drawAnnotation({...circle,points:pair},true);assert.equal(node.localName,'circle');assert.equal(node.getAttribute('cx'),'90');assert.equal(node.getAttribute('cy'),'70');assert.equal(node.getAttribute('r'),'30');assert.equal(node.getAttribute('fill'),'none');}
 const ellipse=draw(r,r.annotation('ellipse',{points}));assert.equal(ellipse.getAttribute('rx'),'60');assert.equal(ellipse.getAttribute('ry'),'30');
});
test('all filled and legacy shapes survive validation, undo redo and annotated HTML export/reimport',()=>{
 const r=reader();r.rectFill=true;const annotations=shapes.flatMap(type=>{const filled=r.annotation(type,{points,anchor:'body'}),legacy=r.annotation(type,{points,anchor:'body'});delete legacy.fill;delete legacy.fillOpacity;return[filled,legacy];});assert.deepEqual(validateAnnotations(annotations),annotations);
 const history=new History();history.commit(annotations);assert.deepEqual(history.undo(),[]);assert.deepEqual(history.redo(),annotations);
 const parsed=parseHTML('<html><head><title>Shape export</title></head><body>Original text</body></html>');parsed.metadata.annotations=annotations;const html=serializeHTML(documentFor(parsed.html),parsed.metadata),reopened=parseHTML(html);assert.deepEqual(reopened.metadata.annotations,annotations);assert.equal(documentFor(reopened.html).body.textContent,'Original text');
});
test('malformed fill flags and opacity are rejected without losing legacy annotation support',()=>{
 const r=reader();for(const type of shapes){const base=r.annotation(type,{points,anchor:'body'});
 for(const patch of [{fill:'red'},{fill:1},{fill:{}},{fill:true},{fill:true,fillOpacity:NaN},{fill:true,fillOpacity:Infinity},{fill:true,fillOpacity:-.1},{fill:true,fillOpacity:1.1},{fill:false,fillOpacity:.4}])assert.throws(()=>validateAnnotations([{...base,...patch}]),/채움/);
 for(const fillOpacity of [0,.1,.45,.9,1])assert.equal(validateAnnotations([{...base,fill:true,fillOpacity}])[0].fillOpacity,fillOpacity);delete base.fill;assert.deepEqual(validateAnnotations([base]),[base]);}
 for(const type of ['pen','arrow','area','area-underline'])for(const fill of [false,true])assert.throws(()=>validateAnnotations([{...r.annotation(type,{points}),fill,fillOpacity:.4}]),/채움/);
});
