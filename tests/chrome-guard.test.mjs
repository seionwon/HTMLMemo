import test from 'node:test';
import assert from 'node:assert/strict';
import { launchChrome } from './chrome.mjs';
test('restricted macOS browser verification fails before spawning Chrome', {skip: process.platform !== 'darwin'}, async()=>{
 const prior=process.env.CODEMEMO_BROWSER_AUTOMATION;
 process.env.CODEMEMO_BROWSER_AUTOMATION='unavailable';
 try{await assert.rejects(launchChrome(),/unavailable in the macOS agent sandbox/);}
 finally{if(prior===undefined)delete process.env.CODEMEMO_BROWSER_AUTOMATION;else process.env.CODEMEMO_BROWSER_AUTOMATION=prior;}
});
