// Shared by the trusted local verifier and the full/public Chrome suites.
// Only synthetic example content is used. No external connection is started.
export async function auditLowResolution(w=window,onProgress=()=>{}) {
  const d=w.document,$=s=>d.querySelector(s),frames=()=>new Promise(r=>w.requestAnimationFrame(()=>w.requestAnimationFrame(r)));
  const wait=async predicate=>{const end=Date.now()+15000;while(!predicate()){if(Date.now()>end)throw new Error('Low-resolution fixture timed out: '+predicate);await new Promise(r=>setTimeout(r,25));}await frames();};
  const report={width:w.innerWidth,height:w.innerHeight,screens:[],failures:[]};
  const issue=(screen,detail)=>report.failures.push({screen,detail});
  const click=async s=>{onProgress("click "+s);const n=$(s);if(!n)throw new Error('Missing fixture control '+s);n.scrollIntoView({block:'center',inline:'nearest'});await frames();n.click();await frames();};
  async function inspect(name,selector,{scroll=true}={}) {
    onProgress(name);const root=$(selector);if(!root)throw new Error('Missing screen '+selector);
    await wait(()=>root.checkVisibility()&&root.getBoundingClientRect().height>0);
    const rect=root.getBoundingClientRect();
    if(rect.left<-.5||rect.right>w.innerWidth+.5||rect.top<-.5||rect.bottom>w.innerHeight+.5)issue(name,`outside viewport: ${[rect.x,rect.y,rect.width,rect.height].map(Math.round)}`);
    if(root.scrollWidth>root.clientWidth+1)issue(name,`horizontal overflow: ${root.scrollWidth}/${root.clientWidth}`);
    let count=0;
    for(const node of root.querySelectorAll('button,input:not([type=radio]):not([type=checkbox]),select,textarea,summary,a[href]')){
      if(!node.getClientRects().length||!node.checkVisibility()||node.disabled)continue;
      if(node.closest('#library-breadcrumbs,.library-folder-tree,.help-table-scroll'))continue; // Deliberately scrollable regions.
      if(scroll){node.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});}
      const r=node.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
      const label=node.id||node.getAttribute('aria-label')||node.textContent.trim().slice(0,24);
      if(r.left<-.5||r.right>w.innerWidth+.5)issue(name,'control too wide: '+label);
      if(scroll&&(!node.contains(d.elementFromPoint(x,y)))){const hit=d.elementFromPoint(x,y);issue(name,'control unreachable: '+label+'; covered by '+(hit?.id||hit?.className||hit?.tagName)+' at '+[x,y].map(Math.round));}
      count++;
    }
    root.scrollTop=0;await frames();report.screens.push({name,controls:count});
  }
  const close=async()=>{if($('#dialog').open){const b=$('#dialog [data-dialog-close]');if(b)await click('#dialog [data-dialog-close]');else $('#dialog').close();await frames();}};
  const settings=async()=>{await close();await click('#settings-button');};
  const popClose=async()=>{if(!$('#tool-popover').hidden){if($('[data-popover-close]'))await click('[data-popover-close]');else await click('#settings-button');await close();}};
  await wait(()=>d.documentElement.dataset.storageSetup==='ready');await close();await click('#library-tab');
  if($('#library-trash').getAttribute('aria-pressed')==='true')await click('#library-trash');
  await inspect('library-card','#library');await click('#library-list-view');await inspect('library-list','#library');await click('#library-card-view');
  for(const [s,name] of [['#paste-button','paste'],['#web-help-button','web-import-guide'],['#library-new-folder','new-folder'],['#library-folder-help','folder-help']]){await click(s);await inspect(name,'#dialog');await close();}
  await click('#library-trash');await inspect('trash','#library');await click('#library-trash');
  await settings();await inspect('settings','#dialog');
  $('.settings-backup').open=true;await inspect('settings-backup','#dialog');
  for(const [s,name] of [['#settings-folder','data-folder'],['#settings-about','about']]){await settings();await click(s);await inspect(name,'#dialog');await close();}
  await settings();await click('#settings-sync');await inspect('sync-host','#dialog');await click('#sync-join-tab');await inspect('sync-join','#dialog');await close();
  await settings();await click('#settings-help');await inspect('help','#dialog');
  const pane=$('#help-content');if(pane.clientHeight<60)issue('help','reading pane too short: '+pane.clientHeight);
  pane.scrollTop=pane.scrollHeight;await frames();const nav=$('.help-page-nav');if(nav&&nav.getBoundingClientRect().bottom>pane.getBoundingClientRect().bottom+1)issue('help','last page controls clipped');
  await close();await settings();await click('#settings-execution');await inspect('execution','#execution');await click('#library-tab');
  if(!$('.tab.document')){await click('#open-example');}else await click('.tab.document .tab-select');
  await wait(()=>$('.document-host:not([hidden]) iframe.document-frame')?.style.visibility==='visible');
  await inspect('reading-header','.addressbar',{scroll:false});
  await click('#toolbar [data-action=palette]');await inspect('palette','#tool-popover');await popClose();
  for(const tool of ['highlight','rect','note']){await click('#toolbar [data-action='+tool+']');await click('#toolbar [data-action='+tool+']');await inspect(tool+'-options','#tool-popover');await popClose();}
  await click('#toolbar [data-action=more]');await inspect('document-tools','#tool-popover');
  if($('[data-more=sidebar]'))await click('[data-more=sidebar]');else await popClose();
  if(!$('#sidebar').hidden){
    for(const view of ['outline','search','annotations','bookmarks']){const s='#sidebar [data-sidebar-view='+view+']';if($(s)&&!$(s).hidden){await click(s);await inspect('sidebar-'+view,'#sidebar');}}
    let controls=0;
    for(const button of d.querySelectorAll('#toolbar .tool-button:not(:disabled)')){
      button.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});const r=button.getBoundingClientRect();
      if(!button.contains(d.elementFromPoint(r.x+r.width/2,r.y+r.height/2)))issue('toolbar-with-sidebar','covered tool: '+button.dataset.action);
      controls++;
    }
    report.screens.push({name:'toolbar-with-sidebar',controls});await click('#close-sidebar');
  }
  for(const mode of ['info','history']){await click('#toolbar [data-action=more]');await click('[data-more='+mode+']');await wait(()=>$('#dialog').open&&$(mode==='history'?'.revision-browser':'.document-info'));await inspect('document-'+mode,'#dialog');await close();}
  const tts='.document-host:not([hidden]) > [data-htmlmemo-reading-controls] [data-action=speak]';
  await click(tts);await wait(()=>$('.mstts-player'));const bar=$('.mstts-player');
  // Equivalent to dragging the compact bar to the right edge; no speech starts.
  bar.style.left=Math.max(4,w.innerWidth-bar.offsetWidth-4)+'px';bar.style.top=Math.max(4,Math.floor(w.innerHeight/2))+'px';bar.style.bottom='auto';
  await click('[data-tts-gear]');await inspect('tts-settings','.mstts-panel');
  for(const button of [...d.querySelectorAll('.mstts-select-trigger')]){button.click();await frames();await inspect('tts-options','.mstts-select-menu');button.click();await frames();}
  await click('.mstts-player > button:last-of-type');
  await click('#toolbar [data-action=select]');await popClose();await click('#library-tab');await wait(()=>$('[data-card-menu]'));
  await click('[data-card-menu]');await inspect('document-menu','#dialog');await close();
  if(!$('[data-folder-menu]')){await click('#library-new-folder');$('#library-folder-name').value='이름이 아주 긴 테스트용 하위 폴더';await click('#library-folder-save');await wait(()=>!$('#dialog').open);}
  await inspect('library-with-content','#library');await click('#library-list-view');await inspect('library-list-with-content','#library');await click('#library-card-view');
  await click('[data-folder-menu]');await inspect('folder-menu','#dialog');await click('#folder-menu-move');await inspect('move-folder','#dialog');await close();
  return report;
}
