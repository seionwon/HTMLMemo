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
 const r={doc:{},metadata,measure(){calls.measured++;},setTool(){}};
 let finish,finishExit;
 doc.exitFullscreen=async()=>{calls.exited++;if(exitDeferred)await new Promise(resolve=>finishExit=resolve);doc.fullscreenElement=null;doc.dispatchEvent(new doc.defaultView.Event('fullscreenchange'));};
 if(native)root.requestFullscreen=async()=>{calls.requested++;if(rejected)throw Error('Permission denied');if(deferred)await new Promise(resolve=>finish=resolve);doc.fullscreenElement=root;doc.dispatchEvent(new doc.defaultView.Event('fullscreenchange'));};
 const context=vm.createContext({document:doc,$:selector=>doc.querySelector(selector),reader:()=>r,requestAnimationFrame:fn=>fn(),applyToolbarPosition(){},closePopover(){doc.querySelector('#tool-popover').hidden=true;},closeSidebar(){doc.querySelector('#sidebar').hidden=true;},renderSidebar:value=>calls.search.push(value)});
 new vm.Script('var readerFocused=false,nativeReaderFullscreen=false,focusBusy=false;'+functions+'\n'+listener).runInContext(context);
 return {context,doc,root,r,calls,finish:()=>finish(),finishExit:()=>finishExit()};
}
test('document focus works without browser fullscreen and keeps annotation tools/dialogs in its shell',async()=>{
 const a=app();const notes=a.r.metadata.annotations;
 await a.context.toggleReaderFocus();assert.equal(a.context.readerFocused,true);assert.ok(a.root.classList.contains('reader-focus'));
 assert.equal(a.doc.querySelector('#reader-fullscreen').getAttribute('aria-pressed'),'true');
 assert.ok(a.root.contains(a.doc.querySelector('#toolbar')));assert.ok(a.root.contains(a.doc.querySelector('#dialog')));
 assert.strictEqual(a.r.metadata.annotations,notes);assert.equal(a.calls.requested,0);
 await a.context.toggleReaderFocus();assert.equal(a.context.readerFocused,false);assert.equal(a.doc.querySelector('#reader-fullscreen').textContent,'전체 화면');
});
test('native fullscreen targets the app shell and exit restores the document view',async()=>{
 const a=app({native:true});await a.context.toggleReaderFocus();assert.strictEqual(a.doc.fullscreenElement,a.root);assert.equal(a.context.nativeReaderFullscreen,true);
 await a.context.leaveReaderFocus();assert.equal(a.calls.exited,1);assert.equal(a.context.readerFocused,false);assert.equal(a.doc.fullscreenElement,null);
});
test('a denied browser fullscreen request retains usable document focus',async()=>{
 const a=app({native:true,rejected:true});await a.context.toggleReaderFocus();assert.equal(a.context.readerFocused,true);assert.equal(a.context.focusBusy,false);assert.equal(a.context.nativeReaderFullscreen,false);
 await a.context.leaveReaderFocus();assert.equal(a.context.readerFocused,false);assert.equal(a.calls.exited,0);
});
test('browser Escape/fullscreenchange clears focus and restores the exit button',async()=>{
 const a=app({native:true});await a.context.toggleReaderFocus();a.doc.fullscreenElement=null;a.doc.dispatchEvent(new a.doc.defaultView.Event('fullscreenchange'));
 assert.equal(a.context.readerFocused,false);assert.equal(a.context.nativeReaderFullscreen,false);assert.equal(a.doc.querySelector('#reader-fullscreen').getAttribute('aria-pressed'),'false');
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
test('toolbar button markup remains unchanged; only outside spacing is compacted',async()=>{
 const a=app();a.r.zoom=1;
 Object.assign(a.context,{icon,$$:(selector,root)=>[...root.querySelectorAll(selector)],bindToolbarDrag(){},updateToolbarState(){},applyToolbarPosition(){}});
 const toolbar=appSource.slice(appSource.indexOf('function toolbarButton('),appSource.indexOf('function updateToolbarState()'));
 new vm.Script(toolbar+'renderToolbar();').runInContext(a.context);
 assert.deepEqual([...a.doc.querySelectorAll('#toolbar [data-action]')].map(button=>button.dataset.action),['select','pen','highlight','underline','eraser','note','palette','undo','redo','zoom','more']);
 assert.ok(a.doc.querySelector('#toolbar .toolbar-grip'));
 assert.equal(a.doc.querySelector('#toolbar [data-action=zoom]').textContent,'100%');
 const css=await readFile(new URL('../public/design.tailwind.css',import.meta.url),'utf8');
 assert.match(css,/\.floating-toolbar\{height:auto;min-height:0;padding:0 1px;gap:0/);
 assert.match(css,/#app\.reader-focus>\.chrome/);
});


test('fitting a focused pane uses its full width without the normal reader margins',()=>{
 const a=app(),r=Object.create(Reader.prototype),host=a.doc.createElement('div');a.doc.querySelector('#workspaces').append(host);
 r.host=host;r.viewport={clientWidth:1000};r.naturalWidth=1000;
 const prior=globalThis.innerWidth;globalThis.innerWidth=1200;
 try{assert.equal(r.fitZoom(),.944);a.root.classList.add('reader-focus');assert.equal(r.fitZoom(),1);}
 finally{if(prior===undefined)delete globalThis.innerWidth;else globalThis.innerWidth=prior;}
});


test('rapid reentry waits for browser fullscreen exit to settle',async()=>{
 const a=app({native:true,exitDeferred:true});await a.context.toggleReaderFocus();
 const exit=a.context.toggleReaderFocus();await a.context.toggleReaderFocus();assert.equal(a.calls.requested,1);
 a.finishExit();await exit;assert.equal(a.context.focusBusy,false);assert.equal(a.context.readerFocused,false);
});


test('document and blank pane double-click enter focus without changing annotations; controls and links retain their actions',async()=>{
 const a=app(),r=Object.create(Reader.prototype);let prevented=0;
 r.callbacks={onDocumentFocus:()=>{if(!a.context.readerFocused)void a.context.toggleReaderFocus();}};
 const doc=new DOMParser().parseFromString('<html><head></head><body><p>Document text</p><a href="#chapter">Link</a><input><span data-htmlmemo-id="note">Note</span></body></html>','text/html');
 const click=target=>r.focusDocument({target,button:0,preventDefault(){prevented++;}});
 const original=a.r.metadata.annotations;click(doc.querySelector('p'));assert.equal(a.context.readerFocused,true);assert.strictEqual(a.r.metadata.annotations,original);
 click(doc.body);assert.equal(a.context.readerFocused,true);assert.equal(prevented,2);
 await a.context.leaveReaderFocus();for(const target of doc.querySelectorAll('a,input,[data-htmlmemo-id]'))click(target);assert.equal(a.context.readerFocused,false);assert.equal(prevented,2);
 r.disposed=true;click(doc.body);assert.equal(a.context.readerFocused,false);
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
