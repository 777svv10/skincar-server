import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ANALYTICS_PERIODS,periodFilter,periodLabel,loadGenerationExport,reportToCsv,analyticsText,summarizeGenerations,loadGenerationAnalytics} from './image-analytics.js';
import {createBotService} from './bot-service.js';
const id='11111111-1111-4111-8111-111111111111';
const row={id,created_at:'2026-11-20T18:00:00Z',started_at:'2026-11-20T18:00:02Z',finished_at:'2026-11-20T18:00:22Z',model:'gpt-image-2.6-sunburst',status:'done',quality:'hd',charged_credits:3,refunded:false,usage:{input_tokens:4000,output_tokens:1000,input_tokens_details:{text_tokens:1000,image_tokens:3000},total_tokens:5000}};
const config={SKINCAR_IMAGE_RATES_JSON:JSON.stringify({'gpt-image-2.6-sunburst':{text:5,image:8,output:30,version:'official-2026-11-23'}})};
test('SK110.1 periods: 90d, 365d, all-time and reject invalid SQL period',()=>{
 assert.deepEqual(Object.keys(ANALYTICS_PERIODS),['today','week','month','quarter','year','all']);
 assert.equal(periodFilter('quarter').params[0],'90 days');
 assert.equal(periodFilter('year').params[0],'365 days');
 assert.deepEqual(periodFilter('all'),{where:'',params:[]});
 assert.equal(periodLabel('all'),'всё время');
 assert.throws(()=>periodFilter('year;DELETE FROM generations'),/SK108_RANGE_INVALID/);
});
test('SK110.1 admin statistical counts and cost text are distinct',()=>{
 const r={period:'month',pricingConfigured:true,pricingError:false,summary:summarizeGenerations([row],JSON.parse(config.SKINCAR_IMAGE_RATES_JSON))};
 assert.match(analyticsText(r,'stats'),/Запросов:/);
 assert.doesNotMatch(analyticsText(r,'stats'),/USD, оценка:/);
 assert.match(analyticsText(r,'cost'),/USD, оценка:/);
 assert.doesNotMatch(analyticsText(r,'cost'),/Запросов:/);
});
test('SK110.1 CSV is byte-compatible, no PII and no spreadsheet formula injection',async()=>{
 const db={query:async(sql,params)=>{assert.match(sql,/LIMIT 10001/);assert.deepEqual(params,[]);return {rows:[row,{...row,id:'=SUM(2,2)',model:'=HYPERLINK("bad")',usage:null}]}}};
 const r=await loadGenerationExport(db,'all',config);
 const csv=reportToCsv(r).toString('utf8');
 assert(csv.startsWith('\uFEFF'));
 assert.match(csv,/0\.05900000/);
 assert(csv.includes("'=SUM(2,2)"));
 assert(csv.includes("'=HYPERLINK"));
 assert(!csv.includes('telegram_id'));
 assert(!csv.includes('result_image'));
});
test('SK110.1 CSV over limit fails closed',async()=>{
 const db={query:async()=>({rows:Array(10001).fill(row)})};
 const r=await loadGenerationExport(db,'all',config);
 assert.equal(r.truncated,true);
 assert.equal(r.rows.length,10000);
});
test('SK110.1 report SQL binds whitelisted year interval',async()=>{
 let args;
 const db={query:async(sql,p)=>{args=p;return {rows:[row]}}};
 const r=await loadGenerationAnalytics(db,'year',config);
 assert.deepEqual(args,['365 days']);
 assert.equal(r.summary.total,1);
});
test('SK110.1 CSV export in bot requires admin allowlist',async()=>{
 const fake=admin=>{
  const queries=[],out=[],media=[];
  const db={query:async(sql,p=[])=>{queries.push(sql);
    if(sql.includes('bot_rate_limits'))return {rows:[{hits:1}]};
    if(sql.includes('FROM generations'))return {rows:[row]};
    if(sql.includes('count(*) AS n FROM users'))return {rows:[{n:2}]};
    if(sql.includes('FROM payment_receipts'))return {rows:[{stars:1}]};
    return {rows:[]};
  }};
  const handle=createBotService({db,config:{BOT_ADMIN_IDS:admin?'123456':'',...config},send:async(m,d)=>out.push({m,d}),upload:async(m,d)=>media.push({m,d})});
  return {handle,queries,out,media};
 };
 const update=text=>({message:{from:{id:123456,language_code:'ru'},chat:{id:123456,type:'private'},text}});
 const callback=data=>({callback_query:{from:{id:123456,language_code:'ru'},message:{chat:{id:123456,type:'private'}},id:'cb-1',data}});
 const visitor=fake(false);await visitor.handle(update('/export_all'));await visitor.handle(callback('a:export_all'));
 assert.equal(visitor.media.length,0);assert(!visitor.queries.some(x=>x.includes('FROM generations')));
 const admin=fake(true);await admin.handle(update('/export_all'));
 assert.equal(admin.media.length,1);assert.equal(admin.media[0].m,'sendDocument');
 assert.equal(admin.media[0].d.mime,'text/csv; charset=utf-8');
 await admin.handle(callback('a:stats_year'));
 assert.match(admin.out.at(-1).d.text,/365 дней/);
 await admin.handle(callback('a:cost_month'));
 assert.match(admin.out.at(-1).d.text,/USD, оценка/);
});
