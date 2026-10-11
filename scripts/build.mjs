import { cp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { root, prepareAssets, packageAssets } from './assets.mjs';
import { pagesEntries, installationHTML } from '../public/src/distribution.js';
import { zipFiles } from '../public/src/zip.js';
import { PUBLIC_APP_URL } from '../public/src/install.js';
await prepareAssets();const output=join(root,'dist');await rm(output,{recursive:true,force:true});await mkdir(output,{recursive:true});await cp(join(root,'public'),output,{recursive:true});
const hash=createHash('sha256');
async function walk(dir){for(const item of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){if(item.isDirectory())await walk(join(dir,item.name));else hash.update(await readFile(join(dir,item.name)));}}
await walk(output);const version=hash.digest('hex').slice(0,12);const sw=await readFile(join(output,'sw.js'),'utf8');await writeFile(join(output,'sw.js'),sw.replace(/const CACHE = '[^']+';/,`const CACHE = 'htmlmemo-${version}';`));
const entries=pagesEntries(await packageAssets());
for(const entry of entries){const target=join(output,'pages',entry.name);await mkdir(join(target,'..'),{recursive:true});await writeFile(target,entry.data);}
await writeFile(join(output,'downloads/HTMLMemo-pages.zip'),zipFiles(entries));
await writeFile(join(output,'downloads/HTMLMemo-install.html'),installationHTML(PUBLIC_APP_URL));
console.log('GitHub Pages에 올릴 파일: dist/downloads/HTMLMemo-pages.zip (압축을 풀고 docs 폴더 업로드)');
console.log('다른 사람에게 전달: dist/downloads/HTMLMemo-install.html');
console.log('Pages 설정: Deploy from a branch → main → /docs');
console.log(`로컬 검토용 빌드: dist/ (캐시 ${version})`);
