import {requireConsent,recordConsent,verifyConsent,imageHashes,CONSENT_VERSION} from './consent.js';
import {catalog,createInvoice,checkCheckout,settlePayment,applyRefund} from './payments.js';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import sharp from 'sharp';
import {enqueue,imageOf,optionsOf,admitWheelOptions,admitFilmOptions,viewJob,uuid,grantPilot} from './generations.js';
import {wheelAccess} from './wheel-library.js';
import {filmAccess} from './film-library.js';
import {validateInitData} from './auth.js';
import {normalizeNickname,claimNickname,nicknameQuota} from './nickname.js';
import {listDrafts,saveDraft,deleteDraft} from './drafts.js';
import {vehicleMetadata,vehicleView} from './vehicle-metadata.js';
import {findSavedUpload} from './upload-status.js';
import {createBotService,telegramMultipart} from './bot-service.js';
import {newRequestId,routeFamily,traceEvent,ratePolicy,consumeApiLimit,allowAnonymousAuth,tooMany} from './api-security.js';
export function createHandler(db,config=process.env){
const {BOT_TOKEN,WEBHOOK_SECRET}=config;
const APP_URL=config.APP_URL||'https://skincar01.netlify.app/';
const ORIGIN=new URL(APP_URL).origin;
const digest=s=>createHash('sha256').update(s).digest('hex');
const reply=(res,status,data)=>{
 if(status>=400&&!res.skLogged)console.warn(traceEvent('api_rejection',res.skRequestId,res.skRoute||'other',status,data?.code||'UNSPECIFIED'));
 const payload=data&&typeof data==='object'&&!Array.isArray(data)?{...data,requestId:res.skRequestId}:data;
 res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
 res.end(JSON.stringify(payload));
};
async function body(req,limit=32768){let size=0,parts=[];for await(const chunk of req){size+=chunk.length;if(size>limit)throw Object.assign(Error('Body too large'),{status:413,code:'BODY_TOO_LARGE'});parts.push(chunk)}try{const value=JSON.parse(Buffer.concat(parts).toString()||'{}');if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value;}catch{throw Object.assign(Error('Invalid JSON'),{status:400,code:'INVALID_JSON'})}}
async function telegram(method,data){const r=await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(10000)});const json=await r.json();if(!json.ok)throw Error('Telegram request failed');return json.result}
const botService=createBotService({db,config,send:telegram,upload:(method,data)=>telegramMultipart(BOT_TOKEN,method,data)});
const view=u=>({id:u.telegram_id,displayName:u.display_name,lang:u.lang,theme:u.theme,balance:u.balance,nickname:u.nickname,nicknameRequired:!u.nickname,suggestedNickname:normalizeNickname(u.telegram_username)});
return async(req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  res.skRequestId=newRequestId();res.skRoute=routeFamily(path);
  res.setHeader('X-Request-ID',res.skRequestId);
  res.setHeader('Access-Control-Expose-Headers','X-Request-ID, Retry-After');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Content-Type-Options','nosniff');
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
      if(m?.refunded_payment){const recipient=m.chat?.type==='private'?m.chat.id:m.from?.id;await applyRefund(db,recipient,m.refunded_payment);}
      // SK-106: repeated Telegram callback delivery cannot send the same document twice.
      // An interrupted action can be retried by pressing a button again (new callback ID).
      let botCallbackFirst=true;
      if(update.callback_query){
        const qid=String(update.callback_query.id||'');
        if(qid.length<1||qid.length>128)botCallbackFirst=false;
        else{const receipt=await db.query(`INSERT INTO bot_callback_receipts(query_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING query_id`,[qid]);botCallbackFirst=!!receipt.rowCount;}
      }
      // User commands, private garage and admin controls; Stars handlers above remain intact.
      if(botCallbackFirst&&(update.callback_query||m))await botService(update);
      return reply(res,200,{ok:true});
    }
    if(path==='/api/auth/telegram'&&req.method==='POST'){
      if(!allowAnonymousAuth(req.socket?.remoteAddress))throw tooMany(60);
      const b=await body(req);let user;
      try{user=validateInitData(b.initData,BOT_TOKEN)}catch{return reply(res,401,{error:'Открой приложение заново через Telegram'})}
      await consumeApiLimit(db,'auth',user.id);
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
    const policy=ratePolicy(path,req.method);
    if(policy)await consumeApiLimit(db,policy,user.telegram_id);
    if(path==='/api/wheels/availability'&&req.method==='GET')return reply(res,200,wheelAccess(config,user.telegram_id));
    if(path==='/api/films/availability'&&req.method==='GET')return reply(res,200,filmAccess(config,user.telegram_id));
    if(path==='/api/payments/catalog'&&req.method==='GET')return reply(res,200,catalog(user.telegram_id,config));
    if(path==='/api/payments/invoice'&&req.method==='POST'){const b=await body(req);return reply(res,200,await createInvoice(db,user.telegram_id,b.packId,telegram,config));}
    if(path==='/api/payments/history'&&req.method==='GET'){const r=await db.query('SELECT r.order_id,r.stars,r.credits,r.created_at,r.refunded_at FROM payment_receipts r WHERE telegram_id=$1 ORDER BY created_at DESC LIMIT 50',[user.telegram_id]);return reply(res,200,{purchases:r.rows,balance:user.balance});}
    if(path==='/api/vehicles'&&req.method==='GET'){
      const items=(await db.query(`SELECT v.id,v.name,v.make,v.model,v.generation,v.modification,v.nickname,v.created_at,
       (1+(SELECT count(*) FROM vehicle_photos p WHERE p.vehicle_id=v.id)) AS photo_count
       FROM vehicles v WHERE v.telegram_id=$1 ORDER BY v.created_at DESC LIMIT 100`,[user.telegram_id])).rows;
      return reply(res,200,{vehicles:items.map(vehicleView)});
    }
    // SK-085: recover a saved upload when the client did not receive the HTTP response.
    if(path==='/api/uploads/status'&&req.method==='GET'){
      const params=new URL(req.url,'http://localhost').searchParams;
      const vehicleId=params.get('vehicleId'),photoId=params.get('photoId');
      if(!uuid(vehicleId)||!uuid(photoId))return reply(res,400,{code:'INVALID_UPLOAD_ID'});
      const record=await findSavedUpload(db,{telegramId:user.telegram_id,vehicleId,photoId,consentVersion:CONSENT_VERSION});
      return record?reply(res,200,record):reply(res,404,{code:'UPLOAD_PENDING'});
    }
    if(path==='/api/vehicles'&&req.method==='POST'){
      const b=await body(req,15*1024*1024+8192);
      if(!uuid(b.id))return reply(res,400,{code:'INVALID_VEHICLE'});
      const meta=vehicleMetadata(b,{allowLegacy:true}),name=meta.name;
      requireConsent(b.consent);const source=await imageOf(b.image);
      const c=await db.connect();try{await c.query('BEGIN');await c.query('SELECT telegram_id FROM users WHERE telegram_id=$1 FOR UPDATE',[user.telegram_id]);
       const existing=(await c.query('SELECT id,name,source_image FROM vehicles WHERE id=$1 AND telegram_id=$2',[b.id,user.telegram_id])).rows[0];
       if(existing){const h=imageHashes(b.image,source);if(!h.includes(digest(existing.source_image)))throw Object.assign(Error(),{status:409,code:'PHOTO_MISMATCH'});const consent=await recordConsent(c,user.telegram_id,b.id,b.image,source,b.consent);await c.query('COMMIT');return reply(res,200,{vehicle:{id:existing.id,name:existing.name},consent});}
       const count=(await c.query('SELECT count(*) AS n FROM vehicles WHERE telegram_id=$1',[user.telegram_id])).rows[0];if(Number(count.n)>=100)throw Object.assign(Error(),{status:429,code:'VEHICLE_LIMIT'});
       const vehicle=(await c.query('INSERT INTO vehicles(id,telegram_id,name,source_image,original_image,original_mime,make,model,generation,modification,nickname) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id,name,make,model,generation,modification,nickname',[b.id,user.telegram_id,name,source,Buffer.from(b.image.split(',')[1],'base64'),b.image.slice(5,b.image.indexOf(';')),meta.make,meta.model,meta.generation,meta.modification,meta.nickname])).rows[0];const consent=await recordConsent(c,user.telegram_id,b.id,b.image,source,b.consent);await c.query('COMMIT');return reply(res,201,{vehicle,consent});
      }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
    }
    // SK-078: owner may attach a *new photo* to an existing car without overwriting its primary photo.
    const extraPhotoPath=/^\/api\/vehicles\/([a-f0-9-]+)\/photos$/.exec(path);
    if(extraPhotoPath){
      const id=extraPhotoPath[1];if(!uuid(id))return reply(res,404,{code:'VEHICLE_NOT_FOUND'});
      if(req.method==='GET'){
        const owner=(await db.query('SELECT id FROM vehicles WHERE id=$1 AND telegram_id=$2',[id,user.telegram_id])).rows[0];
        if(!owner)return reply(res,404,{code:'VEHICLE_NOT_FOUND'});
        const rows=(await db.query(`SELECT id,created_at FROM vehicle_photos WHERE vehicle_id=$1 AND telegram_id=$2 ORDER BY created_at DESC LIMIT 100`,[id,user.telegram_id])).rows;
        return reply(res,200,{photos:[{id,primary:true},...rows.map(r=>({id:r.id,createdAt:r.created_at,primary:false}))]});
      }
      if(req.method==='POST'){
        const b=await body(req,15*1024*1024+8192);
        if(!uuid(b.photoId)||b.photoId===id)return reply(res,400,{code:'INVALID_PHOTO'});
        requireConsent(b.consent);
        const processed=await imageOf(b.image);
        const c=await db.connect();
        try{
          await c.query('BEGIN');
          const car=(await c.query('SELECT id,name,make,model,generation,modification,nickname FROM vehicles WHERE id=$1 AND telegram_id=$2 FOR UPDATE',[id,user.telegram_id])).rows[0];
          if(!car)throw Object.assign(Error(),{status:404,code:'VEHICLE_NOT_FOUND'});
          const original=Buffer.from(b.image.split(',')[1],'base64'),mime=b.image.slice(5,b.image.indexOf(';'));
          const prev=(await c.query('SELECT id,vehicle_id,source_image FROM vehicle_photos WHERE id=$1 AND telegram_id=$2',[b.photoId,user.telegram_id])).rows[0];
          if(prev){if(String(prev.vehicle_id)!==id||digest(prev.source_image)!==digest(processed))throw Object.assign(Error(),{status:409,code:'PHOTO_MISMATCH'});}
          else{
            const count=(await c.query('SELECT count(*) AS n FROM vehicle_photos WHERE vehicle_id=$1',[id])).rows[0];
            if(Number(count.n)>=99)throw Object.assign(Error(),{status:429,code:'VEHICLE_PHOTO_LIMIT'});
            await c.query('INSERT INTO vehicle_photos(id,vehicle_id,telegram_id,source_image,original_image,original_mime) VALUES($1,$2,$3,$4,$5,$6)',[b.photoId,id,user.telegram_id,processed,original,mime]);
          }
          const consent=await recordConsent(c,user.telegram_id,id,b.image,processed,b.consent);
          await c.query('COMMIT');return reply(res,prev?200:201,{vehicle:car,photo:{id:b.photoId},consent});
        }catch(err){await c.query('ROLLBACK');throw err;}finally{c.release();}
      }
    }
    const extraPhotoThumb=/^\/api\/vehicles\/([a-f0-9-]+)\/photos\/([a-f0-9-]+)\/thumbnail$/.exec(path);
    if(extraPhotoThumb&&req.method==='GET'){
      const [,vehicleId,photoId]=extraPhotoThumb;
      if(!uuid(vehicleId)||!uuid(photoId))return reply(res,404,{code:'PHOTO_NOT_FOUND'});
      const row=(await db.query('SELECT p.source_image FROM vehicle_photos p JOIN vehicles v ON v.id=p.vehicle_id WHERE p.id=$1 AND p.vehicle_id=$2 AND p.telegram_id=$3 AND v.telegram_id=$3',[photoId,vehicleId,user.telegram_id])).rows[0];
      if(!row)return reply(res,404,{code:'PHOTO_NOT_FOUND'});
      const thumb=await sharp(row.source_image).resize(480,320,{fit:'inside',withoutEnlargement:true}).jpeg({quality:72}).toBuffer();
      res.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'private, no-store','Content-Length':thumb.length});return res.end(thumb);
    }
    const extraPhotoSource=/^\/api\/vehicles\/([a-f0-9-]+)\/photos\/([a-f0-9-]+)\/source$/.exec(path);
    if(extraPhotoSource&&req.method==='GET'){
      const [,vehicleId,photoId]=extraPhotoSource;
      if(!uuid(vehicleId)||!uuid(photoId))return reply(res,404,{code:'PHOTO_NOT_FOUND'});
      const row=(await db.query(`SELECT p.original_image,p.original_mime FROM vehicle_photos p JOIN vehicles v ON v.id=p.vehicle_id
      WHERE p.id=$1 AND p.vehicle_id=$2 AND p.telegram_id=$3 AND v.telegram_id=$3`,[photoId,vehicleId,user.telegram_id])).rows[0];
      if(!row)return reply(res,404,{code:'PHOTO_NOT_FOUND'});
      res.writeHead(200,{'Content-Type':row.original_mime,'Cache-Control':'private, no-store','Content-Length':row.original_image.length});return res.end(row.original_image);
    }
    const vehicleMetaPath=/^\/api\/vehicles\/([a-f0-9-]+)$/.exec(path);
    if(vehicleMetaPath){
      const id=vehicleMetaPath[1];if(!uuid(id))return reply(res,404,{code:'VEHICLE_NOT_FOUND'});
      if(req.method==='PATCH'){
        const b=await body(req,8192),meta=vehicleMetadata(b);
        const result=(await db.query(`UPDATE vehicles SET name=$1,make=$2,model=$3,generation=$4,modification=$5,nickname=$6
          WHERE id=$7 AND telegram_id=$8 RETURNING id,name,make,model,generation,modification,nickname`,[meta.name,meta.make,meta.model,meta.generation,meta.modification,meta.nickname,id,user.telegram_id])).rows[0];
        if(!result)return reply(res,404,{code:'VEHICLE_NOT_FOUND'});
        return reply(res,200,{vehicle:result});
      }
      if(req.method==='DELETE'){
        const c=await db.connect();try{
          await c.query('BEGIN');
          const vehicle=(await c.query('SELECT id FROM vehicles WHERE id=$1 AND telegram_id=$2 FOR UPDATE',[id,user.telegram_id])).rows[0];
          if(!vehicle){await c.query('ROLLBACK');return reply(res,404,{code:'VEHICLE_NOT_FOUND'});}
          const active=(await c.query(`SELECT id FROM generations WHERE telegram_id=$1 AND options->>'vehicleId'=$2 AND status IN ('queued','processing') LIMIT 1`,[user.telegram_id,id])).rows[0];
          if(active){await c.query('ROLLBACK');return reply(res,409,{code:'VEHICLE_PROCESSING'});}
          // Preserve monetary ledger and anonymous token usage, erase all personal image/vehicle content.
          await c.query(`UPDATE generations SET archived=true,source_image=NULL,result_image=NULL,thumbnail=NULL,options='{}'::jsonb
             WHERE telegram_id=$1 AND options->>'vehicleId'=$2`,[user.telegram_id,id]);
          await c.query('DELETE FROM drafts WHERE telegram_id=$1 AND vehicle_id=$2',[user.telegram_id,id]);
          await c.query('DELETE FROM photo_consents WHERE telegram_id=$1 AND vehicle_id=$2',[user.telegram_id,id]);
          await c.query('DELETE FROM vehicle_photos WHERE telegram_id=$1 AND vehicle_id=$2',[user.telegram_id,id]);
          await c.query('DELETE FROM vehicles WHERE id=$1 AND telegram_id=$2',[id,user.telegram_id]);
          await c.query('COMMIT');return reply(res,200,{deleted:true});
        }catch(err){await c.query('ROLLBACK');throw err;}finally{c.release();}
      }
    }
    // SK-047..049: reusing an owner's original photo requires the existing consent,
    // not an anonymous vehicle ID or a newly fabricated agreement.
    const vehicleReusePath=/^\/api\/vehicles\/([a-f0-9-]+)\/reuse$/.exec(path);
    if(vehicleReusePath&&req.method==='GET'){
      if(!uuid(vehicleReusePath[1]))return reply(res,404,{code:'VEHICLE_NOT_FOUND'});
      const requestedPhoto=new URL(req.url,'http://localhost').searchParams.get('photoId');
      if(requestedPhoto&&!uuid(requestedPhoto))return reply(res,400,{code:'INVALID_PHOTO'});
      const vehicle=(await db.query('SELECT id,name,make,model,generation,modification,nickname,source_image FROM vehicles WHERE id=$1 AND telegram_id=$2',[vehicleReusePath[1],user.telegram_id])).rows[0];
      if(!vehicle)return reply(res,404,{code:'VEHICLE_NOT_FOUND'});
      let selectedImage=vehicle.source_image;
      if(requestedPhoto&&requestedPhoto!==vehicle.id){
        const extra=(await db.query('SELECT source_image FROM vehicle_photos WHERE id=$1 AND vehicle_id=$2 AND telegram_id=$3',[requestedPhoto,vehicle.id,user.telegram_id])).rows[0];
        if(!extra)return reply(res,404,{code:'PHOTO_NOT_FOUND'});
        selectedImage=extra.source_image;
      }
      const consent=(await db.query(`SELECT id FROM photo_consents
        WHERE vehicle_id=$1 AND telegram_id=$2 AND accepted=true
          AND text_version=$4 AND source_hash=$3
        ORDER BY accepted_at DESC LIMIT 1`,[vehicle.id,user.telegram_id,digest(selectedImage),CONSENT_VERSION])).rows[0];
      if(!consent)return reply(res,409,{code:'PHOTO_CONSENT_REQUIRED'});
      return reply(res,200,{vehicle:vehicleView(vehicle),photoId:requestedPhoto||vehicle.id,consentId:consent.id});
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
      if(!uuid(b.consentId)||!uuid(b.options?.vehicleId))return reply(res,400,{code:'PHOTO_CONSENT_REQUIRED'});const options=admitFilmOptions(admitWheelOptions(optionsOf(b.options),config,user.telegram_id),config,user.telegram_id),source=await imageOf(b.image);await verifyConsent(db,user.telegram_id,b.consentId,options.vehicleId,b.image,source);
      if(options.photoId){
        const row=options.photoId===options.vehicleId
         ?(await db.query('SELECT source_image FROM vehicles WHERE id=$1 AND telegram_id=$2',[options.vehicleId,user.telegram_id])).rows[0]
         :(await db.query('SELECT source_image FROM vehicle_photos WHERE id=$1 AND vehicle_id=$2 AND telegram_id=$3',[options.photoId,options.vehicleId,user.telegram_id])).rows[0];
        if(!row||digest(row.source_image)!==digest(source))return reply(res,409,{code:'PHOTO_MISMATCH'});
      }
      options.photoConsentId=b.consentId;
      if(options.vehicleId){const v=(await db.query('SELECT name,make,model,generation,modification FROM vehicles WHERE id=$1 AND telegram_id=$2',[options.vehicleId,user.telegram_id])).rows[0];if(!v)return reply(res,404,{code:'VEHICLE_NOT_FOUND'});
       options.vehicleName=v.name;
       // Trusted database record, never a client-supplied make/model. Preserve legacy cars with no structured fields.
       options.vehicleIdentity={make:v.make||null,model:v.model||null,generation:v.generation||null,modification:v.modification||null};
      }
      return reply(res,202,await enqueue(db,user.telegram_id,b.requestKey,source,options));
    }
    if(path==='/api/generations'&&req.method==='GET'){
      const jobs=await db.query('SELECT id,request_key,status,options,charged_credits,error_code,refunded,created_at,archived FROM generations WHERE telegram_id=$1 AND NOT archived ORDER BY created_at DESC LIMIT 100',[user.telegram_id]);
      return reply(res,200,{jobs:jobs.rows.map(viewJob),balance:user.balance});
    }
    const jobPath=/^\/api\/generations\/([^/]+)(?:\/(source|result|thumbnail))?$/.exec(path);
    if(jobPath){
      if(!uuid(jobPath[1]))return reply(res,404,{error:'Not found'});
      const job=(await db.query('SELECT id,request_key,status,options,charged_credits,error_code,refunded,created_at,archived FROM generations WHERE id=$1 AND telegram_id=$2 AND NOT archived',[jobPath[1],user.telegram_id])).rows[0];
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
  }catch(error){
    if(error.retryAfter)res.setHeader('Retry-After',String(error.retryAfter));
    const status=error.status||500,code=error.status?error.code:'SERVER_ERROR';
    console.error(traceEvent('api_exception',res.skRequestId,res.skRoute||'other',status,code));
    res.skLogged=true;
    return reply(res,status,{error:error.status?error.code:'Server error',code});
  }
};
}
