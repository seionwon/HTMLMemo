import {textIndex,textIndexAsync} from './document.js';

const ignored=node=>{const element=node?.nodeType===3?node.parentElement:node;return element?.closest?.('script,style,noscript,textarea,template,[data-htmlmemo-ui]')||element?.closest?.('svg')&&!element?.closest?.('foreignObject [data-office-text]');};
const observeOptions={subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['data-htmlmemo-ui']};

// DOM nodes cannot safely survive closing a document. Keep one bounded, lazy
// cache per open reader instead of copying private book text into saved HTML.
export class SearchIndexCache {
  constructor(doc){this.doc=doc;this.entries=new Map();this.disposed=false;}
  entry(root){
    let entry=this.entries.get(root);if(entry)return entry;
    for(const [oldRoot,oldEntry] of this.entries)if(oldRoot.isConnected===false){oldEntry.observer?.disconnect();oldEntry.revision++;this.entries.delete(oldRoot);}
    entry={root,index:null,dirty:true,revision:0,results:new Map(),excluded:[],pending:null};this.entries.set(root,entry);
    const MO=this.doc.defaultView?.MutationObserver;
    if(MO){entry.observer=new MO(records=>this.changed(entry,records));entry.observer.observe(root,observeOptions);}
    return entry;
  }
  changed(entry,records){
    if(records.some(record=>record.type==='attributes'||(!ignored(record.target)&&(record.type==='characterData'||[...record.addedNodes,...record.removedNodes].some(node=>!ignored(node)))))){
      entry.dirty=true;entry.revision++;
    }
  }
  flush(entry){this.changed(entry,entry.observer?.takeRecords?.()||[]);}
  accept(entry,index){
    const excluded=[];
    if(entry.root.querySelector?.('[data-htmlmemo-book-search-slot]'))for(const item of index.nodes){
      if(!item.node.parentElement?.closest('[data-htmlmemo-book-search-slot]'))continue;
      const last=excluded.at(-1);if(last?.end===item.start)last.end=item.end;else excluded.push({start:item.start,end:item.end});
    }
    if(entry.index?.text!==index.text||JSON.stringify(entry.excluded)!==JSON.stringify(excluded))entry.results.clear();
    entry.index=index;entry.excluded=excluded;entry.dirty=false;return index;
  }
  seed(root,index){
    const entry=this.entry(root);entry.observer?.disconnect();entry.revision++;
    this.accept(entry,index);if(!this.disposed)entry.observer?.observe(root,observeOptions);return index;
  }
  get(root=this.doc.body){
    const entry=this.entry(root);this.flush(entry);
    return entry.dirty||!entry.index?this.accept(entry,textIndex(this.doc,root)):entry.index;
  }
  prepare(root=this.doc.body){
    if(this.disposed)return Promise.resolve(null);
    const entry=this.entry(root);this.flush(entry);
    if(!entry.dirty&&entry.index)return Promise.resolve(entry.index);
    if(entry.pending)return entry.pending;
    entry.pending=(async()=>{
      // Reuse a concurrent build, and retry if source scripts changed the text
      // while a yielded pass was running. A final synchronous snapshot is bounded.
      for(let attempt=0;attempt<2&&!this.disposed;attempt++){
        this.flush(entry);if(!entry.dirty&&entry.index)return entry.index;
        const revision=entry.revision,index=await textIndexAsync(this.doc,root,()=>this.disposed||root.isConnected===false||entry.revision!==revision);
        this.flush(entry);if(this.disposed||root.isConnected===false)return null;
        if(index&&revision===entry.revision)return this.accept(entry,index);
      }
      return this.disposed?null:this.get(root);
    })().finally(()=>{entry.pending=null;});
    return entry.pending;
  }
  query(query,root=this.doc.body,limit=3000){
    if(!query.trim())return {index:null,results:[]};
    const index=this.get(root),entry=this.entry(root),key=limit+'\n'+query;
    if(entry.results.has(key)){const results=entry.results.get(key);entry.results.delete(key);entry.results.set(key,results);return {index,results};}
    const results=[],pattern=new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'giu');let excludedAt=0;
    for(const match of index.text.matchAll(pattern)){
      const start=match.index,end=start+match[0].length;
      while(entry.excluded[excludedAt]?.end<=start)excludedAt++;
      if(entry.excluded[excludedAt]?.start<end)continue;
      results.push({start,end,quote:index.text.slice(Math.max(0,start-35),end+45)});if(results.length===limit)break;
    }
    entry.results.set(key,results);while(entry.results.size>8)entry.results.delete(entry.results.keys().next().value);
    return {index,results};
  }
  mutate(index,action,split=true){
    for(const entry of this.entries.values()){this.flush(entry);entry.observer?.disconnect();}
    try{return action();}finally{
      for(const entry of this.entries.values()){
        entry.revision++;if(split&&entry.index!==index)entry.dirty=true;
        if(!this.disposed)entry.observer?.observe(entry.root,observeOptions);
      }
    }
  }
  invalidate(){for(const entry of this.entries.values()){entry.dirty=true;entry.revision++;}}
  dispose(){this.disposed=true;for(const entry of this.entries.values())entry.observer?.disconnect();this.entries.clear();}
}
