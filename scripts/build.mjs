import { execFileSync as buildCodeMemoDesign } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { root, prepareAssets, packageAssets } from './assets.mjs';
import { pwaEntries } from '../public/src/distribution.js';
import { PUBLIC_APP_URL } from '../public/src/install.js';

buildCodeMemoDesign(process.execPath, [new URL('../.codememo-design/build.mjs', import.meta.url).pathname], { stdio: 'pipe' });
await prepareAssets();
const output=join(root,'dist');
await rm(output,{recursive:true,force:true});
for(const entry of pwaEntries(await packageAssets())){
  const target=join(output,entry.name);
  await mkdir(join(target,'..'),{recursive:true});
  await writeFile(target,entry.data);
}
console.log('GitHub Pages 정적 앱 빌드 완료: dist/');
console.log('게시 후 사용자에게 공유할 URL: '+PUBLIC_APP_URL);
