import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import ts from '/Users/ls/workspace/MemoSuite/node_modules/typescript/lib/typescript.js';

const text=await readFile('/tmp/htmlmemo-pages-run-ProjectConsole.tsx','utf8');
const result=ts.transpileModule(text,{fileName:'ProjectConsole.tsx',reportDiagnostics:true,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.React}});
assert.deepEqual(result.diagnostics.filter(d=>d.category===ts.DiagnosticCategory.Error),[]);
const tree=ts.createSourceFile('ProjectConsole.tsx',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let panel;
function walk(node){if(ts.isVariableDeclaration(node)&&node.name.getText(tree)==='RunPanel')panel=node.getText(tree);ts.forEachChild(node,walk);}walk(tree);
assert.ok(panel);
const compiled=ts.transpileModule('const '+panel+';globalThis.RunPanel=RunPanel;', {compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;
function render(project,{denyClipboard=false}={}){
 const calls={opened:[],copied:[],preview:0,meta:[],state:[]},effects=[];let stateIndex=0;
 const React={createElement(type,props,...children){return {type,props:props||{},children:children.flat(Infinity).filter(x=>x!==null&&x!==undefined&&x!==false)};},Fragment:'fragment',useState(initial){const index=stateIndex++;return [index===8?'index.html':initial, value=>calls.state.push(value)];},useRef:value=>({current:value}),useEffect:fn=>effects.push(fn),useCallback:fn=>fn};
 const context={React,useLanguage:()=>({t:{}}),loadRun:()=>null,tc:(t,key,fallback)=>fallback,window:{open:(...args)=>calls.opened.push(args)},navigator:{clipboard:{writeText:async value=>{if(denyClipboard)throw Error('denied');calls.copied.push(value);}}},ccPreviewUrl:async()=>{calls.preview++;return 'https://preview.example/';}};
 for(const name of [...compiled.matchAll(/\b[A-Z][A-Za-z0-9]+\b/g)].map(m=>m[0]))if(!(name in context))context[name]=name in globalThis?globalThis[name]:name;
 vm.createContext(context);new vm.Script(compiled).runInContext(context);
 const output=context.RunPanel({project,onRunChange(){},onPathSave(){},onMeta:value=>calls.meta.push(value)});
 const nodes=[];function collect(n){if(!n||typeof n!=='object')return;nodes.push(n);for(const child of n.children||[])collect(child);}collect(output);
 const button=label=>nodes.find(n=>n.type==='Btn'&&(n.children||[]).includes(label));
 return {calls,nodes,button,effects};
}
const URL='https://seionwon.github.io/HTMLMemo/';let scenarios=0;
for(const path of ['HTMLMemo','CodeMemo/HTMLMemo','/Users/ls/MemoSuite/code-projects/u1/CodeMemo/HTMLMemo','C:\\Projects\\HTMLMemo\\']){
 for(const webKind of ['app','static',undefined]){
  const r=render({id:'project',path,webKind,liveUrl:'http://localhost:4173/'});
  const open=r.button('Open in browser');assert.ok(open,'Open button exists');await open.props.onClick();
  assert.equal(r.calls.opened[0][0],URL);assert.equal(r.calls.preview,0,'Never opens a localhost preview');
  await r.button('Copy link').props.onClick();assert.deepEqual(r.calls.copied,[URL]);
  assert.ok(r.nodes.some(n=>n.type==='a'&&n.props.href===URL));
  assert.equal(r.nodes.some(n=>n.type==='RunDeploymentZip'),false);
  assert.equal(r.nodes.some(n=>n.type==='Input'&&String(n.props.placeholder).includes('Public URL')),false);
  assert.equal(r.nodes.some(n=>n.type==='Input'&&String(n.props.placeholder).includes('run command')),false);
  const reconcile=r.effects.find(fn=>fn.toString().includes('liveUrl: pagesUrl'));assert.ok(reconcile);reconcile();
  assert.equal(r.calls.meta[0].liveUrl,URL);assert.equal(r.calls.meta[0].webKind,'app');scenarios++;
 }
}
const denied=render({id:'project',path:'HTMLMemo',webKind:'app',liveUrl:'http://localhost:4173/'},{denyClipboard:true});
await denied.button('Copy link').props.onClick();assert.ok(denied.calls.state.includes(URL));scenarios++;
for(const path of ['OtherProject','HTMLMemoOther']){
 const r=render({id:'other',path,webKind:'app',liveUrl:'https://other.example/app/'});await r.button('Open in browser').props.onClick();assert.equal(r.calls.opened[0][0],'https://other.example/app/');scenarios++;
}
const staticProject=render({id:'static',path:'StaticExample',webKind:'static'});await staticProject.button('Open in browser').props.onClick();assert.equal(staticProject.calls.preview,1);assert.equal(staticProject.calls.opened[0][0],'https://preview.example/');scenarios++;
console.log('Complete TSX syntax passed; '+scenarios+' RunPanel scenarios passed, including actual open/copy handlers, stale metadata, controls and unrelated projects.');
