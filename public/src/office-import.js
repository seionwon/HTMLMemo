// The parser runs only after duplicate confirmation, outside the UI thread.
// Its imports and worker are same-origin assets also cached by the PWA.
export async function prepareOffice(snapshot){
  if(!snapshot.office)return snapshot;
  const bytes=await snapshot.office.arrayBuffer();
  return new Promise((resolve,reject)=>{
    let worker,timer;
    const finish=(error,result)=>{clearTimeout(timer);worker?.terminate();error?reject(error):resolve(result);};
    try{
      worker=new Worker(new URL('src/office-worker.js',document.baseURI),{type:'module'});
      timer=setTimeout(()=>finish(Error('문서를 읽는 시간이 너무 오래 걸립니다. 문서를 나누어 저장한 뒤 다시 가져와 주세요.')),120000);
      worker.onmessage=({data})=>finish(data.error?Error(data.error):null,data.result);
      worker.onerror=()=>finish(Error('문서 읽기 도구를 불러오지 못했습니다. 앱을 다시 열거나 업데이트한 뒤 시도해주세요.'));
      worker.postMessage({bytes,format:snapshot.officeFormat,title:snapshot.title},[bytes]);
    }catch(error){finish(error);}
  });
}
