import {escapeHTML} from './utils.js';

export const WEB_RESOURCE_LIMIT=25*1024*1024;
export const PASTE_LIMIT=200000;
export function webURL(value){
  const url=new URL(value);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('사용자 정보가 없는 http 또는 https 주소를 입력해주세요.');
  return url.href;
}
export function isWebSearch(value){
  try{const url=new URL(value);return ['google.com','www.google.com'].includes(url.hostname)&&url.pathname==='/search';}catch{return false;}
}
// Only references to tabs opened by this app, held in memory for this session.
// Never inspect a destination's DOM, address, history, clipboard or other tabs.
export class BrowserTabs {
  constructor(browser){this.browser=browser;this.entries=new Map();}
  available(id){try{return !!this.entries.get(id)&&!this.entries.get(id).window.closed;}catch{return false;}}
  forget(id){this.entries.delete(id);}
  open(id,address,{refresh=false}={}){
    const url=webURL(address),entry=this.entries.get(id);
    if(this.available(id)){
      try{if(refresh||entry.url!==url){entry.window.location.href=url;entry.url=url;}entry.window.focus();return 'focused';}
      catch{return 'unavailable';}
    }
    let target,navigating=false;
    try{
      // Start with our own empty page, sever reverse access BEFORE navigation,
      // and retain only the limited WindowProxy allowed by the browser.
      target=this.browser.open('about:blank','_blank');if(!target)return 'blocked';
      target.opener=null;
      const link=target.document.createElement('a');link.href=url;link.target='_self';link.rel='noreferrer';link.referrerPolicy='no-referrer';target.document.body.append(link);
      navigating=true;link.click();this.entries.set(id,{window:target,url});
      try{target.focus();}catch{/* A successful open does not guarantee browser focus. */}return 'opened';
    }catch{if(!navigating)try{target?.close();}catch{/* Only the new empty tab is ours to close. */}return 'blocked';}
  }
}
async function readResource(url,fetchPage){
  const response=await fetchPage(webURL(url),{mode:'cors',credentials:'omit',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error('HTTP '+response.status);
  if(Number(response.headers.get('content-length'))>WEB_RESOURCE_LIMIT)throw new Error('페이지 또는 리소스가 25MB를 초과합니다.');
  let bytes;
  if(response.body?.getReader){
    const reader=response.body.getReader(),chunks=[];let size=0;
    try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>WEB_RESOURCE_LIMIT){await reader.cancel();throw new Error('페이지 또는 리소스가 25MB를 초과합니다.');}chunks.push(value);}}
    finally{reader.releaseLock?.();}
    bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  }else{bytes=new Uint8Array(await response.arrayBuffer());if(bytes.length>WEB_RESOURCE_LIMIT)throw new Error('페이지 또는 리소스가 25MB를 초과합니다.');}
  return {bytes,type:response.headers.get('content-type')||'',url:webURL(response.url||url)};
}
// Direct requests only: no proxy, extension, login cookies or CORS bypass.
// DOMParser keeps fetched scripts inert; capture removes active content and
// packages only resources that the destination site permits us to read.
export async function readWebPage(url,{fetchPage=globalThis.fetch,capture=globalThis.HTMLMemoCapture?.captureDocument}={}){
  const resource=await readResource(url,fetchPage);
  if(resource.type&&!/^(text\/html|application\/xhtml\+xml)\b/i.test(resource.type))throw new Error('HTML 웹페이지가 아닙니다. HTML 파일 가져오기를 사용해주세요.');
  const header=new TextDecoder().decode(resource.bytes.subarray(0,4096));
  const charset=resource.type.match(/charset\s*=\s*["']?([^\s;"']+)/i)?.[1]||header.match(/<meta\b[^>]*charset\s*=\s*["']?([\w-]+)/i)?.[1]||'utf-8';
  let html;try{html=new TextDecoder(charset).decode(resource.bytes);}catch{throw new Error('이 페이지의 문자 인코딩을 읽지 못했습니다. HTML 파일로 저장한 뒤 가져와주세요.');}
  const doc=new DOMParser().parseFromString(html,'text/html'),base=doc.createElement('base');
  const baseURL=webURL(new URL(doc.querySelector('base[href]')?.getAttribute('href')||resource.url,resource.url).href);
  base.setAttribute('href',baseURL);
  for(const old of doc.querySelectorAll('base'))old.remove();doc.head.prepend(base);
  if(typeof capture!=='function')throw new Error('페이지 가져오기 기능을 준비하지 못했습니다. 앱을 새로고침해주세요.');
  return capture(doc,{url:resource.url,baseURL,fetchResource:value=>readResource(value,fetchPage)});
}
export function pastedPage({text,title='붙여넣은 글',url=''}={}){
  if(typeof text!=='string'||!text.trim())throw new Error('가져올 글을 붙여넣어주세요.');
  if(text.length>PASTE_LIMIT)throw new Error('붙여넣기는 한 번에 200,000자까지 가능합니다.');
  title=String(title).trim().slice(0,300)||'붙여넣은 글';if(url)url=webURL(url);
  const paragraphs=text.trim().split(/\r?\n\s*\r?\n/).map(value=>'<p>'+escapeHTML(value).replace(/\r?\n/g,'<br>')+'</p>').join('');
  return {title,url,viewport:{width:960,height:800},warnings:[],html:'<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>'+escapeHTML(title)+'</title><style>body{max-width:820px;margin:40px auto;padding:0 24px;font:18px/1.9 system-ui,sans-serif;overflow-wrap:anywhere}h1{font-size:1.6em}p{white-space:normal}</style></head><body><article><h1>'+escapeHTML(title)+'</h1>'+paragraphs+(url?'<p><a href="'+escapeHTML(url)+'">원문 열기</a></p>':'')+'</article></body></html>'};
}
