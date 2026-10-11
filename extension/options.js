const input=document.getElementById('pwa-url');const bundled=chrome.runtime.getURL('app/index.html');input.value=(await chrome.storage.local.get('pwaUrl')).pwaUrl||bundled;
document.getElementById('form').onsubmit=async event=>{
  event.preventDefault();const status=document.getElementById('status');
  try{const url=new URL(input.value);url.search='';url.hash='';if(url.href!==bundled&&url.protocol!=='file:')throw new Error('서버 없는 기본 앱 또는 로컬 HTML 파일을 선택해주세요.');if(url.username||url.password)throw new Error('사용자 정보가 포함된 주소는 사용할 수 없습니다.');await chrome.storage.local.set({pwaUrl:url.href});status.textContent='저장했습니다. HTMLMemo 파일을 다시 열어주세요.';}
  catch(error){status.textContent=error.message;}
};
document.getElementById('default-app').onclick=async()=>{input.value=bundled;await chrome.storage.local.set({pwaUrl:bundled});document.getElementById('status').textContent='서버 없는 기본 앱으로 연결했습니다. 「HTMLMemo 열기」를 누르세요.';};
