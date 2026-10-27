import {SCRIPT_CSP,sanitizeRuntimeHTML,serializeBookSource} from './document.js';
import {cleanSourceStorage} from './model.js';

const ID='data-htmlmemo-runtime-id',MAX_HTML=64*1024*1024;
const validId=value=>typeof value==='string'&&/^r\d{1,12}$/.test(value);
export function needsIsolatedRuntime(doc) {
  for(const node of doc.querySelectorAll('*')){
    if(node.localName==='script'&&(!node.type||/^(?:module|(?:text|application)\/(?:x-)?(?:java|ecma)script)$/i.test(node.type))&&(node.getAttribute('src')||node.textContent.trim()))return true;
    if([...node.attributes].some(a=>/^on/i.test(a.name)&&a.value.trim()||/^(?:href|xlink:href)$/.test(a.name)&&/^javascript:/i.test(a.value.replace(/[\u0000-\u0020]/g,''))))return true;
  }
  return false;
}
const locator=node=>{const path=[];for(let n=node;n?.parentElement;n=n.parentElement)path.unshift([...n.parentElement.children].indexOf(n));return {tag:node?.localName,id:node?.id,anchor:node?.getAttribute?.('data-htmlmemo-anchor'),path};};
const locate=(doc,key)=>{let node=key.id?doc.getElementById(key.id):null;if(!node&&/^(?:body|(?:n|js)\d+)$/.test(key.anchor))node=doc.querySelector('[data-htmlmemo-anchor="'+key.anchor+'"]');if(!node){node=doc.documentElement;for(const index of key.path)node=node?.children[index];}return node?.localName===key.tag?node:null;};
export function privateRuntimeSource(doc,source) {
  if(!doc.querySelector('#htmlmemo-annotation-layer,[data-htmlmemo-mark],[data-htmlmemo-search]')&&![...doc.querySelectorAll('#htmlmemo-data')].some(node=>node.parentElement!==doc.head))return source;
  // Stream ordinary originals; unusual metadata locations and already drawn
  // exports need a cleaned copy before any source code can read the document.
  const clone=doc.documentElement.cloneNode(true);
  clone.querySelectorAll('#htmlmemo-data,#htmlmemo-annotation-layer,#htmlmemo-annotation-style,[data-htmlmemo-ui]').forEach(node=>node.remove());
  // The displayed document also contains our script-src 'none' prefix. The
  // opaque runner gets its own restrictive policy before these cleaned bytes.
  for(const node of clone.querySelectorAll('meta[http-equiv]'))if(/^content-security-policy$/i.test(node.getAttribute('http-equiv')))node.remove();
  for(const node of [...clone.querySelectorAll('[data-htmlmemo-mark],[data-htmlmemo-search]')].reverse())node.replaceWith(...node.childNodes);
  return new Blob(['<!doctype html>'+clone.outerHTML],{type:'text/html;charset=utf-8'});
}

// This function is serialized into the opaque child before ANY source script.
// No app settings, annotations, tokens, storage handles or executable RPC enter it.
function bootstrap(channel,preferences) {
  const ID='data-htmlmemo-runtime-id',MAX=64*1024*1024,send=parent.postMessage.bind(parent),ids=new WeakMap(),nodes=new Map();
  window.name='htmlmemo-runtime-'+channel;
  // Hidden execution frames do not receive rendering opportunities. Source
  // books still need a cancellable animation callback to finish lazy chapters.
  window.requestAnimationFrame=callback=>setTimeout(()=>callback(performance.now()),16);
  window.cancelAnimationFrame=id=>clearTimeout(id);
  let serial=0,started=false,timer=0,appliedInput=0;const dirty=new Map(),controls=new Map(),controlNodes=new Set(),removed=new Set();
  let storageTimer=0;
  const storage=(entries=[],persist=false)=>{const values=new Map(entries),changed=()=>{if(persist&&!storageTimer)storageTimer=setTimeout(()=>{storageTimer=0;send({channel,type:'storage',entries:[...values]},'*');},30);};return {get length(){return values.size;},key:i=>[...values.keys()][i]??null,getItem:key=>values.get(String(key))??null,setItem:(key,value)=>{key=String(key);value=String(value);if(values.get(key)===value)return;const next=new Map(values);next.set(key,value);if(key.length>1000||next.size>256||[...next].reduce((sum,[k,v])=>sum+k.length+v.length,0)>262144)throw new DOMException('문서 설정 저장 한도를 넘었습니다.','QuotaExceededError');values.set(key,value);changed();},removeItem:key=>{if(values.delete(String(key)))changed();},clear:()=>{if(values.size){values.clear();changed();}}};};
  // Only this document's own bounded preferences can survive reopening. No
  // values from the app's localStorage, settings or other documents enter it.
  for(const key of ['localStorage','sessionStorage'])try{Object.defineProperty(window,key,{value:storage(key==='localStorage'?preferences:[],key==='localStorage')});}catch{}
  const key=node=>{if(!ids.has(node)){const id='r'+(++serial);ids.set(node,id);nodes.set(id,node);if(['input','textarea','select'].includes(node.localName))controlNodes.add(node);}return ids.get(node);};
  const inert=node=>node?.closest?.('script,template');
  const html=node=>{
    const clone=node.cloneNode(true),from=[node,...node.querySelectorAll('*')],to=[clone,...clone.querySelectorAll('*')];
    for(let i=0;i<from.length;i++){to[i].setAttribute(ID,key(from[i]));if(from[i].localName==='input'&&!/^(?:file|password)$/i.test(from[i].type))to[i].setAttribute('value',from[i].value);if(from[i].localName==='textarea')to[i].textContent=from[i].value;}
    // Volume/image payloads already exist in the non-executable source reader.
    // Never copy them on every chapter, and never send annotation metadata.
    for(const script of clone.querySelectorAll('script'))if(script.id!=='book-manifest')script.remove();
    clone.querySelectorAll('#htmlmemo-data,link[rel="preload"],link[rel="prefetch"],link[rel="preconnect"]').forEach(n=>n.remove());
    return clone.outerHTML;
  };
  const emit=value=>send({channel,...value},'*');
  // App-owned search/bookmark navigation already has a precise target. Do not
  // turn its echoed hashchange into a new source navigation that resets it.
  const silentHashes=[];
  const setHashSilently=hash=>{const before=location.href;location.hash=hash;if(location.href!==before){silentHashes.push(location.href);if(silentHashes.length>128)silentHashes.shift();}};
  addEventListener('hashchange',event=>{
    const index=silentHashes.indexOf(event.newURL);
    if(index>=0){silentHashes.splice(index,1);return;}
    if(started&&event.newURL===location.href)emit({type:'navigation',hash:location.hash});
  });
  const publish=()=>{
    timer=0;
    if(!started){if(!document.body)return;const snapshot=html(document.documentElement);if(snapshot.length>MAX){emit({type:'error',message:'문서의 실행 결과가 안전한 표시 한도(64MB)를 넘었습니다.'});return;}emit({type:'initial',html:snapshot,assets:[...document.querySelectorAll('script[id^="book-asset-"]')].map(node=>node.id)});started=true;dirty.clear();return;}
    const entries=[...dirty];dirty.clear();
    const roots=entries.filter(([node])=>node.isConnected&&!inert(node)&&!entries.some(([other,kind])=>kind==='content'&&other!==node&&other.contains(node)));
    const patches=[];let length=0;
    for(const [node,kind] of roots){const value=kind==='attributes'?{id:key(node),kind,tag:node.localName,attributes:[...node.attributes].map(a=>[a.name,a.value])}:{id:key(node),kind,html:html(node)};length+=value.html?.length||JSON.stringify(value.attributes).length;if(length>MAX){emit({type:'error',message:'문서 변경의 크기가 안전한 표시 한도(64MB)를 넘었습니다.'});return;}patches.push(value);}
    for(const node of [...controlNodes].slice(0,256)){
      if(!node.isConnected){controlNodes.delete(node);continue;}
      if(/^(?:file|password)$/i.test(node.type)||node.value.length>200000)continue;
      const id=key(node),state=JSON.stringify([node.value,!!node.checked,appliedInput]);if(controls.get(id)!==state){controls.set(id,state);patches.push({id,kind:'control',value:node.value,checked:!!node.checked,revision:appliedInput});}
    }
    const released=[];for(const root of removed)if(!root.isConnected)for(const node of [root,...(root.querySelectorAll?.('*')||[])]){if(node.localName==='script'&&/^book-asset-\d{1,10}$/.test(node.id))released.push(node.id);nodes.delete(ids.get(node));controls.delete(ids.get(node));controlNodes.delete(node);}removed.clear();if(released.length)emit({type:'released-assets',ids:[...new Set(released)]});
    if(patches.length)emit({type:'patches',patches});
  };
  const schedule=()=>{if(!timer)timer=setTimeout(publish,30);};
  new MutationObserver(records=>{
    if(!started)return;
    for(const record of records){
      for(const node of record.removedNodes||[])if(node.nodeType===1)removed.add(node);
      if(record.type==='childList'&&[...record.addedNodes,...record.removedNodes].every(node=>node.nodeType===1&&node.localName==='script'))continue;
      const node=record.target.nodeType===1?record.target:record.target.parentElement;if(!node||inert(node))continue;const kind=record.type==='attributes'?'attributes':'content';if(dirty.get(node)!=='content')dirty.set(node,kind);
    }
    schedule();
  }).observe(document,{subtree:true,childList:true,characterData:true,attributes:true});
  const command=value=>{
    if(value?.channel!==channel)return;
    if(value.type==='hash'&&typeof value.hash==='string'&&value.hash.length<2000){setHashSilently(value.hash);return;}
    if(!['click','input','change','toggle','submit'].includes(value.type)||!/^r\d{1,12}$/.test(value.id))return;
    const node=nodes.get(value.id);if(!node?.isConnected)return;
    if(value.type==='toggle'&&node.localName==='details'){if(node.open!==!!value.open)node.open=!!value.open;return;}
    if(value.type==='submit'&&node.localName==='form'){node.requestSubmit();return;}
    if(value.type==='input'||value.type==='change'){
      if(!['input','textarea','select'].includes(node.localName)||typeof value.value!=='string'||value.value.length>200000)return;
      if(Number.isSafeInteger(value.revision)&&value.revision>=0)appliedInput=Math.max(appliedInput,value.revision);
      node.value=value.value;node.dispatchEvent(new Event(value.type,{bubbles:true}));schedule();return;
    }
    // No eval, arbitrary property access, network/file request or parent callback.
    if(value.type==='click'){node.click();schedule();}
  };
  // srcdoc inherits the app's base URL. Hash links belong to this source
  // document, rather than navigating the hidden frame to the app URL.
  addEventListener('click',event=>{const link=event.target?.closest?.('a[href]'),href=link?.getAttribute('href')?.trim();if(!event.defaultPrevented&&href?.startsWith('#')){event.preventDefault();setHashSilently(href);emit({type:'navigation',hash:location.hash});}});
  let commandPort;
  addEventListener('message',event=>{
    const value=event.data;if(commandPort||event.source!==parent||value?.channel!==channel||value.type!=='connect'||!event.ports[0])return;
    commandPort=event.ports[0];commandPort.onmessage=message=>command(message.data);
  });
  addEventListener('DOMContentLoaded',()=>setTimeout(publish,0),{once:true});
  if(document.readyState!=='loading')schedule();
}

/** Source code runs in an opaque origin. Only inert, sanitized DOM comes back. */
export class IsolatedRuntime {
  constructor({host,doc,source,storage=[],onStorage=()=>{},onNavigate=()=>{},onError=()=>{}}) {
    this.host=host;this.doc=doc;this.source=source;this.storage=cleanSourceStorage(storage);this.onStorage=onStorage;this.onNavigate=onNavigate;this.onError=onError;this.channel=crypto.randomUUID();this.queue=Promise.resolve();this.disposed=false;this.listeners=[];this.nodes=new Map();this.attributes=new Map();this.controlRevisions=new Map();this.inputRevision=0;
  }
  async start() {
    const owner=this.host.ownerDocument,win=owner.defaultView;
    const frame=owner.createElement('iframe');this.frame=frame;frame.setAttribute('sandbox','allow-scripts');frame.setAttribute('data-htmlmemo-runtime-runner','');frame.name='htmlmemo-runtime-'+this.channel;frame.title='문서 스크립트 격리 실행';frame.setAttribute('aria-hidden','true');frame.tabIndex=-1;frame.referrerPolicy='no-referrer';
    // Keep it in the viewport so Chrome does not throttle book timers. Inert,
    // transparent and outside pointer/tab interaction, it never becomes UI.
    frame.inert=true;frame.style.cssText='position:fixed;left:0;top:0;width:1100px;height:900px;border:0;opacity:0;pointer-events:none;z-index:-1';
    this.originalScripts=[...this.doc.querySelectorAll('script')].filter(node=>node.id!=='htmlmemo-data').map(node=>({node,parent:locator(node.parentElement)}));
    this.originalHandlers=[];for(const node of this.doc.querySelectorAll('*')){const attributes=[...node.attributes].filter(a=>/^on/i.test(a.name)||/^(?:href|xlink:href)$/.test(a.name)&&/^javascript:/i.test(a.value.trim())).map(a=>[a.name,a.value]);if(attributes.length)this.originalHandlers.push({target:locator(node),attributes});}
    // Remove exported notes before the source gets to run. The original source
    // Blob remains immutable in storage; the app's live metadata never enters it.
    const original=privateRuntimeSource(this.doc,this.source);
    const source=await serializeBookSource(original,{version:1,annotations:[],bookmarks:[],view:{},execution:{allowScripts:false}});
    if(this.disposed)return;
    const script='('+bootstrap.toString()+')('+JSON.stringify(this.channel)+','+JSON.stringify(this.storage).replaceAll('<','\\u003c')+');';
    const policy=SCRIPT_CSP.replace("frame-src 'self'","frame-src 'none'");
    // A sandboxed Blob URL cannot reliably change its fragment in Chrome.
    // Stream immutable source bytes INSIDE an opaque srcdoc instead; no full
    // source string or same-origin execution is needed in the app window.
    const prefix='<!doctype html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="'+policy+'"><script>'+script+'</script></head>';
    const loader=async event=>{
      if(event.source!==parent||event.data?.channel!==CHANNEL||event.data.type!=='source'||!(event.data.source instanceof Blob))return;
      removeEventListener('message',loader);
      try{
        const reader=event.data.source.stream().getReader(),decoder=new TextDecoder('utf-8');
        document.open();document.write(PREFIX);
        for(;;){const {done,value}=await reader.read();if(done)break;document.write(decoder.decode(value,{stream:true}));}
        document.write(decoder.decode());document.close();
      }catch(error){parent.postMessage({channel:CHANNEL,type:'error',message:String(error.message)},'*');}
    };
    const loaderCode=loader.toString().replaceAll('CHANNEL',JSON.stringify(this.channel)).replaceAll('PREFIX',JSON.stringify(prefix).replaceAll('<','\\u003c'));
    const loaderHTML='<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="'+policy+'"><script>(()=>{const loader='+loaderCode+';addEventListener("message",loader);parent.postMessage({type:"source-ready",channel:'+JSON.stringify(this.channel)+'},"*");})();</script>';
    const initial=new Promise((resolve,reject)=>{this.resolve=resolve;this.reject=reject;this.timer=setTimeout(()=>this.fail(Error('문서 스크립트의 격리 실행 결과를 준비하지 못했습니다.')),30000);});
    this.receive=event=>{
      const value=event.data;if(this.disposed||event.source!==frame.contentWindow||value?.channel!==this.channel)return;
      if(value.type==='source-ready'){if(!this.sourceDelivered){this.sourceDelivered=true;frame.contentWindow.postMessage({type:'source',channel:this.channel,source},'*');}return;}
      if(value.type==='initial'&&!this.port){
        // Establish the port in the app window's own message callback. A DOM
        // callback invoked in the static child has that child's incumbent
        // Window, so Window.postMessage source identity is not a command bus.
        const connection=new win.MessageChannel();this.port=connection.port1;
        frame.contentWindow.postMessage({channel:this.channel,type:'connect'},'*',[connection.port2]);
      }
      this.queue=this.queue.then(()=>this.accept(value)).catch(error=>this.fail(error));
    };
    win.addEventListener('message',this.receive);this.window=win;
    frame.srcdoc=loaderHTML;this.host.append(frame);
    await initial;this.bind();return this;
  }
  fail(error) {clearTimeout(this.timer);if(this.reject){this.reject(error);this.resolve=this.reject=null;}else if(!this.disposed)this.onError(error);this.dispose();}
  async accept(value) {
    if(this.disposed)return;
    if(value.type==='navigation'){
      if(this.resolve||typeof value.hash!=='string'||value.hash.length>=2000||!/^#[^\u0000-\u001f\u007f]*$/.test(value.hash))return;
      // Update only this displayed document's fragment, without echoing a
      // hashchange back to the source and racing a later click.
      const win=this.doc.defaultView;
      win?.history?.replaceState(null,'',win.location.href.split('#')[0]+value.hash);
      this.onNavigate(value.hash);return;
    }
    if(value.type==='storage'){
      if(!Array.isArray(value.entries)||value.entries.length>256||JSON.stringify(value.entries).length>600000)return;
      const entries=cleanSourceStorage(value.entries);if(JSON.stringify(entries)!==JSON.stringify(this.storage)){this.storage=entries;this.onStorage(entries);}return;
    }
    if(value.type==='released-assets'){
      if(Array.isArray(value.ids)&&value.ids.length<=10000)for(const id of value.ids)if(typeof id==='string'&&/^book-asset-\d{1,10}$/.test(id)){const node=this.doc.getElementById(id);if(node?.localName==='script'&&node.type==='application/octet-stream')node.remove();}return;
    }
    if(value.type==='error'){this.fail(Error(String(value.message).slice(0,300)));return;}
    if(value.type==='initial'){
      if(!this.resolve||typeof value.html!=='string'||value.html.length>MAX_HTML)throw Error('유효하지 않은 문서 실행 결과입니다.');
      const next=sanitizeRuntimeHTML(value.html),payloads=[...this.doc.querySelectorAll('script[type="application/octet-stream"]')],metadata=this.doc.getElementById('htmlmemo-data');
      this.doc.head.replaceChildren(...[...next.head.childNodes].map(node=>this.doc.importNode(node,true)));this.doc.body.replaceChildren(...[...next.body.childNodes].map(node=>this.doc.importNode(node,true)));
      if(metadata)this.doc.head.append(metadata);
      const assets=Array.isArray(value.assets)&&value.assets.length<=10000?new Set(value.assets):null;
      for(const node of payloads)if(!assets||!/^book-asset-\d{1,10}$/.test(node.id)||assets.has(node.id))this.doc.body.append(node);
      this.copyAttributes(this.doc.documentElement,next.documentElement);this.copyAttributes(this.doc.body,next.body);this.copyAttributes(this.doc.head,next.head);
      this.doc.documentElement.setAttribute('data-htmlmemo-isolated-runtime','');
      this.index(this.doc.documentElement);
      clearTimeout(this.timer);const done=this.resolve;this.resolve=this.reject=null;done();return;
    }
    if(value.type!=='patches'||!Array.isArray(value.patches)||value.patches.length>10000||JSON.stringify(value.patches).length>MAX_HTML)return;
    for(const patch of value.patches){
      if(!validId(patch?.id))continue;
      const target=this.nodes.get(patch.id);if(!target?.isConnected)continue;
      if(patch.kind==='control'){
        const revision=Number.isSafeInteger(patch.revision)&&patch.revision>=0?patch.revision:0;
        if(revision>=(this.controlRevisions.get(patch.id)||0)&&['input','textarea','select'].includes(target.localName)&&!/^(?:file|password)$/i.test(target.type)&&typeof patch.value==='string'&&patch.value.length<=200000){if(target.value!==patch.value)target.value=patch.value;if(target.localName==='input')target.checked=patch.checked===true;}
      }else if(patch.kind==='attributes'){
        if(!/^[a-z][a-z0-9-]{0,63}$/.test(patch.tag)||!Array.isArray(patch.attributes)||patch.attributes.length>200)continue;
        const temp=new DOMParser().parseFromString('<html><head></head><body></body></html>','text/html'),special=['html','head','body'].includes(patch.tag),node=special?(patch.tag==='html'?temp.documentElement:temp[patch.tag]):temp.createElement(patch.tag);if(!special)temp.body.append(node);
        for(const pair of patch.attributes)if(Array.isArray(pair)&&pair.length===2&&pair.every(v=>typeof v==='string'))try{node.setAttribute(pair[0],pair[1]);}catch{}
        node.setAttribute(ID,patch.id);
        const safeDoc=sanitizeRuntimeHTML(temp.documentElement.outerHTML),safe=special?(patch.tag==='html'?safeDoc.documentElement:safeDoc[patch.tag]):safeDoc.body.firstElementChild;if(safe)this.copyAttributes(target,safe);
      }else if(patch.kind==='content'&&typeof patch.html==='string'&&patch.html.length<=MAX_HTML){
        const safe=sanitizeRuntimeHTML(target===this.doc.documentElement?patch.html:target===this.doc.head?'<html>'+patch.html+'<body></body></html>':target===this.doc.body?'<html><head></head>'+patch.html+'</html>':'<html><head></head><body>'+patch.html+'</body></html>');
        const replacement=target===this.doc.documentElement?safe.documentElement:target===this.doc.head?safe.head:target===this.doc.body?safe.body:safe.body.firstElementChild;
        if(!replacement||replacement.localName!==target.localName)continue;
        const owned=[...target.children].filter(n=>n.hasAttribute('data-htmlmemo-ui')||/^htmlmemo-/.test(n.id)||n.localName==='script'&&/^book-(?:volume|asset)-\d+$/.test(n.id));
        for(const root of target.children)if(!owned.includes(root))for(const node of [root,...root.querySelectorAll('['+ID+']')]){const id=node.getAttribute(ID);if(this.nodes.get(id)===node){this.nodes.delete(id);this.attributes.delete(id);this.controlRevisions.delete(id);}}
        this.copyAttributes(target,replacement);target.replaceChildren(...[...replacement.childNodes].map(node=>this.doc.importNode(node,true)),...owned);
        this.index(target);
      }
    }
  }
  index(root) {for(const node of [root,...root.querySelectorAll('['+ID+']')]){const id=node.getAttribute(ID);if(validId(id)){this.nodes.set(id,node);if(!this.attributes.has(id))this.attributes.set(id,new Map([...node.attributes].map(a=>[a.name,a.value])));}}}
  copyAttributes(target,source) {
    // App-owned marks/layout/runtime state are never author-controlled RPC.
    const app=name=>name.startsWith('data-htmlmemo-')&&name!==ID,previous=this.attributes.get(target.getAttribute(ID)),next=new Map([...source.attributes].map(a=>[a.name,a.value]));
    for(const name of new Set([...(previous?.keys()||[...target.attributes].map(a=>a.name)),...next.keys()])){
      if(app(name)||previous&&previous.get(name)===next.get(name))continue;
      if(name==='open'&&target.localName==='details'&&target.hasAttribute('data-htmlmemo-book-search-open'))continue;
      if(name==='style'&&previous){
        const old=this.doc.createElement('span');old.setAttribute('style',previous.get(name)||'');
        for(const property of new Set([...Array.from(old.style),...Array.from(source.style)]))if(!property.startsWith('--htmlmemo-')&&(old.style.getPropertyValue(property)!==source.style.getPropertyValue(property)||old.style.getPropertyPriority(property)!==source.style.getPropertyPriority(property))){const value=source.style.getPropertyValue(property);if(value)target.style.setProperty(property,value,source.style.getPropertyPriority(property));else target.style.removeProperty(property);}
      }else if(next.has(name))target.setAttribute(name,next.get(name));else target.removeAttribute(name);
    }
    const id=target.getAttribute(ID);if(validId(id))this.attributes.set(id,next);
  }
  send(value) {if(!this.disposed)this.port?.postMessage({channel:this.channel,...value});}
  exportDocument() {
    // Restore original executable markup only into a detached export clone.
    // It never re-enters the live, scriptless reader or the app document.
    const clone=new DOMParser().parseFromString('<html><head></head><body></body></html>','text/html');clone.replaceChild(clone.importNode(this.doc.documentElement,true),clone.documentElement);
    for(const item of this.originalHandlers||[]){const target=locate(clone,item.target);if(target)for(const [name,value] of item.attributes)target.setAttribute(name,value);}
    for(const item of this.originalScripts||[]){if(item.node.id)clone.getElementById(item.node.id)?.remove();(locate(clone,item.parent)||clone.body).append(clone.importNode(item.node,true));}
    for(const node of clone.querySelectorAll('['+ID+'],[data-htmlmemo-isolated-runtime]')){node.removeAttribute(ID);node.removeAttribute('data-htmlmemo-isolated-runtime');}
    return clone;
  }
  bind() {
    const add=(target,type,fn,capture=true)=>{target.addEventListener(type,fn,capture);this.listeners.push(()=>target.removeEventListener(type,fn,capture));};
    const sourceTarget=event=>{const node=event.target?.nodeType===1?event.target:event.target?.parentElement,source=node?.closest('['+ID+']');return source&&this.nodes.get(source.getAttribute(ID))===source?source:null;};
    for(const type of ['input','change'])add(this.doc,type,event=>{const node=sourceTarget(event);if(node&&['input','textarea','select'].includes(node.localName)){const id=node.getAttribute(ID),revision=++this.inputRevision;this.controlRevisions.set(id,revision);this.send({type,id,value:node.value,revision});}});
    add(this.doc,'submit',event=>{event.preventDefault();const node=sourceTarget(event);if(node?.localName==='form')this.send({type:'submit',id:node.getAttribute(ID)});});
    add(this.doc,'click',event=>{
      const node=sourceTarget(event),control=node?.closest('button,summary,a,[role="button"],input[type="button"],input[type="submit"]');if(event.defaultPrevented||!control||!validId(control.getAttribute(ID)))return;
      const href=control.getAttribute('href');
      // Executable hrefs/handlers are stripped from the visible copy. Their
      // original source anchor can still run through this inert click command.
      if(control.localName==='a'&&href&&!href.startsWith('#'))return;
      if(control.localName==='summary')return; // Native details toggle below carries exact state.
      event.preventDefault();this.send({type:'click',id:control.getAttribute(ID)});
    },false);
    add(this.doc,'toggle',event=>{const node=sourceTarget(event);if(node?.localName==='details')this.send({type:'toggle',id:node.getAttribute(ID),open:node.open});});
    add(this.doc.defaultView,'hashchange',()=>this.send({type:'hash',hash:this.doc.defaultView.location.hash}));
  }
  dispose() {this.disposed=true;clearTimeout(this.timer);this.reject?.(new DOMException('문서 열기가 취소되었습니다.','AbortError'));this.resolve=this.reject=null;for(const remove of this.listeners)remove();this.port?.close();this.window?.removeEventListener('message',this.receive);this.frame?.remove();if(this.url)URL.revokeObjectURL(this.url);this.nodes.clear();this.attributes.clear();}
}
