import {SyncService,cleanRoomId} from './sync-service.js';
import {DeviceSyncAdapter} from './sync-adapter.js';
import {drawSyncQR} from './sync-qr.js';
import {escapeHTML as esc,icon} from './utils.js';
import {assetText} from './bundler.js';

const randomCode=()=>{const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789',bytes=crypto.getRandomValues(new Uint8Array(12));return 'HM-'+[0,4,8].map(i=>[...bytes.slice(i,i+4)].map(b=>alphabet[b%32]).join('')).join('-');};
const statuses={connecting:'중계 서버에 연결하는 중…',ready:'상대 기기를 기다립니다.',connected:'상대 기기에 연결했습니다.',syncing:'암호화한 데이터를 주고받는 중…',merging:'받은 데이터를 검증·저장하는 중…',completed:'동기화를 완료했습니다.',error:'동기화하지 못했습니다.'};
let scannerLibrary;
function loadScanner(){return scannerLibrary ||= new Promise((resolve,reject)=>{
  if(globalThis.Html5Qrcode){resolve();return;}
  const script=document.createElement('script'),embedded=document.getElementById('htmlmemo-package-assets');
  if(embedded){const data=assetText(JSON.parse(embedded.textContent).app['vendor/html5-qrcode.min.js']);script.textContent=data;document.head.append(script);globalThis.Html5Qrcode?resolve():reject(Error('QR 판독기를 불러오지 못했습니다.'));}
  else{script.src=new URL('vendor/html5-qrcode.min.js',document.baseURI);script.onload=()=>resolve();script.onerror=()=>{scannerLibrary=null;reject(Error('QR 판독기를 불러오지 못했습니다. 연결 코드를 직접 입력해주세요.'));};document.head.append(script);}
});}

export function openDeviceSync({modal,currentId,prepare,afterCommit,onClose,onError}){
  let service=null,role='host',closed=false,scanner=null,resolveConflict=null,prepared=false,preparing=null,scanEpoch=0;
  const cleanup=()=>{closed=true;scanEpoch++;service?.destroy();if(scanner)void scanner.stop().catch(()=>{});resolveConflict?.(null);resolveConflict=null;if(prepared||preparing)void Promise.resolve(preparing).then(()=>onClose?.()).catch(onError);};
  modal(`<section class="device-sync"><div class="dialog-heading"><h2>기기 간 동기화</h2><button class="icon-button" data-dialog-close aria-label="닫기">${icon('close')}</button></div><p class="dialog-description">로그인 없이 연결 코드·QR로 기기를 연결합니다. 문서·주석·북마크·읽기 위치·저장 이력과 <strong>휴지통</strong>도 함께 주고받습니다.</p><div class="sync-tabs" role="tablist"><button id="sync-host-tab" role="tab" aria-selected="true" class="primary-button">기준 기기</button><button id="sync-join-tab" role="tab" aria-selected="false" class="secondary-button">상대 기기에 연결</button></div><fieldset id="sync-options"><legend>동기화할 데이터</legend><label>범위 <select id="sync-scope"><option value="all">서재 전체 · 휴지통 포함</option>${currentId?'<option value="current">현재 문서만 공유</option>':''}</select></label><label><input id="sync-sources" type="checkbox" checked> 원본 파일 포함</label><label><input id="sync-settings" type="checkbox" checked> 기준 기기의 앱 설정 적용</label><p class="dialog-description small">원본 포함을 끄면 양쪽 기기에 같은 HTML 원본이 있어야 합니다. 전용 저장 폴더의 이름·연결·권한은 기기마다 그대로 유지합니다.</p></fieldset><div id="sync-host"><label for="sync-room">연결 코드</label><div class="sync-code-row"><input id="sync-room" autocapitalize="characters" spellcheck="false"><button id="sync-copy" class="secondary-button">복사</button><button id="sync-new" class="secondary-button">새 코드</button></div><canvas id="sync-qr" role="img" aria-label="상대 기기에서 스캔할 연결 코드 QR"></canvas><button id="sync-start" class="primary-button">연결 시작</button></div><div id="sync-join" hidden><label for="sync-target">기준 기기의 연결 코드</label><input id="sync-target" autocapitalize="characters" spellcheck="false" autocomplete="off"><div class="dialog-actions"><button id="sync-scan" class="secondary-button">QR 스캔</button><button id="sync-connect" class="primary-button">연결</button></div><div id="sync-scanner" hidden></div></div><p id="sync-summary" class="dialog-description small" aria-live="polite"></p><p id="sync-status" role="status" aria-live="polite">연결 시작을 누르면 중계 서버에 접속합니다.</p><div id="sync-conflict" hidden></div><p class="dialog-description small">전송할 때만 인터넷이 필요합니다. 데이터는 기기에서 암호화하며 외부 중계 서버에 임시 보관될 수 있습니다. 이 창을 닫으면 연결을 종료합니다.</p></section>`,dialog=>{
    const q=s=>dialog.querySelector(s),status=q('#sync-status');
    const fail=error=>{if(!closed){status.textContent=error?.message||String(error);status.dataset.state='error';q('#sync-options').disabled=false;q('#sync-start').disabled=false;q('#sync-connect').disabled=false;}};
    dialog.addEventListener('close',cleanup,{once:true});
    const makeCode=()=>{q('#sync-room').value=randomCode();drawSyncQR(q('#sync-qr'),q('#sync-room').value);};makeCode();
    q('#sync-new').onclick=()=>{service?.destroy();service=null;makeCode();status.textContent='새 연결 코드입니다. 연결 시작을 눌러주세요.';};
    q('#sync-room').oninput=()=>drawSyncQR(q('#sync-qr'),cleanRoomId(q('#sync-room').value));
    q('#sync-copy').onclick=async()=>{try{await navigator.clipboard.writeText(cleanRoomId(q('#sync-room').value));status.textContent='연결 코드를 복사했습니다.';}catch{q('#sync-room').select();status.textContent='선택된 연결 코드를 직접 복사해주세요.';}};
    const chooseRole=value=>{scanEpoch++;if(scanner){void scanner.stop().catch(()=>{});scanner=null;q('#sync-scanner').hidden=true;q('#sync-scan').textContent='QR 스캔';}service?.destroy();service=null;role=value;q('#sync-host').hidden=value!=='host';q('#sync-join').hidden=value!=='join';for(const r of ['host','join']){const tab=q('#sync-'+r+'-tab');tab.setAttribute('aria-selected',String(r===value));tab.className=r===value?'primary-button':'secondary-button';}q('#sync-options').disabled=false;};
    q('#sync-host-tab').onclick=()=>chooseRole('host');q('#sync-join-tab').onclick=()=>chooseRole('join');
    const conflicts=items=>new Promise(resolve=>{
      resolveConflict=resolve;let i=0;const choices=[],box=q('#sync-conflict');box.hidden=false;
      const render=()=>{const item=items[i];box.innerHTML=`<h3>서로 다른 문서 ${i+1}/${items.length}</h3><strong>${esc(item.title)}</strong><p>${esc(item.localContent)}</p><p>${esc(item.remoteContent)}</p><p class="dialog-description small">상대 내용을 사용해도 이 기기의 이전 내용은 별도 보관본으로 남깁니다.</p><div class="dialog-actions"><button data-choice="local" class="secondary-button">이 기기 유지</button><button data-choice="remote" class="secondary-button">상대 기기 사용</button><button data-choice="both" class="primary-button">둘 다 보관</button></div>`;box.querySelectorAll('[data-choice]').forEach(button=>button.onclick=()=>{choices.push(button.dataset.choice);if(++i<items.length)render();else{box.hidden=true;resolveConflict=null;resolve(choices);}});};render();
    });
    const begin=async()=>{
      try{
        if(service)service.destroy();
        const code=cleanRoomId(q(role==='host'?'#sync-room':'#sync-target').value);if(code.length<6||code.length>80)throw Error('기준 기기에 표시된 연결 코드를 입력해주세요.');
        q('#sync-options').disabled=true;q('#sync-start').disabled=true;q('#sync-connect').disabled=true;
        if(!prepared){preparing=prepare();await preparing;prepared=true;}if(closed)return;
        let session;const adapter=new DeviceSyncAdapter({includeSources:q('#sync-sources').checked,includeSettings:q('#sync-scope').value==='all'&&q('#sync-settings').checked,isHost:()=>role==='host',isActive:()=>!closed&&service===session&&!session?.isDestroyed,afterCommit});
        session=new SyncService({adapter,initialDataLogId:q('#sync-scope').value==='current'?currentId:undefined,onConflict:conflicts,onSyncInfo:info=>{q('#sync-summary').textContent=(info.type==='full'?'서재 전체':'선택 문서')+' · '+info.count+'개'+(info.type==='full'?'':' · '+(info.label||''));},onDataReceived:()=>{},onStatusChange:(state,message)=>{
          if(closed||service!==session)return;status.dataset.state=state;status.textContent=state==='error'?(message||statuses.error):statuses[state]||message;
          if(state==='completed'||state==='error'){q('#sync-options').disabled=false;q('#sync-start').disabled=false;q('#sync-connect').disabled=false;service?.destroy();}
        }});
        service=session;role==='host'?await service.initialize(code):await service.connect(code);
      }catch(error){service?.destroy();fail(error);}
    };
    q('#sync-scope').onchange=()=>{q('#sync-settings').disabled=q('#sync-scope').value==='current';};
    q('#sync-start').onclick=begin;q('#sync-connect').onclick=begin;q('#sync-target').onkeydown=e=>{if(e.key==='Enter')void begin();};
    q('#sync-scan').onclick=async()=>{try{
      if(scanner){scanEpoch++;await scanner.stop();scanner=null;q('#sync-scanner').hidden=true;q('#sync-scan').textContent='QR 스캔';return;}
      const epoch=++scanEpoch;await loadScanner();if(closed||epoch!==scanEpoch)return;q('#sync-scanner').hidden=false;scanner=new globalThis.Html5Qrcode('sync-scanner');
      const camera=scanner;let accepted=false;await camera.start({facingMode:'environment'},{fps:10,qrbox:200},code=>{if(closed||epoch!==scanEpoch||accepted)return;accepted=true;q('#sync-target').value=cleanRoomId(code);void camera.stop().then(()=>{scanner=null;if(closed||epoch!==scanEpoch)return;q('#sync-scanner').hidden=true;q('#sync-scan').textContent='QR 스캔';void begin();}).catch(fail);},()=>{});if(closed||epoch!==scanEpoch){await camera.stop().catch(()=>{});return;}q('#sync-scan').textContent='스캔 중지';
    }catch(error){scanner=null;q('#sync-scanner').hidden=true;fail(error);}};
  });
}
