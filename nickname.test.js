import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeNickname,claimNickname} from './nickname.js';
test('normalizes case, whitespace and leading @',()=>assert.equal(normalizeNickname(' @Street_E36 '),'street_e36'));
test('rejects reserved, confusable and invalid names',()=>{
 for(const value of ['ADMIN','skincar','ab','a'.repeat(25),'street-e36','владимир','vladіmir','a b',null,42]) assert.equal(normalizeNickname(value),null);
});
test('database conflict returns 409 rather than overwriting another account',async()=>{
 const result=await claimNickname({query:async()=>{throw Object.assign(Error(),{code:'23505'})}},1,'street_e36');
 assert.deepEqual(result,{status:409,code:'NICKNAME_TAKEN'});
});
test('only authenticated account id is used to claim nickname',async()=>{
 const db={query:async(sql,args)=>{assert.deepEqual(args,[123,'street_e36']);return {rows:[{telegram_id:123,nickname:args[1]}]}}};
 assert.equal((await claimNickname(db,123,'Street_E36')).user.nickname,'street_e36');
});

