// SK-106 admin credit and promo operations. Always use explicit Telegram ID + DB transaction.
// No secrets or promotion plaintext stored in the database.
import {randomBytes,randomUUID,createHmac} from 'node:crypto';
const problem=(code)=>Object.assign(new Error(code),{code});
const validId=x=>/^[1-9]\d{3,15}$/.test(String(x));
const guid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hashCode=(code,token)=>createHmac('sha256',token).update(code.trim().toUpperCase()).digest('hex');
async function transact(db,callback){const c=await db.connect();try{await c.query('BEGIN');const ret=await callback(c);await c.query('COMMIT');return ret;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
export async function stageCreditAction(db,{adminId,targetId,delta,reason}){
 if(!validId(adminId)||!validId(targetId)||!Number.isInteger(delta)||delta===0||Math.abs(delta)>100||typeof reason!=='string'||reason.trim().length<3||reason.length>160)throw problem('INVALID_ADMIN_ACTION');
 const target=(await db.query('SELECT telegram_id,balance,credit_debt FROM users WHERE telegram_id=$1',[targetId])).rows[0];if(!target)throw problem('USER_NOT_FOUND');
 const id=randomUUID();await db.query(`INSERT INTO bot_admin_credit_actions(id,admin_id,target_id,delta,reason,status)
 VALUES($1,$2,$3,$4,$5,'pending')`,[id,adminId,targetId,delta,reason.trim()]);
 return {id,targetId,delta,balance:Number(target.balance),debt:Number(target.credit_debt)};
}
export async function cancelCreditAction(db,{adminId,id}){
 if(!guid.test(id)||!validId(adminId))throw problem('INVALID_ADMIN_ACTION');
 const r=await db.query(`UPDATE bot_admin_credit_actions SET status='cancelled' WHERE id=$1 AND admin_id=$2 AND status='pending' RETURNING id`,[id,adminId]);return !!r.rowCount;
}
export async function confirmCreditAction(db,{adminId,id}){
 if(!guid.test(id)||!validId(adminId))throw problem('INVALID_ADMIN_ACTION');
 return transact(db,async c=>{
  const action=(await c.query(`SELECT * FROM bot_admin_credit_actions WHERE id=$1 AND admin_id=$2 AND status='pending' AND created_at>now()-interval '10 minutes' FOR UPDATE`,[id,adminId])).rows[0];
  if(!action)throw problem('ACTION_EXPIRED_OR_ALREADY_USED');
  const target=(await c.query('SELECT telegram_id,balance,credit_debt FROM users WHERE telegram_id=$1 FOR UPDATE',[action.target_id])).rows[0];if(!target)throw problem('USER_NOT_FOUND');
  const delta=Number(action.delta);
  if(delta<0&&Number(target.balance)<-delta)throw problem('INSUFFICIENT_BALANCE');
  const debtRepaid=delta>0?Math.min(delta,Number(target.credit_debt)):0;
  const applied=delta-debtRepaid;
  await c.query('UPDATE users SET balance=balance+$2,credit_debt=credit_debt-$3 WHERE telegram_id=$1',[action.target_id,applied,debtRepaid]);
  await c.query('INSERT INTO credit_ledger(operation_key,telegram_id,delta) VALUES($1,$2,$3)',[`bot-admin:${id}`,action.target_id,applied]);
  await c.query(`UPDATE bot_admin_credit_actions SET status='applied',applied_delta=$2,debt_repaid=$3,confirmed_at=now() WHERE id=$1`,[id,applied,debtRepaid]);
  return {targetId:String(action.target_id),delta,applied,debtRepaid};
 });
}
export async function issuePromo(db,{adminId,credits,maxUses,days,botToken}){
 if(!validId(adminId)||!Number.isInteger(credits)||credits<1||credits>20||!Number.isInteger(maxUses)||maxUses<1||maxUses>100||!Number.isInteger(days)||days<1||days>30||!botToken)throw problem('INVALID_PROMO');
 const code=`SC-${randomBytes(12).toString('hex').toUpperCase()}`;
 const codeHash=hashCode(code,botToken);
 await db.query(`INSERT INTO bot_promo_codes(code_hash,credits,max_uses,expires_at,created_by)
 VALUES($1,$2,$3,now()+($4::integer*interval '1 day'),$5)`,[codeHash,credits,maxUses,days,adminId]);
 return {code,credits,maxUses,days};
}
export async function redeemPromo(db,{userId,code,botToken}){
 if(!validId(userId)||typeof code!=='string'||!/^SC-[A-F0-9]{24}$/i.test(code.trim())||!botToken)throw problem('INVALID_PROMO');
 const codeHash=hashCode(code,botToken);
 return transact(db,async c=>{
  const promo=(await c.query(`SELECT code_hash,credits,max_uses,uses FROM bot_promo_codes WHERE code_hash=$1 AND active=true AND expires_at>now() FOR UPDATE`,[codeHash])).rows[0];
  if(!promo||Number(promo.uses)>=Number(promo.max_uses))throw problem('PROMO_UNAVAILABLE');
  const previous=await c.query(`INSERT INTO bot_promo_redemptions(code_hash,telegram_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING code_hash`,[codeHash,userId]);
  if(!previous.rowCount)throw problem('PROMO_ALREADY_USED');
  const u=(await c.query('SELECT balance,credit_debt FROM users WHERE telegram_id=$1 FOR UPDATE',[userId])).rows[0];if(!u)throw problem('USER_NOT_FOUND');
  const credits=Number(promo.credits),repaid=Math.min(Number(u.credit_debt),credits),added=credits-repaid;
  await c.query('UPDATE bot_promo_codes SET uses=uses+1 WHERE code_hash=$1',[codeHash]);
  await c.query('UPDATE users SET balance=balance+$2,credit_debt=credit_debt-$3 WHERE telegram_id=$1',[userId,added,repaid]);
  await c.query('INSERT INTO credit_ledger(operation_key,telegram_id,delta) VALUES($1,$2,$3)',[`bot-promo:${codeHash}:${userId}`,userId,added]);
  return {credits,added,repaid};
 });
}
export async function promoSummary(db){const r=await db.query(`SELECT count(*) AS count,coalesce(sum(uses),0) AS activations,
 coalesce(sum(credits*uses),0) AS credits_issued FROM bot_promo_codes`);return r.rows[0];}
