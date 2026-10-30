import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {documentFor} from './dom.mjs';
import {escapeHTML} from '../public/src/utils.js';
import {folderPath} from '../public/src/library-folders.js';

const source=await readFile(new URL('../public/src/app.js',import.meta.url),'utf8');
const navigation=source.slice(source.indexOf('function navigateLibraryFolder('),source.indexOf('function toggleLibraryTrash('));
const restore=source.slice(source.indexOf('async function finishTrashChange('),source.indexOf('async function emptyLibraryTrash('));
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
function fixture({destination='part',folders=[{id:'books',parentId:'',name:'책'},{id:'part',parentId:'books',name:'1부'}]}={}){
  const doc=documentFor('<html><body><input id="library-filter" value="휴지통 검색"><div id="document-grid"></div><dialog id="dialog"></dialog></body></html>'),dialog=doc.querySelector('#dialog');
  const record={id:'restored',title:'복원할 책',name:'원본.html',folderId:'part',trashedAt:1000,metadata:{annotations:[{id:'note'}],bookmarks:[{id:'mark'}]}};
  const calls=[],messages=[],errors=[],control={};let saved,focus,scrolled;
  dialog.close=()=>dialog.open=false;
  const context=vm.createContext({folderPath,esc:escapeHTML,icon:()=>'',formatDate:String,safely:fn=>fn,
    $:(selector,root=doc)=>root.querySelector(selector),$$:(selector,root=doc)=>[...root.querySelectorAll(selector)],
    modal:(html,bind)=>{dialog.innerHTML=html;dialog.open=true;bind(dialog);},
    restoreDocument:async id=>{calls.push(['restore',id]);await control.restoreWait;if(control.restoreError)throw control.restoreError;saved=structuredClone(record);delete saved.trashedAt;saved.folderId=destination;return saved;},
    refreshLibrary:async()=>{calls.push(['refresh']);context.records=[saved];context.libraryFolders=folders;context.libraryFolderById=new Map(folders.map(f=>[f.id,f]));},
    renderLibrary:()=>{calls.push(['render']);const shown=context.libraryTrash||doc.querySelector('#library-filter').value?[]:context.records.filter(r=>(r.folderId||'')===context.libraryFolderId);doc.querySelector('#document-grid').innerHTML=shown.map(r=>`<button data-open="${r.id}">${escapeHTML(r.title)}</button>`).join('');for(const button of doc.querySelectorAll('[data-open]')){button.focus=()=>focus=button.dataset.open;button.scrollIntoView=()=>scrolled=button.dataset.open;}},
    libraryPathLabel:id=>['전용 폴더',...folderPath(folders,id).map(f=>f.name)].join(' / '),
    dataFolder:{flush:async()=>{calls.push(['flush']);await control.flushWait;if(control.flushError)throw control.flushError;}},
    toast:message=>messages.push(message),showError:error=>errors.push(error.message),
    records:[],libraryFolders:[],libraryFolderById:new Map(),libraryFolderId:'unrelated',libraryTrash:true,libraryCollapsed:new Set(['books','part']),libraryTreeVersion:0,trashBusy:false,
  });
  vm.runInContext(navigation+restore,context);context.trashDocumentMenu(record);
  return {doc,dialog,context,record,control,calls,messages,errors,click:()=>doc.querySelector('#trash-restore').onclick(),get saved(){return saved;},get focus(){return focus;},get scrolled(){return scrolled;}};
}

test('restore opens the actual nested folder, clears search and reveals the restored item without another click',async()=>{
  const f=fixture(),before=structuredClone(f.record);await f.click();
  assert.equal(f.context.libraryTrash,false);assert.equal(f.context.libraryFolderId,'part');assert.equal(f.doc.querySelector('#library-filter').value,'');assert.equal(f.context.libraryCollapsed.size,0);
  assert.equal(f.doc.querySelector('[data-open]')?.dataset.open,'restored');assert.equal(f.focus,'restored');assert.equal(f.scrolled,'restored');assert.equal(f.dialog.open,false);assert.equal(f.context.trashBusy,false);
  assert.deepEqual(f.saved.metadata,before.metadata);assert.deepEqual(f.record,before);assert.deepEqual(f.messages,['복원했습니다. 위치: 전용 폴더 / 책 / 1부']);
});
test('a removed original folder restores visibly at root before a slow folder write finishes, with repeated clicks ignored',async()=>{
  const f=fixture({destination:'',folders:[]}),wait=deferred(),started=deferred();f.control.flushWait=wait.promise;
  const flush=f.context.dataFolder.flush;f.context.dataFolder.flush=async()=>{started.resolve();await flush();};const pending=f.click();await started.promise;
  assert.equal(f.context.libraryTrash,false);assert.equal(f.context.libraryFolderId,'');assert.ok(f.doc.querySelector('[data-open=restored]'));assert.equal(f.context.trashBusy,true);assert.deepEqual(f.messages,[]);
  await f.click();assert.equal(f.calls.filter(([name])=>name==='restore').length,1);wait.resolve();await pending;assert.equal(f.context.trashBusy,false);assert.deepEqual(f.messages,['복원했습니다. 위치: 전용 폴더']);
});
test('failed storage restoration leaves the trash and its dialog intact without showing success',async()=>{
  const f=fixture();f.control.restoreError=Error('저장 실패');await assert.rejects(f.click(),/저장 실패/);
  assert.equal(f.context.libraryTrash,true);assert.equal(f.dialog.open,true);assert.equal(f.context.trashBusy,false);assert.equal(f.saved,undefined);assert.equal(f.focus,undefined);assert.deepEqual(f.calls,[['restore','restored']]);assert.deepEqual(f.messages,[]);
});
test('a failed folder write keeps the restored item visible and reports the save error',async()=>{
  const f=fixture();f.control.flushError=Error('폴더 쓰기 권한이 필요합니다.');await f.click();
  assert.equal(f.context.libraryTrash,false);assert.ok(f.doc.querySelector('[data-open=restored]'));assert.equal(f.context.trashBusy,false);assert.equal(f.saved.trashedAt,undefined);assert.deepEqual(f.messages,[]);assert.deepEqual(f.errors,['폴더 쓰기 권한이 필요합니다.']);
});
