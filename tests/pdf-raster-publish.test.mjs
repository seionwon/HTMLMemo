import test from 'node:test';
import assert from 'node:assert/strict';
import {PdfPageImage} from '../public/src/pdf/page-rendering.js';
import {documentFor} from './dom.mjs';

test('PDF keeps its loaded raster until its replacement loads and revokes stale or disposed images',async()=>{
  const doc=documentFor('<html><body><section></section></body></html>'),element=doc.querySelector('section'),images=[],create=doc.createElement.bind(doc);
  doc.createElement=name=>{const node=create(name);if(name==='img')images.push(node);return node;};
  const canvas=text=>{const node=create('canvas');node.width=20;node.height=30;node.toBlob=done=>done(new Blob([text],{type:'image/png'}));return node;};
  const raster=new PdfPageImage(element);
  raster.publish(canvas('preview'),20,30);const first=images[0];
  assert.equal(element.querySelectorAll('[data-pdf-raster]').length,0,'an undecoded image is not published');first.onload();assert.ok(element.querySelector('[data-pdf-raster]')===first);
  raster.publish(canvas('detail'),20,30);const second=images[1];
  assert.ok(element.querySelector('[data-pdf-raster]')===first,'the loaded preview remains while detail loads');second.onload();assert.ok(element.querySelector('[data-pdf-raster]')===second);assert.equal(first.isConnected,false);await assert.rejects(fetch(first.src));
  raster.publish(canvas('stale'),20,30);const stale=images[2];raster.publish(canvas('pending'),20,30);const pending=images[3];stale.onload();assert.equal(stale.isConnected,false);await assert.rejects(fetch(stale.src));assert.ok(element.querySelector('[data-pdf-raster]')===second);
  raster.dispose();pending.onload();assert.equal(element.querySelectorAll('[data-pdf-raster]').length,0);await assert.rejects(fetch(second.src));await assert.rejects(fetch(pending.src));
});
