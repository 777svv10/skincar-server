import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'film-packs');
const idx=JSON.parse(fs.readFileSync(path.join(root,'index.json'),'utf8'));
const expectations={'vega-color-ppf':76,'vega-color-premium':41,'iristek-colors':34};

test('SK087: all three independent collections are active for generation',()=>{
 assert.equal(idx.schemaVersion,1);
 assert.deepEqual(idx.packs.map(p=>p.id),Object.keys(expectations));
 assert.ok(idx.packs.every(p=>p.active===true));
});

test('SK087: 151 distinct products are generation-ready with valid thumbnails and references',()=>{
 const seen=new Set();let n=0;
 for(const p of idx.packs){
  const pack=JSON.parse(fs.readFileSync(path.join(root,p.id,'pack.json'),'utf8'));
  assert.equal(pack.id,p.id);
  assert.equal(pack.models.length,expectations[p.id]);
  for(const m of pack.models){
   n++;
   assert.ok(m.id && m.name && m.sku);
   assert.equal(m.skuVerified,true);
   assert.equal(m.imageRights,'approved');
   assert.ok(['vinyl','ppf'].includes(m.material));
   assert.ok(['gloss','matte','satin'].includes(m.finish));
   assert.ok(['solid','metallic','pearl','chrome','chameleon','carbon','texture'].includes(m.effect));
   assert.equal(typeof m.colorGroup,'string');
   const key=p.id+'/'+m.id;assert.ok(!seen.has(key),'duplicate '+key);seen.add(key);
   for(const k of ['preview','reference']){
    assert.match(m[k],/^assets\/(?:thumbs|references)\/[^/]+\.webp$/);
    const data=fs.readFileSync(path.join(root,p.id,m[k]));
    assert.equal(data.toString('ascii',0,4),'RIFF');
    assert.equal(data.toString('ascii',8,12),'WEBP');
    assert.ok(data.length>350);
   }
  }
 }
 assert.equal(n,151);
});
