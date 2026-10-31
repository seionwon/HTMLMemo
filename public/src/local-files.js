import { LOCAL_CSP, SCRIPT_CSP, parseHTML } from './document.js';
import { readMHTML } from './mhtml.js';
import { isPDFFile, verifyPDF, PDF_ARCHIVE_MARKER, readPDFArchive } from './pdf-document.js';

const isMHTML = file => /\.(?:mhtml|mht)$/i.test(file.name||'') || /^(?:multipart\/related|application\/x-mimearchive)(?:;|$)/i.test(file.type||'');
const hasDocumentExtension = file => /\.(?:html?|mhtml|mht|pdf)$/i.test(file?.name||'');
export const isLocalHTMLFile = file => !!file && (isPDFFile(file)||hasDocumentExtension(file) || /^(?:text\/html|multipart\/related|application\/x-mimearchive)(?:;|$)/i.test(file.type||''));
export function htmlExportName(name, annotations = false) {
  return String(name||'문서.html').replace(/\.(?:html?|mhtml|mht|pdf)$/i,'')+(annotations?'-주석':'')+'.html';
}

const identities=new WeakMap(),localSources=new WeakMap(),nativeLegacyCopies=new WeakMap();
// File/Blob objects are immutable. Reuse only that exact object, never a name,
// timestamp or handle whose on-disk contents could have changed.
export function localFileIdentity(file) {
  let pending=identities.get(file);
  if(!pending){
    pending=hashLocalFile(file);identities.set(file,pending);
    pending.catch(()=>{if(identities.get(file)===pending)identities.delete(file);});
  }
  return pending;
}
/** A full immutable slice changes only MIME; its proven bytes stay identical. */
export function localFileWithType(file,type){
  if(file.type===type)return file;
  const typed=file.slice(0,file.size,type),pending=localFileIdentity(file);identities.set(typed,pending);
  pending.catch(()=>{if(identities.get(typed)===pending)identities.delete(typed);});return typed;
}
// Four bounded workers hide file-read/digest round trips without buffering a
// whole book. Keep the original v1 chunk size/order for existing libraries.
async function hashLocalFile(file) {
  const hashes=[],chunkSize=1024*1024,count=Math.ceil(file.size/chunkSize);let next=0;
  await Promise.all(Array.from({length:Math.min(4,count)},async()=>{
    for(let index;(index=next++)<count;){
      const bytes=await file.slice(index*chunkSize,Math.min((index+1)*chunkSize,file.size)).arrayBuffer();
      hashes[index]=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
    }
  }));
  const prefix=new TextEncoder().encode('HTMLMemo local file v1:'+file.size+':');
  const joined=new Uint8Array(prefix.length+hashes.length*32);joined.set(prefix);
  hashes.forEach((hash,index)=>joined.set(hash,prefix.length+index*32));
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',joined));
  return {version:1,size:file.size,digest:[...digest].map(byte=>byte.toString(16).padStart(2,'0')).join('')};
}
export async function identifyLocalFile(local) {
  if(local.sourceIdentity)return local.sourceIdentity;
  const file=localSources.get(local);
  if(!file)return null;
  return local.sourceIdentity=await localFileIdentity(file);
}
export function sameLocalFile(a,b) {
  return a?.version===1&&b?.version===1&&Number.isSafeInteger(a.size)&&a.size>=0&&a.size===b.size&&/^[a-f0-9]{64}$/.test(a.digest)&&a.digest===b.digest;
}
export async function findLocalDuplicates(local, records, loadRecord) {
  const matches=[];let preparedHTML;
  const sourceSize=local.sourceIdentity?.size??localSources.get(local)?.size;
  // Most first imports cannot match any known source size. Do not scan their
  // entire contents here; a new document fingerprints while its reader opens.
  if(records.some(record=>record.sourceIdentity?.version===1&&record.sourceIdentity.size===sourceSize))await identifyLocalFile(local);
  for(const record of records){
    if(sameLocalFile(local.sourceIdentity,record.sourceIdentity)){matches.push(record);continue;}
    // A different known digest is never treated as the same file merely
    // because its filename, size, title or modification date matches.
    if(record.sourceIdentity||record.name!==local.name)continue;
    let preparedFile=local.snapshot.file;
    const versionForSize=size=>[local.snapshot.file,nativeLegacyCopies.get(local)].find(file=>file?.size===size);
    if(preparedFile&&Number.isSafeInteger(record.byteSize)&&record.byteSize>0){preparedFile=versionForSize(record.byteSize);if(!preparedFile)continue;}
    const stored=await loadRecord(record.id);
    if(!stored)continue;
    let same=false;
    if(preparedFile&&stored.file instanceof Blob){
      preparedFile=versionForSize(stored.file.size);if(!preparedFile)continue;
      // Reject changed same-size legacy books using a small prefix before
      // hashing either full prepared copy. A prefix match alone proves nothing.
      const [a,b]=await Promise.all([preparedFile,stored.file].map(file=>file.slice(0,4096).arrayBuffer()));
      const other=new Uint8Array(b);
      if(new Uint8Array(a).some((byte,index)=>byte!==other[index]))continue;
      same=sameLocalFile(await localFileIdentity(preparedFile),await localFileIdentity(stored.file));
    }else if(typeof local.snapshot.html==='string'&&typeof stored.html==='string'){
      preparedHTML??=parseHTML(local.snapshot.html,{}, {allowScripts:true}).html;
      // Older records have no source digest. Compare their immutable prepared
      // HTML, excluding annotations/metadata, without changing either record.
      try{same=preparedHTML===parseHTML(stored.html,{}, {allowScripts:true}).html;}catch{ /* A damaged old record cannot prove identity. */ }
    }
    if(same)matches.push(record);
  }
  return matches;
}

export async function readLocalHTML(input, {native = false, allowScripts = false, identify = true} = {}) {
  const originalHandle = input?.kind === 'file' && typeof input.getFile === 'function' ? input : null;
  const file = originalHandle ? await originalHandle.getFile() : input;
  if (!isLocalHTMLFile(file) || typeof file.text !== 'function') throw new Error('HTML, HTM, MHTML, MHT 또는 PDF 파일을 선택해주세요.');
  if(isPDFFile(file)){
    await verifyPDF(file);const local={snapshot:{pdf:file,title:file.name},name:file.name,handle:null,originalHandle,sourceIdentity:identify?await localFileIdentity(file):null,diskStamp:originalHandle?{modified:file.lastModified,size:file.size}:null};localSources.set(local,file);return local;
  }
  const probeBytes=isMHTML(file)?null:new Uint8Array(await file.slice(0,native&&file.size>=4*1024*1024?65536:128).arrayBuffer());
  if(probeBytes&&new TextDecoder().decode(probeBytes.subarray(0,128)).startsWith(PDF_ARCHIVE_MARKER)){
    const snapshot=await readPDFArchive(file),local={snapshot,name:file.name,handle:null,originalHandle,sourceIdentity:identify?await localFileIdentity(snapshot.pdf):null};localSources.set(local,snapshot.pdf);return local;
  }
  const sourceIdentity=identify?await localFileIdentity(file):null;
  if(isMHTML(file)){
    const snapshot=await readMHTML(file);
    const local={snapshot:{...snapshot,file:null,title:file.name},name:file.name,handle:null,originalHandle,originalFile:file,sourceIdentity,diskStamp:originalHandle?{modified:file.lastModified,size:file.size}:null};
    localSources.set(local,file);return local;
  }
  // Inspect only the encoding header. Blob slices retain the original file bytes;
  // the browser streams/parses them without making a giant JS string first.
  let nativeFile = null,legacyNativeFile = null;
  if (native && file.size >= 4 * 1024 * 1024 && typeof file.slice === 'function') {
    const header = probeBytes;
    const charset = new TextDecoder().decode(header.subarray(0, 4096)).match(/<meta\b[^>]*charset\s*=\s*["']?([\w-]+)/i)?.[1] || 'utf-8';
    const utf16 = header[0] === 0xff && header[1] === 0xfe || header[0] === 0xfe && header[1] === 0xff;
    if (!utf16 && /^(utf-8|utf8)$/i.test(charset)) {
      const offset = header[0] === 0xef && header[1] === 0xbb && header[2] === 0xbf ? 3 : 0;
      const lastGt = header.lastIndexOf(0x3e);
      let bodyParts = [file.slice(offset)];
      if (lastGt > offset) {
        const prefixText = new TextDecoder('utf-8').decode(header.subarray(offset, lastGt + 1));
        const cleanedPrefix = prefixText.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?(?:content-security-policy|refresh)\b[^>]*>/gi, '');
        bodyParts = [cleanedPrefix, file.slice(lastGt + 1)];
      }
      // CSP precedes every source byte. The requested local-script policy
      // allows inline JS, eval, data/blob fetches and decompression workers.
      const policy=allowScripts?SCRIPT_CSP:LOCAL_CSP;
      const withPolicy=csp=>new Blob(['<!doctype html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="'+csp+'">',...bodyParts],{type:'text/html;charset=utf-8'});
      nativeFile=withPolicy(policy);
      // Preserve duplicate recognition for older, unidentified streamed copies
      // made before saved srcdoc frames were permitted. Both share the original
      // Blob slices; no extra whole-book read or JS string is created.
      legacyNativeFile=withPolicy(policy.replace(" frame-src 'self';",''));
    }
  }
  let html;
  if (nativeFile) html = null;
  else if (typeof file.arrayBuffer === 'function') {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const header = new TextDecoder().decode(bytes.subarray(0,4096));
    const charset = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : header.match(/<meta\b[^>]*charset\s*=\s*["']?([\w-]+)/i)?.[1] || 'utf-8';
    try { html = new TextDecoder(charset).decode(bytes); } catch { throw new Error('지원하지 않는 HTML 문자 인코딩입니다. UTF-8로 저장한 파일을 열어주세요.'); }
  } else html = await file.text();
  // Annotation availability is independent of file write permission. Read-only
  // files still become local document tabs with a recoverable internal copy.
  const local={
    snapshot:{html,file:nativeFile,title:file.name,allowScripts}, name:file.name, handle:null,
    originalHandle, originalFile:file, sourceIdentity, diskStamp:originalHandle ? {modified:file.lastModified,size:file.size} : null,
  };
  localSources.set(local,file);
  if(legacyNativeFile)nativeLegacyCopies.set(local,legacyNativeFile);
  return local;
}
export async function droppedHTMLFiles(dataTransfer) {
  const items = [...(dataTransfer.items || [])].filter(item=>item.kind==='file');
  if(!items.length) return [...(dataTransfer.files || [])].filter(hasDocumentExtension);
  // Acquire every handle before the first await, while still in the drop event.
  const pending=items.map(item=>{try{return Promise.resolve(item.getAsFileSystemHandle?.()).catch(()=>null);}catch{return Promise.resolve(null);}});
  const handles=await Promise.all(pending);const files=[];
  for(let i=0;i<items.length;i++) {
    const item=items[i];const handle=handles[i];
    const file=handle?.kind==='file'?handle:item.getAsFile?.();
    if(hasDocumentExtension(file))files.push(file);
  }
  return files;
}
