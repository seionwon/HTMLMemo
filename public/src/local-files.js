import { LOCAL_CSP, SCRIPT_CSP, parseHTML } from './document.js';

// Hash bounded chunks so large books never require a second full-file buffer.
// The final digest includes their order and the exact source byte count.
export async function localFileIdentity(file) {
  const hashes=[],chunkSize=1024*1024;
  for(let offset=0;offset<file.size;offset+=chunkSize){
    const bytes=await file.slice(offset,offset+chunkSize).arrayBuffer();
    hashes.push(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)));
  }
  const prefix=new TextEncoder().encode('HTMLMemo local file v1:'+file.size+':');
  const joined=new Uint8Array(prefix.length+hashes.length*32);joined.set(prefix);
  hashes.forEach((hash,index)=>joined.set(hash,prefix.length+index*32));
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',joined));
  return {version:1,size:file.size,digest:[...digest].map(byte=>byte.toString(16).padStart(2,'0')).join('')};
}
export function sameLocalFile(a,b) {
  return a?.version===1&&b?.version===1&&Number.isSafeInteger(a.size)&&a.size>=0&&a.size===b.size&&/^[a-f0-9]{64}$/.test(a.digest)&&a.digest===b.digest;
}
export async function findLocalDuplicates(local, records, loadRecord) {
  const matches=[];let preparedHTML,preparedFile;
  for(const record of records){
    if(sameLocalFile(local.sourceIdentity,record.sourceIdentity)){matches.push(record);continue;}
    // A different known digest is never treated as the same file merely
    // because its filename, size, title or modification date matches.
    if(record.sourceIdentity||record.name!==local.name)continue;
    const stored=await loadRecord(record.id);
    if(!stored)continue;
    let same=false;
    if(local.snapshot.file&&stored.file instanceof Blob){
      preparedFile??=await localFileIdentity(local.snapshot.file);
      same=sameLocalFile(preparedFile,await localFileIdentity(stored.file));
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

export async function readLocalHTML(input, {native = false, allowScripts = false} = {}) {
  const originalHandle = input?.kind === 'file' && typeof input.getFile === 'function' ? input : null;
  const file = originalHandle ? await originalHandle.getFile() : input;
  if (!file || typeof file.text !== 'function' || !/\.html?$/i.test(file.name || '') && file.type !== 'text/html') throw new Error('HTML 또는 HTM 파일을 선택해주세요.');
  const sourceIdentity=await localFileIdentity(file);
  // Inspect only the encoding header. Blob slices retain the original file bytes;
  // the browser streams/parses them without making a giant JS string first.
  let nativeFile = null;
  if (native && file.size >= 4 * 1024 * 1024 && typeof file.slice === 'function') {
    const header = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
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
      nativeFile = new Blob(['<!doctype html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + (allowScripts ? SCRIPT_CSP : LOCAL_CSP) + '">', ...bodyParts], {type:'text/html;charset=utf-8'});
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
  return {
    snapshot:{html,file:nativeFile,title:file.name,allowScripts}, name:file.name, handle:null,
    originalHandle, sourceIdentity, diskStamp:originalHandle ? {modified:file.lastModified,size:file.size} : null,
  };
}
export async function droppedHTMLFiles(dataTransfer) {
  const items = [...(dataTransfer.items || [])].filter(item=>item.kind==='file');
  if(!items.length) return [...(dataTransfer.files || [])].filter(file=>/\.html?$/i.test(file.name));
  // Acquire every handle before the first await, while still in the drop event.
  const pending=items.map(item=>{try{return Promise.resolve(item.getAsFileSystemHandle?.()).catch(()=>null);}catch{return Promise.resolve(null);}});
  const handles=await Promise.all(pending);const files=[];
  for(let i=0;i<items.length;i++) {
    const item=items[i];const handle=handles[i];
    const file=handle?.kind==='file'?handle:item.getAsFile?.();
    if(file&&/\.html?$/i.test(file.name))files.push(file);
  }
  return files;
}
