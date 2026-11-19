import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {findSavedUpload} from './upload-status.js';
const vehicleId='b2dc1010-1e7c-4ca7-a4dd-14900d4ec680';
const photoId='202b8991-2384-4ea1-aeba-0300ab343515';
const telegramId=123456;
const photo=Buffer.from('server-stored-image');
const vehicle={id:vehicleId,name:'Test car',make:'BMW',model:'3 Series',source_image:photo};
const consent={id:'c90a5ed6-39c4-4759-84de-e780dad63d4f'};
const params=(id=vehicleId)=>({telegramId,vehicleId,photoId:id,consentVersion:'2026-11-11'});
function mockDb({hasVehicle=true,hasPhoto=true,hasConsent=true}={}){
 const queries=[];
 const db={async query(sql,values){
  queries.push({sql,values});
  if(sql.includes('FROM vehicles WHERE'))return {rows:hasVehicle?[vehicle]:[]};
  if(sql.includes('FROM vehicle_photos WHERE'))return {rows:hasPhoto?[{source_image:photo}]:[]};
  if(sql.includes('FROM photo_consents WHERE'))return {rows:hasConsent?[consent]:[]};
  throw Error('Unexpected SQL');
 }};
 return {db,queries};
}
test('SK-085 confirms a complete original upload',async()=>{
 const {db,queries}=mockDb();
 const result=await findSavedUpload(db,params());
 assert.equal(result.vehicle.id,vehicleId);
 assert.equal(result.vehicle.source_image,undefined,'do not return private image bytes');
 assert.equal(result.photo.id,vehicleId);
 assert.equal(result.consent.id,consent.id);
 assert.deepEqual(queries[0].values,[vehicleId,telegramId]);
 assert.deepEqual(queries[1].values,[telegramId,vehicleId,createHash('sha256').update(photo).digest('hex'),'2026-11-11']);
});
test('SK-085 confirms only the selected photo within its car and owner',async()=>{
 const {db,queries}=mockDb();
 const result=await findSavedUpload(db,params(photoId));
 assert.equal(result.photo.id,photoId);
 assert.deepEqual(queries[1].values,[photoId,vehicleId,telegramId]);
});
test('SK-085 returns pending on missing or unauthorized vehicle',async()=>{
 const {db,queries}=mockDb({hasVehicle:false});
 assert.equal(await findSavedUpload(db,params()),null);
 assert.equal(queries.length,1,'must not query images for another account');
});
test('SK-085 returns pending when the requested additional photo does not exist',async()=>{
 const {db,queries}=mockDb({hasPhoto:false});
 assert.equal(await findSavedUpload(db,params(photoId)),null);
 assert.equal(queries.length,2,'must not confirm an absent photo');
});
test('SK-085 does not confirm a photo before consent is recorded',async()=>{
 const {db}=mockDb({hasConsent:false});
 assert.equal(await findSavedUpload(db,params()),null);
});
