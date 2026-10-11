const utf8=new TextDecoder();
export function assetBytes(asset) {
  if(typeof asset?.text==='string')return new TextEncoder().encode(asset.text);
  if(typeof asset?.base64==='string'){const binary=atob(asset.base64);return Uint8Array.from(binary,c=>c.charCodeAt(0));}
  throw new Error('앱 파일을 읽을 수 없습니다.');
}
export const assetText = asset => utf8.decode(assetBytes(asset));
const resolveModule=(parent,relative)=>{const parts=parent.split('/');parts.pop();for(const part of relative.split('/')){if(part==='.'||!part)continue;if(part==='..')parts.pop();else parts.push(part);}return parts.join('/');};
export function bundleModules(sources,entry='src/app.js') {
  const compiled=new Set(),visiting=new Set(),output=['(()=>{\nconst modules=Object.create(null);'];
  function compile(name){
    if(compiled.has(name))return;if(visiting.has(name))throw new Error('앱 모듈이 서로 순환 참조합니다.');if(!Object.hasOwn(sources,name))throw new Error('앱 모듈이 누락되었습니다: '+name);visiting.add(name);
    const original=assetText(sources[name]);const exports=[...original.matchAll(/\bexport\s+(?:async\s+)?(?:function|class|const|let|var)\s+([$\w]+)/g)].map(match=>match[1]);
    const source=original.replace(/^import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"];?\s*$/gm,(_,names,relative)=>{if(!relative.startsWith('.'))throw new Error('외부 앱 모듈은 지원하지 않습니다.');const dependency=resolveModule(name,relative);compile(dependency);return 'const {'+names.trim().replace(/\s+as\s+/g,':')+'}=modules['+JSON.stringify(dependency)+'];';}).replace(/\bexport\s+(?=(?:async\s+)?(?:function|class|const|let|var)\b)/g,'');
    if(/^\s*(?:import|export)\s/m.test(source))throw new Error('지원하지 않는 앱 모듈 구문입니다: '+name);
    output.push('modules['+JSON.stringify(name)+']=(()=>{\n'+source+'\nreturn {'+exports.join(',')+'};\n})();');visiting.delete(name);compiled.add(name);
  }
  compile(entry);output.push('})();');return output.join('\n');
}
export function standaloneHTML(assets) {
  const app=assets.app;let html=assetText(app['index.html']);
  html=html.replace(/<link rel="manifest"[^>]*>/,'').replace(/<link rel="icon"[^>]*>/,'<link rel="icon" href="data:image/svg+xml;base64,'+btoa(String.fromCharCode(...assetBytes(app['icons/icon.svg'])))+'">').replace(/<link rel="apple-touch-icon"[^>]*>/,'');
  html=html.replace('<link rel="stylesheet" href="./styles.css">',()=>'<style>'+assetText(app['styles.css'])+'</style>').replace(/<script src="\.\/shared\/capture\.js" defer><\/script>\s*/,'').replace(/<script type="module" src="\.\/src\/app\.js"><\/script>/,'');
  const json=JSON.stringify(assets).replace(/</g,'\\u003c');
  const script=(assetText(app['shared/capture.js'])+'\n'+bundleModules(app)).replace(/<\/script/gi,'<\\/script');
  return html.replace('</body>',()=>'<script type="application/json" id="htmlmemo-package-assets">'+json+'</script>\n<script>'+script+'</script>\n</body>');
}
