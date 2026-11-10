import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {validateInitData} from '../src/auth.js';
const token='123:test', now=1800000000;
function signed(date=now){const p=new URLSearchParams({auth_date:String(date),query_id:'test',user:JSON.stringify({id:42,first_name:'Vladimir'})});const key=createHmac('sha256','WebAppData').update(token).digest();p.set('hash',createHmac('sha256',key).update([...p].sort().map(([k,v])=>`${k}=${v}`).join('\n')).digest('hex'));return p.toString()}
test('valid login returns Telegram identity',()=>assert.equal(validateInitData(signed(),token,now).id,42));
test('rejects modified user',()=>assert.throws(()=>validateInitData(signed().replace('Vladimir','Attacker'),token,now)));
test('rejects wrong bot',()=>assert.throws(()=>validateInitData(signed(),'other',now)));
test('rejects expired login',()=>assert.throws(()=>validateInitData(signed(now-601),token,now)));
test('rejects future login',()=>assert.throws(()=>validateInitData(signed(now+31),token,now)));
test('rejects duplicate fields',()=>assert.throws(()=>validateInitData(signed()+'&auth_date='+now,token,now)));
