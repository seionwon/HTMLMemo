import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {$,$$,icon} from '../public/src/utils.js';
import {Reader} from '../public/src/reader.js';
import {History} from '../public/src/model.js';
import {textIndex,rangeFromOffsets,selectionAnchor} from '../public/src/document.js';
import {documentFor,installDOM} from './dom.mjs';

const source=await readFile(new URL('../public/src/app.js',import.meta.url),'utf8');
function fixture({section=''}={}){
  installDOM();const doc=documentFor(`<html><head></head><body><article id="reader-content" data-section="${section}"><p id="target">앞 문장. 선택한 <em>대상 글</em>에 메모를 남깁니다. 뒷 문장.</p></article></body></html>`),ui=documentFor('<html><body><div id="toolbar"></div><div id="tool-popover" hidden></div></body></html>');
  let ranges=[],answer,requests=0,changes=0;const notices=[],tools=[];
  const selection={get rangeCount(){return ranges.length;},get isCollapsed(){return !ranges.length;},getRangeAt:i=>ranges[i],removeAllRanges(){ranges=[];},addRange:r=>ranges=[r],toString:()=>ranges.length?selectionAnchor(doc,ranges[0])?.quote||'':''};
  doc.getSelection=()=>selection;doc.createRange=()=>({setStart(node,offset){this.startContainer=node;this.startOffset=offset;},setEnd(node,offset){this.endContainer=node;this.endOffset=offset;},getBoundingClientRect:()=>({left:24,top:80,width:80,height:20}),intersectsNode(node){const index=textIndex(doc),entry=index.nodes.find(n=>n.node===node),start=index.nodes.find(n=>n.node===this.startContainer),end=index.nodes.find(n=>n.node===this.endContainer);return !!entry&&entry.end>start.start+this.startOffset&&entry.start<end.start+this.endOffset;}});
  const r=Object.assign(Object.create(Reader.prototype),{doc,host:{hidden:false},tool:'select',metadata:{annotations:[],bookmarks:[],view:{}},history:new History(),color:'#334155',width:3,opacity:1,render(){},layerOrigin:()=>({left:0,top:0}),elementAnchor:()=>({key:'target',target:{tag:'p',id:'target',rootId:'reader-content',path:[],quote:'선택한 대상 글',section},x:0,y:0,width:400}),callbacks:{onChange:()=>changes++,onNotice:message=>notices.push(message),requestText:type=>{assert.equal(type,'note');requests++;return new Promise(resolve=>answer=resolve);}}});
  const setTool=r.setTool.bind(r);r.setTool=tool=>{tools.push(tool);setTool(tool);};
  let current=r;const context=vm.createContext({document:ui,$:(s,root=ui)=>$(s,root),$$:(s,root=ui)=>$$(s,root),icon,reader:()=>current,bindToolbarDrag(){},applyToolbarPosition(){},updateToolbarState(){},closePopover(){ui.querySelector('#tool-popover').hidden=true;},showPopover(){ui.querySelector('#tool-popover').hidden=false;},safely:fn=>fn});
  const controls=source.slice(source.indexOf('function toolbarButton('),source.indexOf('function updateToolbarState()')),actions=source.slice(source.indexOf('function toolAction('),source.indexOf('function bindToolbarDrag('));vm.runInContext('var sidebarMode="";'+controls+actions+'renderToolbar();',context);
  const choose=(quote='대상 글')=>{const index=textIndex(doc),start=index.text.indexOf(quote),range=rangeFromOffsets(doc,start,start+quote.length,index);selection.removeAllRanges();selection.addRange(range);r.selection=r.sectionAnchor(selectionAnchor(doc,range));};choose();
  return {r,doc,ui,selection,notices,tools,context,choose,button:ui.querySelector('[data-action=note]'),answer:value=>answer(value),get requests(){return requests;},get changes(){return changes;},setReader:value=>current=value};
}

test('floating Note opens a selected-text note instead of switching to a drawing tool or remembered text variant',async()=>{
  for(const tool of ['select','note','text']){
    const a=fixture({section:'v0:one'});a.r.tool=tool;a.r.toolChoices={note:'text'};const quote=a.selection.toString(),pending=a.button.onclick();
    assert.equal(a.requests,1);assert.deepEqual(a.tools,[]);assert.equal(a.ui.querySelector('#tool-popover').hidden,true);assert.equal(a.selection.toString(),quote);
    a.r.selection=null;a.answer(' 선택한 글의 메모 ');await pending;
    const note=a.r.metadata.annotations[0];assert.equal(note.type,'note');assert.equal(note.text,'선택한 글의 메모');assert.equal(note.textAnchor.quote,quote);assert.equal(note.textAnchor.section,'v0:one');assert.equal(note.anchorTarget.id,'target');assert.equal(a.selection.toString(),quote);assert.equal(a.r.selection.quote,quote);assert.equal(a.changes,1);
  }
});

test('Note pointer activation preserves a pending selection for mouse, touch and pen without changing other touch controls',()=>{
  const a=fixture();for(const pointerType of ['mouse','touch','pen']){let prevented=0;a.button.onpointerdown({pointerType,preventDefault(){prevented++;}});assert.equal(prevented,1,pointerType);}
  let prevented=0;a.ui.querySelector('[data-action=palette]').onpointerdown({pointerType:'touch',preventDefault(){prevented++;}});assert.equal(prevented,0);
});

test('canceling or saving whitespace preserves the selected text and does not create a note',async()=>{
  for(const answer of [null,'   ']){const a=fixture(),quote=a.selection.toString(),pending=a.button.onclick();assert.equal(a.requests,1);a.selection.removeAllRanges();a.r.selection=null;a.answer(answer);await pending;assert.equal(a.r.metadata.annotations.length,0);assert.equal(a.selection.toString(),quote);assert.equal(a.changes,0);assert.equal(a.r.tool,'select');}
});

test('without selected text the existing note placement and repeat-click mode picker remain available',()=>{
  const a=fixture();a.selection.removeAllRanges();a.r.selection=null;a.button.onclick();assert.deepEqual(a.tools,['note']);assert.equal(a.requests,0);a.button.onclick();assert.equal(a.ui.querySelector('#tool-popover').hidden,false);assert.equal(a.requests,0);
});

test('one pending selected-text note cannot open duplicate prompts or create duplicate annotations',async()=>{
  const a=fixture(),first=a.button.onclick(),second=a.button.onclick();assert.equal(a.requests,1);a.answer('한 번만 저장');await Promise.all([first,second]);assert.equal(a.r.metadata.annotations.length,1);assert.equal(a.changes,1);
});

test('a disposed, hidden or changed chapter cannot receive a note from an earlier selection',async()=>{
  for(const change of [a=>a.r.disposed=true,a=>a.r.host.hidden=true,a=>a.doc.querySelector('#reader-content').dataset.section='v0:two']){
    const a=fixture({section:'v0:one'}),pending=a.button.onclick();assert.equal(a.requests,1);change(a);a.answer('다른 곳에 남기면 안 되는 메모');await pending;assert.equal(a.r.metadata.annotations.length,0);assert.equal(a.changes,0);
  }
});

test('a removed target reports a missing selection instead of silently making an unrelated note',async()=>{
  const a=fixture(),pending=a.button.onclick();assert.equal(a.requests,1);a.doc.querySelector('#target').textContent='이전에 선택한 글이 없는 새 본문입니다.';a.answer('메모');await pending;assert.equal(a.r.metadata.annotations.length,0);assert.equal(a.notices.length,1);
});

test('a completed note leaves normal text annotations free to clear their own selection',async()=>{
  const a=fixture(),pending=a.button.onclick();assert.equal(a.requests,1);a.answer('대상 글 메모');await pending;a.choose('뒷 문장');a.r.addText('highlight',a.r.selection);assert.equal(a.r.metadata.annotations.length,2);assert.equal(a.selection.rangeCount,0);assert.equal(a.r.selection,null);assert.equal(a.r.metadata.annotations[0].textAnchor.quote,'대상 글');
});
