const input=document.getElementById('pwa-url');const bundled=chrome.runtime.getURL('app/index.html');const pwa='https://sweon.github.io/HTMLMemo/';input.value=(await chrome.storage.local.get('pwaUrl')).pwaUrl||pwa;
document.getElementById('form').onsubmit=async event=>{
  event.preventDefault();const status=document.getElementById('status');
  try{const url=new URL(input.value);url.search='';url.hash='';const project=url.protocol==='https:'&&url.host==='sweon.github.io'&&['/HTMLMemo/','/HTMLMemo/index.html'].includes(url.pathname);if(url.href!==bundled&&url.protocol!=='file:'&&!project)throw new Error('sweon/HTMLMemo의 PWA 또는 로컬 HTML 파일을 선택해주세요.');if(url.username||url.password)throw new Error('사용자 정보가 포함된 주소는 사용할 수 없습니다.');await chrome.storage.local.set({pwaUrl:url.href});status.textContent='저장했습니다. HTMLMemo를 다시 열거나 새로고침해주세요.';}
  catch(error){status.textContent=error.message;}
};
document.getElementById('default-app').onclick=async()=>{input.value=pwa;await chrome.storage.local.set({pwaUrl:pwa});document.getElementById('status').textContent='HTMLMemo PWA로 연결했습니다. 앱을 새로고침해주세요.';};
