const CACHE = 'htmlmemo-v43';
const SHELL = ['./','./index.html','./styles.css','./manifest.webmanifest','./example.html','./icons/icon.svg','./icons/icon-192.png','./icons/icon-512.png','./shared/capture.js','./src/app.js','./src/web.js','./src/document.js','./src/search-index.js','./src/local-files.js','./src/mhtml.js','./src/migrate.js','./src/model.js','./src/reader.js','./src/isolated-runtime.js','./src/read-aloud.js','./src/storage.js','./src/data-folder.js','./src/library-folders.js','./src/folder-tree.js','./src/utils.js','./src/preferences.js','./src/distribution.js','./src/bundler.js','./src/zip.js','./src/install.js','./src/version.js','./src/sync-service.js','./src/sync-crypto.js','./src/sync-adapter.js','./src/sync-ui.js','./src/sync-device-service.js','./src/sync-peer.js','./src/sync-stream.js','./src/sync-temp.js','./src/sync-qr.js','./vendor/html5-qrcode.min.js','./vendor/html5-qrcode-LICENSE.txt','./vendor/qrcodegen-LICENSE.txt','./distribution.json'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('htmlmemo-')&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  const url=new URL(event.request.url);if(url.origin!==self.location.origin)return;
  const scope=new URL('./',self.location.href).pathname;
  const appNavigation=event.request.mode==='navigate'&&(url.pathname===scope||url.pathname===scope+'index.html');
  if(appNavigation){event.respondWith(fetch(event.request).catch(()=>caches.match(new URL('./index.html',self.location.href))));return;}
  const asset=SHELL.some(path=>new URL(path,self.location.href).pathname===url.pathname);
  if(asset)event.respondWith(caches.open(CACHE).then(async cache=>{
    try{
      const response=await fetch(event.request);
      if(response.ok)await cache.put(event.request,response.clone());
      return response;
    }catch{
      const cached=await cache.match(event.request,{ignoreSearch:true});
      if(cached)return cached;
      throw new Error('Offline asset unavailable');
    }
  }));
});
