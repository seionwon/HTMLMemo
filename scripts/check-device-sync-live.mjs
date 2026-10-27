// Explicit, synthetic-only check of the same public relay used by MemoSuite.
// No library is opened, no account is used and the room secret never leaves memory.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {SyncService} from '../public/src/sync-service.js';
const room='HM-CHECK-'+randomBytes(16).toString('hex'),run=randomBytes(12).toString('hex');
const sides=[new Map([['host','Synthetic HTMLMemo transport check. '.repeat(140)]]),new Map([['peer','Synthetic receiver transport check. '.repeat(140)]])],states=[[],[]];
const report={scope:'Public ntfy encrypted attachment exchange; generated test strings only; no app library/account',status:'running'};
let timer;
const done=[];const waits=[0,1].map(i=>new Promise((resolve,reject)=>done[i]={resolve,reject}));
const services=[0,1].map(i=>new SyncService({adapter:{
 async getSyncTargetIds(){},async getBackupData(_ids,exclude=[]){return {format:'HTMLMemo.synthetic-check',run,items:[...sides[i]].filter(([id])=>!exclude.includes(id))};},
 async mergeBackupData(data){assert.equal(data.format,'HTMLMemo.synthetic-check');assert.equal(data.run,run);for(const [id,value] of data.items)sides[i].set(id,value);return data.items.map(([id])=>id);}
},onDataReceived:()=>{},onStatusChange(state,message){states[i].push(state);if(state==='completed')done[i].resolve();if(state==='error')done[i].reject(Error(message));}}));
try{
 const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Public relay verification timed out')),45000);});
 await Promise.race([(async()=>{await services[0].initialize(room);await services[1].connect(room);await Promise.all(waits);})(),timeout]);
 assert.equal(sides[0].size,2);assert.equal(sides[1].size,2);report.status='pass';report.bothDirections=true;report.attachmentPayloads=true;
}catch(error){report.status='failed';report.error=error.message;process.exitCode=1;}finally{
 clearTimeout(timer);services.forEach(s=>s.destroy());report.states=states;report.connectionsClosed=services.every(s=>s.isDestroyed&&s.ws===null);
 await mkdir(new URL('../test-results/',import.meta.url),{recursive:true});await writeFile(new URL('../test-results/device-sync-live.json',import.meta.url),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}
