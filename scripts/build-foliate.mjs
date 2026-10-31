import {build} from 'esbuild';
import {mkdir,readFile,writeFile,readdir,copyFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
const root=new URL('../',import.meta.url).pathname,out=resolve(root,'public/vendor/ebook');
await mkdir(out,{recursive:true});
const upstream=JSON.parse(await readFile(resolve(root,'vendor-src/foliate-js/UPSTREAM.json'),'utf8'));
for(const file of upstream.files){const bytes=await readFile(resolve(root,'vendor-src/foliate-js',file.path));if(createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw Error('Changed upstream foliate file: '+file.path);}
const result=await build({absWorkingDir:root,entryPoints:['packages/ebook/foliate-entry.js'],outfile:'public/vendor/ebook/foliate.js',bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,legalComments:'external',metafile:true});
const deps=new Map();
for(const input of Object.keys(result.metafile.inputs))if(input.includes('node_modules/')){
  let dir=dirname(resolve(root,input));
  while(dir!==root){try{const pkg=JSON.parse(await readFile(resolve(dir,'package.json'),'utf8'));if(pkg.name){deps.set(dir,pkg);break;}}catch{}dir=dirname(dir);}
}
const allowed=new Set(['MIT','ISC','BSD-2-Clause','BSD-3-Clause','Apache-2.0']);
const notices=['LibreMemo ebook import engine\nfoliate-js '+upstream.commit+'\n'+upstream.repository+'\nMIT; original modules are unmodified. Worker DOM bridge and document adapters: https://github.com/seionwon/LibreMemo/tree/main/packages/ebook\n'+await readFile(resolve(root,'vendor-src/foliate-js/LICENSE'),'utf8')];
const audited=[];
for(const [dir,pkg] of [...deps].sort((a,b)=>a[1].name.localeCompare(b[1].name))){
  if(!allowed.has(pkg.license))throw Error('Review ebook dependency license: '+pkg.name+' '+pkg.license);
  const names=(await readdir(dir)).filter(n=>/^(?:licen[cs]e|copying|notice)(?:\.|$)/i.test(n));
  const licenses=await Promise.all(names.map(n=>readFile(resolve(dir,n),'utf8')));
  if(!licenses.length&&pkg.name==='boolbase')licenses.push(await readFile(resolve(root,'vendor-src/licenses/boolbase-LICENSE'),'utf8'));
  if(!licenses.length)throw Error('Missing ebook license: '+pkg.name);
  audited.push({name:pkg.name,version:pkg.version,license:pkg.license});notices.push(pkg.name+' '+pkg.version+' — '+pkg.license+'\n'+licenses.join('\n'));
}
await copyFile(resolve(root,'vendor-src/foliate-js/LICENSE'),resolve(out,'FOLIATE-LICENSE.txt'));
await writeFile(resolve(out,'THIRD-PARTY-NOTICES.txt'),notices.join('\n\n================================\n\n'));
await writeFile(resolve(out,'UPSTREAM.json'),JSON.stringify({...upstream,bundledDependencies:audited,excluded:['Foliate application','foliate-js demo UI','zip.js','fflate','experimental PDF adapter'],archive:'Existing JSZip + GenOffice ZIP limits (see ../office/THIRD-PARTY-NOTICES.txt)',fonts:'Built-in DecompressionStream; no font catalogue'},null,2)+'\n');
await mkdir(resolve(root,'test-results/foliate-build'),{recursive:true});await writeFile(resolve(root,'test-results/foliate-build/metafile.json'),JSON.stringify(result.metafile,null,2));
console.log('foliate: '+result.metafile.outputs['public/vendor/ebook/foliate.js'].bytes+' bytes; '+audited.length+' dependency licenses verified');
