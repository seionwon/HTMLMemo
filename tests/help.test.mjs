import test from 'node:test';
import assert from 'node:assert/strict';
import {DOMParser} from 'linkedom';
import {HELP_TOPICS,HELP_GROUPS} from '../public/src/help-content.js';
import {searchHelp,highlightHelp,openHelp} from '../public/src/help.js';

test('help topics have unique navigation targets and no broken related-topic references',()=>{
 const ids=new Set(HELP_TOPICS.map(topic=>topic.id));assert.equal(ids.size,HELP_TOPICS.length);
 for(const topic of HELP_TOPICS){assert.ok(HELP_GROUPS.some(group=>group.id===topic.group));assert.ok(topic.sections.length);assert.ok((topic.related||[]).every(id=>ids.has(id)));}
 assert.ok(HELP_GROUPS.every(group=>HELP_TOPICS.some(topic=>topic.group===group.id)));
});
test('help search ranks title matches and searches complete body text with multiple terms',()=>{
 assert.equal(searchHelp('기기 간 동기화의 범위와 원본 생략')[0].topic.id,'device-sync');
 assert.ok(searchHelp('브라우저 데이터 복원').some(row=>row.topic.id==='backup-restore'));
 assert.ok(searchHelp('원본 생략').every(row=>[row.topic.title,row.topic.summary,row.topic.keywords,...row.topic.sections.map(section=>JSON.stringify(section))].join(' ').includes('원본')));
 assert.equal(searchHelp('존재하지않는아무말874293').length,0);assert.equal(searchHelp('   ').length,HELP_TOPICS.length);
});
test('help search accepts Korean spacing, Unicode-compatible and case-insensitive format names',()=>{
 assert.ok(searchHelp('  ｍｈｔ  ').some(row=>row.topic.id==='import-files'));
 assert.equal(searchHelp('TTS')[0].topic.id,'speech');
 assert.ok(searchHelp('기기\n간\t동기화').some(row=>row.topic.id==='device-sync'));
 assert.doesNotThrow(()=>searchHelp('('.repeat(10000)));
});
test('search highlighting treats regex characters literally and escapes HTML before marking',()=>{
 const html=highlightHelp('<script>alert(1)</script> [x] .* $1','[x] .* $1');
 const doc=new DOMParser().parseFromString('<html><body>'+html+'</body></html>','text/html');
 assert.equal(doc.querySelector('script'),null);assert.equal(doc.querySelectorAll('mark').length,3);assert.equal(doc.body.textContent,'<script>alert(1)</script> [x] .* $1');
 assert.equal(highlightHelp('<b>보관</b>',''), '&lt;b&gt;보관&lt;/b&gt;');
});
function fixture(){
 const doc=new DOMParser().parseFromString('<html><body><dialog id="dialog"><div id="dialog-content"></div></dialog></body></html>','text/html');
 Object.defineProperty(doc,'activeElement',{value:doc.body,writable:true,configurable:true});doc.defaultView.HTMLElement.prototype.focus=function(){doc.activeElement=this;};
 const selectPrototype=Object.getPrototypeOf(doc.createElement('select'));Object.defineProperty(selectPrototype,'value',{configurable:true,get(){return this.getAttribute('data-value')||'';},set(value){this.setAttribute('data-value',value);}});
 const dialog=doc.querySelector('#dialog');dialog.close=()=>{dialog.open=false;dialog.onclose?.();};let back=0,closed=0;
 openHelp({modal:(html,bind)=>{doc.querySelector('#dialog-content').innerHTML=html;dialog.open=true;doc.querySelector('[data-dialog-close]').onclick=()=>dialog.close();bind(dialog);},onBack:()=>back++,onClose:()=>closed++});
 const query=value=>{const input=doc.querySelector('#help-search');input.value=value;input.oninput({isComposing:false});};
 return {doc,dialog,query,get back(){return back;},get closed(){return closed;}};
}
test('help search results open an article, retain the query and return to the same results',()=>{
 const f=fixture();assert.equal(f.doc.activeElement.id,'help-article-title');f.query('원본 생략');
 assert.ok(f.doc.querySelector('.help-results'));f.doc.querySelector('.help-results [data-help-open="device-sync"]').onclick();
 assert.match(f.doc.querySelector('#help-article-title').textContent,/동기화/);assert.equal(f.doc.querySelector('#help-search').value,'원본 생략');assert.ok(f.doc.querySelectorAll('.help-article mark').length);
 f.doc.querySelector('#help-results-back').onclick();assert.ok(f.doc.querySelector('.help-results'));assert.equal(f.doc.activeElement.id,'help-search');
});
test('empty and hostile searches show a recoverable empty state without creating executable content',()=>{
 const f=fixture();f.query('<img src=x onerror=alert(1)>');assert.equal(f.doc.querySelector('.help-results img'),null);assert.match(f.doc.querySelector('#help-results-title').textContent,/없습니다/);
 f.doc.querySelector('#help-empty-clear').onclick();assert.equal(f.doc.querySelector('#help-search').value,'');assert.ok(f.doc.querySelector('#help-article-title'));
});
test('help supports mobile topic selection, related navigation and separate back and close actions',()=>{
 const f=fixture(),picker=f.doc.querySelector('#help-topic-select');picker.value='trash';picker.onchange();assert.match(f.doc.querySelector('#help-article-title').textContent,/영구 삭제/);
 f.doc.querySelector('[data-help-related="backup-restore"]').onclick();assert.match(f.doc.querySelector('#help-article-title').textContent,/백업/);
 f.doc.querySelector('#help-back-settings').onclick();assert.equal(f.back,1);assert.equal(f.closed,0);
 f.doc.querySelector('[data-dialog-close]').onclick();assert.equal(f.closed,1);assert.equal(f.dialog.open,false);
});
