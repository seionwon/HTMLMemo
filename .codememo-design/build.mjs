// Copy with package.json into an app's .codememo-design directory.
// npm install --prefix .codememo-design; node .codememo-design/build.mjs
import { readFile, writeFile, mkdtemp, rm, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
const metadata=import.meta.dirname,root=path.resolve(metadata,'..');
const version=JSON.parse(await readFile(path.join(metadata,'package.json'),'utf8')).dependencies.tailwindcss;
const confine=rel=>{const full=path.resolve(root,rel);if(!full.startsWith(root+path.sep))throw new Error('Design build path must stay in this app');return full;};
let cli,tool;
for(const base of [metadata,path.join(os.homedir(),'MemoSuite/tools/codememo-design')]){
  try{
    const require=createRequire(path.join(base,'package.json'));
    const pkg=require.resolve('@tailwindcss/cli/package.json');
    if(JSON.parse(await readFile(pkg,'utf8')).version!==version)continue;
    tool=base;cli=path.join(path.dirname(pkg),'dist/index.mjs');await access(cli);break;
  }catch{}
}
if(!cli)throw new Error('Install the pinned Tailwind compiler: npm install --prefix .codememo-design');
const config=JSON.parse(await readFile(path.join(metadata,'build.json'),'utf8'));
for(const job of config.targets){
  const source=await readFile(confine(job.input),'utf8'),temp=await mkdtemp(path.join(tool,'.compile-'));
  try{
    const input=path.join(temp,'input.css'),output=path.join(temp,'output.css');
    await writeFile(input,source);
    execFileSync(process.execPath,[cli,'-i',input,'-o',output,'--minify'],{cwd:tool,timeout:30000,stdio:'pipe'});
    const notice=await readFile(path.join(metadata,'TAILWIND-LICENSE.txt'),'utf8');
    const css=(await readFile(output,'utf8'))+'\n/*! Tailwind CSS license\n'+notice.replaceAll('*/','* /')+'\n*/';if(!css.includes(`tailwindcss v${version}`))throw new Error('Tailwind version mismatch');
    const target=confine(job.output);
    if(job.kind==='inline'){
      const html=await readFile(target,'utf8');
      if(!/<style(?:\s[^>]*)?>[\s\S]*?<\/style>/i.test(html))throw new Error('Missing inline style in '+job.output);
      await writeFile(target,html.replace(/<style(?:\s[^>]*)?>[\s\S]*?<\/style>/i,()=>'<style data-codememo-tailwind="'+version+'">\n'+css.replace(/<\/style/gi,'<\\/style')+'\n</style>'));
    }else await writeFile(target,css+'\n');
  }finally{await rm(temp,{recursive:true,force:true});}
}
console.log(`Tailwind CSS ${version}: ${config.targets.length} app stylesheet(s)`);
