import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanDraftOptions,saveDraft,listDrafts,deleteDraft,cleanupExpiredDrafts,DRAFT_RETENTION_DAYS} from './drafts.js';
const valid={mode:'builder',coatingType:'paint',color:'#02FC00',finish:'satin',wheel:'bbs',custom:'',fromRepeat:true};
test('draft fields sanitized and separate builder/free modes are supported',()=>{
 const b=cleanDraftOptions(valid);assert.equal(b.color,'#02FC00');assert.equal(b.wheel,'bbs');assert.equal(b.fromRepeat,true);
 assert.equal(cleanDraftOptions({mode:'free',custom:'Добавь диски'}).custom,'Добавь диски');
 for(const value of [{mode:'builder',wheel:'not-a-wheel'},{mode:'wrong'},{mode:'free',custom:'x'.repeat(1001)}]){
  assert.throws(()=>cleanDraftOptions(value),e=>e.code==='INVALID_DRAFT');
 }
 assert.equal(DRAFT_RETENTION_DAYS,7);
});
test('draft cannot be stored for an unowned photo',async()=>{
 const events=[];
 const c={query:async(sql)=>{events.push(sql);if(sql.includes('SELECT v.id FROM vehicles'))return {rows:[]};return {rows:[]}},release(){events.push('release')}};
 const pool={connect:async()=>c};
 await assert.rejects(saveDraft(pool,123,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',valid),e=>e.code==='DRAFT_SOURCE_UNAVAILABLE');
 assert.ok(events.includes('ROLLBACK'));assert.ok(events.includes('release'));
});
test('listing filters out server-expired drafts and is scoped to one user',async()=>{
 let sql='';let args;
 const pool={query:async(query,params)=>{sql=query;args=params;return{rows:[{id:'x',name:'Lada',expiresAt:'2026-11-15'}]}}};
 assert.equal((await listDrafts(pool,321))[0].name,'Lada');assert.deepEqual(args,[321]);assert.match(sql,/telegram_id=\$1/);assert.match(sql,/interval '7 days'/);
});
test('cleanup with no expired drafts does not touch user vehicles',async()=>{
 const events=[];const c={query:async(sql)=>{events.push(sql);if(sql.includes('DELETE FROM drafts'))return{rows:[]};return{rows:[]}},release(){}};
 assert.equal(await cleanupExpiredDrafts({connect:async()=>c}),0);
 assert.equal(events.some(e=>e.includes('DELETE FROM vehicles')),false);
 assert.ok(events.includes('COMMIT'));
});
test('manual draft deletion does not delete non-owned records',async()=>{
 const events=[];const c={query:async(sql)=>{events.push(sql);if(sql.includes('DELETE FROM drafts'))return{rows:[]};return{rows:[]}},release(){}};
 const r=await deleteDraft({connect:async()=>c},123,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
 assert.equal(r,false);assert.equal(events.some(e=>e.includes('DELETE FROM vehicles')),false);
});
test('authorized draft saves atomically and retains its existing vehicle',async()=>{
 const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',vehicleId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 const events=[];
 const client={query:async(sql)=>{
  events.push(sql);
  if(sql.includes('SELECT v.id FROM vehicles'))return{rows:[{id:vehicleId}]};
  if(sql.includes('SELECT id,vehicle_id,updated_at FROM drafts'))return{rows:[]};
  if(sql.includes('SELECT count(*) AS count FROM drafts'))return{rows:[{count:'0'}]};
  if(sql.includes('INSERT INTO drafts'))return{rows:[{id,vehicleId,options:valid,expiresAt:'2026-11-19T12:00:00.000Z'}]};
  return{rows:[]};
 },release(){}};
 const saved=await saveDraft({connect:async()=>client},123,id,vehicleId,valid);
 assert.equal(saved.id,id);
 assert.ok(events.includes('COMMIT'));
 assert.ok(events.some(x=>x.includes('WHERE v.id=$1 AND v.telegram_id=$2')));
});
test('deleting a draft preserves sources of completed generations',async()=>{
 const events=[];
 const client={query:async(sql)=>{
  events.push(sql);
  if(sql.includes('DELETE FROM drafts'))return{rows:[{vehicle_id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'}]};
  if(sql.includes('SELECT id FROM vehicles'))return{rows:[{id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'}]};
  if(sql.includes('AS busy'))return{rows:[{busy:true}]};
  return{rows:[]};
 },release(){}};
 assert.equal(await deleteDraft({connect:async()=>client},123,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),true);
 assert.equal(events.some(q=>q.includes('DELETE FROM photo_consents')),false);
 assert.equal(events.some(q=>q.includes('DELETE FROM vehicles')),false);
});
test('generation request stays backward-compatible while accepting a draft ID',async()=>{
 const {optionsOf}=await import('./generations.js');
 const base={mode:'builder',color:'#02FC00',finish:'satin',wheel:'bbs',custom:''};
 assert.equal(optionsOf(base).draftId,undefined);
 assert.equal(optionsOf({...base,draftId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}).draftId,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
 assert.throws(()=>optionsOf({...base,draftId:'not-a-uuid'}),e=>e.code==='INVALID_OPTIONS');
});
