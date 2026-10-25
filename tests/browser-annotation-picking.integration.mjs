import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,cp,rm,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {prepareAssets,root} from '../scripts/assets.mjs';
import {createServer} from '../scripts/server.mjs';
import {launchChrome} from './chrome.mjs';

test('real Chrome: Pages-only thin annotation picking keeps screen tolerance, text cursors, erasing and clean exports',{timeout:180000},async()=>{
  await prepareAssets();const directory=await mkdtemp(join(tmpdir(),'htmlmemo-picking-'));await cp(join(root,'public'),directory,{recursive:true});const server=createServer(directory);let browser;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));browser=await launchChrome();const page=browser.page,url=process.env.HTMLMEMO_SIDEBAR_TEST_URL||`http://127.0.0.1:${server.address().port}/`;
    await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});await page.navigate(url);await page.waitFor('document.querySelector("#status-left").textContent.includes("개의 문서")');
    const drawingTypes=['pen','area-underline','arrow','rect','ellipse','circle'],colors=['#334155','#285847','#894921','#415ac7','#753f92','#921d42'],textTypes=['highlight','underline','strike'];
    await page.evaluate(`(async()=>{
      const {parseHTML,textIndex}=await import('./src/document.js'),{putDocumentRevision}=await import('./src/storage.js');
      const html='<html><head><title>Annotation picking</title><style>html,body{margin:0;height:100%;overflow:hidden}main{height:100%;overflow:auto}article{height:2200px;padding:20px 28px;box-sizing:border-box;font:20px/1.5 system-ui}p{height:32px;margin:4px 0}p,p *{cursor:text!important}</style></head><body><main><article><p><strong>Highlight target</strong></p><p><em>Underline target</em></p><p><strong>Strikeout target</strong></p></article></main></body></html>';
      const parsed=parseHTML(html,{viewport:{width:1100,height:900}},{allowScripts:true}),doc=new DOMParser().parseFromString(parsed.html,'text/html'),index=textIndex(doc);
      parsed.metadata.view={zoom:1,autoFit:false,scrollTop:0,scrollLeft:0};
      parsed.metadata.annotations=${JSON.stringify(drawingTypes)}.map((type,i)=>({id:'thin-'+type,type,color:${JSON.stringify(colors)}[i],width:.1,opacity:1,points:[{x:60,y:160+i*65},{x:300,y:160+i*65+(i<3?0:45)}]}));
      for(const [i,quote] of ['Highlight target','Underline target','Strikeout target'].entries()){const start=index.text.indexOf(quote);parsed.metadata.annotations.push({id:'text-'+${JSON.stringify(textTypes)}[i],type:${JSON.stringify(textTypes)}[i],color:'#415ac7',width:.1,opacity:.35,textAnchor:{start,end:start+quote.length,quote}});}
      await putDocumentRevision({id:'picking-fixture',title:'Annotation picking',name:'picking.html',created:1000,modified:2000,html:parsed.html,metadata:parsed.metadata});
    })()`);
    await page.navigate(url);await page.waitFor('document.querySelector("[data-open=picking-fixture]")');await page.click('[data-open=picking-fixture]');
    const frame='document.querySelector(".document-host:not([hidden]) .document-frame")',doc=frame+'.contentDocument';await page.waitFor(`${frame}?.style.visibility==='visible'&&${doc}?.querySelectorAll('[data-htmlmemo-hit]').length===6`);
    if(await page.evaluate('!!document.querySelector("#close-sidebar")'))await page.click('#close-sidebar');
    const saved=()=>page.evaluate(`(async()=> (await(await import('./src/storage.js')).getDocument('picking-fixture')).metadata.annotations)()`),original=await saved(),metrics=[];
    const zoom=async value=>{await page.click('.document-host:not([hidden]) [data-action=zoom]');await page.waitFor('document.querySelector("#zoom-value")');await page.evaluate(`(()=>{const input=document.querySelector('#zoom-value');input.value=${JSON.stringify(value*100)};input.dispatchEvent(new Event('change',{bubbles:true}));})()`);if(await page.evaluate('!!document.querySelector("#tool-popover [data-popover-close]")'))await page.click('#tool-popover [data-popover-close]');};
    const point=async(id,offset=0,edge=false)=>page.evaluate(`(async()=>{const f=${frame},d=f.contentDocument,node=d.querySelector('[data-htmlmemo-id="'+${JSON.stringify(id)}+'"]');node.scrollIntoView({block:'center',inline:'nearest'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const r=node.getBoundingClientRect(),b=f.getBoundingClientRect(),scale=b.width/f.offsetWidth,x=r.left+r.width/2,y=${edge?'r.top':'r.top+r.height/2'}+${offset}/scale,target=d.elementFromPoint(x,y),mark=target?.closest('[data-htmlmemo-hit],[data-htmlmemo-id]');return {x:b.left+x*scale,y:b.top+y*scale,id:mark?.getAttribute('data-htmlmemo-id')||mark?.getAttribute('data-htmlmemo-hit'),cursor:target&&d.defaultView.getComputedStyle(target).cursor,visualWidth:node.getAttribute('stroke-width')};})()`);
    const click=async p=>{await page.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:p.x,y:p.y});await page.send('Input.dispatchMouseEvent',{type:'mousePressed',x:p.x,y:p.y,button:'left',buttons:1,clickCount:1});await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:p.x,y:p.y,button:'left',buttons:0,clickCount:1});};
    const select=async(id,offset,edge,color)=>{await page.click('#toolbar [data-action=select]');const p=await point(id,offset,edge);assert.equal(p.id,id);assert.equal(p.cursor,'pointer');await click(p);await page.waitFor('document.querySelector("#dialog[open] #annotation-color")');if(color)assert.equal(await page.evaluate('document.querySelector("#annotation-color").value'),color);await page.click('#dialog [data-dialog-close]');return p;};
    const eraseAndUndo=async(id,offset,edge)=>{await page.click('#toolbar [data-action=eraser]');const p=await point(id,offset,edge);assert.equal(p.id,id);assert.equal(p.cursor,'pointer');await click(p);await page.waitFor(`(async()=> !(await(await import('./src/storage.js')).getDocument('picking-fixture')).metadata.annotations.some(a=>a.id===${JSON.stringify(id)}))()`);assert.equal((await saved()).length,original.length-1);await page.click('#toolbar [data-action=undo]');await page.waitFor(`(async()=> (await(await import('./src/storage.js')).getDocument('picking-fixture')).metadata.annotations.length===${original.length})()`);};
    for(const scale of [.5,1,2]){
      await zoom(scale);
      for(const [i,type] of drawingTypes.entries()){
        const id='thin-'+type,edge=i>=3;await page.click('#toolbar [data-action=select]');const outside=await point(id,10,edge);assert.notEqual(outside.id,id);await click(outside);assert.equal(await page.evaluate('document.querySelector("#dialog").open'),false);
        const p=await select(id,4,edge,colors[i]);assert.equal(p.visualWidth,'0.1');await eraseAndUndo(id,4,edge);metrics.push({type,zoom:scale,offset:4,outsideOffset:10,cursor:p.cursor,selected:true,erased:true,undone:true});
      }
    }
    await zoom(1);for(const type of textTypes){await select('text-'+type,0,false,'#415ac7');await eraseAndUndo('text-'+type,0,false);}
    assert.deepEqual(await saved(),original);await page.click('#toolbar [data-action=pen]');const disabled=await point('thin-pen',4);assert.notEqual(disabled.id,'thin-pen');await page.click('#toolbar [data-action=select]');
    await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/pages-only-annotation-picking-1280.png'),await page.screenshot());
    await page.evaluate(`window.showSaveFilePicker=async()=> (await navigator.storage.getDirectory()).getFileHandle('picking-shared.html',{create:true})`);await page.click('#save-page');await page.waitFor('document.querySelector("#toast").textContent.includes("현재 주석을 포함한 HTML")');
    const exported=await page.evaluate(`(async()=> (await(await(await navigator.storage.getDirectory()).getFileHandle('picking-shared.html')).getFile()).text())()`);assert.ok(!exported.includes('data-htmlmemo-hit'));assert.ok(!exported.includes('data-htmlmemo-picking'));assert.ok(!exported.includes('--htmlmemo-hit-padding'));
    await page.evaluate(`(()=>{const t=new DataTransfer();t.items.add(new File([${JSON.stringify(exported)}],'picking-shared.html',{type:'text/html'}));const input=document.querySelector('#file-input');input.files=t.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);await page.waitFor(`document.querySelectorAll('.tab.document').length===2&&${frame}?.style.visibility==='visible'&&${doc}?.querySelectorAll('[data-htmlmemo-hit]').length===6`);
    const imported=await page.evaluate(`(async()=> (await(await import('./src/storage.js')).listDocuments()).find(r=>r.name==='picking-shared.html').metadata.annotations)()`);assert.deepEqual(imported,original);
    await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await zoom(.5);await select('thin-pen',4,false,colors[0]);await writeFile(join(root,'test-results/pages-only-annotation-picking-390.png'),await page.screenshot());
    await writeFile(join(root,'test-results/pages-only-annotation-picking.json'),JSON.stringify({screenMargin:6,checks:metrics,textCursors:textTypes,annotationsPreserved:true,helpersExcludedFromExport:true,reimported:imported.length,mobilePicking:true,errors:browser.errors},null,2));assert.deepEqual(browser.errors,[]);
  }catch(error){if(browser){await mkdir(join(root,'test-results'),{recursive:true});await writeFile(join(root,'test-results/pages-only-annotation-picking-failure.json'),JSON.stringify({message:error.message,errors:browser.errors,state:await browser.page.evaluate('({dialog:document.querySelector("#dialog")?.textContent,toast:document.querySelector("#toast")?.textContent,status:document.querySelector("#status-left")?.textContent})').catch(()=>null)},null,2));await writeFile(join(root,'test-results/pages-only-annotation-picking-failure.png'),await browser.page.screenshot());}throw error;}
  finally{await browser?.close();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}
});
