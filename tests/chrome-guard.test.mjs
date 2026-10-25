import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import { launchChrome } from './chrome.mjs';
test('both browser suites import only existing shared helpers without launching Chrome',async()=>{
 const helpers=await import('./chrome.mjs');
 for(const name of ['browser.integration.mjs','browser-tts.integration.mjs']){
  const source=await readFile(new URL(name,import.meta.url),'utf8'),imports=[...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]\.\/chrome\.mjs['"]/gu)];
  assert.ok(imports.length>0,name+' must declare its shared browser helpers');
  for(const match of imports)for(const binding of match[1].split(',')){const imported=binding.trim().split(/\s+as\s+/u)[0];assert.ok(Object.hasOwn(helpers,imported),name+' imports missing helper '+imported);}
 }
});
test('restricted macOS browser verification fails before spawning Chrome', {skip: process.platform !== 'darwin'}, async()=>{
 const prior=process.env.CODEMEMO_BROWSER_AUTOMATION;
 process.env.CODEMEMO_BROWSER_AUTOMATION='unavailable';
 try{await assert.rejects(launchChrome(),/unavailable in the macOS agent sandbox/);}
 finally{if(prior===undefined)delete process.env.CODEMEMO_BROWSER_AUTOMATION;else process.env.CODEMEMO_BROWSER_AUTOMATION=prior;}
});
