// SK-108 — read-only generation analytics and explicitly configured USD estimates.
// Pricing is NEVER inferred from total tokens, image size or the number of credits.
const finiteInt=value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null;
const finiteRate=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=100000?value:null;
const safeText=value=>typeof value==='string'&&/^[a-zA-Z0-9._-]{1,80}$/.test(value)?value:null;

export function normalizeImageUsage(raw){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return {input:null,text:null,image:null,output:null,total:null};
 const input=finiteInt(raw.input_tokens),output=finiteInt(raw.output_tokens);
 const text=finiteInt(raw.input_tokens_details?.text_tokens);
 const image=finiteInt(raw.input_tokens_details?.image_tokens);
 const directTotal=finiteInt(raw.total_tokens);
 const total=directTotal??(input!==null&&output!==null?input+output:null);
 return {input,text,image,output,total};
}

// Example value: {"some-model":{"text":5,"image":8,"output":30,"version":"approved-2026-11"}}
// Prices are USD per 1 million input-text / input-image / output tokens.
export function parseImageRates(serialized=''){
 if(!serialized)return {};
 if(typeof serialized!=='string'||serialized.length>10000)throw Error('SK108_RATE_CONFIG_INVALID');
 let data;try{data=JSON.parse(serialized);}catch{throw Error('SK108_RATE_CONFIG_INVALID');}
 if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).length>20)throw Error('SK108_RATE_CONFIG_INVALID');
 const out={};
 for(const [model,val] of Object.entries(data)){
  if(!safeText(model)||!val||typeof val!=='object'||Array.isArray(val))throw Error('SK108_RATE_CONFIG_INVALID');
  const rates={text:finiteRate(val.text),image:finiteRate(val.image),output:finiteRate(val.output),version:safeText(val.version)};
  if(Object.values(rates).some(v=>v===null))throw Error('SK108_RATE_CONFIG_INVALID');
  out[model]=rates;
 }
 return out;
}
export function estimateImageUSD(model,usage,rates={}){
 const rate=rates?.[model];if(!rate)return null;
 const u=normalizeImageUsage(usage);
 // Do not price a partial response, or silently invent the text/image split.
 if([u.input,u.text,u.image,u.output].some(v=>v===null)||u.text+u.image!==u.input)return null;
 return {usd:(u.text*rate.text+u.image*rate.image+u.output*rate.output)/1e6,version:rate.version};
}
const asQuality=o=>o==='hd'?'hd':o==='standard'?'standard':'unknown';
const newGroup=()=>({count:0,priced:0,estimatedUSD:0,totalTokens:0,withUsage:0});
export function summarizeGenerations(rows=[],rates={},truncated=false){
 const summary={total:0,done:0,failed:0,queued:0,processing:0,refunded:0,
  hd:0,standard:0,unknownQuality:0,chargedCredits:0,netCredits:0,
  totalTokens:0,inputTokens:0,textTokens:0,imageTokens:0,outputTokens:0,withUsage:0,
  priced:0,unpriced:0,estimatedUSD:0,averageProcessingSeconds:null,truncated:!!truncated,
  models:{},qualities:{standard:newGroup(),hd:newGroup(),unknown:newGroup()}};
 let durationCount=0,durationSum=0;
 for(const row of rows){
  summary.total++;if(['done','failed','queued','processing'].includes(row.status))summary[row.status]++;
  if(row.refunded)summary.refunded++;
  const credits=Number(row.charged_credits);if(Number.isInteger(credits)&&credits>0){summary.chargedCredits+=credits;if(!row.refunded)summary.netCredits+=credits;}
  const q=asQuality(row.quality??row.options?.qualityMode);if(q==='unknown')summary.unknownQuality++;else summary[q]++;
  const g=summary.qualities[q],model=String(row.model||'unknown').slice(0,80);
  const modelGroup=summary.models[model]??(summary.models[model]=newGroup());
  g.count++;modelGroup.count++;
  const u=normalizeImageUsage(row.usage);
  if(u.total!==null){summary.withUsage++;summary.totalTokens+=u.total;g.withUsage++;g.totalTokens+=u.total;modelGroup.withUsage++;modelGroup.totalTokens+=u.total;}
  if(u.input!==null)summary.inputTokens+=u.input;
  if(u.text!==null)summary.textTokens+=u.text;
  if(u.image!==null)summary.imageTokens+=u.image;
  if(u.output!==null)summary.outputTokens+=u.output;
  if(row.status==='done'){
   const priced=estimateImageUSD(model,row.usage,rates);
   if(priced){summary.priced++;summary.estimatedUSD+=priced.usd;g.priced++;g.estimatedUSD+=priced.usd;modelGroup.priced++;modelGroup.estimatedUSD+=priced.usd;}
   else summary.unpriced++;
   if(row.started_at&&row.finished_at){const ms=new Date(row.finished_at).getTime()-new Date(row.started_at).getTime();if(Number.isFinite(ms)&&ms>=0){durationSum+=ms;durationCount++;}}
  }
 }
 if(durationCount)summary.averageProcessingSeconds=durationSum/(durationCount*1000);
 return summary;
}
export const ANALYTICS_PERIODS=Object.freeze({today:'1 day',week:'7 days',month:'30 days'});
export async function loadGenerationAnalytics(db,period='today',config={}){
 const interval=ANALYTICS_PERIODS[period];if(!interval)throw Error('SK108_RANGE_INVALID');
 let rates={},pricingError=false;
 try{rates=parseImageRates(config.SKINCAR_IMAGE_RATES_JSON||'');}catch{pricingError=true;}
 // Bounded server-side reads: if truncated, do NOT present the values as complete totals.
 const {rows}=await db.query(`SELECT model,status,options->>'qualityMode' AS quality,
    charged_credits,refunded,usage,started_at,finished_at
    FROM generations WHERE created_at>=now()-($1::interval)
    ORDER BY created_at DESC LIMIT 10001`,[interval]);
 return {period,pricingConfigured:Object.keys(rates).length>0,pricingError,summary:summarizeGenerations(rows.slice(0,10000),rates,rows.length>10000)};
}
const n=v=>Number(v||0).toLocaleString('ru-RU');
const usd=v=>'$'+Number(v||0).toFixed(4);
export function analyticsText(report,kind='cost'){
 const s=report.summary;
 const range=report.period==='today'?'24 часа':report.period==='week'?'7 дней':'30 дней';
 const cap=s.truncated?'⚠️ Достигнут лимит 10 000 записей: ниже только выборка.\n':'';
 const rateNote=report.pricingError?'⚠️ SKINCAR_IMAGE_RATES_JSON имеет неверный формат: USD не рассчитывается.':
  !report.pricingConfigured?'Тарифы не настроены: USD не рассчитывается.':
    s.unpriced?`⚠️ Оценка охватывает ${n(s.priced)} из ${n(s.done)} успешных запросов; остальные ${n(s.unpriced)} без подходящего тарифа или разбивки токенов.`:
    'Оценка по настроенным тарифам; не является фактическим счётом OpenAI.';
 const head=`🔒 SkinCar · ${kind==='cost'?'Себестоимость':'Статистика'} · ${range}\n${cap}`;
 const counts=`Запросов: ${n(s.total)} · готово: ${n(s.done)} · ошибки: ${n(s.failed)} · выполняются: ${n(s.queued+s.processing)}\nСтандарт: ${n(s.standard)} · HD: ${n(s.hd)} · неизвестно: ${n(s.unknownQuality)}\nВозвраты: ${n(s.refunded)} · генераций списано (нетто): ${n(s.netCredits)}`;
 const toks=`Токены (есть usage: ${n(s.withUsage)}/${n(s.total)}): ${n(s.totalTokens)}\nВход: ${n(s.inputTokens)} · текст: ${n(s.textTokens)} · изображения: ${n(s.imageTokens)} · выход: ${n(s.outputTokens)}`;
 const costs=`USD, расчётная оценка: ${s.priced?usd(s.estimatedUSD):'—'}\nСтандарт: ${s.qualities.standard.priced?usd(s.qualities.standard.estimatedUSD):'—'} · HD: ${s.qualities.hd.priced?usd(s.qualities.hd.estimatedUSD):'—'}\n${rateNote}`;
 const top=Object.entries(s.models).sort((a,b)=>b[1].count-a[1].count).slice(0,4).map(([name,g])=>`• ${name}: ${n(g.count)} запросов, ${n(g.totalTokens)} ток.`).join('\n');
 return head+counts+'\n\n'+toks+'\n\n'+costs+(top?'\n\nМодели:\n'+top:'')+(s.averageProcessingSeconds!==null?`\n\nСреднее время обработки: ${s.averageProcessingSeconds.toFixed(1)} с`:'');
}
