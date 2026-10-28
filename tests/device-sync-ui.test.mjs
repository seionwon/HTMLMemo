import test from 'node:test';
import assert from 'node:assert/strict';
import {syncProgressDetail} from '../public/src/sync-ui.js';

test('completed progress without a file number states completion without undefined or NaN',()=>{
 const text=syncProgressDetail({direction:'send',bytes:963000000,total:963000000,files:2,complete:true});
 assert.match(text,/전송 완료/);assert.doesNotMatch(text,/undefined|NaN|파일/);
});
test('commit progress clearly distinguishes sending from saving received data',()=>{
 assert.match(syncProgressDetail({direction:'send',bytes:10,total:10,files:2,phase:'commit'}),/상대 기기의 저장·선택 확인 중/);
 assert.match(syncProgressDetail({direction:'receive',bytes:10,total:10,files:2,phase:'commit'}),/받은 문서 저장 중/);
});
test('only valid file numbers are shown and reused originals remain visible after a reply',()=>{
 assert.match(syncProgressDetail({direction:'send',bytes:10,total:20,file:1,files:2}),/파일 1 \/ 2/);
 for(const file of [undefined,null,-1,3])assert.doesNotMatch(syncProgressDetail({direction:'send',file,files:2}),/파일|undefined|NaN/);
 assert.match(syncProgressDetail({direction:'send',bytes:10,total:10,complete:true},{files:2,bytes:64*1024*1024}),/같은 파일 2개 \(64\.0 MB\) 전송 생략/);
});
