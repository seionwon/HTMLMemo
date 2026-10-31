import {EPUB,MOBI,makeFB2,makeComicBook,InertDOMParser,resourceBlobs,parseCSS,activateEbookDOM} from '../vendor/ebook/foliate.js';
import {esc,safeLink} from './office-common.js';
import {inspectOfficeZip} from './office-render.js';

const MAX_PART=32*1024*1024,MAX_TEXT=64*1024*1024;
const parser=new InertDOMParser();
const imageMimes={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',svg:'image/svg+xml',bmp:'image/bmp',avif:'image/avif',jxl:'image/jxl',woff:'font/woff',woff2:'font/woff2',ttf:'font/ttf',otf:'font/otf',css:'text/css'};
function bytes64(bytes){let s='';for(let i=0;i<bytes.length;i+=16384)s+=String.fromCharCode(...bytes.subarray(i,i+16384));return btoa(s);}
function sniff(bytes){const s=new TextDecoder().decode(bytes.subarray(0,200));return bytes[0]===137&&bytes[1]===80?'image/png':bytes[0]===255&&bytes[1]===216?'image/jpeg':s.startsWith('GIF8')?'image/gif':s.startsWith('RIFF')&&s.slice(8,12)==='WEBP'?'image/webp':/<svg[\s>]/i.test(s)?'image/svg+xml':'';}
export function validateMOBI(bytes){
  if(bytes.length<86||new TextDecoder().decode(bytes.subarray(60,68))!=='BOOKMOBI')throw Error('MOBI·AZW3 파일의 형식을 확인하지 못했습니다.');
  const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),count=v.getUint16(76);
  if(count<2||78+count*8>bytes.length)throw Error('전자책의 레코드 목록이 손상되었습니다.');
  let previous=78+count*8;for(let i=0;i<count;i++){const offset=v.getUint32(78+i*8);if(offset<previous||offset>=bytes.length)throw Error('전자책의 레코드 위치가 올바르지 않습니다.');previous=offset;}
  for(let i=0;i<count;i++){
    const start=v.getUint32(78+i*8),end=i+1<count?v.getUint32(86+i*8):bytes.length;
    // Check both headers in combo MOBI/KF8 files before decompression.
    if(i&&new TextDecoder().decode(bytes.subarray(start+16,start+20))!=='MOBI')continue;
    if(end-start<248||new TextDecoder().decode(bytes.subarray(start+16,start+20))!=='MOBI')throw Error('MOBI 헤더가 손상되었습니다.');
    if(v.getUint16(start+12)!==0)throw Error('DRM·암호로 보호된 전자책은 열 수 없습니다. 보호되지 않은 사본을 가져와 주세요.');
    if(v.getUint32(start+4)>MAX_TEXT||v.getUint16(start+8)>16384)throw Error('전자책 본문이 너무 큽니다.');
  }
}
export function validateFB2(bytes){
  if(bytes.length>MAX_PART)throw Error('FB2 파일은 32MB 이하로 나누어 가져와 주세요.');
  const head=new TextDecoder().decode(bytes.subarray(0,300));
  const encoding=bytes[0]===255&&bytes[1]===254?'utf-16le':bytes[0]===254&&bytes[1]===255?'utf-16be':head.match(/encoding\s*=\s*["']([^"']+)/i)?.[1]||'utf-8';
  let text;try{text=new TextDecoder(encoding,{fatal:true}).decode(bytes);}catch{throw Error('FB2 문자 인코딩을 읽지 못했습니다.');}
  if(/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text))throw Error('엔터티 선언이 있는 FB2는 열 수 없습니다.');
  if(!/^\s*(?:<\?xml[^?]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<FictionBook\b/.test(text))throw Error('FB2의 FictionBook 문서 형식을 확인하지 못했습니다.');
  return new Blob([text.replace(/^\s*<\?xml[^?]*\?>/,'')]);
}
function selectors(text){const out=[];let start=0,depth=0,quote='';for(let i=0;i<text.length;i++){const c=text[i];if(quote){if(c===quote&&text[i-1]!=='\\')quote='';}else if(c==='"'||c==="'")quote=c;else if(c==='('||c==='[')depth++;else if(c===')'||c===']')depth--;else if(c===','&&!depth){out.push(text.slice(start,i));start=i+1;}}out.push(text.slice(start));return out;}
const tags=new Set('a abbr address article aside b bdi bdo blockquote br caption cite code col colgroup dd del details dfn div dl dt em figcaption figure footer h1 h2 h3 h4 h5 h6 header hr i img ins kbd label li main mark nav ol p pre q rp rt ruby s samp section small span strong sub summary sup table tbody td tfoot th thead time tr u ul var wbr svg g defs path rect circle ellipse polygon polyline line text tspan image use symbol clippath lineargradient radialgradient stop title desc math mrow mi mn mo ms mtext mspace mfrac msqrt mroot msub msup msubsup munder mover munderover mtable mtr mtd semantics annotation'.split(' '));
const attrs=new Set('class title lang dir alt width height colspan rowspan scope datetime open start reversed type align valign viewbox preserveaspectratio d points x y x1 y1 x2 y2 cx cy r rx ry dx dy transform fill fill-rule fill-opacity stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-dasharray opacity text-anchor dominant-baseline font-family font-size font-weight font-style offset stop-color stop-opacity gradientunits gradienttransform clip-path xmlns aria-label'.split(' '));
const voidTags=new Set('br col hr img wbr'.split(' '));
function htmlNode(node){
  if(node.nodeType===3)return esc(node.textContent);
  if(node.nodeType!==1)return '';
  const tag=node.localName,open='<'+tag+[...node.attributes].map(a=>' '+a.name+'="'+esc(a.value)+'"').join('')+'>';
  return open+(voidTags.has(tag)?'':[...node.childNodes].map(htmlNode).join('')+'</'+tag+'>');
}

export async function renderEbook(bytes,format,warnings){
  // All object URLs are private in-memory references owned by this worker.
  // No fetch of document URLs, scripts, or remote resources is performed.
  activateEbookDOM();const persistent=new Set(resourceBlobs.keys());let book;
  try{
    let zip;
    if(['epub','epub3','cbz','fbz','fb2.zip'].includes(format))zip=await inspectOfficeZip(bytes,format,warnings);
    const loader={
      entries:zip?Object.values(zip.files).filter(f=>!f.dir).map(f=>({filename:f.name})):[],
      loadText:async name=>zip.file(name)?.async('string'),
      loadBlob:async name=>{const f=zip.file(name);if(!f)return null;return new Blob([await f.async('uint8array')],{type:imageMimes[name.split('.').at(-1).toLowerCase()]||''});},
      getSize:name=>zip.file(name)?._data?.uncompressedSize||0,
      sha1:async bytes=>new Uint8Array(await crypto.subtle.digest('SHA-1',bytes)),
    };
    if(format==='epub'||format==='epub3'){
      const mimetype=await loader.loadText('mimetype');if(mimetype?.trim()!=='application/epub+zip')throw Error('EPUB 파일의 형식 표지가 올바르지 않습니다.');
      const encryption=await loader.loadText('META-INF/encryption.xml');
      if(encryption){const d=parser.parseFromString(encryption,'application/xml');for(const el of d.querySelectorAll('EncryptionMethod'))if(!['http://www.idpf.org/2008/embedding','http://ns.adobe.com/pdf/enc#RC'].includes(el.getAttribute('Algorithm')))throw Error('DRM·암호로 보호된 EPUB은 열 수 없습니다.');}
      book=await new EPUB(loader).init();
    }else if(format==='cbz')book=makeComicBook(loader,{name:'만화'});
    else if(['fb2','fbz','fb2.zip'].includes(format)){
      if(zip){const files=Object.values(zip.files).filter(f=>!f.dir&&/\.fb2$/i.test(f.name));if(files.length!==1)throw Error('압축 파일 안에 FB2 문서가 하나 있어야 합니다.');bytes=await files[0].async('uint8array');}
      book=await makeFB2(validateFB2(bytes));
    }
    else{
      validateMOBI(bytes);
      book=await new MOBI({unzlib:async data=>{const reader=new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate')).getReader(),parts=[];let n=0;try{for(;;){const {done,value}=await reader.read();if(done)break;n+=value.length;if(n>MAX_PART)throw Error('압축된 글꼴이 너무 큽니다.');parts.push(value);}}finally{await reader.cancel();}return new Uint8Array(await new Blob(parts).arrayBuffer());}}).open(new Blob([bytes]));
    }
    if(!book.sections?.length||book.sections.length>2000)throw Error('전자책은 1~2,000개 부분으로 나누어진 파일을 열 수 있습니다.');
    const docs=[],ids=new Map(),idMaps=[],sections=book.sections;let total=0;
    for(let index=0;index<sections.length;index++){
      if(typeof sections[index].load!=='function'&&sections[index].linear==='no'){docs.push(null);idMaps.push(new Map());continue;}
      const url=await sections[index].load(),blob=resourceBlobs.get(url);
      if(!blob)throw Error('전자책 본문을 읽지 못했습니다.');
      const text=await blob.text();total+=text.length;if(total>MAX_TEXT)throw Error('전자책 읽기 화면이 너무 큽니다.');
      const doc=parser.parseFromString(text,/<html\b[^>]*\bxmlns\s*=\s*["']http:\/\/www\.w3\.org\/1999\/xhtml["']/i.test(text)?'application/xhtml+xml':'text/html');if(!doc.body)throw Error('전자책 본문이 비어 있습니다.');
      docs.push(doc);const map=new Map();idMaps.push(map);let number=0;
      ids.set(doc.body,'ebook-section-'+index);ids.set(doc.documentElement,'ebook-section-'+index);
      for(const el of doc.querySelectorAll('[id],a[name]')){const name=el.getAttribute('id')||el.getAttribute('name');const id='ebook-'+index+'-'+(++number);ids.set(el,id);if(!map.has(name))map.set(name,id);}
    }
    async function target(href,index){
      try{
        const resolved=index!==undefined&&sections[index].resolveHref?sections[index].resolveHref(href):href;
        const result=await book.resolveHref?.(resolved);if(!result||!docs[result.index])return null;
        const node=result.anchor?.(docs[result.index]);let el=node?.nodeType===1?node:node?.startContainer?.parentElement;
        if(!el)el=docs[result.index].body;
        if(!ids.has(el))ids.set(el,'ebook-'+result.index+'-anchor-'+ids.size);
        return '#'+ids.get(el);
      }catch{return null;}
    }
    const outline=[];
    async function toc(items,level=1){if(level>20)return;for(const item of items||[]){if(outline.length>=10000)throw Error('전자책 목차가 너무 큽니다.');const href=await target(item.href);if(href&&item.label)outline.push({href,title:String(item.label).slice(0,1000),level});await toc(item.subitems,level+1);}}
    await toc(book.toc);
    const links=new Map();
    for(let index=0;index<docs.length;index++)for(const a of docs[index]?.querySelectorAll('a[href]')||[]){
      const href=a.getAttribute('href');let dest=await target(href,index);
      if(!dest&&href.startsWith('#'))dest=idMaps[index].has(href.slice(1))?'#'+idMaps[index].get(href.slice(1)):null;
      links.set(a,dest||(!href.startsWith('#')?safeLink(href):null));
    }
    const cached=new Map();let embedded=0;
    async function resource(url,kind='image',depth=0){
      if(!url||depth>12)return null;
      if(url.startsWith('#'))return url;
      if(url.startsWith('data:'))return /^data:(?:image\/(?:png|jpeg|gif|webp|svg\+xml|bmp|avif)|font\/[\w.-]+|application\/(?:font-woff|vnd.ms-fontobject|octet-stream));base64,[a-z\d+/=\s]+$/i.test(url)?url:null;
      if(!resourceBlobs.has(url)){warnings.push('외부 그림·글꼴·미디어는 다운로드하지 않습니다.');return null;}
      if(cached.has(url))return cached.get(url);
      const blob=resourceBlobs.get(url);if(blob.size>MAX_PART)throw Error('전자책의 리소스가 너무 큽니다.');
      const data=new Uint8Array(await blob.arrayBuffer());let mime=blob.type.split(';')[0]||sniff(data);
      if(kind==='image'&&!/^image\/(?:png|jpeg|gif|webp|svg\+xml|bmp|avif|jxl)$/.test(mime))return null;
      if(kind==='font'&&!/^(?:font\/|application\/(?:font|octet-stream|vnd.ms-fontobject))/.test(mime))return null;
      embedded+=data.length;if(embedded>MAX_TEXT)throw Error('전자책 그림·글꼴 합계가 너무 큽니다.');
      const result='data:'+mime+';base64,'+bytes64(data);cached.set(url,result);return result;
    }
    async function declarations(style,index,depth){let output='';for(let i=0;i<style.length;i++){
      const prop=style[i];let value=style.getPropertyValue(prop);
      if(!/^[-a-z]+$/.test(prop)||/^(?:behavior|-moz-binding|pointer-events|touch-action|user-select|z-index|content)$/.test(prop)||/\\|expression\s*\(|javascript:|@import|image-set\s*\(/i.test(value)||prop==='position'&&/fixed|sticky/i.test(value))continue;
      const urls=[...value.matchAll(/url\(\s*['"]?([^'"\)]*?)['"]?\s*\)/gi)];let valid=true;
      for(const match of urls){const u=match[1].trim(),replacement=u.startsWith('#')?'#'+(idMaps[index].get(u.slice(1))||u.slice(1)):await resource(u,prop==='src'?'font':'image',depth+1);if(!replacement){valid=false;break;}value=value.replace(match[0],'url("'+replacement+'")');}
      if(valid)output+=prop+':'+value+(style.getPropertyPriority(prop)?' !important':'')+';';
    }return output;}
    async function stylesheet(text,index,depth=0,seen=new Set()){
      if(depth>12||text.length>2*1024*1024)return '';let sheet;try{sheet=parseCSS(text);}catch{warnings.push('해석할 수 없는 전자책 스타일 일부는 기본 모양으로 표시합니다.');return '';}
      let result='';const scope='#ebook-section-'+index;
      async function rules(list){for(const rule of list){
        if(rule.type===1){const selector=selectors(rule.selectorText).map(s=>s.trim().replace(/#([\w\u0080-\uffff-]+)/g,(m,id)=>idMaps[index].has(id)?'#'+idMaps[index].get(id):m).replace(/(^|[\s>+~])(html|body|:root)(?=[\s.#:[>+~]|$)/g,'$1:scope').replace(/:scope\s+(?=:scope)/g,'')).join(',');if(!/[{}\\]/.test(selector))result+='@scope ('+scope+'){'+selector+'{'+await declarations(rule.style,index,depth)+'}}';}
        else if(rule.type===5)result+='@font-face{'+await declarations(rule.style,index,depth)+'}';
        else if(rule.type===3){const url=rule.href;if(resourceBlobs.has(url)&&!seen.has(url)){seen.add(url);result+=await stylesheet(await resourceBlobs.get(url).text(),index,depth+1,seen);}}
        else if(rule.type===4&&rule.media?.mediaText&&!/[{}\\]/.test(rule.media.mediaText)){result+='@media '+rule.media.mediaText+'{';await rules(rule.cssRules);result+='}';}
      }}await rules(sheet.cssRules);return result.replace(/<\/style/gi,'');
    }
    const bodies=[];let outputBytes=0;
    for(let index=0;index<docs.length;index++){
      const doc=docs[index];if(!doc)continue;const nodes=[...doc.body.querySelectorAll('*')];if(nodes.length>200000)throw Error('전자책의 한 부분에 개체가 너무 많습니다.');
      let css='';for(const el of doc.querySelectorAll('style,link[rel=stylesheet]')){
        const text=el.localName==='style'?el.textContent:resourceBlobs.has(el.getAttribute('href'))?await resourceBlobs.get(el.getAttribute('href')).text():'';
        css+=await stylesheet(text,index);el.remove();
      }
      for(const el of nodes){
        const tag=el.localName.toLowerCase();
        if(['script','iframe','object','embed','template','link','meta','base','style','form','input','button','textarea','select','audio','video','source','track','foreignobject','animate','animatemotion','animatetransform','set'].includes(tag)){if(['audio','video'].includes(tag))warnings.push('전자책의 오디오·영상은 재생하지 않습니다.');el.remove();continue;}
        if(!tags.has(tag)){el.replaceWith(...el.childNodes);continue;}
        const style=el.getAttribute('style');const image=el.getAttribute(['image','use'].includes(tag)?'href':'src')||el.getAttribute('xlink:href');
        for(const a of [...el.attributes]){
          if(!attrs.has(a.name.toLowerCase())){el.removeAttribute(a.name);continue;}
          if(/url\s*\(/i.test(a.value)){const ref=a.value.match(/^url\(\s*['"]?#([^'"\s)]+)['"]?\s*\)$/i),id=ref&&idMaps[index].get(ref[1]);if(id)el.setAttribute(a.name,'url(#'+id+')');else el.removeAttribute(a.name);}
        }
        if(ids.has(el))el.id=ids.get(el);
        if(style){try{el.setAttribute('style',await declarations(parseCSS('x{'+style+'}').cssRules[0].style,index,0));}catch{}}
        if(tag==='a'){const href=links.get(el);if(href)el.setAttribute('href',href);}
        if(tag==='img'||tag==='image'){
          const src=await resource(image);if(src)el.setAttribute(tag==='img'?'src':'href',src);else{el.replaceWith(doc.createTextNode(el.getAttribute('alt')||''));warnings.push('표시할 수 없는 그림이 있습니다. 원본 파일은 그대로 보관합니다.');}
        }
        if(tag==='use'){const ref=image||el.getAttribute('href');if(ref?.startsWith('#'))el.setAttribute('href','#'+(idMaps[index].get(ref.slice(1))||''));else el.remove();}
      }
      const id='ebook-section-'+index,heading=outline.find(x=>x.href==='#'+id)?.title||doc.body.querySelector('h1,h2,h3')?.textContent.trim()||String(index+1)+'번째 부분';
      if(!outline.some(x=>x.href==='#'+id||x.href.startsWith('#ebook-'+index+'-')))outline.push({href:'#'+id,title:heading,level:1});
      const cls=esc((doc.body.getAttribute('class')||'')+(format==='cbz'?' ebook-comic-page':'')),style=doc.body.getAttribute('style');let inline='';if(style)try{inline=await declarations(parseCSS('x{'+style+'}').cssRules[0].style,index,0);}catch{}
      const content='<section class="ebook-section '+cls+'" id="'+id+'"'+(inline?' style="'+esc(inline)+'"':'')+'>'+[...doc.body.childNodes].map(htmlNode).join('')+'</section>';
      let page=content;
      if(book.rendition?.layout==='pre-paginated'&&format!=='cbz'){
        const viewport=doc.querySelector('meta[name=viewport]')?.getAttribute('content')||'',dimension=key=>{const n=Number(viewport.match(new RegExp(key+'\\s*=\\s*([\\d.]+)','i'))?.[1]);return Number.isFinite(n)&&n>=100&&n<=10000?n:key==='width'?600:800;},width=dimension('width'),height=dimension('height');
        page='<section class="office-page ebook-fixed-page" style="width:'+(width/16)+'em"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '+width+' '+height+'"><foreignObject width="'+width+'" height="'+height+'"><div xmlns="http://www.w3.org/1999/xhtml" data-office-text style="font-size:16px;width:'+width+'px;height:'+height+'px">'+content+'</div></foreignObject></svg></section>';
      }
      const part='<style>'+css+'</style>'+page;
      outputBytes+=part.length;if(outputBytes>MAX_TEXT)throw Error('전자책 읽기 화면이 너무 큽니다.');bodies.push(part);
    }
    if(format==='cbz')warnings.push('만화 이미지에는 펜·도형·메모·북마크를 사용할 수 있습니다. 이미지 안 글자의 검색·선택·읽어주기는 OCR 없이 제공되지 않습니다.');
    const tocHTML='<template data-ebook-outline>'+outline.map(x=>'<a href="'+esc(x.href)+'" data-level="'+x.level+'">'+esc(x.title)+'</a>').join('')+'</template>';
    return tocHTML+'<article data-ebook data-ebook-layout="'+(book.rendition?.layout==='pre-paginated'?'fixed':'reflow')+'" dir="'+(book.dir==='rtl'?'rtl':'ltr')+'">'+bodies.join('')+'</article>';
  }finally{book?.destroy?.();for(const url of resourceBlobs.keys())if(!persistent.has(url))resourceBlobs.delete(url);}
}
