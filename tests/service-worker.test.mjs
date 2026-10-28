import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {crc32} from '../public/src/zip.js';

const source=await readFile(new URL('../public/sw.js',import.meta.url),'utf8'),base='https://app.test/HTMLMemo/';
class Cache{
  constructor(){this.rows=new Map();}
  url(input,ignoreSearch=false){const u=new URL(typeof input==='string'?input:input.url);if(ignoreSearch)u.search='';return u.href;}
  async put(input,response){this.rows.set(this.url(input),response.clone());}
  async match(input,options={}){const target=this.url(input,options.ignoreSearch);for(const [url,response]of this.rows)if(this.url(url,options.ignoreSearch)===target)return response.clone();}
  async keys(){return[...this.rows.keys()].map(url=>new Request(url));}
  async delete(input){return this.rows.delete(this.url(input));}
}
function fixture(){
  const stores=new Map(),clients=new Map(),network=new Map(),requests=[];
  const caches={async open(name){if(!stores.has(name))stores.set(name,new Cache());return stores.get(name);},async keys(){return[...stores.keys()];},async delete(name){return stores.delete(name);}};
  function worker(version,{bad=false,networkFailure=false}={}){
    const files={'index.html':`<h1>release ${version}</h1>`,'styles.css':`/* ${version} */`,'src/version.js':`export const APP_VERSION = "${version}";`},events=new Map();
    for(const[name,body]of Object.entries(files))network.set(new URL(name,base).href,body);network.set(base,files['index.html']);
    const digests=Object.fromEntries(Object.entries(files).map(([name,body])=>[name,crc32(new TextEncoder().encode(body))]));
    if(bad)network.set(new URL('styles.css',base).href,'Wrong deployed file');if(networkFailure)network.delete(new URL('styles.css',base).href);
    const self={location:new URL('sw.js',base),addEventListener:(type,fn)=>events.set(type,fn),clients:{async matchAll(){return[...clients.values()];},async get(id){return clients.get(id);},async claim(){}},skipWaiting:async()=>{w.skips++;}};
    const context=vm.createContext({self,caches,URL,Request,Response,Uint8Array,fetch:async request=>{requests.push(request.url);const body=network.get(request.url);return new Response(body??'Unavailable',{status:body===undefined?503:200});}});
    const script=source.replace(/const CACHE = '[^']+';/,`const CACHE = 'htmlmemo-${version}';`).replace(/const VERSION = [^;]+;/,`const VERSION = ${JSON.stringify(version)};`).replace(/const DIGESTS = [^;]+;/,`const DIGESTS = ${JSON.stringify(digests)};`).replace(/const SHELL = [^;]+;/,`const SHELL = ['./','./index.html','./styles.css','./src/version.js'];`);
    vm.runInContext(script,context);
    const w={skips:0,async event(type,data={}){let pending;events.get(type)({...data,waitUntil:p=>pending=p});await pending;},async message(id,message){let result;await w.event('message',{source:{id},data:message,ports:[{postMessage:value=>result=value}]});return result;},async fetch(path,{id='page',navigation=false,next='next',method='GET'}={}){
      let pending;const request={method,url:new URL(path,base).href,mode:navigation?'navigate':'cors'};
      events.get('fetch')({request,clientId:id,resultingClientId:next,respondWith:p=>pending=p});return pending?await pending:null;
    }};return w;
  }
  const client=(id,url=base)=>clients.set(id,{id,url,frameType:'top-level'});
  return{worker,stores,clients,client,requests,caches,network};
}
test('cancel survives worker activation and a complete app close; accepting switches navigation but preserves other live windows',async()=>{
  const f=fixture();f.client('old');const one=f.worker('one');await one.event('install');await one.event('activate');assert.equal(one.skips,0);
  await one.fetch('',{navigation:true,next:'old'});assert.match(await(await one.fetch('styles.css',{id:'old'})).text(),/one/);
  const two=f.worker('two');await two.event('install');assert.equal(two.skips,0);assert.equal((await two.message('old',{type:'HTMLMEMO_UPDATE_INFO'})).available,true);
  f.clients.clear();await two.event('activate');f.client('reopened');
  assert.match(await(await two.fetch('',{navigation:true,next:'reopened'})).text(),/one/);assert.equal((await two.message('reopened',{type:'HTMLMEMO_UPDATE_INFO'})).available,true);
  f.client('other');await two.fetch('',{navigation:true,next:'other'});
  const result=await two.message('reopened',{type:'HTMLMEMO_UPDATE_APPLY',build:'htmlmemo-two'});assert.equal(result.ok,true);assert.equal(two.skips,1);
  assert.match(await(await two.fetch('',{navigation:true,next:'updated'})).text(),/two/);
  assert.match(await(await two.fetch('styles.css',{id:'other'})).text(),/one/);
  await two.event('activate');assert.ok([...f.stores.keys()].some(key=>key==='htmlmemo-one:/HTMLMemo/'));
});
test('incomplete or mixed releases never replace the selected app or offer an install',async()=>{
  for(const failure of ['bad','networkFailure']){
    const f=fixture();f.client('page');const one=f.worker('one');await one.event('install');await one.event('activate');await one.fetch('',{navigation:true,next:'page'});
    const two=f.worker('two',{[failure]:true});await assert.rejects(two.event('install'));
    assert.match(await(await one.fetch('',{navigation:true,next:'reopened'})).text(),/one/);assert.equal((await one.message('page',{type:'HTMLMEMO_UPDATE_INFO'})).available,false);assert.equal(two.skips,0);
  }
});
test('messages reject document frames, other app paths and stale releases before applying anything',async()=>{
  const f=fixture();f.client('page');const one=f.worker('one');await one.event('install');await one.event('activate');await one.fetch('',{navigation:true,next:'page'});
  const two=f.worker('two');await two.event('install');
  f.client('frame',base+'private-document.html');f.client('foreign','https://app.test/Other/');f.client('nested');f.clients.get('nested').frameType='nested';
  for(const id of ['frame','foreign','nested','missing'])assert.equal((await two.message(id,{type:'HTMLMEMO_UPDATE_APPLY',build:'htmlmemo-two'})).ok,false);
  assert.equal((await two.message('page',{type:'HTMLMEMO_UPDATE_APPLY',build:'wrong'})).ok,false);assert.equal(two.skips,0);
  const three=f.worker('three');await three.event('install');assert.equal((await two.message('page',{type:'HTMLMEMO_UPDATE_APPLY',build:'htmlmemo-two'})).ok,false);
  assert.match(await(await one.fetch('',{navigation:true,next:'again'})).text(),/one/);
});
test('old app resources stay cached offline and cache cleanup is limited to this app scope',async()=>{
  const f=fixture();await f.caches.open('htmlmemo-other:/Other/');await f.caches.open('another-app');f.client('page');const one=f.worker('one');await one.event('install');await one.event('activate');await one.fetch('',{navigation:true,next:'page'});
  f.requests.length=0;f.network.clear();assert.match(await(await one.fetch('styles.css?reload=1',{id:'page'})).text(),/one/);assert.equal(f.requests.length,0);
  const two=f.worker('two');await two.event('install');await two.message('page',{type:'HTMLMEMO_UPDATE_APPLY',build:'htmlmemo-two'});f.clients.clear();await two.event('activate');
  assert.ok(!f.stores.has('htmlmemo-one:/HTMLMemo/'));assert.ok(f.stores.has('htmlmemo-other:/Other/'));assert.ok(f.stores.has('another-app'));
  assert.equal(await two.fetch('https://foreign.test/file.js'),null);assert.equal(await two.fetch('styles.css',{method:'POST'}),null);
});
