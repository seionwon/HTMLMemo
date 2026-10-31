import {buildRenderSlide,HeuristicMetrics} from '../vendor/office/genoffice.js';
import {esc,number,color,font,imageSource,safeLink} from './office-common.js';
const n=number;
class BrowserMetrics extends HeuristicMetrics {
  constructor(){super();try{this.context=new OffscreenCanvas(1,1).getContext('2d');}catch{/* Node checks use deterministic upstream metrics. */}}
  measure(text,style){if(!this.context)return super.measure(text,style);this.context.font=(style.italic?'italic ':'')+(style.bold?'700 ':'400 ')+style.fontSizePx+'px '+font(style.fontFamily);this.context.fontKerning=style.kerning===false?'none':'normal';return this.context.measureText(text).width;}
}
function dataURL(bytes,type){let binary='';for(let i=0;i<bytes.length;i+=16384)binary+=String.fromCharCode(...bytes.subarray(i,i+16384));return 'data:'+type+';base64,'+btoa(binary);}
const mimes={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',svg:'image/svg+xml',bmp:'image/bmp'};
function mediaResolver(archive){const cache=new Map();return path=>{
  if(cache.has(path))return cache.get(path);const type=mimes[String(path).split('.').at(-1).toLowerCase()],bytes=archive.readBytes(path);
  const result=type&&bytes?dataURL(bytes,type):undefined;cache.set(path,result);return result;
};}
function paintFactory(prefix){let next=0;const definitions=[];
  const fill=value=>{
    if(!value||value.kind==='none')return 'none';
    if(value.kind==='solid')return color(value.color,'none');
    if(value.kind==='pattern')return color(value.bg,'white');
    if(value.kind==='gradient'){
      const id=prefix+'-fill-'+(++next),radial=!!value.radial,tag=radial?'radialGradient':'linearGradient';
      const attrs=radial?'cx="'+n(value.center?.x,.5)+'" cy="'+n(value.center?.y,.5)+'" r=".75"':'x1="0" y1="0" x2="1" y2="0" gradientTransform="rotate('+n(value.angleDeg)+' .5 .5)"';
      definitions.push('<'+tag+' id="'+id+'" '+attrs+'>'+value.stops.map(s=>'<stop offset="'+Math.max(0,Math.min(1,n(s.pos)))+'" stop-color="'+esc(color(s.color,'white'))+'"/>').join('')+'</'+tag+'>');return 'url(#'+id+')';
    }
    const src=imageSource(value.dataUrl);if(src){const id=prefix+'-fill-'+(++next);definitions.push('<pattern id="'+id+'" width="1" height="1" patternContentUnits="objectBoundingBox"><image href="'+esc(src)+'" width="1" height="1" preserveAspectRatio="none"/></pattern>');return 'url(#'+id+')';}
    return 'none';
  };
  return {fill,definitions};
}
const stroke=s=>s?'stroke="'+esc(color(s.color,'#777'))+'" stroke-width="'+Math.max(0,n(s.widthPx,1))+'"'+(s.dash?.length?' stroke-dasharray="'+s.dash.map(n).join(' ')+'"':''): 'stroke="none"';
function textLayout(layout){
  if(!layout)return '';
  return layout.lines.map(line=>line.runs.map(run=>{
    if(run.image){const src=imageSource(run.image);return src?'<image href="'+esc(src)+'" x="'+n(run.x)+'" y="'+n(run.baselineY-run.ascentPx)+'" width="'+n(run.widthPx)+'" height="'+n(run.ascentPx)+'"/>':'';}
    const rotation=run.rotate90?90:run.rotate270?-90:0;
    const size=Math.max(1,n(run.fontSizePx,16)),ascent=n(run.ascentPx,size*.8),top=n(run.baselineY)-ascent;
    const style='font-family:'+font(run.fontFamily)+';font-size:'+size+'px;line-height:1;white-space:pre;color:'+color(run.color,'#202633')+';font-weight:'+(run.bold?'700':'400')+';font-style:'+(run.italic?'italic':'normal')+(run.underline||run.strike?';text-decoration:'+([run.underline?'underline':'',run.strike?'line-through':''].filter(Boolean).join(' ')):'')+(run.rtl?';direction:rtl;unicode-bidi:plaintext':'');
    let text='<foreignObject x="'+n(run.x)+'" y="'+top+'" width="'+Math.max(size,n(run.widthPx)+size)+'" height="'+size*1.5+'" overflow="visible"'+(rotation?' transform="rotate('+rotation+' '+n(run.x)+' '+n(run.baselineY)+')"':'')+'><span xmlns="http://www.w3.org/1999/xhtml" data-office-text style="display:block;'+esc(style)+'">'+esc(run.text)+'</span></foreignObject>';
    const href=/^slide:\d+$/.test(run.link||'')?'#office-slide-'+run.link.slice(6):safeLink(run.link);
    if(href)text='<a href="'+esc(href)+'">'+text+'</a>';
    if(run.highlight)text='<rect x="'+n(run.x)+'" y="'+n(run.baselineY-run.fontSizePx*.85)+'" width="'+n(run.widthPx)+'" height="'+n(run.fontSizePx*1.15)+'" fill="'+esc(color(run.highlight,'transparent'))+'"/>'+text;
    return text;
  }).join('')).join('');
}
function chartHTML(chart,paint){
  const rect=r=>'<rect x="'+n(r.x)+'" y="'+n(r.y)+'" width="'+Math.max(0,n(r.w))+'" height="'+Math.max(0,n(r.h))+'" fill="'+esc(r.fill?paint.fill(r.fill):color(r.color,'none'))+'"/>';
  const lines=[...(chart.gridLines||[]),...(chart.axisLines||[])].map(l=>'<line x1="'+n(l.x1)+'" y1="'+n(l.y1)+'" x2="'+n(l.x2)+'" y2="'+n(l.y2)+'" '+stroke(l)+'/>').join('');
  const polylines=(chart.polylines||[]).map(l=>'<'+(l.closed?'polygon':'polyline')+' points="'+l.points.map(n).join(' ')+'" fill="'+esc(color(l.fill,'none'))+'" '+stroke(l)+'/>').join('');
  const paths=(chart.paths||[]).map(p=>'<path d="'+esc(p.d)+'" fill="'+esc(color(p.fill,'none'))+'"/>').join('');
  const wedges=(chart.wedges||[]).map(w=>{
    const point=(radius,angle)=>[n(w.cx)+radius*Math.cos(angle*Math.PI/180),n(w.cy)+radius*Math.sin(angle*Math.PI/180)];
    const start=n(w.startDeg)-90,sweep=Math.min(359.999,Math.max(.001,n(w.sweepDeg))),end=start+sweep,r=Math.max(0,n(w.outerR)),inner=Math.max(0,n(w.innerR));
    const a=point(r,start),b=point(r,end),c=point(inner,end),d=point(inner,start);
    const path='M '+a.join(' ')+' A '+r+' '+r+' 0 '+(sweep>180?1:0)+' 1 '+b.join(' ')+' L '+c.join(' ')+(inner?' A '+inner+' '+inner+' 0 '+(sweep>180?1:0)+' 0 '+d.join(' '):'')+' Z';
    return '<path d="'+path+'" fill="'+esc(color(w.color,'#667085'))+'"/>';
  }).join('');
  const labels=(chart.labels||[]).map(l=>'<text x="'+n(l.x)+'" y="'+n(l.y+n(l.fontSizePx,12))+'" font-size="'+n(l.fontSizePx,12)+'" font-family="'+esc(font(l.fontFamily))+'" fill="'+esc(color(l.color,'#202633'))+'"'+(l.bold?' font-weight="700"':'')+(l.rotationDeg?' transform="rotate('+n(l.rotationDeg)+' '+n(l.x)+' '+n(l.y)+')"':'')+'>'+esc(l.text)+'</text>').join('');
  return (chart.bgFill?rect({x:0,y:0,w:chart.box.w,h:chart.box.h,fill:chart.bgFill}):'')+(chart.plotRect?rect(chart.plotRect):'')+lines+(chart.bars||[]).map(rect).join('')+polylines+paths+wedges+(chart.markers||[]).map(m=>'<circle cx="'+n(m.x)+'" cy="'+n(m.y)+'" r="'+n(m.r)+'" fill="'+esc(color(m.color))+'"/>').join('')+(chart.swatches||[]).map(rect).join('')+labels;
}
function renderNode(node,paint,warnings,depth=0){
  if(depth>64)throw Error('슬라이드 개체가 너무 깊게 중첩되어 있습니다.');
  const b=node.box,w=Math.max(0,n(b.w)),h=Math.max(0,n(b.h));let body='';
  if(node.type==='group')body=node.children.map(c=>renderNode(c,paint,warnings,depth+1)).join('');
  else if(node.type==='picture'){
    const src=imageSource(node.dataUrl);if(src){
      const crop=node.srcRect||{},left=n(crop.l),top=n(crop.t),cw=Math.max(.001,1-left-n(crop.r)),ch=Math.max(.001,1-top-n(crop.b));
      body='<svg width="'+w+'" height="'+h+'" viewBox="0 0 '+w+' '+h+'" overflow="hidden"><image href="'+esc(src)+'" x="'+(-left*w/cw)+'" y="'+(-top*h/ch)+'" width="'+(w/cw)+'" height="'+(h/ch)+'" preserveAspectRatio="none" opacity="'+Math.max(0,Math.min(1,n(node.opacity,1)))+'"/></svg>';
    }else{warnings.add('일부 그림·미디어는 미리보기가 없어 표시하지 못했습니다.');body='<rect width="'+w+'" height="'+h+'" fill="#eef1f5"/><text x="8" y="20" font-size="14">'+esc(node.name||'그림')+'</text>';}
  }else if(node.type==='table')body=node.cells.map(c=>'<g transform="translate('+n(c.x)+' '+n(c.y)+')"><rect width="'+n(c.w)+'" height="'+n(c.h)+'" fill="'+esc(paint.fill(c.fill))+'"/>'+Object.entries(c.borders||{}).map(([side,s])=>{const p=side==='l'?[0,0,0,c.h]:side==='r'?[c.w,0,c.w,c.h]:side==='t'?[0,0,c.w,0]:[0,c.h,c.w,c.h];return '<line x1="'+n(p[0])+'" y1="'+n(p[1])+'" x2="'+n(p[2])+'" y2="'+n(p[3])+'" '+stroke(s)+'/>';}).join('')+textLayout(c.text)+'</g>').join('');
  else if(node.type==='chart')body=chartHTML(node,paint);
  else if(node.type==='placeholder-chip'){warnings.add('일부 슬라이드 개체는 원래 모양을 표시하지 못했습니다.');body='<text x="8" y="20" font-size="14">'+esc(node.label)+'</text>';}
  else{
    const style='fill="'+esc(paint.fill(node.fill))+'" '+stroke(node.stroke);
    if(node.line)body='<polyline points="'+node.line.points.map(n).join(' ')+'" fill="none" '+stroke(node.stroke||{widthPx:1,color:'#333'})+'/>';
    else if(node.pathData)body='<path d="'+esc(node.pathData)+'" '+style+'/>';
    else if(node.polygonPoints)body='<polygon points="'+node.polygonPoints.map(n).join(' ')+'" '+style+'/>';
    else if(node.presetGeometry==='ellipse')body='<ellipse cx="'+w/2+'" cy="'+h/2+'" rx="'+w/2+'" ry="'+h/2+'" '+style+'/>';
    else body='<rect width="'+w+'" height="'+h+'" rx="'+n(node.cornerRadiusPx)+'" '+style+'/>';
    if(node.fillPathData)body+='<path d="'+esc(node.fillPathData)+'" fill="'+esc(paint.fill(node.fill))+'"/>';
    if(node.strokePathData)body+='<path d="'+esc(node.strokePathData)+'" fill="none" '+stroke(node.stroke)+'/>';
    body+=textLayout(node.text);
  }
  const transform='translate('+n(b.x)+' '+n(b.y)+')'+(b.rotationDeg?' rotate('+n(b.rotationDeg)+' '+w/2+' '+h/2+')':'')+(b.flipH||b.flipV?' translate('+(b.flipH?w:0)+' '+(b.flipV?h:0)+') scale('+(b.flipH?-1:1)+' '+(b.flipV?-1:1)+')':'');
  return '<g transform="'+transform+'">'+body+'</g>';
}
export function renderSlides(opened,warnings){
  const media=mediaResolver(opened.archive),issues=new Set(),metrics=new BrowserMetrics();
  if(opened.deck.slides.length>2000)throw Error('슬라이드가 2,000장을 넘는 문서는 나누어 가져와 주세요.');
  const body=opened.deck.slides.map((slide,index)=>{
    const tree=buildRenderSlide(slide,opened.deck.size,{fitWidthPx:960,media,metrics,slideNo:index+1}),paint=paintFactory('office-slide-'+index);
    const bg=paint.fill(tree.background),content=tree.nodes.map(node=>renderNode(node,paint,issues)).join('');
    const title='슬라이드 '+(index+1);
    return '<section class="office-slide" id="office-slide-'+(index+1)+'" style="width:60em"><h2>'+esc(title)+'</h2><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '+tree.widthPx+' '+tree.heightPx+'" role="group" aria-label="'+esc(title)+'"><defs>'+paint.definitions.join('')+'</defs><rect width="100%" height="100%" fill="'+esc(bg==='none'?'white':bg)+'"/>'+content+'</svg></section>';
  }).join('');
  warnings.push(...issues);return '<article data-office-slides>'+body+'</article>';
}
