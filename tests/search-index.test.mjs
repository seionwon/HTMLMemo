import test from 'node:test';
import assert from 'node:assert/strict';
import {SearchIndexCache} from '../public/src/search-index.js';
import {textIndex,rangeFromOffsets,wrapOffsets} from '../public/src/document.js';
import {Reader} from '../public/src/reader.js';
import {documentFor,installDOM} from './dom.mjs';

installDOM();
function fixture(body='<p>첫 키워드와 다음 <em>키워드</em>, 마지막 키워드.</p>'){
  const doc=documentFor('<html><head></head><body>'+body+'</body></html>'),walk=doc.createTreeWalker.bind(doc);let walks=0;
  doc.createTreeWalker=(...args)=>{walks++;return walk(...args);};
  const cache=new SearchIndexCache(doc);return {doc,cache,walks:()=>walks};
}
function controlled(body){
  const f=fixture(body),observers=[];
  Object.defineProperty(f.doc,'defaultView',{value:{MutationObserver:class{
    constructor(callback){this.callback=callback;this.records=[];observers.push(this);}
    observe(root){this.root=root;}disconnect(){this.records=[];}takeRecords(){return this.records.splice(0);}
  }}});
  return {...f,observers};
}
function reader(doc){
  const r=Object.create(Reader.prototype);r.doc=doc;r.metadata={annotations:[],bookmarks:[]};r.callbacks={};r.zoom=1;r.viewport={clientHeight:200,clientWidth:300};r.layerOrigin=()=>({left:0,top:0});
  doc.createRange=()=>({setStart(){},setEnd(){},getBoundingClientRect:()=>({left:10,top:200,width:20,height:10})});return r;
}

test('search index is lazy, reuses one DOM pass across queries and caches repeated results',()=>{
  const f=fixture();assert.equal(f.walks(),0);assert.deepEqual(f.cache.query(' ').results,[]);assert.equal(f.walks(),0);
  const first=f.cache.query('키워드'),second=f.cache.query('다음');assert.equal(first.results.length,3);assert.equal(second.results.length,1);assert.strictEqual(first.index,second.index);assert.equal(f.walks(),1);
  assert.strictEqual(f.cache.query('키워드').results,first.results);assert.equal(f.walks(),1);
  for(let i=0;i<20;i++)f.cache.query('absent-'+i);assert.equal(f.cache.entry(f.doc.body).results.size,8);assert.equal(f.walks(),1);f.cache.dispose();
});

test('a text index already made for annotation restoration is adopted without rebuilding',()=>{
  const f=fixture(),index=textIndex(f.doc);assert.equal(f.walks(),1);f.cache.seed(f.doc.body,index);
  assert.strictEqual(f.cache.query('키워드').index,index);assert.equal(f.walks(),1);f.cache.dispose();
});

test('concurrent first searches share the same asynchronous index build',async()=>{
  const f=fixture();const first=f.cache.prepare(),second=f.cache.prepare();assert.strictEqual(first,second);
  const index=await first;assert.strictEqual(await second,index);assert.strictEqual(f.cache.query('키워드').index,index);assert.equal(f.walks(),1);f.cache.dispose();
});

test('literal Unicode matching keeps original UTF-16 positions and never treats punctuation as regex',()=>{
  const f=fixture('<p>İ before 🧠 A.B a.b [x] 한<em>글</em> Σ σ ς</p>');
  assert.equal(f.cache.query('before').results[0].start,2);assert.equal(f.cache.query('🧠').results[0].end-f.cache.query('🧠').results[0].start,2);
  assert.equal(f.cache.query('a.b').results.length,2);assert.equal(f.cache.query('[x]').results.length,1);assert.equal(f.cache.query('한글').results.length,1);assert.equal(f.cache.query('σ').results.length,3);
  for(const match of f.cache.query('a.b').results)assert.equal(f.cache.get().text.slice(match.start,match.end).toLowerCase(),'a.b');f.cache.dispose();
});

test('source search placeholders retain annotation offsets but are excluded from matches',()=>{
  const f=fixture('<p>일반 키워드</p><span hidden data-htmlmemo-book-search-slot>목차 키워드</span><p>실제 <b>키워드</b></p><span data-htmlmemo-ui>도구 키워드</span><script>키워드</script>');
  const {index,results}=f.cache.query('키워드');assert.equal(results.length,2);assert.equal(index.text,'일반 키워드목차 키워드실제 키워드');assert.equal(results[1].start,index.text.lastIndexOf('키워드'));f.cache.dispose();
});

test('pending source mutations invalidate before the observer callback and unchanged queries are refreshed',()=>{
  const f=controlled('<p>old text</p>'),first=f.cache.query('text'),observer=f.observers[0];
  f.doc.querySelector('p').firstChild.textContent='new keyword';observer.records.push({type:'characterData',target:f.doc.querySelector('p').firstChild});
  const second=f.cache.query('keyword');assert.notStrictEqual(second.index,first.index);assert.equal(second.results.length,1);assert.equal(f.cache.query('text').results.length,0);assert.equal(f.walks(),2);f.cache.dispose();
});

test('editor-only mutations do not discard the search index',()=>{
  const f=controlled('<p>source</p>'),first=f.cache.get(),observer=f.observers[0],ui=f.doc.createElement('div');ui.setAttribute('data-htmlmemo-ui','');ui.textContent='ui only';f.doc.body.append(ui);
  observer.records.push({type:'childList',target:f.doc.body,addedNodes:[ui],removedNodes:[]});assert.strictEqual(f.cache.query('ui only').index,first);assert.equal(f.cache.query('ui only').results.length,0);assert.equal(f.walks(),1);
  observer.records.push({type:'attributes',target:f.doc.querySelector('p')});f.doc.querySelector('p').setAttribute('data-htmlmemo-ui','');assert.equal(f.cache.query('source').results.length,0);assert.equal(f.walks(),2);f.cache.dispose();
});

test('wrapping and unwrapping one active search hit keeps its node index usable',()=>{
  const f=fixture(),{index,results}=f.cache.query('키워드');
  for(const match of [...results,...results].reverse()){
    const marks=f.cache.mutate(index,()=>wrapOffsets(f.doc,match.start,match.end,{'data-htmlmemo-search':''},'',index));
    assert.equal(marks.map(mark=>mark.textContent).reverse().join(''),'키워드');f.cache.mutate(null,()=>{for(const mark of marks)mark.replaceWith(...mark.childNodes);},false);
    assert.strictEqual(f.cache.get(),index);
  }
  assert.equal(f.walks(),1);assert.equal(textIndex(f.doc).text,index.text);f.cache.dispose();
});

test('source edits within an annotation or active-search wrapper are not ignored',()=>{
  const f=controlled('<p><span data-htmlmemo-search>old</span></p>');f.cache.query('old');const node=f.doc.querySelector('span').firstChild;node.textContent='new';f.observers[0].records.push({type:'characterData',target:node});
  assert.equal(f.cache.query('old').results.length,0);assert.equal(f.cache.query('new').results.length,1);assert.equal(f.walks(),2);f.cache.dispose();
});

test('range lookup uses binary boundaries without copying or scanning the node array',()=>{
  const f=fixture('<p>'+Array.from({length:10000},()=>'<span>x</span>').join('')+'</p>'),index=textIndex(f.doc),calls=[];let reads=0;
  index.nodes=new Proxy(index.nodes,{get(target,key){if(/^\d+$/.test(String(key)))reads++;if(key===Symbol.iterator)throw Error('No whole-index copy');return Reflect.get(target,key);}});
  f.doc.createRange=()=>({setStart:(node,offset)=>calls.push(['start',node.textContent,offset]),setEnd:(node,offset)=>calls.push(['end',node.textContent,offset])});
  assert.ok(rangeFromOffsets(f.doc,9998,10000,index));assert.deepEqual(calls,[['start','x',0],['end','x',1]]);assert.ok(reads<40,'only logarithmic index entries are accessed');f.cache.dispose();
});

test('search result cache is capped and a 3000-hit limit stays compatible',()=>{
  const f=fixture('<p>'+('word '.repeat(5000))+'</p>');assert.equal(f.cache.query('word').results.length,3000);assert.equal(f.cache.query('word',f.doc.body,2).results.length,2);assert.equal(f.walks(),1);f.cache.dispose();
});

test('reader navigation performs no full text walks or body normalization after indexing',()=>{
  const f=fixture(),r=reader(f.doc);f.doc.body.normalize=()=>{throw Error('Do not normalize the entire book for search');};
  r.search('키워드');const first=r.searchTextIndex;for(let i=0;i<10;i++){r.nextSearch(1);r.nextSearch(-1);}
  r.search('마지막',false);assert.strictEqual(r.searchTextIndex,first);assert.equal(f.walks(),1);assert.equal(r.searchResults.length,1);r.search('');assert.equal(f.doc.querySelector('[data-htmlmemo-search]'),null);r.searchCache().dispose();
});
test('refreshing a changed source index keeps the requested next match instead of jumping to the first',()=>{
  const f=controlled('<p>word one, word two, word three.</p>'),r=reader(f.doc);r.search('word',false);r.searchPosition=1;
  const text=f.doc.querySelector('p').firstChild;text.textContent+=' Extra text.';f.observers[0].records.push({type:'characterData',target:text});
  assert.equal(r.nextSearch(1),true);assert.equal(r.searchPosition,2);assert.equal(r.searchResults.length,3);assert.equal(f.doc.querySelector('[data-htmlmemo-search]').textContent,'word');r.searchCache().dispose();
});

test('empty-search Enter or navigation never builds an otherwise unused index',()=>{
  const f=fixture(),r=reader(f.doc);assert.equal(r.nextSearch(1),false);r.search('');assert.equal(r.nextSearch(1),false);r.search('   ');assert.equal(r.nextSearch(-1),false);assert.equal(f.walks(),0);assert.equal(r.searchCache().entries.size,0);r.searchCache().dispose();
});

test('reader render seeds the index used to restore existing text annotations',()=>{
  const f=fixture('<p>existing annotation and keyword</p>'),r=reader(f.doc);r.metadata.annotations=[{id:'existing',type:'highlight',textAnchor:{start:0,end:8,quote:'existing'},color:'#edcf67',opacity:.35}];r.annotationInSection=()=>true;r.renderDrawingLayer=()=>{};r.observeDynamicDocument=()=>{};
  r.render();assert.equal(f.walks(),1);r.search('keyword',false);assert.equal(f.walks(),1);assert.equal(r.searchResults.length,1);r.searchCache().dispose();
});

test('newer queries, clear, closed views and disposal cancel stale asynchronous search results',async()=>{
  const f=fixture(),r=reader(f.doc),old=r.searchAsync('첫',false),latest=r.searchAsync('마지막',false);assert.equal(await old,null);assert.equal((await latest).length,1);assert.equal(r.searchQuery,'마지막');assert.equal(f.walks(),1);
  assert.equal(await r.searchAsync('키워드',true,()=>false),null);assert.equal(r.searchQuery,'마지막');
  const pending=r.searchAsync('키워드');r.search('');assert.equal(await pending,null);assert.equal(r.searchQuery,'');
  r.disposed=true;r.searchCache().dispose();assert.equal(await r.searchCache().prepare(),null);assert.equal(await r.searchAsync('마지막'),null);
});

test('disposing a pending first build releases cached roots and never publishes its index',async()=>{
  const f=fixture(),pending=f.cache.prepare();f.cache.dispose();assert.equal(await pending,null);assert.equal(f.cache.entries.size,0);
});

test('an asynchronous build retries changed source text instead of caching a stale snapshot',async()=>{
  const f=controlled('<p>before</p>'),pending=f.cache.prepare(),node=f.doc.querySelector('p').firstChild;node.textContent='after';f.observers[0].records.push({type:'characterData',target:node});
  const index=await pending;assert.equal(index.text,'after');assert.equal(f.cache.query('after').results.length,1);assert.equal(f.cache.query('before').results.length,0);assert.equal(f.walks(),2);f.cache.dispose();
});

test('replaced chapter roots are released while the body and new chapter remain isolated',()=>{
  const f=fixture('<article id="chapter">first</article>'),old=f.doc.querySelector('article');f.cache.query('first');f.cache.query('first',old);
  const next=f.doc.createElement('article');next.textContent='second';old.replaceWith(next);f.cache.query('second',next);
  assert.equal(f.cache.entries.has(old),false);assert.equal(f.cache.entries.has(next),true);assert.equal(f.cache.entries.size,2);f.cache.invalidate();assert.equal(f.cache.query('first').results.length,0);f.cache.dispose();
});
