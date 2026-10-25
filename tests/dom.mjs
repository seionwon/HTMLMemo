import { DOMParser as Parser } from 'linkedom';
export const NodeFilter={SHOW_TEXT:4,FILTER_ACCEPT:1,FILTER_REJECT:2,FILTER_SKIP:3};
export function documentFor(html,url='https://example.test/article') {
  // Browser DOMParser always creates an HTML document, including blank srcdoc.
  let doc=new Parser().parseFromString(html,'text/html');
  if(!doc.documentElement)doc=new Parser().parseFromString('<html><head></head><body></body></html>','text/html');
  Object.defineProperty(doc,'baseURI',{value:url,configurable:true});
  Object.defineProperty(doc,'location',{value:{href:url},configurable:true});
  Object.defineProperty(doc.documentElement,'clientWidth',{value:960,configurable:true});
  Object.defineProperty(doc.documentElement,'clientHeight',{value:800,configurable:true});
  // LinkeDOM intentionally omits browser geometry and a few text APIs. These
  // adapters model their contracts only; this is not a rendering/browser test.
  const textPrototype=Object.getPrototypeOf(doc.createTextNode(''));
  if(!textPrototype.splitText)textPrototype.splitText=function(offset){const next=this.ownerDocument.createTextNode(this.textContent.slice(offset));this.textContent=this.textContent.slice(0,offset);this.parentNode.insertBefore(next,this.nextSibling);return next;};
  if(!Object.getOwnPropertyDescriptor(textPrototype,'length'))Object.defineProperty(textPrototype,'length',{get(){return this.textContent.length;}});
  const originalWalker=doc.createTreeWalker.bind(doc);
  doc.createTreeWalker=(root,show,filter)=>{const walker=originalWalker(root,show);return {currentNode:root,nextNode(){while(walker.nextNode()){if(!filter||filter.acceptNode(walker.currentNode)===NodeFilter.FILTER_ACCEPT){this.currentNode=walker.currentNode;return true;}}return false;}};};
  for(const link of doc.querySelectorAll('link,a'))Object.defineProperty(link,'href',{get(){return new URL(this.getAttribute('href'),url).href;},configurable:true});
  for(const image of doc.querySelectorAll('img'))Object.defineProperty(image,'currentSrc',{get(){return new URL(this.getAttribute('src'),url).href;},configurable:true});
  for(const canvas of doc.querySelectorAll('canvas'))canvas.toDataURL=()=> 'data:image/png;base64,aGVsbG8=';
  return doc;
}
export class DOMParser {parseFromString(html){return documentFor(html);}}
export function installDOM(){globalThis.DOMParser=DOMParser;globalThis.NodeFilter=NodeFilter;}
