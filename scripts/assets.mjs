import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const crcTable=Array.from({length:256},(_,i)=>{for(let b=0;b<8;b++)i=i&1?0xedb88320^(i>>>1):i>>>1;return i>>>0;});
export function crc32(bytes){let crc=0xffffffff;for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
function pngChunk(type,data){const name=Buffer.from(type);const header=Buffer.alloc(4);header.writeUInt32BE(data.length);const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(Buffer.concat([name,data])));return Buffer.concat([header,name,data,crc]);}
function createIcon(size){
  const data=Buffer.alloc((size*4+1)*size);const green=[39,98,84];const ivory=[255,253,246];const gold=[228,191,131];
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const nx=x/size*512,ny=y/size*512;let color=green;const cornerX=nx<112?112:nx>400?400:nx;const cornerY=ny<112?112:ny>400?400:ny;
    const transparent=(nx-cornerX)**2+(ny-cornerY)**2>112**2;
    if((nx>=147&&nx<=209||nx>=303&&nx<=365)&&ny>=126&&ny<=386||nx>=209&&nx<=303&&ny>=226&&ny<=280)color=ivory;
    if(nx>=321&&nx<=408&&ny>=63&&ny<=150&&ny-63<=nx-321)color=gold;
    const offset=y*(size*4+1)+1+x*4;data.set([...color,transparent?0:255],offset);
  }
  const header=Buffer.alloc(13);header.writeUInt32BE(size,0);header.writeUInt32BE(size,4);header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),pngChunk('IHDR',header),pngChunk('IDAT',deflateSync(data)),pngChunk('IEND',Buffer.alloc(0))]);
}
async function files(dir,prefix=''){const result=[];for(const entry of await readdir(dir,{withFileTypes:true})){if(entry.isDirectory())result.push(...await files(join(dir,entry.name),prefix+entry.name+'/'));else result.push({name:prefix+entry.name,data:await readFile(join(dir,entry.name))});}return result;}
function zip(entries){
  const chunks=[];const central=[];let offset=0;
  for(const {name,data} of entries){
    const filename=Buffer.from(name);const crc=crc32(data);const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(filename.length,26);
    chunks.push(local,filename,data);const info=Buffer.alloc(46);info.writeUInt32LE(0x02014b50);info.writeUInt16LE(20,4);info.writeUInt16LE(20,6);info.writeUInt16LE(0x800,8);info.writeUInt32LE(crc,16);info.writeUInt32LE(data.length,20);info.writeUInt32LE(data.length,24);info.writeUInt16LE(filename.length,28);info.writeUInt32LE(offset,42);central.push(info,filename);offset+=local.length+filename.length+data.length;
  }
  const directory=Buffer.concat(central);const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...chunks,directory,end]);
}
export async function prepareAssets(){
  await mkdir(join(root,'public/icons'),{recursive:true});await mkdir(join(root,'public/downloads'),{recursive:true});
  await writeFile(join(root,'public/icons/icon-192.png'),createIcon(192));await writeFile(join(root,'public/icons/icon-512.png'),createIcon(512));
  await writeFile(join(root,'extension/capture.js'),await readFile(join(root,'public/shared/capture.js')));
  await writeFile(join(root,'public/downloads/htmlmemo-chrome.zip'),zip(await files(join(root,'extension'))));
}
