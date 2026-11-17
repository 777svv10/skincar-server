import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {createHash} from 'node:crypto';
import {ALL_WHEEL_SKUS,wheelRecord,isWheelSku,wheelAccess,authorizeWheelSku,loadWheelReference} from './wheel-library.js';
import {optionsOf,admitWheelOptions,promptOf,editWithOpenAI} from './generations.js';
import {cleanDraftOptions} from './drafts.js';
import {createHandler} from './app.js';
const configs={off:{WHEEL_GENERATION_MODE:'off',WHEEL_APPROVED_SKUS:ALL_WHEEL_SKUS[0],WHEEL_PILOT_TESTER_IDS:'42'},pilot:{WHEEL_GENERATION_MODE:'pilot',WHEEL_APPROVED_SKUS:ALL_WHEEL_SKUS[0],WHEEL_PILOT_TESTER_IDS:'42'}};
const sku=ALL_WHEEL_SKUS[0];
const colorOptions={mode:'builder',color:'original',finish:'original',wheel:'original',wheelSku:sku,custom:''};
const scopedEnv=(fields,fn)=>async()=>{const saved=Object.fromEntries(Object.keys(fields).map(k=>[k,process.env[k]]));Object.assign(process.env,fields);try{await fn();}finally{for(const [k,v] of Object.entries(saved))if(v===undefined)delete process.env[k];else process.env[k]=v;}};

test('exact catalogue has 68 BMW + 24 Vossen + 15 BBS with unique safe names and hashed local references',()=>{
 assert.equal(ALL_WHEEL_SKUS.length,107);
 assert.deepEqual(['bmw-oem','vossen','bbs'].map(b=>ALL_WHEEL_SKUS.filter(s=>s.startsWith(b+'/')).length),[68,24,15]);
 for(const sku of ALL_WHEEL_SKUS){assert(isWheelSku(sku));const record=wheelRecord(sku);assert.match(record.asset,/^[a-z0-9-]+\.jpg$/);const ref=loadWheelReference(sku,record.sha256);assert(ref.bytes.length>1000);assert.equal(createHash('sha256').update(ref.bytes).digest('hex'),record.sha256);}
});
test('unknown or path-injection SKU and tampered reference are blocked',()=>{
 assert.equal(isWheelSku('../../.env'),false);
 assert.throws(()=>loadWheelReference('../../.env','x'),e=>e.code==='WHEEL_NOT_FOUND');
 assert.throws(()=>loadWheelReference(sku,'0'.repeat(64)),e=>e.code==='WHEEL_REFERENCE_CHANGED');
 assert.throws(()=>optionsOf({...colorOptions,wheelSku:'vossen/../../secret'}),e=>e.code==='INVALID_OPTIONS');
 assert.throws(()=>optionsOf({...colorOptions,wheel:'bbs'}),e=>e.code==='INVALID_OPTIONS');
 assert.throws(()=>optionsOf({...colorOptions,model:'force-model'}),e=>e.code==='INVALID_OPTIONS');
});
test('deny by default, pilot user allowlist, and explicit SKU rights approval',()=>{
 assert.equal(wheelAccess(configs.off,42).availableSkus.length,0);
 assert.throws(()=>authorizeWheelSku(sku,configs.off,42),e=>e.code==='WHEEL_GENERATION_DISABLED');
 assert.deepEqual(wheelAccess(configs.pilot,42).availableSkus,[sku]);
 assert.deepEqual(wheelAccess(configs.pilot,43).availableSkus,[]);
 assert.throws(()=>authorizeWheelSku(sku,configs.pilot,43),e=>e.code==='WHEEL_NOT_APPROVED');
 assert.throws(()=>authorizeWheelSku(ALL_WHEEL_SKUS[1],configs.pilot,42),e=>e.code==='WHEEL_NOT_APPROVED');
 assert.equal(admitWheelOptions(optionsOf(colorOptions),configs.pilot,42).wheelName,wheelRecord(sku).name);
});
test('drafts preserve selected wheel; no arbitrary client metadata or free-mode wheel injection',()=>{
 const draft=cleanDraftOptions({mode:'builder',coatingType:'paint',color:'original',finish:'original',wheel:'original',wheelSku:sku,custom:'',fromRepeat:false});
 assert.equal(draft.wheelSku,sku);
 assert.throws(()=>cleanDraftOptions({...draft,mode:'free'}),e=>e.code==='INVALID_DRAFT');
 assert.throws(()=>optionsOf({...colorOptions,mode:'free',custom:'x'}),e=>e.code==='INVALID_OPTIONS');
 assert.throws(()=>optionsOf({...colorOptions,wheelReferenceSha256:'0'.repeat(64)}),e=>e.code==='INVALID_OPTIONS');
});
test('image edit sends selected source wheel as 2nd JPEG and references exact SKU',scopedEnv({...configs.pilot,OPENAI_API_KEY:'test'},async()=>{
 const options=admitWheelOptions(optionsOf(colorOptions),configs.pilot,42);
 const car=await sharp({create:{width:320,height:280,channels:3,background:'#555'}}).jpeg().toBuffer();
 const prompt=promptOf(options);assert.match(prompt,/IMAGE 2/);assert.match(prompt,/spoke count/);assert.match(prompt,new RegExp(sku));
 let calls=0;
 const result=await editWithOpenAI({model:'mock-image-model',telegram_id:42,source_image:car,options},async(url,request)=>{
  calls++;assert(url.endsWith('/images/edits'));assert.equal(request.body.getAll('image[]').length,2);
  assert.equal(request.body.getAll('image[]')[1].type,'image/jpeg');assert.equal(request.body.getAll('image[]')[1].name,'wheel-reference.jpg');
  assert.equal(request.body.get('model'),'mock-image-model');
  const second=Buffer.from(await request.body.getAll('image[]')[1].arrayBuffer());
  assert.deepEqual(second,loadWheelReference(sku,wheelRecord(sku).sha256).bytes);
  return new Response(JSON.stringify({data:[{b64_json:car.toString('base64')}],usage:{total_tokens:10}}));
 });
 assert.equal(calls,1);assert.deepEqual(result.result,car);
}));
test('revoking access while queued prevents provider call',scopedEnv({...configs.off,OPENAI_API_KEY:'test'},async()=>{
 const options=admitWheelOptions(optionsOf(colorOptions),configs.pilot,42);
 let calls=0;
 await assert.rejects(editWithOpenAI({telegram_id:42,options,source_image:Buffer.alloc(8)},()=>{calls++;throw Error('must not call');}),e=>e.code==='WHEEL_GENERATION_DISABLED');
 assert.equal(calls,0);
}));
test('API declines blocked wheels before any balance/debit query',scopedEnv({OPENAI_API_KEY:'test'},async()=>{
 const db={calls:[],async query(sql){this.calls.push(sql);if(sql.includes('FROM sessions s JOIN users'))return {rows:[{telegram_id:42,balance:5,display_name:'QA'}]};throw Error('Unexpected DB query '+sql);}};
 const token='a'.repeat(64),req=(url,method='GET',body=null)=>({url,method,headers:{authorization:'Bearer '+token},async *[Symbol.asyncIterator](){if(body)yield Buffer.from(JSON.stringify(body));}});
 const handle=createHandler(db,{...configs.off,BOT_TOKEN:'fake',WEBHOOK_SECRET:'x'.repeat(32)});
 async function call(request){const out={};await handle(request,{setHeader(){},writeHead(s){out.status=s;},end(data){out.json=JSON.parse(data);}});return out;}
 const state=await call(req('/api/wheels/availability'));
 assert.equal(state.status,200);assert.deepEqual(state.json.availableSkus,[]);
 const invalid=await call(req('/api/generations','POST',{requestKey:'11111111-1111-4111-8111-111111111111',image:'ignored',consentId:'11111111-1111-4111-8111-111111111111',options:{...colorOptions,vehicleId:'11111111-1111-4111-8111-111111111111'}}));
 assert.equal(invalid.status,503);assert.equal(invalid.json.code,'WHEEL_GENERATION_DISABLED');
 assert.equal(db.calls.filter(x=>!x.includes('FROM sessions s JOIN users')).length,0);
}));
