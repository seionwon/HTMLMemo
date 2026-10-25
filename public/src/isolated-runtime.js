import {SCRIPT_CSP,sanitizeRuntimeHTML,serializeBookSource} from './document.js';

const ID='data-htmlmemo-runtime-id',MAX_HTML=64*1024*1024;
const validId=value=>typeof value==='string'&&/^r\d{1,12}$/.test(value);

// This function is serialized into the opaque child before ANY source script.
// No app settings, annotations, tokens, storage handles or executable RPC enter it.
function bootstrap(channel) {
  const ID='data-htmlmemo-runtime-id',MAX=64*1024*1024,send=parent.postMessage.bind(parent),ids=new WeakMap(),nodes=new Map();
  let serial=0,started=false,timer=0;const dirty=new Map();
  const storage=()=>{const values=new Map();return {get length(){return values.size;},key:i=>[...values.keys()][i]??null,getItem:key=>values.get(String(key))??null,setItem:(key,value)=>values.set(String(key),String(value)),removeItem:key=>values.delete(String(key)),clear:()=>values.clear()};};
  // Books may remember a sidebar width. Give them a fresh, private memory store,
  // never the app's persistent storage or a channel back to it.
  for(const key of ['localStorage','sessionStorage'])try{Object.defineProperty(window,key,{value:storage()});}catch{}
  const key=node=>{if(!ids.has(node)){const id='r'+(++serial);ids.set(node,id);nodes.set(id,node);}return ids.get(node);};
  const inert=node=>node?.closest?.('script,template');
  const html=node=>{
    const clone=node.cloneNode(true),from=[node,...node.querySelectorAll('*')],to=[clone,...clone.querySelectorAll('*')];
    for(let i=0;i<from.length;i++)to[i].setAttribute(ID,key(from[i]));
    // Volume/image payloads already exist in the non-executable source reader.
    // Never copy them on every chapter, and never send annotation metadata.
    for(const script of clone.querySelectorAll('script'))if(script.id!=='book-manifest')script.remove();
    clone.querySelectorAll('#htmlmemo-data,link[rel="preload"],link[rel="prefetch"],link[rel="preconnect"]').forEach(n=>n.remove());
    return clone.outerHTML;
  };
  const emit=value=>send({channel,...value},'*');
  const publish=()=>{
    timer=0;
    if(!started){if(!document.body)return;const snapshot=html(document.documentElement);if(snapshot.length>MAX){emit({type:'error',message:'문서의 실행 결과가 안전한 표시 한도(64MB)를 넘었습니다.'});return;}emit({type:'initial',html:snapshot});started=true;dirty.clear();return;}
    const entries=[...dirty];dirty.clear();
    const roots=entries.filter(([node])=>node.isConnected&&!inert(node)&&!entries.some(([other,kind])=>kind==='content'&&other!==node&&other.contains(node)));
    const patches=[];let length=0;
    for(const [node,kind] of roots){const value=kind==='attributes'?{id:key(node),kind,tag:node.localName,attributes:[...node.attributes].map(a=>[a.name,a.value])}:{id:key(node),kind,html:html(node)};length+=value.html?.length||JSON.stringify(value.attributes).length;if(length>MAX){emit({type:'error',message:'문서 변경의 크기가 안전한 표시 한도(64MB)를 넘었습니다.'});return;}patches.push(value);}
    if(patches.length)emit({type:'patches',patches});
    for(const [id,node] of nodes)if(!node.isConnected)nodes.delete(id);
  };
  const schedule=()=>{if(!timer)timer=setTimeout(publish,30);};
  new MutationObserver(records=>{
    if(!started)return;
    for(const record of records){const node=record.target.nodeType===1?record.target:record.target.parentElement;if(!node||inert(node))continue;const kind=record.type==='attributes'?'attributes':'content';if(dirty.get(node)!=='content')dirty.set(node,kind);}
    schedule();
  }).observe(document,{subtree:true,childList:true,characterData:true,attributes:true});
  addEventListener('message',event=>{
    const value=event.data;if(event.source!==parent||value?.channel!==channel)return;
    if(value.type==='hash'&&typeof value.hash==='string'&&value.hash.length<2000){location.hash=value.hash;return;}
    if(!['click','input','change','toggle'].includes(value.type)||!/^r\d{1,12}$/.test(value.id))return;
    const node=nodes.get(value.id);if(!node?.isConnected)return;
    if(value.type==='toggle'&&node.localName==='details'){if(node.open!==!!value.open)node.open=!!value.open;return;}
    if(value.type==='input'||value.type==='change'){
      if(!['input','textarea','select'].includes(node.localName)||typeof value.value!=='string'||value.value.length>200000)return;
      node.value=value.value;node.dispatchEvent(new Event(value.type,{bubbles:true}));return;
    }
    // No eval, arbitrary property access, network/file request or parent callback.
    if(value.type==='click'){node.click();schedule();}
  });
  addEventListener('DOMContentLoaded',()=>setTimeout(publish,0),{once:true});
  if(document.readyState!=='loading')schedule();
}

/** Source code runs in an opaque origin. Only inert, sanitized DOM comes back. */
export class IsolatedRuntime {
  constructor({host,doc,source,onError=()=>{}}) {
    this.host=host;this.doc=doc;this.source=source;this.onError=onError;this.channel=crypto.randomUUID();this.queue=Promise.resolve();this.disposed=false;this.listeners=[];this.nodes=new Map();this.attributes=new Map();
  }
  async start() {
    const owner=this.host.ownerDocument,win=owner.defaultView;
    const frame=owner.createElement('iframe');this.frame=frame;frame.setAttribute('sandbox','allow-scripts');frame.setAttribute('data-htmlmemo-runtime-runner','');frame.name='htmlmemo-runtime-'+this.channel;frame.title='문서 스크립트 격리 실행';frame.setAttribute('aria-hidden','true');frame.tabIndex=-1;frame.referrerPolicy='no-referrer';
    frame.style.cssText='position:fixed;left:-20000px;top:0;width:1100px;height:900px;border:0;visibility:hidden;pointer-events:none';
    // Remove exported notes before the source gets to run. The original source
    // Blob remains immutable in storage; the app's live metadata never enters it.
    let original=this.source;
    if(this.doc.querySelector('#htmlmemo-annotation-layer,[data-htmlmemo-mark],[data-htmlmemo-search]')){
      // Stream ordinary originals; only an already annotated HTML snapshot
      // needs a cleaned clone so notes drawn into its SVG cannot reach code.
      const clone=this.doc.documentElement.cloneNode(true);
      clone.querySelectorAll('#htmlmemo-data,#htmlmemo-annotation-layer,#htmlmemo-annotation-style,[data-htmlmemo-ui]').forEach(node=>node.remove());
      for(const node of [...clone.querySelectorAll('[data-htmlmemo-mark],[data-htmlmemo-search]')].reverse())node.replaceWith(...node.childNodes);
      original=new Blob(['<!doctype html>'+clone.outerHTML],{type:'text/html;charset=utf-8'});
    }
    const source=await serializeBookSource(original,{version:1,annotations:[],bookmarks:[],view:{},execution:{allowScripts:false}});
    if(this.disposed)return;
    const script='('+bootstrap.toString()+')('+JSON.stringify(this.channel)+');';
    const policy=SCRIPT_CSP.replace("frame-src 'self'","frame-src 'none'");
    this.url=URL.createObjectURL(new Blob(['<!doctype html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="'+policy+'"><script>'+script+'</script></head>',source],{type:'text/html;charset=utf-8'}));
    const initial=new Promise((resolve,reject)=>{this.resolve=resolve;this.reject=reject;this.timer=setTimeout(()=>this.fail(Error('문서 스크립트의 격리 실행 결과를 준비하지 못했습니다.')),30000);});
    this.receive=event=>{
      const value=event.data;if(this.disposed||event.source!==frame.contentWindow||value?.channel!==this.channel)return;
      this.queue=this.queue.then(()=>this.accept(value)).catch(error=>this.fail(error));
    };
    win.addEventListener('message',this.receive);this.window=win;
    frame.src=this.url;this.host.append(frame);
    await initial;this.bind();return this;
  }
  fail(error) {clearTimeout(this.timer);if(this.reject){this.reject(error);this.resolve=this.reject=null;}else if(!this.disposed)this.onError(error);this.dispose();}
  async accept(value) {
    if(this.disposed)return;
    if(value.type==='error'){this.fail(Error(String(value.message).slice(0,300)));return;}
    if(value.type==='initial'){
      if(!this.resolve||typeof value.html!=='string'||value.html.length>MAX_HTML)throw Error('유효하지 않은 문서 실행 결과입니다.');
      const next=sanitizeRuntimeHTML(value.html),payloads=[...this.doc.querySelectorAll('script[type="application/octet-stream"]')],metadata=this.doc.getElementById('htmlmemo-data');
      this.doc.head.replaceChildren(...[...next.head.childNodes].map(node=>this.doc.importNode(node,true)));this.doc.body.replaceChildren(...[...next.body.childNodes].map(node=>this.doc.importNode(node,true)));
      if(metadata)this.doc.head.append(metadata);
      for(const node of payloads)this.doc.body.append(node);
      this.copyAttributes(this.doc.documentElement,next.documentElement);this.copyAttributes(this.doc.body,next.body);this.copyAttributes(this.doc.head,next.head);
      this.doc.documentElement.setAttribute('data-htmlmemo-isolated-runtime','');
      this.index(this.doc.documentElement);
      clearTimeout(this.timer);const done=this.resolve;this.resolve=this.reject=null;done();return;
    }
    if(value.type!=='patches'||!Array.isArray(value.patches)||value.patches.length>10000||JSON.stringify(value.patches).length>MAX_HTML)return;
    for(const patch of value.patches){
      if(!validId(patch?.id))continue;
      const target=this.nodes.get(patch.id);if(!target?.isConnected)continue;
      if(patch.kind==='attributes'){
        if(!/^[a-z][a-z0-9-]{0,63}$/.test(patch.tag)||!Array.isArray(patch.attributes)||patch.attributes.length>200)continue;
        const temp=new DOMParser().parseFromString('<html><head></head><body></body></html>','text/html'),special=['html','head','body'].includes(patch.tag),node=special?(patch.tag==='html'?temp.documentElement:temp[patch.tag]):temp.createElement(patch.tag);if(!special)temp.body.append(node);
        for(const pair of patch.attributes)if(Array.isArray(pair)&&pair.length===2&&pair.every(v=>typeof v==='string'))try{node.setAttribute(pair[0],pair[1]);}catch{}
        const safeDoc=sanitizeRuntimeHTML(temp.documentElement.outerHTML),safe=special?(patch.tag==='html'?safeDoc.documentElement:safeDoc[patch.tag]):safeDoc.body.firstElementChild;if(safe)this.copyAttributes(target,safe);
      }else if(patch.kind==='content'&&typeof patch.html==='string'&&patch.html.length<=MAX_HTML){
        const safe=sanitizeRuntimeHTML(target===this.doc.documentElement?patch.html:target===this.doc.head?'<html>'+patch.html+'<body></body></html>':target===this.doc.body?'<html><head></head>'+patch.html+'</html>':'<html><head></head><body>'+patch.html+'</body></html>');
        const replacement=target===this.doc.documentElement?safe.documentElement:target===this.doc.head?safe.head:target===this.doc.body?safe.body:safe.body.firstElementChild;
        if(!replacement||replacement.localName!==target.localName)continue;
        const owned=[...target.children].filter(n=>n.hasAttribute('data-htmlmemo-ui')||/^htmlmemo-/.test(n.id)||n.localName==='script'&&/^book-(?:volume|asset)-\d+$/.test(n.id));
        this.copyAttributes(target,replacement);target.replaceChildren(...[...replacement.childNodes].map(node=>this.doc.importNode(node,true)),...owned);
        this.index(target);
      }
    }
    for(const [id,node] of this.nodes)if(!node.isConnected){this.nodes.delete(id);this.attributes.delete(id);}
  }
  index(root) {for(const node of [root,...root.querySelectorAll('['+ID+']')]){const id=node.getAttribute(ID);if(validId(id)){this.nodes.set(id,node);this.attributes.set(id,new Map([...node.attributes].map(a=>[a.name,a.value])));}}}
  copyAttributes(target,source) {
    // App-owned marks/layout/runtime state are never author-controlled RPC.
    const app=name=>name.startsWith('data-htmlmemo-')&&name!==ID,previous=this.attributes.get(target.getAttribute(ID)),next=new Map([...source.attributes].map(a=>[a.name,a.value]));
    for(const name of new Set([...(previous?.keys()||[...target.attributes].map(a=>a.name)),...next.keys()])){
      if(app(name)||previous&&previous.get(name)===next.get(name))continue;
      if(name==='style'&&previous){
        const old=this.doc.createElement('span');old.setAttribute('style',previous.get(name)||'');
        for(const property of new Set([...Array.from(old.style),...Array.from(source.style)]))if(!property.startsWith('--htmlmemo-')&&(old.style.getPropertyValue(property)!==source.style.getPropertyValue(property)||old.style.getPropertyPriority(property)!==source.style.getPropertyPriority(property))){const value=source.style.getPropertyValue(property);if(value)target.style.setProperty(property,value,source.style.getPropertyPriority(property));else target.style.removeProperty(property);}
      }else if(next.has(name))target.setAttribute(name,next.get(name));else target.removeAttribute(name);
    }
    const id=target.getAttribute(ID);if(validId(id))this.attributes.set(id,next);
  }
  send(value) {if(!this.disposed)this.frame?.contentWindow?.postMessage({channel:this.channel,...value},'*');}
  bind() {
    const add=(target,type,fn,capture=true)=>{target.addEventListener(type,fn,capture);this.listeners.push(()=>target.removeEventListener(type,fn,capture));};
    const sourceTarget=event=>{const node=event.target?.nodeType===1?event.target:event.target?.parentElement,source=node?.closest('['+ID+']');return source&&this.nodes.get(source.getAttribute(ID))===source?source:null;};
    for(const type of ['input','change'])add(this.doc,type,event=>{const node=sourceTarget(event);if(node&&['input','textarea','select'].includes(node.localName))this.send({type,id:node.getAttribute(ID),value:node.value});});
    add(this.doc,'click',event=>{
      const node=sourceTarget(event),control=node?.closest('button,summary,a[href],[role="button"],input[type="button"],input[type="submit"]');if(!control||!validId(control.getAttribute(ID)))return;
      if(control.localName==='a'&&!control.getAttribute('href')?.startsWith('#'))return;
      if(control.localName==='summary')return; // Native details toggle below carries exact state.
      event.preventDefault();this.send({type:'click',id:control.getAttribute(ID)});
    },false);
    add(this.doc,'toggle',event=>{const node=sourceTarget(event);if(node?.localName==='details')this.send({type:'toggle',id:node.getAttribute(ID),open:node.open});});
    add(this.doc.defaultView,'hashchange',()=>this.send({type:'hash',hash:this.doc.defaultView.location.hash}));
  }
  dispose() {this.disposed=true;clearTimeout(this.timer);this.reject?.(new DOMException('문서 열기가 취소되었습니다.','AbortError'));this.resolve=this.reject=null;for(const remove of this.listeners)remove();this.window?.removeEventListener('message',this.receive);this.frame?.remove();if(this.url)URL.revokeObjectURL(this.url);}
}
