import {renderOffice} from './office-render.js';
self.onmessage=async({data})=>{
  try{self.postMessage({result:await renderOffice(data.bytes,data.format,data.title)});}
  catch(error){const message=String(error?.message||error);self.postMessage({error:/[가-힣]/.test(message)?message:/encrypt|password/i.test(message)?'암호가 설정된 문서는 암호 없이 저장한 사본으로 가져와 주세요.':'문서를 읽지 못했습니다. 파일이 손상되었거나 지원 범위를 벗어났습니다. 원래 앱에서 다시 저장한 사본을 가져와 주세요.'});}
};
