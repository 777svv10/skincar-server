import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createBotService,botPersistentKeyboard,botStatusSummary} from './bot-service.js';
const uid=442211;
const car='11111111-1111-4111-8111-111111111111';
const job='33333333-3333-4333-8333-333333333333';
const url='https://skincar01.netlify.app/';
const update=(text)=>({message:{from:{id:uid,first_name:'Tester',language_code:'ru'},chat:{id:uid,type:'private'},text}});
function env(jobs=[]){
 const sent=[],queries=[];
 const db={async query(sql,values=[]){
  queries.push({sql,values});
  if(sql.includes('bot_rate_limits'))return {rows:[{hits:1}]};
  if(sql.includes('FROM generations g LEFT JOIN vehicles v'))return {rows:jobs};
  return {rows:[]};
 }};
 const handle=createBotService({db,config:{APP_URL:url},send:async(method,data)=>{sent.push({method,data})},upload:async()=>{throw Error('Unexpected upload')}});
 return {handle,sent,queries};
}
test('SK-107 reply keyboard provides TWO adjacent buttons and is persistent in three languages',()=>{
 for(const lang of ['ru','kk','en']){
  const k=botPersistentKeyboard(lang,url);
  assert.equal(k.keyboard.length,1);
  assert.equal(k.keyboard[0].length,2);
  assert.equal(k.keyboard[0][0].web_app.url,url);
  assert.equal(k.keyboard[0][1].web_app,undefined);
  assert.equal(k.is_persistent,true);
  assert.equal(k.resize_keyboard,true);
 }
 assert.equal(botPersistentKeyboard('ru',url).keyboard[0][1].text,'☰ Меню');
});
test('SK-107 /start exposes two permanent actions; Menu exposes actual inline bot menu',async()=>{
 const h=env();await h.handle(update('/start'));
 assert.equal(h.sent.length,1);assert(h.sent[0].data.reply_markup.keyboard);
 await h.handle(update('☰ Меню'));
 assert.equal(h.sent.length,2);
 assert.match(JSON.stringify(h.sent.at(-1).data.reply_markup),/Мой гараж/);
 await h.handle(update('/menu'));
 assert.match(JSON.stringify(h.sent.at(-1).data.reply_markup),/Статус работ/);
});
test('SK-107 status summary collapses repetitive Ready statuses and identifies cars/HD',()=>{
 const rows=Array.from({length:8},(_,i)=>({id:job,status:'done',options:{qualityMode:i===0?'hd':'standard'},vehicle_make:'BMW',vehicle_model:'X6',vehicle_generation:'G06',created_at:'2026-11-22T11:30:00Z'}));
 const s=botStatusSummary('ru',rows);
 assert.match(s,/последние 8 запросов/);
 assert.match(s,/Готово: 8/);
 assert.match(s,/BMW X6 G06/);
 assert.match(s,/HD/);
 assert.equal((s.match(/Готово/g)||[]).length,6); // one aggregate + five detailed rows
 assert(!s.includes('undefined'));
});
test('SK-107 status summary handles no results, varied progress, and legacy quality',()=>{
 assert.match(botStatusSummary('ru',[]),/пока нет/);
 const r=[{status:'processing',options:{},vehicle_name:'Infiniti QX80'},{status:'failed',options:{qualityMode:'standard'},vehicle_name:'Kia Ceed'}];
 const s=botStatusSummary('ru',r);assert.match(s,/В работе: 1/);assert.match(s,/Ошибки: 1/);assert.match(s,/Infiniti QX80/);assert.match(s,/· —/);
 assert.match(botStatusSummary('kk',r),/Дайын/);assert.match(botStatusSummary('en',r),/Recent results/);
});
test('SK-107 status SQL only joins owner cars and offers preview only of completed owner jobs',async()=>{
 const jobs=[{id:job,vehicle_id:car,status:'done',options:{qualityMode:'hd'},vehicle_make:'BMW',vehicle_model:'X6',vehicle_generation:'G06',created_at:'2026-11-22T11:30:00Z'}];
 const h=env(jobs);await h.handle(update('/status'));
 const sql=h.queries.find(x=>x.sql.includes('FROM generations g LEFT JOIN vehicles v'));
 assert(sql);assert.deepEqual(sql.values,[uid]);assert.match(sql.sql,/v.telegram_id=g.telegram_id/);assert.match(sql.sql,/g.telegram_id=\$1/);
 const markup=h.sent.at(-1).data.reply_markup;
 assert(markup.inline_keyboard.some(row=>row.some(b=>b.callback_data===`w:${job}:p`)));
 const h2=env([{...jobs[0],vehicle_id:null}]);await h2.handle(update('/status'));
 assert(!JSON.stringify(h2.sent.at(-1).data.reply_markup).includes(`w:${job}`));
});
test('SK-107 status messages remain under Telegram 4096-character limit for 8 long titles',()=>{
 const jobs=Array.from({length:8},(_,i)=>({status:'done',options:{qualityMode:'hd'},vehicle_name:'X'.repeat(1000),created_at:'2026-11-22T11:30:00Z'}));
 assert(botStatusSummary('ru',jobs).length<4096);
});
