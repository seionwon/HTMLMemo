import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {root,prepareAssets} from '../scripts/assets.mjs';
import {createServer as staticServer} from '../scripts/server.mjs';
import {launchChrome} from './chrome.mjs';

test('real Chrome: Pages-only LibreMemo rename preserves old-profile documents, marks, trash and settings across both paths',{timeout:150000},async()=>{
  await prepareAssets();
  // Use the pre-rename storage implementation to create an actual old database.
  const originalStorage=await readFile(new URL('./fixtures/storage-1.3.0.js',import.meta.url),'utf8');
  const serve=staticServer().listeners('request')[0];
  const server=createServer((req,res)=>{
    if(req.url==='/HTMLMemo/legacy-storage.js'){res.writeHead(200,{'Content-Type':'text/javascript'});res.end(originalStorage);return;}
    req.url=req.url.replace(/^\/(?:HTMLMemo|LibreMemo)(?=\/)/,'');
    return serve(req,res);
  });
  let chrome;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    chrome=await launchChrome();const {page}=chrome,origin=`http://127.0.0.1:${server.address().port}`;
    await page.navigate(origin+'/HTMLMemo/');
    await page.waitFor('document.documentElement.dataset.storageSetup==="ready"');
    await page.evaluate(`(async()=>{
      const {putDocumentRevision,trashDocument,getDocument}=await import('./legacy-storage.js');
      const {parseHTML}=await import('./src/document.js');
      const parsed=parseHTML('<html><head><title>이름 변경 전 문서</title></head><body><p>Hello world</p></body></html>');
      parsed.metadata.annotations=[{id:'old-mark',type:'highlight',color:'#edcf67',width:3,opacity:.35,textAnchor:{start:0,end:5,quote:'Hello',prefix:'',suffix:' world'}}];
      parsed.metadata.bookmarks=[{id:'old-bookmark',title:'옛 북마크',top:0,left:0}];
      const record={id:'legacy-brand-document',name:'옛 문서.html',created:1000,title:'이름 변경 전 문서',html:parsed.html,metadata:parsed.metadata,modified:1000};
      await putDocumentRevision(record,{baseline:true});
      await putDocumentRevision({...record,id:'legacy-brand-trash',title:'이름 변경 전 휴지통'},{baseline:true});
      await trashDocument('legacy-brand-trash');
      window.brandingTrash=(await getDocument('legacy-brand-trash')).trashedAt;
      localStorage.setItem('htmlmemo-theme','dark');
      localStorage.setItem('htmlmemo-preferences-v1',JSON.stringify({theme:'dark'}));
      window.brandingOriginal=JSON.stringify((await(await import('./src/storage.js')).getDocument(record.id)).metadata);
    })()`);
    const expected=await page.evaluate('window.brandingOriginal'),expectedTrash=await page.evaluate('window.brandingTrash');
    assert.ok(expectedTrash>0);
    await page.waitFor('document.querySelector("#data-folder-status").textContent!=="폴더 저장 중…"');
    const report=[];
    for(const width of [1280,390,320]){
      await page.send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:width<500});
      await page.navigate(origin+'/LibreMemo/');
      await page.waitFor('document.documentElement.dataset.storageSetup==="ready"');
      const result=await page.evaluate(`(async()=>{
        const s=await import('./src/storage.js'),doc=await s.getDocument('legacy-brand-document'),trash=await s.getDocument('legacy-brand-trash');
        const manifest=await fetch('./manifest.webmanifest').then(r=>r.json());
        return {title:document.title,metadata:JSON.stringify(doc.metadata),html:doc.html,trash:trash.trashedAt,theme:localStorage.getItem('htmlmemo-theme'),manifest,dbs:(await indexedDB.databases()).map(x=>x.name),overflow:document.documentElement.scrollWidth>innerWidth};
      })()`);
      assert.match(result.title,/LibreMemo/);assert.equal(result.metadata,expected);
      assert.match(result.html,/Hello world/);assert.equal(result.trash,expectedTrash);assert.equal(result.theme,'dark');
      assert.equal(result.manifest.short_name,'LibreMemo');assert.equal(result.manifest.id,'/HTMLMemo/');
      assert.ok(result.dbs.includes('HTMLMemo-v1'));assert.ok(!result.dbs.includes('LibreMemo-v1'));assert.equal(result.overflow,false);
      await page.waitFor('!!document.querySelector("[data-open=legacy-brand-document]")');
      await page.click('[data-open=legacy-brand-document]');
      await page.waitFor('document.querySelector(".document-host:not([hidden]) iframe")?.contentDocument?.querySelector("[data-htmlmemo-mark]")?.textContent==="Hello"');
      await page.click('#library-tab');
      await page.click('#settings-button');await page.waitFor('document.querySelector("#dialog").open');
      assert.match(await page.evaluate('document.querySelector("#dialog").textContent'),/LibreMemo 설정/);
      await mkdir(root+'/test-results',{recursive:true});await writeFile(root+'/test-results/librememo-branding-'+width+'.png',await page.screenshot());
      await page.evaluate('document.querySelector("#dialog").close()');
      report.push({width,oldDataPreserved:true,trashPreserved:true,settingsPreserved:true,folderReady:true,pwaIdentityPreserved:true});
    }
    assert.deepEqual(chrome.errors,[]);
    await writeFile(root+'/test-results/librememo-branding.json',JSON.stringify({status:'pass',cases:report,errors:chrome.errors},null,2));
  }finally{await chrome?.close();await new Promise(resolve=>server.close(resolve));}
});
