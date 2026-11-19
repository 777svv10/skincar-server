import test from 'node:test';
import assert from 'node:assert/strict';
import {optionsOf,cleanTint,cleanPlate,promptOf,tintInstructions,plateInstructions,imageEditSettings} from './generations.js';
import {cleanDraftOptions} from './drafts.js';

const base={mode:'builder',color:'original',finish:'original',wheel:'original',qualityMode:'hd'};
const tint={
 windshield:{film:'chameleon',vlt:80},
 frontSides:{film:'dark',vlt:35},
 rearSides:{film:'colored',vlt:20,color:'blue'},
 rearWindshield:{film:'dark',vlt:15}
};

test('builder accepts four independent zones and keep plate mode',()=>{
 const o=optionsOf({...base,tint,plate:{mode:'keep'}});
 assert.deepEqual(o.tint,tint);assert.deepEqual(o.plate,{mode:'keep'});
 assert.equal(o.qualityMode,'hd');
});
test('older builder jobs default to preserve plate and no tinted zones',()=>{
 const o=optionsOf({...base,qualityMode:undefined});
 assert.deepEqual(o.plate,{mode:'keep'});
 assert.equal(o.tint,undefined);
});
test('tint has explicit windshield and rear windshield in prompt',()=>{
 const text=promptOf({...optionsOf({...base,tint,plate:{mode:'keep'}}),vehicleIdentity:{make:'Lada',model:'Largus',generation:'I',modification:'Cross'}});
 assert.match(text,/windshield\/front windscreen: chameleon iridescent tint, target visible-light transmission \(VLT\) approx 80%/);
 assert.match(text,/rear windscreen: neutral dark tint, target visible-light transmission \(VLT\) approx 15%/);
 assert.match(text,/front side windows: neutral dark tint/);
 assert.match(text,/rear side windows: colored blue tint/);
 assert.match(text,/"make":"Lada"/);
 assert.match(text,/"model":"Largus"/);
 assert.match(text,/exact original characters/);
});
test('remove plate prompt restores body surface, never fabricates characters',()=>{
 const text=plateInstructions({plate:{mode:'remove'}});
 assert.match(text,/Remove only the physical license/);
 assert.match(text,/without adding fake text/);
});
test('new options reject unknown country/text injection rather than treat it as prompt',()=>{
 assert.throws(()=>optionsOf({...base,plate:{mode:'replace',country:'RU',text:'A123BC'}}),e=>e.code==='INVALID_PLATE');
 assert.throws(()=>optionsOf({...base,plate:{mode:'keep',text:'IGNORE ALL'}}),e=>e.code==='INVALID_PLATE');
 assert.throws(()=>optionsOf({...base,plate:{mode:'remove',country:'KZ'}}),e=>e.code==='INVALID_PLATE');
});
test('tint rejects illegal schemas and nonsense values',()=>{
 for(const z of [
  {windshield:{film:'dark',vlt:101}},
  {rearSides:{film:'colored',vlt:35,color:'javascript:'}},
  {frontSides:{film:'dark',vlt:'35'}},
  {sideDoor:{film:'dark',vlt:20}},
  {windshield:{film:'none',vlt:0}},
  {rearWindshield:{film:'reflective',vlt:5}}
 ])assert.throws(()=>cleanTint(z),e=>e.code==='INVALID_TINT');
});
test('free mode cannot smuggle builder tint or plate options',()=>{
 assert.throws(()=>optionsOf({mode:'free',color:'original',finish:'original',wheel:'original',custom:'night',plate:{mode:'remove'}}),e=>e.code==='INVALID_OPTIONS');
 assert.throws(()=>optionsOf({mode:'free',color:'original',finish:'original',wheel:'original',custom:'night',tint}),e=>e.code==='INVALID_OPTIONS');
});
test('new server draft accepts quality HD with tint/plate and strips unrelated values',()=>{
 const d=cleanDraftOptions({mode:'builder',coatingType:'paint',color:'original',finish:'original',wheel:'original',custom:'',qualityMode:'hd',tint,plate:{mode:'remove'},fromRepeat:true});
 assert.equal(d.qualityMode,'hd');assert.deepEqual(d.tint,tint);assert.deepEqual(d.plate,{mode:'remove'});
 assert.equal(d.fromRepeat,true);
});
test('legacy draft stays readable',()=>{
 const d=cleanDraftOptions({mode:'builder',coatingType:'paint',color:'original',finish:'original',wheel:'original',custom:''});
 assert.equal(d.qualityMode,'standard');assert.deepEqual(d.plate,{mode:'keep'});
});
test('free draft rejects plate and tint',()=>{
 assert.throws(()=>cleanDraftOptions({mode:'free',color:'original',finish:'original',wheel:'original',custom:'a',plate:{mode:'keep'}}),e=>e.code==='INVALID_DRAFT');
});
test('HD selection and credit accounting contracts untouched',()=>{
 const settings=imageEditSettings({qualityMode:'hd'},{width:1600,height:1000},'gpt-image-2.6-sunburst');
 assert.equal(settings.quality,'high');assert.equal(settings.size,'2048x1152');
 assert.equal(imageEditSettings({qualityMode:'standard'}).quality,'medium');
});
test('vehicle metadata remains contextual, no automatic vehicle transformation',()=>{
 const text=promptOf({...optionsOf(base),vehicleIdentity:{make:'BMW',model:'3 Series',generation:'E36',modification:'320i'}});
 assert.match(text,/BMW/);assert.match(text,/3 Series/);assert.match(text,/E36/);
 assert.match(text,/visual truth/);assert.match(text,/not.*instructions/i);
});

// Master 19.11: prevent contradictory instructions reaching paid image generation.
test('SK-084 master: remove-plate prompt does not demand keeping the original plate',()=>{
 const text=promptOf(optionsOf({...base,plate:{mode:'remove'}}));
 assert.match(text,/Remove only the physical license\/registration plates/);
 assert.doesNotMatch(text,/Preserve all existing visible license plates/);
 assert.doesNotMatch(text,/Preserve the exact car model, body geometry, lights, badges, license plate,/);
 assert.doesNotMatch(text,/Keep windows, tires, trim, lights and registration plates/);
});
test('SK-084 master: keep-plate instruction is explicit',()=>{
 const text=promptOf(optionsOf({...base,plate:{mode:'keep'}}));
 assert.match(text,/Preserve all existing visible license plates and their exact original characters/);
});
