import { spawn } from 'node:child_process';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export class CDP {
  constructor(socket){this.socket=socket;this.serial=0;this.pending=new Map();this.listeners=new Map();this.contexts=new Map();this.runnerSessions=new Map();socket.addEventListener('message',event=>{
    const message=JSON.parse(event.data);if(message.id){const pending=this.pending.get(message.id);if(!pending)return;clearTimeout(pending.timer);this.pending.delete(message.id);message.error?pending.reject(new Error(message.error.message)):pending.resolve(message.result);}
    else {if(message.method==='Runtime.executionContextCreated')this.contexts.set((message.sessionId||'')+':'+message.params.context.id,{...message.params.context,sessionId:message.sessionId});if(message.method==='Runtime.executionContextDestroyed')this.contexts.delete((message.sessionId||'')+':'+message.params.executionContextId);if(message.method==='Runtime.executionContextsCleared')this.contexts.clear();for(const listener of this.listeners.get(message.method)||[])listener(message.params);}
  });}
  static async connect(url){const socket=new WebSocket(url);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});return new CDP(socket);}
  send(method,params={},sessionId){return new Promise((resolve,reject)=>{const id=++this.serial;const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('CDP timeout: '+method));},20000);this.pending.set(id,{resolve,reject,timer});this.socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});}
  on(method,listener){if(!this.listeners.has(method))this.listeners.set(method,[]);this.listeners.get(method).push(listener);}
  async evaluate(expression){const result=await this.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value;}
  // Read test instrumentation in the opaque source, never copy source globals
  // into the app or grant production RPC access to arbitrary properties.
  async scriptEvaluate(expression){
    const {result:owner}=await this.send('Runtime.evaluate',{expression:'document.querySelector(".document-host:not([hidden]) iframe[data-htmlmemo-runtime-runner]")'});
    if(!owner.objectId)throw Error('No active isolated runtime');
    const {node}=await this.send('DOM.describeNode',{objectId:owner.objectId});await this.send('Runtime.releaseObject',{objectId:owner.objectId});
    const context=[...this.contexts.values()].find(c=>c.auxData?.frameId===node.frameId&&c.auxData?.isDefault);
    let sessionId=context?.sessionId;
    if(!context){
      sessionId=this.runnerSessions.get(node.frameId);
      if(!sessionId){const attached=await this.send('Target.attachToTarget',{targetId:node.frameId,flatten:true});sessionId=attached.sessionId;this.runnerSessions.set(node.frameId,sessionId);}
    }
    const result=await this.send('Runtime.evaluate',{expression,...(context?{contextId:context.id}:{}),awaitPromise:true,returnByValue:true,userGesture:true},sessionId);if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value;
  }
  async scriptWaitFor(expression,timeout=15000){const start=Date.now();while(Date.now()-start<timeout){try{if(await this.scriptEvaluate(expression))return;}catch{}await delay(100);}throw Error('Timed out waiting for isolated source: '+expression);}
  async waitFor(expression,timeout=15000){const start=Date.now();while(Date.now()-start<timeout){try{if(await this.evaluate(expression))return;}catch{/* Execution contexts disappear during navigation. */}await delay(100);}throw new Error('Timed out waiting for: '+expression);}
  async navigate(url){await this.send('Page.navigate',{url});await this.waitFor('document.readyState === "complete"');}
  async click(selector){const rect=await this.evaluate(`(async()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element||element.hidden)throw Error('Missing element: '+${JSON.stringify(selector)});element.scrollIntoView({block:'nearest',inline:'nearest'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const r=element.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);await this.send('Input.dispatchMouseEvent',{type:'mousePressed',x:rect.x,y:rect.y,button:'left',clickCount:1});await this.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:rect.x,y:rect.y,button:'left',clickCount:1});}
  async screenshot(){const result=await this.send('Page.captureScreenshot',{format:'png'});return Buffer.from(result.data,'base64');}
  async close(){this.socket.close();for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(new Error('CDP closed'));}this.pending.clear();}
}
export async function launchChrome({firstRun=false}={}){
  if(process.platform==='darwin'&&(process.env.CODEX_SANDBOX==='seatbelt'||process.env.CODEMEMO_BROWSER_AUTOMATION==='unavailable'))
    throw new Error('Browser verification is unavailable in the macOS agent sandbox. Run in CI or a trusted verification environment; do not retry desktop Chrome.');
  const paths=[process.env.CHROME_PATH,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser'].filter(Boolean);let executable;
  for(const path of paths){try{await access(path);executable=path;break;}catch{/* try next platform */}}
  if(!executable)throw new Error('Chrome is required for browser tests. Set CHROME_PATH to its executable.');
  const profile=await mkdtemp(join(tmpdir(),'htmlmemo-chrome-'));
  const child=spawn(executable,['--headless=new','--no-sandbox','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:['ignore','ignore','pipe']});
  let output='';let endpoint;
  // A fresh CI runner can take longer to start its first browser than later
  // profiles. Keep a finite startup limit without relaxing any page assertions.
  try{endpoint=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Chrome launch timeout: '+output.slice(-1800))),60000);child.stderr.on('data',chunk=>{output+=chunk.toString();const match=output.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(match){clearTimeout(timer);resolve(match[1]);}});child.once('exit',code=>{clearTimeout(timer);reject(new Error('Chrome exited '+code+': '+output.slice(-1800)));});});}
  catch(error){child.kill();await rm(profile,{recursive:true,force:true}).catch(()=>{});throw error;}
  const debugURL='http://'+new URL(endpoint).host;
  const targets=await fetch(debugURL+'/json/list').then(response=>response.json());const page=await CDP.connect(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await page.send('Page.enable');await page.send('Runtime.enable');
  // Keep routine reader tests independent from onboarding. The first-run test
  // explicitly opts into an untouched profile and exercises the real welcome.
  if(!firstRun)await page.send('Page.addScriptToEvaluateOnNewDocument',{source:"try{localStorage.setItem('htmlmemo-data-folder-welcome-v1','1')}catch{}"});
  const errors=[];page.on('Runtime.exceptionThrown',e=>errors.push(e.exceptionDetails.exception?.description||e.exceptionDetails.text));
  return {page,errors,process:child,profile,async close(){await page.close();child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(5000)]);if(child.exitCode===null)child.kill('SIGKILL');await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});}};
}

// Settings is opened directly from the icon; app delivery and About live inside it.
export async function clickSettingsAction(page,selector){
  if(!await page.evaluate('document.querySelector("#dialog").open&&!!document.querySelector("#appearance")'))await page.click('#settings-button');
  await page.waitFor('document.querySelector("#dialog").open&&!!document.querySelector("#settings-execution")');
  if(selector!=='#settings-button'){
    if(['#settings-save','#settings-load','#settings-reload'].includes(selector))await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).closest('details').open=true`);
    await page.click(selector);
  }
}

export async function clickLibraryImport(page){
  await page.click('#library-tab');
  await page.click('#hero-import');
}
