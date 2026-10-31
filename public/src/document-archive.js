// LibreMemo document archive v1: an ordinary ZIP, immutable source + current state.
// Stored entries are Blobs. A gigabyte source is never made into one JS array/string.
import {validateAnnotations,validPDFPosition,cleanSourceStorage} from './model.js';
const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
export const ARCHIVE_FORMAT='librememo-document';
export const ARCHIVE_VERSION=1;
const MAX_FILE=0xffffffff,MAX_META=16*1024*1024;
const table=Uint32Array.from({length:256},(_,i)=>{for(let n=0;n<8;n++)i=i&1?0xedb88320^(i>>>1):i>>>1;return i>>>0;});
function abort(signal){if(signal?.aborted)throw new DOMException('내보내기를 취소했습니다.','AbortError');}
export function archiveName(name,extension='librememo'){
  const leaf=safeName(name||'문서').replace(/\.(?:fb2\.zip|[a-z0-9]+)$/i,'');
  return (leaf||'문서')+'.'+extension;
}
function safeName(name){
  let value=String(name||'문서.html').normalize('NFC').split(/[\\/]/).at(-1).replace(/[\u0000-\u001f\u007f<>:"|?*]/g,'_').replace(/^[. ]+|[. ]+$/g,'')||'문서.html';
  const ext=value.match(/(?:\.fb2\.zip|\.[a-z0-9]{1,12})$/i)?.[0]||'';let stem=value.slice(0,value.length-ext.length);
  while(encoder.encode(stem+ext).length>220)stem=Array.from(stem).slice(0,-1).join('');
  return (stem||'문서')+ext;
}
function validPath(name){return typeof name==='string'&&name.length<1000&&!name.startsWith('/')&&!/[\\\u0000-\u001f\u007f]/.test(name)&&name.split('/').every(part=>part&&part!=='.'&&part!=='..');}
export function archiveMetadata(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||value.version!==1)throw Error('지원하지 않는 문서 상태 버전입니다.');
  const annotations=validateAnnotations(value.annotations),bookmarks=value.bookmarks;
  if(!Array.isArray(bookmarks)||bookmarks.length>10000||bookmarks.some(b=>!b||typeof b.id!=='string'||!b.id||b.id.length>100||typeof b.title!=='string'||b.title.length>10000||!Number.isFinite(b.top)||!Number.isFinite(b.left)||b.pdfPosition!=null&&!validPDFPosition(b.pdfPosition)))throw Error('북마크 정보가 손상되었습니다.');
  // Preserve the existing per-document fields, never any app settings, handles or identities.
  const result={version:1,title:String(value.title||'문서').slice(0,1000),source:'',capturedAt:Number(value.capturedAt)||Date.now(),viewport:{width:1100,height:800},annotations,bookmarks:structuredClone(bookmarks),view:{},execution:{allowScripts:value.execution?.allowScripts===true}};
  try{const u=new URL(value.source);if(['https:','http:'].includes(u.protocol)&&!u.username&&!u.password)result.source=u.href;}catch{/* no remote source */}
  for(const key of ['width','height'])if(Number.isFinite(value.viewport?.[key]))result.viewport[key]=Math.max(1,Math.min(100000,value.viewport[key]));
  for(const key of ['scrollTop','scrollLeft','zoom','fontScale','tocWidth'])if(Number.isFinite(value.view?.[key]))result.view[key]=Math.max(0,Math.min(1e12,value.view[key]));
  if(typeof value.view?.autoFit==='boolean')result.view.autoFit=value.view.autoFit;
  if(['system','light','dark'].includes(value.view?.readingTheme))result.view.readingTheme=value.view.readingTheme;
  if(validPDFPosition(value.view?.pdfPosition))result.view.pdfPosition=structuredClone(value.view.pdfPosition);
  if(value.view?.sourceStorage)result.view.sourceStorage=cleanSourceStorage(value.view.sourceStorage);
  if(value.format==='pdf'){result.format='pdf';result.execution.allowScripts=false;if(value.pdf)result.pdf=structuredClone(value.pdf);}
  result.warnings=(Array.isArray(value.warnings)?value.warnings:[]).filter(v=>typeof v==='string').slice(0,5000).map(v=>v.slice(0,10000));
  return result;
}
async function crc(blob,{signal,onBytes=()=>{}}={}){
  let sum=0xffffffff;
  for(let offset=0;offset<blob.size;offset+=1024*1024){abort(signal);const bytes=new Uint8Array(await blob.slice(offset,offset+1024*1024).arrayBuffer());for(const byte of bytes)sum=table[(sum^byte)&255]^(sum>>>8);onBytes(bytes.length);}
  return (sum^0xffffffff)>>>0;
}
export async function zipBlobs(entries,{signal,onProgress=()=>{}}={}){
  if(!entries.length||entries.length>32)throw Error('보관 파일 항목 수가 올바르지 않습니다.');
  const parts=[],directory=[],names=new Set(),total=entries.reduce((n,e)=>n+e.blob.size,0);let done=0,offset=0;
  if(total>MAX_FILE-65536)throw Error('보관 파일은 4GB 미만으로 나누어 저장해주세요.');
  for(const entry of entries){
    abort(signal);if(!validPath(entry.name)||names.has(entry.name)||!(entry.blob instanceof Blob))throw Error('보관 파일 경로가 올바르지 않습니다.');names.add(entry.name);
    const name=encoder.encode(entry.name),size=entry.blob.size,checksum=await crc(entry.blob,{signal,onBytes:n=>{done+=n;onProgress({done,total});}}),local=new Uint8Array(30),lv=new DataView(local.buffer);
    lv.setUint32(0,0x04034b50,true);lv.setUint16(4,20,true);lv.setUint16(6,0x800,true);lv.setUint16(12,0x21,true);lv.setUint32(14,checksum,true);lv.setUint32(18,size,true);lv.setUint32(22,size,true);lv.setUint16(26,name.length,true);
    const info=new Uint8Array(46),iv=new DataView(info.buffer);iv.setUint32(0,0x02014b50,true);iv.setUint16(4,20,true);iv.setUint16(6,20,true);iv.setUint16(8,0x800,true);iv.setUint16(14,0x21,true);iv.setUint32(16,checksum,true);iv.setUint32(20,size,true);iv.setUint32(24,size,true);iv.setUint16(28,name.length,true);iv.setUint32(38,0x81a40000,true);iv.setUint32(42,offset,true);
    parts.push(local,name,entry.blob);directory.push(info,name);offset+=30+name.length+size;
  }
  const length=directory.reduce((n,b)=>n+b.length,0),end=new Uint8Array(22),v=new DataView(end.buffer);v.setUint32(0,0x06054b50,true);v.setUint16(8,entries.length,true);v.setUint16(10,entries.length,true);v.setUint32(12,length,true);v.setUint32(16,offset,true);
  if(offset+length+22>MAX_FILE)throw Error('보관 파일은 4GB 미만으로 나누어 저장해주세요.');
  return new Blob([...parts,...directory,end],{type:'application/zip'});
}
export async function createDocumentArchive({original,name,reading,metadata,originalExact=true},options={}){
  if(!(original instanceof Blob)||!original.size)throw Error('보관할 원본 파일을 찾지 못했습니다.');
  const state=archiveMetadata(metadata),originalName=safeName(name),originalPath='original/'+originalName;
  const parts=[{name:originalPath,blob:original}],kind=state.format==='pdf'?'pdf':'html';
  let readingPath=originalPath;
  if(reading&&reading!==original){readingPath='reading/document.'+(kind==='pdf'?'pdf':'html');parts.push({name:readingPath,blob:reading});}
  if(kind==='html'&&readingPath===originalPath&&!/\.html?$/i.test(originalName))throw Error('이 형식의 읽기용 사본을 찾지 못했습니다. 원본을 다시 가져와주세요.');
  const manifest={format:ARCHIVE_FORMAT,version:ARCHIVE_VERSION,created:new Date().toISOString(),original:{path:originalPath,name:originalName,type:original.type||'application/octet-stream',exact:originalExact},reading:{path:readingPath,kind},state:'metadata.json'};
  const json=JSON.stringify(state);if(encoder.encode(json).length>MAX_META)throw Error('주석 정보가 너무 큽니다. 문서를 나누어 저장해주세요.');
  parts.unshift({name:'manifest.json',blob:new Blob([JSON.stringify(manifest,null,2)],{type:'application/json'})},{name:'metadata.json',blob:new Blob([json],{type:'application/json'})});
  return zipBlobs(parts,options);
}
async function json(blob,max=MAX_META){if(blob.size>max)throw Error('보관 파일의 문서 정보가 너무 큽니다.');try{return JSON.parse(decoder.decode(await blob.arrayBuffer()));}catch{throw Error('보관 파일의 문서 정보가 손상되었습니다.');}}
export async function readArchiveEntries(file,{signal}={}){
  if(!(file instanceof Blob)||file.size<22||file.size>MAX_FILE)throw Error('올바른 LibreMemo 보관 파일이 아닙니다.');
  const start=Math.max(0,file.size-65557),tail=new Uint8Array(await file.slice(start).arrayBuffer()),tv=new DataView(tail.buffer);let end=-1;
  for(let i=tail.length-22;i>=0;i--)if(tv.getUint32(i,true)===0x06054b50&&i+22+tv.getUint16(i+20,true)===tail.length){end=i;break;}
  if(end<0||tv.getUint16(end+4,true)||tv.getUint16(end+6,true)||tv.getUint16(end+8,true)!==tv.getUint16(end+10,true))throw Error('보관 파일 끝부분이 없거나 분할 압축 파일입니다.');
  const count=tv.getUint16(end+10,true),length=tv.getUint32(end+12,true),at=tv.getUint32(end+16,true);
  if(count<2||count>32||length>65536||at+length!==start+end)throw Error('보관 파일의 목록이 손상되었습니다.');
  const directory=new Uint8Array(await file.slice(at,at+length).arrayBuffer()),v=new DataView(directory.buffer),entries=new Map(),ranges=[];let cursor=0,total=0;
  for(let n=0;n<count;n++){
    abort(signal);if(cursor+46>length||v.getUint32(cursor,true)!==0x02014b50)throw Error('보관 파일 목록이 손상되었습니다.');
    const flags=v.getUint16(cursor+8,true),method=v.getUint16(cursor+10,true),sum=v.getUint32(cursor+16,true),packed=v.getUint32(cursor+20,true),size=v.getUint32(cursor+24,true),names=v.getUint16(cursor+28,true),extra=v.getUint16(cursor+30,true),comment=v.getUint16(cursor+32,true),offset=v.getUint32(cursor+42,true);
    if(cursor+46+names+extra+comment>length||flags&1||![0,8].includes(method)||((v.getUint32(cursor+38,true)>>>16)&0xf000)===0xa000)throw Error('암호화·링크 또는 지원하지 않는 압축 항목입니다.');
    let name;try{name=decoder.decode(directory.subarray(cursor+46,cursor+46+names));}catch{throw Error('보관 파일 경로가 손상되었습니다.');}
    if(!validPath(name)||entries.has(name)||size===0xffffffff||packed===0xffffffff||offset+30>at)throw Error('보관 파일의 경로·크기가 올바르지 않습니다.');
    total+=size;if(total>MAX_FILE-65536)throw Error('압축을 푼 문서가 4GB를 넘습니다.');
    const header=new Uint8Array(await file.slice(offset,offset+30).arrayBuffer()),h=new DataView(header.buffer),localNames=h.getUint16(26,true),localExtra=h.getUint16(28,true),dataAt=offset+30+localNames+localExtra;
    if(h.getUint32(0,true)!==0x04034b50||h.getUint16(6,true)!==flags||h.getUint16(8,true)!==method||dataAt+packed>at||decoder.decode(await file.slice(offset+30,offset+30+localNames).arrayBuffer())!==name||(!(flags&8)&&(h.getUint32(14,true)!==sum||h.getUint32(18,true)!==packed||h.getUint32(22,true)!==size)))throw Error('보관 파일 본문과 목록이 일치하지 않습니다.');
    if(ranges.some(r=>offset<r[1]&&dataAt+packed>r[0]))throw Error('보관 파일의 항목이 겹칩니다.');ranges.push([offset,dataAt+packed]);
    let blob=file.slice(dataAt,dataAt+packed);
    if(method===8){
      const reader=blob.stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader(),parts=[];let read=0;
      try{for(;;){abort(signal);const next=await reader.read();if(next.done)break;read+=next.value.length;if(read>size)throw Error('압축을 푼 문서의 크기가 올바르지 않습니다.');parts.push(new Blob([next.value]));}}finally{await reader.cancel().catch(()=>{});}
      blob=new Blob(parts);
    }
    if(blob.size!==size||await crc(blob,{signal})!==sum)throw Error('보관 파일의 내용이 손상되었습니다.');
    entries.set(name,blob);cursor+=46+names+extra+comment;
  }
  if(cursor!==length)throw Error('보관 파일 목록의 길이가 올바르지 않습니다.');return entries;
}
export async function readDocumentArchive(file,options={}){
  const entries=await readArchiveEntries(file,options),manifest=await json(entries.get('manifest.json')||new Blob(),65536);
  if(manifest?.format!==ARCHIVE_FORMAT||manifest.version!==1)throw Error('지원하지 않는 LibreMemo 보관 파일 버전입니다.');
  if(!manifest.original||typeof manifest.original.exact!=='boolean'||!validPath(manifest.original.path)||!manifest.original.path.startsWith('original/')||manifest.original.name!==safeName(manifest.original.name)||manifest.state!=='metadata.json'||!['pdf','html'].includes(manifest.reading?.kind)||!validPath(manifest.reading.path))throw Error('보관 파일의 원본 정보가 손상되었습니다.');
  const wanted=new Set(['manifest.json','metadata.json',manifest.original.path,manifest.reading.path]);
  if([...entries.keys()].some(name=>!wanted.has(name))||[...wanted].some(name=>!entries.has(name)))throw Error('보관 파일에 필요한 항목이 없거나 알 수 없는 항목이 있습니다.');
  const metadata=archiveMetadata(await json(entries.get('metadata.json'))),kind=manifest.reading.kind,reading=entries.get(manifest.reading.path),original=entries.get(manifest.original.path);
  if(!original.size||!reading.size||(kind==='pdf')!==(metadata.format==='pdf'))throw Error('보관 파일의 원본과 문서 상태가 맞지 않습니다.');
  if(kind==='pdf'&&!/%PDF-\d\.\d/.test(await reading.slice(0,1024).text()))throw Error('보관 파일의 PDF 원본이 손상되었습니다.');
  return {manifest,metadata,original:new File([original],manifest.original.name,{type:typeof manifest.original.type==='string'?manifest.original.type:'application/octet-stream'}),reading:reading.slice(0,reading.size,kind==='pdf'?'application/pdf':'text/html;charset=utf-8')};
}
