// SK-111: single-use, user-bound Telegram support handoff and minimal diagnostics.
// No API credentials, session tokens, image bytes or raw request bodies are recorded.
import {createHash,randomBytes} from 'node:crypto';

const clean=(value,max=96)=>typeof value==='string'?value.replace(/[\x00-\x1f\x7f<>]/g,' ').trim().slice(0,max):'';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const requestId=/^[0-9a-f]{24}$/i;
export const reportToken=()=>randomBytes(18).toString('hex');
export const reportTokenHash=token=>createHash('sha256').update('skincar-report-v1:'+token).digest('hex');
export function reportContext(raw={}){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))raw={};
 const context={appVersion:clean(raw.appVersion,40),screen:clean(raw.screen,64),device:clean(raw.device,180),
  errorCode:clean(raw.errorCode,64),requestId:requestId.test(raw.requestId||'')?raw.requestId.toLowerCase():'',
  generationId:uuid.test(raw.generationId||'')?raw.generationId.toLowerCase():'',
  clientUTC:typeof raw.clientUTC==='string'&&!Number.isNaN(Date.parse(raw.clientUTC))?new Date(raw.clientUTC).toISOString():''};
 return context;
}
export async function startReport(db,ownerId,raw,botUsername='skincartuning_bot'){
 const context=reportContext(raw);
 // The generation ID is never trusted just because the browser supplied it.
 if(context.generationId){
  const r=await db.query("SELECT id,status,model,options->>'qualityMode' AS quality FROM generations WHERE id=$1 AND telegram_id=$2",[context.generationId,ownerId]);
  if(!r.rows.length)throw Object.assign(Error('GENERATION_NOT_FOUND'),{status:404,code:'GENERATION_NOT_FOUND'});
  context.generation={status:clean(r.rows[0].status,24),model:clean(r.rows[0].model,80),quality:clean(r.rows[0].quality,16)};
 }
 const token=reportToken();
 await db.query("INSERT INTO bot_report_links(token_hash,telegram_id,context) VALUES($1,$2,$3)",[reportTokenHash(token),ownerId,JSON.stringify(context)]);
 const name=/^[a-zA-Z0-9_]{5,32}$/.test(botUsername)?botUsername:'skincartuning_bot';
 return {url:`https://t.me/${name}?start=report_${token}`,expiresIn:600};
}
export async function consumeReport(db,ownerId,token){
 if(typeof token!=='string'||!/^[a-f0-9]{36}$/.test(token))return null;
 const r=await db.query(`UPDATE bot_report_links SET consumed_at=now()
  WHERE token_hash=$1 AND telegram_id=$2 AND consumed_at IS NULL AND expires_at>now()
  RETURNING context`,[reportTokenHash(token),ownerId]);
 return r.rows[0]?.context||null;
}
export function diagnosticsText(row){
 const c=row?.report_context&&typeof row.report_context==='object'?row.report_context:{};
 const entries=[['Экран',c.screen],['Версия',c.appVersion],['Устройство',c.device],['Ошибка',c.errorCode],['Request ID',c.requestId],
  ['Generation ID',c.generationId],['Статус генерации',c.generation?.status],['Модель',c.generation?.model],
  ['Время устройства (UTC)',c.clientUTC],['Сервер (UTC)',row?.created_at&&new Date(row.created_at).toISOString()]];
 return entries.filter(([,v])=>typeof v==='string'&&v).map(([k,v])=>`${k}: ${clean(v,180)}`).join('\n')||'Контекст приложения отсутствует: обращение из бота.';
}
export function screenshotInfo(message){
 const photos=Array.isArray(message?.photo)?message.photo:[];
 const last=photos.at(-1);
 if(last&&typeof last.file_id==='string'&&last.file_id.length<=256&&Number(last.file_size||0)<=10*1024*1024){return {fileId:last.file_id,kind:'photo'};}
 const d=message?.document;
 if(d&&['image/png','image/jpeg'].includes(d.mime_type)&&typeof d.file_id==='string'&&d.file_id.length<=256&&Number.isFinite(Number(d.file_size))&&Number(d.file_size)<=10*1024*1024){return {fileId:d.file_id,kind:'document'};}
 return null;
}
