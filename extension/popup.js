const status=document.getElementById('status');
document.getElementById('capture').onclick=async()=>{
  const button=document.getElementById('capture');button.disabled=true;status.textContent='페이지를 한 파일로 보관하고 있습니다…';
  try{const [tab]=await chrome.tabs.query({active:true,currentWindow:true});const response=await chrome.runtime.sendMessage({action:'popupSave',tabId:tab.id});if(response.error)throw new Error(response.error);status.textContent='저장할 페이지를 HTMLMemo에 전달했습니다.';}
  catch(error){status.textContent=error.message;button.disabled=false;}
};
document.getElementById('options').onclick=()=>chrome.runtime.openOptionsPage();
document.getElementById('open-app').onclick=async()=>{
  const button=document.getElementById('open-app');button.disabled=true;
  try{const response=await chrome.runtime.sendMessage({action:'openApp'});if(response?.error)throw new Error(response.error);window.close();}
  catch(error){status.textContent=error.message;button.disabled=false;}
};
