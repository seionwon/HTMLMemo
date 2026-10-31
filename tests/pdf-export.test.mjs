import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PDFDocument,PDFName,PDFArray,PDFDict,PDFHexString,PDFNumber} from 'pdf-lib';
import {writeAnnotatedPDF} from '../packages/pdf-export/entry.js';
const N=PDFName.of;
const source=await readFile(new URL('fixtures/unified-reader.pdf',import.meta.url));
const plan=()=>({annotations:[{id:'highlight',type:'highlight',page:1,color:'#f5db6f',opacity:.35,width:1,contents:'highlight',quad:[72,700,170,700,72,686,170,686]},{id:'underline',type:'underline',page:1,color:'#ee3344',opacity:1,width:1,quad:[72,675,170,675,72,661,170,661]},{id:'strike',type:'strike',page:1,color:'#000000',opacity:1,width:1,quad:[72,650,170,650,72,636,170,636]},...['pen','rect','area','circle','ellipse','arrow','area-underline'].map((type,index)=>({id:type,page:2,type,color:'#3355cc',opacity:.65,width:2,fill:type==='rect',fillOpacity:.2,points:[[70+index*60,700],[90+index*60,680],[110+index*60,660]]}))],bookmarks:[{title:'한국어 북마크',page:2,x:0,y:660}]});
test('standard PDF annotations and Unicode bookmarks preserve original pages, source bytes and all drawing types',async()=>{
 const untouched=Buffer.from(source),input=await PDFDocument.load(source),p=plan(),output=await writeAnnotatedPDF(source,p),doc=await PDFDocument.load(output);
 assert.equal(doc.getPageCount(),input.getPageCount());assert.deepEqual(source,untouched);
 const first=doc.getPage(0).node.lookup(N('Annots'),PDFArray),second=doc.getPage(1).node.lookup(N('Annots'),PDFArray);
 assert.equal(first.size(),(input.getPage(0).node.lookupMaybe(N('Annots'),PDFArray)?.size()||0)+3);assert.equal(second.size(),(input.getPage(1).node.lookupMaybe(N('Annots'),PDFArray)?.size()||0)+7);
 assert.deepEqual(first.asArray().slice(-3).map(ref=>doc.context.lookup(ref,PDFDict).get(N('Subtype')).decodeText()),['Highlight','Underline','StrikeOut']);
 const subtypes=second.asArray().slice(-7).map(ref=>doc.context.lookup(ref,PDFDict).get(N('Subtype')).decodeText());assert.deepEqual(subtypes,['Ink','Square','Square','Circle','Circle','Line','Line']);
 for(const ref of [...first.asArray().slice(-3),...second.asArray().slice(-7)]){const a=doc.context.lookup(ref,PDFDict);assert.ok(a.get(N('AP')));assert.equal(a.lookup(N('F'),PDFNumber).asNumber(),4);}
 const outlines=doc.catalog.lookup(N('Outlines'),PDFDict),group=outlines.lookup(N('Last'),PDFDict),mark=group.lookup(N('First'),PDFDict);assert.equal(mark.lookup(N('Title'),PDFHexString).decodeText(),'한국어 북마크');assert.equal(mark.lookup(N('Dest'),PDFArray).get(0).toString(),doc.getPage(1).ref.toString());
});
test('existing outlines, links, crop boxes and rotation survive additional annotations',async()=>{
 const base=await PDFDocument.load(source),ctx=base.context,page=base.getPage(0);page.setRotation({type:'degrees',angle:90});page.setCropBox(12,20,400,500);
 const root=ctx.obj({Type:'Outlines',Count:1}),rootRef=ctx.register(root),existing=ctx.obj({Title:PDFHexString.fromText('기존 목차'),Parent:rootRef,Dest:[page.ref,N('Fit')]}),existingRef=ctx.register(existing);root.set(N('First'),existingRef);root.set(N('Last'),existingRef);base.catalog.set(N('Outlines'),rootRef);
 const bytes=await base.save(),doc=await PDFDocument.load(await writeAnnotatedPDF(bytes,plan()));assert.equal(doc.getPage(0).getRotation().angle,90);assert.deepEqual(doc.getPage(0).getCropBox(),page.getCropBox());const result=doc.catalog.lookup(N('Outlines'),PDFDict);assert.equal(result.lookup(N('First'),PDFDict).lookup(N('Title'),PDFHexString).decodeText(),'기존 목차');assert.ok(result.lookup(N('First'),PDFDict).get(N('Next')));
});
test('invalid annotation positions cannot silently disappear from an otherwise successful export',async()=>{
 await assert.rejects(writeAnnotatedPDF(source,{annotations:[{...plan().annotations[0],page:1000000}],bookmarks:[]}));
 await assert.rejects(writeAnnotatedPDF(source,{annotations:[],bookmarks:[{title:'invalid',page:1000000,x:0,y:0}]}));
 await assert.rejects(writeAnnotatedPDF(source,{annotations:[{...plan().annotations[0],quad:[NaN,2,3,4,5,6,7,8]}],bookmarks:[]}));
});
test('active PDF actions cannot be carried into reading copies, while ordinary links and original bytes stay intact',async()=>{
 const original=await PDFDocument.load(source),ctx=original.context;
 original.catalog.set(N('OpenAction'),ctx.obj({S:'JavaScript',JS:PDFHexString.fromText('globalThis.privateProbe=true')}));
 original.getPage(0).node.set(N('AA'),ctx.obj({O:ctx.obj({S:'Launch',F:PDFHexString.fromText('/private/file')})}));
 const bytes=await original.save(),untouched=Buffer.from(bytes),doc=await PDFDocument.load(await writeAnnotatedPDF(bytes,{annotations:[],bookmarks:[]}));
 assert.deepEqual(Buffer.from(bytes),untouched);assert.equal(doc.catalog.lookup(N('OpenAction'),PDFDict).get(N('S')).decodeText(),'Named');assert.equal(doc.getPage(0).node.has(N('AA')),false);
});
