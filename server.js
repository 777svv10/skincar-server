import {ensurePaymentWebhook} from './telegram.js';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {createHandler} from './app.js';
import {startWorker} from './generations.js';
const {BOT_TOKEN,DATABASE_URL,WEBHOOK_SECRET}=process.env;
if(!BOT_TOKEN||!DATABASE_URL||!WEBHOOK_SECRET||WEBHOOK_SECRET.length<32)throw Error('Set BOT_TOKEN, DATABASE_URL and WEBHOOK_SECRET (32+ characters)');
const db=new pg.Pool({connectionString:DATABASE_URL,max:10});
await db.query(await readFile(new URL('./schema.sql',import.meta.url),'utf8'));
const appConfig={...process.env,PAYMENTS_MODE:'off'};
async function enablePayments(){if(process.env.PAYMENTS_MODE==='off')return;try{await ensurePaymentWebhook();appConfig.PAYMENTS_MODE=process.env.PAYMENTS_MODE||'pilot';console.log('Stars webhook ready');}catch{console.error('Stars webhook unavailable; payments disabled until retry');}}
void enablePayments();
const paymentRetry=setInterval(()=>{if(appConfig.PAYMENTS_MODE==='off')void enablePayments();},60000);paymentRetry.unref();
http.createServer(createHandler(db,appConfig)).listen(Number(process.env.PORT)||3000,'0.0.0.0',()=>console.log('SkinCar server ready'));
setInterval(()=>db.query('DELETE FROM sessions WHERE expires_at < now()').catch(()=>{}),3600000).unref();
startWorker(db);
