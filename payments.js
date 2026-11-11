import {randomUUID} from 'node:crypto';
import {transaction,problem} from './generations.js';
const proposed=[{id:'start',name:'START',count:1,price:40},{id:'boost',name:'BOOST',count:5,price:175},{id:'pro',name:'PRO',count:12,price:390}];
export function catalog(userId,config=process.env){
 const mode=config.PAYMENTS_MODE||'pilot';
 const testers=(config.PAYMENT_TESTER_IDS||'306179287,705535713').split(',').map(x=>x.trim());
 return {mode,packs:mode==='live'?proposed:mode==='pilot'&&testers.includes(String(userId))?[{id:'test',name:'TEST',count:1,price:1}]:[]};
}
export async function createInvoice(db,userId,packId,telegram,config=process.env){
 const pack=catalog(userId,config).packs.find(p=>p.id===packId);if(!pack)throw problem(403,'PAYMENTS_UNAVAILABLE');
 const order=await transaction(db,async c=>{
  await c.query('SELECT telegram_id FROM users WHERE telegram_id=$1 FOR UPDATE',[userId]);
  const n=(await c.query("SELECT count(*) AS n FROM payment_orders WHERE telegram_id=$1 AND created_at>now()-interval '1 hour'",[userId])).rows[0];
  if(Number(n.n)>=20)throw problem(429,'INVOICE_LIMIT');
  const id=randomUUID();await c.query('INSERT INTO payment_orders(id,telegram_id,pack_id,credits,stars) VALUES($1,$2,$3,$4,$5)',[id,userId,pack.id,pack.count,pack.price]);return {id};
 });
 const url=await telegram('createInvoiceLink',{title:'SkinCar · '+pack.count+' генерация(й)',description:'Пакет генераций SkinCar. 1 генерация — 1 создание образа. '+(pack.id==='test'?'Тестовая покупка за настоящие Stars.':''),payload:order.id,currency:'XTR',provider_token:'',prices:[{label:'Генерации SkinCar',amount:pack.price}]});
 return {orderId:order.id,url};
}
export async function checkCheckout(db,q,config=process.env){
 return transaction(db,async c=>{
  const o=(await c.query('SELECT * FROM payment_orders WHERE id::text=$1 FOR UPDATE',[q.invoice_payload])).rows[0];
  if(!o||String(o.telegram_id)!==String(q.from?.id)||q.currency!=='XTR'||q.total_amount!==o.stars||o.paid_at||new Date(o.expires_at)<new Date()||!catalog(o.telegram_id,config).packs.some(p=>p.id===o.pack_id))return false;
  if(o.checkout_id&&o.checkout_id!==q.id)return false;
  await c.query('UPDATE payment_orders SET checkout_id=$2 WHERE id=$1',[o.id,q.id]);return true;
 });
}
export async function settlePayment(db,userId,p){
 if(p.currency!=='XTR'||typeof p.telegram_payment_charge_id!=='string')throw problem(400,'INVALID_PAYMENT');
 return transaction(db,async c=>{
  const o=(await c.query('SELECT * FROM payment_orders WHERE id::text=$1 FOR UPDATE',[p.invoice_payload])).rows[0];
  if(!o||String(o.telegram_id)!==String(userId)||o.stars!==p.total_amount)throw problem(400,'INVALID_PAYMENT');
  const receipt=await c.query('INSERT INTO payment_receipts(charge_id,order_id,telegram_id,stars,credits) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING charge_id',[p.telegram_payment_charge_id,o.id,userId,o.stars,o.credits]);
  if(!receipt.rowCount)return false;
  const u=(await c.query('SELECT balance,credit_debt FROM users WHERE telegram_id=$1 FOR UPDATE',[userId])).rows[0];const offset=Math.min(u.credit_debt,o.credits);
  await c.query('UPDATE users SET balance=balance+$2,credit_debt=credit_debt-$3 WHERE telegram_id=$1',[userId,o.credits-offset,offset]);
  await c.query('INSERT INTO credit_ledger(operation_key,telegram_id,delta) VALUES($1,$2,$3)',['stars:'+p.telegram_payment_charge_id,userId,o.credits-offset]);
  await c.query('UPDATE payment_orders SET paid_at=now() WHERE id=$1',[o.id]);return true;
 });
}
export async function applyRefund(db,userId,p){
 return transaction(db,async c=>{
  const r=(await c.query('SELECT * FROM payment_receipts WHERE charge_id=$1 FOR UPDATE',[p.telegram_payment_charge_id])).rows[0];
  if(!r)return false; // Telegram may deliver a refund first; webhook ensures original receipt exists.
  if(String(r.telegram_id)!==String(userId)||r.stars!==p.total_amount||p.currency!=='XTR')throw problem(400,'INVALID_PAYMENT');
  if(r.refunded_at)return false;
  const u=(await c.query('SELECT balance FROM users WHERE telegram_id=$1 FOR UPDATE',[userId])).rows[0];const debit=Math.min(u.balance,r.credits);
  await c.query('UPDATE users SET balance=balance-$2,credit_debt=credit_debt+$3 WHERE telegram_id=$1',[userId,debit,r.credits-debit]);
  await c.query('UPDATE payment_receipts SET refunded_at=now() WHERE charge_id=$1',[r.charge_id]);
  await c.query('INSERT INTO credit_ledger(operation_key,telegram_id,delta) VALUES($1,$2,$3)',['stars-refund:'+r.charge_id,userId,-debit]);return true;
 });
}
