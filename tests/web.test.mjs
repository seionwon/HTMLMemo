import test from 'node:test';
import assert from 'node:assert/strict';
import {readWebPage,pastedPage,webURL,WEB_RESOURCE_LIMIT,PASTE_LIMIT,BrowserTabs,isWebSearch} from '../public/src/web.js';
import {installDOM} from './dom.mjs';
installDOM();
function browser(){const tabs=[],events=[];return {tabs,events,open(){events.push('blank');const tab={opener:'app',closed:false,document:{createElement:()=>({}),head:{append:meta=>events.push(meta.content)}},location:{replace(url){events.push('navigate');assert.equal(tab.opener,null);this.href=url;}},focus(){events.push('focus');},close(){this.closed=true;}};tabs.push(tab);return tab;}};}
test('browser handoff validates URLs before opening and isolates the opener before navigation',()=>{const b=browser(),tabs=new BrowserTabs(b);assert.throws(()=>tabs.open('x','javascript:alert(1)'));assert.equal(b.tabs.length,0);assert.equal(tabs.open('x','https://site.example/'),'opened');assert.equal(b.tabs[0].opener,null);assert.deepEqual(b.events,['blank','no-referrer','navigate','focus']);});
test('browser handoff reuses only owned references and never reads a destination address or content',()=>{const b=browser(),tabs=new BrowserTabs(b);tabs.open('x','https://site.example/');Object.defineProperty(b.tabs[0],'document',{get(){assert.fail('Remote DOM read');}});Object.defineProperty(b.tabs[0].location,'href',{get(){assert.fail('Remote URL read');},set(value){b.events.push(value);}});assert.equal(tabs.open('x','https://site.example/'),'focused');assert.equal(b.tabs.length,1);assert.equal(tabs.open('x','https://site.example/next'),'focused');assert.equal(b.events.at(-2),'https://site.example/next');});
test('closed or COOP-severed references reopen only on explicit action; forgetting never closes user browsing tabs',()=>{const b=browser(),tabs=new BrowserTabs(b);tabs.open('x','https://site.example/');b.tabs[0].closed=true;assert.equal(tabs.available('x'),false);assert.equal(b.tabs.length,1);tabs.open('x','https://site.example/');assert.equal(b.tabs.length,2);tabs.forget('x');assert.equal(b.tabs[1].closed,false);assert.equal(tabs.available('x'),false);});
test('popup blocking and focus denial return recoverable status without automatic duplicate tabs',()=>{let calls=0;const blocked=new BrowserTabs({open(){calls++;return null;}});assert.equal(blocked.open('x','https://site.example/'),'blocked');assert.equal(calls,1);const b=browser(),tabs=new BrowserTabs(b);tabs.open('x','https://site.example/');b.tabs[0].focus=()=>{throw Error('Focus denied');};assert.equal(tabs.open('x','https://site.example/'),'unavailable');assert.equal(b.tabs.length,1);});
test('search-result import does not pretend that the search URL is the article URL',()=>{assert.equal(isWebSearch('https://www.google.com/search?q=book'),true);assert.equal(isWebSearch('https://source.example/article'),false);assert.equal(isWebSearch('not a URL'),false);});
function response(body,type='text/html; charset=utf-8',url='https://source.example/article'){
  const r=new Response(body,{headers:{'content-type':type}});Object.defineProperty(r,'url',{value:url});return r;
}
test('direct web reading accepts only HTTP(S), never credential-bearing or executable URLs',()=>{
  assert.equal(webURL('https://source.example/a?q=1#x'),'https://source.example/a?q=1#x');
  for(const url of ['javascript:alert(1)','file:///private.html','https://user:password@source.example/'])assert.throws(()=>webURL(url),/http 또는 https/);
});
test('direct reading uses CORS without cookies or a proxy and preserves the redirected source/base for capture',async()=>{
  const calls=[];let captured;
  const result=await readWebPage('https://source.example/start',{fetchPage:async(url,options)=>{calls.push({url,options});return response('<html><head><base href="../assets/"><title>문서</title></head><body><p>내용</p></body></html>','text/html; charset=utf-8','https://source.example/book/page');},capture:async(doc,options)=>{captured={doc,options};return {title:doc.title,url:options.url};}});
  assert.equal(result.url,'https://source.example/book/page');assert.equal(captured.doc.querySelectorAll('base').length,1);assert.equal(captured.doc.querySelector('base').getAttribute('href'),'https://source.example/assets/');
  assert.equal(calls[0].url,'https://source.example/start');assert.equal(calls[0].options.mode,'cors');assert.equal(calls[0].options.credentials,'omit');assert.equal(calls[0].options.referrerPolicy,'no-referrer');assert.ok(calls[0].options.signal);
  await captured.options.fetchResource('https://source.example/image.png');assert.equal(calls[1].options.credentials,'omit');
});
test('HTTP failures, non-HTML data, network/CORS failures and unsupported encodings never reach capture',async()=>{
  let captured=0;const capture=()=>captured++;
  await assert.rejects(readWebPage('https://source.example/',{fetchPage:async()=>new Response('',{status:403}),capture}),/403/);
  await assert.rejects(readWebPage('https://source.example/',{fetchPage:async()=>response('binary','image/png'),capture}),/HTML 웹페이지/);
  await assert.rejects(readWebPage('https://source.example/',{fetchPage:async()=>{throw new TypeError('CORS blocked');},capture}),/CORS blocked/);
  await assert.rejects(readWebPage('https://source.example/',{fetchPage:async()=>response('text','text/html; charset=not-an-encoding'),capture}),/인코딩/);
  assert.equal(captured,0);
});
test('declared and streamed resource size limits stop reading before capture',async()=>{
  let cancelled=0,released=0;
  for(const advertised of [true,false]){
    const r={ok:true,url:'https://source.example/',headers:{get:key=>key==='content-length'?(advertised?String(WEB_RESOURCE_LIMIT+1):null):'text/html'},body:{getReader:()=>({read:async()=>({done:false,value:{length:WEB_RESOURCE_LIMIT+1}}),cancel:async()=>cancelled++,releaseLock:()=>released++})}};
    await assert.rejects(readWebPage('https://source.example/',{fetchPage:async()=>r,capture:()=>assert.fail('Oversized capture')}),/25MB/);
  }
  assert.equal(cancelled,1);assert.equal(released,1);
});
test('fetched-page script handling and complete-book protection are delegated to the safe snapshotter',async()=>{
  await assert.rejects(readWebPage('https://source.example/',{fetchPage:async()=>response('<script id="book-manifest">book</script>'),capture:()=>{throw Error('완전한 원본 HTML 파일을 열어 주세요.');}}),/원본 HTML/);
});
test('pasted text becomes escaped, paragraph-preserving HTML with an optional validated source',()=>{
  const snapshot=pastedPage({title:'<제목>',text:'<script>alert(1)</script>\n다음 줄\n\n두 번째 문단',url:'https://source.example/a?q=1&b=2'});
  assert.match(snapshot.html,/&lt;script&gt;/);assert.doesNotMatch(snapshot.html,/<script>/);assert.match(snapshot.html,/다음 줄<\/p><p>두 번째 문단/);assert.match(snapshot.html,/<br>/);assert.match(snapshot.html,/&lt;제목&gt;/);assert.equal(snapshot.url,'https://source.example/a?q=1&b=2');assert.match(snapshot.html,/q=1&amp;b=2/);
});
test('empty/oversized pasted text and unsafe source addresses are rejected without silently truncating content',()=>{
  assert.throws(()=>pastedPage({text:' \n '}),/붙여넣어/);assert.throws(()=>pastedPage({text:'x'.repeat(PASTE_LIMIT+1)}),/200,000/);assert.throws(()=>pastedPage({text:'text',url:'javascript:alert(1)'}),/http 또는 https/);
  assert.equal(pastedPage({text:'내용'}).title,'붙여넣은 글');assert.equal(pastedPage({text:'내용'}).url,'');
});
