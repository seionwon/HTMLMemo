import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { root } from './assets.mjs';
let count=0;
async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isDirectory())await walk(path);else if(/\.(m?js)$/.test(entry.name)){const result=spawnSync(process.execPath,['--check',path],{encoding:'utf8'});if(result.status!==0){process.stderr.write(result.stderr);process.exitCode=1;}count++;}else if(/\.(json|webmanifest)$/.test(entry.name))JSON.parse(await readFile(path,'utf8'));}}
for(const dir of ['public','extension','scripts','tests'])await walk(join(root,dir));
if(!process.exitCode)console.log(`${count}개 JavaScript 파일 문법 및 JSON 검사 통과`);
