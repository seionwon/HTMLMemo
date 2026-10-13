import { compileDesign } from './design.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { root, prepareAssets } from './assets.mjs';
await compileDesign();await prepareAssets();const path=join(root,'public/HTMLMemo.html');console.log('서버 없이 여는 실행 파일: '+path);
if(!process.argv.includes('--no-open')){
  const execute=promisify(execFile);
  try{if(process.platform==='darwin')await execute('open',['-a','Google Chrome',path]);else if(process.platform==='win32')await execute('explorer.exe',[path]);else await execute('xdg-open',[path]);}
  catch(error){console.error('위 HTML 파일을 Chrome으로 직접 열어주세요. '+error.message);process.exitCode=1;}
}
