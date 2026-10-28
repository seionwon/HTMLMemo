import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
export const storageSource=await readFile(new URL('../public/src/storage.js',import.meta.url),'utf8');
export function sourceCacheFixture({code=storageSource,file=new Blob(['original source'],{type:'text/html'}),key='initial-key'}={}){
  const metadata={version:1,title:'Book',source:'',viewport:{width:1000,height:800},view:{scrollTop:0},annotations:[],bookmarks:[]};
  let stores=new Map([['documents',new Map([['book',{id:'book',title:'Book',name:'book.html',created:1,modified:2,metadata,historyVersion:0,...(key?{contentKey:key}:{})}]])],['contents',new Map([['book',{documentId:'book',file,originalFile:file}]])],['settings',new Map([['library-folders-v1',[]]])],['revisions',new Map()],['revisionHeaders',new Map()]]);
  const reads=[],writes=[],control={};
  const connection={transaction(names,mode){
    const snapshot=structuredClone(stores);let pending=0,aborted=false,scheduled=false;const tx={};
    const request=value=>{pending++;const r={};queueMicrotask(()=>{if(aborted)return;r.result=structuredClone(value);r.onsuccess?.();pending--;if(!pending&&!scheduled){scheduled=true;setImmediate(()=>{if(aborted)return;if(mode==='readwrite')stores=snapshot;tx.oncomplete?.();});}});return r;};
    tx.abort=()=>{aborted=true;queueMicrotask(()=>tx.onabort?.());};
    tx.objectStore=name=>{
      const rows=snapshot.get(name),write=()=>{writes.push(name);if(mode!=='readwrite')throw Error('Readonly write');if(control.fail===name)throw Error('Disk full');};
      return {get:key=>{reads.push(name);return request(rows.get(key));},getAll:()=>request([...rows.values()]),getKey:key=>request(rows.has(key)?key:undefined),
        put:(value,key)=>{write();const id=key??(name==='contents'?value.documentId:value.id);rows.set(id,structuredClone(value));return request(id);},
        add:value=>{write();const id=name==='contents'?value.documentId:value.id;if(rows.has(id))throw Error('Already exists');rows.set(id,structuredClone(value));return request(id);},
        delete:key=>{write();rows.delete(key);return request(undefined);},index:()=>({getAll:id=>request([...rows.values()].filter(r=>r.documentId===id))})};
    };return tx;
  }};
  const context=vm.createContext({connection,structuredClone,Blob,crypto,Date,IDBKeyRange:{only:id=>id}});
  vm.runInContext(code.replace(/^export /gm,'')+'\ndatabase=Promise.resolve(connection);this.api={getDocument,putDocumentView,commitDeviceSync,syncRecordSnapshot,restoreFolderDocuments,...(typeof documentSource===\'function\'?{documentSource}:{})};',context);
  return {api:context.api,reads,writes,control,get stores(){return stores;}};
}
