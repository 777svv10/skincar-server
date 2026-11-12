import {randomUUID} from 'node:crypto';
import {COLORS, FINISHES, WHEELS, uuid, problem} from './generations.js';

export const DRAFT_RETENTION_DAYS=7;
export const DRAFT_MAX_PER_USER=20;

export function cleanDraftOptions(value){
 if(!value||typeof value!=='object'||Array.isArray(value))throw problem(400,'INVALID_DRAFT');
 const mode=value.mode==='free'?'free':value.mode==='builder'?'builder':null;
 if(!mode||!['paint','film'].includes(value.coatingType??'paint'))throw problem(400,'INVALID_DRAFT');
 const color=value.color??'original',finish=value.finish??'original',wheel=value.wheel??'original',custom=value.custom??'';
 if(!(Object.hasOwn(COLORS,color)||typeof color==='string'&&/^#[a-f0-9]{6}$/i.test(color))||!Object.hasOwn(FINISHES,finish)||!(wheel==='original'||Object.hasOwn(WHEELS,wheel))||typeof custom!=='string'||custom.length>1000)throw problem(400,'INVALID_DRAFT');
 return {mode,coatingType:value.coatingType??'paint',color,finish,wheel,custom,fromRepeat:!!value.fromRepeat};
}

export async function listDrafts(db,userId){
 const {rows}=await db.query(`SELECT d.id,d.vehicle_id AS "vehicleId",v.name AS "name",d.options,
  d.updated_at AS "updatedAt",(d.updated_at + interval '7 days') AS "expiresAt"
  FROM drafts d JOIN vehicles v ON v.id=d.vehicle_id AND v.telegram_id=d.telegram_id
  WHERE d.telegram_id=$1 AND d.updated_at>now()-interval '7 days'
  ORDER BY d.updated_at DESC LIMIT 20`,[userId]);
 return rows;
}

export async function saveDraft(db,userId,id,vehicleId,value){
 if(!uuid(id)||!uuid(vehicleId))throw problem(400,'INVALID_DRAFT');
 const options=cleanDraftOptions(value);
 const client=await db.connect();
 try{
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['drafts:'+userId]);
  const valid=(await client.query(`SELECT v.id FROM vehicles v WHERE v.id=$1 AND v.telegram_id=$2 AND
   EXISTS(SELECT 1 FROM photo_consents pc WHERE pc.vehicle_id=v.id AND pc.telegram_id=$2 AND pc.accepted=true)
   FOR UPDATE`,[vehicleId,userId])).rows[0];
  if(!valid)throw problem(403,'DRAFT_SOURCE_UNAVAILABLE');
  const old=(await client.query('SELECT id,vehicle_id,updated_at FROM drafts WHERE id=$1 AND telegram_id=$2 FOR UPDATE',[id,userId])).rows[0];
  if(old){
   if(String(old.vehicle_id)!==vehicleId)throw problem(409,'DRAFT_VEHICLE_MISMATCH');
   if(Date.now()-new Date(old.updated_at).getTime()>DRAFT_RETENTION_DAYS*86400000)throw problem(410,'DRAFT_EXPIRED');
  }else{
   const count=Number((await client.query("SELECT count(*) AS count FROM drafts WHERE telegram_id=$1 AND updated_at>now()-interval '7 days'",[userId])).rows[0].count);
   if(count>=DRAFT_MAX_PER_USER)throw problem(429,'DRAFT_LIMIT');
  }
  const {rows}=await client.query(`INSERT INTO drafts(id,telegram_id,vehicle_id,options) VALUES($1,$2,$3,$4)
    ON CONFLICT(id) DO UPDATE SET options=EXCLUDED.options,updated_at=now()
    WHERE drafts.telegram_id=EXCLUDED.telegram_id AND drafts.vehicle_id=EXCLUDED.vehicle_id
    RETURNING id,vehicle_id AS "vehicleId",options,updated_at AS "updatedAt",(updated_at + interval '7 days') AS "expiresAt"`,[id,userId,vehicleId,JSON.stringify(options)]);
  if(!rows.length)throw problem(403,'DRAFT_FORBIDDEN');
  await client.query('COMMIT');return rows[0];
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

async function deleteOrphanedSource(client,vehicleId,userId){
 // Never remove the original photo of a vehicle associated with any generation or another draft.
 const existing=(await client.query(`SELECT id FROM vehicles WHERE id=$1 AND telegram_id=$2 FOR UPDATE`,[vehicleId,userId])).rows[0];
 if(!existing)return;
 const inUse=(await client.query(`SELECT EXISTS(SELECT 1 FROM drafts WHERE vehicle_id=$1)
 OR EXISTS(SELECT 1 FROM generations WHERE telegram_id=$2 AND options->>'vehicleId'=$1::text) AS busy`,[vehicleId,userId])).rows[0]?.busy;
 if(inUse)return;
 await client.query('DELETE FROM photo_consents WHERE vehicle_id=$1 AND telegram_id=$2',[vehicleId,userId]);
 await client.query('DELETE FROM vehicles WHERE id=$1 AND telegram_id=$2',[vehicleId,userId]);
}

export async function deleteDraft(db,userId,id){
 if(!uuid(id))throw problem(400,'INVALID_DRAFT');
 const client=await db.connect();
 try{
  await client.query('BEGIN');
  const row=(await client.query('DELETE FROM drafts WHERE id=$1 AND telegram_id=$2 RETURNING vehicle_id',[id,userId])).rows[0];
  if(row)await deleteOrphanedSource(client,row.vehicle_id,userId);
  await client.query('COMMIT');return !!row;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

export async function cleanupExpiredDrafts(db){
 const c=await db.connect();
 try{
  await c.query('BEGIN');
  const expired=(await c.query("DELETE FROM drafts WHERE updated_at<=now()-interval '7 days' RETURNING vehicle_id,telegram_id")).rows;
  for(const d of expired)await deleteOrphanedSource(c,d.vehicle_id,d.telegram_id);
  await c.query('COMMIT');return expired.length;
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
