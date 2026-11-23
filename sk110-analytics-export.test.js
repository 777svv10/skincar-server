import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ANALYTICS_PERIODS,periodFilter,periodLabel,loadGenerationExport,reportToCsv,analyticsText,summarizeGenerations,loadGenerationAnalytics} from './image-analytics.js';
import {createBotService} from './bot-service.js';
const id='11111111-1111-4111-8111-111111111111';
const row={id,created_at:'2026-11-20T18:00:00Z',started_at:'2026-11-20T18:00:02Z',finished_at:'2026-11-20T18:00:22Z',model:'gpt-image-2.6-sunburst',status:'done',quality:'hd',charged_credits:3,refunded:false,usage:{input_tokens:4000,output_tokens:1000,input_tokens_details:{text_tokens:1000,image_tokens:3000},total_tokens:5000}};
const config={SKINCAR_IMAGE_RATES_JSON:JSON.stringify({'gpt-image-2.6-sunburst':{text:5,image:8,output:30,version:'official-2026-11-23'}})};
test('SK110.1 periods include 90d, 365d and unbounded all history; no arbitrary SQL',()=>{
 assert.deepEqual(Object.keys(ANALYTICS_PERIODS),['today','week','month','quarter','year','all']);
 assert.equal(periodFilter('quarter').params[0],'90 days');
 assert.equal(periodFilter('year').params[0],'365 days');
 assert.deepEqual(periodFilter('all'),{where:'',params:[]});
 assert.equal(periodLabel('all'),'всё время');
 assert.throws(()=>periodFilter('all;DROP TABLE generations'),/SK108_RANGE_INVALID/);
});
test('SK110.1 stats and cost report are DISTINCT',()=>{
 const a={period:'month',pricingConfigured:true,pricingError:false,summary:summarizeGenerations([row],JSON.parse(config.SKINCAR_IMAGE_RATES_JSON))};
 assert.match(analyticsText(a,'stats'),/Запросов:/);
 assert.doesNotMatch(analyticsText(a,'stats'),/USD, оценка:/);
 assert.match(analyticsText(a,'cost'),/USD, оценка:/);
 assert.doesNotMatch(analyticsText(a,'cost'),/Запросов:/);
});
test('SK110.1 CSV export uses no images, keeps costs as estimates, protects spreadsheet formula injection',async()=>{
 const captured=[];const db={query:async(sql,params)=>{captured.push({sql,params});return {rows:[row,{...row,id:'=IMPORTRANGE(42)',model:'=HYPERLINK("bad")',usage:null}]}}};
 const report=await loadGenerationExport(db,'all',config);assert.equal(captured[0].params.length,0);
 assert.match(captured[0].sql,/LIMIT 10001/);
 const csv=reportToCsv(report).toString('utf8');assert(csv.startsWith('\uFEFF'));
 assert.match(csv,/0\.05900000/); // (1000*5 + 3000*8 + 1000*30)/1e6
 assert(csv.includes("'=IMPORTRANGE(42)"));assert(csv.includes("'=HYPERLINK"));
 assert(!csv.includes('source_image'));assert(!csv.includes('telegram_id'));
});
test('SK110.1 exported 10k cap fails closed rather than silently hiding rows',async()=>{
 const db={query:async()=>({rows:new Array(10001).fill(row)})};
 const report=await loadGenerationExport(db,'year',config);assert.equal(report.truncated,true);
 assert.equal(report.rows.length,10000);
});
test('SK110.1 report SQL uses whitelisted window parameters',async()=>{
 let query;const db={query:async(sql,p)=>{query={sql,p};return {rows:[row]}}};
 const r=await loadGenerationAnalytics(db,'year',config);
 assert.equal(query.p[0],'365 days');assert.equal(r.summary.total,1);
});
test('SK110.1 bot exports CSV only for admin; non-admin may not query or upload',async()=>{
 const fake=admin=>{
 const queries=[],out=[],media=[];
 const db={query:async(sql,p=[])=>{queries.push(sql);if(sql.includes('bot_rate_limits'))return {rows:[{hits:1}]};if(sql.includes('FROM generations'))return {rows:[row]};if(sql.includes('count(*) AS n FROM users'))return {rows:[{n:2}]};if(sql.includes('FROM payment_receipts'))return {rows:[{stars:1}]};return {rows:[]};}};
 const handle=createBotService({db,config:{BOT_ADMIN_IDS:admin?'123456':'',...config},send:async(m,d)=>out.push({m,d}),upload:async(m,d)=>media.push({m,d})});
 return {queries,out,media,handle};
 };
 const msg=text=>({message:{from:{id:123456,language_code:'ru'},chat:{id:123456,type:'private'},text}});
 const cb=data=>({callback_query:{from:{id:123456,language_code:'ru'},message:{chat:{id:123456,type:'private'}},id:'callback1',data}});
 const visitor=fake(false);await visitor.handle(msg('/export_all'));await visitor.handle(cb('a:export_all'));
 assert.equal(visitor.media.length,0);assert(!visitor.queries.some(x=>x.includes('FROM generations')));
 const admin=fake(true);await admin.handle(msg('/export_all'));
 assert.equal(admin.media.length,1);assert.equal(admin.media[0].m,'sendDocument');
 assert.equal(admin.media[0].d.mime,'text/csv; charset=utf-8');
 assert(admin.media[0].d.bytes.length>50);
 await admin.handle(cb('a:stats_year'));
 assert.match(admin.out.at(-1).d.text,/365 дней/);
 await admin.handle(cb('a:cost_month'));
 assert.match(admin.out.at(-1).d.text,/USD, оценка/);
});
