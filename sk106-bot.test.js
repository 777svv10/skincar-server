import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createBotService,botCallback,botAdminIds,telegramMultipart,botMediaName,searchFaq,queueReadyNotification,flushReadyNotifications} from './bot-service.js';
const car='11111111-1111-4111-8111-111111111111';
const image='22222222-2222-4222-8222-222222222222';
const job='33333333-3333-4333-8333-333333333333';
const u=442211;
const photo=Buffer.from('FAKE_JPEG_BYTES_NOT_RECOMPRESSED');
const cb=(data,id=u,chatId=id)=>({callback_query:{id:'cb:42',from:{id,first_name:'Tester',language_code:'ru'},message:{chat:{type:'private',id:chatId}},data}});
const msg=(text,id=u)=>({message:{from:{id,first_name:'Tester',language_code:'ru'},chat:{type:'private',id},text}});
function harness({owner=true,deleted=false,admin='',support=false}={}){
 const queries=[],out=[],media=[];
 const db={async query(sql,values=[]){queries.push({sql,values});
  if(sql.includes('bot_rate_limits'))return {rows:[{hits:1}]};
  if(sql.includes('FROM vehicles WHERE id=$1 AND telegram_id=$2'))return {rows:owner&&!deleted?[{id:car,name:'BMW G06',make:'BMW',model:'X6 G06'}]:[]};
  if(sql.includes('FROM vehicles v WHERE v.id=$1 AND v.telegram_id=$2'))return {rows:owner&&!deleted?[{id:car,name:'BMW G06',source_image:photo,original_image:photo,original_mime:'image/jpeg'}]:[]};
  if(sql.includes('FROM generations g\n   JOIN vehicles v'))return {rows:owner&&!deleted?[{id:job,result_image:photo,thumbnail:photo,source_image:photo,options:{qualityMode:'hd'}}]:[]};
  if(sql.includes('FROM vehicle_photos p\n   JOIN vehicles'))return {rows:owner&&!deleted?[{id:image,source_image:photo,original_image:photo,original_mime:'image/jpeg'}]:[]};
  if(sql.includes('FROM generations WHERE telegram_id=$1 AND options->>'))return {rows:[{looks:1,n:1}]};
  if(sql.includes('FROM users WHERE telegram_id=$1'))return {rows:[{balance:10,credit_debt:0}]};
  if(sql.includes('FROM bot_support_state WHERE'))return {rows:[{awaiting:support}]};
  if(sql.includes('FROM bot_tickets WHERE telegram_id'))return {rows:[]};
  if(sql.includes('FROM bot_preferences WHERE'))return {rows:[{notify_ready:false}]};
  if(sql.includes('FROM generations WHERE telegram_id=$1 AND NOT archived'))return {rows:[]};
  if(sql.includes('FROM payment_receipts r'))return {rows:[]};
  if(sql.includes('SELECT count(*) AS n FROM vehicles WHERE'))return {rows:[{n:1}]};
  if(sql.includes('FROM vehicles v WHERE v.telegram_id=$1'))return {rows:[{id:car,name:'BMW G06',make:'BMW',model:'X6 G06',looks:1}]};
  if(sql.includes('FROM generations WHERE telegram_id=$1 AND NOT archived'))return {rows:[]};
  if(sql.includes('FROM generations WHERE telegram_id=$1 AND options->>'))return {rows:[{n:1,looks:1}]};
  if(sql.includes('FROM generations WHERE telegram_id=$1 AND NOT archived'))return {rows:[]};
  return {rows:[]};
 }};
 const send=async(method,data)=>{out.push({method,data});return {ok:true}};
 const upload=async(method,data)=>{media.push({method,data});return {ok:true}};
 const handle=createBotService({db,config:{APP_URL:'https://skincar01.netlify.app/',BOT_ADMIN_IDS:admin},send,upload});
 return {db,queries,out,media,handle};
}
test('SK-106 callback parser accepts UUID only, bounded pages and rejects injections',()=>{
 assert.deepEqual(botCallback(`v:${car}`),{type:'vehicle',id:car});
 assert.equal(botCallback('v:../../..'),null);
 assert.equal(botCallback(`w:${job}:f`)?.operation,'f');
 assert.equal(botCallback(`x:${car}:0`)?.type,'photos');
 assert.equal(botCallback('a:today'),null);
 assert.equal(botCallback('x'.repeat(65)),null);
});
test('SK-106 explicit admin allowlist; user-controlled nicknames do not authorize',()=>{
 assert.equal(botAdminIds({BOT_ADMIN_IDS:'1234, 9009, @admin, hello'}).has('9009'),true);
 assert.equal(botAdminIds({BOT_ADMIN_IDS:'1234, 9009, @admin, hello'}).has('@admin'),false);
});
test('SK-106 ignores group and chat/from ID mismatch before any database activity',async()=>{
 const h=harness();await h.handle(cb(`w:${job}:f`,u,999));
 assert.equal(h.out.length,0);assert.equal(h.media.length,0);assert.equal(h.queries.length,0);
});
test('SK-106 /start adds menu with garage, settings and web_app; no admin for visitor',async()=>{
 const h=harness();await h.handle(msg('/start'));
 const out=h.out.find(x=>x.method==='sendMessage');assert.match(out.data.text,/SkinCar/);
 const kb=JSON.stringify(out.data.reply_markup);assert.match(kb,/Мой гараж/);assert.match(kb,/web_app/);assert.doesNotMatch(kb,/Админка/);
});
test('SK-106 garage lists only user cars via owner parameter',async()=>{
 const h=harness();await h.handle(cb('g:0'));
 assert(h.queries.some(x=>/FROM vehicles v WHERE v.telegram_id=\$1/.test(x.sql)&&x.values[0]===u));
 assert(h.out.some(x=>/Мой гараж/.test(x.data.text||'')));
});
test('SK-106 stale deleted car callback sends explanation and NEVER media',async()=>{
 const h=harness({deleted:true});await h.handle(cb(`b:${car}:f`));
 assert.equal(h.media.length,0);assert(h.out.some(x=>/больше нет/.test(x.data.text||'')));
});
test('SK-106 old generation button after deletion cannot fetch result',async()=>{
 const h=harness({deleted:true});await h.handle(cb(`w:${job}:f`));
 assert.equal(h.media.length,0);assert(h.out.some(x=>/недоступен/.test(x.data.text||'')));
 assert(h.queries.some(x=>x.sql.includes('JOIN vehicles v')&&x.values[1]===u));
});
test('SK-106 original car file delivered as unchanged bytes via sendDocument',async()=>{
 const h=harness();await h.handle(cb(`b:${car}:f`));
 assert.equal(h.media.length,1);assert.equal(h.media[0].method,'sendDocument');
 assert.deepEqual(h.media[0].data.bytes,photo);
 assert.equal(h.media[0].data.mime,'image/jpeg');
});
test('SK-106 finished look is delivered unchanged as document',async()=>{
 const h=harness();await h.handle(cb(`w:${job}:f`));
 assert.equal(h.media.length,1);assert.equal(h.media[0].method,'sendDocument');
 assert.deepEqual(h.media[0].data.bytes,photo);
 assert(h.queries.some(x=>x.values[1]===u));
});
test('SK-106 extra source photo delivered through vehicle owner join',async()=>{
 const h=harness();await h.handle(cb(`y:${image}:f`));
 assert.equal(h.media[0].method,'sendDocument');assert.deepEqual(h.media[0].data.bytes,photo);
 assert(h.queries.some(x=>x.sql.includes('JOIN vehicles v ON v.id=p.vehicle_id AND v.telegram_id=$2')));
});
test('SK-106 preview does not call file download, uses sendPhoto',async()=>{
 const h=harness();await h.handle(cb(`w:${job}:p`));assert.equal(h.media[0].method,'sendPhoto');
});
test('SK-106 admin commands deny non-admin even when guessing /stats',async()=>{
 const h=harness();await h.handle(msg('/stats'));assert(h.out.some(x=>/главное меню/.test(x.data.text||'')));
 assert(!h.queries.some(x=>x.sql.includes('FROM generations WHERE created_at')));
});
test('SK-106 FAQ searches by real words',()=>{
 assert(searchFaq('Что после удаления автомобиля?').includes(3));
 assert(searchFaq('HD Standard').includes(1));
});
test('SK-106 upload uses multipart/form-data and does not transform JPEG bytes',async()=>{
 let captured;
 const fetched=async(url,options)=>{captured={url,options};return {ok:true,json:async()=>({ok:true,result:{message_id:2}})}};
 const result=await telegramMultipart('test_TOKEN','sendDocument',{chat_id:u,field:'document',bytes:photo,filename:botMediaName('result',job),mime:'image/jpeg'},fetched);
 assert.equal(result.message_id,2);assert.match(captured.url,/sendDocument$/);
 const file=captured.options.body.get('document');
 assert.deepEqual(Buffer.from(await file.arrayBuffer()),photo);
 assert.equal(captured.options.body.get('chat_id'),String(u));
});
test('SK-106 rejects over-limit media without calling Telegram',async()=>{
 let sent=false;
 await assert.rejects(telegramMultipart('token','sendPhoto',{chat_id:u,field:'photo',bytes:Buffer.alloc(48*1024*1024+1),filename:'x.jpg'},async()=>{sent=true}),/BOT_MEDIA_INVALID_SIZE/);
 assert.equal(sent,false);
});
test('SK-106 queue notification SQL always requires opt-in, existing vehicle and completed job',async()=>{
 const queries=[];
 await queueReadyNotification({query:async(sql,params)=>{queries.push({sql,params})}},job,u);
 assert.match(queries[0].sql,/p.notify_ready=true/);assert.match(queries[0].sql,/JOIN vehicles v/);
 assert.deepEqual(queries[0].params,[job,u]);
});
test('SK-106 notification outbox skips deleted jobs without sending',async()=>{
 let n=0;const db={query:async(sql)=>{
  if(sql.includes('FROM bot_notification_outbox n'))return {rows:[{generation_id:job,telegram_id:u}]};
  if(sql.includes('SELECT g.id FROM generations'))return {rows:[]};
  if(sql.includes('SET sent_at=now()')){n++;return {rows:[]}};
  throw Error(sql);
 }};let calls=0;
 await flushReadyNotifications(db,async()=>{calls++});assert.equal(calls,0);assert.equal(n,1);
});
