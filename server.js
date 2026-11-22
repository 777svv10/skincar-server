import {ensurePaymentWebhook,telegramCall} from './telegram.js';
import {flushReadyNotifications} from './bot-service.js';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {createHandler} from './app.js';
import {startWorker} from './generations.js';
import {cleanupExpiredDrafts} from './drafts.js';
const {BOT_TOKEN,DATABASE_URL,WEBHOOK_SECRET}=process.env;
if(!BOT_TOKEN||!DATABASE_URL||!WEBHOOK_SECRET||WEBHOOK_SECRET.length<32)throw Error('Set BOT_TOKEN, DATABASE_URL and WEBHOOK_SECRET (32+ characters)');
const db=new pg.Pool({connectionString:DATABASE_URL,max:10});
await db.query(await readFile(new URL('./schema.sql',import.meta.url),'utf8'));
const appConfig={...process.env,PAYMENTS_MODE:'off'};
let webhookConfigured=false;
async function enableWebhook(){
 try{
  await ensurePaymentWebhook();
  webhookConfigured=true;
  appConfig.PAYMENTS_MODE=process.env.PAYMENTS_MODE||'pilot';
  console.log('Telegram bot webhook ready; Stars mode:',appConfig.PAYMENTS_MODE);
  // Commands are convenience only; failures never disable payments or bot.
  try{await telegramCall(BOT_TOKEN,'setMyCommands',{commands:[
   {command:'start',description:'Две кнопки: приложение и меню'},
   {command:'menu',description:'Разделы Telegram-бота'},
   {command:'garage',description:'Мой гараж и готовые образы'},
   {command:'balance',description:'Баланс генераций'},
   {command:'status',description:'Статус последних генераций'},
   {command:'faq',description:'Частые вопросы'},
   {command:'support',description:'Обращение в поддержку'},
   {command:'notifications',description:'Уведомления о готовности'}
  ]});}catch(e){console.error('Telegram command menu unavailable',e.code||e.name);}
 }catch(e){console.error('Telegram webhook unavailable; retry scheduled',e.code||e.name);}
}
void enableWebhook();
const webhookRetry=setInterval(()=>{if(!webhookConfigured)void enableWebhook();},60000);webhookRetry.unref();
let botNoticeRunning=false;
const noticeTimer=setInterval(async()=>{
 if(botNoticeRunning||!webhookConfigured)return;
 botNoticeRunning=true;
 try{await flushReadyNotifications(db,(method,data)=>telegramCall(BOT_TOKEN,method,data),appConfig);}catch(e){console.error('Bot notification delivery',e.code||e.name);}finally{botNoticeRunning=false;}
},15000);noticeTimer.unref();
http.createServer(createHandler(db,appConfig)).listen(Number(process.env.PORT)||3000,'0.0.0.0',()=>console.log('SkinCar server ready'));
setInterval(()=>db.query('DELETE FROM sessions WHERE expires_at < now()').catch(()=>{}),3600000).unref();
startWorker(db);
// Expiration uses database timestamps, never client time. Retention: 7 days since last saved change.
const draftCleanup=()=>cleanupExpiredDrafts(db).catch(e=>console.error('Draft cleanup failed',e.code||e.name));
void draftCleanup();
setInterval(draftCleanup,3600000).unref();

// Bound receipt retention and flood-control housekeeping to protect PostgreSQL.
const botHousekeeping=async()=>{
 try{
  await db.query("DELETE FROM bot_callback_receipts WHERE received_at<now()-interval '7 days'");
  await db.query("DELETE FROM bot_rate_limits WHERE window_start<now()-interval '2 days'");
  await db.query("DELETE FROM bot_support_state WHERE awaiting=false AND updated_at<now()-interval '30 days'");
 }catch(e){console.error('Bot housekeeping failed',e.code||e.name);}
};
setInterval(botHousekeeping,6*3600000).unref();
