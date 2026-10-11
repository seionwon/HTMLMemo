import test from 'node:test';
import assert from 'node:assert/strict';
import { InstallController, isIOS, installableLocation, installationURL, PUBLIC_APP_URL } from '../public/src/install.js';

function controller({navigator={},address=PUBLIC_APP_URL,standalone=false}={}) {
  const listeners=new Map(),states=[],guides=[];
  const window={addEventListener:(name,fn)=>listeners.set(name,fn)};
  const media={matches:standalone,addEventListener:(name,fn)=>listeners.set('display-change',fn)};
  const install=new InstallController({window,navigator,location:new URL(address),matchMedia:()=>media,onChange:state=>states.push(state),onGuide:kind=>guides.push(kind)});
  return {install,states,guides,emit:(name,event={})=>listeners.get(name)?.(event)};
}

test('iPhone and desktop-mode iPad get the iOS procedure, while Macs and Android do not',()=>{
  assert.equal(isIOS({userAgent:'Mozilla/5.0 (iPhone) CriOS/140'}),true);
  assert.equal(isIOS({userAgent:'Mozilla/5.0 (Macintosh)',platform:'MacIntel',maxTouchPoints:5}),true);
  assert.equal(isIOS({platform:'MacIntel',maxTouchPoints:0}),false);
  assert.equal(isIOS({userAgent:'Mozilla/5.0 (Android) Chrome/140'}),false);
});

test('a native prompt is consumed once and dismissal keeps the installation entry usable',async()=>{
  const ctx=controller();let prompted=0,prevented=0;
  ctx.emit('beforeinstallprompt',{preventDefault:()=>prevented++,prompt:async()=>prompted++,userChoice:Promise.resolve({outcome:'dismissed'})});
  assert.equal(ctx.states.at(-1).ready,true);
  assert.equal(await ctx.install.install(),'dismissed');
  assert.equal(ctx.states.at(-1).busy,false);assert.equal(ctx.states.at(-1).installed,false);
  await ctx.install.install();assert.deepEqual(ctx.guides,['browser']);assert.equal(prompted,1);assert.equal(prevented,1);
});

test('iOS never pretends to open the native install prompt from the app button',async()=>{
  const ctx=controller({navigator:{userAgent:'iPhone CriOS/140'}});let prompted=false;
  ctx.emit('beforeinstallprompt',{preventDefault(){},prompt:async()=>prompted=true,userChoice:Promise.resolve({outcome:'accepted'})});
  await ctx.install.install();assert.deepEqual(ctx.guides,['ios']);assert.equal(prompted,false);assert.equal(ctx.states.at(-1).installed,false);
});

test('prompt errors restore the button and a later browser event can retry',async()=>{
  const ctx=controller();ctx.emit('beforeinstallprompt',{preventDefault(){},prompt:async()=>{throw new Error('Prompt failed');}});
  await assert.rejects(ctx.install.install(),/Prompt failed/);assert.equal(ctx.states.at(-1).busy,false);
  ctx.emit('beforeinstallprompt',{preventDefault(){},prompt:async()=>{},userChoice:Promise.resolve({outcome:'accepted'})});
  assert.equal(await ctx.install.install(),'accepted');assert.equal(ctx.states.at(-1).installed,false);
  ctx.emit('appinstalled');assert.equal(ctx.states.at(-1).installed,true);
});

test('local files and insecure remote pages cannot invoke installation even if an event arrives',async()=>{
  for(const address of ['file:///Users/private/HTMLMemo.html','http://example.test/']){
    const ctx=controller({address});let prompted=false;
    ctx.emit('beforeinstallprompt',{preventDefault(){},prompt:async()=>prompted=true});
    await ctx.install.install();assert.deepEqual(ctx.guides,['local']);assert.equal(prompted,false);
  }
  for(const address of [PUBLIC_APP_URL,'http://localhost:4173/','http://127.0.0.1/','http://[::1]/'])assert.equal(installableLocation(new URL(address)),true);
});

test('standalone detection and appinstalled lead to the installed state without another prompt',async()=>{
  for(const options of [{standalone:true},{navigator:{standalone:true}}]){
    const ctx=controller(options);await ctx.install.install();assert.equal(ctx.states.at(-1).installed,true);assert.deepEqual(ctx.guides,['installed']);
  }
  const ctx=controller();ctx.emit('display-change',{matches:true});assert.equal(ctx.states.at(-1).installed,true);
});

test('handoff addresses retain the project scope and drop private file paths, queries and credentials',()=>{
  assert.equal(installationURL(new URL('https://sweon.github.io/HTMLMemo/index.html?capture=private#note')),PUBLIC_APP_URL);
  assert.equal(installationURL(new URL('https://name:secret@example.test/project/?token=private')),'https://example.test/project/');
  assert.equal(installationURL(new URL('file:///Users/private/HTMLMemo.html')),PUBLIC_APP_URL);
  assert.equal(installationURL(new URL('chrome-extension://id/app/index.html')),PUBLIC_APP_URL);
});
