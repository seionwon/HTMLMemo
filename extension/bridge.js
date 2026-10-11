(() => {
  if(globalThis.htmlmemoBridgeInstalled)return;
  if(document.querySelector('meta[name="htmlmemo-app"]')?.content!=='htmlmemo-app-v1')return;
  globalThis.htmlmemoBridgeInstalled=true;
  const send=data=>window.postMessage({channel:'htmlmemo-extension',...data},location.origin==='null'?'*':location.origin);
  const actions=new Set(['ping','openBrowser','listTabs','focusTab','navigateTab','backTab','forwardTab','reloadTab','captureTab','takeCaptures','ackCapture']);
  window.addEventListener('message',async event=>{
    const message=event.data;if(event.source!==window||event.origin!==location.origin||message?.channel!=='htmlmemo-app'||!actions.has(message.action)||typeof message.id!=='string')return;
    try{const response=await chrome.runtime.sendMessage(message);send({id:message.id,...response});}catch(error){send({id:message.id,error:error.message});}
  });
  chrome.runtime.onMessage.addListener(message=>{if(message.event==='capture-ready')send({event:'capture-ready'});});
  chrome.runtime.sendMessage({action:'ping'}).then(response=>{if(!response.error)send({event:'ready'});}).catch(()=>{});
})();
