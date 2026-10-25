import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {revisionDate,revisionDateRange} from '../public/src/storage.js';
const source=(await readFile(new URL('../public/src/storage.js',import.meta.url),'utf8')).replace(/^export /gm,'');
const compare=(a,b)=>{if(Array.isArray(a)&&Array.isArray(b)){for(let i=0;i<Math.min(a.length,b.length);i++){const result=compare(a[i],b[i]);if(result)return result;}return a.length-b.length;}return a<b?-1:a>b?1:0;};
function calendar(rows){
  const stats={keys:0,values:0,counts:0,stores:[]};
  const bound=(lower,upper,lowerOpen=false,upperOpen=false)=>({includes:key=>(compare(key,lower)>0||!lowerOpen&&compare(key,lower)===0)&&(compare(key,upper)<0||!upperOpen&&compare(key,upper)===0)});
  const connection={transaction(name){
    stats.stores.push(name);assert.equal(name,'revisionHeaders');const tx={};let pending=0,done=false;
    const enqueue=(op,request={})=>{pending++;queueMicrotask(()=>{request.result=op();request.onsuccess?.();if(!--pending)setImmediate(()=>{if(!pending&&!done){done=true;tx.oncomplete?.();}});});return request;};
    tx.objectStore=()=>({index(name){
      const key=row=>name==='documentRevision'?[row.documentId,row.id]:[row.documentId,row.time,row.id];
      const sorted=[...rows].sort((a,b)=>compare(key(a),key(b)));
      const cursor=(range,direction,values)=>{
        const matches=sorted.filter(row=>range.includes(key(row)));if(direction==='prev')matches.reverse();let position=0;const request={};
        const next=()=>{if(position>=matches.length)return null;const row=matches[position];stats[values?'values':'keys']++;return {key:key(row),primaryKey:row.id,value:row,continue(target){position++;if(target)while(position<matches.length&&(direction==='prev'?compare(key(matches[position]),target)>0:compare(key(matches[position]),target)<0))position++;enqueue(next,request);}};};return enqueue(next,request);
      };
      return {openCursor:(range,direction)=>cursor(range,direction,true),openKeyCursor:(range,direction)=>cursor(range,direction,false),count:range=>{stats.counts++;return enqueue(()=>sorted.filter(row=>range.includes(key(row))).length);}};
    }});return tx;
  }};
  const api=vm.createContext({connection,structuredClone,Blob,Date,IDBKeyRange:{bound}});vm.runInContext(source+'\ndatabase=Promise.resolve(connection);',api);
  return {api,stats};
}
const header=(id,year,month,day,book='book')=>({id,documentId:book,time:new Date(year,month-1,day,12).getTime(),created:new Date(year,month-1,day,12).getTime(),kind:'edit',annotationCount:id,bookmarkCount:0});
test('local dates and month/year boundaries preserve leap days and years below 100',()=>{
  const [start,end]=revisionDateRange(2024,2,29);assert.deepEqual(revisionDate(start),{year:2024,month:2,day:29});assert.deepEqual(revisionDate(end),{year:2024,month:3,day:1});assert.equal(new Date(revisionDateRange(99)[0]).getFullYear(),99);assert.deepEqual(revisionDate(revisionDateRange(2025)[1]),{year:2026,month:1,day:1});
});
test('calendar ranges follow the device timezone and 23/25-hour daylight-saving days',()=>{
  const previous=process.env.TZ;
  try{process.env.TZ='Asia/Seoul';assert.deepEqual(revisionDate(Date.UTC(2026,0,1,15)),{year:2026,month:1,day:2});process.env.TZ='America/New_York';for(const [month,day,hours]of [[3,8,23],[11,1,25]]){const [start,end]=revisionDateRange(2026,month,day);assert.equal(end-start,hours*3600000);assert.equal(new Date(start).getHours(),0);assert.equal(new Date(end).getHours(),0);}}
  finally{if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;}
});
test('invalid legacy timestamps are kept in an explicit unknown-date group',()=>{for(const value of [null,undefined,NaN,Infinity,-Infinity,1e20])assert.deepEqual(revisionDate(value),{year:'unknown',month:null,day:null});assert.deepEqual(revisionDateRange('unknown'),[-Infinity,-Infinity]);});
test('calendar browsing skips snapshot payloads and visits only populated periods',async()=>{
  const rows=[header(1,2024,2,29),header(2,2025,12,31),...Array.from({length:1000},(_,i)=>header(i+3,2026,i%2?1:3,i%2?1:8)),header(2000,2030,1,1,'other')],{api,stats}=calendar(rows);
  assert.deepEqual(JSON.parse(JSON.stringify(await api.listRevisionPeriods('book'))),[{value:2026,count:1000},{value:2025,count:1},{value:2024,count:1}]);assert.equal(stats.keys,3);assert.equal(stats.values,0);
  assert.deepEqual(JSON.parse(JSON.stringify(await api.listRevisionPeriods('book',2026))),[{value:3,count:500},{value:1,count:500}]);assert.deepEqual(JSON.parse(JSON.stringify(await api.listRevisionPeriods('book',2026,3))),[{value:8,count:500}]);assert.equal(stats.keys,6);assert.equal(stats.counts,6);assert.equal(stats.values,0);
});
test('same-timestamp day paging has stable keysets without rescanning earlier pages or other days',async()=>{
  const rows=[...Array.from({length:125},(_,i)=>header(i+1,2026,1,1)),header(200,2026,1,2),header(300,2026,1,1,'other')],{api,stats}=calendar(rows),date={year:2026,month:1,day:1};
  const first=await api.listRevisionDay('book',date),second=await api.listRevisionDay('book',date,first.next),third=await api.listRevisionDay('book',date,second.next);
  assert.deepEqual([first.rows.length,second.rows.length,third.rows.length],[50,50,25]);assert.equal(third.next,null);assert.equal(new Set([...first.rows,...second.rows,...third.rows].map(row=>row.id)).size,125);assert.equal(first.rows[0].id,125);assert.equal(third.rows.at(-1).id,1);assert.equal(stats.values,127);assert.ok(stats.stores.every(name=>name==='revisionHeaders'));
});
test('day navigation crosses month/year gaps and stops at both ends without wrapping',async()=>{
  const {api}=calendar([header(1,2024,2,29),header(2,2025,12,31),header(3,2026,1,1)]),plain=value=>JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(await api.adjacentRevisionDay('book',{year:2026,month:1,day:1},'previous')),{year:2025,month:12,day:31});assert.deepEqual(plain(await api.adjacentRevisionDay('book',{year:2025,month:12,day:31},'next')),{year:2026,month:1,day:1});assert.equal(await api.adjacentRevisionDay('book',{year:2024,month:2,day:29},'previous'),null);assert.equal(await api.adjacentRevisionDay('book',{year:2026,month:1,day:1},'next'),null);
});
test('unknown-date histories can be counted, paged and navigated without inventing a date',async()=>{
  const {api}=calendar([{...header(1,2024,1,1),time:-Infinity,created:null},header(2,2026,1,1)]),date={year:'unknown',month:null,day:null};
  const years=await api.listRevisionPeriods('book');assert.equal(years.at(-1).value,'unknown');assert.equal(years.at(-1).count,1);assert.equal((await api.listRevisionDay('book',date)).rows[0].id,1);assert.equal(await api.adjacentRevisionDay('book',date,'previous'),null);assert.equal((await api.adjacentRevisionDay('book',date,'next')).year,2026);
});
test('empty books and legacy summary callers remain isolated and metadata-only',async()=>{
  const {api}=calendar([header(1,2026,1,1,'other')]);assert.equal((await api.listRevisionPeriods('book')).length,0);assert.equal((await api.listRevisionSummaries('book')).length,0);const other=await api.listRevisionSummaries('other');assert.equal(other.length,1);assert.equal(Object.hasOwn(other[0],'annotations'),false);assert.equal((await api.listRevisionSummaries('other',1)).length,0);
});
