import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createHandler} from './app.js';
import {consumeApiLimit} from './api-security.js';
const token='token-for-auth-tests';
function signedInitData(){
 const parts={auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id:451723,first_name:'QA Test',language_code:'ru'})};
 const check=Object.entries(parts).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');
 const secret=createHmac('sha256','WebAppData').update(token).digest();
 const hash=createHmac('sha256',secret).update(check).digest('hex');
 return new URLSearchParams({...parts,hash}).toString();
}
function makeRequest(){return {url:'/api/auth/telegram',method:'POST',headers:{},socket:{remoteAddress:'127.0.0.99'},async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify({initData:signedInitData()}))}}}
function makeRes(){return {headers:{},status:0,body:'',setHeader(k,v){this.headers[k]=v;},writeHead(code,headers={}){this.status=code;Object.assign(this.headers,headers);},end(data){this.body=data||'';}}}
const person={telegram_id:'451723',display_name:'QA Test',nickname:null,balance:6,lang:'ru',theme:'system',telegram_username:null};
test('SK-111.1 valid Telegram initData reaches 2 database-window limits and creates session',async()=>{
 const queries=[];
 const db={query:async(sql,args)=>{queries.push({sql,args});if(sql.includes('INSERT INTO api_rate_limits'))return {rowCount:1};if(sql.includes('INSERT INTO users'))return {rows:[person],rowCount:1};if(sql.includes('INSERT INTO sessions'))return {rowCount:1};if(sql.includes('SELECT * FROM users'))return {rows:[person]};throw Error('Unexpected database query');}};
 const r=makeRes();await createHandler(db,{BOT_TOKEN:token,WEBHOOK_SECRET:'Z'.repeat(40)})(makeRequest(),r);
 assert.equal(r.status,200);const reply=JSON.parse(r.body);
 assert.equal(reply.user.balance,6);assert.equal(reply.user.id,'451723');assert.equal(reply.session.length,64);
 assert.equal(queries.filter(q=>q.sql.includes('INSERT INTO api_rate_limits')).length,2);
 assert.equal(queries.filter(q=>q.sql.includes('INSERT INTO sessions')).length,1);
 assert(queries.every(q=>!JSON.stringify(q.args||[]).includes('token-for-auth-tests')));
});
test('SK-111.1 auth SQL exception logs stage and SQLSTATE only; never discloses SQL or Telegram identity to client',async()=>{
 const db={query:async()=>{const error=Error('PRIVATE DB query and user secret');error.code='42P01';throw error;}};
 const original=console.error;let log='';console.error=x=>{log=String(x)};
 try{const r=makeRes();await createHandler(db,{BOT_TOKEN:token,WEBHOOK_SECRET:'Z'.repeat(40)})(makeRequest(),r);
  assert.equal(r.status,500);const json=JSON.parse(r.body);assert.equal(json.code,'SERVER_ERROR');assert.match(json.requestId,/^[0-9a-f]{24}$/);
  assert(!r.body.includes('42P01'));assert(!r.body.includes('PRIVATE'));assert(!r.body.includes('451723'));
  const event=JSON.parse(log);assert.equal(event.authStage,'auth_limit');assert.equal(event.sqlState,'42P01');assert.equal(event.requestId,json.requestId);
  assert(!log.includes('PRIVATE'));assert(!log.includes('451723'));assert(!log.includes(token));
 }finally{console.error=original;}
});
test('SK-111.1 rate limiter computes UTC boundaries with explicit postgres type conversions',async()=>{
 const seen=[];await consumeApiLimit({query:async(sql,args)=>{seen.push({sql,args});return {rowCount:1};}},'auth',451723);
 assert.equal(seen.length,2);assert(seen.every(x=>x.sql.includes('$3::numeric')&&x.sql.includes('::double precision')));
 assert.deepEqual(seen.map(x=>x.args.slice(2)),[[60,15],[3600,120]]);
});
