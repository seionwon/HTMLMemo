const CACHE = 'htmlmemo-v44';
const VERSION = 'development';
const DIGESTS = {};
const SHELL = ["./","./index.html","./styles.css","./manifest.webmanifest","./example.html","./icons/icon.svg","./icons/icon-192.png","./icons/icon-512.png","./shared/capture.js","./src/app.js","./src/updates.js","./src/help.js","./src/help-content.js","./src/web.js","./src/markdown.js","./src/document.js","./src/bookmark-location.js","./src/search-index.js","./src/local-files.js","./src/mhtml.js","./src/migrate.js","./src/model.js","./src/reader.js","./src/isolated-runtime.js","./src/read-aloud.js","./src/storage.js","./src/data-folder.js","./src/library-folders.js","./src/folder-tree.js","./src/utils.js","./src/preferences.js","./src/zip.js","./src/bundler.js","./src/distribution.js","./src/install.js","./src/version.js","./src/sync-service.js","./src/sync-crypto.js","./src/sync-adapter.js","./src/sync-ui.js","./src/sync-device-service.js","./src/sync-peer.js","./src/sync-stream.js","./src/sync-temp.js","./src/sync-qr.js","./vendor/markdown-it.js","./vendor/markdown-it-LICENSE.txt","./vendor/html5-qrcode.min.js","./vendor/html5-qrcode-LICENSE.txt","./vendor/qrcodegen-LICENSE.txt","./distribution.json"];
const BASE=new URL('./',self.location.href),STORE=CACHE+':'+BASE.pathname,CONTROL='htmlmemo-control-v1:'+BASE.pathname;
const identity={cache:STORE,version:VERSION};
const key=name=>new URL('.htmlmemo-update/'+name,BASE).href;
async function read(name){return(await(await caches.open(CONTROL)).match(key(name)))?.json();}
async function write(name,value){await(await caches.open(CONTROL)).put(key(name),new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}}));}
const locked=action=>self.navigator?.locks?.request?self.navigator.locks.request('htmlmemo-app-update:'+BASE.pathname,action):action();
const application=url=>{try{const u=new URL(url);return u.origin===BASE.origin&&(u.pathname===BASE.pathname||u.pathname===BASE.pathname+'index.html');}catch{return false;}};
// This checksum detects incomplete/mixed deployments; HTTPS supplies source authentication.
function checksum(bytes){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return(crc^0xffffffff)>>>0;}
async function prepare(){
  const cache=await caches.open(STORE);
  try{
    for(let offset=0;offset<SHELL.length;offset+=6)await Promise.all(SHELL.slice(offset,offset+6).map(async path=>{
      const url=new URL(path,BASE),response=await fetch(new Request(url,{cache:'reload',credentials:'same-origin'}));
      if(!response.ok)throw Error('앱 파일을 받지 못했습니다.');
      const expected=DIGESTS[path==='./'?'index.html':path.slice(2)];
      if(expected!==undefined&&checksum(new Uint8Array(await response.clone().arrayBuffer()))!==expected)throw Error('새 앱 파일이 일치하지 않습니다.');
      await cache.put(url.href,response);
    }));
    await locked(async()=>{if(!await read('selected'))await write('selected',identity);await write('latest',identity);await prune();});
  }catch(error){if((await read('selected'))?.cache!==STORE)await caches.delete(STORE);throw error;}
}
async function pin(id,value){if(id)await write('client/'+id,value);return value;}
async function chosen(id){return id&&await read('client/'+id)||await read('selected')||identity;}
async function prune(){
  const live=(await self.clients.matchAll({type:'window',includeUncontrolled:true})).filter(client=>application(client.url));
  const liveIds=new Set(live.map(client=>client.id));
  const selected=await read('selected')||identity,keep=new Set([CONTROL,STORE,selected.cache]);
  for(const client of live){const value=await chosen(client.id);keep.add(value.cache);await pin(client.id,value);}
  const control=await caches.open(CONTROL);
  for(const request of await control.keys())if(request.url.startsWith(key('client/'))){
    // clients.get() can wait for a navigating window to become execution-ready.
    // That navigation needs this same update lock to select its cached shell.
    // Use the completed client snapshot instead; selected/new caches are kept
    // above, and every live old window already retains its own pinned cache.
    if(!liveIds.has(request.url.slice(key('client/').length)))await control.delete(request);
  }
  for(const name of await caches.keys())if(name.startsWith('htmlmemo-')&&name.endsWith(':'+BASE.pathname)&&!keep.has(name))await caches.delete(name);
}
self.addEventListener('install',event=>event.waitUntil(prepare()));
self.addEventListener('activate',event=>event.waitUntil(locked(prune).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(event.request.method!=='GET'||url.origin!==BASE.origin||!url.pathname.startsWith(BASE.pathname))return;
  event.respondWith((async()=>{
    const navigation=event.request.mode==='navigate'&&application(url.href);
    const value=navigation?await locked(async()=>pin(event.resultingClientId,await read('selected')||identity)):await chosen(event.clientId);
    const path=navigation?new URL('index.html',BASE).href:event.request;
    const cached=await(await caches.open(value.cache)).match(path,{ignoreSearch:true});
    if(cached)return cached;
    // Never mix a missing old code file with a newer network release.
    if(navigation||SHELL.some(path=>new URL(path,BASE).pathname===url.pathname))return new Response('앱 파일을 불러오지 못했습니다. 앱을 다시 실행해주세요.',{status:503,headers:{'Content-Type':'text/plain;charset=utf-8'}});
    return fetch(event.request);
  })());
});
self.addEventListener('message',event=>{
  if(!event.ports?.[0]||!['HTMLMEMO_UPDATE_INFO','HTMLMEMO_UPDATE_APPLY'].includes(event.data?.type))return;
  event.waitUntil((async()=>{
    try{
      const client=event.source?.id&&await self.clients.get(event.source.id);
      if(!client||!application(client.url)||client.frameType&&client.frameType!=='top-level')throw Error('앱 창에서만 업데이트할 수 있습니다.');
      const current=await chosen(client.id),latest=await read('latest');
      if(event.data.type==='HTMLMEMO_UPDATE_INFO'){
        await pin(client.id,current);
        event.ports[0].postMessage({ok:true,available:latest?.cache===STORE&&current.cache!==STORE,version:VERSION,currentVersion:current.version,build:CACHE,selected:(await read('selected'))?.cache===STORE});
      }else{
        await locked(async()=>{
          if(event.data.build!==CACHE||(await read('latest'))?.cache!==STORE)throw Error('새 버전이 변경되었습니다. 앱을 다시 실행해주세요.');
          if(!await(await caches.open(STORE)).match(new URL('index.html',BASE).href))throw Error('새 버전 준비를 끝내지 못했습니다.');
          await write('selected',identity);
        });
        // Selection is durable and the old worker can serve this cache on the
        // next navigation. A delayed activation must not delay this receipt.
        event.ports[0].postMessage({ok:true,navigationReady:true});
        await self.skipWaiting();
      }
    }catch(error){event.ports[0].postMessage({ok:false,error:error.message});}
  })());
});
