import '../vendor/pdf-export/pdf-export.js';
const writeAnnotatedPDF=globalThis.__librememoWritePDF;
self.onmessage=async({data})=>{
  try{const result=await writeAnnotatedPDF(data.bytes,data.plan,{onProgress:progress=>self.postMessage({progress})});self.postMessage({bytes:result},[result.buffer]);}
  catch(error){self.postMessage({error:/[가-힣]/.test(error.message||'')?error.message:'PDF를 만들지 못했습니다. 원본 PDF와 주석은 변경하지 않았습니다.'});}
};
