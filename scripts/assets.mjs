import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { crc32 } from '../public/src/zip.js';
import { standaloneHTML } from '../public/src/bundler.js';
import {APP_FILES} from '../public/src/distribution.js';

export const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
export { crc32 };
function pngChunk(type,data){const name=Buffer.from(type);const header=Buffer.alloc(4);header.writeUInt32BE(data.length);const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(Buffer.concat([name,data])));return Buffer.concat([header,name,data,crc]);}
function createIcon(size){
  const data=Buffer.alloc((size*4+1)*size);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const nx=x/size*64,ny=y/size*64;let color=[51,65,85];
    const cornerX=Math.max(15,Math.min(49,nx)),cornerY=Math.max(15,Math.min(49,ny));
    const transparent=(nx-cornerX)**2+(ny-cornerY)**2>15**2;
    const segments=[[8,22,32,9],[32,9,56,22],[56,22,32,35],[32,35,8,22],[8,33,32,46],[32,46,56,33],[8,44,32,57],[32,57,56,44]];
    const px=(nx-6)/.8125,py=(ny-6)/.8125;
    for(const [ax,ay,bx,by] of segments){const t=Math.max(0,Math.min(1,((px-ax)*(bx-ax)+(py-ay)*(by-ay))/((bx-ax)**2+(by-ay)**2)));if(Math.hypot(px-ax-t*(bx-ax),py-ay-t*(by-ay))<=1.75)color=[255,255,255];}
    const offset=y*(size*4+1)+1+x*4;data.set([...color,transparent?0:255],offset);
  }
  const header=Buffer.alloc(13);header.writeUInt32BE(size,0);header.writeUInt32BE(size,4);header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),pngChunk('IHDR',header),pngChunk('IDAT',deflateSync(data)),pngChunk('IEND',Buffer.alloc(0))]);
}
export async function packageAssets(){
  const app={};
  for(const name of APP_FILES){const bytes=await readFile(join(root,'public',name));app[name]=/\.(?:png|bcmap|pfb|ttf|otf|wasm)$/.test(name)?{base64:bytes.toString('base64')}:{text:bytes.toString('utf8')};}
  return {app};
}
export async function prepareAssets(){
  const {version}=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
  await writeFile(join(root,'public/src/version.js'),'// Generated from package.json by scripts/assets.mjs.\nexport const APP_VERSION = '+JSON.stringify(version)+';\n');
  await mkdir(join(root,'public/icons'),{recursive:true});await mkdir(join(root,'public/downloads'),{recursive:true});
  await writeFile(join(root,'public/icons/icon-192.png'),createIcon(192));await writeFile(join(root,'public/icons/icon-512.png'),createIcon(512));
  const assets=await packageAssets();await writeFile(join(root,'public/distribution.json'),JSON.stringify(assets));await writeFile(join(root,'public/LibreMemo.html'),standaloneHTML(assets));
  for(const prefix of ['LibreMemo','HTMLMemo','htmlmemo'])for(const suffix of ['-chrome.zip','-local.zip','-pages.zip','-install.html'])await rm(join(root,'public/downloads',prefix+suffix),{force:true});
  await rm(join(root,'public/HTMLMemo.html'),{force:true});
}
