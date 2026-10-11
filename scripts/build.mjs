import { cp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { root, prepareAssets } from './assets.mjs';
await prepareAssets();const output=join(root,'dist');await rm(output,{recursive:true,force:true});await mkdir(output,{recursive:true});await cp(join(root,'public'),output,{recursive:true});
const hash=createHash('sha256');
async function walk(dir){for(const item of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){if(item.isDirectory())await walk(join(dir,item.name));else hash.update(await readFile(join(dir,item.name)));}}
await walk(output);const version=hash.digest('hex').slice(0,12);const sw=await readFile(join(output,'sw.js'),'utf8');await writeFile(join(output,'sw.js'),sw.replace("'htmlmemo-v1'",`'htmlmemo-${version}'`));
console.log(`PWA 빌드 완료: dist/ (오프라인 캐시 ${version})`);console.log('Chrome 확장 기능: extension/ 또는 dist/downloads/htmlmemo-chrome.zip');
