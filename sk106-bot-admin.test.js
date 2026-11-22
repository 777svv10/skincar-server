import {test} from 'node:test';
import assert from 'node:assert/strict';
import {stageCreditAction,cancelCreditAction,confirmCreditAction,issuePromo,redeemPromo} from './bot-admin-ops.js';
const id='11111111-1111-4111-8111-111111111111';
const adminId=123456,userId=987654;
const r=rows=>({rows,rowCount:rows.length});
function fakeAdminDb({balance=3,debt=0,actionStatus='pending'}={}){
 const seen=[];const state={balance,debt,status:actionStatus};
 const query=async(sql,params=[])=>{
  seen.push({sql,params});
  if(sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK')return r([]);
  if(sql.startsWith('SELECT telegram_id,balance,credit_debt FROM users WHERE telegram_id=$1 FOR UPDATE'))return r([{telegram_id:userId,balance:state.balance,credit_debt:state.debt}]);
  if(sql.startsWith('SELECT telegram_id,balance,credit_debt FROM users WHERE telegram_id=$1'))return r([{telegram_id:userId,balance:state.balance,credit_debt:state.debt}]);
  if(sql.includes('FROM bot_admin_credit_actions WHERE'))return r(state.status==='pending'?[{id,admin_id:adminId,target_id:userId,delta:5,reason:'Test refill'}]:[]);
  if(sql.startsWith('INSERT INTO bot_admin_credit_actions'))return r([{id}]);
  if(sql.startsWith('UPDATE users SET balance=balance+$2')){state.balance+=params[1];state.debt-=params[2];return r([])}
  if(sql.startsWith('UPDATE bot_admin_credit_actions SET status=\'applied\'')){state.status='applied';return r([])}
  if(sql.startsWith('UPDATE bot_admin_credit_actions SET status=\'cancelled\'')){if(state.status==='pending'){state.status='cancelled';return r([{id}]);}return r([])}
  return r([]);
 };
 return {seen,state,db:{query,connect:async()=>({query,release:()=>{}})}};
}
test('SK-106 cannot stage credit action without valid target, signed amount and reason',async()=>{
 const {db}=fakeAdminDb();
 await assert.rejects(stageCreditAction(db,{adminId,targetId:userId,delta:0,reason:'test'}),/INVALID_ADMIN_ACTION/);
 await assert.rejects(stageCreditAction(db,{adminId,targetId:userId,delta:101,reason:'test'}),/INVALID_ADMIN_ACTION/);
 await assert.rejects(stageCreditAction(db,{adminId,targetId:userId,delta:1,reason:'x'}),/INVALID_ADMIN_ACTION/);
});
test('SK-106 staged admin credit does not change balance until explicit confirm',async()=>{
 const {db,seen,state}=fakeAdminDb();const result=await stageCreditAction(db,{adminId,targetId:userId,delta:5,reason:'Tester compensation'});
 assert.equal(result.delta,5);assert.equal(state.balance,3);
 assert(!seen.some(x=>x.sql.includes('UPDATE users SET')));
});
test('SK-106 credits repay debt before increasing spendable balance; records ledger',async()=>{
 const {db,state,seen}=fakeAdminDb({balance:3,debt:2});
 const result=await confirmCreditAction(db,{adminId,id});
 assert.deepEqual({applied:result.applied,debtRepaid:result.debtRepaid},{applied:3,debtRepaid:2});
 assert.equal(state.balance,6);assert.equal(state.debt,0);
 assert(seen.some(x=>x.sql.includes('INSERT INTO credit_ledger')&&x.params[0]===`bot-admin:${id}`));
 assert(seen.some(x=>x.sql==='COMMIT'));
});
test('SK-106 second confirmation cannot apply same admin action twice',async()=>{
 const {db}=fakeAdminDb({actionStatus:'applied'});
 await assert.rejects(confirmCreditAction(db,{adminId,id}),/ACTION_EXPIRED_OR_ALREADY_USED/);
});
test('SK-106 cancel disallows later confirm',async()=>{
 const {db}=fakeAdminDb();assert.equal(await cancelCreditAction(db,{adminId,id}),true);
 await assert.rejects(confirmCreditAction(db,{adminId,id}),/ACTION_EXPIRED_OR_ALREADY_USED/);
});
test('SK-106 promo is random high-entropy and only hash stored',async()=>{
 const calls=[];const db={query:async(sql,values)=>{calls.push({sql,values});return r([])}};
 const p=await issuePromo(db,{adminId,credits:5,maxUses:10,days:7,botToken:'test-only-telegram-token'});
 assert.match(p.code,/^SC-[A-F0-9]{24}$/);
 assert(!calls[0].values.includes(p.code));assert.equal(calls[0].values[0].length,64);
});
test('SK-106 promo rejects externally supplied weak code before touching DB',async()=>{
 let n=0;const db={connect:async()=>{n++;throw Error()}};
 await assert.rejects(redeemPromo(db,{userId,code:'WIN',botToken:'t'}),/INVALID_PROMO/);
 assert.equal(n,0);
});
