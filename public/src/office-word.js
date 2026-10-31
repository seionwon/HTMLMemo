import {computeListMarkers,ommlToMathML} from '../vendor/office/genoffice.js';
import {esc,number,color,font,imageSource,safeLink} from './office-common.js';
const highlight={yellow:'#ffff00',green:'#00ff00',cyan:'#00ffff',magenta:'#ff00ff',blue:'#0000ff',red:'#ff0000',darkYellow:'#808000',lightGray:'#d3d3d3'};
function runHTML(run){
  if(run.vanish||run.del)return '';
  const css=[];
  if(run.bold)css.push('font-weight:700');if(run.italic)css.push('font-style:italic');
  if(run.underline||run.strike)css.push('text-decoration:'+([run.underline?'underline':'',run.strike?'line-through':''].filter(Boolean).join(' ')));
  if(run.color)css.push('color:'+color(run.color));
  if(run.sizeHalfPoints)css.push('font-size:'+Math.max(.3,Math.min(12,number(run.sizeHalfPoints)/24))+'em');
  if(run.font)css.push('font-family:'+font(run.font));
  if(run.highlight||run.shading)css.push('background:'+color(highlight[run.highlight]||run.shading,'transparent'));
  if(run.rtl)css.push('direction:rtl;unicode-bidi:embed');
  let content=esc(run.text||'').replace(/\n/g,'<br>');
  if(run.math?.omml)content=ommlToMathML(run.math.omml)||content;
  if(run.ruby)content='<ruby>'+content+'<rt>'+esc(run.ruby.rt)+'</rt></ruby>';
  const image=imageSource(run.image?.dataUrl);if(image)content+='<img src="'+esc(image)+'" alt="" style="width:'+Math.max(.5,number(run.image.widthPx,100)/16)+'em">';
  if(run.noteRef){const id='office-'+run.noteRef.kind+'-'+run.noteRef.id;content='<sup><a href="#'+esc(id)+'">'+content+'</a></sup>';}
  if(run.vertAlign==='superscript')content='<sup>'+content+'</sup>';if(run.vertAlign==='subscript')content='<sub>'+content+'</sub>';
  const href=safeLink(run.link?.href);if(href)content='<a href="'+esc(href.startsWith('#')?'#office-bookmark-'+href.slice(1):href)+'">'+content+'</a>';
  return '<span'+(css.length?' style="'+esc(css.join(';'))+'"':'')+'>'+content+'</span>';
}
function paragraph(runs=[],format={},tag='p',attrs=''){
  const css=[];
  if(['left','right','center','justify'].includes(format.align))css.push('text-align:'+format.align);
  for(const [key,property] of [['spaceBefore','margin-top'],['spaceAfter','margin-bottom'],['indentLeft','margin-left'],['indentRight','margin-right'],['indentFirstLine','text-indent']])if(Number.isFinite(format[key]))css.push(property+':'+number(format[key])/240+'em');
  if(format.shadingFill)css.push('background:'+color(format.shadingFill,'transparent'));
  if(format.pageBreakBefore)css.push('break-before:page');
  if(format.bidi)css.push('direction:rtl');
  return '<'+tag+attrs+' style="'+esc(css.join(';'))+'">'+(runs.map(runHTML).join('')||'<br>')+'</'+tag+'>';
}
function tableHTML(table,depth=0){
  if(depth>16)throw Error('중첩된 표가 너무 많습니다.');
  const rows=table.rows||[];
  const cols=table.colWidthsPct?.map(w=>'<col style="width:'+Math.max(0,Math.min(100,number(w)))+'%">').join('')||'';
  return '<div class="office-table-scroll"><table style="width:100%"><colgroup>'+cols+'</colgroup><tbody>'+rows.map((row,ri)=>{
    let col=0;return '<tr>'+row.map(cell=>{
      const start=col,span=Math.max(1,Math.min(16384,number(cell.colSpan,1)));col+=span;
      if(cell.vMerge==='continue')return '';
      let rowSpan=1;if(cell.vMerge==='restart')for(let r=ri+1;r<rows.length;r++){let cc=0;const match=rows[r].find(c=>{const c0=cc;cc+=c.colSpan||1;return c0===start;});if(match?.vMerge!=='continue')break;rowSpan++;}
      const css=['background:'+color(cell.fill||table.fill,'transparent')];
      if(cell.color)css.push('color:'+color(cell.color));if(cell.bold)css.push('font-weight:bold');
      if(['top','center','bottom'].includes(cell.vAlign))css.push('vertical-align:'+(cell.vAlign==='center'?'middle':cell.vAlign));
      if(cell.noWrap)css.push('white-space:nowrap');
      const paras=cell.richParas?.map(p=>paragraph(p.runs||[],p.format||p)).join('')||cell.paras?.map(p=>'<p>'+esc(p)+'</p>').join('')||'';
      return '<td colspan="'+span+'" rowspan="'+rowSpan+'" style="'+esc(css.join(';'))+'">'+paras+(cell.nestedTables||[]).map(t=>tableHTML(t,depth+1)).join('')+'</td>';
    }).join('')+'</tr>';
  }).join('')+'</tbody></table></div>';
}
export function renderWord(doc,warnings){
  const lists=doc.blocks.filter(b=>b.type==='listItem'),markers=computeListMarkers(lists.map(b=>({numId:b.list?.numId||null,ilvl:b.list?.ilvl||0})),doc.numbering);let listIndex=0,missing=0;
  const body=doc.blocks.map((block,index)=>{
    if(block.hidden||block.invisibleMarker)return '';
    const id='office-block-'+index;
    const anchors=[...(block.bookmarks||[]),...(block.hiddenBookmarks||[])].map(n=>'<span id="office-bookmark-'+esc(n)+'"></span>').join('');
    if(block.type==='table'&&block.table)return anchors+tableHTML(block.table);
    const image=imageSource(block.imageDataUrl);
    if(image)return anchors+'<figure id="'+id+'"><img src="'+esc(image)+'" alt="'+esc(block.label||'')+'"'+(block.imageWidthPx?' style="width:'+number(block.imageWidthPx)/16+'em"':'')+'></figure>';
    if(block.type==='paragraph'||block.type==='heading'||block.type==='listItem'){
      const tag=block.type==='heading'?'h'+Math.max(1,Math.min(6,number(block.level,1))):'p';
      const content=paragraph(block.runs||[],block.format,tag,' id="'+id+'"');
      if(block.type==='listItem')return anchors+'<div class="office-list" style="margin-left:'+Math.min(20,number(block.list?.ilvl))*1.3+'em"><span class="office-marker">'+esc(markers[listIndex++]||'•')+'</span><div>'+content+'</div></div>';
      return anchors+content;
    }
    if(block.textboxes?.length)return anchors+block.textboxes.map(box=>(box.paras||box.paragraphs||[]).map(p=>paragraph(p.runs||[{text:p.text||''}],p.format||p)).join('')).join('');
    if(block.fieldDisplay?.runs)return anchors+paragraph(block.fieldDisplay.runs,block.format);
    if(block.formulaDisplay)return anchors+'<p>'+((block.formulaDisplay.omml&&ommlToMathML(block.formulaDisplay.omml))||esc(block.formulaDisplay.tokens?.join('')||''))+'</p>';
    if(block.decorative)return '<hr>';
    if(block.previewText)return anchors+'<p id="'+id+'">'+esc(block.previewText)+'</p>';
    missing++;return '<p class="office-note">'+esc(block.label||'표시할 수 없는 문서 개체')+'</p>';
  }).join('');
  const notes=(kind,items)=>(items||[]).map(n=>'<li id="office-'+kind+'-'+esc(n.id)+'">'+(n.richParas?.map(runs=>paragraph(runs)).join('')||esc(n.text||''))+'</li>').join('');
  const footnotes=notes('footnote',doc.footnotes),endnotes=notes('endnote',doc.endnotes);
  if(missing)warnings.push('일부 문서 개체 '+missing+'개는 원래 모양을 표시하지 못했습니다. 원본 파일은 그대로 보관합니다.');
  return '<article class="office-word">'+(doc.headerText?'<header>'+esc(doc.headerText)+'</header>':'')+body+(footnotes?'<section><h2>각주</h2><ol>'+footnotes+'</ol></section>':'')+(endnotes?'<section><h2>미주</h2><ol>'+endnotes+'</ol></section>':'')+(doc.footerText?'<footer>'+esc(doc.footerText)+'</footer>':'')+'</article>';
}
