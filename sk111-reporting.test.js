import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reportToken,reportTokenHash,reportContext,startReport,consumeReport,screenshotInfo,diagnosticsText} from './report-intake.js';
import {ratePolicy,RATE_LIMITS} from './api-security.js';
import {createBotService} from './bot-service.js';
const owner=101001,other=202002,admin1=303003,admin2=404004;
const UUID='11111111-1111-4111-8111-111111111111';
const message=(id,text)=>({message:{from:{id,language_code:'ru'},chat:{type:'private',id},text}});
const photoMsg=(id,fileId,caption='')=>({message:{from:{id,language_code:'ru'},chat:{type:'private',id},photo:[{file_id:fileId,file_size:23000}],caption}});
const cb=(id,data)=>({callback_query:{id:'c'+Math.random(),from:{id,language_code:'ru'},message:{chat:{type:'private',id}},data}});

test('SK-111 cryptographic token has high entropy, hashed DB key and fixed 36 hex format',()=>{
 const a=reportToken(),b=reportToken();assert.match(a,/^[a-f0-9]{36}$/);assert.notEqual(a,b);
 assert.equal(reportTokenHash(a).length,64);assert(!reportTokenHash(a).includes(a));
});
test('SK-111 report context excludes credentials, email, arbitrary fields and invalid IDs',()=>{
 const c=reportContext({screen:'<script>Editor',device:'iPhone',requestId:'a'.repeat(24),generationId:UUID,authorization:'Bearer secret',session:'secret',errorCode:'BAD\nCODE'});
 assert.equal(c.screen,'script Editor');assert.equal(c.requestId,'a'.repeat(24));assert.equal(c.generationId,UUID);
 assert(!JSON.stringify(c).includes('Bearer'));assert(!JSON.stringify(c).includes('secret'));
 assert.equal(reportContext({generationId:'not-a-uuid'}).generationId,'');
});
test('SK-111 report link ties valid generation to owner and returns only opaque Telegram URL',async()=>{
 const calls=[],db={query:async(sql,args)=>{calls.push({sql,args});if(sql.includes('FROM generations'))return {rows:[{id:UUID,model:'x',status:'done',quality:'hd'}]};return {rows:[],rowCount:1};}};
 const r=await startReport(db,owner,{generationId:UUID,screen:'garage',requestId:'c'.repeat(24)});
 assert.match(r.url,/^https:\/\/t\.me\/skincartuning_bot\?start=report_[a-f0-9]{36}$/);
 assert.equal(r.expiresIn,600);
 assert.deepEqual(calls[0].args,[UUID,owner]);
 assert.equal(calls[1].args[0].length,64);assert(!calls[1].args[2].includes('session'));
});
test('SK-111 forged generation ID cannot be reported under other account',async()=>{
 const db={query:async()=>({rows:[]})};
 await assert.rejects(startReport(db,other,{generationId:UUID}),e=>e.status===404);
});
test('SK-111 redemption rejects guessed, malformed, reused, expired, and foreign token',async()=>{
 let used=false;
 const good=reportToken();const db={query:async(sql,args)=>{
  assert.match(sql,/telegram_id=\$2 AND consumed_at IS NULL AND expires_at>now\(\)/);
  assert.equal(args[0],reportTokenHash(good));
  if(args[1]!==owner||used)return {rows:[]};used=true;return {rows:[{context:{screen:'editor'}}]};}};
 assert.equal(await consumeReport(db,other,good),null);
 assert.deepEqual(await consumeReport(db,owner,good),{screen:'editor'});
 assert.equal(await consumeReport(db,owner,good),null);
 assert.equal(await consumeReport(db,owner,'bad'),null);
});
test('SK-111 screenshot accepts size-bounded photos and JPEG/PNG documents only',()=>{
 assert.deepEqual(screenshotInfo({photo:[{file_id:'fileA',file_size:456}]}),{fileId:'fileA',kind:'photo'});
 assert.deepEqual(screenshotInfo({document:{file_id:'fileB',file_size:1234,mime_type:'image/png'}}),{fileId:'fileB',kind:'document'});
 assert.equal(screenshotInfo({document:{file_id:'x',file_size:20,mime_type:'application/pdf'}}),null);
 assert.equal(screenshotInfo({photo:[{file_id:'x',file_size:11*1024*1024}]}),null);
});
test('SK-111 report throttling is separate from generation budget and uses shared DB counters',()=>{
 assert.equal(ratePolicy('/api/reports/start','POST'),'report');assert.deepEqual(RATE_LIMITS.report,[[60,3],[3600,10]]);
});
test('SK-111 structured diagnostic card does not reveal arbitrary fields or private secrets',()=>{
 const t=diagnosticsText({report_context:{screen:'result',appVersion:'SK-111',requestId:'a'.repeat(24),session:'secret',apiKey:'bad'},created_at:'2026-11-23T10:03:00Z'});
 assert.match(t,/Request ID/);assert.match(t,/10:03:00/);assert(!t.includes('secret'));assert(!t.includes('apiKey'));
});
function botHarness(){
 const state=new Map(),links=new Map(),tickets=new Map(),diagnostics=new Map(),calls=[],out=[];
 const db={
  async query(sql,a=[]){calls.push({sql,a});
   if(sql.includes('INSERT INTO users'))return {rows:[]};
   if(sql.includes('INSERT INTO bot_rate_limits'))return {rows:[{hits:1}]};
   if(sql.includes('UPDATE bot_report_links SET consumed_at')){
    const tok=links.get(a[0]);if(!tok||tok.owner!==a[1]||tok.used)return {rows:[]};tok.used=true;return {rows:[{context:tok.context}]};}
   if(sql.includes('INSERT INTO bot_support_state')){state.set(a[0],{awaiting:true,report_context:JSON.parse(a[1]),screenshot_file_id:null,screenshot_kind:null,pending_ticket_id:null});return {rows:[]};}
   if(sql.includes('SELECT awaiting,pending_ticket_id FROM bot_support_state')){const x=state.get(a[0]);return {rows:x?[x]:[]};}
   if(sql.includes('UPDATE bot_support_state SET screenshot_file_id')){let x=state.get(a[0]);x.screenshot_file_id=a[1];x.screenshot_kind=a[2];return {rows:[]};}
   if(sql.includes('UPDATE bot_ticket_diagnostics SET screenshot_file_id')){
    const d=diagnostics.get(a[0]);if(!d||d.screenshot_file_id||tickets.get(a[0])?.owner!==a[1])return {rowCount:0,rows:[]};d.screenshot_file_id=a[2];d.screenshot_kind=a[3];return {rowCount:1,rows:[{ticket_id:a[0]}]};}
   if(sql.includes('UPDATE bot_support_state SET pending_ticket_id=NULL')){let x=state.get(a[0]);x.pending_ticket_id=null;return {rows:[]};}
   if(sql.includes('FROM bot_tickets t LEFT JOIN bot_ticket_diagnostics d')){const t=tickets.get(a[0]),d=diagnostics.get(a[0]);return {rows:t?[{id:a[0],telegram_id:t.owner,subject:t.subject,status:t.status,created_at:'2026-11-23T10:00:00Z',report_context:d?.report_context,screenshot_file_id:d?.screenshot_file_id,screenshot_kind:d?.screenshot_kind}]:[]};}
   if(sql.includes('FROM bot_ticket_diagnostics WHERE ticket_id')){const d=diagnostics.get(a[0]);return {rows:d?[d]:[]};}
   if(sql.includes('FROM bot_support_state')||sql.startsWith('SELECT report_context')){const x=state.get(a[0]);return {rows:x?[x]:[]};}
   if(sql.startsWith('UPDATE bot_tickets SET status=')){const t=tickets.get(a[0]);if(t)t.status='answered';return {rows:[]};}
   return {rows:[],rowCount:0};
  },
  async connect(){return {release(){},query:async(sql,a=[])=>{
   calls.push({sql,a});if(sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK')return {rows:[]};
   if(sql.includes('FROM bot_support_state WHERE telegram_id=$1 AND awaiting=true FOR UPDATE')){const x=state.get(a[0]);return {rows:x?.awaiting?[{...x}]:[]};}
   if(sql.includes('UPDATE bot_support_state SET awaiting=false')){const x=state.get(a[0]);x.awaiting=false;x.pending_ticket_id=a[1];return {rows:[]};}
   if(sql.includes('INSERT INTO bot_tickets')){tickets.set(a[0],{owner:a[1],subject:a[2],status:'open'});return {rows:[]};}
   if(sql.includes('INSERT INTO bot_ticket_diagnostics')){diagnostics.set(a[0],{report_context:JSON.parse(a[1]),screenshot_file_id:a[2],screenshot_kind:a[3]});return {rows:[]};}
   throw Error('unexpected transaction SQL '+sql);
  }};}
 };
 const handle=createBotService({db,config:{BOT_ADMIN_IDS:[admin1,admin2].join(','),BOT_TOKEN:'test'},send:async(method,data)=>{out.push({method,data})},upload:async()=>{throw Error('media upload unexpected')}});
 return {state,links,tickets,diagnostics,calls,out,handle};
}
test('SK-111 bot completes single-use deep link, screenshot first, then description; both admins notified',async()=>{
 const h=botHarness(),token=reportToken();h.links.set(reportTokenHash(token),{owner,context:{screen:'review',requestId:'f'.repeat(24)}});
 await h.handle(message(other,'/start report_'+token));assert.equal(h.tickets.size,0);
 await h.handle(message(owner,'/start report_'+token));assert.equal(h.state.get(owner).awaiting,true);
 await h.handle(photoMsg(owner,'telegram-file-id'));assert.equal(h.state.get(owner).screenshot_file_id,'telegram-file-id');
 await h.handle(message(owner,'Ошибка при создании образа'));
 assert.equal(h.tickets.size,1);assert.equal([...h.diagnostics.values()][0].screenshot_file_id,'telegram-file-id');
 assert(h.out.filter(x=>x.method==='sendPhoto').length===2);
 assert(h.out.filter(x=>String(x.data?.chat_id)===String(admin1)&&/Request ID/.test(x.data?.text||'')).length===1);
 await h.handle(message(owner,'/start report_'+token));assert.equal(h.tickets.size,1);
});
test('SK-111 admin screenshot requires admin ID, user cannot guess callback',async()=>{
 const h=botHarness();h.tickets.set(UUID,{owner,subject:'Issue',status:'open'});h.diagnostics.set(UUID,{screenshot_file_id:'file',screenshot_kind:'photo',report_context:{screen:'result'}});
 await h.handle(cb(other,'a:ticket:photo:'+UUID));assert(!h.out.some(x=>x.method==='sendPhoto'));
 await h.handle(cb(admin1,'a:ticket:photo:'+UUID));assert(h.out.some(x=>x.method==='sendPhoto'&&x.data.photo==='file'));
});
