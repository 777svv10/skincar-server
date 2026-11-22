import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createHandler} from './app.js';
const goodToken='b'.repeat(64);
const digest=createHash('sha256').update(goodToken).digest('hex');
const OWNER=101001;
const JOB='11111111-1111-4111-8111-111111111111';
function output(){let result={headers:{},status:null,body:null,setHeader(n,v){this.headers[n]=v;},writeHead(status,h={}){this.status=status;Object.assign(this.headers,h);},end(raw){this.body=raw?JSON.parse(raw):null;}};return result;}
function request(path,payload,session=goodToken){return {url:path,method:'POST',headers:session?{authorization:'Bearer '+session}:{},async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify(payload));}};}
function dbHarness(hasJob=true){let seen=[],reported=0;
 const db={async query(sql,args=[]){seen.push({sql,args});if(sql.includes('FROM sessions s JOIN users'))return {rows:args[0]===digest?[{telegram_id:OWNER,balance:3,display_name:'QA'}]:[]};
  if(sql.includes('INSERT INTO api_rate_limits'))return {rowCount:1,rows:[{hits:1}]};
  if(sql.includes('FROM generations WHERE id=$1 AND telegram_id=$2'))return {rows:hasJob&&args[1]===OWNER?[{id:JOB,status:'failed',model:'x',quality:'standard'}]:[]};
  if(sql.includes('INSERT INTO bot_report_links')){reported++;return {rowCount:1,rows:[]};}
  throw Error('Unexpected query '+sql.slice(0,70));
 }};return {db,seen,reported:()=>reported};}
test('SK111 report endpoint requires valid session before reading body or creating link',async()=>{
 const h=dbHarness();const f=createHandler(h.db,{BOT_TOKEN:'bot',WEBHOOK_SECRET:'x'.repeat(32)}),res=output();
 await f(request('/api/reports/start',{screen:'editor'},null),res);
 assert.equal(res.status,401);assert.equal(h.reported(),0);assert.match(res.body.requestId,/^[a-f0-9]{24}$/);
});
test('SK111 report endpoint creates one owner-linked request, rate limits and never leaks session',async()=>{
 const h=dbHarness(),f=createHandler(h.db,{BOT_TOKEN:'bot',WEBHOOK_SECRET:'x'.repeat(32)}),res=output();
 await f(request('/api/reports/start',{screen:'review',generationId:JOB,requestId:'a'.repeat(24)}),res);
 assert.equal(res.status,201);assert.match(res.body.url,/^https:\/\/t\.me\/skincartuning_bot\?start=report_/);
 assert(h.seen.some(x=>x.sql.includes('INSERT INTO api_rate_limits')&&x.args[0]==='report'));
 assert(!JSON.stringify(res.body).includes(goodToken));assert.equal(h.reported(),1);
});
test('SK111 cannot attach an unowned generation or create a support link for it',async()=>{
 const h=dbHarness(false),f=createHandler(h.db,{BOT_TOKEN:'bot',WEBHOOK_SECRET:'x'.repeat(32)}),res=output();
 await f(request('/api/reports/start',{screen:'result',generationId:JOB}),res);
 assert.equal(res.status,404);assert.equal(res.body.code,'GENERATION_NOT_FOUND');assert.equal(h.reported(),0);
});
