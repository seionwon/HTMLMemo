// A DOM that cannot execute scripts or request resources, used only by the
// ebook import worker. Namespace additions bridge linkedom's XML subset.
import {DOMParser as Parser,Document,Element} from 'linkedom';
const XMLNS='http://www.w3.org/2000/xmlns/';
const originalNames=new WeakMap();
function namespace(node,prefix){
  if(prefix==='xml')return 'http://www.w3.org/XML/1998/namespace';
  if(prefix==='xmlns')return XMLNS;
  for(let el=node.nodeType===9?node.documentElement:node;el;el=el.parentElement){
    const value=el.getAttribute(prefix?'xmlns:'+prefix:'xmlns');if(value)return value;
  }
  return null;
}
for(const proto of [Document.prototype,Element.prototype]){
  proto.lookupNamespaceURI=function(prefix){return namespace(this,prefix);};
  proto.lookupPrefix=function(uri){for(let el=this.nodeType===9?this.documentElement:this;el;el=el.parentElement)for(const a of el.attributes)if(a.name.startsWith('xmlns:')&&a.value===uri)return a.name.slice(6);return null;};
  proto.getElementsByTagNameNS=function(ns,name){return [...this.querySelectorAll('*')].filter(el=>(name==='*'||el.localName===name)&&(ns==='*'||el.namespaceURI===ns));};
  const query=proto.querySelectorAll;
  proto.querySelectorAll=function(selector){return selector==='[*|href]:not([href])'?[...query.call(this,'*')].filter(el=>!el.hasAttribute('href')&&[...el.attributes].some(a=>a.name.endsWith(':href'))):query.call(this,selector);};
}
Element.prototype.getAttributeNS=function(ns,name){for(const a of this.attributes){const parts=a.name.split(':');if(parts.at(-1)===name&&(parts.length>1?namespace(this,parts[0]):null)===ns)return a.value;}return null;};
Element.prototype.setAttributeNS=function(ns,name,value){const prefix=name.includes(':')?'':this.lookupPrefix(ns);this.setAttribute(prefix?prefix+':'+name:name,value);};
function xmlDocument(doc){
  for(const el of doc.querySelectorAll('*')){
    const name=el.localName,parts=name.split(':');originalNames.set(el,name);
    Object.defineProperty(el,'localName',{value:parts.at(-1),configurable:true});
    Object.defineProperty(el,'namespaceURI',{get:()=>namespace(el,parts.length>1?parts[0]:null),configurable:true});
    for(const attr of el.attributes){const a=attr.name.split(':');Object.defineProperty(attr,'namespaceURI',{value:a.length>1?namespace(el,a[0]):null,configurable:true});Object.defineProperty(attr,'localName',{value:a.at(-1),configurable:true});}
  }
  Object.defineProperties(doc,{body:{get:()=>doc.querySelector('body')},head:{get:()=>doc.querySelector('head')}});
  return doc;
}
export class InertDOMParser {
  parseFromString(input,type='text/html'){
    let text=String(input);
    if(text.length>32*1024*1024)throw Error('전자책의 한 부분이 너무 큽니다.');
    if(/<!\s*ENTITY\b|<!\s*DOCTYPE[^>]*\[/i.test(text))throw Error('엔터티 선언이 있는 전자책은 열 수 없습니다.');
    // Legacy EPUB XHTML doctypes are allowed as inert declarations only.
    text=text.replace(/<!DOCTYPE[^>]*>/gi,'');
    if(type==='text/html'&&!/<html(?:\s|>)/i.test(text))text='<html><head></head><body>'+text+'</body></html>';
    const doc=new Parser().parseFromString(text,type);
    return type==='text/html'?doc:xmlDocument(doc);
  }
}
export const resourceBlobs=new Map();let sequence=0;
URL.createObjectURL=blob=>{const url='blob:librememo-ebook/'+(++sequence);resourceBlobs.set(url,blob);return url;};
URL.revokeObjectURL=url=>resourceBlobs.delete(url);
globalThis.CustomEvent??=class extends Event{constructor(type,options={}){super(type,options);this.detail=options.detail;}};
const inertDocument=new InertDOMParser().parseFromString('<html><head></head><body></body></html>','text/html');
inertDocument.implementation={createDocument:(ns,tag)=>new InertDOMParser().parseFromString('<'+tag+' xmlns="'+ns+'"/>','application/xml')};
export function activateEbookDOM(){
  globalThis.DOMParser=InertDOMParser;
  globalThis.XMLSerializer=class{serializeToString(node){return node.toString();}};
  globalThis.ProcessingInstruction=class{};
  globalThis.CSS={escape:value=>Array.from(String(value),c=>/[a-zA-Z0-9_-]/.test(c)?c:'\\'+c.codePointAt(0).toString(16)+' ').join('')};
  globalThis.document=inertDocument;
}
activateEbookDOM();
