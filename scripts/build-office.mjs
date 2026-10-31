import {build} from 'esbuild';
import {mkdir,writeFile,readFile,copyFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
const root=new URL('../',import.meta.url).pathname;
const dependencies=new Set();
const aliases={
  'node:crypto':resolve(root,'packages/office/browser-crypto.js'),
  'node:zlib':resolve(root,'packages/office/browser-zlib.js'),
  'node:fs':resolve(root,'packages/office/no-filesystem.js'),
  'node:fs/promises':resolve(root,'packages/office/no-filesystem.js'),
  'node:stream/promises':resolve(root,'packages/office/no-filesystem.js'),
};
const workspace={name:'genoffice-workspaces',setup(build){build.onResolve({filter:/^@genoffice\//},args=>{
  const [name,...path]=args.path.slice('@genoffice/'.length).split('/');
  return {path:resolve(root,'vendor-src/genoffice/packages',name,'src',path.join('/')||'index')+'.ts'};
});}};
await mkdir(resolve(root,'public/vendor/office'),{recursive:true});
for(const name of ['genoffice','sheets']){
  const result=await build({absWorkingDir:root,entryPoints:['packages/office/'+name+'-entry.js'],outfile:'public/vendor/office/'+name+'.js',bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,legalComments:'external',metafile:true,alias:aliases,inject:[resolve(root,'packages/office/browser-globals.js')],plugins:[workspace],define:{'process.env.NODE_ENV':'"production"'}});
  await mkdir(resolve(root,'test-results/office-build'),{recursive:true});
  await writeFile(resolve(root,'test-results/office-build',name+'.json'),JSON.stringify(result.metafile,null,2));
  for(const input of Object.keys(result.metafile.inputs))if(input.startsWith('node_modules/')){const parts=input.split('/');dependencies.add(parts.slice(0,parts[1].startsWith('@')?3:2).join('/'));}
  console.log(name+': '+result.metafile.outputs['public/vendor/office/'+name+'.js'].bytes+' bytes');
}
await copyFile(resolve(root,'vendor-src/genoffice/LICENSE'),resolve(root,'public/vendor/office/GENOFFICE-LICENSE.txt'));
await copyFile(resolve(root,'vendor-src/genoffice/NOTICE'),resolve(root,'public/vendor/office/GENOFFICE-NOTICE.txt'));
await copyFile(resolve(root,'node_modules/xlsx/LICENSE'),resolve(root,'public/vendor/office/SHEETJS-LICENSE.txt'));
const notices=['LibreMemo read-only document adapters\nGenOffice upstream: https://github.com/genspark-ai/genoffice/tree/36a509e8fc16ace85ed7afa3c37acb7b9c441ad1\nAdaptations and corresponding source: https://github.com/seionwon/LibreMemo/tree/main/vendor-src/genoffice\nBrowser shims: https://github.com/seionwon/LibreMemo/tree/main/packages/office\nNo GenOffice Electron/AI UI or font catalogue is included.\n'];
for(const dependency of [...dependencies].sort()){
  const folder=resolve(root,dependency),pkg=JSON.parse(await readFile(resolve(folder,'package.json'),'utf8'));
  const files=(await readdir(folder)).filter(name=>/^(?:licen[cs]e|copying|notice)(?:\.|$)/i.test(name));
  const texts=await Promise.all(files.map(name=>readFile(resolve(folder,name),'utf8')));
  if(!texts.length&&pkg.name==='@nodable/entities')texts.push(await readFile(resolve(root,'vendor-src/licenses/nodable-entities-LICENSE'),'utf8'));
  if(!texts.length)throw Error('Missing license: '+pkg.name);
  notices.push(pkg.name+' '+pkg.version+' — '+pkg.license+'\n'+texts.join('\n'));
}
for(const [name,path] of [['MTX decoder (MPL-2.0)','pptx-engine/src/vendor/mtx/LICENSE'],['emf-converter (Apache-2.0)','docx-engine/src/vendor/emf-converter/LICENSE']])notices.push(name+'\n'+await readFile(resolve(root,'vendor-src/genoffice/packages',path),'utf8'));
await writeFile(resolve(root,'public/vendor/office/THIRD-PARTY-NOTICES.txt'),notices.join('\n\n========================================\n\n'));
