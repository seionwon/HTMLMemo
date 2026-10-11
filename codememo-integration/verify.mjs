import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { readFile, writeFile, stat, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMParser } from 'linkedom';

// The host is read only. All generated files stay in this integration directory.
const host = resolve(process.env.MEMOSUITE_ROOT || '/Users/ls/workspace/MemoSuite');
const here = fileURLToPath(new URL('.', import.meta.url));
const requireHost = createRequire(join(host, 'package.json'));
const ts = requireHost('typescript');
const React = requireHost('react');
const { createRoot } = requireHost('react-dom/client');
const componentSource = await readFile(join(here, 'RunDeploymentZip.tsx'), 'utf8');
const transpiled = ts.transpileModule(componentSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  reportDiagnostics: true,
});
assert.equal(transpiled.diagnostics?.length || 0, 0);

// Check the component's types against the existing workspace API contract.
const declarations = join(here, '.workspace-check.d.ts');
await writeFile(declarations, "export interface WorkFile { name: string; dir: boolean; size: number; mtime: number; hidden: boolean }\nexport declare function ccLs(id: string | number, rel: string): Promise<WorkFile[]>;\nexport declare function ccDownloadUrl(id: string | number, rel: string): Promise<{ url: string }>;\n");
const options = { strict: true, noEmit: true, skipLibCheck: true, jsx: ts.JsxEmit.React, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, moduleResolution: ts.ModuleResolutionKind.Bundler, esModuleInterop: true, typeRoots: [join(host, 'node_modules/@types')] };
const compilerHost = ts.createCompilerHost(options);
compilerHost.resolveModuleNames = (names, containing) => names.map(name => name === './workspace'
  ? { resolvedFileName: declarations, extension: ts.Extension.Dts }
  : name === 'react' ? { resolvedFileName: join(host, 'node_modules/@types/react/index.d.ts'), extension: ts.Extension.Dts, isExternalLibraryImport: true }
  : ts.resolveModuleName(name, containing, options, compilerHost).resolvedModule);
const program = ts.createProgram([join(here, 'RunDeploymentZip.tsx')], options, compilerHost);
const diagnostics = ts.getPreEmitDiagnostics(program);
await rm(declarations);
assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: f => f, getCurrentDirectory: () => here, getNewLine: () => '\n' }));

// Also parse the exact host integration without writing it back to CodeMemo.
const consolePath = join(host, 'apps/CodeMemo/src/components/Project/ProjectConsole.tsx');
const consoleSource = await readFile(consolePath, 'utf8');
const importPoint = "import { InviteMembersModal } from './InviteMembersModal';";
const renderPoint = "  return (\n    <div>\n      {webEntry && !android?.android && (";
assert.equal(consoleSource.split(importPoint).length, 2);
assert.equal(consoleSource.split(renderPoint).length, 2);
const proposedConsole = consoleSource.replace(importPoint, importPoint + "\nimport { RunDeploymentZip } from './RunDeploymentZip';")
  .replace(renderPoint, "  return (\n    <div>\n      <RunDeploymentZip projectId={project.id} projectPath={project.path} running={running} />\n      {webEntry && !android?.android && (");
const syntax = ts.transpileModule(proposedConsole, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true });
assert.equal(syntax.diagnostics?.length || 0, 0);

const bundle = { name: 'HTMLMemo-pages.zip', dir: false, size: (await stat(new URL('../dist/downloads/HTMLMemo-pages.zip', import.meta.url))).size, mtime: 1, hidden: false };
async function mount({ files = [bundle], readError = null, ticketError = false } = {}) {
  const doc = new DOMParser().parseFromString('<!doctype html><html><body><div id="root"></div></body></html>', 'text/html');
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  globalThis.window = doc.defaultView; globalThis.document = doc; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const timers = new Map(); let timerId = 0;
  const oldSetInterval = window.setInterval, oldClearInterval = window.clearInterval;
  window.setInterval = fn => { const id = ++timerId; timers.set(id, fn); return id; };
  window.clearInterval = id => timers.delete(id);
  const listings = [], tickets = [], downloads = [];
  doc.body.addEventListener('click', event => {
    if (event.target.tagName === 'A' && event.target.href.startsWith('https://download.example.test/')) {
      downloads.push({ url: event.target.href, name: event.target.download });
      event.preventDefault();
    }
  });
  const api = {
    async ccLs(id, rel) { listings.push({ id, rel }); if (readError) throw new Error(readError); return files; },
    async ccDownloadUrl(id, rel) { tickets.push({ id, rel }); if (ticketError) throw new Error('download token 503'); return { url: 'https://download.example.test/' + tickets.length }; },
  };
  const module = { exports: {} };
  const context = { module, exports: module.exports, document: doc, window: doc.defaultView, require: name => name === 'react' ? React : name === './workspace' ? api : requireHost(name) };
  new vm.Script(transpiled.outputText).runInNewContext(context);
  const root = createRoot(doc.getElementById('root'));
  await React.act(async () => { root.render(React.createElement(context.module.exports.RunDeploymentZip, { projectId: 'htmlmemo-id', projectPath: 'HTMLMemo', running: false })); });
  return {
    doc, listings, tickets, downloads, timers,
    async click() {
      const event = new window.Event('click', { bubbles: true, cancelable: true });
      await React.act(async () => { doc.querySelector('section a').dispatchEvent(event); });
      return event.defaultPrevented;
    },
    async poll() { await React.act(async () => { for (const fn of timers.values()) await fn(); }); },
    setFiles(next) { files = next; }, setTicketError(next) { ticketError = next; },
    async close() {
      await React.act(async () => root.unmount());
      assert.equal(timers.size, 0);
      window.setInterval = oldSetInterval; window.clearInterval = oldClearInterval;
      globalThis.window = previous.window; globalThis.document = previous.document; globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
    },
  };
}

test('the real React component shows the built Pages ZIP even without a run log or web classification', async () => {
  const app = await mount();
  try {
    assert.match(app.doc.querySelector('section').textContent, /HTMLMemo-pages\.zip/);
    assert.equal(app.doc.querySelector('section a').textContent, '배포 ZIP 다운로드');
    assert.deepEqual(app.listings, [{ id: 'htmlmemo-id', rel: 'dist/downloads' }]);
    assert.equal(await app.click(), true);
    assert.deepEqual(app.tickets, [{ id: 'htmlmemo-id', rel: 'dist/downloads/HTMLMemo-pages.zip' }]);
    assert.deepEqual(app.downloads, [{ url: 'https://download.example.test/1', name: 'HTMLMemo-pages.zip' }]);
    await app.click(); assert.equal(app.tickets.length, 2); assert.equal(app.downloads[1].url, 'https://download.example.test/2');
  } finally { await app.close(); }
});

test('a missing build is quiet and an externally generated archive appears on refresh', async () => {
  const app = await mount({ files: [] });
  try {
    assert.equal(app.doc.querySelector('section'), null);
    app.setFiles([bundle]); await app.poll();
    assert.match(app.doc.querySelector('section a').textContent, /배포 ZIP 다운로드/);
    app.setFiles([]); await app.poll(); assert.equal(app.doc.querySelector('section'), null);
  } finally { await app.close(); }
});

test('folders, unrelated ZIPs and traversal filenames are excluded', async () => {
  const app = await mount({ files: [
    { ...bundle, name: 'HTMLMemo-chrome.zip' }, { ...bundle, name: 'private.zip' },
    { ...bundle, name: '../secret-pages.zip' }, { ...bundle, name: 'dir\\secret-pages.zip' },
    { ...bundle, dir: true }, { ...bundle, size: 0 },
  ] });
  try { assert.equal(app.doc.querySelector('section'), null); } finally { await app.close(); }
});

test('a failed download restores the link for an explicit retry', async () => {
  const app = await mount({ ticketError: true });
  try {
    await app.click(); assert.equal(app.downloads.length, 0);
    assert.match(app.doc.querySelector('[role=alert]').textContent, /다시 눌러/);
    assert.equal(app.doc.querySelector('section a').getAttribute('aria-disabled'), 'false');
    app.setTicketError(false); await app.click(); assert.equal(app.downloads.length, 1);
    assert.equal(app.doc.querySelector('[role=alert]'), null);
  } finally { await app.close(); }
});

test('an authorization failure is reported without automatic retries', async () => {
  const app = await mount({ readError: '403' });
  try {
    assert.match(app.doc.querySelector('[role=alert]').textContent, /권한/);
    await app.poll(); assert.equal(app.listings.length, 1); assert.equal(app.doc.querySelector('section a'), null);
  } finally { await app.close(); }
});
