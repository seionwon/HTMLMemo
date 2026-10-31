// Responsive books now close their drawer on small screens. Open it through
// the visible app menu before testing a control inside it; never bypass CSS.
export async function toggleDocumentSidebarFromToolbar(page){
  const menu='.document-host:not([hidden]) [data-action="toggle-sidebar"]';
  if(await page.evaluate(`!!document.querySelector(${JSON.stringify(menu)})?.getClientRects().length`))await page.click(menu);
  else{await page.click('#toolbar [data-action=more]');await page.click('[data-more=sidebar]');}
}
export async function revealDocumentControl(page,selector){
  await page.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const close=await page.evaluate(`(()=>{const f=document.querySelector('.document-host:not([hidden]) iframe.document-frame'),d=f?.contentDocument,n=d?.querySelector(${JSON.stringify(selector)}),sidebar=d?.querySelector('[data-htmlmemo-native-sidebar]');return !!n&&!n.matches('#reader-menu,[data-action=toggle-sidebar]')&&!n.closest('[data-htmlmemo-native-sidebar]')&&d.documentElement.hasAttribute('data-htmlmemo-compact-ui')&&!!sidebar?.getClientRects().length;})()`);
  // The app row stays visible even when a static document has scrolled its
  // iframe out of view. Use that real control, and wait for the drawer to close.
  if(close){await toggleDocumentSidebarFromToolbar(page);await page.waitFor(`!document.querySelector('.document-host:not([hidden]) iframe.document-frame')?.contentDocument?.querySelector('[data-htmlmemo-native-sidebar]')?.getClientRects().length`);}
  const hidden=await page.evaluate(`(()=>{const f=document.querySelector('.document-host:not([hidden]) iframe.document-frame'),n=f?.contentDocument?.querySelector(${JSON.stringify(selector)});return !!n?.closest('[data-htmlmemo-native-sidebar]')&&!n.getClientRects().length;})()`);
  if(!hidden)return;
  await toggleDocumentSidebarFromToolbar(page);
  try{await page.waitFor(`!!document.querySelector('.document-host:not([hidden]) iframe.document-frame')?.contentDocument?.querySelector(${JSON.stringify(selector)})?.getClientRects().length`);}catch(error){throw Error(error.message+' '+JSON.stringify(await page.evaluate(`(()=>{const d=document.querySelector('.document-host:not([hidden]) iframe.document-frame').contentDocument,n=d.querySelector('[data-htmlmemo-native-sidebar]');return {root:d.documentElement.outerHTML.slice(0,350),body:d.body.className,sidebar:n?.outerHTML.slice(0,250),display:n&&d.defaultView.getComputedStyle(n).display};})()`)));}
}
