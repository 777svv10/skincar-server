import {test} from 'node:test';
import assert from 'node:assert/strict';
import {newRequestId,routeFamily,traceEvent,hashActor,ratePolicy,consumeApiLimit,allowAnonymousAuth,RATE_LIMITS} from './api-security.js';
import {catalog} from './payments.js';
test('SK110 request IDs unique and safe; structured log never includes raw user URLs',()=>{
 const a=newRequestId(),b=newRequestId();assert.match(a,/^[0-9a-f]{24}$/);assert.notEqual(a,b);
 assert.equal(routeFamily('/api/generations/aaaa-1234/result'),'generations');
 assert(!traceEvent('api_exception',a,'vehicles',403,'PHOTO_MISMATCH').includes('telegram_id'));
});
test('SK110 correct per-route mutation budgets without slowing normal GET',()=>{
 assert.equal(ratePolicy('/api/vehicles','POST'),'upload');
 assert.equal(ratePolicy('/api/vehicles/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/photos','POST'),'upload');
 assert.equal(ratePolicy('/api/generations','POST'),'generation');
 assert.equal(ratePolicy('/api/drafts/some-id','PUT'),'mutation');
 assert.equal(ratePolicy('/api/auth/telegram','POST'),'auth');
 assert.equal(ratePolicy('/api/generations','GET'),null);
 assert.equal(RATE_LIMITS.auth[0][1],15);
});
test('SK110 atomic DB budget and safe 429 on exhausted window',async()=>{
 const seen=[],db={query:async(sql,args)=>{seen.push({sql,args});return {rowCount:seen.length===2?0:1}}};
 await assert.rejects(()=>consumeApiLimit(db,'generation','123456'),e=>e.status===429&&e.code==='RATE_LIMITED'&&e.retryAfter===3600);
 assert.equal(seen.length,2);assert.match(seen[0].sql,/ON CONFLICT/);
 assert.match(seen[0].sql,/WHERE api_rate_limits.hits<\$4/);
 assert.equal(seen[0].args[1].length,64);assert(!seen[0].args.includes('123456'));
});
test('SK110 different users have isolated counters and raw tokens never become keys',()=>{
 assert.notEqual(hashActor('sk110:auth','123'),hashActor('sk110:auth','124'));
 assert.notEqual(hashActor('sk110:auth','123'),hashActor('sk110:upload','123'));
 assert.throws(()=>hashActor('scope','abc\nsecret'));
});
test('SK110 old implicit payment testers are not allowed without explicit Railway allowlist',()=>{
 assert.deepEqual(catalog('42',{PAYMENTS_MODE:'pilot'}).packs,[]);
 assert.equal(catalog('42',{PAYMENTS_MODE:'pilot',PAYMENT_TESTER_IDS:'42'}).packs.length,1);
 assert.equal(catalog('999',{PAYMENTS_MODE:'pilot',PAYMENT_TESTER_IDS:'42'}).packs.length,0);
});
test('SK110 socket guard never trusts forwarded header and avoids huge memory per request',()=>{
 assert.equal(allowAnonymousAuth('127.0.0.1',1800000000000),true);
 assert.equal(allowAnonymousAuth('127.0.0.1',1800000060000),true);
});

import {createHandler} from './app.js';
import {createHash} from 'node:crypto';
function mockResponse(){const headers={},out={headers,status:null,data:null,setHeader(name,value){headers[name]=value;},writeHead(status,extra){this.status=status;Object.assign(headers,extra||{});},end(value){this.data=value;}};return out;}
test('SK110 unauthenticated access receives trace ID without disclosing internal details',async()=>{
 const db={query:async()=>{throw Error('DB SHOULD NOT BE REACHED')}};
 const handler=createHandler(db,{BOT_TOKEN:'test-token',WEBHOOK_SECRET:'s'.repeat(32)});
 const res=mockResponse();await handler({url:'/api/vehicles',method:'GET',headers:{}},res);
 assert.equal(res.status,401);assert.match(res.headers['X-Request-ID'],/^[a-f0-9]{24}$/);
 assert.equal(JSON.parse(res.data).requestId,res.headers['X-Request-ID']);
 assert.equal(res.headers['Access-Control-Expose-Headers'],'X-Request-ID, Retry-After');
});
test('SK110 too frequent uploads blocked before body decoding; owner data remains scoped',async()=>{
 const key='a'.repeat(64);const digest=createHash('sha256').update(key).digest('hex');
 let requestCount=0,parsed=false;
 const db={query:async(sql,args)=>{
  if(sql.includes('FROM sessions s JOIN users')){assert.equal(args[0],digest);return {rows:[{telegram_id:1,balance:4,nickname:'abc',telegram_username:null,display_name:'Tester',lang:'ru',theme:'light'}]}}
  if(sql.includes('INSERT INTO api_rate_limits')){requestCount++;return {rows:[],rowCount:0}}
  if(sql.includes('FROM vehicles WHERE id=$1 AND telegram_id=$2')){assert.equal(args[1],1);return {rows:[]}}
  throw Error('Unexpected query: '+sql.slice(0,40));
 }};
 const handler=createHandler(db,{BOT_TOKEN:'test-token',WEBHOOK_SECRET:'s'.repeat(32)});
 let response=mockResponse();await handler({url:'/api/vehicles',method:'POST',headers:{authorization:'Bearer '+key},async *[Symbol.asyncIterator](){parsed=true;yield Buffer.from('{}');}},response);
 assert.equal(parsed,false);assert.equal(response.status,429);assert.equal(response.headers['Retry-After'],'60');
 assert.equal(JSON.parse(response.data).code,'RATE_LIMITED');assert.equal(requestCount,1);
 response=mockResponse();await handler({url:'/api/vehicles/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/source',method:'GET',headers:{authorization:'Bearer '+key}},response);
 assert.equal(response.status,404);assert.equal(response.headers['X-Request-ID'].length,24);
});
