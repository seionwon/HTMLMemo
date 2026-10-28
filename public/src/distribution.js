import {crc32} from './zip.js';
import { assetBytes, assetText } from './bundler.js';
export const APP_FILES=['index.html','styles.css','manifest.webmanifest','sw.js','example.html','icons/icon.svg','icons/icon-192.png','icons/icon-512.png','shared/capture.js','src/app.js','src/updates.js','src/help.js','src/help-content.js','src/web.js','src/document.js','src/search-index.js','src/local-files.js','src/mhtml.js','src/migrate.js','src/model.js','src/reader.js','src/isolated-runtime.js','src/read-aloud.js','src/storage.js','src/data-folder.js','src/library-folders.js','src/folder-tree.js','src/utils.js','src/preferences.js','src/zip.js','src/bundler.js','src/distribution.js','src/install.js','src/version.js','src/sync-service.js','src/sync-crypto.js','src/sync-adapter.js','src/sync-ui.js','src/sync-device-service.js','src/sync-peer.js','src/sync-stream.js','src/sync-temp.js','src/sync-qr.js','vendor/html5-qrcode.min.js','vendor/html5-qrcode-LICENSE.txt','vendor/qrcodegen-LICENSE.txt'];
export function cleanDistribution(assets){return {app:Object.fromEntries(APP_FILES.map(name=>[name,assets.app?.[name]]))};}
export function pwaEntries(assets) {
  assets=cleanDistribution(assets);
  const release=assetText(assets.app['src/version.js']).match(/export\s+const\s+APP_VERSION = ("[^"\n]+");/);
  const digests=Object.fromEntries(APP_FILES.filter(name=>name!=='sw.js').map(name=>[name,crc32(assetBytes(assets.app[name]))]));
  const normalizedSW=assetText(assets.app['sw.js']).replace(/const CACHE = '[^']+';/,"const CACHE = 'htmlmemo-pages';").replace(/const VERSION = [^;]+;/,'const VERSION = '+(release?.[1]||'"development"')+';').replace(/const DIGESTS = [^;]+;/,'const DIGESTS = '+JSON.stringify(digests)+';');
  const app={...assets.app,'sw.js':{text:normalizedSW}};
  const version=crc32(new TextEncoder().encode(JSON.stringify({...assets,app}))).toString(16).padStart(8,'0');
  assets={...assets,app:{...app,'sw.js':{text:normalizedSW.replace("const CACHE = 'htmlmemo-pages';","const CACHE = 'htmlmemo-"+version+"';")}}};
  return [...APP_FILES.map(name=>({name,data:assetBytes(assets.app[name])})),{name:'distribution.json',data:JSON.stringify(assets)},{name:'.nojekyll',data:''}];
}
export async function bundledExample() {const data=document.getElementById('htmlmemo-package-assets');return data?assetText(JSON.parse(data.textContent).app['example.html']):null;}
