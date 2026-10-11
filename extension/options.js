const input=document.getElementById('pwa-url');input.value=(await chrome.storage.local.get('pwaUrl')).pwaUrl||'http://localhost:4173/';
document.getElementById('form').onsubmit=async event=>{
  event.preventDefault();const status=document.getElementById('status');
  try{const url=new URL(input.value);if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname)))throw new Error('HTTPS 주소 또는 localhost 주소를 입력해주세요.');if(url.username||url.password)throw new Error('사용자 정보가 포함된 주소는 사용할 수 없습니다.');url.search='';url.hash='';await chrome.storage.local.set({pwaUrl:url.href});status.textContent='저장했습니다. HTMLMemo를 새로고침해주세요.';}
  catch(error){status.textContent=error.message;}
};
