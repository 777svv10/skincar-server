import { createHmac, timingSafeEqual } from 'node:crypto';
export function validateInitData(raw, token, now = Math.floor(Date.now()/1000)) {
  if(typeof raw !== 'string' || raw.length > 16384) throw Error('Invalid login');
  const p = new URLSearchParams(raw);
  if(new Set(p.keys()).size !== [...p.keys()].length) throw Error('Duplicate fields');
  const hash=p.get('hash'); p.delete('hash');
  if(!/^[a-f0-9]{64}$/i.test(hash || '')) throw Error('Invalid hash');
  const secret=createHmac('sha256','WebAppData').update(token).digest();
  const check=[...p.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${k}=${v}`).join('\n');
  const expected=createHmac('sha256',secret).update(check).digest();
  if(!timingSafeEqual(expected,Buffer.from(hash,'hex'))) throw Error('Invalid signature');
  const date=Number(p.get('auth_date'));
  if(!Number.isInteger(date)||now-date>600||date>now+30) throw Error('Expired login');
  const user=JSON.parse(p.get('user')||'null');
  if(!user||!Number.isSafeInteger(user.id)||user.id<=0) throw Error('Invalid user');
  return user;
}


