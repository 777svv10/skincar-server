import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {editWithOpenAI,admitFilmOptions,admitWheelOptions,optionsOf,creditCostFor,promptOf} from './generations.js';
import {wheelRecord,ALL_WHEEL_SKUS} from './wheel-library.js';

const id='987654321';
const filmSku='iristek-colors/orh2p';
const wheelSku=ALL_WHEEL_SKUS[0];
const config={FILM_GENERATION_MODE:'public_beta',WHEEL_GENERATION_MODE:'pilot',WHEEL_PILOT_TESTER_IDS:id,WHEEL_APPROVED_SKUS:wheelSku};

test('SK-088: combination film + wheels + tint + plate removal is sent in correct image order; HD costs 3', async()=>{
 const base={mode:'builder',coatingType:'film',filmSku,filmZone:'full',color:'original',finish:'original',wheel:'original',wheelSku,qualityMode:'hd',tint:{frontSides:{film:'chameleon',vlt:5},rearSides:{film:'chameleon',vlt:5},rearWindshield:{film:'chameleon',vlt:5}},plate:{mode:'remove'}};
 const options=admitFilmOptions(admitWheelOptions(optionsOf(base),config,id),config,id);
 assert.equal(creditCostFor(options),3);
 const prompt=promptOf(options);
 assert.match(prompt,/IMAGE 3 is the film visual reference/);
 assert.match(prompt,/IMAGE 2 is a reference/);
 assert.match(prompt,/Remove only the physical license/);
 assert.match(prompt,/5%/);
 const source=await sharp({create:{width:640,height:480,channels:3,background:'white'}}).jpeg().toBuffer();
 const replyImage=source.toString('base64');
 let captured=null;
 Object.assign(process.env,config);
 const result=await editWithOpenAI({source_image:source,telegram_id:id,options,model:'gpt-image-2.5-sunburst'},async (url,req)=>{
  assert.equal(url,'https://api.openai.com/v1/images/edits');
  captured=req.body;
  return new Response(JSON.stringify({data:[{b64_json:replyImage}]}),{status:200,headers:{'Content-Type':'application/json'}});
 });
 assert.ok(result.result.length>1000);
 const images=captured.getAll('image[]');
 assert.equal(images.length,3);
 assert.deepEqual(images.map(x=>x.name),['car.jpg','wheel-reference.jpg','film-reference.webp']);
 assert.equal(captured.get('quality'),'high');
 assert.ok(captured.get('prompt').includes('5%'));
});
