import {assertZipInflatesWithinLimits,JSZip,parseDocx,openPptx,convertOdtToDocx,convertOdpToPptx,decodeCsvBuffer} from '../vendor/office/genoffice.js';
import {OFFICE_FORMATS,OFFICE_MAX_BYTES} from './office-formats.js';
import {officeHTML,esc} from './office-common.js';
import {renderWord} from './office-word.js';
import {renderSlides} from './office-slides.js';
import {renderSheets} from './office-sheets.js';
import {renderMarkdown} from './markdown.js';

export async function inspectOfficeZip(bytes,format,warnings){
  await assertZipInflatesWithinLimits(bytes,{maxParts:10000,maxPartBytes:64*1024*1024,maxTotalBytes:256*1024*1024});
  const zip=await JSZip.loadAsync(bytes),names=new Set();
  for(const entry of Object.values(zip.files)){
    const name=entry.unsafeOriginalName||entry.name;
    if(name.startsWith('/')||name.includes('\\')||name.split('/').includes('..')||names.has(name))throw Error('문서 안에 올바르지 않은 파일 경로가 있습니다.');
    names.add(name);if(entry.dir)continue;
    if(/\.(xml|rels)$/i.test(name)){
      const text=await entry.async('string');
      if(/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text))throw Error('외부 엔터티 선언이 있는 문서는 열 수 없습니다.');
      if(/<manifest:encryption-data\b/.test(text))throw Error('암호가 설정된 문서는 암호 없이 저장한 사본으로 가져와 주세요.');
      if(/TargetMode\s*=\s*["']External["']/i.test(text)&&/relationships\/(?:image|oleObject|package|video|audio)/i.test(text))warnings.push('외부 파일로 연결된 그림·미디어는 가져오지 않습니다.');
    }
  }
  if(['xlsx','xlsm','xls','ods','ots'].includes(format)&&[...names].some(n=>/^(?:xl\/(?:drawings|charts)\/|Object \d+\/)/.test(n)))warnings.push('시트의 셀·병합·저장된 계산 결과를 표시합니다. 차트·그림·피벗의 대화형 기능은 포함하지 않습니다. 원본 파일은 그대로 보관합니다.');
  return zip;
}
export async function renderOffice(input,format,title){
  if(!Object.hasOwn(OFFICE_FORMATS,format))throw Error('지원하지 않는 문서 형식입니다.');
  let bytes=input instanceof Uint8Array?input:new Uint8Array(input);
  if(!bytes.length||bytes.length>OFFICE_MAX_BYTES)throw Error('문서 파일은 비어 있지 않은 100MB 이하 파일이어야 합니다.');
  const warnings=[];
  if(bytes[0]===0x50&&bytes[1]===0x4b)await inspectOfficeZip(bytes,format,warnings);
  let body;
  if(OFFICE_FORMATS[format]==='word'){
    if(format!=='docx'){const result=await convertOdtToDocx(bytes);bytes=result.docx;if(result.dropped.length)warnings.push('OpenDocument 변환에서 지원하지 않는 개체 '+result.dropped.reduce((n,d)=>n+d.count,0)+'개는 생략되었습니다. 원본 파일은 그대로 보관합니다.');}
    body=renderWord(await parseDocx(bytes,{expandAltChunks:false}),warnings);
  }else if(OFFICE_FORMATS[format]==='slides'){
    if(format!=='pptx'){const result=await convertOdpToPptx(bytes);bytes=result.pptx;if(result.dropped.length)warnings.push('OpenDocument 변환에서 지원하지 않는 개체 '+result.dropped.reduce((n,d)=>n+d.count,0)+'개는 생략되었습니다. 원본 파일은 그대로 보관합니다.');}
    body=renderSlides(await openPptx(bytes),warnings);
  }else if(OFFICE_FORMATS[format]==='sheet')body=renderSheets(bytes,format,warnings);
  else{
    const text=decodeCsvBuffer(bytes,'euc-kr');
    if(text.length>8*1024*1024)throw Error('텍스트 문서는 8백만 글자 이하로 나누어 가져와 주세요.');
    body=OFFICE_FORMATS[format]==='markdown'?renderMarkdown(text).html:'<pre class="office-plain">'+esc(text)+'</pre>';
  }
  const unique=[...new Set(warnings)],html=officeHTML(title,body,unique);
  if(html.length>64*1024*1024)throw Error('읽기 화면이 너무 큽니다. 문서를 나누어 가져와 주세요.');
  return {html,title,warnings:unique,allowScripts:false};
}
