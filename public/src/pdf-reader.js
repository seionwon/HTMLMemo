import {PdfTextSearch,indexPdfSearchPage,findPdfPageMatches} from './pdf/text-search.js';
import {createSearchTextCache} from './pdf/search-cache.js';
import {PdfPageImage,renderPdfPageImage} from './pdf/page-rendering.js';
import {exportPDFHTML,verifyPDF} from './pdf-document.js';
import {rangeFromOffsets,resolveTextAnchor,textIndex,selectionAnchor} from './document.js';
import {TEXT_TOOLS} from './model.js';
import {clamp} from './utils.js';
import {PDF_SCROLL_WINDOW_HEIGHT,pdfWindowBase} from './pdf/viewport-window.js';
import {localFileIdentity} from './local-files.js';

const SCALE=4/3,WINDOW_HEIGHT=PDF_SCROLL_WINDOW_HEIGHT,MAX_PIXELS=4*1024*1024,NS='http://www.w3.org/2000/svg';
const svg=(doc,tag,attrs)=>{const node=doc.createElementNS(NS,tag);for(const [key,value]of Object.entries(attrs))node.setAttribute(key,String(value));return node;};
let library;
async function pdfLibrary(){
  if(!library)library=import(new URL('vendor/pdfjs/pdf.min.mjs',document.baseURI).href).then(pdf=>{pdf.GlobalWorkerOptions.workerSrc=new URL('vendor/pdfjs/pdf.worker.min.mjs',document.baseURI).href;return pdf;}).catch(error=>{library=null;throw error;});
  return library;
}
/** PDFMemo's range transport, adapted to immutable local Blobs. No local server,
 * native bridge, external URL or eager whole-file ArrayBuffer is involved. */
export function blobRangeSource(pdfjs,source,onError){
  class LocalRange extends pdfjs.PDFDataRangeTransport{
    constructor(){super(source.size,new Uint8Array(),true);this.stopped=false;this.tail=Promise.resolve();}
    requestDataRange(begin,end){
      this.tail=this.tail.then(async()=>{if(this.stopped)return;if(!Number.isSafeInteger(begin)||!Number.isSafeInteger(end)||begin<0||end>source.size||begin>=end)throw Error('잘못된 PDF 읽기 범위입니다.');const bytes=new Uint8Array(await source.slice(begin,end).arrayBuffer());if(!this.stopped)this.onDataRange(begin,bytes);}).catch(error=>{if(!this.stopped){this.abort();onError(error);}});
    }
    abort(){this.stopped=true;}
  }
  return {range:new LocalRange(),disableStream:true,disableAutoFetch:true,rangeChunkSize:65536};
}

export class PdfReader{
  constructor(reader,source){this.reader=reader;this.source=source;this.doc=reader.doc;this.slots=new Map();this.sizes=new Map();this.base=0;this.scale=reader.readingFontScale();this.jumpVersion=0;this.disposed=false;this.searchGeneration=0;}
  async open(){
    await verifyPDF(this.source);this.pdfjs=await pdfLibrary();if(this.disposed)return;
    const assets=new URL('vendor/pdfjs/',document.baseURI).href;
    const ranges=blobRangeSource(this.pdfjs,this.source,error=>{this.reader.callbacks.onError?.(error);void this.loading?.destroy();});
    this.loading=this.pdfjs.getDocument({...ranges,ownerDocument:this.doc,cMapUrl:assets+'cmaps/',cMapPacked:true,standardFontDataUrl:assets+'standard_fonts/',wasmUrl:assets+'wasm/',isEvalSupported:false,enableScripting:false,enableXfa:false,useWasm:true,verbosity:0});
    this.loading.onPassword=()=>{void this.loading.destroy();};
    try{this.pdf=await this.loading.promise;}catch(error){if(error?.name==='PasswordException'||/password|destroyed/i.test(error?.message||''))throw Error('암호가 설정된 PDF입니다. 암호를 해제한 사본을 가져와주세요.');throw Error('PDF를 열지 못했습니다. 파일이 손상되었거나 지원하지 않는 형식입니다.');}
    if(this.disposed){await this.loading.destroy();return;}
    if(!Number.isInteger(this.pdf.numPages)||this.pdf.numPages<1||this.pdf.numPages>100000)throw Error('지원하는 PDF 페이지 수를 벗어났습니다.');
    this.count=this.pdf.numPages;const first=await this.pdf.getPage(1),viewport=first.getViewport({scale:SCALE});this.defaultSize={width:viewport.width,height:viewport.height};this.sizes.set(1,this.defaultSize);
    this.tops=new Float64Array(this.count+1);this.relayout();
    this.reader.metadata.viewport.width=this.width*this.scale;this.reader.metadata.pdf={version:1,pages:this.count};
    this.root=this.doc.getElementById('htmlmemo-pdf-pages');this.root.removeAttribute('data-tts-root');
    this.root.removeAttribute('data-htmlmemo-anchor');this.relayout();
    const style=this.doc.createElement('style');style.id='htmlmemo-pdf-style';style.textContent=PDF_STYLE;this.doc.head.append(style);
    this.doc.body.style.width=this.width*this.scale+'px';
    this.entries=await this.readOutline();
    const position=this.reader.metadata.view.pdfPosition,page=clamp(Number(position?.page)||1,1,this.count);
    await this.ensure(page);if(this.disposed)return;
    this.seek(page,clamp(Number(position?.y)||0,0,1),false);this.setSpeechRoot(page);
    let cache;const store=async()=>cache??=localFileIdentity(this.source).then(identity=>createSearchTextCache({id:identity.digest,modified:identity.digest,length:identity.size},this.count));
    this.searchEngine=new PdfTextSearch(this.pdf,{store:{load:async()=>(await store()).load(),save:async pages=>(await store()).save(pages)}});
    this.onScroll=()=>{if(this.disposed||this.reader.preparing)return;this.schedule();};
    this.doc.defaultView.addEventListener('scroll',this.onScroll,{passive:true});this.reader.viewport.addEventListener('scroll',this.onScroll,{passive:true});
    this.schedule();
  }
  relayout(){
    let top=0,width=this.defaultSize.width;
    for(let page=1;page<=this.count;page++){this.tops[page-1]=top;const size=this.sizes.get(page)||this.defaultSize;top+=size.height+12;width=Math.max(width,size.width);}
    this.tops[this.count]=top;this.total=top;this.width=width;
    if(this.root){
      this.root.style.height=Math.min(this.total*this.scale,WINDOW_HEIGHT)+'px';this.root.style.width=this.width*this.scale+'px';for(const slot of this.slots.values())this.place(slot);
      const width=this.width*this.scale;if(this.reader.naturalWidth!==width){this.reader.naturalWidth=width;this.reader.metadata.viewport.width=width;this.reader.frame.style.width=width+'px';this.doc.body.style.width=width+'px';if(!this.reader.preparing&&this.reader.autoFit)this.reader.resizeViewport();}
    }
  }
  size(page){return this.sizes.get(page)||this.defaultSize;}
  pageAt(top=this.logicalTop){let lo=0,hi=this.count-1;while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(this.tops[mid]*this.scale<=top)lo=mid;else hi=mid-1;}return lo+1;}
  get logicalTop(){return this.base+(this.reader.rootScrollTop()||0);}
  position(){const page=this.pageAt();return {page,y:clamp((this.logicalTop/this.scale-this.tops[page-1])/this.size(page).height,0,1)};}
  setLogicalTop(value){
    const top=clamp(value,0,Math.max(0,this.total*this.scale-this.reader.viewport.clientHeight/this.reader.zoom));
    if(top<this.base||top>this.base+WINDOW_HEIGHT-this.reader.viewport.clientHeight/this.reader.zoom)this.windowAt(top);
    this.doc.defaultView.scrollTo(this.reader.rootScrollLeft(),Math.max(0,top-this.base));this.schedule();
  }
  windowAt(top){
    this.base=pdfWindowBase(this.total*this.scale,top,top);
    for(const slot of this.slots.values())this.place(slot);
  }
  place(slot){const size=this.size(slot.page);Object.assign(slot.node.style,{top:(this.tops[slot.page-1]*this.scale-this.base)+'px',width:size.width*this.scale+'px',height:size.height*this.scale+'px',fontSize:16*this.scale+'px'});slot.inner.style.transform='scale('+this.scale+')';}
  async readOutline(){
    const entries=[];const outline=await this.pdf.getOutline().catch(()=>null);let order=0;
    const visit=async(items,level)=>{for(const item of items||[]){if(entries.length>=20000||level>32)break;let dest=item.dest,page;
      try{if(typeof dest==='string')dest=await this.pdf.getDestination(dest);if(Array.isArray(dest)){page=typeof dest[0]==='number'?dest[0]+1:await this.pdf.getPageIndex(dest[0])+1;}}
      catch{/* Keep children whose own destinations remain valid. */}
      if(page>=1&&page<=this.count){const node=this.doc.createElement('span');node.id='pdf-outline-'+order++;node.dataset.pdfPage=page;node.dataset.pdfDestination=JSON.stringify(dest||null);entries.push({node,title:String(item.title||page+'쪽').slice(0,1000),level:Math.min(6,level),page});}
      await visit(item.items,level+1);
    }};await visit(outline,1);
    if(!entries.length)for(let page=1;page<=this.count;page++){const node=this.doc.createElement('span');node.dataset.pdfPage=page;entries.push({node,title:page+'쪽',level:1,page});}
    return entries;
  }
  async ensure(page){
    if(this.disposed||page<1||page>this.count)return null;
    let slot=this.slots.get(page);if(slot)return slot.ready;
    const node=this.doc.createElement('section');node.id='pdf-page-'+page;node.className='htmlmemo-pdf-page';node.dataset.pdfPage=page;node.dataset.htmlmemoAnchor='n'+page;node.setAttribute('aria-label',page+'쪽');
    const inner=this.doc.createElement('div');inner.className='htmlmemo-pdf-page-inner';node.append(inner);this.root.append(node);
    slot={page,node,inner,controller:new AbortController(),used:performance.now()};slot.image=new PdfPageImage(inner);this.slots.set(page,slot);this.place(slot);
    slot.ready=(async()=>{
      const pdfPage=await this.pdf.getPage(page);if(this.disposed||slot.controller.signal.aborted)return null;slot.pdfPage=pdfPage;
      const viewport=pdfPage.getViewport({scale:SCALE}),previous=this.size(page);this.sizes.set(page,{width:viewport.width,height:viewport.height});
      if(previous.width!==viewport.width||previous.height!==viewport.height){const position=this.position();this.relayout();this.seek(position.page,position.y,false);}
      Object.assign(inner.style,{width:viewport.width+'px',height:viewport.height+'px'});
      const text=this.doc.createElement('div');text.className='textLayer';inner.append(text);text.style.setProperty('--total-scale-factor',SCALE);text.style.setProperty('--scale-factor',SCALE);text.style.setProperty('--user-unit',viewport.userUnit||1);slot.text=text;
      const content=await pdfPage.getTextContent();slot.content=content;slot.viewport=viewport;if(this.disposed||slot.controller.signal.aborted)return null;
      slot.textLayer=new this.pdfjs.TextLayer({textContentSource:content,container:text,viewport});await slot.textLayer.render();
      for(const span of text.querySelectorAll('span'))span.dataset.pdfText='';
      await this.links(slot,viewport);if(this.disposed)return null;
      this.reader.searchIndexCache?.invalidate();this.renderTextMarks();this.renderPage(slot);node.dataset.pdfReady='true';return slot;
    })().catch(error=>{if(this.disposed||slot.controller.signal.aborted)return null;this.slots.delete(page);node.remove();throw error;});return slot.ready;
  }
  async links(slot,viewport){
    const annotations=await slot.pdfPage.getAnnotations({intent:'display'});if(this.disposed)return;
    for(const item of annotations){if(item.subtype!=='Link'||!Array.isArray(item.rect))continue;const [x1,y1]=viewport.convertToViewportPoint(item.rect[0],item.rect[1]),[x2,y2]=viewport.convertToViewportPoint(item.rect[2],item.rect[3]);const a=this.doc.createElement('a');
      if(item.dest){a.href='#pdf-destination';a.addEventListener('click',event=>{event.preventDefault();event.stopImmediatePropagation();void this.navigateDestination(item.dest,true).catch(error=>this.reader.callbacks.onError?.(error));},true);}
      else{try{const url=new URL(item.url);if(!['https:','http:','mailto:','tel:'].includes(url.protocol)||url.username||url.password)continue;a.href=url.href;}catch{continue;}}
      a.className='htmlmemo-pdf-link';a.setAttribute('aria-label',item.title||'문서 링크');Object.assign(a.style,{left:Math.min(x1,x2)+'px',top:Math.min(y1,y2)+'px',width:Math.abs(x2-x1)+'px',height:Math.abs(y2-y1)+'px'});slot.inner.append(a);
    }
  }
  renderPage(slot){
    if(this.disposed||slot.painting)return;
    slot.painting=true;
    void renderPdfPageImage({doc:this.pdf,pageNumber:slot.page,width:this.size(slot.page).width,sliceTop:0,sliceBottom:1,rasterZoom:this.reader.zoom*this.scale,maxPixels:MAX_PIXELS,priority:()=>slot.page===this.pageAt()?0:1,signal:slot.controller.signal,image:slot.image,renderOptions:()=>({annotationMode:this.pdfjs.AnnotationMode.ENABLE}),waitForIdle:async()=>{},onSize:()=>{}}).catch(error=>{if(!this.disposed&&!slot.controller.signal.aborted)this.reader.callbacks.onError?.(error);}).finally(()=>{slot.painting=false;});
  }
  schedule(){if(this.disposed||this.frame)return;this.frame=this.doc.defaultView.requestAnimationFrame(()=>{this.frame=null;void this.updateVisible().catch(error=>{if(!this.disposed)this.reader.callbacks.onError?.(error);});});}
  async updateVisible(){
    if(this.reader.host.hidden||this.disposed)return;
    const logical=this.logicalTop,page=this.pageAt(logical),end=this.pageAt(logical+this.reader.viewport.clientHeight/this.reader.zoom),wanted=new Set();
    if(this.total*this.scale>WINDOW_HEIGHT&&(logical-this.base<WINDOW_HEIGHT*.15||logical-this.base>WINDOW_HEIGHT*.8)){const old=this.base;this.windowAt(logical);if(old!==this.base)this.doc.defaultView.scrollTo(this.reader.rootScrollLeft(),logical-this.base);}
    for(let p=Math.max(1,page-1);p<=Math.min(this.count,end+1,page+63);p++)wanted.add(p);this.wanted=wanted;
    await this.ensure(page);for(const number of wanted)if(number!==page)void this.ensure(number).catch(error=>{if(!this.disposed)this.reader.callbacks.onError?.(error);});
    if(this.disposed)return;
    for(const slot of this.slots.values()){
      if(wanted.has(slot.page)){slot.used=performance.now();if(slot.node.dataset.pdfReady)this.renderPage(slot);}
      else if(!slot.painting&&slot.image.canvas){slot.image.dispose();slot.image=new PdfPageImage(slot.inner);slot.pdfPage?.cleanup();}
    }
    const selection=this.doc.getSelection();
    const retained=[...this.slots.values()].sort((a,b)=>b.used-a.used);
    for(const slot of retained.slice(12)){if(wanted.has(slot.page)||slot.node.contains(selection?.anchorNode)||slot.node.contains(selection?.focusNode)||slot.node.contains(this.speechRoot))continue;slot.controller.abort();slot.textLayer?.cancel();slot.image.dispose();slot.node.remove();this.slots.delete(slot.page);}
    if(!this.reader.readAloud?.isPlaying?.())this.setSpeechRoot(page);
    this.reader.renderDrawingLayer();this.reader.updateReadingControls();
  }
  seek(page,y=0,remember=true){
    this.setLogicalTop((this.tops[page-1]+this.size(page).height*y)*this.scale);
    if(remember){this.reader.rememberPosition();this.reader.callbacks.onView?.();}
  }
  async go(page,y=0,{history=false}={}){
    const version=++this.jumpVersion;page=clamp(page,1,this.count);
    if(history){this.reader.linkHistory.push({top:this.reader.scrollTop,left:this.reader.scrollLeft});if(this.reader.linkHistory.length>128)this.reader.linkHistory.shift();}
    this.seek(page,y,false);await this.ensure(page);if(this.disposed||version!==this.jumpVersion)return false;this.seek(page,y);this.setSpeechRoot(page);this.schedule();return true;
  }
  async navigateDestination(dest,history=false){
    if(typeof dest==='string')dest=await this.pdf.getDestination(dest);if(!Array.isArray(dest))return false;
    const page=typeof dest[0]==='number'?dest[0]+1:await this.pdf.getPageIndex(dest[0])+1;if(!(page>=1&&page<=this.count))return false;
    const proxy=await this.pdf.getPage(page),view=proxy.getViewport({scale:SCALE});let y=0;
    if(dest[1]?.name==='XYZ'&&Number.isFinite(dest[3]))y=view.convertToViewportPoint(Number.isFinite(dest[2])?dest[2]:0,dest[3])[1]/view.height;
    else if(['FitH','FitBH'].includes(dest[1]?.name)&&Number.isFinite(dest[2]))y=view.convertToViewportPoint(0,dest[2])[1]/view.height;
    return this.go(page,clamp(y,0,1),{history});
  }
  navigateNode(node){if(node?.dataset?.pdfDestination){try{return this.navigateDestination(JSON.parse(node.dataset.pdfDestination),true);}catch{return false;}}const page=Number(node?.dataset?.pdfPage||node?.closest?.('[data-pdf-page]')?.dataset.pdfPage);return page?this.go(page,0,{history:true}):false;}
  headingState(){const nodes=this.entries.map(item=>item.node),page=this.pageAt();let current=0;for(let i=0;i<this.entries.length;i++)if(this.entries[i].page<=page)current=i;return {nodes,current};}
  applyFont(){
    if(!this.root)return;const position=this.position();this.scale=this.reader.readingFontScale();this.relayout();this.doc.body.style.width=this.width*this.scale+'px';this.reader.naturalWidth=this.width*this.scale;this.reader.frame.style.width=this.reader.naturalWidth+'px';this.reader.metadata.viewport.width=this.reader.naturalWidth;this.windowAt((this.tops[position.page-1]+this.size(position.page).height*position.y)*this.scale);this.seek(position.page,position.y,false);this.schedule();
  }
  captureRects(range){
    const rects=[];
    for(const slot of this.slots.values()){
      if(!range.intersectsNode(slot.text))continue;const index=textIndex(this.doc,slot.text);
      for(const run of index.nodes){if(!range.intersectsNode(run.node))continue;const from=run.node===range.startContainer?range.startOffset:0,to=run.node===range.endContainer?range.endOffset:run.node.length;if(to<=from)continue;
        const part=this.doc.createRange();part.setStart(run.node,from);part.setEnd(run.node,to);const box=slot.node.getBoundingClientRect();
        for(const r of part.getClientRects()){const x=clamp((r.left-box.left)/box.width,0,1),y=clamp((r.top-box.top)/box.height,0,1),w=Math.min(r.width/box.width,1-x),h=Math.min(r.height/box.height,1-y);if(w>0&&h>0)rects.push({page:slot.page,x,y,w,h});}
      }
    }
    return rects;
  }
  addText(type,anchor,text){
    const r=this.reader,index=r.searchCache().get(),resolved=resolveTextAnchor(index,anchor),range=resolved&&rangeFromOffsets(this.doc,resolved.start,resolved.end,index);if(!range)return false;
    const rects=this.captureRects(range);if(!rects.length||rects.length>10000)return false;
    if(type==='note'){const first=rects[0],slot=this.slots.get(first.page);if(!text?.trim())return false;r.commit([...r.metadata.annotations,r.annotation(type,{anchor:'n'+first.page,anchorTarget:{tag:'section',id:slot.node.id,rootId:'',section:'',quote:'',path:[]},pdfPage:first.page,textAnchor:{...anchor},points:[{x:first.x,y:first.y}],text:text.trim()})]);}
    else r.commit([...r.metadata.annotations,r.annotation(type,{textAnchor:{...anchor},pdfRects:rects,pdfPage:rects[0].page})]);
    this.doc.getSelection()?.removeAllRanges();r.selection=null;return true;
  }
  renderTextMarks(){
    if(this.disposed)return;
    for(const slot of this.slots.values()){
      slot.marks?.remove();const layer=svg(this.doc,'svg',{class:'htmlmemo-pdf-marks',viewBox:'0 0 '+this.size(slot.page).width+' '+this.size(slot.page).height,'data-htmlmemo-ui':''});slot.marks=layer;
      for(const a of this.reader.metadata.annotations){if(!TEXT_TOOLS.includes(a.type)||!a.pdfRects)continue;
        for(const rect of a.pdfRects){if(rect.page!==slot.page)continue;const width=this.size(slot.page).width,height=this.size(slot.page).height,x=rect.x*width,y=rect.y*height,w=rect.w*width,h=rect.h*height;
          const group=svg(this.doc,'g',{'data-htmlmemo-id':a.id,'data-htmlmemo-pdf-mark':''});
          if(a.type==='highlight')group.append(svg(this.doc,'rect',{x,y,width:w,height:h,fill:a.color,opacity:a.opacity,'pointer-events':'all'}));
          else{const lineY=a.type==='strike'?y+h*.5:y+h;group.append(svg(this.doc,'path',{d:`M${x} ${lineY}h${w}`,fill:'none',stroke:a.color,'stroke-width':a.width,'pointer-events':'stroke'}));group.append(svg(this.doc,'path',{d:`M${x} ${lineY}h${w}`,fill:'none',stroke:'transparent','stroke-width':Math.max(a.width,12/(this.reader.zoom*this.scale)),'data-htmlmemo-hit':a.id,'pointer-events':'stroke'}));}
          layer.append(group);
        }
      }
      slot.inner.append(layer);
    }
  }
  dragText(drag,event){
    const caret=this.doc.caretPositionFromPoint?.(event.clientX,event.clientY),hit=caret?null:this.doc.caretRangeFromPoint?.(event.clientX,event.clientY),node=caret?.offsetNode||hit?.startContainer,offset=caret?.offset??hit?.startOffset;
    if(node?.nodeType!==3||!node.parentElement.closest('.textLayer'))return null;
    const index=this.reader.searchCache().get(),entry=index.nodes.find(item=>item.node===node);if(!entry)return null;
    const start=entry.start+offset,end=Math.min(start+drag.annotation.textAnchor.quote.length,index.text.length),range=rangeFromOffsets(this.doc,start,end,index);if(!range)return null;
    const rects=this.captureRects(range);if(!rects.length)return null;return {...drag.annotation,textAnchor:selectionAnchor(this.doc,range,index),pdfPage:rects[0].page,pdfRects:rects};
  }
  previewText(a,layer){const origin=this.reader.layerOrigin();for(const b of a.pdfRects||[]){const box=this.slots.get(b.page)?.node.getBoundingClientRect();if(!box)continue;const x=box.left-origin.left+b.x*box.width,y=box.top-origin.top+b.y*box.height,w=b.w*box.width,h=b.h*box.height;layer.append(a.type==='highlight'?svg(this.doc,'rect',{x,y,width:w,height:h,fill:a.color,opacity:a.opacity}):svg(this.doc,'path',{d:`M${x} ${y+(a.type==='strike'?h/2:h)}h${w}`,stroke:a.color,'stroke-width':a.width,fill:'none'}));}}
  bookmarkLocation(){
    const pdfPosition=this.position(),slot=this.slots.get(pdfPosition.page),index=slot?.text?textIndex(this.doc,slot.text):null;
    if(!index?.nodes.length)return {pdfPosition};
    const line=index.nodes.find(item=>item.node.parentElement.getBoundingClientRect().bottom>=8)||index.nodes.at(-1),quote=index.text.slice(line.start,Math.min(index.text.length,line.start+120)),rect=line.node.parentElement.getBoundingClientRect(),pageBox=slot.node.getBoundingClientRect();
    return {pdfPosition,textAnchor:{start:line.start,end:line.start+quote.length,quote,prefix:index.text.slice(Math.max(0,line.start-40),line.start),suffix:index.text.slice(line.start+quote.length,line.start+quote.length+40)},textPoint:0,pdfQuoteOffset:pdfPosition.y-(rect.top-pageBox.top)/pageBox.height};
  }
  async migrate({annotations=[],bookmarks=[],onProgress=()=>{}}){
    const result={annotations:[],bookmarks:[],oldSections:new Map(),report:{same:0,changed:0,deleted:[],unplaceable:[],unchecked:[]},bookmarkReport:{same:0,changed:0,approximate:0,deleted:[],unplaceable:[],unchecked:[]}},signal=new AbortController().signal;
    const work=[...annotations.map(item=>({item,field:'annotations',report:result.report})),...bookmarks.map(item=>({item,field:'bookmarks',report:result.bookmarkReport}))];let done=0;
    for(const {item,field,report}of work){
      if(this.disposed)throw new DOMException('새 판 확인이 취소되었습니다.','AbortError');
      const anchor=item.textAnchor||{quote:item.anchorTarget?.quote||''},quote=anchor.quote?.trim();
      if(!quote){report.unplaceable.push(item);onProgress(++done,work.length,'search');continue;}
      let progress;await this.searchEngine.run(quote,1,signal,p=>{progress=p;},{limit:2000,deferGeometry:true});
      const candidates=progress?.matches||[];let found=candidates.length===1?candidates[0]:null;
      if(!found&&candidates.length>1&&!progress?.limited){
        const suffix=(a,b)=>{let n=0;while(n<a.length&&n<b.length&&a[a.length-1-n]===b[b.length-1-n])n++;return n;},prefix=(a,b)=>{let n=0;while(n<a.length&&n<b.length&&a[n]===b[n])n++;return n;};
        const ranked=candidates.map(match=>({match,score:suffix(match.before,anchor.prefix||'')+prefix(match.after,anchor.suffix||'')})).sort((a,b)=>b.score-a.score);if(ranked[0].score>0&&ranked[0].score>ranked[1].score)found=ranked[0].match;
      }
      if(!found){report.unplaceable.push(item);onProgress(++done,work.length,'search');continue;}
      const [located]=await this.searchEngine.locate([found],signal),rects=located?.rects;if(!rects?.length){report.unplaceable.push(item);onProgress(++done,work.length,'search');continue;}
      const next=structuredClone(item);delete next.section;delete next.heading;delete next.editionPosition;
      if(field==='bookmarks'){next.pdfPosition={page:found.page,y:clamp(rects[0].y+(item.pdfQuoteOffset||0),0,1)};next.top=this.tops[found.page-1]+this.size(found.page).height*next.pdfPosition.y;next.left=0;}
      else if(TEXT_TOOLS.includes(next.type)){next.pdfRects=rects.map(rect=>({...rect,page:found.page}));next.pdfPage=found.page;next.textAnchor={start:found.start,end:found.end,quote:found.text,prefix:found.before.slice(-40),suffix:found.after.slice(0,40)};}
      else{next.anchor='n'+found.page;next.pdfPage=found.page;next.anchorTarget={tag:'section',id:'pdf-page-'+found.page,rootId:'',section:'',quote:'',path:[]};delete next.penBasis;}
      result[field].push(next);report.same++;onProgress(++done,work.length,'search');
    }
    return result;
  }
  async jumpAnnotation(a){const page=a.pdfPage||a.pdfRects?.[0]?.page||Number(/^n(\d+)$/.exec(a.anchor||'')?.[1]);if(!page)return false;const y=a.pdfRects?.[0]?.y??a.points?.[0]?.y??0;await this.go(page,Math.max(0,y-.25));this.reader.selectedId=a.id;return true;}
  path(page){const stack=[];for(const item of this.entries){if(item.page>page)continue;while(stack.length&&stack.at(-1).level>=item.level)stack.pop();stack.push({id:item.node.id||'pdf-page-'+item.page,title:item.title,level:item.level,order:item.page,kind:'heading'});}if(stack.at(-1)?.title!==page+'쪽')stack.push({id:'pdf-page-'+page,title:page+'쪽',order:page,kind:'section'});return stack;}
  annotationPage(a){return a.pdfPage||a.pdfRects?.[0]?.page||Number(/^n(\d+)$/.exec(a.anchor||'')?.[1])||1;}
  tree(field){const r=this.reader;return r.locationTree(r.metadata[field],field,item=>this.path(field==='bookmarks'?item.pdfPosition?.page||1:this.annotationPage(item)));}
  contexts(){return new Map(this.reader.metadata.annotations.map(a=>{const path=this.path(this.annotationPage(a));return [a.id,{quote:a.textAnchor?.quote||'',heading:path.map(p=>p.title).join(' › '),path}];}));}
  async search(query,move,isCurrent){
    this.searchAbort?.abort();this.searchAbort=new AbortController();const signal=this.searchAbort.signal,r=this.reader;const generation=++this.searchGeneration;r.searchQuery=query;r.searchPosition=-1;r.searchResults=[];this.clearSearch();
    if(!query.trim()){r.callbacks.onSearchChange?.(r);return [];}
    const matches=[];
    for(const slot of [...this.slots.values()].sort((a,b)=>a.page-b.page)){await slot.ready;if(this.disposed||signal.aborted||!isCurrent())return null;if(slot.content)matches.push(...findPdfPageMatches(indexPdfSearchPage(slot.content,slot.viewport),query,slot.page,2000-matches.length));if(matches.length>=2000)break;}
    if(this.disposed||signal.aborted||generation!==this.searchGeneration||!isCurrent())return null;
    r.searchResults=matches.map(match=>({...match,quote:match.page+'쪽 · '+match.before+match.text+match.after}));
    if(move&&r.searchResults.length)await this.nextSearch(1);else r.callbacks.onSearchChange?.(r);return r.searchResults;
  }
  clearSearch(){for(const node of this.doc.querySelectorAll('[data-htmlmemo-pdf-search]'))node.remove();}
  async searchWhole(query,isCurrent,onProgress=()=>{}){
    this.wholeAbort?.abort();this.wholeAbort=new AbortController();const signal=this.wholeAbort.signal;let progress;
    if(!query.trim())return [];
    await this.searchEngine.run(query,this.pageAt(),signal,value=>{progress=value;if(isCurrent())onProgress(value);},{deferGeometry:true});
    if(this.disposed||signal.aborted||!isCurrent())return null;
    if(progress?.errors)this.reader.callbacks.onNotice?.(progress.errors+'쪽의 글자를 읽지 못했습니다.');
    if(progress?.limited)this.reader.callbacks.onNotice?.('검색 결과가 2,000개를 넘었습니다. 검색어를 더 구체적으로 입력하세요.');
    return (progress?.matches||[]).map(match=>({...match,quote:match.page+'쪽 · '+match.before+match.text+match.after}));
  }
  async jumpWhole(match){
    const signal=this.wholeAbort?.signal||new AbortController().signal,generation=this.wholeAbort;await this.go(match.page);if(this.disposed||signal.aborted||generation!==this.wholeAbort)return false;
    const [located]=await this.searchEngine.locate([match],signal);if(this.disposed||signal.aborted||generation!==this.wholeAbort)return false;
    for(const old of this.doc.querySelectorAll('[data-htmlmemo-pdf-book-search]'))old.remove();
    const slot=this.slots.get(match.page),size=this.size(match.page),layer=svg(this.doc,'svg',{class:'htmlmemo-pdf-marks',viewBox:'0 0 '+size.width+' '+size.height,'data-htmlmemo-ui':'','data-htmlmemo-pdf-book-search':''});
    for(const b of located?.rects||[])layer.append(svg(this.doc,'rect',{x:b.x*size.width,y:b.y*size.height,width:b.w*size.width,height:b.h*size.height,fill:'#f0a85b80',stroke:'#df9057','stroke-width':1,'pointer-events':'none'}));slot.inner.append(layer);if(located?.rects?.length)this.seek(match.page,Math.max(0,located.rects[0].y-.3));return true;
  }
  async nextSearch(direction){
    const r=this.reader;if(!r.searchResults.length)return false;const position=clamp(r.searchPosition+direction,0,r.searchResults.length-1);if(position===r.searchPosition)return false;r.searchPosition=position;r.callbacks.onSearchChange?.(r);
    const match=r.searchResults[position],generation=this.searchGeneration;await this.go(match.page,0);if(this.disposed||generation!==this.searchGeneration||r.searchPosition!==position)return false;
    const located=await this.searchEngine.locate([match],this.searchAbort.signal);if(this.disposed||generation!==this.searchGeneration||r.searchPosition!==position)return false;const rects=located[0]?.rects||[];this.clearSearch();const slot=this.slots.get(match.page),size=this.size(match.page);
    const layer=svg(this.doc,'svg',{class:'htmlmemo-pdf-marks',viewBox:'0 0 '+size.width+' '+size.height,'data-htmlmemo-ui':'','data-htmlmemo-pdf-search':''});for(const b of rects)layer.append(svg(this.doc,'rect',{x:b.x*size.width,y:b.y*size.height,width:b.w*size.width,height:b.h*size.height,fill:'#f0a85b80',stroke:'#df9057','stroke-width':1,'pointer-events':'none'}));slot.inner.append(layer);if(rects.length)this.seek(match.page,Math.max(0,rects[0].y-.3));return true;
  }
  setSpeechRoot(page){const slot=this.slots.get(page);if(!slot?.text)return;this.speechRoot?.removeAttribute('data-tts-root');this.speechRoot=slot.text;this.speechRoot.setAttribute('data-tts-root','');}
  async prepareSpeech(){const page=this.pageAt();await this.ensure(page);this.setSpeechRoot(page);return !!this.speechRoot?.textContent.trim();}
  async nextSpeechPage(isCurrent=()=>true){let page=Number(this.speechRoot?.closest('[data-pdf-page]')?.dataset.pdfPage)||this.pageAt();while(page<this.count&&!this.disposed&&isCurrent()){page++;await this.ensure(page);if(!isCurrent()||this.disposed)return false;await this.go(page);this.setSpeechRoot(page);if(this.speechRoot?.textContent.trim())return true;}return false;}
  exportHTML(metadata){return exportPDFHTML(this.source,metadata);}
  dispose(){this.disposed=true;this.jumpVersion++;this.searchGeneration++;this.searchAbort?.abort();this.wholeAbort?.abort();this.searchEngine?.clear();this.doc.defaultView.cancelAnimationFrame(this.frame);this.doc.defaultView.removeEventListener('scroll',this.onScroll);this.reader.viewport.removeEventListener('scroll',this.onScroll);for(const slot of this.slots.values()){slot.controller.abort();slot.textLayer?.cancel();slot.image.dispose();}this.slots.clear();void this.loading?.destroy().catch(()=>{});}
}

const PDF_STYLE=`
html,body{margin:0;padding:0;min-height:100%;background:var(--htmlmemo-reader-panel,#f6f8fa);color:var(--htmlmemo-reader-ink,#1f2328);font:16px system-ui;overflow-anchor:none!important}
#htmlmemo-pdf-pages{position:relative;margin:0;padding:0;overflow:hidden}
.htmlmemo-pdf-page{position:absolute;left:0;margin:0;padding:0;background:white;contain:layout style;overflow:hidden;box-shadow:0 1px 3px #0002}
.htmlmemo-pdf-page-inner{position:relative;transform-origin:0 0}
.htmlmemo-pdf-link{position:absolute;z-index:4;background:transparent;cursor:pointer}.htmlmemo-pdf-link:hover{background:#6f9eff18}.htmlmemo-pdf-link:focus-visible{outline:2px solid #557bba}
.htmlmemo-pdf-marks{position:absolute;inset:0;width:100%;height:100%;z-index:3;pointer-events:none;overflow:visible}
html[data-htmlmemo-picking] [data-htmlmemo-pdf-mark]{cursor:pointer!important}html:not([data-htmlmemo-picking]) [data-htmlmemo-pdf-mark],html:not([data-htmlmemo-picking]) [data-htmlmemo-pdf-mark] *{pointer-events:none!important}
.textLayer{position:absolute;inset:0;text-align:initial;line-height:1;text-size-adjust:none;forced-color-adjust:none;transform-origin:0 0;caret-color:CanvasText;z-index:2;--min-font-size:1;--text-scale-factor:calc(var(--total-scale-factor) * var(--min-font-size));--min-font-size-inv:calc(1 / var(--min-font-size))}
.textLayer :is(span,br){color:transparent;position:absolute;white-space:pre;cursor:text;transform-origin:0 0}
.textLayer> :not(.markedContent),.textLayer .markedContent span:not(.markedContent){z-index:1;--font-height:0;--scale-x:1;--rotate:0deg;font-size:calc(var(--text-scale-factor) * var(--font-height));transform:rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv))}
.textLayer .markedContent{display:contents}.textLayer span[role=img]{user-select:none;cursor:default}
.textLayer ::selection{background:#6e9fe877}.textLayer br::selection{background:transparent}
`;
