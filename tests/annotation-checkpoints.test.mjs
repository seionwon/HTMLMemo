import test from 'node:test';
import assert from 'node:assert/strict';
import {AnnotationCheckpoints} from '../public/src/model.js';

function clock(){
  let time=0,serial=0;const timers=new Map();
  return {timers,get serial(){return serial;},options:{now:()=>time,setTimer:(fn,ms)=>{timers.set(++serial,{fn,at:time+ms});return serial;},clearTimer:id=>timers.delete(id)},async advance(ms){
    const target=time+ms;for(;;){const next=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>target)break;time=next[1].at;timers.delete(next[0]);next[1].fn();await new Promise(resolve=>setImmediate(resolve));}time=target;
  }};
}
function setup(t,write=async()=>{}){const c=clock(),q=new AnnotationCheckpoints(write,()=>{},c.options);t.after(()=>q.dispose());return {c,q};}
test('checkpoint waits one full idle minute and then stops without polling',async t=>{
  let writes=0;const {c,q}=setup(t,async()=>writes++);q.schedule();await c.advance(59999);assert.equal(writes,0);await c.advance(1);assert.equal(writes,1);assert.equal(q.pending,false);assert.equal(c.timers.size,0);await c.advance(3600000);assert.equal(writes,1);
});
test('continued annotation input resets idle but never postpones the five-minute checkpoint',async t=>{
  let writes=0;const {c,q}=setup(t,async()=>writes++);q.schedule();for(let i=0;i<9;i++){await c.advance(30000);q.schedule();assert.equal(writes,0);}await c.advance(29999);assert.equal(writes,0);await c.advance(1);assert.equal(writes,1);assert.equal(q.pending,false);
});
test('annotation activity without a committed change postpones idle, while no-change activity does no work',async t=>{
  let writes=0;const {c,q}=setup(t,async()=>writes++);q.activity();assert.equal(c.timers.size,0);q.schedule();await c.advance(50000);q.activity();await c.advance(10000);assert.equal(writes,0);await c.advance(49999);assert.equal(writes,0);await c.advance(1);assert.equal(writes,1);q.activity();assert.equal(c.timers.size,0);
});
test('thousands of pen input events keep one timer rather than creating thousands of timers',async t=>{
  const {c,q}=setup(t);q.schedule();for(let i=0;i<10000;i++)q.activity();assert.equal(c.timers.size,1);assert.equal(c.serial,1);await c.advance(60000);assert.equal(q.pending,false);
});
test('new edits arriving during a checkpoint wait for their own idle window',async t=>{
  let release,writes=0;const {c,q}=setup(t,async()=>{if(++writes===1)await new Promise(resolve=>release=resolve);});q.schedule();await c.advance(60000);assert.equal(writes,1);q.schedule();await c.advance(10000);assert.equal(writes,1);assert.equal(c.timers.size,0);release();await q.running;await new Promise(resolve=>setImmediate(resolve));assert.equal(q.pending,true);await c.advance(49999);assert.equal(writes,1);await c.advance(1);assert.equal(writes,2);assert.equal(q.pending,false);
});
test('failed checkpoints stay pending, do not busy-loop, and retry without losing a newer change',async t=>{
  let failing=true,writes=0;const {c,q}=setup(t,async()=>{writes++;if(failing)throw Error('Disk full');});q.schedule();await c.advance(60000);assert.equal(q.pending,true);assert.match(q.error.message,/Disk full/);await c.advance(600000);assert.equal(writes,1);failing=false;await q.flush({force:true});assert.equal(q.pending,false);assert.equal(q.error,null);q.schedule();await c.advance(60000);assert.equal(writes,3);
});
test('forced close drains changes and concurrent checkpoint calls never overlap',async t=>{
  let release,running=0,max=0,writes=0;const {q}=setup(t,async()=>{max=Math.max(max,++running);if(++writes===1)await new Promise(resolve=>release=resolve);running--;});q.schedule();const first=q.flush({force:true}),second=q.flush({force:true});q.schedule();release();await Promise.all([first,second]);assert.equal(max,1);assert.equal(q.pending,false);
});
test('disposing a closed tab cancels its idle timer',async t=>{let writes=0;const {c,q}=setup(t,async()=>writes++);q.schedule();q.dispose();await c.advance(600000);q.schedule();assert.equal(writes,0);assert.equal(c.timers.size,0);});
