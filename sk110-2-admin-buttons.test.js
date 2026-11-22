import {test} from 'node:test';
import assert from 'node:assert/strict';
import {adminHomeKeyboard,botAdminIds,createBotService} from './bot-service.js';
const a=1122334455,b=9988776655,other=9912345678;
const ticket='11111111-1111-4111-8111-111111111111';
function harness(){
 const out=[],sql=[],media=[],state=new Map();
 let issued=0,stagedCredits=0,replies=0;
 const row=rows=>({rows,rowCount:rows.length});
 const db={
  async query(q,args=[]){
   sql.push({q,args});
   if(q.includes('INSERT INTO bot_rate_limits'))return row([{hits:1}]);
   if(q.includes('INSERT INTO bot_admin_input_state')){state.set(String(args[0]),{action:args[1],ticket_id:args[2],payload:JSON.parse(args[3])});return row([]);}
   if(q.includes('SELECT action,ticket_id,payload FROM bot_admin_input_state')){const st=state.get(String(args[0]));return row(st?[st]:[]);}
   if(q.includes('DELETE FROM bot_admin_input_state')&&q.includes('RETURNING')){const st=state.get(String(args[0]));if(st?.action!==args[1])return row([]);state.delete(String(args[0]));return row([st]);}
   if(q.includes('DELETE FROM bot_admin_input_state')){state.delete(String(args[0]));return row([]);}
   if(q.startsWith('SELECT id,telegram_id,subject,status FROM bot_tickets'))return row([{id:ticket,telegram_id:other,subject:'Фото не загрузилось',status:'open'}]);
   if(q.includes('FROM bot_tickets t LEFT JOIN bot_ticket_diagnostics d'))return row([{id:ticket,telegram_id:other,subject:'Фото не загрузилось',status:'open',created_at:'2026-11-23T08:00:00Z',report_context:{}}]);
   if(q.includes("SELECT id FROM bot_tickets WHERE id=$1 AND status"))return row([{id:ticket}]);
   if(q.includes('SELECT id,telegram_id FROM bot_tickets'))return row([{id:ticket,telegram_id:other}]);
   if(q.includes("UPDATE bot_tickets SET status='answered'")){replies++;return row([]);}
   if(q.includes("UPDATE bot_tickets SET status='closed'"))return row([{telegram_id:other}]);
   if(q.startsWith('SELECT count(*) AS n FROM users'))return row([{n:3}]);
   if(q.startsWith('SELECT count(*) AS n FROM generations'))return row([{n:45}]);
   if(q.includes('FROM bot_promo_codes')&&q.includes('count'))return row([{count:0,activations:0,credits_issued:0}]);
   if(q.includes('INSERT INTO bot_promo_codes')){issued++;return row([]);}
   if(q.includes('INSERT INTO bot_admin_credit_actions')){stagedCredits++;return row([]);}
   if(q.includes('SELECT telegram_id,balance,credit_debt FROM users'))return row([{telegram_id:other,balance:3,credit_debt:0}]);
   if(q.includes('FROM bot_support_state'))return row([{awaiting:false}]);
   if(q.includes('FROM generations')||q.includes('FROM payment_receipts'))return row([]);
   return row([]);
  },
 };
 const handle=createBotService({db,config:{BOT_ADMIN_IDS:[a,b].join(','),BOT_CREDIT_ADMIN_ENABLED:'true',BOT_PROMOS_ENABLED:'true',BOT_TOKEN:'test-token'},send:async(method,data)=>{out.push({method,data});},upload:async(method,data)=>media.push({method,data})});
 const cb=(uid,data)=>handle({callback_query:{id:'cb-'+out.length,from:{id:uid,first_name:'Test',language_code:'ru'},message:{chat:{type:'private',id:uid}},data}});
 const msg=(uid,text)=>handle({message:{from:{id:uid,first_name:'Test',language_code:'ru'},chat:{type:'private',id:uid},text}});
 return {cb,msg,out,sql,state,media,counts:()=>({issued,stagedCredits,replies})};
}
const last=h=>h.out.filter(x=>x.method==='sendMessage').at(-1)?.data;
const buttons=message=>JSON.stringify(message?.reply_markup||{});

test('SK-110.2 two listed admins and no other ID; home keyboard has 8 themed categories',()=>{
 const ids=botAdminIds({BOT_ADMIN_IDS:`${a},${b}`});assert.deepEqual([...ids],[String(a),String(b)]);
 const rows=adminHomeKeyboard().inline_keyboard;
 const texts=rows.flat().map(x=>x.text).join(' / ');
 for(const term of ['Статистика','Себестоимость','Пользователи','Генерации','Промокоды','Балансы','Поддержка','Система'])assert.match(texts,new RegExp(term));
 assert.equal(rows.length,5);
});
test('SK-110.2 public menu never contains admin for non-admin, admin sees admin entry',async()=>{
 const h=harness();await h.msg(other,'/menu');assert.doesNotMatch(buttons(last(h)),/Админка/);
 await h.msg(a,'/menu');assert.match(buttons(last(h)),/Админка/);
 await h.msg(b,'/menu');assert.match(buttons(last(h)),/Админка/);
});
test('SK-110.2 forged admin callback denied before any admin DB operation',async()=>{
 const h=harness();for(const data of ['a','a:credits','a:promos','a:input:promo','a:ticket:'+ticket,'a:ticket:reply:'+ticket,'a:promo:confirm'])await h.cb(other,data);
 assert.equal(h.counts().issued,0);assert.equal(h.state.size,0);
 assert.equal(h.sql.filter(x=>x.q.includes('FROM bot_tickets')).length,0);
 assert(!h.out.some(x=>String(x.data?.text||'').includes('Администрация SkinCar')));
});
test('SK-110.2 admin navigation is grouped and no raw command dump',async()=>{
 const h=harness();await h.cb(a,'a');assert.match(last(h).text,/Администрация SkinCar/);
 assert.doesNotMatch(last(h).text,/\/credit|\/makepromo/);
 await h.cb(a,'a:promos');assert.match(buttons(last(h)),/Создать промокод/);
 await h.cb(a,'a:credits');assert.match(buttons(last(h)),/Начислить|Списать/);
 await h.cb(a,'a:support');assert.match(buttons(last(h)),/Обращения/);
 await h.cb(a,'a:system');assert.match(buttons(last(h)),/Статус бота|Лимиты/);
 await h.cb(a,'a:jobs');assert.match(buttons(last(h)),/Последние 10|Модели/);
 await h.cb(b,'a:users');assert.match(last(h).text,/Всего аккаунтов: 3/);
});
test('SK-110.2 promo creation is two-phase and callback cannot be repeated',async()=>{
 const h=harness();await h.cb(a,'a:input:promo');assert.equal(h.counts().issued,0);
 await h.msg(a,'3 10 7');assert.equal(h.counts().issued,0);
 assert.match(last(h).text,/пока НЕ создан/);
 await h.cb(a,'a:promo:confirm');assert.equal(h.counts().issued,1);
 await h.cb(a,'a:promo:confirm');assert.equal(h.counts().issued,1);
 assert.match(last(h).text,/истекло|использовано/);
});
test('SK-110.2 credit button only stages action, never directly debits user',async()=>{
 const h=harness();await h.cb(b,'a:input:credit');assert.equal(h.counts().stagedCredits,0);
 await h.msg(b,`${other} 5 Проверка`);assert.equal(h.counts().stagedCredits,1);
 assert.match(buttons(last(h)),/Подтвердить/);
 assert.equal(h.sql.filter(x=>x.q.includes('UPDATE users SET balance')).length,0);
});
test('SK-110.2 support tickets offer context buttons, reply input binds to ticket UUID',async()=>{
 const h=harness();await h.cb(a,'a:tickets');assert.match(buttons(last(h)),new RegExp(ticket));
 await h.cb(a,'a:ticket:'+ticket);assert.match(buttons(last(h)),/Ответить|Решено/);
 await h.cb(a,'a:ticket:reply:'+ticket);assert.equal(h.state.get(String(a)).ticket_id,ticket);
 await h.msg(a,'Мы исправили ошибку, попробуйте ещё раз.');
 assert.equal(h.counts().replies,1);
 assert(h.out.some(x=>x.data?.chat_id===other&&/исправили/.test(x.data?.text||'')));
 assert.equal(h.state.has(String(a)),false);
});
test('SK-110.2 admin dialog can be cancelled without creating promos or credits',async()=>{
 const h=harness();await h.cb(a,'a:input:promo');await h.msg(a,'3 10 7');
 await h.cb(a,'a:input:cancel');await h.cb(a,'a:promo:confirm');
 assert.equal(h.counts().issued,0);assert.equal(h.state.size,0);
});
