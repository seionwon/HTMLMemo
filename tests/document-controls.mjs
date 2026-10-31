// Responsive books now close their drawer on small screens. Open it through
// the visible app menu before testing a control inside it; never bypass CSS.
export async function revealDocumentControl(page,selector){
  const close=await page.evaluate(`(()=>{const f=document.querySelector('.document-host:not([hidden]) iframe.document-frame'),d=f?.contentDocument,n=d?.querySelector(${JSON.stringify(selector)}),button=d?.querySelector('[data-htmlmemo-doc-sidebar-ui] [data-sidebar-close]');if(!n||n.matches('#reader-menu,[data-action=toggle-sidebar]')||n.closest('[data-htmlmemo-native-sidebar]')||!d.documentElement.hasAttribute('data-htmlmemo-compact-ui')||!button?.getClientRects().length)return null;const r=button.getBoundingClientRect(),b=f.getBoundingClientRect(),z=b.width/f.clientWidth;return{x:b.left+(r.left+r.width/2)*z,y:b.top+(r.top+r.height/2)*z};})()`);
  if(close)for(const type of ['mousePressed','mouseReleased'])await page.send('Input.dispatchMouseEvent',{type,...close,button:'left',clickCount:1});
  const hidden=await page.evaluate(`(()=>{const f=document.querySelector('.document-host:not([hidden]) iframe.document-frame'),n=f?.contentDocument?.querySelector(${JSON.stringify(selector)});return !!n?.closest('[data-htmlmemo-native-sidebar]')&&!n.getClientRects().length;})()`);
  if(!hidden)return;
  const menu='.document-host:not([hidden]) [data-action="toggle-sidebar"]';
  if(await page.evaluate(`!!document.querySelector(${JSON.stringify(menu)})?.getClientRects().length`))await page.click(menu);
  else{await page.click('#toolbar [data-action=more]');await page.click('[data-more=sidebar]');}
  try{await page.waitFor(`!!document.querySelector('.document-host:not([hidden]) iframe.document-frame')?.contentDocument?.querySelector(${JSON.stringify(selector)})?.getClientRects().length`);}catch(error){throw Error(error.message+' '+JSON.stringify(await page.evaluate(`(()=>{const d=document.querySelector('.document-host:not([hidden]) iframe.document-frame').contentDocument,n=d.querySelector('[data-htmlmemo-native-sidebar]');return {root:d.documentElement.outerHTML.slice(0,350),body:d.body.className,sidebar:n?.outerHTML.slice(0,250),display:n&&d.defaultView.getComputedStyle(n).display};})()`)));}
}
