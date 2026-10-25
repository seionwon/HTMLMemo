import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {icon} from '../public/src/utils.js';
import {Reader} from '../public/src/reader.js';
import {DOMParser} from 'linkedom';
const appSource=await readFile(new URL('../public/src/app.js',import.meta.url),'utf8');
const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
const functions=appSource.slice(appSource.indexOf('function handleKey('),appSource.indexOf('async function copyAppURL('));
const listener=appSource.match(/^  document.addEventListener\('fullscreenchange',.*$/m)[0];
function app({native=false,rejected=false,deferred=false,exitDeferred=false}={}){
 const doc=new DOMParser().parseFromString(html,'text/html'),root=doc.querySelector('#app');
 const calls={requested:0,exited:0,measured:0,search:[]};
 const metadata={annotations:[{id:'note-1',text:'Keep my note'}]};
 const r={doc:{},metadata,measure(){calls.measured++;},setTool(){},stopSpeech(){calls.speechStopped=true;}};
 let finish,finishExit;
 doc.exitFullscreen=async()=>{calls.exited++;if(exitDeferred)await new Promise(resolve=>finishExit=resolve);doc.fullscreenElement=null;doc.dispatchEvent(new doc.defaultView.Event('fullscreenchange'));};
 if(native)root.requestFullscreen=async()=>{calls.requested++;if(rejected)throw Error('Permission denied');if(deferred)await new Promise(resolve=>finish=resolve);doc.fullscreenElement=root;doc.dispatchEvent(new doc.defaultView.Event('fullscreenchange'));};
 const context=vm.createContext({document:doc,$:selector=>doc.querySelector(selector),reader:()=>r,requestAnimationFrame:fn=>fn(),applyToolbarPosition(){},closePopover(){doc.querySelector('#tool-popover').hidden=true;},closeSidebar(){doc.querySelector('#sidebar').hidden=true;},restoreSidebar(){},renderSidebar:value=>calls.search.push(value)});
 new vm.Script('var readerFocused=false,nativeReaderFullscreen=false,focusBusy=false;'+functions+'\n'+listener).runInContext(context);
 return {context,doc,root,r,calls,finish:()=>finish(),finishExit:()=>finishExit()};
}
test('document focus works without browser fullscreen and keeps annotation tools/dialogs in its shell',async()=>{
 const a=app();const notes=a.r.metadata.annotations;
 await a.context.toggleReaderFocus();assert.equal(a.context.readerFocused,true);assert.ok(a.root.classList.contains('reader-focus'));
 assert.ok(a.root.contains(a.doc.querySelector('#toolbar')));assert.ok(a.root.contains(a.doc.querySelector('#dialog')));
 assert.strictEqual(a.r.metadata.annotations,notes);assert.equal(a.calls.requested,0);
 await a.context.toggleReaderFocus();assert.equal(a.context.readerFocused,false);
});
test('native fullscreen targets the app shell and exit restores the document view',async()=>{
 const a=app({native:true});await a.context.toggleReaderFocus();assert.strictEqual(a.doc.fullscreenElement,a.root);assert.equal(a.context.nativeReaderFullscreen,true);
 await a.context.leaveReaderFocus();assert.equal(a.calls.exited,1);assert.equal(a.context.readerFocused,false);assert.equal(a.doc.fullscreenElement,null);
});
test('a denied browser fullscreen request retains usable document focus',async()=>{
 const a=app({native:true,rejected:true});await a.context.toggleReaderFocus();assert.equal(a.context.readerFocused,true);assert.equal(a.context.focusBusy,false);assert.equal(a.context.nativeReaderFullscreen,false);
 await a.context.leaveReaderFocus();assert.equal(a.context.readerFocused,false);assert.equal(a.calls.exited,0);
});
test('browser Escape/fullscreenchange clears focus',async()=>{
 const a=app({native:true});await a.context.toggleReaderFocus();a.doc.fullscreenElement=null;a.doc.dispatchEvent(new a.doc.defaultView.Event('fullscreenchange'));
 assert.equal(a.context.readerFocused,false);assert.equal(a.context.nativeReaderFullscreen,false);
});
test('a user can exit while a fullscreen request is pending without being trapped or reopened',async()=>{
 const a=app({native:true,deferred:true});const pending=a.context.toggleReaderFocus();await a.context.toggleReaderFocus();assert.equal(a.context.readerFocused,false);
 a.finish();await pending;assert.equal(a.context.readerFocused,false);assert.equal(a.doc.fullscreenElement,null);assert.equal(a.calls.exited,1);
});
test('F and Escape toggle the view; typing and Ctrl-F retain their existing behavior',async()=>{
 const a=app();const key=(value,target,ctrlKey=false)=>({key:value,target,ctrlKey,preventDefault(){}});
 a.context.handleKey(key('f',{tagName:'INPUT'}));assert.equal(a.context.readerFocused,false);
 a.context.handleKey(key('f',{tagName:'DIV'}));assert.equal(a.context.readerFocused,true);
 a.context.handleKey(key('f',{tagName:'DIV'},true));assert.deepEqual(a.calls.search,['search']);
 a.context.handleKey(key('Escape',{tagName:'DIV'}));assert.equal(a.context.readerFocused,false);
});
test('floating toolbar stays compact without duplicate TTS or relocated zoom controls',async()=>{
 const a=app();a.r.zoom=1;
 Object.assign(a.context,{icon,$$:(selector,root)=>[...root.querySelectorAll(selector)],bindToolbarDrag(){},updateToolbarState(){},applyToolbarPosition(){}});
 const toolbar=appSource.slice(appSource.indexOf('function toolbarButton('),appSource.indexOf('function updateToolbarState()'));
 new vm.Script(toolbar+'renderToolbar();').runInContext(a.context);
 assert.deepEqual([...a.doc.querySelectorAll('#toolbar [data-action]')].map(button=>button.dataset.action),['select','pen','highlight','underline','eraser','note','palette','undo','redo','more']);
 assert.ok(a.doc.querySelector('#toolbar .toolbar-grip'));
 assert.equal(a.doc.querySelector('#toolbar [data-action=zoom]'),null);
 assert.equal(a.doc.querySelector('#toolbar [data-action=speak]'),null);
 const css=await readFile(new URL('../public/design.tailwind.css',import.meta.url),'utf8');
 assert.match(css,/\.floating-toolbar\{height:auto;min-height:0;padding:0 1px;gap:0/);
 assert.match(css,/#app\.reader-focus>\.chrome/);
 assert.doesNotMatch(html,/chrome-topline/);
 assert.match(css,/\.addressbar\{height:24px;min-height:0;padding:0;margin:0\}/);
});

test('document focus is entered through a document double-click, without a separate screen button',()=>{
 assert.doesNotMatch(html,/id="reader-fullscreen"/);
 assert.doesNotMatch(appSource,/reader-fullscreen/);
});
test('upper reading controls preserve the open popover until their click can toggle it',()=>{
 const a=app(),pop=a.doc.querySelector('#tool-popover');pop.hidden=false;
 const controls=a.doc.createElement('div');controls.setAttribute('data-htmlmemo-reading-controls','');controls.innerHTML='<button>100%</button>';a.doc.querySelector('#app').append(controls);
 vm.runInContext(appSource.match(/^  document.addEventListener\('keydown',handleKey\);document.addEventListener\('pointerdown'.*$/m)[0],a.context);
 controls.firstElementChild.dispatchEvent(new a.doc.defaultView.Event('pointerdown',{bubbles:true}));assert.equal(pop.hidden,false);
 a.doc.body.dispatchEvent(new a.doc.defaultView.Event('pointerdown',{bubbles:true}));assert.equal(pop.hidden,true,'outside clicks still dismiss the popover');
});
test('more tools contain no duplicated toolbar, sidebar, bookmark or export actions and preserve drawing tools',()=>{
 const a=app(),selected=[];a.r.setTool=tool=>selected.push(tool);
 Object.assign(a.context,{icon,$$:(selector,root)=>[...root.querySelectorAll(selector)],safely:fn=>fn,updateToolbarState(){},
   showPopover(name,html,bind){a.doc.querySelector('#tool-popover').innerHTML=html;a.doc.querySelector('#tool-popover').hidden=false;bind();}});
 const code=appSource.slice(appSource.indexOf('function toolAction('),appSource.indexOf('function bindToolbarDrag('));
 new vm.Script('var sidebarMode="";'+code).runInContext(a.context);a.context.toolAction('more');
 const ids=()=>[...a.doc.querySelectorAll('[data-more]')].map(b=>b.dataset.more);
 const expected=['rect','ellipse','arrow','strike','history','migrate','info'];
 assert.deepEqual(ids(),['sidebar',...expected]);assert.equal(new Set(ids()).size,ids().length);
 for(const removed of ['search','outline','annotations','undo','redo','bookmark','connect','area','area-underline','text','clear'])assert.equal(a.doc.querySelector(`[data-more=${removed}]`),null);
 a.doc.querySelector('[data-more=rect]').onclick();assert.deepEqual(selected,['rect']);assert.equal(a.doc.querySelector('#tool-popover').hidden,true);
 a.context.toolAction('more');a.doc.querySelector('[data-more=sidebar]').onclick();assert.deepEqual(a.calls.search,['search']);
 a.doc.querySelector('#sidebar').hidden=false;a.context.toolAction('more');assert.deepEqual(ids(),expected,'an already open panel needs no duplicate entry');
 a.doc.querySelector('#sidebar').hidden=true;a.r.documentSidebarUI=a.doc.createElement('section');a.doc.body.append(a.r.documentSidebarUI);a.context.toolAction('more');assert.deepEqual(ids(),expected,'native books use their own sidebar');
 assert.ok(a.doc.querySelector('#save-page'));assert.ok(a.doc.querySelector('.addressbar #settings-button'));
});
test('toolbar groups keep area and text variants in one tool with repeat-click, keyboard selection and no wider toolbar',()=>{
 const a=app();Object.assign(a.r,{tool:'select',zoom:1,color:'#edcf67',history:{canUndo:false,canRedo:false}});
 const original=a.r.metadata.annotations,chosen=[];a.r.setTool=tool=>{a.r.tool=tool;chosen.push(tool);};
 Object.assign(a.context,{icon,$$:(selector,root=a.doc)=>[...root.querySelectorAll(selector)],safely:fn=>fn,bindToolbarDrag(){},
   showPopover(name,html,bind){const pop=a.doc.querySelector('#tool-popover');pop.innerHTML=html;pop.hidden=false;a.context.popoverName=name;bind();}});
 const controls=appSource.slice(appSource.indexOf('function toolbarButton('),appSource.indexOf('function positionPopover('));
 const actions=appSource.slice(appSource.indexOf('function toolAction('),appSource.indexOf('function bindToolbarDrag('));
 vm.runInContext('var popoverName="",sidebarMode="";'+controls+actions+'renderToolbar();',a.context);
 const button=action=>a.doc.querySelector(`#toolbar [data-action=${action}]`),pop=a.doc.querySelector('#tool-popover');
 const count=a.doc.querySelectorAll('#toolbar button').length;
 for(const [group,variant] of [['highlight','area'],['underline','area-underline'],['note','text']]){
   button(group).onclick();assert.equal(a.r.tool,group);assert.equal(pop.hidden,true,'first click keeps normal tool activation');
   button(group).onclick();assert.equal(pop.hidden,false);assert.equal(a.r.tool,group,'opening options does not create or change an annotation');
   assert.equal(pop.querySelectorAll('[role=menuitemradio]').length,2);assert.equal(button(group).getAttribute('aria-expanded'),'true');
   pop.querySelector(`[data-tool-mode=${variant}]`).onclick();assert.equal(a.r.tool,variant);assert.equal(pop.hidden,true);
   assert.equal(button(group).getAttribute('aria-pressed'),'true');assert.equal(button(group).getAttribute('aria-expanded'),'false');
   assert.match(button(group).getAttribute('aria-label'),variant==='text'?/자유 텍스트/:/영역/);
   a.context.toolAction('pen');button(group).onclick();assert.equal(a.r.tool,variant,'reactivation remembers this document’s last mode');
   a.context.toolAction(group);assert.equal(a.r.tool,group,'the existing keyboard shortcut still chooses its original tool');
 }
 a.context.toolAction('pen');const trigger=button('highlight');let focused;
 Object.defineProperty(a.doc,'activeElement',{get:()=>focused,configurable:true});trigger.focus=()=>{focused=trigger;};
 trigger.onkeydown({key:'ArrowDown',preventDefault(){},stopPropagation(){}});
 const items=[...pop.querySelectorAll('[data-tool-mode]')];items.forEach(item=>item.focus=()=>{focused=item;});focused=items[0];
 pop.onkeydown({key:'ArrowDown',preventDefault(){},stopPropagation(){}});assert.strictEqual(focused,items[1]);
 pop.onkeydown({key:'Escape',preventDefault(){},stopPropagation(){}});assert.strictEqual(focused,trigger);assert.equal(pop.hidden,true);assert.equal(a.r.tool,'pen');
 assert.equal(a.doc.querySelectorAll('#toolbar button').length,count);assert.strictEqual(a.r.metadata.annotations,original);assert.ok(chosen.includes('area')&&chosen.includes('area-underline')&&chosen.includes('text'));
 a.context.toolAction('eraser');button('eraser').onclick();const clear=pop.querySelector('[data-tool-mode=clear]');
 assert.equal(clear.getAttribute('role'),'menuitem');assert.equal(clear.hasAttribute('aria-checked'),false);assert.equal(clear.disabled,false);
 a.r.metadata.annotations=[];a.context.closePopover();button('eraser').onclick();assert.equal(pop.querySelector('[data-tool-mode=clear]').disabled,true);
});
test('selected text takes priority over repeat-click mode selection for both text annotation tools',()=>{
 const a=app(),chosen=[];Object.assign(a.r,{tool:'select',zoom:1,color:'#edcf67',history:{canUndo:false,canRedo:false}});
 a.r.setTool=tool=>{a.r.tool=tool;chosen.push({tool,quote:a.r.selection?.quote});a.r.selection=null;};
 Object.assign(a.context,{icon,$$:(selector,root=a.doc)=>[...root.querySelectorAll(selector)],safely:fn=>fn,bindToolbarDrag(){},
   showPopover(name,html,bind){const pop=a.doc.querySelector('#tool-popover');pop.innerHTML=html;pop.hidden=false;a.context.popoverName=name;bind();}});
 const controls=appSource.slice(appSource.indexOf('function toolbarButton('),appSource.indexOf('function positionPopover('));
 const actions=appSource.slice(appSource.indexOf('function toolAction('),appSource.indexOf('function bindToolbarDrag('));
 vm.runInContext('var popoverName="",sidebarMode="";'+controls+actions+'renderToolbar();',a.context);
 const pop=a.doc.querySelector('#tool-popover');
 for(const [group,variant] of [['highlight','area'],['underline','area-underline']]){
   const button=a.doc.querySelector(`#toolbar [data-action=${group}]`);
   for(const current of ['select',group,group,variant]){
     a.context.toolAction(current);a.r.selection={quote:'New selected text'};
     button.onclick();assert.deepEqual(chosen.at(-1),{tool:group,quote:'New selected text'});
     assert.equal(pop.hidden,true,'repeated selections apply annotations without opening options');
   }
   button.onclick();assert.equal(pop.hidden,false,'without a new selection, repeat click opens the options');
   a.context.closePopover();a.r.selection={quote:'Still selected'};const before=chosen.length;
   button.onkeydown({key:'ArrowDown',preventDefault(){},stopPropagation(){}});
   assert.equal(pop.hidden,false);assert.equal(chosen.length,before,'keyboard options never apply a pending selection');
   a.context.closePopover();a.r.selection=null;
 }
});
test('saved history, document transfer and freehand area underline have distinct icons from basic toolbar actions',()=>{
 assert.notEqual(icon('history'),icon('undo'));assert.notEqual(icon('file-transfer'),icon('file'));assert.notEqual(icon('area-underline'),icon('underline'));
 assert.match(appSource,/\['history','history','주석 저장 이력'\]/);assert.match(appSource,/\['info','info','문서 정보'\]/);
});

test('document tools and palette window provide an explicit close button and full color selection controls',()=>{
 assert.match(appSource,/data-popover-close aria-label="문서 도구 닫기"/);
 assert.match(appSource,/data-popover-close aria-label="펜과 색상 닫기"/);
 assert.match(appSource,/id="palette-preset"/);
 assert.match(appSource,/id="add-custom-color"/);
 assert.match(appSource,/id="save-custom-palette"/);
 assert.match(appSource,/id="color-picker-sv"/);
 assert.match(appSource,/id="color-picker-hue"/);
 assert.match(appSource,/id="color-hex"/);
 assert.match(appSource,/\$\('\[data-popover-close\]'\s*,\$\('#tool-popover'\)\)\.onclick=closePopover/);
});

test('pen width, highlighter opacity and pen lifetime precede every palette in the pen and color panel',()=>{
 const palette=appSource.slice(appSource.indexOf('function renderPalettePopoverContent('),appSource.indexOf('  positionPopover();',appSource.indexOf('function renderPalettePopoverContent(')));
 const controls=['id="pen-width"','id="pen-opacity"','id="pen-ttl"','시간을 정한 펜은','id="palette-preset"','id="custom-swatches"','id="color-picker-sv"'];
 const positions=controls.map(id=>palette.indexOf(id));
 assert.ok(positions.every(position=>position>=0));
 assert.deepEqual(positions,[...positions].sort((a,b)=>a-b));
 for(const id of controls.slice(0,3))assert.equal(palette.split(id).length-1,1,'moved controls must not be duplicated');
});

test('palette title dragging captures one pointer, clamps its position and excludes controls and other popovers',()=>{
 const a=app(),pop=a.doc.querySelector('#tool-popover');pop.hidden=false;pop.classList.add('palette-popover');
 pop.innerHTML='<div data-palette-drag tabindex="0"><h3>펜과 색상</h3><button>닫기</button></div><input type="range">';
 Object.defineProperties(pop,{offsetWidth:{value:320},offsetHeight:{value:600}});
 let height=600;pop.style.left='100px';pop.style.top='80px';pop.getBoundingClientRect=()=>({left:parseFloat(pop.style.left),top:parseFloat(pop.style.top),width:320,height});
 a.doc.querySelector('#toolbar').getBoundingClientRect=()=>({left:500,width:400,top:740,bottom:760});
 let captured=null,prevented=0;pop.setPointerCapture=id=>{captured=id;};pop.hasPointerCapture=id=>captured===id;pop.releasePointerCapture=id=>{assert.equal(captured,id);captured=null;};
 Object.assign(a.context,{innerWidth:1280,innerHeight:800});
 vm.runInContext(appSource.slice(appSource.indexOf('function positionPopover('),appSource.indexOf('function showPopover('))+'bindPaletteDrag(document.querySelector("#tool-popover"));',a.context);
 const pointer=(type,target,extra={})=>{const event=new a.doc.defaultView.Event(type,{bubbles:true});Object.assign(event,{pointerId:1,button:0,isPrimary:true,clientX:120,clientY:100,...extra});event.preventDefault=()=>prevented++;target.dispatchEvent(event);};
 const title=pop.querySelector('h3'),header=pop.querySelector('[data-palette-drag]');
 for(const target of pop.querySelectorAll('button,input'))pointer('pointerdown',target);
 pointer('pointerdown',title,{button:2});pointer('pointerdown',title,{isPrimary:false});assert.equal(captured,null);assert.equal(prevented,0);
 pointer('pointerdown',title);assert.equal(captured,1);assert.equal(pop.classList.contains('palette-dragging'),true);
 pointer('pointerdown',title,{pointerId:2});pointer('pointermove',pop,{pointerId:2,clientX:700});assert.equal(pop.style.left,'100px');assert.equal(captured,1);
 pointer('pointermove',pop,{clientX:220,clientY:140});assert.equal(pop.style.left,'200px');assert.equal(pop.style.top,'120px');
 pointer('pointermove',pop,{clientX:-1000,clientY:-1000});assert.equal(pop.style.left,'10px');assert.equal(pop.style.top,'8px');
 pointer('pointermove',pop,{clientX:3000,clientY:3000});assert.equal(pop.style.left,'950px');assert.equal(pop.style.top,'192px');
 pointer('pointerup',pop);assert.equal(captured,null);assert.equal(pop.classList.contains('palette-dragging'),false);
 pointer('pointermove',pop,{clientX:0,clientY:0});assert.equal(pop.style.left,'950px');
 const position=JSON.stringify(pop.palettePosition);pop.classList.remove('palette-popover');a.context.positionPopover();assert.notEqual(pop.style.left,'950px');assert.equal(JSON.stringify(pop.palettePosition),position);
 pointer('pointerdown',title);assert.equal(captured,null,'other tool windows cannot be dragged');
 pop.classList.add('palette-popover');a.context.positionPopover();assert.equal(pop.style.left,'950px');
 const key=new a.doc.defaultView.Event('keydown',{bubbles:true});Object.assign(key,{key:'ArrowLeft',shiftKey:true});header.dispatchEvent(key);assert.equal(pop.style.left,'910px');
 pointer('pointerdown',title);pointer('pointercancel',pop);assert.equal(captured,null);
 pointer('pointerdown',title);pop.cancelPaletteDrag();assert.equal(captured,null);assert.equal(pop.classList.contains('palette-dragging'),false);
 a.context.innerWidth=640;a.context.innerHeight=720;a.context.positionPopover();assert.equal(pop.style.left,'310px');assert.equal(pop.style.top,'112px');
 height=600.1875;a.context.positionPopover();assert.equal(pop.style.top,'111.8125px','fractional rendered height is not rounded through offsetHeight');
});

test('opening a local document does not create the app outline sidebar',()=>{
 const openRecord=appSource.slice(appSource.indexOf('async function openRecord('),appSource.indexOf('function saveStatus('));
 assert.doesNotMatch(openRecord,/await tab\.reader\.ready;[\s\S]*renderSidebar\('outline'\);[\s\S]*updateChrome\(\)/);
});


test('reader panes use all available horizontal width without app gutters',async()=>{
 const a=app(),r=Object.create(Reader.prototype),host=a.doc.createElement('div');a.doc.querySelector('#workspaces').append(host);
 r.host=host;r.viewport={clientWidth:1000};r.naturalWidth=1000;
 assert.equal(r.fitZoom(),1);a.root.classList.add('reader-focus');assert.equal(r.fitZoom(),1);
 const css=await readFile(new URL('../public/design.tailwind.css',import.meta.url),'utf8');
 assert.match(css,/\.reader-viewport\{height:100%;width:100%;overflow:auto;padding:25px 0 100px;/);
 assert.match(css,/\.reader-viewport\{padding:15px 0 90px\}/);
});

test('reader saves whether its zoom follows the available reader width',()=>{
 const r=Object.create(Reader.prototype);r.metadata={view:{}};r.zoom=.85;r.autoFit=true;r.callbacks={};
 Object.defineProperties(r,{scrollTop:{get:()=>120},scrollLeft:{get:()=>40}});
 r.rememberPosition();assert.deepEqual(r.metadata.view,{scrollTop:120,scrollLeft:40,zoom:.85,autoFit:true});
 r.autoFit=false;r.rememberPosition();assert.equal(r.metadata.view.autoFit,false);
});

test('unchanged reading positions do not schedule another save',()=>{
 const r=Object.create(Reader.prototype);let changes=0,top=120;
 r.metadata={view:{}};r.zoom=1;r.autoFit=true;r.callbacks={onPosition:()=>changes++};
 Object.defineProperties(r,{scrollTop:{get:()=>top},scrollLeft:{get:()=>0}});
 assert.equal(r.rememberPosition(),true);assert.equal(r.rememberPosition(),false);assert.equal(changes,1);
 top=150;assert.equal(r.rememberPosition(),true);r.tocResizedWidth=300;assert.equal(r.rememberPosition(),true);
 assert.equal(r.rememberPosition(),false);assert.equal(changes,3);assert.equal(r.metadata.view.tocWidth,300);
});

test('reopening at a different sidebar width restores the same document coordinates',()=>{
 const r=Object.create(Reader.prototype);r.metadata={view:{scrollTop:490,scrollLeft:49,zoom:.98}};r.zoom=1.28;
 Object.defineProperties(r,{scrollTop:{value:0,writable:true},scrollLeft:{value:0,writable:true}});
 const before=structuredClone(r.metadata);r.restoreOpeningPosition();
 assert.equal(r.scrollTop,640);assert.equal(r.scrollLeft,64);assert.deepEqual(r.metadata,before);
 r.openingScroll={top:125,left:25};r.restoreOpeningPosition();assert.equal(r.scrollTop,160);assert.equal(r.scrollLeft,32);
 r.openingScroll=null;delete r.metadata.view.zoom;r.restoreOpeningPosition();assert.equal(r.scrollTop,490);assert.equal(r.scrollLeft,49);
});

test('sidebar width changes preserve reading coordinates for native and outer scrolling',()=>{
 for(const nativeScroll of [false,true]){
  const r=Object.create(Reader.prototype);Object.defineProperties(r,{scrollTop:{value:640,writable:true},scrollLeft:{value:64,writable:true}});
  r.zoom=1.28;r.autoFit=true;r.nativeScroll=nativeScroll;r.fitZoom=()=>.98;let applied=0;r.applyZoom=()=>applied++;
  r.resizeViewport();assert.equal(r.zoom,.98);assert.equal(r.scrollTop,490);assert.equal(r.scrollLeft,49);assert.equal(applied,1);
  r.autoFit=false;r.resizeViewport();assert.equal(r.zoom,.98);assert.equal(r.scrollTop,490);assert.equal(applied,nativeScroll?2:1);
 }
});


test('rapid reentry waits for browser fullscreen exit to settle',async()=>{
 const a=app({native:true,exitDeferred:true});await a.context.toggleReaderFocus();
 const exit=a.context.toggleReaderFocus();await a.context.toggleReaderFocus();assert.equal(a.calls.requested,1);
 a.finishExit();await exit;assert.equal(a.context.focusBusy,false);assert.equal(a.context.readerFocused,false);
});


test('blank pane double-click enters focus while word selection, controls and links retain their actions',async()=>{
 const a=app(),r=Object.create(Reader.prototype);let prevented=0;
 r.callbacks={onDocumentFocus:()=>{if(!a.context.readerFocused)void a.context.toggleReaderFocus();}};
 const doc=new DOMParser().parseFromString('<html><head></head><body><p>Document text</p><a href="#chapter">Link</a><input><span data-htmlmemo-id="note">Note</span></body></html>','text/html');
 r.textAtClick=event=>event.target===doc.querySelector('p')?{unknown:true}:null;
 const click=target=>r.focusDocument({target,button:0,preventDefault(){prevented++;}});
 const original=a.r.metadata.annotations;click(doc.querySelector('p'));assert.equal(a.context.readerFocused,false);assert.strictEqual(a.r.metadata.annotations,original);
 click(doc.body);assert.equal(a.context.readerFocused,true);assert.equal(prevented,1);
 await a.context.leaveReaderFocus();for(const target of doc.querySelectorAll('a,input,[data-htmlmemo-id]'))click(target);assert.equal(a.context.readerFocused,false);assert.equal(prevented,1);
 r.disposed=true;click(doc.body);assert.equal(a.context.readerFocused,false);
});

test('sidebar double-click keeps normal and fullscreen views unchanged without cancelling native sidebar actions',()=>{
 const r=Object.create(Reader.prototype),doc=new DOMParser().parseFromString('<html><head></head><body><header><span>Original header</span></header><div id="menu-shell"><section id="book-menu"><h2><span>목차</span></h2><details><summary><span>1부</span></summary><p>목차 항목</p></details><section data-htmlmemo-doc-sidebar-ui><div class="sidebar-views"><button><svg><path></path></svg></button></div><div class="sidebar-content"><p>빈 주석 목록</p></div></section></section></div><aside><span>Aside</span></aside><nav><span>Navigation</span></nav><div role="navigation"><span>Navigation role</span></div><div class="sidebar"><span>App sidebar</span></div><div data-htmlmemo-native-sidebar><span>Native sidebar</span></div><main><p>본문</p></main></body></html>','text/html');
 let focused=false,calls=0,prevented=0;const annotations=[{id:'keep',text:'주석 보존'}];r.metadata={annotations};
 r.tocResize={sidebar:doc.querySelector('#book-menu'),sidebarItem:doc.querySelector('#menu-shell')};r.topbarNode=doc.querySelector('header');
 r.callbacks={onDocumentFocus(){focused=!focused;calls++;}};
 const click=target=>r.focusDocument({target,button:0,preventDefault(){prevented++;}});
 const roots=[doc.querySelector('#menu-shell'),...doc.querySelectorAll('aside,nav,[role="navigation"],.sidebar,[data-htmlmemo-native-sidebar]')];
 for(const initial of [false,true]){focused=initial;for(const root of roots)for(const node of [root,...root.querySelectorAll('*')])click(node);click(doc.querySelector('#book-menu h2 span').firstChild);assert.equal(focused,initial);}
 assert.equal(calls,0);assert.equal(prevented,0);assert.strictEqual(r.metadata.annotations,annotations);
 focused=false;click(doc.querySelector('main p'));assert.equal(focused,true);click(doc.querySelector('main'));assert.equal(focused,false);
 click(doc.querySelector('header span'));assert.equal(focused,true,'the original source header behavior is unchanged');assert.equal(prevented,3);
 assert.equal(r.isInsideTocOrTopbar(doc.querySelector('header span')),true);assert.equal(r.isInsideTocOrTopbar(doc.querySelector('#book-menu p')),true);
});

test('sidebar resizer double-click still resets its width instead of toggling fullscreen',()=>{
 const r=Object.create(Reader.prototype);let reset=0,focused=0,prevented=0,stopped=0;
 r.isTocResizeTarget=()=>true;r.resetTocWidth=()=>reset++;r.callbacks={onDocumentFocus:()=>focused++};
 const event={button:0,preventDefault(){prevented++;},stopPropagation(){stopped++;},stopImmediatePropagation(){stopped++;}};
 if(!r.handleTocDblClick(event))r.focusDocument(event);
 assert.equal(reset,1);assert.equal(focused,0);assert.equal(prevented,1);assert.equal(stopped,2);
});


test('full pane focus fits even a saved manual zoom and restores it on exit',()=>{
 const a=app(),r=Object.create(Reader.prototype),host=a.doc.createElement('div');a.doc.querySelector('#workspaces').append(host);
 r.host=host;r.viewport={clientWidth:1600};r.naturalWidth=1000;r.zoom=.5;r.autoFit=false;
 r.setZoom=function(value,fit){this.autoFit=fit;this.zoom=fit?this.fitZoom():value;};r.measure=()=>{};
 const prior=globalThis.innerWidth;globalThis.innerWidth=1600;
 try{a.root.classList.add('reader-focus');r.setFocusLayout(true);assert.equal(r.zoom,1.6);assert.equal(r.autoFit,true);
 r.viewport.clientWidth=1800;r.setFocusLayout(true);assert.equal(r.zoom,1.8);
 a.root.classList.remove('reader-focus');r.setFocusLayout(false);assert.equal(r.zoom,.5);assert.equal(r.autoFit,false);}
 finally{if(prior===undefined)delete globalThis.innerWidth;else globalThis.innerWidth=prior;}
});
