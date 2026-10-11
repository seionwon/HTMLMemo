import { permission } from './storage.js';

export async function readLocalHTML(input, {requestWrite = false} = {}) {
  const originalHandle = input?.kind === 'file' && typeof input.getFile === 'function' ? input : null;
  const file = originalHandle ? await originalHandle.getFile() : input;
  if (!file || typeof file.text !== 'function' || !/\.html?$/i.test(file.name || '') && file.type !== 'text/html') throw new Error('HTML 또는 HTM 파일을 선택해주세요.');
  let html;
  if (typeof file.arrayBuffer === 'function') {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const header = new TextDecoder().decode(bytes.subarray(0,4096));
    const charset = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : header.match(/<meta\b[^>]*charset\s*=\s*["']?([\w-]+)/i)?.[1] || 'utf-8';
    try { html = new TextDecoder(charset).decode(bytes); } catch { throw new Error('지원하지 않는 HTML 문자 인코딩입니다. UTF-8로 저장한 파일을 열어주세요.'); }
  } else html = await file.text();
  // Annotation availability is independent of file write permission. Read-only
  // files still become local document tabs with a recoverable internal copy.
  let writable = false;
  try { writable = originalHandle ? await permission(originalHandle,requestWrite) : false; } catch { /* A missing write gesture must not block reading or annotation. */ }
  return {
    snapshot:{html,title:file.name}, name:file.name, handle:writable ? originalHandle : null,
    originalHandle, diskStamp:originalHandle ? {modified:file.lastModified,size:file.size} : null,
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
