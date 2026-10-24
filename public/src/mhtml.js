// Decode a saved web archive locally. Resource URLs become persistent data URLs,
// not temporary blob URLs or requests to the original (possibly private) site.
const FALLBACK_BASE = 'https://htmlmemo.invalid/__archive__/index.html';
const HTML_TYPES = new Set(['text/html','application/xhtml+xml']);
const malformed = () => new Error('MHTML 파일의 구조가 손상되었거나 본문이 없습니다. 웹 페이지를 다시 단일 파일로 저장해 주세요.');
const binaryString = bytes => {
  const chunks=[];
  for(let i=0;i<bytes.length;i+=32768)chunks.push(String.fromCharCode(...bytes.subarray(i,i+32768)));
  return chunks.join('');
};
const binaryBytes = text => Uint8Array.from(text,character=>character.charCodeAt(0));
function contentType(value='text/plain') {
  const type=value.split(';',1)[0].trim().toLowerCase(),params={};
  for(const match of value.matchAll(/;\s*([\w-]+)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^;\s]+))/g))params[match[1].toLowerCase()]=(match[2]??match[3]).replace(/\\(.)/g,'$1');
  return {type,params};
}
function parsePart(raw,parts,depth=0) {
  if(depth>12||parts.length>=10000)throw new Error('MHTML 파일에 중첩된 문서나 리소스가 너무 많습니다. HTML 단일 파일로 저장해 주세요.');
  const separator=/\r?\n\r?\n/.exec(raw);
  if(!separator||separator.index>1024*1024)throw malformed();
  const headers={};
  for(const line of raw.slice(0,separator.index).replace(/\r?\n[\t ]+/g,' ').split(/\r?\n/)){
    const colon=line.indexOf(':');if(colon>0)headers[line.slice(0,colon).trim().toLowerCase()]=line.slice(colon+1).trim();
  }
  const part={headers,...contentType(headers['content-type']),body:raw.slice(separator.index+separator[0].length),children:[]};
  parts.push(part);
  if(part.type.startsWith('multipart/')){
    const boundary=part.params.boundary;
    if(!boundary||boundary.length>200||/[\r\n]/.test(boundary))throw malformed();
    const delimiter=new RegExp('^--'+boundary.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(--)?[\\t ]*(?:\\r?\\n|$)','gm');
    let previous=null,closed=false;
    for(const match of part.body.matchAll(delimiter)){
      if(previous!==null){
        let end=match.index;if(part.body[end-1]==='\n')end-=part.body[end-2]==='\r'?2:1;
        part.children.push(parsePart(part.body.slice(previous,end),parts,depth+1));
      }
      if(match[1]){closed=true;break;}
      previous=match.index+match[0].length;
    }
    if(!closed||!part.children.length)throw malformed();
    part.body='';
  }
  return part;
}
function partBytes(part) {
  if(part.bytes)return part.bytes;
  const encoding=(part.headers['content-transfer-encoding']||'8bit').toLowerCase();
  let text=part.body;
  if(encoding==='base64'){
    try{text=atob(text.replace(/\s/g,''));}catch{throw new Error('MHTML 파일의 Base64 데이터가 손상되었습니다. 파일을 다시 저장해 주세요.');}
  }else if(encoding==='quoted-printable')text=text.replace(/=\r?\n/g,'').replace(/=([a-f\d]{2})/gi,(_,hex)=>String.fromCharCode(parseInt(hex,16)));
  else if(!['7bit','8bit','binary'].includes(encoding))throw new Error('지원하지 않는 MHTML 데이터 인코딩입니다: '+encoding.slice(0,40));
  return part.bytes=binaryBytes(text);
}
function partText(part) {
  const bytes=partBytes(part),prefix=binaryString(bytes.subarray(0,4096));
  const charset=bytes[0]===255&&bytes[1]===254?'utf-16le':bytes[0]===254&&bytes[1]===255?'utf-16be':part.params.charset||prefix.match(/(?:charset\s*=\s*["']?|@charset\s+["'])([\w-]+)/i)?.[1]||'utf-8';
  try{return new TextDecoder(charset).decode(bytes);}catch{throw new Error('지원하지 않는 MHTML 문자 인코딩입니다. UTF-8로 저장한 파일을 열어 주세요.');}
}
function contentID(value='') {
  value=value.replace(/^cid:/i,'').trim().replace(/^<|>$/g,'');
  try{return decodeURIComponent(value);}catch{return value;}
}
function rootPart(part) {
  if(!part.children.length)return HTML_TYPES.has(part.type)?part:null;
  if(part.params.start){
    const child=part.children.find(child=>contentID(child.headers['content-id'])===contentID(part.params.start));
    return child?rootPart(child):null;
  }
  for(const child of part.children){const root=rootPart(child);if(root)return root;}
  return null;
}
function resolve(value,base) {try{return new URL(value,base).href;}catch{return '';}}
function withoutHash(value) {return value.split('#',1)[0];}
function cssUnescape(value) {
  return value.replace(/\\(?:([a-f\d]{1,6})[\t\n\r\f ]?|(\r\n|[\n\r\f])|(.))/gi,(_,hex,newline,character)=>hex?String.fromCodePoint(Math.min(0x10ffff,parseInt(hex,16)||0xfffd)):newline?'':character);
}
function rewriteSrcset(value,rewrite) {
  const candidates=[];let index=0;
  while(index<value.length){
    while(/[\s,]/.test(value[index]||'')&&index<value.length)index++;
    const start=index;while(index<value.length&&!/\s/.test(value[index]))index++;
    let url=value.slice(start,index),descriptor='';
    if(url.endsWith(','))url=url.replace(/,+$/,'');
    else {const start=index;let parentheses=0;while(index<value.length){const c=value[index];if(c===','&&!parentheses)break;if(c==='(')parentheses++;if(c===')')parentheses--;index++;}descriptor=value.slice(start,index).trim();index++;}
    if(url){const next=rewrite(url);if(next)candidates.push(next+(descriptor?' '+descriptor:''));}
  }
  return candidates.join(', ');
}

export async function readMHTML(file) {
  const parts=[],archive=parsePart(binaryString(new Uint8Array(await file.arrayBuffer())).replace(/^\xef\xbb\xbf/,''),parts),root=rootPart(archive);
  if(!root)throw malformed();
  const original=resolve(root.headers['content-location']||archive.headers['snapshot-content-location']||archive.headers['content-location']||'',FALLBACK_BASE);
  const rootDocument=new DOMParser().parseFromString(partText(root),'text/html');
  const rootBase=resolve(rootDocument.querySelector('base[href]')?.getAttribute('href')||original,original)||original;
  const locations=new Map(),ids=new Map(),cache=new Map(),warnings=new Set();
  const warn=value=>{if(warnings.size<5000)warnings.add('MHTML에 포함되지 않았거나 읽을 수 없는 리소스: '+String(value).slice(0,500));};
  const indexParts=(part,parentBase)=>{
    const location=part.headers['content-location']?.replace(/[\t ]/g,'');
    part.location=location?resolve(location,parentBase):parentBase;
    if(!part.children.length){
      if(location)for(const base of [parentBase,rootBase,original]){const url=withoutHash(resolve(location,base));if(url&&!locations.has(url))locations.set(url,part);}
      const id=contentID(part.headers['content-id']);if(id&&!ids.has(id))ids.set(id,part);
    }
    for(const child of part.children)indexParts(child,part.location);
  };
  indexParts(archive,original);
  const find=(value,base)=>/^cid:/i.test(value)?ids.get(contentID(withoutHash(value))):locations.get(withoutHash(resolve(value,base)));
  const dataURL=(bytes,type)=>'data:'+type+';base64,'+btoa(binaryString(bytes));
  function resource(value,base,ancestors=new Set()) {
    value=value.trim();if(!value||value.startsWith('#')||/^data:/i.test(value))return value;
    const part=find(value,base);
    if(!part||part.children.length||HTML_TYPES.has(part.type)||ancestors.has(part)||ancestors.size>12){warn(value);return '';}
    try{
      if(!cache.has(part)){
        const bytes=part.type==='text/css'?new TextEncoder().encode(rewriteCSS(partText(part).replace(/^\s*@charset\s+["'][^"']*["']\s*;/i,''),part.location,new Set([...ancestors,part]))):partBytes(part);
        const type=/^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/.test(part.type)?part.type:'application/octet-stream';
        cache.set(part,dataURL(bytes,type+(type==='text/css'?';charset=utf-8':'')));
      }
      const hash=value.includes('#')?value.slice(value.indexOf('#')):'';
      return cache.get(part)+hash;
    }catch{warn(value);return '';}
  }
  function rewriteCSS(css,base,ancestors=new Set()) {
    // Skip comments/strings; only rewrite actual url() and quoted @import tokens.
    return css.replace(/\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|url\(\s*(?:"((?:\\[\s\S]|[^"\\])*)"|'((?:\\[\s\S]|[^'\\])*)'|((?:\\[\s\S]|[^)\\])*?))\s*\)|@import\s+(?:"((?:\\[\s\S]|[^"\\])*)"|'((?:\\[\s\S]|[^'\\])*)')/gi,(token,double,single,bare,importDouble,importSingle)=>{
      if(double===undefined&&single===undefined&&bare===undefined&&importDouble===undefined&&importSingle===undefined)return token;
      const url=resource(cssUnescape(double??single??bare??importDouble??importSingle).trim(),base,ancestors);
      return (importDouble!==undefined||importSingle!==undefined?'@import ':'')+'url("'+url.replace(/"/g,'%22')+'")';
    });
  }
  function rewriteHTML(part,doc,ancestors=new Set()) {
    const base=resolve(doc.querySelector('base[href]')?.getAttribute('href')||part.location,part.location)||original;
    const visit=tree=>{
      for(const element of [...tree.querySelectorAll('*')]){
        const tag=element.localName;
        // Saved pages are static, as in Chrome's own MHTML viewer. Never run
        // archived scripts or initiate speculative network loads while opening.
        if(tag==='script'&&element.type!=='application/json'||tag==='link'&&/\b(?:preload|prefetch|preconnect|dns-prefetch|modulepreload)\b/i.test(element.getAttribute('rel')||'')){element.remove();continue;}
        if(tag==='base'){element.remove();continue;}
        if(tag==='iframe'){
          const value=element.getAttribute('src')||'',nested=find(value,base);
          if(nested&&HTML_TYPES.has(nested.type)&&!ancestors.has(nested)&&ancestors.size<4){
            const child=new DOMParser().parseFromString(partText(nested),'text/html');
            element.setAttribute('srcdoc',rewriteHTML(nested,child,new Set([...ancestors,nested])));element.removeAttribute('src');element.setAttribute('sandbox','');
          }else if(!element.hasAttribute('srcdoc')){if(value)warn(value);element.remove();}
          else {const child=new DOMParser().parseFromString(element.getAttribute('srcdoc'),'text/html');if(ancestors.size>=4)element.remove();else element.setAttribute('srcdoc',rewriteHTML(part,child,new Set([...ancestors,element])));}
          continue;
        }
        if(tag==='style')element.textContent=rewriteCSS(element.textContent,base);
        if(element.hasAttribute('style'))element.setAttribute('style',rewriteCSS(element.getAttribute('style'),base));
        if(element.hasAttribute('srcset'))element.setAttribute('srcset',rewriteSrcset(element.getAttribute('srcset'),value=>resource(value,base)));
        for(const attribute of ['src','poster','background','href','xlink:href']){
          if(!element.hasAttribute(attribute))continue;
          const value=element.getAttribute(attribute).trim();
          if(['a','area'].includes(tag)&&attribute==='href'){
            const url=resolve(value,base);
            if(value.startsWith('#'))continue;
            if(url&&withoutHash(url)===withoutHash(part.location)&&url.includes('#'))element.setAttribute(attribute,url.slice(url.indexOf('#')));
            else if(/^(?:https?:|mailto:|tel:)/i.test(url))element.setAttribute(attribute,url);
            else element.removeAttribute(attribute);
          }else {const next=resource(value,base);if(next)element.setAttribute(attribute,next);else element.removeAttribute(attribute);}
        }
        element.removeAttribute('integrity');element.removeAttribute('crossorigin');
        if(tag==='template')visit(element.content);
      }
    };
    visit(doc);
    for(const meta of doc.querySelectorAll('meta[charset],meta[http-equiv]'))if(meta.hasAttribute('charset')||/^(?:content-type|content-security-policy|refresh)$/i.test(meta.getAttribute('http-equiv')))meta.remove();
    const charset=doc.createElement('meta');charset.setAttribute('charset','utf-8');doc.head.prepend(charset);
    return '<!doctype html>\n'+doc.documentElement.outerHTML;
  }
  const html=rewriteHTML(root,rootDocument,new Set([root]));
  let url='';try{const parsed=new URL(original);if(['http:','https:'].includes(parsed.protocol)&&!parsed.username&&!parsed.password&&parsed.origin!=='https://htmlmemo.invalid')url=parsed.href;}catch{ /* Local archives need no public source URL. */ }
  return {html,url,warnings:[...warnings],allowScripts:false};
}
