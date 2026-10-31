import {validateAnnotations,TEXT_TOOLS,validPDFPosition} from './model.js';
const CSS_SCALE=4/3;
const encodeImage=canvas=>new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?blob.arrayBuffer().then(bytes=>resolve(new Uint8Array(bytes)),reject):reject(Error('메모 그림을 만들지 못했습니다.')),'image/png'));
async function textImage(a,doc){
  const lines=a.text.split('\n').flatMap(line=>{const result=[];for(let n=0;n<Math.max(line.length,1);n+=24)result.push(line.slice(n,n+24));return result;}),note=a.type==='note',font=note?14:18,pad=note?12:0;
  const canvas=doc.createElement('canvas'),ctx=canvas.getContext('2d');if(!ctx)throw Error('메모 그림을 만들 수 없습니다. 원본 포함 보관 파일을 사용해주세요.');ctx.font=font+'px system-ui,sans-serif';
  const width=Math.ceil(Math.max(note?130:1,...lines.map(t=>ctx.measureText(t).width+pad*2))+4),height=lines.length*22+(note?24:2);
  if(width*height>8*1024*1024)throw Error('메모가 너무 커서 PDF로 바꿀 수 없습니다. 원본 포함 보관 파일을 사용해주세요.');
  canvas.width=width*2;canvas.height=height*2;ctx.scale(2,2);ctx.font=font+'px system-ui,sans-serif';
  if(note){ctx.fillStyle='#fff9df';ctx.fillRect(1,1,width-2,height-2);ctx.strokeStyle=a.color;ctx.lineWidth=1.5;ctx.strokeRect(1,1,width-2,height-2);}
  ctx.fillStyle=note?'#544a30':a.color;lines.forEach((line,n)=>ctx.fillText(line,pad,(note?25:16)+n*22));
  return {png:await encodeImage(canvas),width,height};
}
export async function pdfExportPlan(reader,{signal,onProgress=()=>{}}={}){
  const annotations=validateAnnotations(reader.metadata.annotations),items=[],pages=new Map();
  const viewport=async number=>{if(!pages.has(number)){const p=await reader.pdf.pdf.getPage(number);pages.set(number,p.getViewport({scale:1}));}return pages.get(number);};
  const check=()=>{if(signal?.aborted)throw new DOMException('내보내기를 취소했습니다.','AbortError');};
  for(let index=0;index<annotations.length;index++){
    check();const a=annotations[index];
    if(TEXT_TOOLS.includes(a.type)){
      if(!a.pdfRects?.length)throw Error('PDF 쪽을 확인할 수 없는 글자 주석이 있습니다. 원본 포함 보관 파일을 사용해주세요.');
      for(const box of a.pdfRects){const v=await viewport(box.page),point=(x,y)=>v.convertToPdfPoint(x*v.width,y*v.height);items.push({id:a.id,page:box.page,type:a.type,color:a.color,opacity:a.opacity,width:a.width/CSS_SCALE,contents:a.textAnchor.quote,quad:[...point(box.x,box.y),...point(box.x+box.w,box.y),...point(box.x,box.y+box.h),...point(box.x+box.w,box.y+box.h)]});}
    }else{
      const number=a.pdfPage||Number(/^n(\d+)$/.exec(a.anchor||'')?.[1]);
      if(!Number.isInteger(number)||number<1||number>reader.pdf.count||!a.anchor||a.points.some(p=>p.x<0||p.x>1||p.y<0||p.y>1))throw Error('쪽 밖에 걸친 그림 또는 위치를 확인하지 못한 주석이 있습니다. 원본 포함 보관 파일은 이 주석도 그대로 보존합니다.');
      const v=await viewport(number),point=(x,y)=>v.convertToPdfPoint(x*v.width,y*v.height),points=a.points.map(p=>point(p.x,p.y));
      const item={id:a.id,page:number,type:a.type,color:a.color,opacity:a.opacity,width:a.width/(a.type==='pen'&&a.penBasis?.width?a.penBasis.width/v.width:CSS_SCALE*reader.pdf.scale),fill:a.fill===true,fillOpacity:a.fillOpacity??0,points,contents:a.text||''};
      if(['note','text'].includes(a.type)){
        const image=await textImage(a,reader.doc),p=a.points[0],scale=CSS_SCALE*reader.pdf.scale;
        Object.assign(item,{png:image.png,imageQuad:[point(p.x,p.y),point(p.x+image.width/(v.width*scale),p.y),point(p.x,p.y+image.height/(v.height*scale))]});
      }
      items.push(item);
    }
    onProgress({done:index+1,total:annotations.length});
  }
  const bookmarks=[];
  for(const b of reader.metadata.bookmarks){
    check();if(!validPDFPosition(b.pdfPosition))throw Error('PDF 쪽을 확인할 수 없는 북마크가 있습니다. 원본 포함 보관 파일을 사용해주세요.');
    const v=await viewport(b.pdfPosition.page),[x,y]=v.convertToPdfPoint(0,b.pdfPosition.y*v.height);bookmarks.push({title:b.title,page:b.pdfPosition.page,x,y});
  }
  return {title:reader.metadata.title,annotations:items,bookmarks};
}
