import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {optionsOf,imageEditSettings,editWithOpenAI} from './generations.js';
const base={color:'white',finish:'matte',wheel:'original',custom:'',mode:'builder'};
test('SK-072 default stays medium auto and old jobs remain compatible',()=>{
 const old=optionsOf(base);
 assert.equal(old.qualityMode,undefined);
 assert.deepEqual(imageEditSettings(old,{width:1600,height:1200},'gpt-image-2.6-sunburst'),{quality:'medium',size:'auto'});
});
test('SK-072 validates quality mode on server',()=>{
 assert.equal(optionsOf({...base,qualityMode:'hd'}).qualityMode,'hd');
 assert.equal(optionsOf({...base,qualityMode:'standard'}).qualityMode,'standard');
 assert.throws(()=>optionsOf({...base,qualityMode:'max'}),e=>e.code==='INVALID_OPTIONS');
 assert.throws(()=>optionsOf({...base,qualityMode:42}),e=>e.code==='INVALID_OPTIONS');
});
test('SK-072 HD produces aspect-specific 2K targets',()=>{
 const wanted=[[1600,900,'2048x1152'],[1600,1200,'2048x1536'],[1200,1200,'2048x2048'],[1200,1600,'1536x2048'],[900,1600,'1152x2048']];
 for(const [width,height,size] of wanted){assert.deepEqual(imageEditSettings({qualityMode:'hd'},{width,height},'gpt-image-2.6-sunburst'),{quality:'high',size,output_compression:'92'});}
 assert.equal(imageEditSettings({qualityMode:'hd'},{width:1600,height:900},'unknown-model').size,'auto');
});
test('SK-072 image API gets medium or high with no real network calls',async()=>{
 const data=await sharp({create:{width:1024,height:768,channels:3,background:'#333'}}).jpeg().toBuffer();
 process.env.OPENAI_API_KEY='mock-test';
 for(const [qualityMode,expectedQuality,expectedSize] of [['standard','medium','auto'],['hd','high','2048x1536']]){
  const job={model:'gpt-image-2.6-sunburst',options:{...base,qualityMode},source_image:data};let called=0;
  const response=await editWithOpenAI(job,async(url,{body})=>{
   called++;assert.equal(url,'https://api.openai.com/v1/images/edits');assert.equal(body.get('quality'),expectedQuality);assert.equal(body.get('size'),expectedSize);
   assert.equal(body.get('output_compression'),qualityMode==='hd'?'92':null);
   return new Response(JSON.stringify({data:[{b64_json:data.toString('base64')}],usage:{input_tokens:500,output_tokens:2000}}));
  });
  assert.equal(called,1);assert.equal(response.usage.output_tokens,2000);assert.equal((await sharp(response.result).metadata()).format,'jpeg');
 }
});
