import test from 'node:test';
import assert from 'node:assert/strict';
import {CDP} from './chrome.mjs';

test('a same-URL Chrome reload cannot reuse the old completed document as its readiness signal',async()=>{
  let frameReads=0,waited=false;
  const page={async send(method){if(method==='Page.navigate')return {loaderId:'new-document'};assert.equal(method,'Page.getFrameTree');frameReads++;return {frameTree:{frame:{loaderId:frameReads<2?'old-document':'new-document'}}};},async waitFor(expression){assert.equal(frameReads,2,'the old complete document must not be queried');assert.match(expression,/readyState/);waited=true;}};
  await CDP.prototype.navigate.call(page,'https://example.test/same-url/');assert.equal(waited,true);
});
test('Chrome navigation reports failures and accepts same-document navigation without inventing a new loader',async()=>{
  let waited=false;
  await assert.rejects(CDP.prototype.navigate.call({send:async()=>({errorText:'offline'}),waitFor(){throw Error('must not query the old page');}},'https://example.test/'),/offline/);
  await CDP.prototype.navigate.call({send:async()=>({}),waitFor:async()=>{waited=true;}},'https://example.test/#anchor');assert.equal(waited,true);
});
