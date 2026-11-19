import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {creditCostFor,enqueue,failJob,GENERATION_CREDIT_COSTS} from './generations.js';

// Deterministic isolated transaction simulator. The production DB schema
// and the full PGlite integration suite are checked separately before launch.
function fakeDb(openingBalance=10){
 const state={balance:openingBalance,jobs:[],ledger:[],rollbacks:0};
 const query=async (sql,params=[])=>{
  const text=String(sql).trim().replace(/\s+/g,' ');
  if(text==='BEGIN'||text==='COMMIT')return {rows:[],rowCount:0};
  if(text==='ROLLBACK'){state.rollbacks++;return {rows:[],rowCount:0};}
  if(text.includes('pg_advisory_xact_lock'))return {rows:[],rowCount:1};
  if(text.startsWith('SELECT balance,credit_debt FROM users'))return {rows:[{balance:state.balance,credit_debt:0}],rowCount:1};
  if(text.startsWith('SELECT * FROM generations WHERE telegram_id=')){
   const found=state.jobs.find(job=>job.telegram_id===Number(params[0])&&job.request_key===params[1]);
   return {rows:found?[{...found}]:[],rowCount:found?1:0};
  }
  if(text.startsWith('SELECT count(*) FILTER')){
   const active=state.jobs.filter(j=>j.status==='queued'||j.status==='processing').length;
   return {rows:[{active,stored:state.jobs.length,daily:state.jobs.length,pending:active,total:state.jobs.length}],rowCount:1};
  }
  if(text.startsWith('INSERT INTO generations(')){
   assert.match(text,/charged_credits/);
   const [id,telegram_id,request_key,request_hash,options,source,model,charged_credits]=params;
   const j={id,telegram_id,request_key,request_hash,options:JSON.parse(options),source_image:source,model,charged_credits,status:'queued',refunded:false,archived:false};
   state.jobs.push(j);return {rows:[{...j}],rowCount:1};
  }
  if(text.startsWith('UPDATE users SET balance=balance-$2')){
   state.balance-=params[1];return {rows:[{balance:state.balance}],rowCount:1};
  }
  if(text.startsWith('INSERT INTO credit_ledger')){
   state.ledger.push({operation_key:params[0],telegram_id:params[1],generation_id:params[2],delta:params[3]});return {rows:[],rowCount:1};
  }
  if(text.startsWith("UPDATE generations SET status='failed'")){
   const j=state.jobs.find(x=>x.id===params[0]);
   if(!j||j.refunded||!['queued','processing'].includes(j.status))return {rows:[],rowCount:0};
   j.refunded=true;j.status='failed';j.error_code=params[1];return {rows:[{...j}],rowCount:1};
  }
  if(text.startsWith('UPDATE users SET balance=balance+$2')){
   state.balance+=params[1];return {rows:[],rowCount:1};
  }
  throw Error('Unexpected SQL in isolated test: '+text.slice(0,130));
 };
 return {state,async connect(){return {query,release(){}};}};
}
const source=Buffer.from('test-car-photo');
const opt=(qualityMode)=>({color:'original',finish:'original',qualityMode});

test('SK-082 pilot rates: legacy/standard=1, hd=3, invalid rejected',()=>{
 assert.deepEqual(GENERATION_CREDIT_COSTS,{standard:1,hd:3});
 assert.equal(creditCostFor({}),1);
 assert.equal(creditCostFor(opt('standard')),1);
 assert.equal(creditCostFor(opt('hd')),3);
 assert.throws(()=>creditCostFor(opt('invalid')),e=>e.code==='INVALID_OPTIONS');
});

test('HD charges 3 atomically; retry key charges zero extra',async()=>{
 const db=fakeDb(10);const key=randomUUID();
 const first=await enqueue(db,10,key,source,opt('hd'));
 assert.equal(first.balance,7);assert.equal(first.job.creditCost,3);
 assert.equal(db.state.jobs[0].charged_credits,3);
 assert.equal(db.state.ledger[0].delta,-3);
 const again=await enqueue(db,10,key,source,opt('hd'));
 assert.equal(again.job.id,first.job.id);assert.equal(db.state.balance,7);
 assert.equal(db.state.ledger.length,1);
});

test('HD rejects insufficient balance before insert, no debit',async()=>{
 const db=fakeDb(2);
 await assert.rejects(enqueue(db,10,randomUUID(),source,opt('hd')),e=>e.code==='NO_CREDITS');
 assert.equal(db.state.balance,2);assert.equal(db.state.jobs.length,0);assert.equal(db.state.ledger.length,0);
});

test('HD failure refunds all 3 exactly once and logs +3',async()=>{
 const db=fakeDb(5);const job=await enqueue(db,10,randomUUID(),source,opt('hd'));
 assert.equal(db.state.balance,2);
 assert.equal(await failJob(db,job.job.id,'SIMULATED_API_ERROR'),true);
 assert.equal(db.state.balance,5);
 assert.equal(await failJob(db,job.job.id,'SIMULATED_API_ERROR'),false);
 assert.deepEqual(db.state.ledger.map(x=>x.delta),[-3,3]);
});

test('legacy/standard jobs charge and refund exactly 1',async()=>{
 const db=fakeDb(5);const job=await enqueue(db,10,randomUUID(),source,opt('standard'));
 assert.equal(db.state.balance,4);assert.equal(job.job.creditCost,1);
 assert.equal(await failJob(db,job.job.id,'FAIL'),true);
 assert.equal(db.state.balance,5);assert.deepEqual(db.state.ledger.map(x=>x.delta),[-1,1]);
});

test('failed jobs remain idempotent: retry same request key does not debit again',async()=>{
 const db=fakeDb(5);const key=randomUUID();const job=await enqueue(db,10,key,source,opt('hd'));
 await failJob(db,job.job.id,'FAIL');const prev=await enqueue(db,10,key,source,opt('hd'));
 assert.equal(prev.job.status,'failed');assert.equal(db.state.balance,5);
 assert.deepEqual(db.state.ledger.map(x=>x.delta),[-3,3]);
});
