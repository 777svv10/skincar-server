// SK-085: idempotent upload confirmation after the client loses the HTTP response.
// Keep this read-only and scoped to the authenticated Telegram account.
import {createHash} from 'node:crypto';
const hash=(data)=>createHash('sha256').update(data).digest('hex');
export async function findSavedUpload(db,{telegramId,vehicleId,photoId,consentVersion}){
  const vehicle=(await db.query(
    'SELECT id,name,make,model,generation,modification,nickname,source_image FROM vehicles WHERE id=$1 AND telegram_id=$2',
    [vehicleId,telegramId]
  )).rows[0];
  if(!vehicle)return null;
  const source=photoId===vehicleId?vehicle.source_image:(await db.query(
    'SELECT source_image FROM vehicle_photos WHERE id=$1 AND vehicle_id=$2 AND telegram_id=$3',
    [photoId,vehicleId,telegramId]
  )).rows[0]?.source_image;
  if(!source)return null;
  const consent=(await db.query(
    'SELECT id FROM photo_consents WHERE telegram_id=$1 AND vehicle_id=$2 AND source_hash=$3 AND text_version=$4 ORDER BY accepted_at DESC LIMIT 1',
    [telegramId,vehicleId,hash(source),consentVersion]
  )).rows[0];
  if(!consent)return null;
  const {source_image,...safeVehicle}=vehicle;
  return {vehicle:safeVehicle,photo:{id:photoId},consent};
}
