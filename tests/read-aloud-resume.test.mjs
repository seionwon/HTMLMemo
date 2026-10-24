import test from 'node:test';
import assert from 'node:assert/strict';
import {createReadAloud} from '../public/src/read-aloud.js';
import {documentFor,NodeFilter} from './dom.mjs';

function fixture({gap=500}={}){
  const ui=documentFor('<html lang="ko"><head></head><body><div id="app"><div id="host"></div></div></body></html>');
  const doc=documentFor('<html><head></head><body><main><p>첫 번째 문장입니다.</p><p>두 번째 문장입니다.</p><p>세 번째 문장입니다.</p><p>네 번째 문장입니다.</p></main></body></html>');
  const DomEvent=doc.defaultView.Event,spoken=[],settings=new Map();let selection={isCollapsed:true,rangeCount:0},point=null,cancels=0;
  const win=new EventTarget();Object.assign(win,{AbortController,SpeechSynthesisUtterance:class{constructor(text){this.text=text;}},speechSynthesis:{getVoices:()=>[],speak:utterance=>spoken.push(utterance),cancel:()=>{cancels++;}},localStorage:{getItem:key=>settings.get(key)||null,setItem:(key,value)=>settings.set(key,value)},innerWidth:1000,innerHeight:700});
  Object.defineProperty(ui,'defaultView',{value:win});Object.defineProperty(doc,'defaultView',{value:{NodeFilter}});
  const reader={host:ui.querySelector('#host'),doc,metadata:{id:'resume-test'},zoom:1,scrollTop:0,scrollLeft:0,frame:{getBoundingClientRect:()=>({top:0})},viewport:{getBoundingClientRect:()=>({top:0,bottom:600,height:600})}};
  // The shared DOM adapter yields a boolean; TTS uses the browser's returned text node.
  const createWalker=doc.createTreeWalker.bind(doc);doc.createTreeWalker=(...args)=>{const walker=createWalker(...args);return {nextNode:()=>walker.nextNode()?walker.currentNode:null};};
  doc.getSelection=()=>selection;doc.caretPositionFromPoint=()=>point;
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
  return {doc,ui,reader,player,spoken,play,pause,select,clickText,geometry,button,clickButton,get cancels(){return cancels;}};
}
test('paused Play repeats the current sentence when the reading position has not changed',()=>{
  const a=fixture();a.play();a.clickButton('다음 문장');assert.equal(a.spoken.at(-1).text,'두 번째 문장입니다.');a.pause();
  const count=a.spoken.length;a.spoken.at(-1).onend();a.spoken.at(-1).onerror();assert.equal(a.spoken.length,count);
  a.play();assert.equal(a.spoken.at(-1).text,'두 번째 문장입니다.');assert.ok(a.button('일시정지'));
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
