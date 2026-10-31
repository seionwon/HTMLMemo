import { compileDesign } from './design.mjs';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { root, prepareAssets, packageAssets } from './assets.mjs';
import { pwaEntries } from '../public/src/distribution.js';
import { PUBLIC_APP_URL } from '../public/src/install.js';

await compileDesign();
await import('./build-office.mjs');
await import('./build-rhwp.mjs');
await import('./build-foliate.mjs');
await prepareAssets();
const output=join(root,'dist');
await rm(output,{recursive:true,force:true});
for(const entry of pwaEntries(await packageAssets())){
  const target=join(output,entry.name);
  await mkdir(join(target,'..'),{recursive:true});
  await writeFile(target,entry.data);
}
console.log('GitHub Pages 정적 앱 빌드 완료: dist/');
const repository=process.env.GITHUB_REPOSITORY;
const published=repository&&/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)?'https://'+repository.split('/')[0]+'.github.io/'+repository.split('/')[1]+'/':PUBLIC_APP_URL;
console.log('게시 후 사용자에게 공유할 URL: '+published);
