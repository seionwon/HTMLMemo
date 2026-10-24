import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {$,$$} from '../public/src/utils.js';
import {documentFor} from './dom.mjs';

const source=await readFile(new URL('../public/src/app.js',import.meta.url),'utf8');
const menu=source.slice(source.indexOf('function showSelectionMenu('),source.indexOf('function toolAction('));
function fixture({quote='선택한 글 & 웹 검색?',speech=true}={}){
  const doc=documentFor('<html><body><div id="tool-popover" hidden></div></body></html>'),pop=doc.querySelector('#tool-popover'),spoken=[],urls=[];
  const r={selection:{quote,start:10,end:10+quote.length,section:'v0:one'},metadata:{annotations:[{id:'existing-note',text:'기존 메모'}],bookmarks:[{id:'existing-bookmark'}]},speakSelection(){spoken.push(this.selection.quote);return speech;}};
  const context=vm.createContext({$:(s,root=doc)=>$(s,root),$$:(s,root=doc)=>$$(s,root),safely:fn=>fn,openBrowser:async url=>urls.push(url)});
  context.closePopover=()=>{context.popoverName='';pop.hidden=true;};context.showPopover=(name,html,bind)=>{context.popoverName=name;pop.innerHTML=html;pop.hidden=false;bind();};
  vm.runInContext('var popoverName="";'+menu,context);
  return {r,pop,spoken,urls,show:()=>context.showSelectionMenu(r)};
}

test('selected text menu contains only Read aloud and Web search in the requested order',()=>{
  const a=fixture(),before=structuredClone(a.r.metadata);a.show();
  assert.deepEqual([...a.pop.querySelectorAll('[data-selection]')].map(b=>[b.dataset.selection,b.textContent]),[['speak','읽어주기'],['webSearch','웹 검색']]);
  assert.equal(a.pop.getAttribute('role'),'dialog');assert.equal(a.pop.getAttribute('aria-label'),'선택한 텍스트');assert.deepEqual(a.r.metadata,before);
});

test('the remaining selection menu buttons preserve the selection on pointer activation',()=>{
  const a=fixture(),anchor=a.r.selection;a.show();let prevented=0;
  for(const button of a.pop.querySelectorAll('[data-selection]'))button.onpointerdown({preventDefault(){prevented++;}});
  assert.equal(prevented,2);assert.strictEqual(a.r.selection,anchor);
});

test('Read aloud uses the captured quote and only dismisses the menu when the player accepts it',async()=>{
  for(const speech of [true,false]){const a=fixture({speech}),quote=a.r.selection.quote;a.show();a.r.selection={quote:'다른 선택'};await a.pop.querySelector('[data-selection=speak]').onclick();assert.deepEqual(a.spoken,[quote]);assert.deepEqual(a.urls,[]);assert.equal(a.pop.hidden,speech);}
});

test('Web search keeps the captured quote, URL encoding and 2000-character limit without modifying annotations',async()=>{
  const quote='한글 & 기호? / # '+ '긴 선택 '.repeat(600),a=fixture({quote}),before=structuredClone(a.r.metadata);a.show();a.r.selection={quote:'나중 선택'};
  await a.pop.querySelector('[data-selection=webSearch]').onclick();assert.deepEqual(a.urls,['https://www.google.com/search?q='+encodeURIComponent(quote.slice(0,2000))]);assert.deepEqual(a.spoken,[]);assert.equal(a.pop.hidden,true);assert.deepEqual(a.r.metadata,before);
});

test('no selection creates no menu and a new selection replaces rather than duplicates its actions',()=>{
  const a=fixture();a.r.selection=null;a.show();assert.equal(a.pop.hidden,true);assert.equal(a.pop.children.length,0);
  a.r.selection={quote:'첫 선택'};a.show();a.r.selection={quote:'다음 선택'};a.show();assert.equal(a.pop.hidden,false);assert.equal(a.pop.querySelectorAll('[data-selection]').length,2);
});

test('selection menu fits its two actions while retaining the viewport width limit',async()=>{
  const css=await readFile(new URL('../public/design.tailwind.css',import.meta.url),'utf8'),rule=css.match(/#tool-popover\.selection\s*\{[^}]*\}/)?.[0]||'';
  assert.match(rule,/width:max-content;[^}]*max-width:calc\(100vw - 20px\)/);
});
