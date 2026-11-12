import {requireConsent,recordConsent,verifyConsent,imageHashes,CONSENT_VERSION} from './consent.js';
import {catalog,createInvoice,checkCheckout,settlePayment,applyRefund} from './payments.js';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import sharp from 'sharp';
import {enqueue,imageOf,optionsOf,viewJob,uuid,grantPilot} from './generations.js';
import {validateInitData} from './auth.js';
import {normalizeNickname,claimNickname,nicknameQuota} from './nickname.js';
import {listDrafts,saveDraft,deleteDraft} from './drafts.js';
export function createHandler(db,config=process.env){
const {BOT_TOKEN,WEBHOOK_SECRET}=config;
const APP_URL=config.APP_URL||'https://skincar01.netlify.app/';
const ORIGIN=new URL(APP_URL).origin;
const digest=s=>createHash('sha256').update(s).digest('hex');
const reply=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data))};
async function body(req,limit=32768){let size=0,parts=[];for await(const chunk of req){size+=chunk.length;if(size>limit)throw Object.assign(Error('Body too large'),{status:413,code:'BODY_TOO_LARGE'});parts.push(chunk)}try{const value=JSON.parse(Buffer.concat(parts).toString()||'{}');if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value;}catch{throw Object.assign(Error('Invalid JSON'),{status:400,code:'INVALID_JSON'})}}
async function telegram(method,data){const r=await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(10000)});const json=await r.json();if(!json.ok)throw Error('Telegram request failed');return json.result}
const view=u=>({id:u.telegram_id,displayName:u.display_name,lang:u.lang,theme:u.theme,balance:u.balance,nickname:u.nickname,nicknameRequired:!u.nickname,suggestedNickname:normalizeNickname(u.telegram_username)});
return async(req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  if(req.headers.origin&&req.headers.origin!==ORIGIN)return reply(res,403,{error:'Origin denied'});
  if(req.headers.origin===ORIGIN){res.setHeader('Access-Control-Allow-Origin',ORIGIN);res.setHeader('Vary','Origin')}
  res.setHeader('X-Content-Type-Options','nosniff');
  if(req.method==='OPTIONS'){res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,PATCH,DELETE,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization');res.writeHead(204);return res.end()}
  try{
    if(path==='/health'&&req.method==='GET'){await db.query('SELECT 1');return reply(res,200,{ok:true})}
    if(path==='/telegram/webhook'&&req.method==='POST'){
      const supplied=Buffer.from(String(req.headers['x-telegram-bot-api-secret-token']||'')), wanted=Buffer.from(WEBHOOK_SECRET);
      if(supplied.length!==wanted.length||!timingSafeEqual(supplied,wanted))return reply(res,403,{error:'Forbidden'});
      const update=await body(req),m=update.message;
      if(update.pre_checkout_query){const q=update.pre_checkout_query;const ok=await checkCheckout(db,q,config);await telegram('answerPreCheckoutQuery',{pre_checkout_query_id:q.id,ok,...(!ok?{error_message:'Счёт недоступен. Открой SkinCar и создай новый.'}:{})});}
      if(m?.successful_payment)await settlePayment(db,m.from.id,m.successful_payment);
      if(m?.refunded_payment){const recipient=m.chat?.type==='private'?m.chat.id:m.from?.id;await settlePayment(db,recipient,m.refunded_payment);await applyRefund(db,recipient,m.refunded_payment);}
      if(m?.chat?.type==='private'&&/^\/(paysupport|support)(?:@skincartuning_bot)?(?:\s|$)/i.test(m.text||''))await telegram('sendMessage',{chat_id:m.chat.id,text:'Поддержка платежей SkinCar: @vladisimonn. Отправь номер заказа из истории покупок и опиши проблему. Не отправляй пароли или данные карты.'});

      if(m?.chat?.type==='private'&&/^\/start(?:@skincartuning_bot)?(?:\s|$)/i.test(m.text||''))await telegram('sendMessage',{chat_id:m.chat.id,text:'Добро пожаловать в SkinCar — твоё тюнинг-ателье. Открой приложение, чтобы собрать образ автомобиля.',reply_markup:{inline_keyboard:[[{text:'Открыть SkinCar',web_app:{url:APP_URL}}]]}});
      return reply(res,200,{ok:true});
    }
    if(path==='/api/auth/telegram'&&req.method==='POST'){
      const b=await body(req);let user;
      try{user=validateInitData(b.initData,BOT_TOKEN)}catch{return reply(res,401,{error:'Открой приложение заново через Telegram'})}
      const lang=['ru','kk','en'].includes(user.language_code)?user.language_code:'ru';
      const {rows}=await db.query(`INSERT INTO users(telegram_id,display_name,lang,telegram_username) VALUES($1,$2,$3,$4) ON CONFLICT(telegram_id) DO UPDATE SET telegram_username=EXCLUDED.telegram_username,updated_at=now() RETURNING *`,[user.id,String(user.first_name||'SkinCar User').slice(0,80),lang,typeof user.username==='string'?user.username.slice(0,64):null]);
      const session=randomBytes(32).toString('hex');
      await db.query(`INSERT INTO sessions(token_hash,telegram_id) VALUES($1,$2)`,[digest(session),user.id]);
      await grantPilot(db,user.id);
      const fresh=(await db.query('SELECT * FROM users WHERE telegram_id=$1',[user.id])).rows[0];
      return reply(res,200,{session,user:view(fresh),expiresIn:86400});
    }
    const bearer=/^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization||'');
    if(!bearer)return reply(res,401,{error:'Login required'});
    const {rows}=await db.query(`SELECT u.* FROM sessions s JOIN users u USING(telegram_id) WHERE s.token_hash=$1 AND s.expires_at>now()`,[digest(bearer[1])]);
    const user=rows[0];if(!user)return reply(res,401,{error:'Session expired'});
    if(path==='/api/payments/catalog'&&req.method==='GET')return reply(res,200,catalog(user.telegram_id,config));
    if(path==='/api/payments/invoice'&&req.method==='POST'){const b=await body(req);return reply(res,200,await createInvoice(db,user.telegram_id,b.packId,telegram,config));}
    if(path==='/api/payments/history'&&req.method==='GET'){const r=await db.query('SELECT r.order_id,r.stars,r.credits,r.created_at,r.refunded_at FROM payment_receipts r WHERE telegram_id=$1 ORDER BY created_at DESC LIMIT 50',[user.telegram_id]);return reply(res,200,{purchases:r.rows,balance:user.balance});}
    if(path==='/api/vehicles'&&req.method==='GET'){return reply(res,200,{vehicles:(await db.query('SELECT id,name,created_at FROM vehicles WHERE telegram_id=$1 ORDER BY created_at DESC LIMIT 20',[user.telegram_id])).rows});}
    if(path==='/api/vehicles'&&req.method==='POST'){
      const b=await body(req,15*1024*1024+8192);const name=typeof b.name==='string'?b.name.trim().replace(/\s+/g,' '):'';
      if(!uuid(b.id)||name.length<2||name.length>80||/[\x00-\x1f<>]/.test(name))return reply(res,400,{code:'INVALID_VEHICLE'});
      requireConsent(b.consent);const source=await imageOf(b.image);
      const c=await db.connect();try{await c.query('BEGIN');await c.query('SELECT telegram_id FROM users WHERE telegram_id=$1 FOR UPDATE',[user.telegram_id]);
       const existing=(await c.query('SELECT id,name,source_image FROM vehicles WHERE id=$1 AND telegram_id=$2',[b.id,user.telegram_id])).rows[0];
       if(existing){const h=imageHashes(b.image,source);if(!h.includes(digest(existing.source_image)))throw Object.assign(Error(),{status:409,code:'PHOTO_MISMATCH'});const consent=await recordConsent(c,user.telegram_id,b.id,b.image,source,b.consent);await c.query('COMMIT');return reply(res,200,{vehicle:{id:existing.id,name:existing.name},consent});}
       const count=(await c.query('SELECT count(*) AS n FROM vehicles WHERE telegram_id=$1',[user.telegram_id])).rows[0];if(Number(count.n)>=20)throw Object.assign(Error(),{status:429,code:'VEHICLE_LIMIT'});
       const vehicle=(await c.query('INSERT INTO vehicles(id,telegram_id,name,source_image,original_image,original_mime) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name',[b.id,user.telegram_id,name,source,Buffer.from(b.image.split(',')[1],'base64'),b.image.slice(5,b.image.indexOf(';'))])).rows[0];const consent=await recordConsent(c,user.telegram_id,b.id,b.image,source,b.consent);await c.query('COMMIT');return reply(res,201,{vehicle,consent});
      }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
    }
    // SK-047..049: reusing an owner's original photo requires the existing consent,
    // not an anonymous vehicle ID or a newly fabricated agreement.
    const vehicleReusePath=/^\/api\/vehicles\/([a-f0-9-]+)\/reuse$/.exec(path);
    if(vehicleReusePath&&req.method==='GET'){
      if(!uuid(vehicleReusePath[1]))return reply(res,404,{code:'VEHICLE_NOT_FOUND'});
      const vehicle=(await db.query('SELECT id,name,source_image FROM vehicles WHERE id=$1 AND telegram_id=$2',[vehicleReusePath[1],user.telegram_id])).rows[0];
      if(!vehicle)return reply(res,404,{code:'VEHICLE_NOT_FOUND'});
      const consent=(await db.query(`SELECT id FROM photo_consents
        WHERE vehicle_id=$1 AND telegram_id=$2 AND accepted=true
          AND text_version=$4 AND source_hash=$3
        ORDER BY accepted_at DESC LIMIT 1`,[vehicle.id,user.telegram_id,digest(vehicle.source_image),CONSENT_VERSION])).rows[0];
      if(!consent)return reply(res,409,{code:'PHOTO_CONSENT_REQUIRED'});
      return reply(res,200,{vehicle:{id:vehicle.id,name:vehicle.name},consentId:consent.id});
    }
    // Small private thumbnails for drafts: avoid downloading every full-size original in Garage.
    const vehicleThumbPath=/^\/api\/vehicles\/([a-f0-9-]+)\/thumbnail$/.exec(path);
    if(vehicleThumbPath&&req.method==='GET'){
      if(!uuid(vehicleThumbPath[1]))return reply(res,404,{code:'VEHICLE_NOT_FOUND'});
      const item=(await db.query('SELECT source_image FROM vehicles WHERE id=$1 AND telegram_id=$2',[vehicleThumbPath[1],user.telegram_id])).rows[0];
      if(!item)return reply(res,404,{code:'VEHICLE_NOT_FOUND'});
      const thumbnail=await sharp(item.source_image).resize(480,320,{fit:'inside',withoutEnlargement:true}).jpeg({quality:75}).toBuffer();
      res.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'private, no-store','Content-Length':thumbnail.length});return res.end(thumbnail);
    }
    const vehiclePath=/^\/api\/vehicles\/([a-f0-9-]+)\/source$/.exec(path);
    if(vehiclePath&&req.method==='GET'){if(!uuid(vehiclePath[1]))return reply(res,404,{});const v=(await db.query("SELECT COALESCE(original_image,source_image) AS source_image,COALESCE(original_mime,'image/jpeg') AS mime FROM vehicles WHERE id=$1 AND telegram_id=$2",[vehiclePath[1],user.telegram_id])).rows[0];if(!v)return reply(res,404,{});res.writeHead(200,{'Content-Type':v.mime,'Cache-Control':'private, no-store'});return res.end(v.source_image);}
    // Editor drafts: authorized per account; the server is the source of truth for 7-day retention.
    if(path==='/api/drafts'&&req.method==='GET')return reply(res,200,{drafts:await listDrafts(db,user.telegram_id)});
    const draftPath=/^\/api\/drafts\/([a-f0-9-]+)$/.exec(path);
    if(draftPath){
      if(req.method==='PUT'){const b=await body(req,8192);return reply(res,200,{draft:await saveDraft(db,user.telegram_id,draftPath[1],b.vehicleId,b.options)});}
      if(req.method==='DELETE')return reply(res,200,{deleted:await deleteDraft(db,user.telegram_id,draftPath[1])});
    }
    if(path==='/api/generations'&&req.method==='POST'){
      if(!process.env.OPENAI_API_KEY)return reply(res,503,{code:'GENERATION_DISABLED'});
      const b=await body(req,15*1024*1024+8192);
      if(!uuid(b.consentId)||!uuid(b.options?.vehicleId))return reply(res,400,{code:'PHOTO_CONSENT_REQUIRED'});const options=optionsOf(b.options),source=await imageOf(b.image);await verifyConsent(db,user.telegram_id,b.consentId,options.vehicleId,b.image,source);options.photoConsentId=b.consentId;
      if(options.vehicleId){const v=(await db.query('SELECT name FROM vehicles WHERE id=$1 AND telegram_id=$2',[options.vehicleId,user.telegram_id])).rows[0];if(!v)return reply(res,404,{code:'VEHICLE_NOT_FOUND'});options.vehicleName=v.name;}
      return reply(res,202,await enqueue(db,user.telegram_id,b.requestKey,source,options));
    }
    if(path==='/api/generations'&&req.method==='GET'){
      const jobs=await db.query('SELECT id,request_key,status,options,error_code,refunded,created_at,archived FROM generations WHERE telegram_id=$1 AND NOT archived ORDER BY created_at DESC LIMIT 20',[user.telegram_id]);
      return reply(res,200,{jobs:jobs.rows.map(viewJob),balance:user.balance});
    }
    const jobPath=/^\/api\/generations\/([^/]+)(?:\/(source|result|thumbnail))?$/.exec(path);
    if(jobPath){
      if(!uuid(jobPath[1]))return reply(res,404,{error:'Not found'});
      const job=(await db.query('SELECT id,request_key,status,options,error_code,refunded,created_at,archived FROM generations WHERE id=$1 AND telegram_id=$2 AND NOT archived',[jobPath[1],user.telegram_id])).rows[0];
      if(!job)return reply(res,404,{error:'Not found'});
      if(req.method==='DELETE'&&!jobPath[2]){
        const deleted=await db.query("UPDATE generations SET archived=true,source_image=NULL,result_image=NULL,thumbnail=NULL WHERE id=$1 AND telegram_id=$2 AND status IN ('done','failed') RETURNING id",[job.id,user.telegram_id]);
        return reply(res,deleted.rowCount?200:409,{ok:!!deleted.rowCount});
      }
      if(req.method==='GET'){
        if(!jobPath[2])return reply(res,200,{job:viewJob(job),balance:user.balance});
        const column={source:'source_image',result:'result_image',thumbnail:'thumbnail'}[jobPath[2]];
        const media=(await db.query(`SELECT ${column} AS image FROM generations WHERE id=$1 AND telegram_id=$2 AND NOT archived`,[job.id,user.telegram_id])).rows[0]?.image;
        if(!media)return reply(res,404,{error:'Image unavailable'});
        res.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'private, no-store','Content-Length':media.length});return res.end(media);
      }
    }
    if(path==='/api/me/nickname'&&req.method==='GET')return reply(res,200,{quota:await nicknameQuota(db,user.telegram_id)});
    if(path==='/api/me/nickname'&&req.method==='POST'){
      const b=await body(req);
      const result=await claimNickname(db,user.telegram_id,b.nickname);
      if(result.status!==200)return reply(res,result.status,{code:result.code,quota:result.quota,error:result.code==='NICKNAME_TAKEN'?'Этот ник занят в SkinCar':'Используй 3–24 символа: латинские буквы, цифры и _. Служебные имена недоступны.'});
      return reply(res,200,{user:view(result.user),quota:result.quota});
    }
    if(path==='/api/me'&&req.method==='GET')return reply(res,200,{user:view(user)});
    if(path==='/api/me'&&req.method==='PATCH'){
      const b=await body(req);
      if(Object.keys(b).some(k=>!['displayName','lang','theme'].includes(k)))return reply(res,400,{error:'Unknown fields'});
      const name=b.displayName??user.display_name,lang=b.lang??user.lang,theme=b.theme??user.theme;
      if(typeof name!=='string'||!name.trim()||name.length>80||!['ru','kk','en'].includes(lang)||!['light','dark','system'].includes(theme))return reply(res,400,{error:'Invalid profile'});
      const saved=await db.query(`UPDATE users SET display_name=$2,lang=$3,theme=$4,updated_at=now() WHERE telegram_id=$1 RETURNING *`,[user.telegram_id,name.trim(),lang,theme]);
      return reply(res,200,{user:view(saved.rows[0])});
    }
    if(path==='/api/logout'&&req.method==='POST'){await db.query('DELETE FROM sessions WHERE token_hash=$1',[digest(bearer[1])]);return reply(res,200,{ok:true})}
    return reply(res,404,{error:'Not found'});
  }catch(error){console.error('Request failed:',error.code||error.name);return reply(res,error.status||500,{error:error.status?error.code:'Server error',code:error.status?error.code:'SERVER_ERROR'})}
};
}
