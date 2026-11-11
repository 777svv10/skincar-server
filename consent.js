import {createHash,randomUUID} from 'node:crypto';
export const CONSENT_VERSION='photo-2026-11-11-v1';
export const LEGAL_VERSION='2026-11-11-draft2';
export const CONSENT_TEXT={
ru:'Подтверждаю, что имею право использовать загруженную фотографию, и соглашаюсь на её обработку для создания проекта SkinCar.',
en:'I confirm that I have the right to use the uploaded photograph and consent to its processing to create a SkinCar project.',
kk:'Жүктелген фотосуретті пайдалануға құқығым бар екенін растаймын және SkinCar жобасын жасау үшін оны өңдеуге келісемін.'};
const hash=b=>createHash('sha256').update(b).digest('hex');
export function imageHashes(data,source){return [hash(Buffer.from(data.split(',')[1],'base64')),hash(source)];}
export function requireConsent(c){if(c?.accepted!==true||c.version!==CONSENT_VERSION||!Object.hasOwn(CONSENT_TEXT,c.lang))throw Object.assign(Error('PHOTO_CONSENT_REQUIRED'),{status:400,code:'PHOTO_CONSENT_REQUIRED'});}
export async function recordConsent(db,userId,vehicleId,data,source,c){
 requireConsent(c);const [inputHash,sourceHash]=imageHashes(data,source);
 const r=await db.query(`INSERT INTO photo_consents(id,telegram_id,vehicle_id,input_hash,source_hash,text_version,text_snapshot,language,privacy_version,terms_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING id,accepted_at`,[randomUUID(),userId,vehicleId,inputHash,sourceHash,CONSENT_VERSION,CONSENT_TEXT[c.lang],c.lang,LEGAL_VERSION]);return r.rows[0];
}
export async function verifyConsent(db,userId,id,vehicleId,data,source){
 const [inputHash,sourceHash]=imageHashes(data,source);
 const r=await db.query(`SELECT id FROM photo_consents WHERE id=$1 AND telegram_id=$2 AND vehicle_id=$3 AND text_version=$4 AND (input_hash=$5 OR source_hash=$5 OR source_hash=$6)`,[id,userId,vehicleId,CONSENT_VERSION,inputHash,sourceHash]);
 if(!r.rows.length)throw Object.assign(Error('PHOTO_CONSENT_REQUIRED'),{status:400,code:'PHOTO_CONSENT_REQUIRED'});
}
