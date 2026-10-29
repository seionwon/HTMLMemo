// Synthetic source only; shared by CI Chrome and the trusted preview verifier.
export async function runtimeBatchProbe(moduleBase,onStage=()=>{}) {
  const {Reader}=await import(moduleBase+'reader.js'),{parseHTML}=await import(moduleBase+'document.js');
  onStage('modules-loaded');
  const check=(value,message)=>{if(!value)throw Error(message);};
  const wait=async predicate=>{for(let i=0;i<800;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,25));}throw Error('Runtime batch did not settle');};
  const source='<!doctype html><html><head><title>Dynamic source batch</title></head><body><h1>Source updates</h1><button id="change" type="button">Update rows</button><button id="replace" type="button">Replace parent</button><p id="metrics">waiting</p><main id="rows">'+Array.from({length:2000},(_,i)=>'<p id="row-'+i+'">Before '+i+'</p>').join('')+'</main><script>let pairChecks=0;const contains=Node.prototype.contains;Node.prototype.contains=function(other){pairChecks++;return contains.call(this,other);};document.querySelector("#change").onclick=()=>{document.querySelectorAll("#rows p").forEach((p,i)=>p.firstChild.nodeValue="Changed "+i);setTimeout(()=>document.querySelector("#metrics").textContent="checks:"+pairChecks,100);};document.querySelector("#replace").onclick=()=>{const rows=document.querySelector("#rows");rows.innerHTML="<section id=final-parent><p>New</p><p>New</p></section>";rows.querySelectorAll("p").forEach((p,i)=>{p.textContent="Final "+i;p.dataset.ready="true";});};</script></body></html>';
  const host=document.createElement('div');host.style.cssText='position:fixed;inset:60px 20px 20px;background:white;z-index:10000';document.body.append(host);
  const parsed=parseHTML(source,{}, {allowScripts:true,includeMetadata:true}),errors=[];
  parsed.metadata.annotations=[{id:'preserved-note',type:'note',text:'Synthetic preserved note',color:'#edcf67',width:3,opacity:1,points:[{x:20,y:20}]}];
  parsed.savedMetadata=true;
  const reader=new Reader(host,parsed,{onError:error=>errors.push(error.message),onSidebarView(){}});
  try{
    onStage('reader-loading');await reader.ready;onStage('reader-ready');const first=reader.doc.getElementById('row-0'),before=JSON.stringify(reader.metadata.annotations),started=performance.now();check(reader.metadata.annotations.length===1,'Initial note missing');
    reader.doc.getElementById('change').click();
    onStage('rows-changing');
    await wait(()=>reader.doc.getElementById('row-1999')?.textContent==='Changed 1999'&&reader.doc.getElementById('metrics')?.textContent.startsWith('checks:'));
    const elapsedMs=performance.now()-started,pairChecks=Number(reader.doc.getElementById('metrics').textContent.slice(7));
    onStage('rows-changed');
    check(reader.doc.querySelectorAll('#rows p').length===2000,'Rows lost');check(reader.doc.getElementById('row-0')===first,'Existing source container replaced');check(pairChecks===0,'Quadratic comparisons remain');
    reader.doc.getElementById('replace').click();await wait(()=>reader.doc.querySelector('#final-parent p:last-child')?.textContent==='Final 1');
    check(reader.doc.querySelectorAll('#rows p').length===2,'Parent replacement left stale children');check(reader.doc.querySelectorAll('#rows p[data-ready=true]').length===2,'Descendant attributes lost');check(JSON.stringify(reader.metadata.annotations)===before,'Private annotations changed');check(!errors.length,errors.join('; '));
    return {rows:2000,pairChecks,elapsedMs,containerReused:true,parentReplacement:true,annotationsPreserved:true,sandboxes:{display:reader.frame.getAttribute('sandbox'),runner:reader.runtime.frame.getAttribute('sandbox')}};
  }finally{reader.dispose();}
}
