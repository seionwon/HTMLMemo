import test from 'node:test';
import assert from 'node:assert/strict';
import {pastedPage,PASTE_LIMIT} from '../public/src/web.js';
import {renderMarkdown} from '../public/src/markdown.js';
import {parseHTML} from '../public/src/document.js';
import {installDOM,documentFor} from './dom.mjs';
installDOM();
const page=(text,options={})=>documentFor(pastedPage({text,...options}).html);

test('markdown paste renders headings, emphasis, nested lists, quotes, rules and code as a document',()=>{
  const doc=page('# 학습 **노트**\n\n## 기본\n\n**중요**와 *강조*, ~~삭제~~, `inline()`\n\n- 첫 항목\n  - 하위 항목\n\n1. 순서\n2. 다음\n\n> 인용 문장\n\n---\n\n```js\nconst html = "<script>bad()</script>";\n```\n');
  assert.equal(doc.title,'학습 노트');assert.equal(doc.querySelectorAll('h1').length,1);assert.equal(doc.querySelector('h1 strong').textContent,'노트');assert.equal(doc.querySelector('h2').textContent,'기본');assert.equal(doc.querySelector('em').textContent,'강조');assert.equal(doc.querySelector('s').textContent,'삭제');assert.ok(doc.querySelector('ul ul li'));assert.equal(doc.querySelectorAll('ol>li').length,2);assert.equal(doc.querySelector('blockquote p').textContent,'인용 문장');assert.ok(doc.querySelector('hr'));assert.match(doc.querySelector('pre code.language-js').textContent,/<script>bad\(\)<\/script>/);assert.equal(doc.querySelector('script'),null);
});
test('tables, task lists, reference links and indented code survive preparation for annotation',()=>{
  const text='표와 할 일\n==========\n\n| 항목 | 상태 |\n| --- | ---: |\n| **책** | 읽음 |\n\n- [x] 완료\n- [ ] 예정\n\n[출처][ref]\n\n[ref]: https://example.com/book "원문"\n\n    <button>코드</button>\n';
  const snapshot=pastedPage({text}),parsed=parseHTML(snapshot.html),doc=documentFor(parsed.html);
  assert.equal(doc.querySelectorAll('table tbody tr').length,1);assert.equal(doc.querySelector('td strong').textContent,'책');assert.deepEqual([...doc.querySelectorAll('.markdown-task')].map(n=>n.textContent.trim()),['☑ 완료','☐ 예정']);assert.equal(doc.querySelector('a').getAttribute('href'),'https://example.com/book');assert.equal(doc.querySelector('a').title,'원문');assert.equal(doc.querySelector('pre code').textContent.trim(),'<button>코드</button>');assert.equal(doc.querySelector('button'),null);
});
test('plain text keeps line breaks, paragraphs and literal HTML without a format switch',()=>{
  const doc=page('일반 글 첫 줄\r\n둘째 줄\r\n\r\n다음 문단\r\n<script>window.evil=true</script>');
  assert.equal(doc.querySelectorAll('article>p').length,2);assert.equal(doc.querySelectorAll('br').length,2);assert.match(doc.body.textContent,/<script>window.evil=true<\/script>/);assert.equal(doc.querySelector('script'),null);assert.equal(doc.title,'붙여넣은 글');
  assert.equal(page('    first indented code\n    second line').querySelector('pre code').textContent,'first indented code\nsecond line\n');
});
test('a supplied title is preserved and generated heading IDs remain unique and usable',()=>{
  const doc=page('# 같은 제목\n\n## 같은 제목\n\n## 같은 제목-1\n\n[이동](#같은-제목-1)',{title:'직접 정한 제목'});
  assert.equal(doc.title,'직접 정한 제목');assert.equal(doc.querySelector('article>h1').textContent,'직접 정한 제목');
  const ids=[...doc.querySelectorAll('[id]')].map(n=>n.id);assert.equal(new Set(ids).size,ids.length);assert.deepEqual(ids,['md-같은-제목','md-같은-제목-1','md-같은-제목-1-1']);assert.equal(decodeURIComponent(doc.querySelector('a').getAttribute('href')),'#md-같은-제목-1');
  const separate=page('# 같은 제목');assert.equal(separate.querySelector('h1').id,'md-같은-제목');
  const long=page('# '+('긴 제목'.repeat(100)));assert.equal(long.title.length,300);assert.equal(long.querySelectorAll('h1').length,1);
});
test('technical heading names never collide with annotation metadata or book runtime elements',()=>{
  const text='# htmlmemo-data\n\n본문을 보존합니다.\n\n## reader-tree\n\n## reader-content\n\n## htmlmemo-annotation-layer\n\n[이동](#reader-content)';
  const snapshot=pastedPage({text}),parsed=parseHTML(snapshot.html),doc=documentFor(parsed.html);
  assert.deepEqual(parsed.metadata.warnings,[]);assert.equal(parsed.metadata.annotations.length,0);assert.equal(doc.querySelector('#htmlmemo-data'),null);assert.equal(doc.querySelector('#reader-tree'),null);assert.equal(doc.querySelector('#reader-content'),null);assert.equal(doc.querySelector('#md-htmlmemo-data').textContent,'htmlmemo-data');assert.equal(doc.querySelector('#md-reader-content').textContent,'reader-content');assert.equal(doc.querySelector('a').getAttribute('href'),'#md-reader-content');assert.ok(doc.body.textContent.includes('본문을 보존합니다.'));
});
test('relative links use the actual source, and unsupported or credential URLs cannot become links',()=>{
  const text='[다음](../next?q=1) [메일](mailto:reader@example.com) [전화](tel:+821012345678) [보류](custom:open) [비밀](https://user:password@example.com/)';
  const withSource=page(text,{url:'https://example.com/book/chapter'});
  assert.deepEqual([...withSource.querySelectorAll('a')].map(n=>n.getAttribute('href')),['https://example.com/next?q=1','mailto:reader@example.com','tel:+821012345678','https://example.com/book/chapter']);
  assert.equal(page('[다음](../next)').querySelector('a'),null);assert.match(page('[다음](../next)').body.textContent,/다음/);
  for(const source of ['[x](javascript:alert%281%29)','[x](vbscript:msgbox%281%29)','[x](data:text/html;base64,PHNjcmlwdD4=)','<img src=x onerror=alert(1)>','<iframe srcdoc="<script>alert(1)</script>"></iframe>','[x](JaVaScRiPt:alert%281%29)']){
    const doc=page(source);assert.equal(doc.querySelector('script,iframe,object,embed,img'),null);assert.equal(doc.querySelector('a'),null);assert.equal(doc.querySelector('[onerror],[onclick]'),null);
  }
});
test('external images are saved as source links and raster data images remain embedded',()=>{
  const data='data:image/png;base64,iVBORw0KGgo=',doc=page('![그림](https://example.com/p.png)\n\n![내장]('+data+')\n\n[![링크 안 그림](https://example.com/b.png)](https://example.com/article)');
  assert.equal(doc.querySelectorAll('img').length,1);assert.equal(doc.querySelector('img').getAttribute('src'),data);assert.equal(doc.querySelector('img').getAttribute('alt'),'내장');assert.equal(doc.querySelector('.markdown-image-link').getAttribute('href'),'https://example.com/p.png');assert.equal(doc.querySelector('a a'),null);assert.equal(doc.querySelectorAll('a').length,2);
  assert.equal(page('![x](data:image/svg+xml;base64,PHN2Zz4=)').querySelector('img'),null);
});
test('maximum-size and deeply nested markdown are bounded without fetching resources',()=>{
  const text=('[unclosed\n').repeat(18000).slice(0,PASTE_LIMIT),start=performance.now(),out=renderMarkdown(text);
  assert.ok(out.html.includes('unclosed'));assert.ok(performance.now()-start<5000);
  const nested=page('> '.repeat(2000)+'깊은 인용');assert.ok(nested.body.textContent.includes('깊은 인용'));assert.ok(nested.querySelectorAll('blockquote').length<=32);
  assert.throws(()=>pastedPage({text:'# '+('x'.repeat(PASTE_LIMIT))}),/200,000/);
});
test('many repeated headings keep unique IDs without rescanning every previous heading',()=>{
  const start=performance.now(),out=renderMarkdown(('# A\n').repeat(20000));assert.ok(performance.now()-start<5000);
  const ids=[...out.html.matchAll(/id="([^"]+)"/g)].map(match=>match[1]);assert.equal(ids.length,20000);assert.equal(new Set(ids).size,20000);assert.equal(ids[0],'md-a');assert.equal(ids.at(-1),'md-a-19999');
});
