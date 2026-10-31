// Opening formats from GenOffice 36a509e8 (app-routing.ts), plus LibreMemo HTML/MHTML/PDF.
export const OFFICE_FORMATS={
  hwp:'hangul',hwpx:'hangul',hml:'hangul',
  docx:'word',odt:'word',ott:'word',
  xlsx:'sheet',xlsm:'sheet',xls:'sheet',csv:'sheet',tsv:'sheet',ods:'sheet',ots:'sheet',
  pptx:'slides',odp:'slides',otp:'slides',
  md:'markdown',markdown:'markdown',txt:'text',json:'text',
};
export const OFFICE_MIMES={
  'application/x-hwp':['.hwp'],'application/hwp+zip':['.hwpx'],'application/x-hwpml':['.hml'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':['.docx'],
  'application/vnd.oasis.opendocument.text':['.odt'],
  'application/vnd.oasis.opendocument.text-template':['.ott'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':['.xlsx'],
  'application/vnd.ms-excel.sheet.macroenabled.12':['.xlsm'],
  'application/vnd.ms-excel':['.xls'],
  'text/csv':['.csv'],'text/tab-separated-values':['.tsv'],
  'application/vnd.oasis.opendocument.spreadsheet':['.ods'],
  'application/vnd.oasis.opendocument.spreadsheet-template':['.ots'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation':['.pptx'],
  'application/vnd.oasis.opendocument.presentation':['.odp'],
  'application/vnd.oasis.opendocument.presentation-template':['.otp'],
  'text/markdown':['.md','.markdown'],'text/plain':['.txt'],'application/json':['.json'],
};
export const DOCUMENT_EXTENSIONS=['html','htm','mhtml','mht','pdf',...Object.keys(OFFICE_FORMATS)];
export function documentExtension(name){const ext=String(name||'').match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();return DOCUMENT_EXTENSIONS.includes(ext)?ext:null;}
export function officeFormat(file){
  const ext=String(file?.name||'').match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  if(ext)return Object.hasOwn(OFFICE_FORMATS,ext)?ext:null;
  return OFFICE_MIMES[String(file?.type||'').split(';')[0].toLowerCase()]?.[0].slice(1)||null;
}
export const OFFICE_MAX_BYTES=100*1024*1024;
export async function verifyOffice(file,format){
  if(!file.size)throw Error('문서 파일이 비어 있습니다.');
  if(file.size>OFFICE_MAX_BYTES)throw Error('이 형식은 100MB 이하의 파일을 열 수 있습니다. 문서를 나누어 저장한 뒤 가져와 주세요.');
  if(['markdown','text'].includes(OFFICE_FORMATS[format])||['csv','tsv'].includes(format))return;
  const b=new Uint8Array(await file.slice(0,8).arrayBuffer());
  const zip=b[0]===0x50&&b[1]===0x4b&&b[2]===3&&b[3]===4;
  const ole=[0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1].every((n,i)=>b[i]===n);
  if(format==='hml')return; // XML encoding/root/DTD validation runs in the bounded worker.
  if(format==='hwp'&&(ole||new TextDecoder().decode(b)==='HWP Docu'))return;
  if(format==='hwpx'&&zip)return;
  if(OFFICE_FORMATS[format]==='hangul')throw Error('파일 확장자와 실제 한글 문서 형식이 다르거나 파일이 손상되었습니다. 원본을 확인해주세요.');
  if(ole&&format!=='xls')throw Error('암호로 보호된 Office 문서는 열 수 없습니다. 원래 앱에서 암호 없이 저장한 사본을 가져와 주세요.');
  if(format==='xls'?(ole||zip||b[0]===9):zip)return;
  throw Error('파일 확장자와 실제 문서 형식이 다르거나 파일이 손상되었습니다. 원본 파일을 확인해주세요.');
}
