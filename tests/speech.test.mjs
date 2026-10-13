import test from 'node:test';
import assert from 'node:assert/strict';
import { Reader } from '../public/src/reader.js';
function fixture(text='',lang='',current='') {
  const spoken=[],errors=[];let cancels=0;
  const win={speechSynthesis:{cancel(){cancels++;},resume(){this.resumed=true;},speak(u){spoken.push(u);},getVoices(){return [{lang:'ko-KR',name:'Korean'}];}},SpeechSynthesisUtterance:class{constructor(text){this.text=text;}}};
  const node={textContent:current,getBoundingClientRect:()=>({bottom:20})};
  const r=Object.assign(Object.create(Reader.prototype),{host:{ownerDocument:{defaultView:win}},doc:{getSelection:()=>({toString:()=>text}),documentElement:{lang},defaultView:{scrollY:0},querySelectorAll:()=>[node]},viewport:{scrollTop:0},zoom:1,nativeScroll:false,callbacks:{onError:e=>errors.push(e.message),onView(){}}});
  return {r,win,spoken,errors,get cancels(){return cancels;}};
}
test('TTS reads selected Korean and replaces previous speech, matching HTMLMemoEx',()=>{
  const f=fixture(' 선택한 문장입니다. ','en');
  assert.equal(f.r.speakSelection(),true);assert.equal(f.spoken[0].text,'선택한 문장입니다.');assert.equal(f.spoken[0].lang,'ko-KR');
  assert.equal(f.spoken[0].voice.name,'Korean');assert.equal(f.win.speechSynthesis.resumed,true);
  const old=f.spoken[0];f.r.speakSelection();old.onerror({error:'audio-busy'});assert.deepEqual(f.errors,[]);
  assert.ok(f.cancels>=2);f.r.stopSpeech();assert.equal(f.r.utterance,null);
});
test('TTS preserves selected quote after toolbar focus and respects document language',()=>{
  const f=fixture('','fr');f.r.selection={quote:'Bonjour'};f.r.speakSelection();assert.equal(f.spoken[0].text,'Bonjour');assert.equal(f.spoken[0].lang,'fr');
  const g=fixture('Hello');g.r.speakSelection();assert.equal(g.spoken[0].lang,'en-US');
});
test('TTS uses the current paragraph without a selection and reports unsupported or failed speech',()=>{
  const f=fixture('','', '현재 읽는 문단');assert.equal(f.r.speakSelection(),true);assert.equal(f.spoken[0].text,'현재 읽는 문단');
  f.r.selection={quote:'hello'};delete f.win.speechSynthesis;assert.equal(f.r.speakSelection(),false);assert.match(f.errors[0],/지원하지/);
  const g=fixture('hello');g.r.speakSelection();g.spoken[0].onerror({error:'not-allowed'});assert.match(g.errors[0],/실행하지/);
});
