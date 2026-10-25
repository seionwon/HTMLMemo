import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {LibraryIndex,indexFolders,validateFolders,mergeLibraryFolders} from '../public/src/library-folders.js';
import {Reader} from '../public/src/reader.js';
import {documentFor,installDOM} from './dom.mjs';
import {$,$$,icon,escapeHTML,formatDate,formatBytes,displayHost} from '../public/src/utils.js';
installDOM();
const tree=[{id:'books',parentId:'',name:'책'},{id:'part',parentId:'books',name:'1부'}];
const rows=()=>Array.from({length:5000},(_,i)=>({id:'d'+i,title:'문서 '+i,name:i+'.html',source:'',created:i,modified:5000-i,folderId:i%2?'part':'',metadata:{annotations:[],view:{}}}));

test('library indexes reuse metadata, counts, search text and sorted results across repeated queries',()=>{
  const records=rows(),before=structuredClone(records),index=new LibraryIndex();
  assert.equal(index.update(records,tree),true);assert.equal(index.counts.get('books'),2500);assert.equal(index.counts.get('part'),2500);
  const first=index.select({filter:'문서 123'});assert.equal(first.documents.length,11);assert.equal(index.searchText.size,5000);
  assert.equal(index.update(records,tree),false);assert.strictEqual(index.select({filter:'문서 123'}),first);
  assert.equal(index.select({folderId:'part'}).documents.length,2500);assert.equal(index.select({filter:'책 / 1부'}).documents.length,2500);
  for(let i=0;i<30;i++)index.select({filter:'문서 '+i});assert.equal(index.queries.size,8);assert.deepEqual(records,before);
  assert.equal(index.select({sort:'created',direction:'asc'}).documents[0].id,'d0');
  assert.equal(index.select({sort:'created',direction:'desc'}).documents[0].id,'d4998');
});
test('renames, moves, edits and a new root invalidate library caches without losing document placement',()=>{
  const records=rows().slice(0,4),index=new LibraryIndex();index.update(records,tree,'Documents');index.select({filter:'문서'});
  const renamed=tree.map(f=>f.id==='books'?{...f,name:'다시 읽기'}:f);assert.equal(index.update(records,renamed,'Documents'),true);
  assert.equal(index.select({filter:'책'}).documents.length,0);assert.equal(index.select({filter:'다시 읽기'}).documents.length,2);
  const moved=records.map(r=>r.id==='d1'?{...r,folderId:'',title:'바뀐 제목'}:r);index.update(moved,renamed,'새 전용 폴더');
  assert.equal(index.select({folderId:'part'}).documents.length,1);assert.equal(index.select({filter:'바뀐 제목'}).documents[0].id,'d1');assert.equal(index.label('part'),'새 전용 폴더 / 다시 읽기 / 1부');
});
test('folder indexing visits a reverse-ordered 10,000-folder hierarchy without repeated full-array scans',()=>{
  let reads=0;const folders=Array.from({length:10000},(_,i)=>({get id(){reads++;return 'f'+i;},get parentId(){reads++;return i%10?'f'+(i-1):'';},name:'폴더 '+i})).reverse();
  const indexed=indexFolders(folders);assert.equal(indexed.ordered.length,10000);assert.ok(reads<10000*15,`property reads: ${reads}`);
  const seen=new Set(['']);for(const folder of indexed.ordered){assert.ok(seen.has(folder.parentId));seen.add(folder.id);}
});
test('large folder merges preserve existing IDs, sibling uniqueness and already ordered input',()=>{
  const incoming=Array.from({length:3000},(_,i)=>({id:'f'+i,parentId:i%10?'f'+(i-1):'',name:'폴더 '+i}));
  const merged=mergeLibraryFolders([],incoming,()=>{throw Error('unexpected conflict');});assert.deepEqual(merged.folders,incoming);
  const again=mergeLibraryFolders(merged.folders,[...incoming].reverse(),()=>{throw Error('unexpected conflict');});assert.deepEqual(again.folders,incoming);assert.equal(again.mapping.size,3001);
  assert.throws(()=>mergeLibraryFolders([{id:'same',parentId:'',name:'기존'}],[{id:'same',parentId:'',name:'다른'}],()=> 'same'),/ID/);
});

const source=await readFile(new URL('../public/src/app.js',import.meta.url),'utf8');
const libraryCode=source.slice(source.indexOf('async function refreshLibrary('),source.indexOf('async function changeLibraryFolder('));
const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
function libraryApp(){
  const doc=documentFor(html),records=rows().slice(0,4),folders=validateFolders(tree),calls={read:0,render:0};
  doc.querySelector('#library-filter').value='';
  const context=vm.createContext({document:doc,$:(s,root=doc)=>$(s,root),$$:(s,root=doc)=>$$(s,root),icon,esc:escapeHTML,formatDate,formatBytes,displayHost,LibraryIndex,validateFolders,
    folderPath:(folders,id,map)=>{const path=[];for(let f=map.get(id);f;f=map.get(f.parentId))path.unshift(f);return path;},clearTimeout,
    readLibrary:async()=>{calls.read++;return {documents:records,folders};},renderFolderState:()=>{},
    initialRecords:records,initialFolders:folders});
  vm.runInContext(`var records=initialRecords,libraryFolders=initialFolders,activeId='library',folder=null,libraryFolderId='',libraryCollapsed=new Set(),libraryRefresh=0,libraryRead=null,libraryReloadTimer;
    var libraryIndex=new LibraryIndex(),libraryIndexVersion=0,libraryTreeVersion=0,libraryTreeState='',libraryGridState=null,libraryFolderById=new Map(),libraryFolderChildren=new Map(),libraryFolderCounts=new Map();
    var preferences={librarySort:'modified',librarySortDirection:'desc',libraryView:'card'};\n`+libraryCode,context);
  return {context,doc,records,folders,calls};
}
test('repeated library renders and view changes retain cards, tree nodes and focused controls',()=>{
  const a=libraryApp();a.context.renderLibrary();const card=a.doc.querySelector('.document-card'),branch=a.doc.querySelector('.library-tree-row'),folder=a.doc.querySelector('.library-folder-card');
  a.context.renderLibrary();assert.strictEqual(a.doc.querySelector('.document-card'),card);assert.strictEqual(a.doc.querySelector('.library-tree-row'),branch);
  a.context.preferences.libraryView='list';a.context.renderLibrary();assert.equal(a.doc.querySelector('#document-grid').dataset.view,'list');assert.strictEqual(a.doc.querySelector('.document-card'),card);
  a.doc.querySelector('#library-filter').value='문서';a.context.renderLibrary();const searchedBranch=a.doc.querySelector('.library-tree-row');
  a.doc.querySelector('#library-filter').value='문서 1';a.context.renderLibrary();assert.strictEqual(a.doc.querySelector('.library-tree-row'),searchedBranch);assert.notStrictEqual(a.doc.querySelector('.library-folder-card'),folder);
  a.context.activeId='reading';const grid=a.doc.querySelector('#document-grid').innerHTML;a.context.records=[];a.context.renderLibrary();assert.equal(a.doc.querySelector('#document-grid').innerHTML,grid);
  a.context.activeId='library';a.context.renderLibrary();assert.equal(a.doc.querySelectorAll('.document-card').length,0);
});
test('concurrent library refreshes share one pending read and publish only the newest snapshot',async()=>{
  const a=libraryApp(),resolvers=[];let renders=0;a.context.renderLibrary=()=>renders++;a.context.readLibrary=()=>{a.calls.read++;return new Promise(resolve=>resolvers.push(resolve));};
  const requests=Array.from({length:100},()=>a.context.refreshLibrary());assert.equal(a.calls.read,1);
  resolvers.shift()({documents:[],folders:[]});await new Promise(resolve=>setImmediate(resolve));assert.equal(a.calls.read,2);assert.equal(renders,0);
  resolvers.shift()({documents:a.records,folders:a.folders});await Promise.all(requests);assert.equal(renders,1);assert.strictEqual(a.context.records,a.records);
  a.context.readLibrary=async()=>{throw Error('read failure');};await assert.rejects(a.context.refreshLibrary(),/read failure/);
  a.context.readLibrary=async()=>({documents:[],folders:[]});await a.context.refreshLibrary();assert.equal(renders,2);
});
test('date formatters are constructed once per locale/style, not once per card',async()=>{
  const code=(await readFile(new URL('../public/src/utils.js',import.meta.url),'utf8')).replace(/^export /gm,'');let created=0;
  const context=vm.createContext({Intl:{DateTimeFormat:function(...args){created++;return new Intl.DateTimeFormat(...args);}}});vm.runInContext(code,context);
  const time=new Date(2026,9,25,12,34,56).getTime();for(let i=0;i<1000;i++){assert.equal(context.formatDate(time),formatDate(time));assert.equal(context.formatDate(time,true),new Date(time).toLocaleString('ko-KR'));}assert.equal(created,2);
});

test('500 strokes sharing a paragraph measure its origin, box and font once per drawing pass',()=>{
  const doc=documentFor('<html><head></head><body><p data-htmlmemo-anchor="n0">Shared paragraph.</p></body></html>'),p=doc.querySelector('p'),reader=Object.create(Reader.prototype);
  let origins=0,boxes=0,fonts=0,visibility=0,queries=0,height=100,fontSize=18;
  Object.assign(reader,{doc,naturalWidth:960,naturalHeight:800,metadata:{annotations:Array.from({length:500},(_,i)=>({id:'pen'+i,type:'pen',anchor:'n0',penBasis:{width:400,height:100,fontSize:18},points:[{x:.1,y:.2},{x:.3,y:.4}],color:'#ef4444',opacity:1,width:3}))}});
  reader.ensureAnnotationLayerHost=()=>null;reader.layerOrigin=()=>{origins++;return {left:0,top:0,scrollHost:null};};reader.drawingFontSize=()=>{fonts++;return fontSize;};
  p.getBoundingClientRect=()=>{boxes++;return {left:10,top:20,width:400,height};};p.getClientRects=()=>{visibility++;return [{}];};
  const query=doc.querySelector.bind(doc);doc.querySelector=selector=>{if(selector.startsWith('[data-htmlmemo-anchor='))queries++;return query(selector);};
  reader.renderDrawingLayer();assert.deepEqual({origins,boxes,fonts,visibility,queries},{origins:1,boxes:1,fonts:1,visibility:1,queries:1});assert.equal(reader.layer.children.length,500);
  const first=reader.layer.firstElementChild;reader.renderDrawingLayer();assert.strictEqual(reader.layer.firstElementChild,first);assert.equal(boxes,2,'measurements are not retained across passes');
  height=400;fontSize=36;reader.renderDrawingLayer();assert.equal(reader.layer.firstElementChild.getAttribute('d'),'M90.00,60.00 L250.00,100.00');
  p.remove();reader.renderDrawingLayer();assert.equal(reader.layer.children.length,0);assert.equal(reader.metadata.annotations.length,500);
});
test('a few drawing anchors avoid a whole-book index; many distinct anchors share a single sweep',()=>{
  const doc=documentFor('<html><head></head><body>'+Array.from({length:50},(_,i)=>`<p data-htmlmemo-anchor="n${i}">Paragraph ${i}</p>`).join('')+'</body></html>'),reader=Object.create(Reader.prototype);reader.doc=doc;
  let singles=0,sweeps=0;const single=doc.querySelector.bind(doc),all=doc.querySelectorAll.bind(doc);
  doc.querySelector=s=>{if(s.startsWith('[data-htmlmemo-anchor='))singles++;return single(s);};doc.querySelectorAll=s=>{if(s==='[data-htmlmemo-anchor]')sweeps++;return all(s);};
  const context=reader.drawingTargetContext();for(let i=0;i<3;i++)assert.ok(reader.resolveDrawingTarget({anchor:'n'+i},context));assert.equal(sweeps,0);
  for(let i=0;i<50;i++)assert.ok(reader.resolveDrawingTarget({anchor:'n'+i},context));assert.equal(singles,7);assert.equal(sweeps,1);
});
test('many drawing targets validate a shared quote once and never reuse it after source replacement',()=>{
  const doc=documentFor('<html><head></head><body><p data-htmlmemo-anchor="n0">Shared target.</p></body></html>'),reader=Object.create(Reader.prototype);reader.doc=doc;
  const p=doc.querySelector('p'),target=reader.describeDrawingTarget(p),annotations=Array.from({length:500},(_,i)=>({id:'a'+i,anchor:'n0',anchorTarget:target}));
  let quotes=0;const original=reader.drawingTargetQuote.bind(reader);reader.drawingTargetQuote=node=>{quotes++;return original(node);};
  const context=reader.drawingTargetContext();for(const a of annotations)assert.strictEqual(reader.resolveDrawingTarget(a,context),p);assert.equal(quotes,1);
  p.textContent='Changed by the source';const next=reader.drawingTargetContext();for(const a of annotations)assert.equal(reader.resolveDrawingTarget(a,next),null);assert.equal(quotes,2);
});
test('annotation contexts look up thousands of marks in one DOM sweep, retaining overlapping marks',()=>{
  const doc=documentFor('<html><head></head><body><h1>첫 장</h1><p>'+Array.from({length:1000},(_,i)=>`<mark data-htmlmemo-mark data-htmlmemo-id="a${i}">문장 ${i}</mark>`).join('')+'</p></body></html>'),reader=Object.create(Reader.prototype);reader.doc=doc;
  reader.metadata={annotations:Array.from({length:1000},(_,i)=>({id:'a'+i,type:'highlight',textAnchor:{quote:'문장 '+i}}))};reader.isInsideTocOrTopbar=()=>false;
  let sweeps=0,lookups=0;const query=doc.querySelectorAll.bind(doc),single=doc.querySelector.bind(doc);doc.querySelectorAll=s=>{if(s==='[data-htmlmemo-id]')sweeps++;return query(s);};doc.querySelector=s=>{if(s.includes('[data-htmlmemo-id='))lookups++;return single(s);};
  const contexts=reader.annotationContexts();assert.equal(contexts.size,1000);assert.equal(contexts.get('a999').heading,'첫 장');assert.equal(contexts.get('a999').quote,'문장 999');assert.equal(sweeps,1);assert.equal(lookups,0);
});
