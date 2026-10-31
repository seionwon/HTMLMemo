import test from 'node:test';
import assert from 'node:assert/strict';
import {Reader} from '../public/src/reader.js';
import {parseHTML,serializeHTML,textIndex} from '../public/src/document.js';
import {documentFor,installDOM} from './dom.mjs';
installDOM();
function fixture(header=''){
  const outer=documentFor('<html><head></head><body><div id="host"><div class="reader-viewport"></div></div></body></html>');
  const doc=documentFor('<html><head></head><body>'+header+'<main><p data-htmlmemo-anchor="n0">본문 그대로 보존.</p></main></body></html>');
  const r=Object.create(Reader.prototype),calls=[];
  Object.assign(r,{host:outer.querySelector('#host'),doc,zoom:1.25,topbarNode:doc.querySelector('header'),metadata:{annotations:[],view:{}},callbacks:{onReadingAction:(action,node)=>calls.push({action,node})}});
  return {r,doc,outer,calls};
}
test('speaker is immediately before A− while zoom and source font handlers stay intact',()=>{
  const {r,doc,calls}=fixture('<header class="topbar"><strong>책</strong><div class="controls"><button id="prev">‹</button><button id="font">A−</button><button>A+</button></div></header>');
  const font=doc.querySelector('#font'),handler=()=>{};font.onclick=handler;
  const text=textIndex(doc).text;r.setupReadingControls();
  assert.equal(r.readingControls.parentElement,doc.querySelector('.controls'));
  assert.equal(r.zoomControl.textContent,'125%');assert.equal(doc.querySelectorAll('[data-action=zoom]').length,1);
  assert.equal(doc.querySelectorAll('[data-action=speak]').length,1);assert.strictEqual(font.onclick,handler);
  assert.equal(font.previousElementSibling,r.speechControls);assert.equal(r.speechControls.previousElementSibling.id,'prev');
  assert.equal(r.speechControl.textContent,'');assert.ok(r.speechControl.querySelector('svg path'));assert.equal(r.speechControl.getAttribute('aria-label'),'소리내어 읽기 (TTS 툴바)');
  assert.equal(textIndex(doc).text,text);assert.equal(r.host.classList.contains('reader-controls-row'),false);
  r.zoomControl.onclick();assert.deepEqual(calls,[{action:'zoom',node:r.zoomControl}]);
  r.setupReadingControls();assert.equal(doc.querySelectorAll('[data-htmlmemo-reading-controls]').length,2);
});
test('plain documents copy the HTML reader header with its title, navigation, position and theme controls',()=>{
  const {r,doc,outer,calls}=fixture();r.setupReadingControls();
  assert.equal(r.host.firstElementChild,r.readingControls);assert.equal(r.host.classList.contains('reader-controls-row'),true);
  assert.deepEqual([...r.readingControls.querySelectorAll('button')].map(node=>node.dataset.action),['toggle-sidebar','reading-back','previous-heading','next-heading','speak','font-smaller','font-larger','zoom']);
  assert.equal(r.readingControls.classList.contains('reader-head'),true);assert.equal(r.plainReadingButtons.back.textContent,'↶');
  assert.equal(r.plainReadingButtons.previous.disabled,true);assert.equal(r.plainReadingButtons.next.disabled,true);assert.equal(r.plainReadingButtons.back.disabled,true);
  assert.equal(r.plainReadingButtons.previous.hidden,false);assert.equal(r.plainReadingButtons.next.hidden,false);
  assert.equal(r.plainReadingButtons.position.textContent,'0 / 0');assert.equal(r.plainReadingButtons.title.textContent,doc.title);
  assert.deepEqual([...r.plainReadingButtons.theme.querySelectorAll('option')].map(option=>[option.value,option.textContent]),[['system','시스템'],['light','밝게'],['dark','어둡게']]);
  assert.equal(r.speechControl.nextElementSibling,r.plainReadingButtons.smaller);
  assert.ok(r.speechControl.querySelector('svg'));assert.equal(r.speechControls.isConnected,false);
  assert.equal(r.readingControls.ownerDocument,outer);assert.equal(doc.querySelector('[data-htmlmemo-reading-controls]'),null);
  r.speechControl.onclick();assert.deepEqual(calls,[{action:'speak',node:r.speechControl}]);
  r.zoom=.2;r.updateReadingControls();assert.equal(r.zoomControl.textContent,'20%');
  r.zoom=8;r.updateReadingControls();assert.equal(r.zoomControl.textContent,'800%');
  const sidebar=outer.createElement('aside');sidebar.id='sidebar';sidebar.annotationReader=r;outer.body.append(sidebar);r.updateReadingControls();assert.equal(r.plainReadingButtons.menu.getAttribute('aria-expanded'),'true');
  sidebar.annotationReader={};r.updateReadingControls();assert.equal(r.plainReadingButtons.menu.getAttribute('aria-expanded'),'false');
});

test('article headers, site navigation, search forms and hidden controls never replace the complete book toolbar',()=>{
  for(const header of ['<header class="header"><strong>문서 제목</strong><input type="search"><button>검색</button></header>','<header class="book-header"><h1>글 제목</h1></header>','<form><input type="search"><button>검색</button></form>','<div class="toolbar"><button>공유</button></div>','<header class="topbar" hidden><button>A+</button></header>']){
    const {r,doc}=fixture(header);r.outline=()=>[];r.setupReadingControls();r.setupReadingControls();
    assert.ok(r.plainReadingButtons);assert.equal(r.readingControls.parentElement,r.host);
    assert.deepEqual([...r.readingControls.querySelectorAll('button')].map(node=>node.dataset.action),['toggle-sidebar','reading-back','previous-heading','next-heading','speak','font-smaller','font-larger','zoom']);
    assert.equal(r.host.querySelectorAll('[data-htmlmemo-reading-controls]').length,1);assert.equal(doc.querySelector('[data-htmlmemo-reading-controls]'),null);
  }
});

test('copied theme controls save a bounded document setting and remove transient palette styles on export',()=>{
  const {r,doc}=fixture();Object.assign(r,{viewport:{scrollTop:0,scrollLeft:0},cancelAnnotationDrag(){},measure(){},renderDrawingLayer(){}});let writes=0;r.callbacks.onPosition=()=>writes++;
  r.setupReadingControls();const original=textIndex(doc).text;r.setReadingTheme('dark');assert.equal(writes,1);assert.equal(r.metadata.view.readingTheme,'dark');assert.equal(r.readingControls.dataset.theme,'dark');assert.equal(r.plainReadingButtons.theme.value,'dark');
  assert.match(doc.querySelector('#htmlmemo-reading-theme-style').textContent,/--htmlmemo-reader-paper:#14161b/);r.rememberPosition();assert.equal(r.metadata.view.readingTheme,'dark');assert.equal(r.setReadingTheme('not-a-theme'),false);
  const saved=serializeHTML(doc,r.metadata);assert.doesNotMatch(saved,/htmlmemo-reading-theme-style/);assert.equal(parseHTML(saved).metadata.view.readingTheme,'dark');assert.equal(textIndex(doc).text,original);
  const raw='<html><head><script id="htmlmemo-data" type="application/json">'+JSON.stringify({version:1,annotations:[],view:{readingTheme:'url(bad)'}})+'</script></head><body>본문</body></html>';assert.equal(Object.hasOwn(parseHTML(raw).metadata.view,'readingTheme'),false);
});

function headingFixture({short=false,count=3}={}){
  const a=fixture(),{r,doc}=a;let layoutReads=0;
  doc.querySelector('main').innerHTML=Array.from({length:count},(_,i)=>'<h2>제목 '+i+'</h2><p>그대로 남길 본문 '+i+'</p>').join('');
  Object.assign(r,{zoom:1,viewport:{scrollTop:0,scrollLeft:0,clientHeight:300,clientWidth:960},linkHistory:[],layerOrigin:()=>({top:0,left:0}),cancelAnnotationDrag(){}});
  if(short)Object.defineProperty(r.viewport,'scrollTop',{get:()=>0,set(){}});
  const nodes=[...doc.querySelectorAll('h2')];nodes.forEach((node,index)=>node.getBoundingClientRect=()=>{layoutReads++;return {top:40+index*1000,left:0,width:400,height:30};});
  r.setupReadingControls();return {...a,nodes,reads:()=>layoutReads};
}
test('plain heading navigation stops at both ends and returning restores the prior reading position',async()=>{
  const {r,nodes}=headingFixture(),{previous,next,back}=r.plainReadingButtons;
  assert.equal(previous.disabled,true);assert.equal(next.disabled,false);
  assert.equal(r.moveReadingHeading(-1),false);assert.equal(r.linkHistory.length,0);
  next.onclick();assert.equal(r.readingHeadingState().current,1);assert.equal(r.scrollTop,1028);assert.equal(previous.disabled,false);assert.equal(back.disabled,false);
  next.onclick();assert.equal(r.readingHeadingState().current,2);assert.equal(next.disabled,true);assert.equal(r.moveReadingHeading(1),false);assert.equal(r.linkHistory.length,2);
  await back.onclick();assert.equal(r.readingHeadingState().current,1);assert.equal(r.scrollTop,1028);await back.onclick();assert.equal(r.scrollTop,0);assert.equal(back.disabled,true);
  r.jump(nodes[2]);r.updateReadingControls();assert.equal(r.readingHeadingState().current,2);assert.equal(next.disabled,true);
  r.viewport.scrollTop=1100;r.updateReadingControls();assert.equal(r.readingHeadingState().current,1,'manual scrolling replaces the previous explicit heading');
});
test('short documents can step through every heading even when all fit on screen',async()=>{
  const {r}=headingFixture({short:true}),{previous,next,back}=r.plainReadingButtons;
  next.onclick();assert.equal(r.readingHeadingState().current,1);next.onclick();assert.equal(r.readingHeadingState().current,2);assert.equal(next.disabled,true);
  await back.onclick();assert.equal(r.readingHeadingState().current,1);previous.onclick();assert.equal(r.readingHeadingState().current,0);assert.equal(previous.disabled,true);assert.equal(r.scrollTop,0);
});
test('scrolling a long plain outline uses logarithmic geometry reads and no repeated heading scan',()=>{
  const {r,reads}=headingFixture({count:8192}),before=reads();r.viewport.scrollTop=6000040;
  r.outline=()=>{throw Error('the cached outline must not be rebuilt during scroll');};r.updateReadingControls();
  assert.equal(r.readingHeadingState().current,6000);assert.ok(reads()-before<30);
});
test('font changes preserve document text and annotations and save a bounded setting without exporting reader styles',()=>{
  const {r,doc}=fixture();r.metadata.annotations=[{id:'kept-note',type:'note',text:'기록',color:'#334155',width:3,opacity:1,points:[{x:10,y:20}]}];
  const writes=[];r.callbacks.onPosition=()=>writes.push(structuredClone(r.metadata.view));
  Object.assign(r,{autoFit:false,viewport:{scrollTop:0,scrollLeft:0},cancelAnnotationDrag(){},measure(){},renderDrawingLayer(){}});
  r.metadata.view={scrollTop:0,scrollLeft:0,zoom:r.zoom,autoFit:false};
  const before=textIndex(doc).text,notes=structuredClone(r.metadata.annotations),sourceBody=doc.body.getAttribute('style');r.setupReadingControls();
  r.plainReadingButtons.larger.onclick();assert.equal(r.metadata.view.fontScale,1.1);assert.match(doc.querySelector('#htmlmemo-reading-font-style').textContent,/19\.800px/);
  assert.equal(writes.length,1);assert.equal(writes[0].fontScale,1.1,'a font-only change at the same scroll and zoom must reach the writer');
  r.setupReadingControls();assert.match(doc.querySelector('#htmlmemo-reading-font-style').textContent,/19\.800px/);assert.equal(doc.body.getAttribute('style'),sourceBody);
  r.plainReadingButtons.larger.onclick();assert.equal(writes.length,2);assert.equal(writes[1].fontScale,1.21);
  assert.equal(textIndex(doc).text,before);assert.deepEqual(r.metadata.annotations,notes);assert.equal(r.setReadingFontScale(NaN),false);
  r.setReadingFontScale(100);assert.equal(r.metadata.view.fontScale,2.4);assert.equal(r.plainReadingButtons.larger.disabled,true);
  r.setReadingFontScale(-100);assert.equal(r.metadata.view.fontScale,.6);assert.equal(r.plainReadingButtons.smaller.disabled,true);
  const saved=serializeHTML(doc,r.metadata);assert.doesNotMatch(saved,/htmlmemo-reading-font-style|data-htmlmemo-reading-controls/);
  assert.equal(parseHTML(saved).metadata.view.fontScale,.6);assert.equal(textIndex(documentFor(parseHTML(saved).html)).text,before);
});
test('saved font scale applies before controls mount and never overrides a source toolbar',()=>{
  const {r,doc}=fixture();r.metadata.view.fontScale=1.5;r.applyReadingFont();assert.match(doc.querySelector('#htmlmemo-reading-font-style').textContent,/27\.000px/);
  r.setupReadingControls();assert.equal(doc.querySelectorAll('#htmlmemo-reading-font-style').length,1);
  const header=doc.createElement('header');header.className='topbar';header.innerHTML='<button>A−</button>';doc.body.prepend(header);r.setupReadingControls();
  assert.equal(doc.querySelector('#htmlmemo-reading-font-style'),null);assert.equal(r.plainReadingButtons,null);assert.equal(r.setReadingFontScale(2),false);
  for(const value of [Infinity,'2',null]){
    const raw='<html><head><script id="htmlmemo-data" type="application/json">'+JSON.stringify({version:1,annotations:[],view:{fontScale:value}})+'</script></head><body>본문</body></html>';
    assert.equal(Object.hasOwn(parseHTML(raw).metadata.view,'fontScale'),false);
  }
});
test('book-provided return, previous and next buttons keep their original nodes and click handlers',()=>{
  const {r,doc}=fixture('<header class="topbar"><div class="controls"><button id="back">↰</button><button id="prev">‹</button><button id="next">›</button><button>A−</button><button>A+</button></div></header>'),calls=[];
  const buttons=['back','prev','next'].map(id=>doc.getElementById(id));
  const handlers=buttons.map(button=>button.onclick=()=>calls.push(button.id));
  r.setupReadingControls();r.setupReadingControls();
  buttons.forEach((button,index)=>{assert.strictEqual(doc.getElementById(button.id),button);assert.strictEqual(button.onclick,handlers[index]);button.onclick();});
  assert.deepEqual(calls,['back','prev','next']);assert.deepEqual(buttons.map(button=>button.textContent),['↰','‹','›']);
});
test('reading controls are restored once after a book header is replaced or removed',()=>{
  const {r,doc}=fixture('<header class="topbar"><button>A+</button></header>');r.setupReadingControls();const old=r.readingControls,oldSpeech=r.speechControls;
  r.topbarNode.remove();r.setupReadingControls();assert.equal(old.isConnected,false);assert.equal(r.readingControls.ownerDocument,r.host.ownerDocument);
  assert.equal(r.readingControls.querySelectorAll('[data-action=speak]').length,1);
  assert.equal(oldSpeech.isConnected,false);
  const header=doc.createElement('header');header.className='topbar';header.innerHTML='<button>A−</button>';
  doc.body.prepend(header);r.setupReadingControls();
  assert.equal(r.topbarNode,header);assert.equal(header.querySelectorAll('[data-action=zoom]').length,1);assert.equal(header.querySelectorAll('[data-action=speak]').length,1);
  r.setupReadingControls();assert.equal(header.querySelectorAll('[data-htmlmemo-reading-controls]').length,2);
  assert.equal(header.querySelector('button:not([data-action])').previousElementSibling,r.speechControls);
});
test('repeated header setup and content replacement retain exactly one app TTS button',()=>{
  const {r,doc}=fixture('<header class="topbar"><div class="controls"><button>A+</button></div></header>');r.setupReadingControls();r.setupReadingControls();
  assert.equal(doc.querySelectorAll('[data-action=speak]').length,1);
  const button=r.speechControl,font=doc.createElement('button');font.textContent='A−';doc.querySelector('.controls').replaceChildren(font);r.setupReadingControls();
  assert.equal(doc.querySelectorAll('[data-action=speak]').length,1);assert.strictEqual(doc.querySelector('[data-action=speak]'),button);assert.equal(font.isConnected,true);
  assert.equal(font.previousElementSibling,r.speechControls);
});
test('nested font groups and different minus labels keep the speaker directly before the original control',()=>{
  for(const label of ['A-','A−','A–',' A − ']){
    const {r,doc}=fixture('<header class="topbar"><div class="controls"><button>‹</button><span class="fonts"><button id="smaller">'+label+'</button><button>A+</button></span></div></header>');
    r.setupReadingControls();assert.equal(doc.querySelector('#smaller').previousElementSibling,r.speechControls);
    assert.equal(r.speechControls.parentElement,doc.querySelector('.fonts'));assert.equal(r.readingControls.parentElement,doc.querySelector('.controls'));
    r.setupReadingControls();assert.equal(doc.querySelectorAll('[data-action=speak]').length,1);
  }
});
test('speaker recognizes an accessible font-decrease label and recovers when that control is inserted later',()=>{
  const {r,doc}=fixture('<header class="topbar"><div class="controls"><button>‹</button><button>A+</button></div></header>');
  r.setupReadingControls();assert.equal(doc.querySelector('.controls').firstElementChild,r.speechControls);
  const smaller=doc.createElement('button');smaller.setAttribute('aria-label','글자 작게');smaller.textContent='↓';doc.querySelector('.controls').insertBefore(smaller,r.readingControls);
  r.setupReadingControls();assert.equal(smaller.previousElementSibling,r.speechControls);assert.equal(doc.querySelectorAll('[data-action=speak]').length,1);
});
test('reader-only controls and styles never change export text offsets or the book toolbar',()=>{
  const {r,doc}=fixture('<header class="topbar"><button id="font" onclick="window.fontChanged=true">A+</button></header>');
  const text=textIndex(doc).text;r.setupReadingControls();assert.equal(textIndex(doc).text,text);
  const saved=serializeHTML(doc,r.metadata);assert.doesNotMatch(saved,/data-htmlmemo-reading-controls|htmlmemo-reading-controls-style|data-action="(?:zoom|speak)"/);
  const reopened=parseHTML(saved,{}, {allowScripts:true}),clean=documentFor(reopened.html);
  assert.equal(textIndex(clean).text,text);assert.equal(clean.querySelector('#font').getAttribute('onclick'),'window.fontChanged=true');
  assert.equal(doc.querySelector('[data-action=zoom]'),r.zoomControl,'export cleans a clone, not the active reader');
});
test('zoom label updates are safe before the reader has a document or controls',()=>{
  const r=Object.create(Reader.prototype);r.frame={getBoundingClientRect(){throw Error('not laid out');}};r.viewport=r.frame;
  assert.doesNotThrow(()=>r.updateReadingControls());
});
test('source UI scale keeps the same physical sidebar width across page magnifications and is excluded from exports',()=>{
  const {r,doc}=fixture('<header class="topbar"><button>A+</button></header>');
  r.callbacks.sidebarWidth=()=>300;r.callbacks.sidebarMaxWidth=()=>640;
  for(const zoom of [.25,.5,1,1.25,2,8]){
    r.zoom=zoom;r.uiScale=1/zoom;assert.equal(r.sidebarUnit(),1/zoom);assert.equal(r.maxTocWidth()*zoom,640);
    assert.ok(Math.abs(r.clampTocWidth(300/zoom,false)*zoom-300)<=1);assert.equal(r.clampTocWidth(8/zoom,false)*zoom,8);
  }
  doc.documentElement.style.setProperty('--htmlmemo-reader-ui-scale','2');doc.documentElement.setAttribute('data-htmlmemo-compact-ui','');
  const saved=serializeHTML(doc,r.metadata);assert.doesNotMatch(saved,/--htmlmemo-reader-ui-scale|data-htmlmemo-compact-ui/);
});
test('app reading controls stay reachable when the enlarged page is horizontally panned',()=>{
  const {r}=fixture('<header class="topbar"><button>A+</button></header>');r.setupReadingControls();
  let left=-300;const shift=()=>Number.parseFloat(r.readingControls.style.getPropertyValue('--htmlmemo-controls-shift'))||0;
  r.frame={offsetWidth:960,getBoundingClientRect:()=>({left,width:1200})};
  r.viewport={getBoundingClientRect:()=>({left:0,right:390,width:390})};
  r.readingControls.getBoundingClientRect=()=>({left:820+shift(),right:910+shift(),width:90});
  for(left of [-300,-600,0]){
    r.updateReadingControls();const right=left+(910+shift())*1.25;
    assert.ok(right<=390&&right>=387);const previous=shift();r.updateReadingControls();assert.equal(shift(),previous,'repeated updates do not accumulate the shift');
  }
});
test('a visible source toolbar moves as a group so pinned zoom cannot cover previous-next buttons',()=>{
  const {r,doc}=fixture('<header class="topbar"><div class="controls" style="transform:rotate(0deg);translate:2px 0px"><button id="prev">‹</button><button id="next">›</button><button>A−</button><button>A+</button></div></header>');r.setupReadingControls();
  const group=doc.querySelector('.controls'),shift=node=>Number.parseFloat(node.style.getPropertyValue('--htmlmemo-controls-shift'))||0;
  let left=-300;r.frame={offsetWidth:960,getBoundingClientRect:()=>({left,width:1200})};r.viewport={getBoundingClientRect:()=>({left:0,right:390,width:390})};
  group.getBoundingClientRect=()=>({left:730+shift(group),right:910+shift(group),width:180});
  r.readingControls.getBoundingClientRect=()=>({left:870+shift(group)+shift(r.readingControls),right:910+shift(group)+shift(r.readingControls),width:40});
  for(left of [-300,-600,0]){
    r.updateReadingControls();const rect=group.getBoundingClientRect();
    assert.ok(left+rect.left*1.25>=2&&left+rect.right*1.25<=388.01,'the source buttons and app zoom fit together in the visible row');
    assert.equal(shift(r.readingControls),0,'zoom never moves over a neighboring source button');const previous=shift(group);r.updateReadingControls();assert.equal(shift(group),previous);
  }
  r.viewport.getBoundingClientRect=()=>({left:0,right:200,width:200});r.updateReadingControls();assert.equal(shift(group),0);assert.equal(shift(r.readingControls),0,'a group wider than the screen keeps its original horizontal pan and button spacing');
  assert.equal(group.style.transform,'rotate(0deg)');assert.equal(group.style.getPropertyValue('translate'),'2px 0px');
  const saved=serializeHTML(doc,r.metadata),clean=documentFor(saved).querySelector('.controls');assert.doesNotMatch(saved,/--htmlmemo-controls-shift|data-htmlmemo-reading-controls/);assert.equal(clean.style.transform,'rotate(0deg)');assert.equal(clean.style.getPropertyValue('translate'),'2px 0px');assert.ok(clean.querySelector('#prev'));assert.ok(clean.querySelector('#next'));
});
