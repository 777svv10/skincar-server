// SK-110: bounded, account-scoped throttling with atomic PostgreSQL counters.
// The application deliberately does not trust an arbitrary X-Forwarded-For header.
import {createHash,randomBytes} from 'node:crypto';

export const newRequestId=()=>randomBytes(12).toString('hex');
const safeCode=(s)=>typeof s==='string'&&/^[A-Z0-9_]{1,64}$/.test(s)?s:'UNSPECIFIED';
export function routeFamily(path=''){
 if(path==='/api/auth/telegram')return 'auth';
 if(path.startsWith('/api/vehicles'))return 'vehicles';
 if(path.startsWith('/api/generations'))return 'generations';
 if(path.startsWith('/api/reports'))return 'reports';
 if(path.startsWith('/api/uploads'))return 'uploads';
 if(path.startsWith('/api/drafts'))return 'drafts';
 if(path.startsWith('/api/payments'))return 'payments';
 if(path.startsWith('/api/me'))return 'account';
 if(path==='/telegram/webhook')return 'telegram_webhook';
 return 'other';
}
export function traceEvent(event,requestId,route,status,code='UNSPECIFIED'){
 return JSON.stringify({event,requestId,route,status,code:safeCode(code),at:new Date().toISOString()});
}
export function hashActor(scope,actor){
 const text=String(actor);
 if(!/^[A-Za-z0-9_-]{1,128}$/.test(text))throw Error('INVALID_RATE_ACTOR');
 return createHash('sha256').update(scope+'\x00'+text).digest('hex');
}
export function ratePolicy(path,method){
 if(method==='POST'&&path==='/api/auth/telegram')return 'auth';
 if(method==='POST'&&path==='/api/reports/start')return 'report';
 if(!['POST','PUT','PATCH','DELETE'].includes(method))return null;
 if(method==='POST'&&(path==='/api/vehicles'||/^\/api\/vehicles\/[a-f0-9-]+\/photos$/.test(path)))return 'upload';
 if(method==='POST'&&path==='/api/generations')return 'generation';
 return 'mutation';
}
export const RATE_LIMITS=Object.freeze({
 auth:[[60,15],[3600,120]],
 report:[[60,3],[3600,10]],
 upload:[[60,6],[3600,50]],
 generation:[[60,5],[3600,40]],
 mutation:[[60,120],[3600,1500]]
});
export function tooMany(seconds){return Object.assign(Error('RATE_LIMITED'),{status:429,code:'RATE_LIMITED',retryAfter:seconds});}
export async function consumeApiLimit(db,policy,actor){
 if(!Object.hasOwn(RATE_LIMITS,policy))throw Error('UNKNOWN_RATE_POLICY');
 const hash=hashActor('sk110:'+policy,actor);
 for(const [period,max] of RATE_LIMITS[policy]){
  // Atomic global limit across multiple Railway replicas, no check-then-write race.
  const r=await db.query(`INSERT INTO api_rate_limits(scope,actor_hash,period_seconds,window_start,hits)
   VALUES($1,$2,$3,to_timestamp((floor(extract(epoch from now()) / $3::numeric) * $3::numeric)::double precision),1)
   ON CONFLICT(scope,actor_hash,period_seconds,window_start)
   DO UPDATE SET hits=api_rate_limits.hits+1 WHERE api_rate_limits.hits<$4
   RETURNING hits`,[policy,hash,period,max]);
  if(!r.rowCount)throw tooMany(period);
 }
}
// An inexpensive per-worker emergency guard for repeated invalid auth attempts.
// Remote address is socket-derived, not user-controlled forwarding headers;
// the high threshold accommodates NAT/proxy sharing. Edge rate limiting is still required.
const anonymousHits=new Map();
export function allowAnonymousAuth(socketAddress,at=Date.now()){
 const address=typeof socketAddress==='string'&&socketAddress.length<=128?socketAddress:'shared';
 const key=hashActor('socket',address==='shared'?'shared':createHash('sha256').update(address).digest('hex'));
 const win=Math.floor(at/60000);
 if(anonymousHits.size>4096){for(const [k,v] of anonymousHits)if(v.win!==win)anonymousHits.delete(k);}
 if(anonymousHits.size>=8192&&!anonymousHits.has(key))return false;
 const entry=anonymousHits.get(key);
 if(!entry||entry.win!==win){anonymousHits.set(key,{win,hits:1});return true;}
 entry.hits++;return entry.hits<=1500;
}
