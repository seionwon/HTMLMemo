import {readFile} from 'node:fs/promises';
import {initSync,HwpDocument} from '../public/vendor/office/rhwp/rhwp.js';
import {hangulMeasure} from '../public/src/office-hangul.js';
// Synthetic, non-private fixture. Only tests use the engine's write API to
// create binary HWP/HWPX equivalents; the shipped adapter never exports them.
export const hmlText=`<?xml version="1.0" encoding="UTF-8"?>
<HWPML Style="embed" Version="2.91"><HEAD SecCnt="1"><DOCSETTING><BEGINNUMBER Page="1"/></DOCSETTING><MAPPINGTABLE>
<FACENAMELIST><FONTFACE Count="1" Lang="Hangul"><FONT Id="0" Name="sans-serif" Type="rep"/></FONTFACE></FACENAMELIST>
<CHARSHAPELIST Count="1"><CHARSHAPE Height="1400" Id="0" TextColor="0"><FONTID Hangul="0" Latin="0" Hanja="0" Japanese="0" Other="0" Symbol="0" User="0"/></CHARSHAPE></CHARSHAPELIST>
<PARASHAPELIST Count="1"><PARASHAPE Align="Left" Id="0"/></PARASHAPELIST><STYLELIST Count="1"><STYLE CharShape="0" EngName="Normal" Id="0" Name="Body" NextStyle="0" ParaShape="0" Type="Para"/></STYLELIST>
</MAPPINGTABLE></HEAD><BODY><SECTION Id="0"><P ParaShape="0" Style="0"><TEXT CharShape="0"><CHAR>검색하는 한국어 본문입니다. 읽기 전용 한글 문서.</CHAR></TEXT></P>
<P ParaShape="0" Style="0"><TEXT CharShape="0"><CHAR>원본을 보관하고 주석을 남깁니다.</CHAR></TEXT></P>
<P ParaShape="0" Style="0"><TEXT CharShape="0"><TABLE RowCount="1" ColCount="1"><SIZE Width="20000" Height="4000"/><POSITION TreatAsChar="true"/><ROW><CELL ColAddr="0" RowAddr="0" ColSpan="1" RowSpan="1" Width="20000" Height="4000"><PARALIST><P ParaShape="0" Style="0"><TEXT CharShape="0"><CHAR>표 안의 검색 본문</CHAR></TEXT></P></PARALIST></CELL></ROW></TABLE></TEXT></P>
<P ParaShape="0" Style="0" PageBreak="true"><TEXT CharShape="0"><CHAR>두 번째 쪽의 본문과 북마크</CHAR></TEXT></P></SECTION></BODY><TAIL/></HWPML>`;
let fixtures;
export async function hangulFixtures(){
  if(fixtures)return fixtures;
  initSync({module:await readFile(new URL('../public/vendor/office/rhwp/rhwp_bg.wasm',import.meta.url))});globalThis.measureTextWidth=hangulMeasure;
  const hml=new TextEncoder().encode(hmlText),doc=new HwpDocument(hml);
  try{return fixtures={hml,hwp:doc.exportHwp(),hwpx:doc.exportHwpx()};}finally{doc.free();}
}
