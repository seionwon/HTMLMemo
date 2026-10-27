import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {CDP} from './chrome.mjs';

test('Chrome input targets the current button after a library redraw during animation frames',async()=>{
 const {document}=parseHTML('<html><body><button id="action">메뉴</button></body></html>'),old=document.querySelector('#action'),replacement=document.createElement('button');replacement.id='action';
 old.scrollIntoView=()=>{};replacement.scrollIntoView=()=>{};
 old.getBoundingClientRect=()=>old.isConnected?{x:100,y:200,width:80,height:40}:{x:0,y:0,width:0,height:0};replacement.getBoundingClientRect=()=>({x:100,y:200,width:80,height:40});
 let changed=false;const context=vm.createContext({document,requestAnimationFrame:callback=>{if(!changed){changed=true;old.replaceWith(replacement);}queueMicrotask(callback);}}),clicks=[];
 const page=Object.create(CDP.prototype);page.evaluate=expression=>vm.runInContext(expression,context);page.send=async(method,params)=>clicks.push({method,params});
 await page.click('#action');assert.equal(clicks.length,2);for(const click of clicks){assert.equal(click.params.x,140);assert.equal(click.params.y,220);}assert.equal(clicks[0].params.type,'mousePressed');assert.equal(clicks[1].params.type,'mouseReleased');
});
