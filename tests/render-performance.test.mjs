import test from 'node:test';
import assert from 'node:assert/strict';
import {installDOM,documentFor} from './dom.mjs';
import {textIndex,wrapOffsets,prepareLoadedHTML,parseHTML} from '../public/src/document.js';
import {Reader} from '../public/src/reader.js';
installDOM();
test('shared text index preserves overlapping and crossing annotations without rescanning the book',()=>{
 const doc=documentFor('<html><head></head><body><p>abcdefghij<b>klmnopqrst</b>uvwxyz</p></body></html>');
 const index=textIndex(doc);let walks=0;const original=doc.createTreeWalker.bind(doc);doc.createTreeWalker=(...args)=>{walks++;return original(...args);};
 for(const [start,end,id] of [[2,15,'one'],[0,8,'two'],[5,22,'three'],[19,26,'four']])wrapOffsets(doc,start,end,{'data-test':id},'',index);
 assert.equal(walks,0);assert.equal(doc.body.textContent,'abcdefghijklmnopqrstuvwxyz');
 for(const [id,expected] of [['one','cdefghijklmno'],['two','abcdefgh'],['three','fghijklmnopqrstuv'],['four','tuvwxyz']])assert.equal([...doc.querySelectorAll(`[data-test="${id}"]`)].map(n=>n.textContent).join(''),expected);
 assert.equal(index.nodes.map(n=>n.node.textContent).join(''),index.text);
});
test('restoring many highlights builds the complete text index only once',()=>{
 const doc=documentFor('<html><head></head><body>'+Array.from({length:5000},()=>'<p>abcdefghij</p>').join('')+'</body></html>');
 let walks=0;const original=doc.createTreeWalker.bind(doc);doc.createTreeWalker=(...args)=>{walks++;return original(...args);};
 const reader=Object.create(Reader.prototype);reader.doc=doc;reader.metadata={annotations:Array.from({length:200},(_,i)=>({id:'a'+i,type:'highlight',color:'#ffcc00',opacity:.4,textAnchor:{start:i*20,end:i*20+5,quote:'abcde'}}))};reader.renderDrawingLayer=()=>{};reader.observeDynamicDocument=()=>{};
 reader.render();assert.equal(walks,1);assert.equal(doc.querySelectorAll('[data-htmlmemo-mark]').length,200);assert.equal(doc.body.textContent.length,50000);
});

test('large native preparation can retain the source Blob without serializing the expanded DOM',async()=>{
 const doc=documentFor('<html><head><title>Expanded source</title></head><body><p>Expanded book text</p></body></html>');
 Object.defineProperty(doc.documentElement,'outerHTML',{get(){throw Error('Expanded HTML serialization is forbidden');}});
 const prepared=await prepareLoadedHTML(doc,{},()=>false,{serialize:false});
 assert.equal(prepared.html,null);assert.equal(prepared.metadata.title,'Expanded source');assert.ok(doc.querySelector('p').hasAttribute('data-htmlmemo-anchor'));
});
test('drawing annotations on generated content keep valid stable anchors after export',()=>{
 const annotations=[{id:'dynamic-note',type:'note',anchor:'js12',points:[{x:.2,y:.3}],color:'#ffcc00',width:3,opacity:1,text:'Dynamic note'}];
 // Reimport applies the same validation as any other HTML file.
 const html=`<html><head><script type="application/json" id="htmlmemo-data">${JSON.stringify({version:1,annotations})}</script></head><body>Generated</body></html>`;
 assert.deepEqual(parseHTML(html).metadata.annotations,annotations);
});
