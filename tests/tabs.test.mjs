import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {DOMParser} from 'linkedom';
import {$,$$,icon} from '../public/src/utils.js';

const source=await readFile(new URL('../public/src/app.js',import.meta.url),'utf8');
const render=source.slice(source.indexOf('function renderTabs('),source.indexOf('function focusAddress('));
const bind=source.slice(source.indexOf('function bindTabs('),source.indexOf('function activate('));
function app({width=400,content=1000,left=0}={}){
  const doc=new DOMParser().parseFromString('<html><body><div id="tabs"></div><button id="library-tab"></button><div id="workspaces"></div></body></html>','text/html');
  const strip=doc.querySelector('#tabs'),frames=[];let position=left;
  Object.defineProperties(strip,{clientWidth:{value:width},scrollWidth:{value:content},scrollLeft:{get:()=>position,set:value=>position=Math.max(0,Math.min(content-width,value))}});
  strip.getBoundingClientRect=()=>({left:10,right:width+10,width});
  const context=vm.createContext({document:doc,$:(selector,root=doc)=>$(selector,root),$$:(selector,root=doc)=>$$(selector,root),icon,safely:fn=>fn,requestAnimationFrame:fn=>frames.push(fn),selectTab(){},closeTab:async()=>{},activate(){}});
  vm.runInContext('var tabs=[],activeId="library",tabLayout="";'+render+bind+'bindTabs();',context);
  const wheel=(properties={})=>{const event=new doc.defaultView.Event('wheel',{bubbles:true,cancelable:true});Object.assign(event,{deltaX:0,deltaY:80,deltaMode:0,ctrlKey:false,metaKey:false},properties);strip.dispatchEvent(event);return event;};
  const add=(id,title=id)=>{const host=doc.createElement('div');host.id='workspace-'+id;doc.querySelector('#workspaces').append(host);context.tabs.push({id,title,type:'document',host,record:{name:id+'.html'}});};
  return {context,doc,strip,frames,wheel,add};
}
test('tabs share available width, retain a usable minimum and overflow only inside the header strip',async()=>{
  const css=await readFile(new URL('../public/design.tailwind.css',import.meta.url),'utf8');
  const rule=css.match(/\.addressbar \.tab\{([^}]+)\}/)[1];
  assert.match(rule,/flex:1 1 220px/);assert.match(rule,/min-width:min\(96px,100%\)/);assert.match(rule,/max-width:min\(220px,100%\)/);
  assert.match(css,/\.addressbar>#tabs\{[^}]*min-width:0[^}]*overflow-x:auto[^}]*overflow-y:hidden/);
  assert.match(css,/\.addressbar \.tab-title\{[^}]*min-width:0[^}]*text-overflow:ellipsis/);
  assert.match(css,/\.addressbar \.tab-close\{[^}]*flex-shrink:0/);
});
test('vertical mouse wheel scrolls overflowing tabs in both directions and stops at either end',()=>{
  const a=app();assert.equal(a.wheel().defaultPrevented,true);assert.equal(a.strip.scrollLeft,80);
  a.wheel({deltaY:-40});assert.equal(a.strip.scrollLeft,40);
  a.wheel({deltaY:5000});assert.equal(a.strip.scrollLeft,600);assert.equal(a.wheel().defaultPrevented,false);
  a.wheel({deltaY:-5000});assert.equal(a.strip.scrollLeft,0);assert.equal(a.wheel({deltaY:-80}).defaultPrevented,false);
});
test('native horizontal gestures, zoom modifiers and strips without overflow are not intercepted',()=>{
  const a=app({left:100});
  for(const properties of [{deltaX:80,deltaY:20},{deltaX:-50,deltaY:0},{ctrlKey:true},{metaKey:true},{deltaX:0,deltaY:0}]){assert.equal(a.wheel(properties).defaultPrevented,false);assert.equal(a.strip.scrollLeft,100);}
  const b=app({width:400,content:400});assert.equal(b.wheel().defaultPrevented,false);assert.equal(b.strip.scrollLeft,0);
});
test('mouse wheel line and page units are converted to strip-relative distances',()=>{
  const a=app();a.wheel({deltaY:2,deltaMode:1});assert.equal(a.strip.scrollLeft,32);
  a.wheel({deltaY:1,deltaMode:2});assert.equal(a.strip.scrollLeft,432);
});
test('tab rendering keeps nodes, full-title tooltips and selection semantics without snapping on autosave',()=>{
  const a=app();a.add('one','First long title');a.add('two');a.context.activeId='two';a.context.renderTabs();
  const first=a.strip.querySelector('[data-tab=one]'),selected=a.strip.querySelector('[data-tab=two]');
  assert.equal(first.title,'First long title · one.html');assert.equal(selected.querySelector('[role=tab]').getAttribute('aria-selected'),'true');
  assert.equal(selected.querySelector('[role=tab]').getAttribute('tabindex'),'0');assert.equal(first.querySelector('[role=tab]').getAttribute('tabindex'),'-1');assert.equal(a.frames.length,1);
  a.strip.scrollLeft=200;a.context.tabs[1].queue={editsPending:true};a.context.renderTabs();
  assert.strictEqual(a.strip.querySelector('[data-tab=one]'),first);assert.equal(a.frames.length,1);assert.equal(a.strip.scrollLeft,200);assert.equal(selected.querySelector('.tab-dirty').hidden,false);
  a.context.tabs.splice(0,1);a.context.renderTabs();assert.equal(a.strip.contains(first),false);assert.strictEqual(a.strip.querySelector('[data-tab=two]'),selected);assert.equal(a.frames.length,2);
});
test('changed selection is revealed at either edge without scrolling a hidden or already visible strip',()=>{
  const a=app();a.add('one');a.context.activeId='one';a.context.renderTabs();const tab=a.strip.querySelector('.tab');
  tab.getBoundingClientRect=()=>({left:600,right:696});a.context.revealActiveTab();assert.equal(a.strip.scrollLeft,286);
  tab.getBoundingClientRect=()=>({left:-10,right:86});a.context.revealActiveTab();assert.equal(a.strip.scrollLeft,266);
  tab.getBoundingClientRect=()=>({left:20,right:116});a.context.revealActiveTab();assert.equal(a.strip.scrollLeft,266);
  a.strip.hidden=true;tab.getBoundingClientRect=()=>({left:600,right:696});a.context.revealActiveTab();assert.equal(a.strip.scrollLeft,266);
});
test('Delete focuses the remaining document or the library button after closing the final tab',async()=>{
  for(const count of [2,1]){
    const a=app();for(let i=0;i<count;i++)a.add('doc-'+i);a.context.activeId='doc-0';a.context.renderTabs();
    Object.defineProperty(a.doc,'activeElement',{value:a.doc.body,writable:true,configurable:true});
    a.doc.defaultView.HTMLElement.prototype.focus=function(){this.ownerDocument.activeElement=this;};
    a.context.closeTab=async id=>{a.context.tabs.splice(a.context.tabs.findIndex(tab=>tab.id===id),1);a.context.activeId=a.context.tabs[0]?.id||'library';a.context.renderTabs();};
    const event=new a.doc.defaultView.Event('keydown',{bubbles:true,cancelable:true});event.key='Delete';
    a.strip.querySelector('.tab.active .tab-select').dispatchEvent(event);await new Promise(resolve=>setImmediate(resolve));
    assert.equal(event.defaultPrevented,true);
    assert.equal(a.doc.activeElement,count===1?a.doc.querySelector('#library-tab'):a.strip.querySelector('.tab.active .tab-select'));
    assert.equal(a.strip.children.length,count-1);
  }
});
