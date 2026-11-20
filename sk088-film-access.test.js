import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {filmAccess,authorizeFilmSku,filmReferenceHash,loadFilmReference} from './film-library.js';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'film-packs');
const cfg={FILM_GENERATION_MODE:'public_beta'};
test('public beta gives all users access to owner-provided film SKUs',()=>{assert.equal(filmAccess(cfg,'999').availableSkus.length,151)});
test('public beta has 151 independent SKU references',()=>{
 const res=filmAccess(cfg,'12345');
 assert.equal(res.mode,'public_beta');assert.equal(res.availableSkus.length,151);
 assert.equal(new Set(res.availableSkus).size,151);
});
test('every public reference exists and can be loaded with matching SHA',()=>{
 for(const sku of filmAccess(cfg,'12345').availableSkus){
  const record=authorizeFilmSku(sku,cfg,'12345');
  const expected=filmReferenceHash(sku,cfg,'12345');
  const reference=loadFilmReference(sku,expected,cfg,'12345');
  assert.ok(reference.bytes.length>1024);
  assert.equal(record.imageRights,'unverified');
 }
});
test('mismatched reference hash is rejected before provider call',()=>assert.throws(()=>loadFilmReference('vega-color-ppf/ppf-101','0'.repeat(64),cfg,'12345'),{code:'FILM_REFERENCE_CHANGED'}));
test('public beta allowlist can narrow the test catalogue',()=>assert.deepEqual(filmAccess({FILM_GENERATION_MODE:'public_beta',FILM_APPROVED_SKUS:'vega-color-ppf/ppf-101'},'12345').availableSkus,['vega-color-ppf/ppf-101']));
test('missing server pack index leaves private pilot unable to generate',()=>{
 const idx=JSON.parse(fs.readFileSync(path.join(root,'index.json'),'utf8'));
 assert.equal(idx.packs.length,3);
 assert.ok(idx.packs.every(p=>p.active===true));
});

test('commercial live rejects unverified images even if allowlisted',()=>assert.equal(filmAccess({FILM_GENERATION_MODE:'live',FILM_APPROVED_SKUS:'vega-color-ppf/ppf-101'},'22').availableSkus.length,0));
test('default off denies all film generation until Railway is configured',()=>assert.equal(filmAccess({},'22').availableSkus.length,0));
