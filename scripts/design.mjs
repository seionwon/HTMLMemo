import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
const require=createRequire(import.meta.url);
export async function compileDesign(){
  const cliPackage=require.resolve('@tailwindcss/cli/package.json');
  if(JSON.parse(await readFile(cliPackage,'utf8')).version!=='4.3.3')throw new Error('Tailwind CSS 4.3.3 is required');
  const root=new URL('../',import.meta.url).pathname;
  execFileSync(process.execPath,[join(dirname(cliPackage),'dist/index.mjs'),'-i','public/design.tailwind.css','-o','public/styles.css','--minify'],{cwd:root,stdio:'inherit'});
}
