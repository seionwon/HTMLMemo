// PDF writing is a separate lazy worker, not part of startup or the PDF reader.
import {PDFDocument,PDFName,PDFString,PDFHexString,PDFNumber,PDFArray,PDFDict,PDFRef,PDFSignature} from 'pdf-lib';
const N=PDFName.of,H=PDFHexString.fromText;
const n=x=>{if(!Number.isFinite(x)||Math.abs(x)>1e9)throw Error('PDF 주석 좌표가 올바르지 않습니다.');return Number(x.toFixed(5));};
const rgb=hex=>[1,3,5].map(offset=>parseInt(hex.slice(offset,offset+2),16)/255);
const values=points=>points.flatMap(p=>[n(p[0]),n(p[1])]);
const bounds=(points,pad=0)=>{let x=Infinity,y=Infinity,right=-Infinity,top=-Infinity;for(const p of points){x=Math.min(x,p[0]);y=Math.min(y,p[1]);right=Math.max(right,p[0]);top=Math.max(top,p[1]);}return [x-pad,y-pad,right+pad,top+pad].map(n);};
function inertActions(doc){
  const stack=[doc.catalog],seen=new Set();
  while(stack.length){let value=stack.pop();if(value instanceof PDFRef)value=doc.context.lookup(value);if(!value||seen.has(value))continue;seen.add(value);
    if(value instanceof PDFArray){for(const child of value.asArray())stack.push(child);continue;}
    const dict=value instanceof PDFDict?value:value.dict instanceof PDFDict?value.dict:null;if(!dict)continue;
    dict.delete(N('AA'));dict.delete(N('JavaScript'));
    const type=dict.get(N('S'))?.decodeText?.(),uri=dict.get(N('URI'))?.decodeText?.();
    if(['JavaScript','Launch','SubmitForm','ImportData','GoToR','GoToE'].includes(type)||(type==='URI'&&!/^(https?:|mailto:)/i.test(uri||''))){for(const key of ['JS','F','URI','Next','D'])dict.delete(N(key));dict.set(N('S'),N('Named'));dict.set(N('N'),N('None'));}
    for(const [,child] of dict.entries())stack.push(child);
  }
}
function shape(a){
  const p=a.points,first=p[0],last=p.at(-1),move=p=>`${n(p[0])} ${n(p[1])} m`,line=p=>`${n(p[0])} ${n(p[1])} l`;
  if(a.type==='pen')return move(first)+' '+p.slice(1).map(line).join(' ')+' S';
  if(a.type==='arrow'||a.type==='area-underline'){
    let path=move(first)+' '+line(last);
    if(a.type==='arrow'){const angle=Math.atan2(last[1]-first[1],last[0]-first[0]),length=Math.max(8,a.width*4);path+=' '+move([last[0]-length*Math.cos(angle-.5),last[1]-length*Math.sin(angle-.5)])+' '+line(last)+' '+line([last[0]-length*Math.cos(angle+.5),last[1]-length*Math.sin(angle+.5)]);}
    return path+' S';
  }
  const [x,y,right,top]=bounds(p),w=right-x,h=top-y;
  if(['circle','ellipse'].includes(a.type)){
    let rx=w/2,ry=h/2;if(a.type==='circle')rx=ry=Math.min(rx,ry);
    const cx=(x+right)/2,cy=(y+top)/2,k=.552284749831;
    return `${n(cx+rx)} ${n(cy)} m ${n(cx+rx)} ${n(cy+ry*k)} ${n(cx+rx*k)} ${n(cy+ry)} ${n(cx)} ${n(cy+ry)} c ${n(cx-rx*k)} ${n(cy+ry)} ${n(cx-rx)} ${n(cy+ry*k)} ${n(cx-rx)} ${n(cy)} c ${n(cx-rx)} ${n(cy-ry*k)} ${n(cx-rx*k)} ${n(cy-ry)} ${n(cx)} ${n(cy-ry)} c ${n(cx+rx*k)} ${n(cy-ry)} ${n(cx+rx)} ${n(cy-ry*k)} ${n(cx+rx)} ${n(cy)} c h ${a.fill?'B':'S'}`;
  }
  return `${x} ${y} ${n(w)} ${n(h)} re ${a.type==='area'?'f':a.fill?'B':'S'}`;
}
function appendOutlines(doc,bookmarks,pages){
  if(!bookmarks.length)return;
  const ctx=doc.context,old=doc.catalog.lookupMaybe(N('Outlines'),PDFDict),root=old||ctx.obj({Type:'Outlines'}),rootRef=old?(doc.catalog.get(N('Outlines')) instanceof PDFRef?doc.catalog.get(N('Outlines')):ctx.register(root)):ctx.register(root);
  const group=ctx.obj({Title:H('LibreMemo 북마크'),Parent:rootRef,Count:-bookmarks.length}),groupRef=ctx.register(group),children=bookmarks.map(b=>ctx.obj({Title:H(String(b.title).slice(0,10000)),Parent:groupRef,Dest:[pages[b.page-1].ref,N('XYZ'),n(b.x),n(b.y),null]})),refs=children.map(c=>ctx.register(c));
  children.forEach((child,i)=>{if(i)child.set(N('Prev'),refs[i-1]);if(i+1<refs.length)child.set(N('Next'),refs[i+1]);});group.set(N('First'),refs[0]);group.set(N('Last'),refs.at(-1));
  const last=root.lookupMaybe(N('Last'),PDFDict),lastRef=root.get(N('Last'));
  if(last&&lastRef){last.set(N('Next'),groupRef);group.set(N('Prev'),lastRef);}else root.set(N('First'),groupRef);
  root.set(N('Last'),groupRef);const count=root.lookupMaybe(N('Count'),PDFNumber)?.asNumber()||0;root.set(N('Count'),PDFNumber.of(count<0?count-1:count+1));doc.catalog.set(N('Outlines'),rootRef);
}
export async function writeAnnotatedPDF(source,plan,{onProgress=()=>{}}={}){
  const bytes=source instanceof Uint8Array?source:new Uint8Array(source);
  const doc=await PDFDocument.load(bytes,{updateMetadata:false,throwOnInvalidObject:true});
  if(doc.isEncrypted)throw Error('암호가 설정된 PDF는 내보낼 수 없습니다.');
  if(doc.getForm().getFields().some(field=>field instanceof PDFSignature))throw Error('전자서명이 있는 PDF는 원본 포함 보관 파일로 저장해주세요. 서명된 원본을 변경하지 않습니다.');
  inertActions(doc);
  const pages=doc.getPages(),ctx=doc.context;
  if(plan.annotations.length>200000||plan.bookmarks.length>10000)throw Error('PDF 주석 수가 너무 많습니다.');
  let done=0;
  for(const a of plan.annotations){
    const page=pages[a.page-1];if(!page||!/^#[\da-f]{6}$/i.test(a.color))throw Error('PDF 주석의 쪽 또는 색상이 올바르지 않습니다.');
    const color=rgb(a.color),width=Math.max(.05,n(a.width)),opacity=Math.max(0,Math.min(1,a.opacity)),resources={ExtGState:{GS:ctx.obj({Type:'ExtGState',CA:opacity,ca:a.type==='area'||a.type==='highlight'?opacity:opacity*(a.fill?a.fillOpacity:1),...(a.type==='highlight'?{BM:'Multiply'}:{})})}},base={Type:'Annot',P:page.ref,F:4,C:color,T:H('LibreMemo'),Contents:H(String(a.contents||'')),NM:PDFString.of('LibreMemo-'+a.id+'-'+done),M:PDFString.fromDate(new Date()),BS:{Type:'Border',W:width,S:'S'},CA:opacity};
    let rect,body,subtype;
    if(a.quad){
      const q=[];for(let i=0;i<a.quad.length;i+=2)q.push([a.quad[i],a.quad[i+1]]);rect=bounds(q,width);subtype={highlight:'Highlight',underline:'Underline',strike:'StrikeOut'}[a.type];if(!subtype)throw Error('지원하지 않는 PDF 글자 주석입니다.');base.QuadPoints=a.quad.map(n);
      const p=a.type==='underline'?[q[2],q[3]]:a.type==='strike'?[[ (q[0][0]+q[2][0])/2,(q[0][1]+q[2][1])/2],[(q[1][0]+q[3][0])/2,(q[1][1]+q[3][1])/2]]:null;
      body=p?`${values([p[0]]).join(' ')} m ${values([p[1]]).join(' ')} l S`:`${values([q[0]]).join(' ')} m ${values([q[1]]).join(' ')} l ${values([q[3]]).join(' ')} l ${values([q[2]]).join(' ')} l h f`;
    }else if(a.png){
      const [tl,tr,bl]=a.imageQuad,br=[tr[0]+bl[0]-tl[0],tr[1]+bl[1]-tl[1]];rect=bounds([tl,tr,bl,br],1);subtype='FreeText';base.DA=PDFString.of('/Helv 14 Tf 0 g');base.RC=undefined;
      const image=await doc.embedPng(a.png);resources.XObject={Text:image.ref};resources.Font={Helv:ctx.obj({Type:'Font',Subtype:'Type1',BaseFont:'Helvetica'})};
      body=`q ${[tr[0]-tl[0],tr[1]-tl[1],tl[0]-bl[0],tl[1]-bl[1],bl[0],bl[1]].map(n).join(' ')} cm /Text Do Q`;
    }else{
      if(!a.points?.length)throw Error('PDF 그림 주석의 위치가 없습니다.');rect=bounds(a.points,Math.max(width*2,a.type==='arrow'?Math.max(8,width*4):1));subtype={pen:'Ink',rect:'Square',area:'Square',circle:'Circle',ellipse:'Circle',arrow:'Line','area-underline':'Line'}[a.type];if(!subtype)throw Error('지원하지 않는 PDF 그림 주석입니다.');
      if(subtype==='Ink')base.InkList=[values(a.points)];
      if(subtype==='Line'){base.L=values([a.points[0],a.points.at(-1)]);base.LE=[N('None'),N(a.type==='arrow'?'OpenArrow':'None')];}
      if(a.fill||a.type==='area')base.IC=color;
      body=shape(a);
    }
    // Explicit appearances make Korean notes, opacity and all drawing types visible
    // even in viewers which do not synthesize an appearance from annotation fields.
    const stream=ctx.flateStream(`q /GS gs ${color.map(n).join(' ')} RG ${color.map(n).join(' ')} rg ${width} w 1 J 1 j ${body} Q`,{Type:'XObject',Subtype:'Form',FormType:1,BBox:rect,Resources:resources});
    const annotation=ctx.obj({...base,Subtype:subtype,Rect:rect,AP:{N:ctx.register(stream)}}),ref=ctx.register(annotation);
    let annots=page.node.lookupMaybe(N('Annots'),PDFArray);if(!annots){annots=ctx.obj([]);page.node.set(N('Annots'),annots);}annots.push(ref);onProgress({done:++done,total:plan.annotations.length});
  }
  if(plan.bookmarks.some(b=>!pages[b.page-1]))throw Error('PDF 북마크의 쪽이 올바르지 않습니다.');
  appendOutlines(doc,plan.bookmarks,pages);doc.setModificationDate(new Date());
  return doc.save({useObjectStreams:true,addDefaultPage:false});
}
