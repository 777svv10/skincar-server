import test from 'node:test';
import assert from 'node:assert/strict';
import {vehicleMetadata,vehicleView} from './vehicle-metadata.js';

test('new vehicle has separate make, model, generation, modification, nickname',()=>{
 const v=vehicleMetadata({metadata:{make:' BMW ',model:' 3 Series ',generation:' E36 ',modification:'320i',nickname:'My Drift Car'}});
 assert.deepEqual(v,{make:'BMW',model:'3 Series',generation:'E36',modification:'320i',nickname:'My Drift Car',name:'BMW 3 Series E36'});
});
test('same name does not generate identity; IDs come from owner-provided validated UUID',()=>{
 const a=vehicleMetadata({metadata:{make:'BMW',model:'3 Series',generation:'E36'}}),b=vehicleMetadata({metadata:{make:'BMW',model:'3 Series',generation:'E36'}});
 assert.equal(a.name,b.name);assert.equal(Object.hasOwn(a,'id'),false);
});
test('optional metadata can be empty',()=>{
 const v=vehicleMetadata({metadata:{make:'Lada',model:'Granta',generation:'',modification:'',nickname:''}});
 assert.equal(v.generation,null);assert.equal(v.modification,null);assert.equal(v.nickname,null);
});
test('legacy saved cars remain valid',()=>{
 const v=vehicleMetadata({name:'BMW E36'},{allowLegacy:true});
 assert.equal(v.name,'BMW E36');assert.equal(v.make,null);
});
test('reject missing make/model',()=>{
 for(const m of [{make:'BMW'},{model:'3 Series'},{}])assert.throws(()=>vehicleMetadata({metadata:m}),{code:'INVALID_VEHICLE_METADATA'});
});
test('reject dangerous tags and excessive lengths',()=>{
 for(const m of [{make:'<img>',model:'3 Series'},{make:'A'.repeat(49),model:'3 Series'},{make:'BMW',model:'\u0001'}])assert.throws(()=>vehicleMetadata({metadata:m}),{code:'INVALID_VEHICLE_METADATA'});
});
test('view returns stable uuid and server metadata for display',()=>{
 assert.deepEqual(vehicleView({id:'aaa',name:'BMW E36',make:'BMW',model:'3 Series',generation:'E36',modification:null,nickname:null,photo_count:'2'}),{id:'aaa',name:'BMW E36',make:'BMW',model:'3 Series',generation:'E36',modification:null,nickname:null,created_at:undefined,photoCount:2});
});
