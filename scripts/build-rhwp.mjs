import {mkdir,copyFile,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root=new URL('../',import.meta.url),source=new URL('node_modules/@rhwp/core/',root),target=new URL('public/vendor/office/rhwp/',root);
const pkg=JSON.parse(await readFile(new URL('package.json',source),'utf8'));
if(pkg.version!=='0.8.7')throw Error('Review the rhwp adapter before updating its pinned engine.');
await mkdir(target,{recursive:true});
const hashes={};
for(const name of ['rhwp.js','rhwp_bg.wasm','LICENSE']){
  await copyFile(new URL(name,source),new URL(name,target));
  hashes[name]=createHash('sha256').update(await readFile(new URL(name,target))).digest('hex');
}
await writeFile(new URL('UPSTREAM.json',target),JSON.stringify({name:pkg.name,version:pkg.version,repository:'https://github.com/edwardkim/rhwp',release:'https://github.com/edwardkim/rhwp/tree/v0.8.7',license:pkg.license,files:hashes,changes:'Unmodified npm WASM and JavaScript. LibreMemo supplies a read-only adapter; no rhwp editor UI.'},null,2)+'\n');
console.log('rhwp '+pkg.version+': local read-only WASM assets');
await writeFile(new URL('THIRD-PARTY-NOTICES.txt',target),'LibreMemo read-only HWP/HWPX/HML adapter\nUnmodified @rhwp/core 0.8.7 (MIT), https://github.com/edwardkim/rhwp/tree/v0.8.7\nOnly WASM and its JavaScript bindings are included; no editor UI or font bundle.\n\n'+await readFile(new URL('LICENSE',source),'utf8')+'\n\n'+await readFile(new URL('vendor-src/rhwp/THIRD_PARTY_LICENSES.md',root),'utf8'));
