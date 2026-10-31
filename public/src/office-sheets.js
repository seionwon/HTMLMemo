import {read,utils} from '../vendor/office/sheets.js';
import {decodeCsvBuffer,parseCsv} from '../vendor/office/genoffice.js';
import {esc,number,color,safeLink} from './office-common.js';
const MAX_CELLS=250000,MAX_ROWS=50000,MAX_COLS=1024;
function checkedRange(sheet){
  const range=utils.decode_range(sheet['!fullref']||sheet['!ref']||'A1');
  const rows=range.e.r-range.s.r+1,cols=range.e.c-range.s.c+1;
  if(rows>MAX_ROWS||cols>MAX_COLS||rows*cols>MAX_CELLS)throw Error('시트의 표시 범위가 너무 큽니다. 시트당 50,000행·1,024열·250,000칸 이하로 나누어 가져와 주세요.');
  return range;
}
export function renderSheets(bytes,format,warnings){
  let workbook;
  if(format==='csv'||format==='tsv'){
    const rows=parseCsv(decodeCsvBuffer(bytes,'euc-kr'),format==='tsv'?'\t':undefined);
    const cols=rows.reduce((max,row)=>Math.max(max,row.length),0);
    if(rows.length>MAX_ROWS||cols>MAX_COLS||rows.length*cols>MAX_CELLS)throw Error('표가 너무 큽니다. 50,000행·1,024열·250,000칸 이하로 나누어 가져와 주세요.');
    workbook=utils.book_new();utils.book_append_sheet(workbook,utils.aoa_to_sheet(rows),'시트 1');
  }else workbook=read(bytes,{type:'array',cellStyles:true,cellNF:true,cellDates:false,cellHTML:false,bookVBA:false,sheetRows:MAX_ROWS+1});
  if(!workbook.SheetNames.length)throw Error('읽을 수 있는 시트가 없습니다.');
  if(workbook.SheetNames.length>256)throw Error('시트가 256개를 넘는 문서는 나누어 가져와 주세요.');
  let total=0,uncached=false;
  const body=workbook.SheetNames.map((name,index)=>{
    const sheet=workbook.Sheets[name],range=checkedRange(sheet),rows=range.e.r-range.s.r+1,cols=range.e.c-range.s.c+1;
    total+=rows*cols;if(total>MAX_CELLS*2)throw Error('통합 문서의 표시 범위가 500,000칸을 넘습니다. 시트를 나누어 가져와 주세요.');
    const merges=new Map(),covered=new Set();
    for(const merge of sheet['!merges']||[]){
      const sr=Math.max(range.s.r,merge.s.r),er=Math.min(range.e.r,merge.e.r),sc=Math.max(range.s.c,merge.s.c),ec=Math.min(range.e.c,merge.e.c);
      if(sr>er||sc>ec)continue;
      merges.set(sr+':'+sc,{rows:er-sr+1,cols:ec-sc+1});
      for(let r=sr;r<=er;r++)for(let c=sc;c<=ec;c++)if(r!==sr||c!==sc)covered.add(r+':'+c);
    }
    let content='<thead><tr><th aria-label="행 번호"></th>';
    for(let c=range.s.c;c<=range.e.c;c++)content+='<th scope="col">'+utils.encode_col(c)+'</th>';
    content+='</tr></thead><tbody>';
    for(let r=range.s.r;r<=range.e.r;r++){
      content+='<tr><th scope="row">'+(r+1)+'</th>';
      for(let c=range.s.c;c<=range.e.c;c++){
        const key=r+':'+c;if(covered.has(key))continue;
        const address=utils.encode_cell({r,c}),cell=sheet[address],merge=merges.get(key),css=[];
        let text=cell?cell.w??utils.format_cell(cell):'';
        if(cell?.f&&cell.v==null){text='='+cell.f;uncached=true;}
        if(cell?.t==='n')css.push('text-align:right');
        const fill=cell?.s?.fgColor?.rgb||cell?.s?.fill?.fgColor?.rgb;if(fill)css.push('background:'+color(fill));
        let value=esc(text);const href=safeLink(cell?.l?.Target);if(href)value='<a href="'+esc(href)+'">'+value+'</a>';
        if(cell?.c?.length)value+='<details><summary>원본 메모</summary>'+cell.c.map(note=>'<p>'+esc(note.t)+'</p>').join('')+'</details>';
        content+='<td id="office-cell-'+index+'-'+address+'"'+(merge?' rowspan="'+merge.rows+'" colspan="'+merge.cols+'"':'')+(css.length?' style="'+esc(css.join(';'))+'"':'')+'>'+value+'</td>';
      }
      content+='</tr>';
    }
    let columns='<col style="width:3em">';
    for(let c=range.s.c;c<=range.e.c;c++){const col=sheet['!cols']?.[c];columns+='<col style="width:'+Math.max(3,Math.min(80,number(col?.wch??(col?.wpx/8),10)*.6))+'em">';}
    const hidden=workbook.Workbook?.Sheets?.[index]?.Hidden;
    return '<section class="office-sheet" id="office-sheet-'+index+'"><h2>'+esc(name)+(hidden?' (숨겨진 시트)':'')+'</h2><div class="office-table-scroll"><table><colgroup>'+columns+'</colgroup>'+content+'</tbody></table></div></section>';
  }).join('');
  if(uncached)warnings.push('저장된 계산 결과가 없는 셀은 수식을 글자로 표시합니다. 수식을 다시 계산하거나 매크로를 실행하지 않습니다.');
  return body;
}
