import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const file=readFileSync(new URL('./generations.js',import.meta.url),'utf8');
const start=file.indexOf('export function isDailyLimitExempt(');
const stop=file.indexOf('export async function enqueue(',start);
assert(start>=0&&stop>start,'Quota helper is missing');
const exported=file.slice(start,stop).replace('export ','');
const isDailyLimitExempt=Function('process',exported+';return isDailyLimitExempt')({env:{}});
test('exempt the precisely configured tester only',()=>{
 assert.equal(isDailyLimitExempt(306179287,'306179287'),true);
 assert.equal(isDailyLimitExempt('306179287','306179287'),true);
 assert.equal(isDailyLimitExempt(306179288,'306179287'),false);
 assert.equal(isDailyLimitExempt(30617928,'306179287'),false);
});
test('allowlist supports whitespace and comma-separated IDs but no substring matching',()=>{
 assert.equal(isDailyLimitExempt(306179287,' 100, 306179287 , 300'),true);
 assert.equal(isDailyLimitExempt(30617928,' 306179287, 100'),false);
 assert.equal(isDailyLimitExempt(306179287,'*'),false);
 assert.equal(isDailyLimitExempt(306179287,''),false);
 assert.equal(isDailyLimitExempt(306179287,'0306179287'),false);
});
test('only the daily limiter is bypassed, not the other safety limits',()=>{
 assert.match(file,/if\(Number\(counts\.daily\)>=10&&!isDailyLimitExempt\(userId\)\)throw problem\(429,'DAILY_LIMIT'\)/);
 for(const safety of ["JOB_ACTIVE","GARAGE_FULL","CAPACITY_LIMIT","NO_CREDITS","CREDIT_DEBT"])
  assert(file.includes("'"+safety+"'"),'missing required safeguard '+safety);
 assert(file.includes('UPDATE users SET balance=balance-$2'));
});
