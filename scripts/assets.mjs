import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { crc32, zipFiles } from '../public/src/zip.js';
import { standaloneHTML } from '../public/src/bundler.js';
import { APP_FILES, EXTENSION_FILES, portableZIP } from '../public/src/distribution.js';

export const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
export { crc32 };
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
export async function packageAssets(){
  const app={},extension={};
  for(const name of APP_FILES){const bytes=await readFile(join(root,'public',name));app[name]=name.endsWith('.png')?{base64:bytes.toString('base64')}:{text:bytes.toString('utf8')};}
  for(const name of EXTENSION_FILES)extension[name]={text:await readFile(join(root,'extension',name),'utf8')};
  return {app,extension};
}
export async function prepareAssets(){
  await mkdir(join(root,'public/icons'),{recursive:true});await mkdir(join(root,'public/downloads'),{recursive:true});
  await writeFile(join(root,'public/icons/icon-192.png'),createIcon(192));await writeFile(join(root,'public/icons/icon-512.png'),createIcon(512));
  await writeFile(join(root,'extension/capture.js'),await readFile(join(root,'public/shared/capture.js')));
  const assets=await packageAssets();await writeFile(join(root,'public/distribution.json'),JSON.stringify(assets));await writeFile(join(root,'public/HTMLMemo.html'),standaloneHTML(assets));
  const extensionEntries=[];
  for(const name of EXTENSION_FILES)extensionEntries.push({name,data:assets.extension[name].text});
  for(const name of APP_FILES){const data=await readFile(join(root,'public',name));const target=join(root,'extension/app',name);await mkdir(resolve(target,'..'),{recursive:true});await writeFile(target,data);extensionEntries.push({name:'app/'+name,data});}
  await writeFile(join(root,'public/downloads/htmlmemo-chrome.zip'),zipFiles(extensionEntries));
  await writeFile(join(root,'public/downloads/HTMLMemo-local.zip'),portableZIP(assets));
}
