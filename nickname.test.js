import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeNickname,claimNickname} from './nickname.js';
test('normalizes case, whitespace and leading @',()=>assert.equal(normalizeNickname(' @Street_E36 '),'street_e36'));
test('rejects reserved, confusable and invalid names',()=>{
 for(const value of ['ADMIN','skincar','ab','a'.repeat(25),'street-e36','владимир','vladіmir','a b',null,42]) assert.equal(normalizeNickname(value),null);
});
