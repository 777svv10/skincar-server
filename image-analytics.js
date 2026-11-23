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
export const ANALYTICS_PERIODS=Object.freeze({today:'1 day',week:'7 days',month:'30 days',quarter:'90 days',year:'365 days',all:null});
export const periodLabel=period=>({today:'24 часа',week:'7 дней',month:'30 дней',quarter:'90 дней',year:'365 дней',all:'всё время'})[period]||'—';
export function periodFilter(period,column='created_at'){
 if(!Object.hasOwn(ANALYTICS_PERIODS,period))throw Error('SK108_RANGE_INVALID');
 // SQL column names are internal literals only, never taken from Telegram or user input.
 if(column!=='created_at'&&column!=='g.created_at')throw Error('SK108_COLUMN_INVALID');
 const interval=ANALYTICS_PERIODS[period];
 return interval?{where:`WHERE ${column}>=now()-($1::interval)`,params:[interval]}:{where:'',params:[]};
}
export async function loadGenerationExport(db,period='month',config={}){
 const filter=periodFilter(period);
 const {rows}=await db.query(`SELECT id,created_at,started_at,finished_at,model,status,options->>'qualityMode' AS quality,
 charged_credits,refunded,usage FROM generations ${filter.where} ORDER BY created_at DESC LIMIT 10001`,filter.params);
 let rates={},pricingError=false;
 try{rates=parseImageRates(config.SKINCAR_IMAGE_RATES_JSON||'');}catch{pricingError=true;}
 return {period,rows:rows.slice(0,10000),truncated:rows.length>10000,rates,pricingError};
}
const escapeCsv=value=>{
 let s=String(value??'').replaceAll('\r',' ').replaceAll('\n',' ').replaceAll('\0','');
 // Prevent spreadsheet formula execution when an export is opened in Excel/Sheets.
 if(/^[\s]*[=+@-]/.test(s))s="'"+s;
 return `"${s.replaceAll('"','""')}"`;
};
export function reportToCsv(report){
 const headers=['UTC','Generation ID','Model','Status','Quality','Charged credits','Refunded','Input tokens','Text input','Image input','Output tokens','Total tokens','Estimated USD','Tariff version','Processing seconds'];
 const lines=[headers.map(escapeCsv).join(',')];
 for(const row of report.rows){
  const usage=normalizeImageUsage(row.usage);
  const model=String(row.model||'unknown');
  const price=row.status==='done'?estimateImageUSD(model,row.usage,report.rates):null;
  const start=row.started_at?new Date(row.started_at).getTime():NaN;
  const end=row.finished_at?new Date(row.finished_at).getTime():NaN;
  const seconds=Number.isFinite(start)&&Number.isFinite(end)&&end>=start?((end-start)/1000).toFixed(1):'';
  const data=[row.created_at?new Date(row.created_at).toISOString():'',row.id||'',model,row.status||'',
  asQuality(row.quality),row.charged_credits??'',row.refunded===true?'yes':'no',usage.input??'',usage.text??'',usage.image??'',usage.output??'',usage.total??'',price?price.usd.toFixed(8):'',price?.version||'',seconds];
  lines.push(data.map(escapeCsv).join(','));
 }
 return Buffer.from('\uFEFF'+lines.join('\r\n')+'\r\n','utf8');
}

export async function loadGenerationAnalytics(db,period='today',config={}){
 const filter=periodFilter(period);
 let rates={},pricingError=false;
 try{rates=parseImageRates(config.SKINCAR_IMAGE_RATES_JSON||'');}catch{pricingError=true;}
 // Bounded server-side reads: if truncated, do NOT present the values as complete totals.
 const {rows}=await db.query(`SELECT model,status,options->>'qualityMode' AS quality,
    charged_credits,refunded,usage,started_at,finished_at
    FROM generations ${filter.where}
    ORDER BY created_at DESC LIMIT 10001`,filter.params);
 return {period,pricingConfigured:Object.keys(rates).length>0,pricingError,summary:summarizeGenerations(rows.slice(0,10000),rates,rows.length>10000)};
}
const n=v=>Number(v||0).toLocaleString('ru-RU');
const usd=v=>'$'+Number(v||0).toFixed(4);
export function analyticsText(report,kind='cost'){
 const s=report.summary,range=periodLabel(report.period);
 const cap=s.truncated?'⚠️ Достигнут лимит 10 000 записей: ниже только выборка.\n':'';
 const head=`🔒 SkinCar · ${kind==='cost'?'Себестоимость':'Статистика'} · ${range}\n${cap}`;
 const status=`Запросов: ${n(s.total)} · готово: ${n(s.done)} · ошибки: ${n(s.failed)} · в работе: ${n(s.queued+s.processing)}\nСтандарт: ${n(s.standard)} · HD: ${n(s.hd)} · не указано: ${n(s.unknownQuality)}\nВозвраты: ${n(s.refunded)} · списано (нетто): ${n(s.netCredits)} генераций`;
 const tokens=`Токены (usage: ${n(s.withUsage)}/${n(s.total)}): ${n(s.totalTokens)}\nВход: ${n(s.inputTokens)} · текст: ${n(s.textTokens)} · изображение: ${n(s.imageTokens)} · выход: ${n(s.outputTokens)}`;
 const groups=Object.entries(s.models).sort((a,b)=>b[1].count-a[1].count).slice(0,8);
 if(kind!=='cost'){
  const models=groups.map(([name,g])=>`• ${name}: ${n(g.count)} запросов, ${n(g.totalTokens)} ток.`).join('\n');
  return head+status+'\n\n'+tokens+(models?'\n\nМодели:\n'+models:'')+
   (s.averageProcessingSeconds!==null?`\n\nСреднее время обработки: ${s.averageProcessingSeconds.toFixed(1)} с`:'');
 }
 const pricing=s.priced?usd(s.estimatedUSD):'—';
 const modelCosts=groups.map(([name,g])=>`• ${name}: ${n(g.priced)}/${n(g.count)} оценено, ${g.priced?usd(g.estimatedUSD):'—'}`).join('\n');
 const reason=report.pricingError?'⚠️ неверный формат SKINCAR_IMAGE_RATES_JSON.':
  !report.pricingConfigured?'⚠️ Тарифы не настроены: USD не рассчитывается.':
  s.unpriced?`⚠️ Стоимость рассчитана для ${n(s.priced)} из ${n(s.done)} успешных запросов; остальные ${n(s.unpriced)} не оценены.`:
  'Тарифы настроены для всех успешно оценённых запросов.';
 const disclaimer='Это расчётная стоимость API по текущим тарифам, не фактический счёт OpenAI. Исторические скидки и незавершённые вызовы могут отличаться.';
 return head+`\nUSD, оценка: ${pricing}\nСтандарт: ${s.qualities.standard.priced?usd(s.qualities.standard.estimatedUSD):'—'} · HD: ${s.qualities.hd.priced?usd(s.qualities.hd.estimatedUSD):'—'} · качество не указано: ${s.qualities.unknown.priced?usd(s.qualities.unknown.estimatedUSD):'—'}`+
  `\nОценено: ${n(s.priced)}/${n(s.done)} успешных вызовов\n\n`+tokens+
  (modelCosts?'\n\nПо моделям:\n'+modelCosts:'')+'\n\n'+reason+'\n'+disclaimer;
}
