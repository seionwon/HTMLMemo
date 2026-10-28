import test from 'node:test';
import assert from 'node:assert/strict';
import {syncProgressDetail,syncConflictMarkup} from '../public/src/sync-ui.js';
import {DOMParser} from 'linkedom';

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
test('same-HTML choices expose exactly four actions and escape document titles and summaries',()=>{
 const html=syncConflictMarkup({type:'annotations',title:'<img src=x onerror=alert(1)>',localContent:'local <script>',remoteContent:'remote & notes'},0,2),doc=new DOMParser().parseFromString('<html><body>'+html+'</body></html>','text/html');
 assert.deepEqual([...doc.querySelectorAll('[data-choice]')].map(b=>b.dataset.choice),['merge','local','remote','skip']);
 assert.deepEqual([...doc.querySelectorAll('[data-choice] strong')].map(b=>b.textContent),['합쳐서 양쪽 모두 보관','이 기기의 것을 상대 기기로','상대 기기의 것을 이 기기로','아무 것도 하지 않음']);
 assert.equal(doc.querySelector('img,script,[data-conflict-cancel]'),null);assert.match(doc.body.textContent,/주석 저장 이력/);
 const legacy=new DOMParser().parseFromString('<html><body>'+syncConflictMarkup({type:'memo',title:'Different original'},0,1)+'</body></html>','text/html');assert.ok(legacy.querySelector('[data-choice="both"]'));assert.ok(legacy.querySelector('[data-conflict-cancel]'));
});
