import JSZip from 'jszip';
import {readFile} from 'node:fs/promises';

export const ebookImage=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT1sAAAAASUVORK5CYII=','base64'));
export const ebookText='검색하는 한국어 본문입니다.';
const encode=s=>new TextEncoder().encode(s);
export async function ebookZip(parts){const zip=new JSZip();for(const [name,data] of Object.entries(parts))zip.file(name,data);return new Uint8Array(await zip.generateAsync({type:'uint8array',compression:'DEFLATE'}));}
export function epubParts({version=3,fixed=false}={}){
  const nav=version===3;
  return {
    mimetype:'application/epub+zip',
    'META-INF/container.xml':'<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    'OEBPS/book.opf':'<package xmlns="http://www.idpf.org/2007/opf" version="'+version+'.0" unique-identifier="book-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">urn:librememo:test</dc:identifier><dc:title>전자책 시험</dc:title><dc:language>ko</dc:language><dc:creator>LibreMemo</dc:creator>'+(fixed?'<meta property="rendition:layout">pre-paginated</meta>':'')+'</metadata><manifest><item id="one" href="chapter1.xhtml" media-type="application/xhtml+xml"/><item id="two" href="chapter2.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="'+(nav?'nav.xhtml':'toc.ncx')+'" media-type="'+(nav?'application/xhtml+xml':'application/x-dtbncx+xml')+'"'+(nav?' properties="nav"':'')+'/><item id="css" href="book.css" media-type="text/css"/><item id="pic" href="pic.png" media-type="image/png"/></manifest><spine toc="nav"><itemref idref="one"/><itemref idref="two"/></spine></package>',
    'OEBPS/nav.xhtml':'<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>목차</title></head><body><nav epub:type="toc"><ol><li><a href="chapter1.xhtml#same">첫 장</a><ol><li><a href="chapter1.xhtml#detail">첫 절</a></li></ol></li><li><a href="chapter2.xhtml#same">둘째 장</a></li></ol></nav></body></html>',
    'OEBPS/toc.ncx':'<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head/><docTitle><text>전자책 시험</text></docTitle><navMap><navPoint id="one" playOrder="1"><navLabel><text>첫 장</text></navLabel><content src="chapter1.xhtml#same"/><navPoint id="detail" playOrder="2"><navLabel><text>첫 절</text></navLabel><content src="chapter1.xhtml#detail"/></navPoint></navPoint><navPoint id="two" playOrder="3"><navLabel><text>둘째 장</text></navLabel><content src="chapter2.xhtml#same"/></navPoint></navMap></ncx>',
    'OEBPS/chapter1.xhtml':'<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>첫 장</title><meta name="viewport" content="width=600,height=800"/><link rel="stylesheet" href="book.css"/></head><body class="chapter"><h1 id="same">첫 장</h1><p id="detail">'+ebookText+'</p><a href="chapter2.xhtml#same">다음 장으로</a><img src="pic.png" alt="삽화"/><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><defs><circle id="dot" r="5" cx="10" cy="10"/></defs><use href="#dot"/></svg></body></html>',
    'OEBPS/chapter2.xhtml':'<html xmlns="http://www.w3.org/1999/xhtml"><head><title>둘째 장</title><meta name="viewport" content="width=600,height=800"/><link rel="stylesheet" href="book.css"/></head><body><h1 id="same">둘째 장</h1><p>Bookmark destination</p><a href="chapter1.xhtml#detail">처음 절로</a></body></html>',
    'OEBPS/book.css':'body{color:#243247}.chapter p{line-height:1.8}#detail{font-weight:600}h1{color:#334155}p{background-image:url(pic.png)}',
    'OEBPS/pic.png':ebookImage,
  };
}
export function fb2Source(){return '<?xml version="1.0" encoding="UTF-8"?><FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink"><description><title-info><genre>prose</genre><author><first-name>Libre</first-name><last-name>Memo</last-name></author><book-title>FB2 전자책</book-title><lang>ko</lang></title-info></description><body><section id="first"><title><p>첫 장</p></title><p>'+ebookText+'</p><p><a l:href="#second">다음 장으로</a></p><image l:href="#cover"/></section><section id="second"><title><p>둘째 장</p></title><p>Bookmark destination <a l:href="#note" type="note">주석</a></p></section></body><body name="notes"><section id="note"><title><p>각주</p></title><p>각주 내용입니다.</p></section></body><binary id="cover" content-type="image/png">'+Buffer.from(ebookImage).toString('base64')+'</binary></FictionBook>';}
export function mobiFixture(){
  const title=encode('MOBI 전자책'),prefix='<html><head></head><body><h1>첫 장</h1><p>'+ebookText+'</p><a filepos="0000000000">다음 장으로</a><img recindex="1"/></body></html><mbp:pagebreak/>',second='<html><head></head><body><h1>둘째 장</h1><p>Bookmark destination</p></body></html>';
  const raw=encode(prefix.replace('0000000000',String(encode(prefix).length).padStart(10,'0'))+second);
  const header=new Uint8Array(300),v=new DataView(header.buffer);v.setUint16(0,1);v.setUint32(4,raw.length);v.setUint16(8,1);v.setUint16(10,4096);header.set(encode('MOBI'),16);v.setUint32(20,232);v.setUint32(24,2);v.setUint32(28,65001);v.setUint32(32,42);v.setUint32(36,6);v.setUint32(84,264);v.setUint32(88,title.length);v.setUint32(108,2);v.setUint32(244,0xffffffff);header.set(title,264);
  const records=[header,raw,ebookImage],start=78+records.length*8+2,bytes=new Uint8Array(start+records.reduce((n,x)=>n+x.length,0)),pdb=new DataView(bytes.buffer);bytes.set(encode('LibreMemo test'));bytes.set(encode('BOOKMOBI'),60);pdb.setUint16(76,records.length);let pos=start;records.forEach((record,i)=>{pdb.setUint32(78+i*8,pos);bytes.set(record,pos);pos+=record.length;});return bytes;
}
let cache;
export async function ebookFixtures(){
  if(!cache)cache=(async()=>{
    const epub=await ebookZip(epubParts()),mobi=mobiFixture(),fb2=encode(fb2Source()),fbz=await ebookZip({'book.fb2':fb2});
    return {epub,epub3:epub,mobi,azw:mobi,azw3:new Uint8Array(await readFile(new URL('fixtures/ebooks/alice.azw3',import.meta.url))),fb2,fbz,'fb2.zip':fbz,cbz:await ebookZip({'page10.png':ebookImage,'page2.png':ebookImage})};
  })();return cache;
}
