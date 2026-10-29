// Synthetic documents only. Shared by trusted preview Chrome and CI/public Chrome.
export async function fullPerformanceProbe(moduleBase,onStage=()=>{}) {
  const {Reader}=await import(moduleBase+'reader.js'),{parseHTML,rangeFromOffsets}=await import(moduleBase+'document.js');
  const check=(condition,message)=>{if(!condition)throw Error(message);};
  const host=document.createElement('div');host.style.cssText='position:fixed;inset:72px 12px 12px;background:white;z-index:10000';document.body.append(host);
  const source='<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>긴 문서 최적화 검사</title><style>body{font:18px/1.8 system-ui;margin:24px}p{margin:16px 0}</style></head><body><h1>선택·메모·실행 취소 검사</h1><main>'+Array.from({length:2500},(_,i)=>`<p id="row-${i}">문단 ${i}에서 선택한 글에 메모를 남깁니다.</p>`).join('')+'</main></body></html>';
  const parsed=parseHTML(source);parsed.savedMetadata=true;parsed.metadata.annotations=[{id:'retained-pen',type:'pen',color:'#334155',width:2,opacity:1,points:Array.from({length:100},(_,i)=>({x:40+i,y:145+i%4}))}];
  const reader=new Reader(host,parsed,{onSidebarView(){},requestText:async()=> '선택한 글의 검사 메모'});
  try{
    onStage('loading');await reader.ready;onStage('ready');
    for(let i=0;i<20;i++)reader.commit([...reader.metadata.annotations,reader.annotation('note',{text:'이력 메모 '+i,points:[{x:20+i*4,y:100}]})]);
    const retained=new Set(reader.history.entries.flatMap(entry=>entry.filter(a=>a.type==='pen').map(a=>a.points)));
    check(retained.size===1,'History duplicated unchanged pen coordinates');
    const detached=reader.history.current;detached[0].points[0].x=-999;check(reader.history.current[0].points[0].x===40,'History shares editable copies');
    const doc=reader.doc,walk=doc.createTreeWalker.bind(doc),intersects=doc.defaultView.Range.prototype.intersectsNode;let walks=0,probes=0;
    doc.createTreeWalker=(...args)=>{if(args[0]===doc.body)walks++;return walk(...args);};
    doc.defaultView.Range.prototype.intersectsNode=function(node){probes++;return intersects.call(this,node);};
    const select=(node,start,end)=>{const range=doc.createRange();range.setStart(node,start);range.setEnd(node,end);doc.getSelection().removeAllRanges();doc.getSelection().addRange(range);return reader.captureTextSelection();};
    let anchor;
    const start=performance.now();
    for(let i=0;i<50;i++){const node=doc.getElementById('row-'+i*41).firstChild,offset=node.textContent.indexOf('선택한');anchor=select(node,offset,offset+5);check(anchor?.quote==='선택한 글','Wrong selection in a long document');}
    const selection={paragraphs:2500,selections:50,walks,probes,elapsedMs:performance.now()-start};
    check(walks<=1&&probes===0,'Selection rescans the whole document');onStage('selection-checked');
    reader.addText('highlight',anchor);check(doc.querySelector('[data-htmlmemo-mark]')?.textContent==='선택한 글','Highlight target changed');
    check(reader.restoreTextSelection(anchor),'Selection could not be restored');await reader.addSelectionNote();
    check(reader.metadata.annotations.at(-1).textAnchor.quote==='선택한 글','Selected note lost its quote');
    const edited=JSON.stringify(reader.metadata.annotations);reader.undo();reader.redo();check(JSON.stringify(reader.metadata.annotations)===edited,'Undo/redo changed annotations');
    const row=doc.getElementById('row-0');row.textContent='새로운 본문과 선택한 글입니다.';
    check(select(row.firstChild,0,3)?.quote==='새로운','Queued source changes reused old text');
    reader.search('새로운',true);const index=reader.searchCache().get(),match=reader.searchResults[0],range=rangeFromOffsets(doc,match.start,match.end,index);
    doc.getSelection().removeAllRanges();doc.getSelection().addRange(range);check(reader.captureTextSelection()?.quote==='새로운','Search wrapping invalidated selection offsets');
    const reopened=parseHTML(reader.html());check(reopened.metadata.annotations.length===23,'Export lost annotations');check(reopened.metadata.annotations.at(-1).textAnchor.quote==='선택한 글','Export lost the note anchor');
    doc.defaultView.Range.prototype.intersectsNode=intersects;
    const result={selection,retainedPenPointArrays:retained.size,historyEntries:reader.history.entries.length,undoRedo:true,selectedNote:true,sourceInvalidation:true,searchSplits:true,exportAnnotations:reopened.metadata.annotations.length};
    onStage('complete');return result;
  }finally{reader.dispose();host.remove();}
}
