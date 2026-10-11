const crcTable=Array.from({length:256},(_,i)=>{for(let b=0;b<8;b++)i=i&1?0xedb88320^(i>>>1):i>>>1;return i>>>0;});
export function crc32(bytes){let crc=0xffffffff;for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
export function zipFiles(entries) {
  const encoder=new TextEncoder(), chunks=[], directory=[];let offset=0;
  for(const entry of entries){
    if(!entry.name||entry.name.startsWith('/')||entry.name.split('/').some(p=>p==='..'||p==='')||/[\\\u0000]/.test(entry.name))throw new Error('잘못된 전달 파일 경로입니다.');
    const name=encoder.encode(entry.name),data=typeof entry.data==='string'?encoder.encode(entry.data):entry.data;
    if(!(data instanceof Uint8Array)||name.length>65535||data.length>0xffffffff)throw new Error('전달 파일을 만들 수 없습니다.');
    const crc=crc32(data),local=new Uint8Array(30),lv=new DataView(local.buffer);lv.setUint32(0,0x04034b50,true);lv.setUint16(4,20,true);lv.setUint16(6,0x800,true);lv.setUint16(12,0x21,true);lv.setUint32(14,crc,true);lv.setUint32(18,data.length,true);lv.setUint32(22,data.length,true);lv.setUint16(26,name.length,true);
    const info=new Uint8Array(46),iv=new DataView(info.buffer);iv.setUint32(0,0x02014b50,true);iv.setUint16(4,0x0314,true);iv.setUint16(6,20,true);iv.setUint16(8,0x800,true);iv.setUint16(14,0x21,true);iv.setUint32(16,crc,true);iv.setUint32(20,data.length,true);iv.setUint32(24,data.length,true);iv.setUint16(28,name.length,true);iv.setUint32(38,((entry.mode??0o100644)<<16)>>>0,true);iv.setUint32(42,offset,true);
    chunks.push(local,name,data);directory.push(info,name);offset+=local.length+name.length+data.length;
  }
  if(entries.length>65535)throw new Error('전달 파일이 너무 많습니다.');
  const directorySize=directory.reduce((sum,c)=>sum+c.length,0),end=new Uint8Array(22),view=new DataView(end.buffer);view.setUint32(0,0x06054b50,true);view.setUint16(8,entries.length,true);view.setUint16(10,entries.length,true);view.setUint32(12,directorySize,true);view.setUint32(16,offset,true);
  const result=new Uint8Array(offset+directorySize+22);let position=0;for(const chunk of [...chunks,...directory,end]){result.set(chunk,position);position+=chunk.length;}return result;
}
