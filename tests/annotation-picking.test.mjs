import test from 'node:test';
import assert from 'node:assert/strict';
import {Reader} from '../public/src/reader.js';
import {serializeHTML,parseHTML} from '../public/src/document.js';
import {documentFor,installDOM} from './dom.mjs';
installDOM();
function reader(){
  const r=Object.create(Reader.prototype);Object.assign(r,{doc:documentFor('<html><head></head><body><p>Article</p></body></html>'),naturalWidth:1100,naturalHeight:800,zoom:1,tool:'select',callbacks:{},metadata:{version:1,annotations:[{id:'thin',type:'pen',width:.1,color:'#334155',opacity:1,points:[{x:30,y:60},{x:300,y:60}]}],view:{},bookmarks:[]}});return r;
}
test('thin strokes gain separate hit areas without changing their visible width or adding annotation records',()=>{
  const r=reader(),before=structuredClone(r.metadata);r.renderDrawingLayer();const line=r.layer.querySelector('[data-htmlmemo-id=thin]'),hit=r.layer.querySelector('[data-htmlmemo-hit=thin]');
  assert.equal(line.getAttribute('stroke-width'),'0.1');assert.equal(hit.getAttribute('d'),line.getAttribute('d'));assert.equal(hit.getAttribute('stroke'),'transparent');assert.equal(hit.getAttribute('data-htmlmemo-id'),null);assert.equal(r.annotationIdAt(hit),'thin');assert.deepEqual(r.metadata,before);
  r.renderDrawingLayer();assert.strictEqual(r.layer.querySelector('[data-htmlmemo-id=thin]'),line);assert.strictEqual(r.layer.querySelector('[data-htmlmemo-hit=thin]'),hit);
});
test('zoom and tool changes keep a six-screen-pixel margin and only enable hit areas when selecting or erasing',()=>{
  const r=reader();r.renderDrawingLayer();const line=r.layer.querySelector('[data-htmlmemo-id]');
  for(const [zoom,padding] of [[.5,'24px'],[1,'12px'],[2,'6px']]){r.zoom=zoom;r.syncAnnotationPicking();assert.equal(r.layer.style.getPropertyValue('--htmlmemo-hit-padding'),padding);assert.equal(line.getAttribute('stroke-width'),'0.1');}
  for(const tool of ['select','eraser','pen','underline','rect']){r.setTool(tool);assert.equal(r.doc.documentElement.hasAttribute('data-htmlmemo-picking'),['select','eraser'].includes(tool));}
  const fake=r.doc.createElement('span');fake.dataset.htmlmemoHit='missing';assert.equal(r.annotationIdAt(fake),null);
});
test('export preserves real drawings and notes while discarding editor hit areas and picking state',()=>{
  const r=reader();r.renderDrawingLayer();const output=serializeHTML(r.doc,r.metadata),doc=documentFor(output);
  assert.equal(doc.querySelector('[data-htmlmemo-hit]'),null);assert.equal(doc.documentElement.hasAttribute('data-htmlmemo-picking'),false);assert.doesNotMatch(output,/--htmlmemo-hit-padding/);assert.equal(doc.querySelector('[data-htmlmemo-id=thin]').getAttribute('stroke-width'),'0.1');assert.deepEqual(parseHTML(output).metadata.annotations,r.metadata.annotations);
});
