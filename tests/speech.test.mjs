import test from 'node:test';
import assert from 'node:assert/strict';
import { Reader } from '../public/src/reader.js';
function fixture({accepted=true}={}) {
  const opened=[],errors=[];let toggles=0,cancels=0,closed=0;
  const win={speechSynthesis:{cancel(){cancels++;},speak(){assert.fail('Selection reading must use the shared player');}}};
  const player={openSelection:anchor=>{opened.push(anchor);return accepted;},toggle(){toggles++;},close(){closed++;}};
  const r=Object.assign(Object.create(Reader.prototype),{readAloud:player,host:{ownerDocument:{defaultView:win}},doc:{getSelection:()=>({rangeCount:0,isCollapsed:true})},callbacks:{onError:e=>errors.push(e.message)}});
  return {r,win,player,opened,errors,get toggles(){return toggles;},get cancels(){return cancels;},get closed(){return closed;}};
}
test('selection and main TTS delegate to the same player without separate native speech',()=>{
  const f=fixture();f.r.selection={quote:'선택한 문장입니다.',start:10,end:21};
  assert.equal(f.r.speakSelection(),true);assert.deepEqual(f.opened,[f.r.selection]);assert.strictEqual(f.r.readAloud,f.player);f.r.toggleReadAloud();assert.equal(f.toggles,1);assert.strictEqual(f.r.readAloud,f.player);assert.equal(f.cancels,0);
  f.r.stopSpeech();assert.equal(f.closed,1);assert.equal(f.cancels,1);
});
test('selection TTS preserves the pinned text anchor and chapter after menu focus',()=>{
  const f=fixture(),anchor={quote:'Bonjour',start:24,end:31,prefix:'avant ',suffix:' après',section:'v0:one'};f.r.selection=anchor;assert.equal(f.r.speakSelection(),true);assert.strictEqual(f.opened[0],anchor);
});
test('selection TTS requires text, a supported engine and an active document',()=>{
  const f=fixture();assert.equal(f.r.speakSelection(),false);assert.equal(f.opened.length,0);f.r.selection={quote:'hello'};delete f.win.speechSynthesis;assert.equal(f.r.speakSelection(),false);assert.match(f.errors[0],/지원하지/);
  for(const state of [{disposed:true},{host:{hidden:true}}]){const a=fixture();Object.assign(a.r,state);a.r.selection={quote:'hello'};assert.equal(a.r.speakSelection(),false);assert.equal(a.opened.length,0);}
});
test('a rejected shared-player selection never falls back to the separate native speech path',()=>{
  const f=fixture({accepted:false});f.r.selection={quote:'읽을 수 없는 글'};assert.equal(f.r.speakSelection(),false);assert.equal(f.opened.length,1);assert.equal(f.cancels,0);assert.equal(f.closed,0);
});
