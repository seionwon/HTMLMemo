import test from 'node:test';
import assert from 'node:assert/strict';
import { Reader } from '../public/src/reader.js';
function fixture(text='',lang='') {
  const spoken=[],errors=[];let cancels=0;
  const win={speechSynthesis:{cancel(){cancels++;},speak(u){spoken.push(u);}},SpeechSynthesisUtterance:class{constructor(text){this.text=text;}}};
  const r=Object.assign(Object.create(Reader.prototype),{host:{ownerDocument:{defaultView:win}},doc:{getSelection:()=>({toString:()=>text}),documentElement:{lang}},callbacks:{onError:e=>errors.push(e.message)}});
  return {r,win,spoken,errors,get cancels(){return cancels;}};
}
test('TTS reads selected Korean and replaces previous speech, matching HTMLMemoEx',()=>{
  const f=fixture(' 선택한 문장입니다. ','en');
  f.r.selection={quote:'선택한 문장입니다.'};
  assert.equal(f.r.speakSelection(),true);assert.equal(f.spoken[0].text,'선택한 문장입니다.');assert.equal(f.spoken[0].lang,'ko-KR');
  f.r.speakSelection();assert.equal(f.spoken.length,2);
  assert.ok(f.cancels>=2);f.r.stopSpeech();assert.ok(f.cancels>=3);
});
test('TTS preserves selected quote after toolbar focus and respects document language',()=>{
  const f=fixture('','fr');f.r.selection={quote:'Bonjour'};f.r.speakSelection();assert.equal(f.spoken[0].text,'Bonjour');assert.equal(f.spoken[0].lang,'fr');
  const g=fixture('Hello');g.r.selection={quote:'Hello'};g.r.speakSelection();assert.equal(g.spoken[0].lang,'en-US');
});
test('TTS requires a selection and reports unsupported or failed speech',()=>{
  const f=fixture();assert.equal(f.r.speakSelection(),false);assert.equal(f.spoken.length,0);
  f.r.selection={quote:'hello'};delete f.win.speechSynthesis;assert.equal(f.r.speakSelection(),false);assert.match(f.errors[0],/지원하지/);
  const g=fixture('hello');g.r.selection={quote:'hello'};assert.equal(g.r.speakSelection(),true);assert.equal(g.spoken[0].text,'hello');
});
