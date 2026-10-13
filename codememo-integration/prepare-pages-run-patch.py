from pathlib import Path
import difflib

source_path = Path('/Users/ls/workspace/MemoSuite/apps/CodeMemo/src/components/Project/ProjectConsole.tsx')
original = source_path.read_text()
updated = original

def replace(before, after):
    global updated
    if updated.count(before) != 1:
        raise SystemExit('Source changed; expected exactly one patch location: ' + before[:75])
    updated = updated.replace(before, after)

replace("  const cacheKey = project.id;\n  const cached = loadRun(cacheKey);", """  // HTMLMemo is distributed through one GitHub Pages address. Old project
  // metadata can still contain a localhost URL or a static-file classification.
  const pagesUrl = /(?:^|[\\\\/])HTMLMemo[\\\\/]?$/.test(project.path || '')
    ? 'https://seionwon.github.io/HTMLMemo/' : '';
  const cacheKey = project.id;
  const cached = loadRun(cacheKey);""")
replace("  const isApp = project.webKind === 'app';", "  const isApp = !!pagesUrl || project.webKind === 'app';")
replace("  const liveUrl = withScheme(project.liveUrl || liveUrlDraft || '');", """  const liveUrl = pagesUrl || withScheme(project.liveUrl || liveUrlDraft || '');
  React.useEffect(() => {
    if (pagesUrl && (project.liveUrl !== pagesUrl || project.webKind !== 'app')) {
      onMeta({ liveUrl: pagesUrl, webKind: 'app' });
    }
  }, [pagesUrl, project.liveUrl, project.webKind, onMeta]);""")
replace("    if (!force && project.webKind) return;            // already judged → use the cached value", """    if (pagesUrl) return; // The Pages route is authoritative for HTMLMemo.
    if (!force && project.webKind) return;            // already judged → use the cached value""")
replace("  }, [project.path, project.webKind, project.id, onMeta]);", "  }, [project.path, project.webKind, project.id, onMeta, pagesUrl]);")
replace("    if (project.webKind !== 'app' || project.liveUrl || !project.path) return;", "    if (pagesUrl || project.webKind !== 'app' || project.liveUrl || !project.path) return;")
replace("  }, [project.webKind, project.liveUrl, project.path, project.id, onMeta]);", "  }, [project.webKind, project.liveUrl, project.path, project.id, onMeta, pagesUrl]);")
replace("      <RunDeploymentZip projectId={project.id} projectPath={project.path} running={running} />", "      {!pagesUrl && <RunDeploymentZip projectId={project.id} projectPath={project.path} running={running} />}")
replace("      {webEntry && !android?.android && (", "      {(webEntry || pagesUrl) && !android?.android && (")
replace("{tc(t, 'web_intro', 'This is a web project — run it in your browser:')}", "{pagesUrl ? 'GitHub Pages에서 HTMLMemo 실행' : tc(t, 'web_intro', 'This is a web project — run it in your browser:')}")
replace("              {project.webKind === 'static'\n", "              {!pagesUrl && project.webKind === 'static'\n")
replace("                : project.webKind === 'app'\n", "                : isApp\n")
replace("              <Btn disabled={recheckingKind} onClick={() => detectWebKind(true)} title={tc(t, 'web_recheck', 'Re-check project type')}><FiRefreshCw /></Btn>", "              {!pagesUrl && <Btn disabled={recheckingKind} onClick={() => detectWebKind(true)} title={tc(t, 'web_recheck', 'Re-check project type')}><FiRefreshCw /></Btn>}")
replace("              {(editingLiveUrl || !liveUrl) ? (", "              {(!pagesUrl && (editingLiveUrl || !liveUrl)) ? (")
replace("{tc(t, 'live_url_label', 'Public URL')}:", "{pagesUrl ? 'GitHub Pages' : tc(t, 'live_url_label', 'Public URL')}:")
replace("                  <button onClick={() => setEditingLiveUrl(true)} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: 2 }} title={tc(t, 'rename', 'Edit')}><FiEdit2 size={13} /></button>", "                  {!pagesUrl && <button onClick={() => setEditingLiveUrl(true)} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: 2 }} title={tc(t, 'rename', 'Edit')}><FiEdit2 size={13} /></button>}")
replace("            {project.webKind === 'static'\n", "            {pagesUrl ? '앱 실행과 공유는 이 GitHub Pages 주소를 사용합니다.' : project.webKind === 'static'\n")
replace("      {(project.webKind !== 'static' || android?.gradle || !!apk) && (", "      {(!pagesUrl || running) && (project.webKind !== 'static' || android?.gradle || !!apk) && (")

root = Path(__file__).resolve().parent
patch = ''.join(difflib.unified_diff(original.splitlines(True), updated.splitlines(True),
    fromfile='a/apps/CodeMemo/src/components/Project/ProjectConsole.tsx',
    tofile='b/apps/CodeMemo/src/components/Project/ProjectConsole.tsx'))
(root / 'HTMLMemo-pages-run.patch').write_text(patch)
# A staged copy is only for verification, inside an allowed temporary directory.
Path('/tmp/htmlmemo-pages-run-ProjectConsole.tsx').write_text(updated)
print('Prepared scoped Pages run patch; original CodeMemo source was not modified.')
