import {parseHTML,serializeHTML} from './document.js';

export const PDF_ARCHIVE_MARKER='<!--HTMLMemo-PDF:1-->';
const PAYLOAD='<template id="htmlmemo-pdf-source">',END='</template>';
export const isPDFFile=file=>/\.pdf$/i.test(file?.name||'')||/^application\/pdf(?:;|$)/i.test(file?.type||'');
export const isPDFDocument=metadata=>metadata?.format==='pdf';
export function pdfShell(title='PDF 문서'){
  const doc=new DOMParser().parseFromString('<!doctype html><html lang="ko"><head><meta charset="utf-8"></head><body data-htmlmemo-anchor="body"><main id="htmlmemo-pdf-pages" data-tts-root></main></body></html>','text/html');
  doc.title=title;return '<!doctype html>'+doc.documentElement.outerHTML;
}
export function preparePDF(source,{title='PDF 문서',metadata,freshAnnotations=false}={}){
  if(!(source instanceof Blob)||!source.size)throw Error('PDF 파일이 비어 있습니다.');
  const result=parseHTML(pdfShell(title),{title},{allowScripts:false});
  if(metadata)result.metadata=structuredClone(metadata);
  result.metadata.format='pdf';result.metadata.execution={allowScripts:false};
  if(freshAnnotations){result.metadata.annotations=[];result.metadata.bookmarks=[];result.metadata.view={scrollTop:0,scrollLeft:0,autoFit:true};}
  return {...result,pdfSource:source,nativeScroll:true,savedMetadata:true};
}
export async function verifyPDF(source){
  const head=new TextDecoder('ascii').decode(await source.slice(0,1024).arrayBuffer());
  if(!/%PDF-\d\.\d/.test(head))throw Error('올바른 PDF 파일이 아닙니다. 원본 파일을 확인해주세요.');
}
/** Portable PDF+LibreMemo annotations, without a network URL or executable code.
 * Base64 is emitted in bounded chunks, never as one enormous intermediate string. */
export async function exportPDFHTML(source,metadata){
  const doc=new DOMParser().parseFromString(pdfShell(metadata.title),'text/html');
  const hint=doc.createElement('p');hint.textContent='이 파일은 PDF 원본과 주석을 함께 담고 있습니다. LibreMemo의 파일 가져오기로 열어주세요.';doc.body.append(hint);
  let shell=serializeHTML(doc,metadata);const at=shell.indexOf('</body>');
  const parts=[PDF_ARCHIVE_MARKER,shell.slice(0,at),PAYLOAD];
  for(let offset=0;offset<source.size;offset+=196608){
    const bytes=new Uint8Array(await source.slice(offset,offset+196608).arrayBuffer());
    let binary='';for(let i=0;i<bytes.length;i+=16384)binary+=String.fromCharCode(...bytes.subarray(i,i+16384));
    parts.push(new Blob([btoa(binary)]));
  }
  parts.push(END,shell.slice(at));return new Blob(parts,{type:'text/html;charset=utf-8'});
}
/** The archive contains only base64 bytes and inert, validated app metadata.
 * Decode incrementally so an exported PDF is not turned into a giant DOM tree. */
export async function readPDFArchive(file){
  const decoder=new TextDecoder('utf-8',{fatal:true}),parts=[];let header='',pending='',inPayload=false,finished=false;
  for(let offset=0;offset<file.size;offset+=262144){
    if(finished)break;
    let chunk=decoder.decode(await file.slice(offset,offset+262144).arrayBuffer(),{stream:offset+262144<file.size});
    if(!inPayload){header+=chunk;const at=header.indexOf(PAYLOAD);if(at<0){if(header.length>64*1024*1024)throw Error('PDF 보관 파일의 문서 정보가 너무 큽니다.');continue;}chunk=header.slice(at+PAYLOAD.length);header=header.slice(0,at);inPayload=true;}
    pending+=chunk;const end=pending.indexOf(END);if(end>=0){pending=pending.slice(0,end);finished=true;}
    const length=finished?pending.length:Math.max(0,Math.floor((pending.length-END.length)/4)*4);
    if(length){const encoded=pending.slice(0,length);if(!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)||encoded.length%4)throw Error('PDF 보관 파일의 본문이 손상되었습니다.');try{const binary=atob(encoded);parts.push(new Blob([Uint8Array.from(binary,c=>c.charCodeAt(0))]));}catch{throw Error('PDF 보관 파일의 본문이 손상되었습니다.');}pending=pending.slice(length);}
  }
  if(!inPayload||!finished||pending)throw Error('PDF 보관 파일의 끝부분이 없거나 손상되었습니다.');
  const source=new Blob(parts,{type:'application/pdf'});await verifyPDF(source);
  const parsed=parseHTML(header+'<body></body></html>',{title:file.name},{allowScripts:false});
  parsed.metadata.format='pdf';return {pdf:source,title:parsed.metadata.title,metadata:parsed.metadata};
}
