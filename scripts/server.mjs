import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { root, prepareAssets } from './assets.mjs';
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png','.zip':'application/zip'};
export function createServer(directory=resolve(root,'public')){
  return http.createServer(async(request,response)=>{
    try{
      if(!['GET','HEAD'].includes(request.method)){response.writeHead(405);response.end();return;}
      const url=new URL(request.url,'http://localhost');let pathname;try{pathname=decodeURIComponent(url.pathname);}catch{response.writeHead(400);response.end();return;}
      const target=resolve(directory,'.'+pathname+(pathname.endsWith('/')?'index.html':''));
      if(target!==directory&&!target.startsWith(directory+sep)){response.writeHead(403);response.end();return;}
      const stats=await stat(target);if(!stats.isFile())throw new Error('not a file');
      const content=await readFile(target);response.writeHead(200,{'Content-Type':types[extname(target)]||'application/octet-stream','Content-Length':content.length,'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin'});response.end(request.method==='HEAD'?undefined:content);
    }catch(error){response.writeHead(error.code==='ENOENT'?404:500,{'Content-Type':'text/plain;charset=utf-8'});response.end('요청한 파일을 찾을 수 없습니다.');}
  });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const production=process.argv.includes('--production');if(!production)await prepareAssets();
  const directory=resolve(root,production?'dist':'public');const port=Number(process.env.PORT)||4173;const server=createServer(directory);
  server.on('error',error=>{console.error(error.message);process.exitCode=1;});server.listen(port,process.env.HTMLMEMO_HOST||'127.0.0.1',()=>console.log(`HTMLMemo: http://localhost:${port}/`));
}
