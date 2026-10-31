import test from 'node:test';
import assert from 'node:assert/strict';
import CSSOM from 'cssom';
import {readerSidebarCSS} from '../public/src/utils.js';

test('native sidebar keeps compiled feature and media conditions without importing document-wide styles',()=>{
  const sheet=CSSOM.parse(`body{color:red}
    :is(#sidebar,[data-htmlmemo-doc-sidebar-ui]) button{border:1px solid blue}
    @supports (color:color-mix(in srgb,red,blue)){
      :is(#sidebar,[data-htmlmemo-doc-sidebar-ui]) button{border-color:color-mix(in srgb,red,blue)}
      body{background:red}
      @media (max-width:400px){[data-htmlmemo-native-sidebar]{padding:4px}}
    }
    @media (min-width:900px){body{padding:20px}}`);
  const text=readerSidebarCSS(sheet.cssRules),copied=CSSOM.parse(text);
  assert.equal(copied.cssRules.length,2);
  assert.equal(copied.cssRules[0].selectorText,':is(#sidebar,[data-htmlmemo-doc-sidebar-ui]) button');
  const feature=copied.cssRules[1];assert.match(feature.cssText,/^@supports/);assert.equal(feature.cssRules.length,2);
  assert.equal(feature.cssRules[0].style.getPropertyValue('border-color'),'color-mix(in srgb,red,blue)');
  const media=feature.cssRules[1];assert.match(media.cssText,/^@media \(max-width:400px\)/);assert.equal(media.cssRules[0].style.padding,'4px');
  assert.doesNotMatch(text,/body|900px/);
});
