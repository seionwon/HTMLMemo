import {bookmarkAnchorTarget,captureBookmarkAnchors,describeDrawingTarget,drawingTargetQuote,currentSection,textIndex} from './document.js';

const QUOTE=192,CONTEXT=80;
const normalize=text=>text.replace(/\s+/gu,' ');
const escape=text=>text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function bookmarkTextAnchor(mark) {
  const a=mark?.textAnchor;
  return mark?.locationVersion===2&&a&&typeof a.quote==='string'&&a.quote.trim()&&a.quote.length<=QUOTE&&
    Number.isSafeInteger(a.start)&&a.start>=0&&Number.isSafeInteger(a.end)&&a.end===a.start+a.quote.length&&
    typeof a.prefix==='string'&&a.prefix.length<=CONTEXT&&typeof a.suffix==='string'&&a.suffix.length<=CONTEXT&&
    (a.section==null||typeof a.section==='string')&&Number.isSafeInteger(mark.textPoint)&&mark.textPoint>=0&&mark.textPoint<a.quote.length ? a : null;
}
export function bookmarkTextLocation(index,point,section='',lineOffset=0,{from=0,to=index.text.length}={}) {
  point=Math.max(0,Math.min(index.text.length-1,point));
  let start=Math.max(from,point-64);if(start>from&&/[\uDC00-\uDFFF]/u.test(index.text[start]))start--;
  let end=Math.min(to,start+QUOTE);if(end<to&&/[\uD800-\uDBFF]/u.test(index.text[end-1]))end--;
  return {locationVersion:2,textPoint:point-start,textOffsetY:Number.isFinite(lineOffset)?Math.max(0,Math.min(1,lineOffset)):0,
    textAnchor:{start,end,quote:index.text.slice(start,end),prefix:index.text.slice(Math.max(0,start-CONTEXT),start),suffix:index.text.slice(end,end+CONTEXT),...(section?{section}:{})}};
}
function shared(a,b,end=false) {
  let n=0;while(n<a.length&&n<b.length&&(end?a[a.length-1-n]===b[b.length-1-n]:a[n]===b[n]))n++;return n;
}
function contextScore(text,start,end,a) {
  const prefix=normalize(a.prefix),suffix=normalize(a.suffix),length=prefix.length+suffix.length;
  return length?(shared(normalize(text.slice(Math.max(0,start-CONTEXT*3),start)),prefix,true)+shared(normalize(text.slice(end,end+CONTEXT*3)),suffix))/length:0;
}
function originalOffset(text,normalizedOffset) {
  let length=0;
  for(const part of text.matchAll(/\s+|[^\s]/gu)){
    const size=/\s/u.test(part[0])?1:part[0].length;
    if(length+size>normalizedOffset)return part.index+Math.min(size-1,normalizedOffset-length);
    length+=size;
  }
  return Math.max(0,text.length-1);
}
// Match context as well as text: repeated passages must not silently choose the first copy.
// A whitespace-tolerant regexp keeps source offsets without a second whole-document index.
export function findBookmarkText(text,mark,from=0,to=text.length,{sameEdition=false}={}) {
  const a=bookmarkTextAnchor(mark);if(!a)return null;
  // In the unchanged source, reflow never changes character offsets. Edition migration
  // deliberately does not take this shortcut, even if an old offset still happens to match.
  if(sameEdition&&a.start>=from&&a.end<=to&&text.slice(a.start,a.end)===a.quote&&contextScore(text,a.start,a.end,a)===1)return {start:a.start,end:a.end,point:a.start+mark.textPoint,context:1,similarity:1};
  const pattern=new RegExp(a.quote.split(/(\s+)/u).map(part=>/\s/u.test(part)?'\\s+':escape(part)).join(''),'gu');pattern.lastIndex=from;
  const candidates=[];let match;
  while((match=pattern.exec(text))&&match.index<to){
    if(match.index+match[0].length>to)continue;
    if(candidates.length===256)return {ambiguous:true};
    candidates.push({start:match.index,end:match.index+match[0].length,context:contextScore(text,match.index,match.index+match[0].length,a),value:match[0]});
  }
  if(!candidates.length)return null;
  candidates.sort((a,b)=>b.context-a.context);
  const hit=candidates[0];if(candidates.length>1&&(hit.context<.25||hit.context-candidates[1].context<.05))return {ambiguous:true};
  const point=hit.start+originalOffset(hit.value,normalize(a.quote.slice(0,mark.textPoint)).length);
  return {start:hit.start,end:hit.end,point,context:hit.context,similarity:1};
}
function targetElement(doc,mark) {
  const target=bookmarkAnchorTarget(mark);if(!target)return null;
  const root=target.rootId?doc.getElementById(target.rootId):doc.body;if(!root)return null;
  const matches=node=>node&&root.contains(node)&&node.localName===target.tag&&drawingTargetQuote(doc,node)===target.quote;
  let node=target.id?doc.getElementById(target.id):root;
  if(!target.id)for(const part of target.path)node=node?.children[part];
  if(matches(node))return node;
  const found=[...root.querySelectorAll(target.tag)].filter(matches);return found.length===1?found[0]:null;
}
function pointInBlock(doc,index,top,left) {
  const range=doc.createRange();if(!range.setStart||!range.getBoundingClientRect)return null;
  let best=null;
  for(const {node} of index.nodes){
    if(!node.textContent.trim()||node.parentElement?.closest('nav,header,footer,[hidden],[aria-hidden="true"],[data-htmlmemo-ui]'))continue;
    range.selectNodeContents(node);const bounds=range.getBoundingClientRect();if(!bounds.height||!bounds.width)continue;
    const distance=bounds.top>top?bounds.top-top:bounds.bottom<=top?top-bounds.bottom+1:0;
    if(best&&distance>best.distance)continue;
    let lo=0,hi=node.length-1;
    const rectAt=offset=>{range.setStart(node,offset);range.setEnd(node,Math.min(node.length,offset+(node.textContent.codePointAt(offset)>0xffff?2:1)));return range.getBoundingClientRect();};
    while(lo<hi){const mid=(lo+hi)>>>1,r=rectAt(mid);if(r.bottom<=top||(r.top<=top&&r.right<=left))lo=mid+1;else hi=mid;}
    // Never persist an offset inside a surrogate pair.
    if(lo>0&&/[\uDC00-\uDFFF]/u.test(node.textContent[lo]))lo--;
    const rect=rectAt(lo);if(!rect.height||!rect.width)continue;
    const dy=rect.top>top?rect.top-top:rect.bottom<=top?top-rect.bottom+1:0,dx=Math.abs(rect.left-left);
    if(!best||dy<best.distance||dy===best.distance&&dx<best.dx)best={node,offset:lo,rect,distance:dy,dx};
  }
  return best;
}
// Capture the actual line/character, not the beginning of a potentially very long paragraph.
// Geometry is read only for the saved block; the existing text index can be reused by the reader.
export function captureBookmarkLocations(doc,marks,origin,{getIndex}={}) {
  const section=currentSection(doc),needs=mark=>mark.editionPosition!=='section'&&!bookmarkTextAnchor(mark)&&(mark.section||'')===section;
  if(!marks.some(needs))return structuredClone(marks);
  const prepared=captureBookmarkAnchors(doc,marks.filter(needs),origin),byId=new Map(prepared.map(mark=>[mark.id,mark]));
  const measure=doc.createRange?.(),canMeasure=measure?.setStart&&measure?.getBoundingClientRect;
  let index,offsets;const blocks=new WeakMap();
  return marks.map(mark=>{
    if(!needs(mark))return structuredClone(mark);
    const next=byId.get(mark.id);if(!canMeasure)return next;
    const target=targetElement(doc,next),block=target||doc.getElementById('reader-content')||doc.body;
    const rect=target?.getBoundingClientRect?.(),offset=Number.isFinite(next.anchorOffset)?Math.max(0,Math.min(1,next.anchorOffset)):0;
    const top=rect?.height>0?rect.top+rect.height*offset:mark.top+origin.top;
    if(!blocks.has(block))blocks.set(block,textIndex(doc,block));
    const point=pointInBlock(doc,blocks.get(block),top,mark.left+origin.left);if(!point)return next;
    if(!index){index=getIndex?.()||textIndex(doc);offsets=new Map(index.nodes.map(n=>[n.node,n.start]));}
    const start=offsets.get(point.node);if(start===undefined)return next;
    const nodes=blocks.get(block).nodes,first=nodes[0]?.node,last=nodes.at(-1)?.node;
    Object.assign(next,bookmarkTextLocation(index,start+point.offset,section,(top-point.rect.top)/point.rect.height,{from:offsets.get(first)??0,to:last?(offsets.get(last)??0)+last.length:index.text.length}));
    if(target)next.anchorTarget=describeDrawingTarget(doc,target);
    return next;
  });
}
