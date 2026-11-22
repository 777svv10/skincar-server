import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeImageUsage,parseImageRates,estimateImageUSD,summarizeGenerations,loadGenerationAnalytics,analyticsText} from './image-analytics.js';
import {createBotService} from './bot-service.js';
const usage={input_tokens:4000,input_tokens_details:{text_tokens:3000,image_tokens:1000},output_tokens:900,total_tokens:4900};
const pricing='{"test-model":{"text":5,"image":8,"output":30,"version":"verified-2026-11"}}';
const rates=parseImageRates(pricing);
const job=(quality='hd',s='done',u=usage,model='test-model')=>({model,status:s,quality,charged_credits:quality==='hd'?3:1,refunded:s==='failed',usage:u,started_at:'2026-11-22T10:00:00Z',finished_at:'2026-11-22T10:00:32Z'});
test('SK108 token classification and provider total',()=>{
 assert.deepEqual(normalizeImageUsage(usage),{input:4000,text:3000,image:1000,output:900,total:4900});
 assert.equal(normalizeImageUsage({input_tokens:4,output_tokens:7}).total,11);
 assert.equal(normalizeImageUsage({}).total,null);
 assert.equal(normalizeImageUsage({total_tokens:-1}).total,null);
});
test('SK108 prices only full usage with explicitly configured per-model USD rates',()=>{
 assert.equal(estimateImageUSD('test-model',usage,rates).usd,(3000*5+1000*8+900*30)/1e6);
 assert.equal(estimateImageUSD('different-model',usage,rates),null);
 assert.equal(estimateImageUSD('test-model',{input_tokens:4,output_tokens:5,total_tokens:9},rates),null);
 assert.equal(estimateImageUSD('test-model',{...usage,input_tokens_details:{text_tokens:3000,image_tokens:999}},rates),null);
 assert.equal(estimateImageUSD('test-model',usage,{}),null);
});
test('SK108 pricing configuration rejects malformed values or silent negative price',()=>{
 for(const value of ['{','[]','{"x":{"text":-1,"image":2,"output":3,"version":"v"}}','{"x":{"text":1,"image":2,"output":3}}','{"bad model":{"text":1,"image":2,"output":3,"version":"v"}}']){
  assert.throws(()=>parseImageRates(value),/SK108_RATE_CONFIG_INVALID/);
 }
 assert.deepEqual(parseImageRates(''),{});
});
test('SK108 separates Standard, HD, refunds, unknown usage and estimated coverage',()=>{
 const rows=[job('hd'),job('standard'),job('standard','failed',null),job(null,'done',null,'another-model')];
 const s=summarizeGenerations(rows,rates);
 assert.equal(s.total,4);assert.equal(s.done,3);assert.equal(s.failed,1);assert.equal(s.refunded,1);
 assert.equal(s.hd,1);assert.equal(s.standard,2);assert.equal(s.unknownQuality,1);
 assert.equal(s.netCredits,3+1+1);assert.equal(s.priced,2);assert.equal(s.unpriced,1);
 assert.equal(s.withUsage,2);assert.equal(s.totalTokens,9800);assert.equal(s.averageProcessingSeconds,32);
 assert.equal(s.estimatedUSD,2*(3000*5+1000*8+900*30)/1e6);
});
test('SK108 reports truncation instead of claiming a complete total, and unknown USD',async()=>{
 const rows=[job('standard'),job('standard','done',null)];const db={query:async(sql,params)=>{assert.match(sql,/LIMIT 10001/);assert.deepEqual(params,['7 days']);return {rows};}};
 const report=await loadGenerationAnalytics(db,'week',{SKINCAR_IMAGE_RATES_JSON:''});
 assert.equal(report.pricingConfigured,false);assert.equal(report.summary.estimatedUSD,0);
 const txt=analyticsText(report);assert.match(txt,/Тарифы не настроены/);assert.match(txt,/не рассчитывается/);
 assert.equal(summarizeGenerations(rows,rates,true).truncated,true);
 await assert.rejects(loadGenerationAnalytics(db,'unknown',{}),/SK108_RANGE_INVALID/);
});
test('SK108 bot /cost exposed only to explicit admin, no user records disclosed',async()=>{
 const make=admin=>{
  const out=[],queries=[],uid=123456;
  const db={query:async(sql,params=[])=>{queries.push(sql);if(sql.includes('bot_rate_limits'))return {rows:[{hits:1}]};if(sql.includes('FROM generations WHERE created_at'))return {rows:[job('hd')]};return {rows:[]};}};
  const handle=createBotService({db,config:{BOT_ADMIN_IDS:admin?String(uid):''},send:async(method,data)=>{out.push({method,data})},upload:async()=>{throw Error('MEDIA_NOT_EXPECTED')}});
  return {uid,handle,out,queries};
 };
 const update=(uid,text)=>({message:{from:{id:uid,first_name:'Tester',language_code:'ru'},chat:{id:uid,type:'private'},text}});
 const ordinary=make(false);await ordinary.handle(update(ordinary.uid,'/cost'));
 assert.equal(ordinary.queries.some(sql=>sql.includes('FROM generations WHERE created_at')),false);
 const admin=make(true);await admin.handle(update(admin.uid,'/cost'));
 assert(admin.queries.some(sql=>sql.includes('FROM generations WHERE created_at')));
 assert.match(admin.out.at(-1).data.text,/Себестоимость/);
 assert.match(admin.out.at(-1).data.text,/Тарифы не настроены/);
 await admin.handle(update(admin.uid,'/cost_week'));
 assert.match(admin.out.at(-1).data.text,/7 дней/);
});
test('SK108 invalid pricing variable gives nonfatal admin warning, never invents USD',async()=>{
 const fake={query:async()=>({rows:[job('hd')]})};
 const report=await loadGenerationAnalytics(fake,'today',{SKINCAR_IMAGE_RATES_JSON:'malformed'});
 assert.equal(report.pricingError,true);assert.equal(report.summary.priced,0);
 assert.match(analyticsText(report),/неверный формат/);
});
test('SK108 correctly flags partial sample when database exceeds limit',async()=>{
 const fake={query:async()=>({rows:Array.from({length:10001},()=>job('standard'))})};
 const report=await loadGenerationAnalytics(fake,'today',{});
 assert.equal(report.summary.total,10000);assert.equal(report.summary.truncated,true);
 assert.match(analyticsText(report),/только выборка/);
});
