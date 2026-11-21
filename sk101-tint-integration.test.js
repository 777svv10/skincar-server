import test from 'node:test';
import assert from 'node:assert/strict';
import {optionsOf,cleanTint,tintInstructions,promptOf} from './generations.js';
import {cleanDraftOptions} from './drafts.js';

const base={mode:'builder',coatingType:'paint',color:'original',finish:'original',wheel:'original',qualityMode:'standard',plate:{mode:'keep'}};
test('SK-101: new four-zone color/chameleon/athermal and 10% VLT round-trip into generation options',()=>{
 const tint={
  windshield:{film:'colored',vlt:10,color:'red'},
  frontSides:{film:'chameleon',vlt:15,color:'yellow'},
  rearSides:{film:'athermal',vlt:90},
  rearWindshield:{film:'none'}
 };
 const normalized=optionsOf({...base,tint});
 assert.deepEqual(normalized.tint,tint);
 const draft=cleanDraftOptions({...base,custom:'',tint});
 assert.deepEqual(draft.tint,tint);
 const prompt=promptOf(normalized);
 assert.match(prompt,/windshield\/front windscreen: colored red tint, target visible-light transmission \(VLT\) approx 10%/);
 assert.match(prompt,/front side windows: chameleon iridescent tint with yellow reflective hue/);
 assert.match(prompt,/rear side windows: subtle athermal heat-control film/);
 assert.doesNotMatch(prompt,/rear windscreen: neutral dark tint/);
 assert.match(prompt,/Keep the remaining glass unchanged/);
});
test('SK-101: backward compatibility with legacy chameleon without tint color and 5% dark VLT',()=>{
 const old={windshield:{film:'chameleon',vlt:20},frontSides:{film:'dark',vlt:5},rearSides:{film:'none'}};
 assert.deepEqual(cleanTint(old),old);
 assert.match(tintInstructions(old),/windshield\/front windscreen: chameleon iridescent tint, target/);
});
test('SK-101: reject unsafe or malformed tint payloads',()=>{
 for(const tint of [
  {windshield:{film:'athermal',vlt:10,color:'red'}},
  {windshield:{film:'chameleon',vlt:35,color:'javascript:alert(1)'}},
  {frontSides:{film:'colored',vlt:12,color:'blue'}},
  {frontSides:{film:'colored',vlt:10,color:'fake'}},
  {rearSides:{film:'none',vlt:10}},
  {rearWindow:{film:'dark',vlt:10}}
 ])assert.throws(()=>cleanTint(tint),e=>e.code==='INVALID_TINT');
});
test('SK-101: no change to quality accounting or plate handling',()=>{
 assert.equal(optionsOf({...base,qualityMode:'hd',tint:{windshield:{film:'dark',vlt:5}}}).qualityMode,'hd');
 assert.deepEqual(optionsOf({...base,plate:{mode:'remove'}}).plate,{mode:'remove'});
});
