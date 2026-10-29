import test from 'node:test';
import assert from 'node:assert/strict';
import {createReadAloud} from '../public/src/read-aloud.js';
import {documentFor,NodeFilter,installDOM} from './dom.mjs';
import {textIndex,selectionAnchor,currentSection,serializeHTML} from '../public/src/document.js';

function fixture({gap=500,html,stored=[],voices=[],paint=false}={}){
  installDOM();
  const ui=documentFor('<html lang="ko"><head></head><body><div id="app"><div id="host"></div></div></body></html>');
  const doc=documentFor(html||'<html><head></head><body><main><p>첫 번째 문장입니다.</p><p>두 번째 문장입니다.</p><p>세 번째 문장입니다.</p><p>네 번째 문장입니다.</p></main></body></html>');
  const DomEvent=doc.defaultView.Event,spoken=[],settings=new Map(stored),timers=new Map(),notices=[];let selection={isCollapsed:true,rangeCount:0},point=null,cancels=0,resumes=0,time=0,timerId=0;
  const engine={paused:false,getVoices:()=>voices,speak:utterance=>spoken.push(utterance),cancel:()=>{cancels++;},resume:()=>{resumes++;engine.paused=false;}};
  const win=new EventTarget();Object.assign(win,{AbortController,SpeechSynthesisUtterance:class{constructor(text){if(win.failUtterance)throw Error('Unavailable utterance');this.text=text;}},speechSynthesis:engine,setTimeout:(fn,ms)=>{const id=++timerId;timers.set(id,{fn,at:time+ms});return id;},clearTimeout:id=>timers.delete(id),localStorage:{getItem:key=>settings.get(key)||null,setItem:(key,value)=>settings.set(key,value)},innerWidth:1000,innerHeight:700});
  const paints=new Map();Object.defineProperty(ui,'defaultView',{value:win});Object.defineProperty(doc,'defaultView',{value:{NodeFilter,...(paint?{CSS:{highlights:paints},Highlight:class{constructor(...ranges){this.range=ranges[0];this.ranges=ranges;}}}:{})}});
  const reader={host:ui.querySelector('#host'),doc,metadata:{id:'resume-test'},callbacks:{onNotice:message=>notices.push(message)},zoom:1,scrollTop:0,scrollLeft:0,frame:{getBoundingClientRect:()=>({top:0})},viewport:{getBoundingClientRect:()=>({top:0,bottom:600,height:600})}};
  // The shared DOM adapter yields a boolean; TTS uses the browser's returned text node.
  const createWalker=doc.createTreeWalker.bind(doc);doc.createTreeWalker=(...args)=>{const walker=createWalker(...args);return {get currentNode(){return walker.currentNode;},nextNode:()=>walker.nextNode()?walker.currentNode:null};};
  doc.getSelection=()=>selection;doc.caretPositionFromPoint=()=>point;
  doc.createRange=()=>({setStart(node,offset){this.startContainer=node;this.startOffset=offset;},setEnd(node,offset){this.endContainer=node;this.endOffset=offset;},offsets(){const index=textIndex(doc),start=index.nodes.find(n=>n.node===this.startContainer),end=index.nodes.find(n=>n.node===this.endContainer);return {index,start:start?.start+this.startOffset,end:end?.start+this.endOffset};},toString(){const {index,start,end}=this.offsets();return index.text.slice(start,end);},intersectsNode(node){const {index,start,end}=this.offsets(),entry=index.nodes.find(n=>n.node===node);return !!entry&&entry.end>start&&entry.start<end;},getClientRects:()=>[],getBoundingClientRect:()=>({height:0})});
  function geometry(){[...doc.querySelectorAll('main p')].forEach((p,i)=>p.getBoundingClientRect=()=>({top:100+i*gap-reader.scrollTop,bottom:160+i*gap-reader.scrollTop,height:60}));}
  geometry();const player=createReadAloud(reader);player.toggle();
  const button=label=>ui.querySelector(`[aria-label="${label}"]`);
  const clickButton=label=>{const b=button(label);assert.ok(b,'Missing '+label);b.click();};
  const play=()=>clickButton('소리내어 읽기'),pause=()=>clickButton('일시정지');
  function select(index,{element=false}={}){
    const p=doc.querySelectorAll('main p')[index],node=element?p:p.firstChild;
    selection={isCollapsed:false,rangeCount:1,getRangeAt:()=>({startContainer:node,startOffset:0,endContainer:node,endOffset:element?1:node.data.length})};
    doc.dispatchEvent(new DomEvent('selectionchange'));
  }
  function clickText(index){
    selection={isCollapsed:true,rangeCount:0};const p=doc.querySelectorAll('main p')[index];point={offsetNode:p.firstChild,offset:0};
    const event=new DomEvent('click',{bubbles:true});Object.assign(event,{clientX:20,clientY:120});p.dispatchEvent(event);doc.dispatchEvent(new DomEvent('selectionchange'));
  }
  function selectRange(startNode,startOffset,endNode=startNode,endOffset=endNode.data.length){
    const range=doc.createRange();range.setStart(startNode,startOffset);range.setEnd(endNode,endOffset);selection={isCollapsed:false,rangeCount:1,getRangeAt:()=>range};
    doc.dispatchEvent(new DomEvent('selectionchange'));const anchor=selectionAnchor(doc,range),section=currentSection(doc);return section?{...anchor,section}:anchor;
  }
  function advance(ms){time+=ms;for(const[id,timer]of [...timers])if(timer.at<=time){timers.delete(id);timer.fn();}}
  return {doc,ui,win,engine,reader,player,spoken,notices,settings,paints,play,pause,select,selectRange,clickText,geometry,button,clickButton,advance,get cancels(){return cancels;},get resumes(){return resumes;},get timers(){return timers.size;}};
}
test('paused Play repeats the current sentence when the reading position has not changed',()=>{
  const a=fixture();a.play();a.clickButton('다음 문장');assert.equal(a.spoken.at(-1).text,'두 번째 문장입니다.');a.pause();
  const count=a.spoken.length;a.spoken.at(-1).onend();a.spoken.at(-1).onerror();assert.equal(a.spoken.length,count);
  a.play();assert.equal(a.spoken.at(-1).text,'두 번째 문장입니다.');assert.ok(a.button('일시정지'));
});
test('starting below a long paragraph measures each offscreen paragraph once and remeasures after moving',()=>{
  const a=fixture({html:'<html><head></head><body><main><p>'+Array.from({length:1000},(_,i)=>`문장 ${i}입니다. `).join('')+'</p><p>지금 보이는 문장입니다.</p></main></body></html>'}),paragraphs=a.doc.querySelectorAll('p');
  let measured=0,top=-600;paragraphs[0].getBoundingClientRect=()=>{measured++;return {top,bottom:top+50,height:50};};paragraphs[1].getBoundingClientRect=()=>({top:100,bottom:150,height:50});
  a.play();assert.equal(a.spoken.at(-1).text,'지금 보이는 문장입니다.');assert.equal(measured,1);
  a.pause();top=100;a.reader.scrollTop=20;a.play();assert.equal(a.spoken.at(-1).text,'문장 0입니다.');assert.equal(measured,2);a.player.dispose();
});
test('mixed prose and SVG sentences keep prose highlights outside diagrams and export no temporary paint',()=>{
  const a=fixture({paint:true,html:'<html><head><title>Diagram</title></head><body><main><p>Prose before.</p><div><span id="lead">Mixed </span><svg viewBox="0 0 100 20"><text id="label">diagram</text></svg><span id="tail"> sentence.</span></div><p>Prose after.</p></main></body></html>'}),original=a.doc.querySelector('svg').outerHTML;
  a.play();assert.equal(a.paints.get('mstts').ranges.length,1);a.clickButton('다음 문장');assert.equal(a.spoken.at(-1).text,'Mixed diagram sentence.');
  const ranges=a.paints.get('mstts').ranges;assert.equal(ranges.length,2);assert.strictEqual(ranges[0].startContainer,a.doc.querySelector('#lead').firstChild);assert.strictEqual(ranges[0].endContainer,ranges[0].startContainer);assert.strictEqual(ranges[1].startContainer,a.doc.querySelector('#tail').firstChild);assert.strictEqual(ranges[1].endContainer,ranges[1].startContainer);
  assert.ok(a.doc.querySelector('[data-htmlmemo-tts-paint][data-htmlmemo-ui][aria-hidden=true]'));assert.equal(a.doc.querySelector('svg').outerHTML,original);
  assert.doesNotMatch(serializeHTML(a.doc,{annotations:[],bookmarks:[]}),/data-htmlmemo-tts-paint/);
  a.clickButton('다음 문장');assert.equal(a.spoken.at(-1).text,'Prose after.');assert.equal(a.doc.querySelector('[data-htmlmemo-tts-paint]'),null);assert.equal(a.paints.get('mstts').ranges.length,1);a.player.dispose();
});
test('SVG and foreignObject reading never use Custom Highlights and release diagram paint on stop, close or dispose',()=>{
  for(const action of ['stop','close','dispose']){
    const a=fixture({paint:true,html:'<html><head></head><body><main><svg><text>Native diagram.</text><foreignObject><div><p>HTML diagram.</p></div></foreignObject></svg></main></body></html>'});
    a.doc.querySelector('text').getBoundingClientRect=()=>({top:100,bottom:120,height:20});
    a.play();assert.equal(a.spoken.at(-1).text,'Native diagram.');assert.equal(a.paints.size,0);assert.ok(a.doc.querySelector('[data-htmlmemo-tts-paint]'));
    a.clickButton('다음 문장');assert.equal(a.spoken.at(-1).text,'HTML diagram.');assert.equal(a.paints.size,0);assert.ok(a.doc.querySelector('[data-htmlmemo-tts-paint]'));
    if(action==='stop')a.clickButton('정지');else a.player[action]();assert.equal(a.doc.querySelector('[data-htmlmemo-tts-paint]'),null);assert.equal(a.paints.size,0);if(action!=='dispose')a.player.dispose();
  }
});
test('scrolling down while paused reads the new visible sentence only after Play',()=>{
  const a=fixture();a.play();const old=a.spoken[0];a.pause();a.reader.scrollTop=1000;assert.equal(a.spoken.length,1);
  a.play();assert.equal(a.spoken.at(-1).text,'세 번째 문장입니다.');const count=a.spoken.length;old.onend();old.onerror();assert.equal(a.spoken.length,count);
});
test('scrolling up while paused starts from the new view instead of the old sentence',()=>{
  const a=fixture();a.reader.scrollTop=1000;a.play();assert.equal(a.spoken.at(-1).text,'세 번째 문장입니다.');a.pause();a.reader.scrollTop=0;a.play();assert.equal(a.spoken.at(-1).text,'첫 번째 문장입니다.');
});
test('paused prose clicks select a sentence without automatically starting speech',()=>{
  const a=fixture({gap:120});a.play();a.pause();a.clickText(2);assert.equal(a.spoken.length,1);assert.ok(a.button('소리내어 읽기'));
  a.play();assert.equal(a.spoken.at(-1).text,'세 번째 문장입니다.');
});
test('a new text selection while paused sets the next Play position',()=>{
  const a=fixture({gap:120});a.play();a.pause();a.select(2);assert.equal(a.spoken.length,1);a.play();assert.equal(a.spoken.at(-1).text,'세 번째 문장입니다.');
});
test('element-boundary text selections resolve to their first readable text node',()=>{
  const a=fixture({gap:120});a.play();a.pause();a.select(2,{element:true});a.play();assert.equal(a.spoken.at(-1).text,'세 번째 문장입니다.');
});
test('an unchanged selection from before Pause does not override the paused sentence',()=>{
  const a=fixture({gap:120});a.select(0);a.play();a.clickButton('다음 문장');a.pause();a.select(0);a.play();assert.equal(a.spoken.at(-1).text,'두 번째 문장입니다.');
});
test('moving after a paused selection ignores the now-stale selection target',()=>{
  const a=fixture();a.play();a.pause();a.select(1);a.reader.scrollTop=1500;a.play();assert.equal(a.spoken.at(-1).text,'네 번째 문장입니다.');
});
test('moving after a paused click ignores the now-stale click target',()=>{
  const a=fixture();a.play();a.pause();a.clickText(1);a.reader.scrollTop=1500;a.play();assert.equal(a.spoken.at(-1).text,'네 번째 문장입니다.');
});
test('a replaced lazy chapter is reindexed before paused Play',()=>{
  const a=fixture();a.play();a.pause();a.doc.querySelector('main').innerHTML='<p>새 장의 문장입니다.</p>';a.geometry();a.play();assert.equal(a.spoken.at(-1).text,'새 장의 문장입니다.');
});
test('in-place chapter text changes cannot reuse stale utterance text',()=>{
  const a=fixture();a.play();a.pause();a.doc.querySelector('p').firstChild.data='바뀐 장의 문장입니다.';a.play();assert.equal(a.spoken.at(-1).text,'바뀐 장의 문장입니다.');
});
test('an empty new chapter stops safely and never replays the previous chapter',()=>{
  const a=fixture();a.play();a.pause();a.doc.querySelector('main').replaceChildren();a.play();assert.equal(a.spoken.length,1);assert.ok(a.button('소리내어 읽기'));
  a.doc.querySelector('main').innerHTML='<p>준비된 새 장입니다.</p>';a.geometry();a.play();assert.equal(a.spoken.at(-1).text,'준비된 새 장입니다.');
});
test('closing the player discards a paused click target and invalidates the old run',()=>{
  const a=fixture({gap:120});a.play();const old=a.spoken[0];a.pause();a.clickText(2);a.player.close();old.onend();assert.equal(a.spoken.length,1);assert.equal(a.ui.querySelector('.mstts-player'),null);
  a.player.toggle();a.play();assert.equal(a.spoken.at(-1).text,'첫 번째 문장입니다.');
});

test('Play releases a paused native engine before queuing the new utterance',()=>{
  const a=fixture(),order=[],speak=a.engine.speak;a.engine.paused=true;a.engine.resume=()=>{order.push('resume');a.engine.paused=false;};a.engine.speak=u=>{order.push('speak');assert.equal(a.engine.paused,false);speak(u);};
  a.play();assert.deepEqual(order,['resume','speak']);a.pause();a.engine.paused=true;a.play();assert.deepEqual(order,['resume','speak','resume','speak']);
});
test('duplicate and out-of-order callbacks from an earlier sentence cannot enqueue more speech',()=>{
  const a=fixture();a.play();const first=a.spoken[0];first.onend();assert.equal(a.spoken.length,2);const second=a.spoken[1];
  first.onend();first.onerror({error:'interrupted'});assert.equal(a.spoken.length,2);second.onend();assert.equal(a.spoken.length,3);assert.equal(a.spoken.at(-1).text,'세 번째 문장입니다.');
});
test('a synthesis error pauses at the same sentence instead of silently skipping or looping',()=>{
  const a=fixture();a.play();const first=a.spoken[0];first.onerror({error:'audio-busy'});assert.equal(a.spoken.length,1);assert.ok(a.button('소리내어 읽기'));assert.equal(a.notices.length,1);
  first.onend();first.onerror({error:'audio-busy'});assert.equal(a.notices.length,1);a.play();assert.equal(a.spoken.at(-1).text,'첫 번째 문장입니다.');assert.ok(a.button('일시정지'));
});
test('a synchronous speak failure keeps the current sentence retryable',()=>{
  const a=fixture();a.play();a.clickButton('다음 문장');a.pause();const speak=a.engine.speak;a.engine.speak=()=>{throw Error('Audio unavailable');};a.play();
  assert.ok(a.button('소리내어 읽기'));assert.equal(a.notices.length,1);a.engine.speak=speak;a.play();assert.equal(a.spoken.at(-1).text,'두 번째 문장입니다.');
});
test('a failed utterance constructor cannot leave the player showing a dead Pause button',()=>{
  const a=fixture();a.win.failUtterance=true;a.play();assert.ok(a.button('소리내어 읽기'));assert.equal(a.spoken.length,0);assert.equal(a.notices.length,1);
  a.win.failUtterance=false;a.play();assert.equal(a.spoken.length,1);assert.ok(a.button('일시정지'));
});
test('a transient selection failure cannot prevent Pause from updating the button',()=>{
  const a=fixture();a.play();a.doc.getSelection=()=>{throw Error('Selection unavailable');};a.pause();assert.ok(a.button('소리내어 읽기'));const n=a.spoken.length;a.spoken[0].onend();assert.equal(a.spoken.length,n);a.play();assert.equal(a.spoken.length,n+1);
});
test('rapid Play/Pause cycles leave only the latest command and utterance active',()=>{
  const a=fixture();a.play();for(let i=0;i<40;i++){a.pause();assert.ok(a.button('소리내어 읽기'));a.play();assert.ok(a.button('일시정지'));}
  const n=a.spoken.length;for(const old of a.spoken.slice(0,-1)){old.onend();old.onerror({error:'interrupted'});}assert.equal(a.spoken.length,n);a.pause();a.advance(20000);assert.equal(a.spoken.length,n);assert.equal(a.notices.length,0);
});
test('a missing native start signal returns to retryable Pause without automatic speech retries',()=>{
  const a=fixture();a.play();a.advance(8000);assert.ok(a.button('소리내어 읽기'));assert.equal(a.spoken.length,1);assert.equal(a.notices.length,1);
  a.play();a.spoken.at(-1).onstart();a.advance(20000);assert.ok(a.button('일시정지'));assert.equal(a.notices.length,1);assert.equal(a.spoken.length,2);
});
test('closing cancels start detection and late speech events cannot resurrect the player',()=>{
  const a=fixture();a.play();assert.equal(a.timers,1);const old=a.spoken[0];a.player.close();assert.equal(a.timers,0);a.advance(20000);old.onstart();old.onend();old.onerror({error:'audio-busy'});assert.equal(a.notices.length,0);assert.equal(a.ui.querySelector('.mstts-player'),null);
});
test('unexpected native pauses recover only while the user still wants playback',()=>{
  const a=fixture();a.play();const old=a.spoken[0];a.engine.paused=true;old.onpause();assert.equal(a.engine.paused,false);assert.equal(a.resumes,1);
  a.pause();a.engine.paused=true;old.onpause();assert.equal(a.engine.paused,true);assert.equal(a.resumes,1);assert.ok(a.button('소리내어 읽기'));
});
test('failed reading preparation resets the button and reports a retryable failure',()=>{
  const a=fixture(),walker=a.doc.createTreeWalker;a.doc.createTreeWalker=()=>{throw Error('Reader temporarily unavailable');};a.play();assert.ok(a.button('소리내어 읽기'));assert.equal(a.notices.length,1);
  a.doc.createTreeWalker=walker;a.play();assert.equal(a.spoken.length,1);assert.ok(a.button('일시정지'));
});

test('selection reading immediately plays with the existing player, saved voice and speed',()=>{
  const voice={voiceURI:'english-test',lang:'en-US',name:'Google English'},a=fixture({voices:[voice],stored:[['msuite_tts_rate','1.5'],['htmlmemo_tts_lang_resume-test','en'],['msuite_tts_voice_en','english-test']]}),bar=a.ui.querySelector('.mstts-player');
  a.play();const old=a.spoken.at(-1),before=a.spoken.length,node=a.doc.querySelectorAll('p')[1].firstChild,anchor=a.selectRange(node,0);
  assert.equal(a.player.openSelection(anchor),true);assert.strictEqual(a.ui.querySelector('.mstts-player'),bar);assert.equal(a.ui.querySelectorAll('.mstts-player').length,1);assert.equal(bar.dataset.ttsScope,'selection');assert.equal(a.spoken.length,before+1);assert.ok(a.button('일시정지'));
  old.onend();old.onerror();assert.equal(a.spoken.length,before+1);assert.equal(a.spoken.at(-1).text,'두 번째 문장입니다.');assert.equal(a.spoken.at(-1).rate,1.5);assert.strictEqual(a.spoken.at(-1).voice,voice);
});
test('selection reading clips partial inline text at both ends and highlights only those offsets',()=>{
  const a=fixture({paint:true,html:'<html><body><main><p>Outside. <em>selected one.</em></p><p><strong>selected two</strong> outside.</p><p>Untouched sentence.</p></main></body></html>'}),start=a.doc.querySelector('em').firstChild,end=a.doc.querySelector('strong').firstChild,paint=a.paints;
  assert.equal(a.player.openSelection(a.selectRange(start,3,end,8)),true);assert.equal(a.spoken.at(-1).text,'ected one.');assert.equal(paint.get('mstts').range.startOffset,3);
  a.spoken.at(-1).onend();assert.equal(a.spoken.at(-1).text,'selected');assert.strictEqual(paint.get('mstts').range.endContainer,end);assert.equal(paint.get('mstts').range.endOffset,8);
  const count=a.spoken.length;a.spoken.at(-1).onend();assert.equal(a.spoken.length,count);assert.ok(a.button('소리내어 읽기'));assert.equal(paint.has('mstts'),false);
});
test('selection Pause and Play keep the pinned range despite scrolling or selecting outside it',()=>{
  const a=fixture(),nodes=[...a.doc.querySelectorAll('p')].map(p=>p.firstChild);a.player.openSelection(a.selectRange(nodes[1],0,nodes[2],nodes[2].data.length));a.clickButton('다음 문장');a.pause();
  a.selectRange(nodes[3],0);a.reader.scrollTop=1500;const count=a.spoken.length;a.play();assert.equal(a.spoken.length,count+1);assert.equal(a.spoken.at(-1).text,'세 번째 문장입니다.');
  a.pause();a.clickText(0);a.play();assert.equal(a.spoken.at(-1).text,'세 번째 문장입니다.');assert.equal(a.spoken.some(u=>/첫 번째|네 번째/.test(u.text)),false);
});
test('selection sentence navigation and Stop never escape the selected bounds',()=>{
  const a=fixture(),nodes=[...a.doc.querySelectorAll('p')].map(p=>p.firstChild);a.player.openSelection(a.selectRange(nodes[1],0,nodes[2],nodes[2].data.length));a.clickButton('이전 문장');assert.equal(a.spoken.at(-1).text,'두 번째 문장입니다.');
  a.clickButton('다음 문장');a.clickButton('다음 문장');assert.equal(a.spoken.at(-1).text,'세 번째 문장입니다.');a.clickButton('정지');a.play();assert.equal(a.spoken.at(-1).text,'두 번째 문장입니다.');assert.equal(a.spoken.some(u=>/첫 번째|네 번째/.test(u.text)),false);
});
test('a new selection replaces the old scope without another player or stale speech callbacks',()=>{
  const a=fixture(),nodes=[...a.doc.querySelectorAll('p')].map(p=>p.firstChild),bar=a.ui.querySelector('.mstts-player');a.player.openSelection(a.selectRange(nodes[0],0));const old=a.spoken.at(-1),before=a.spoken.length;
  a.player.openSelection(a.selectRange(nodes[2],0));const count=a.spoken.length;assert.equal(count,before+1);old.onend();old.onerror();assert.equal(a.spoken.length,count);assert.strictEqual(a.ui.querySelector('.mstts-player'),bar);assert.equal(a.spoken.at(-1).text,'세 번째 문장입니다.');
});
test('selection text replacement and chapter changes stop safely instead of reading other content',()=>{
  for(const change of ['text','chapter']){
    const a=fixture({html:'<html><body><main><article id="reader-content" data-section="one"><p>선택한 문장입니다.</p><p>선택한 문장입니다.</p></article></main></body></html>'}),node=a.doc.querySelector('p').firstChild;a.player.openSelection(a.selectRange(node,0));a.pause();
    if(change==='text')node.data='다른 문장으로 바뀌었습니다.';else {a.doc.querySelector('article').dataset.section='two';a.doc.querySelector('article').innerHTML='<p>선택한 문장입니다.</p>';}
    const count=a.spoken.length;a.play();assert.equal(a.spoken.length,count);assert.ok(a.button('소리내어 읽기'));assert.equal(a.notices.length,1);
  }
});
test('selection callbacks cannot advance after the selected DOM is replaced during playback',()=>{
  const a=fixture(),nodes=[...a.doc.querySelectorAll('p')].map(p=>p.firstChild);a.player.openSelection(a.selectRange(nodes[1],0,nodes[2],nodes[2].data.length));const old=a.spoken.at(-1);a.doc.querySelector('main').innerHTML='<p>다른 내용입니다.</p>';
  const count=a.spoken.length;old.onend();assert.equal(a.spoken.length,count);assert.ok(a.button('소리내어 읽기'));assert.equal(a.notices.length,1);
});
test('closing selection mode restores ordinary document reading and retains shared speed settings',()=>{
  const a=fixture(),node=a.doc.querySelectorAll('p')[2].firstChild;a.player.openSelection(a.selectRange(node,0));a.clickButton('정지');a.clickButton('읽는 속도');a.play();assert.equal(a.spoken.at(-1).rate,1.25);a.player.close();a.player.toggle();
  assert.equal(a.ui.querySelector('.mstts-player').dataset.ttsScope,'document');a.reader.scrollTop=0;a.play();assert.equal(a.spoken.at(-1).text,'첫 번째 문장입니다.');assert.equal(a.spoken.at(-1).rate,1.25);
});
test('unresolvable, hidden, stale-chapter or non-readable selections never fall back to full document speech',()=>{
  for(const kind of ['missing','hidden','chapter','skipped']){
    const a=fixture({html:'<html><body><main><article id="reader-content" data-section="one"><p>읽을 본문입니다.</p><pre>읽지 않는 코드입니다.</pre></article></main></body></html>'}),node=a.doc.querySelector(kind==='skipped'?'pre':'p').firstChild,anchor=a.selectRange(node,0);
    if(kind==='missing')anchor.quote='없는 글입니다.';else if(kind==='hidden')a.reader.host.hidden=true;else if(kind==='chapter')anchor.section='other';
    assert.equal(a.player.openSelection(anchor),false,kind);assert.equal(a.spoken.length,0);
  }
});
test('an explicitly selected single letter is readable without including its neighbors',()=>{
  const a=fixture(),node=a.doc.querySelector('p').firstChild;assert.equal(a.player.openSelection(a.selectRange(node,0,node,1)),true);assert.equal(a.spoken.at(-1).text,'첫');const count=a.spoken.length;a.spoken.at(-1).onend();assert.equal(a.spoken.length,count);
});
test('an explicit selection can read a document title outside main without reading the surrounding document',()=>{
  const a=fixture({html:'<html><body><header><h1>문서 제목입니다.</h1></header><main><p>선택하지 않은 본문입니다.</p></main></body></html>'}),node=a.doc.querySelector('h1').firstChild;
  assert.equal(a.player.openSelection(a.selectRange(node,0)),true);assert.equal(a.spoken.at(-1).text,'문서 제목입니다.');const count=a.spoken.length;a.spoken.at(-1).onend();assert.equal(a.spoken.length,count);
  a.player.close();a.player.toggle();a.play();assert.equal(a.spoken.at(-1).text,'선택하지 않은 본문입니다.');
});
test('selection reading opens a closed player and releases a native pause before immediate speech',()=>{
  const a=fixture(),node=a.doc.querySelectorAll('p')[1].firstChild;a.player.close();a.engine.paused=true;
  assert.equal(a.player.openSelection(a.selectRange(node,0)),true);assert.equal(a.ui.querySelectorAll('.mstts-player').length,1);assert.equal(a.spoken.length,1);assert.equal(a.spoken[0].text,'두 번째 문장입니다.');assert.equal(a.engine.paused,false);assert.equal(a.resumes,1);assert.ok(a.button('일시정지'));
});
test('the ordinary TTS button remains ready without autoplay even when text is selected',()=>{
  const a=fixture(),node=a.doc.querySelectorAll('p')[1].firstChild;a.selectRange(node,0);a.player.close();a.player.toggle();
  assert.equal(a.spoken.length,0);assert.equal(a.ui.querySelector('.mstts-player').dataset.ttsScope,'document');assert.ok(a.button('소리내어 읽기'));
});
test('failed selection autoplay stays retryable within its range without automatic retries',()=>{
  for(const failure of ['constructor','speak','start']){
    const a=fixture(),node=a.doc.querySelectorAll('p')[1].firstChild,speak=a.engine.speak;
    if(failure==='constructor')a.win.failUtterance=true;else if(failure==='speak')a.engine.speak=()=>{throw Error('Audio unavailable');};
    assert.equal(a.player.openSelection(a.selectRange(node,0)),true);if(failure==='start')a.advance(8000);
    assert.ok(a.button('소리내어 읽기'));assert.equal(a.notices.length,1);const before=a.spoken.length;a.advance(20000);assert.equal(a.spoken.length,before);
    a.win.failUtterance=false;a.engine.speak=speak;a.play();assert.equal(a.spoken.length,before+1);assert.equal(a.spoken.at(-1).text,'두 번째 문장입니다.');assert.ok(a.button('일시정지'));
  }
});
