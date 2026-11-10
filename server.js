import http from 'node:http';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {validateInitData} from './auth.js';
import {normalizeNickname,claimNickname} from './nickname.js';
const {BOT_TOKEN,DATABASE_URL,WEBHOOK_SECRET}=process.env;
const APP_URL=process.env.APP_URL||'https://skincar01.netlify.app/';
const ORIGIN=new URL(APP_URL).origin;
if(!BOT_TOKEN||!DATABASE_URL||!WEBHOOK_SECRET||WEBHOOK_SECRET.length<32) throw Error('Set BOT_TOKEN, DATABASE_URL and WEBHOOK_SECRET (32+ characters)');
const db=new pg.Pool({connectionString:DATABASE_URL,max:10});
await db.query(await readFile(new URL('./schema.sql',import.meta.url),'utf8'));
const digest=s=>createHash('sha256').update(s).digest('hex');
const reply=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data))};
async function body(req){let size=0,parts=[];for await(const chunk of req){size+=chunk.length;if(size>32768)throw Error('Body too large');parts.push(chunk)}return JSON.parse(Buffer.concat(parts).toString()||'{}')}
async function telegram(method,data){const r=await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(10000)});const json=await r.json();if(!json.ok)throw Error('Telegram request failed');return json.result}
const view=u=>({id:u.telegram_id,displayName:u.display_name,lang:u.lang,theme:u.theme,balance:u.balance,nickname:u.nickname,nicknameRequired:!u.nickname,suggestedNickname:normalizeNickname(u.telegram_username)});
http.createServer(async(req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  if(req.headers.origin&&req.headers.origin!==ORIGIN)return reply(res,403,{error:'Origin denied'});
  if(req.headers.origin===ORIGIN){res.setHeader('Access-Control-Allow-Origin',ORIGIN);res.setHeader('Vary','Origin')}
  res.setHeader('X-Content-Type-Options','nosniff');
  if(req.method==='OPTIONS'){res.setHeader('Access-Control-Allow-Methods','GET,POST,PATCH,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization');res.writeHead(204);return res.end()}
  try{
    if(path==='/health'&&req.method==='GET'){await db.query('SELECT 1');return reply(res,200,{ok:true})}
    if(path==='/telegram/webhook'&&req.method==='POST'){
      const supplied=Buffer.from(String(req.headers['x-telegram-bot-api-secret-token']||'')), wanted=Buffer.from(WEBHOOK_SECRET);
      if(supplied.length!==wanted.length||!timingSafeEqual(supplied,wanted))return reply(res,403,{error:'Forbidden'});
      const update=await body(req),m=update.message;
      if(m?.chat?.type==='private'&&/^\/start(?:@skincartuning_bot)?(?:\s|$)/i.test(m.text||''))await telegram('sendMessage',{chat_id:m.chat.id,text:'Добро пожаловать в SkinCar — твоё ИИ тюнинг-ателье. Открой приложение, чтобы собрать образ автомобиля.',reply_markup:{inline_keyboard:[[{text:'Открыть SkinCar',web_app:{url:APP_URL}}]]}});
      return reply(res,200,{ok:true});
    }
    if(path==='/api/auth/telegram'&&req.method==='POST'){
      const b=await body(req);let user;
      try{user=validateInitData(b.initData,BOT_TOKEN)}catch{return reply(res,401,{error:'Открой приложение заново через Telegram'})}
      const lang=['ru','kk','en'].includes(user.language_code)?user.language_code:'ru';
      const {rows}=await db.query(`INSERT INTO users(telegram_id,display_name,lang,telegram_username) VALUES($1,$2,$3,$4) ON CONFLICT(telegram_id) DO UPDATE SET telegram_username=EXCLUDED.telegram_username,updated_at=now() RETURNING *`,[user.id,String(user.first_name||'SkinCar User').slice(0,80),lang,typeof user.username==='string'?user.username.slice(0,64):null]);
      const session=randomBytes(32).toString('hex');
      await db.query(`INSERT INTO sessions(token_hash,telegram_id) VALUES($1,$2)`,[digest(session),user.id]);
      return reply(res,200,{session,user:view(rows[0]),expiresIn:86400});
    }
    const bearer=/^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization||'');
    if(!bearer)return reply(res,401,{error:'Login required'});
    const {rows}=await db.query(`SELECT u.* FROM sessions s JOIN users u USING(telegram_id) WHERE s.token_hash=$1 AND s.expires_at>now()`,[digest(bearer[1])]);
    const user=rows[0];if(!user)return reply(res,401,{error:'Session expired'});
    if(path==='/api/me/nickname'&&req.method==='POST'){
      const b=await body(req);
      const result=await claimNickname(db,user.telegram_id,b.nickname);
      if(result.status!==200)return reply(res,result.status,{code:result.code,error:result.code==='NICKNAME_TAKEN'?'Этот ник занят в SkinCar':'Используй 3–24 символа: латинские буквы, цифры и _. Служебные имена недоступны.'});
      return reply(res,200,{user:view(result.user)});
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
  }catch(error){console.error('Request failed:',error.name);return reply(res,500,{error:'Server error'})}
}).listen(Number(process.env.PORT)||3000,'0.0.0.0',()=>console.log('SkinCar server ready'));
setInterval(()=>db.query('DELETE FROM sessions WHERE expires_at < now()').catch(()=>{}),3600000).unref();

