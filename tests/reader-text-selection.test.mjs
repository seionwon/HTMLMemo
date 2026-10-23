import test from 'node:test';
import assert from 'node:assert/strict';
import {Reader} from '../public/src/reader.js';
import {sentenceOffsets,textIndex} from '../public/src/document.js';
import {documentFor,installDOM} from './dom.mjs';

function setup(body){
  installDOM();const doc=documentFor('<html lang="ko"><head></head><body>'+body+'</body></html>'),r=Object.create(Reader.prototype);
  Object.defineProperty(doc,'defaultView',{value:{getComputedStyle:node=>({display:node.style.display||(/^(div|main|article|section)$/.test(node.localName)?'block':'inline'),visibility:node.style.visibility||'visible'})},configurable:true});
  let selected=null,focused=0,prevented=0;
  doc.getSelection=()=>({removeAllRanges(){selected=null;},addRange(range){selected=range;}});
  doc.createRange=()=>({setStart(node,offset){this.startContainer=node;this.startOffset=offset;},setEnd(node,offset){this.endContainer=node;this.endOffset=offset;},getClientRects(){return [{left:this.startOffset*10,right:(this.startOffset+1)*10,top:10,bottom:30,width:10,height:20}];}});
  Object.assign(r,{doc,tool:'select',callbacks:{onDocumentFocus(){focused++;}}});
  const event=(target,options={})=>({target,button:0,detail:3,clientX:15,clientY:20,preventDefault(){prevented++;},...options});
  const selectedText=()=>{const index=textIndex(doc),a=index.nodes.find(n=>n.node===selected.startContainer),b=index.nodes.find(n=>n.node===selected.endContainer);return index.text.slice(a.start+selected.startOffset,b.start+selected.endOffset);};
  return {r,doc,event,selectedText,get selected(){return selected;},get focused(){return focused;},get prevented(){return prevented;}};
}

test('sentence offsets select Korean, quoted, English and unpunctuated sentences without surrounding spaces',()=>{
  for(const [text,word,expected,lang] of [
    ['첫 문장입니다. 두 번째 문장입니다! 마지막 문장인가요?','두 번째','두 번째 문장입니다!','ko'],
    ['“한 문장입니다.” 다음 문장입니다.','한 문장','“한 문장입니다.”','ko'],
    ['First sentence. Another sentence! Last one?','Another','Another sentence!','en'],
    ['  마침표 없는 문장  ','없는','마침표 없는 문장','ko'],
    ['One sentence\nwith formatting. Next sentence.','formatting','One sentence\nwith formatting.','en'],
    ['첫 문장. 다음 문장! 마지막.','다음','다음 문장!','invalid_locale'],
  ]){const bounds=sentenceOffsets(text,text.indexOf(word),lang);assert.equal(text.slice(bounds.start,bounds.end),expected);}
  for(const [text,at] of [['',0],['   ',1],['word',-1],['word',4],['word',1.5]])assert.equal(sentenceOffsets(text,at,'ko'),null);
});

test('text hit-testing checks the actual character rectangles, not the containing paragraph',()=>{
  const a=setup('<p>Hello world.</p>'),p=a.doc.querySelector('p'),node=p.firstChild;
  a.doc.caretPositionFromPoint=()=>({offsetNode:node,offset:2});
  assert.deepEqual(a.r.textAtClick(a.event(p)),{node,offset:1});
  assert.equal(a.r.textAtClick(a.event(p,{clientX:350})),null,'caret snapping at blank line ends is not a text hit');
  assert.equal(a.r.textAtClick(a.event(p,{clientY:60})),null,'blank space below the letters is not a text hit');
  delete a.doc.caretPositionFromPoint;a.doc.caretRangeFromPoint=()=>({startContainer:node,startOffset:2});
  assert.deepEqual(a.r.textAtClick(a.event(p)),{node,offset:1});
  delete a.doc.caretRangeFromPoint;assert.deepEqual(a.r.textAtClick(a.event(p)),{unknown:true},'an older engine conservatively preserves word selection');
});

test('word double-click preserves native selection in both views while blank paragraph space toggles fullscreen',()=>{
  const a=setup('<p>Hello world.</p><img><button>Control</button>'),p=a.doc.querySelector('p'),node=p.firstChild;
  a.doc.caretPositionFromPoint=()=>({offsetNode:node,offset:2});
  for(let n=0;n<2;n++)a.r.focusDocument(a.event(p,{detail:2}));assert.equal(a.focused,0);assert.equal(a.prevented,0);
  a.r.focusDocument(a.event(p,{detail:2,clientX:350}));assert.equal(a.focused,1);assert.equal(a.prevented,1);
  for(const target of a.doc.querySelectorAll('img,button'))a.r.focusDocument(a.event(target,{detail:2,clientX:350}));assert.equal(a.focused,1);
});

test('triple-click selects a sentence across inline markup instead of the whole paragraph',()=>{
  const a=setup('<p>Before. A <em>second</em> sentence! After?</p>'),node=a.doc.querySelector('em').firstChild;
  a.r.textAtClick=()=>({node,offset:2});
  assert.equal(a.r.selectSentenceAtClick(a.event(node.parentElement)),true);assert.equal(a.selectedText(),'A second sentence!');assert.equal(a.prevented,1);assert.equal(a.focused,0);
});

test('sentence indexing remains in the clicked text block and never scans a book-wide tree',()=>{
  const a=setup('<main><p>Unrelated previous text.</p><p id="target">First. <strong>Target sentence!</strong> Last.</p><p>Unrelated next text.</p></main>'),node=a.doc.querySelector('strong').firstChild;
  a.doc.createTreeWalker=()=>{throw Error('A whole-document scan is forbidden');};
  const index=a.r.sentenceIndex({node,offset:1});assert.equal(index.text,'First. Target sentence! Last.');assert.ok(index.nodes.every(item=>a.doc.querySelector('#target').contains(item.node)));
});

test('loose body text selects across adjacent inline nodes but stops before other paragraphs',()=>{
  const a=setup('<p>Previous paragraph.</p>Loose <em>sentence</em>. Next sentence.<p>Next paragraph.</p>'),node=a.doc.querySelector('em').firstChild;
  a.r.textAtClick=()=>({node,offset:1});assert.equal(a.r.selectSentenceAtClick(a.event(node.parentElement)),true);assert.equal(a.selectedText(),'Loose sentence.');
});

test('triple-click leaves sidebar, controls, annotation editing and drawing tools unchanged',()=>{
  const a=setup('<aside><p>Sidebar sentence.</p></aside><main><p>Body sentence.</p><button>Button</button><input><span contenteditable>Editable.</span><mark data-htmlmemo-id="saved">Saved annotation.</mark></main>'),body=a.doc.querySelector('main p');
  a.r.textAtClick=()=>({node:body.firstChild,offset:1});
  for(const target of a.doc.querySelectorAll('aside p,button,input,[contenteditable],[data-htmlmemo-id]'))assert.equal(a.r.selectSentenceAtClick(a.event(target)),false);
  for(const options of [{button:2},{detail:2},{detail:4}])assert.equal(a.r.selectSentenceAtClick(a.event(body,options)),false);
  a.r.tool='pen';assert.equal(a.r.selectSentenceAtClick(a.event(body)),false);a.r.tool='select';a.r.disposed=true;assert.equal(a.r.selectSentenceAtClick(a.event(body)),false);
  assert.equal(a.selected,null);assert.equal(a.prevented,0);assert.equal(a.focused,0);
});
