import {build} from 'esbuild';
import {mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
const root=new URL('../',import.meta.url).pathname,out=resolve(root,'public/vendor/pdf-export');await mkdir(out,{recursive:true});
const result=await build({absWorkingDir:root,entryPoints:['packages/pdf-export/browser.js'],outfile:'public/vendor/pdf-export/pdf-export.js',bundle:true,minify:true,format:'iife',platform:'browser',target:'es2022',legalComments:'external',metafile:true});
const notices=[],seen=new Set();
for(const input of Object.keys(result.metafile.inputs))if(input.includes('node_modules/')){
 let dir=dirname(resolve(root,input));for(;;){try{const pkg=JSON.parse(await readFile(resolve(dir,'package.json'),'utf8'));if(pkg.name){if(!seen.has(dir)){seen.add(dir);if(!['MIT','Zlib','(MIT AND Zlib)','0BSD'].includes(pkg.license))throw Error('Review PDF writer license: '+pkg.name);const name=pkg.name==='pako'?'LICENSE':pkg.name==='@pdf-lib/standard-fonts'?'LICENSE.md':'LICENSE.md';let license;for(const candidate of [name,'LICENSE','LICENSE.md','LICENSE.txt']){try{license=await readFile(resolve(dir,candidate),'utf8');break;}catch{}}if(!license)throw Error('Missing PDF writer license: '+pkg.name);notices.push(pkg.name+' '+pkg.version+' — '+pkg.license+'\n'+license);}break;}}catch(error){if(error.message.startsWith('Review')||error.message.startsWith('Missing'))throw error;}const parent=dirname(dir);if(parent===dir)throw Error('PDF dependency package missing');dir=parent;}
}
await writeFile(resolve(out,'THIRD-PARTY-NOTICES.txt'),notices.join('\n\n================\n\n'));
await writeFile(resolve(out,'pdf-export.js.LEGAL.txt'),notices.join('\n\n================\n\n'));
await mkdir(resolve(root,'test-results/pdf-export-build'),{recursive:true});await writeFile(resolve(root,'test-results/pdf-export-build/metafile.json'),JSON.stringify(result.metafile,null,2));
console.log('PDF export worker: '+result.metafile.outputs['public/vendor/pdf-export/pdf-export.js'].bytes+' bytes; '+seen.size+' dependency licenses verified');
