// SK-008 server-only film reference registry. Default is empty: no fabricated catalogue items.
// Adding public Netlify packs alone cannot enable paid generation. Operators must also install
// verified assets here and explicitly approve SKUs via FILM_APPROVED_SKUS in Railway.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const directory=path.join(path.dirname(fileURLToPath(import.meta.url)),'film-packs');
const validId=s=>typeof s==='string'&&/^[a-z0-9][a-z0-9-]{1,63}$/.test(s);
const validAsset=s=>typeof s==='string'&&/^assets\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)*\.(?:webp|png|jpe?g)$/i.test(s)&&!s.includes('..');
export const isFilmSku=s=>typeof s==='string'&&s.length<=150&&s.split('/').length===2&&s.split('/').every(validId);
export const FILM_ZONES=Object.freeze(['full','hood','roof','mirrors','accents']);
function fail(code){return Object.assign(new Error(code),{status:409,code});}
function catalogue(){
 let index;try{index=JSON.parse(fs.readFileSync(path.join(directory,'index.json'),'utf8'));}catch{return new Map();}
 if(index?.schemaVersion!==1||!Array.isArray(index.packs)||index.packs.length>150)return new Map();
 const list=new Map();
 for(const p of index.packs){
  if(p?.active!==true||!validId(p.id))continue;
  let data;try{data=JSON.parse(fs.readFileSync(path.join(directory,p.id,'pack.json'),'utf8'));}catch{continue;}
  if(data?.schemaVersion!==1||data.id!==p.id||!Array.isArray(data.models)||data.models.length>5000)continue;
  for(const item of data.models){
   if(!validId(item?.id)||item.skuVerified!==true||item.imageRights!=='approved'||!validAsset(item.reference)||
      typeof item.sku!=='string'||!item.sku.trim()||item.sku.length>100||
      typeof item.name!=='string'||!item.name.trim()||item.name.length>160||
      !['vinyl','ppf'].includes(item.material)||!['gloss','matte','satin'].includes(item.finish)||
      !['solid','metallic','pearl','chrome','chameleon','carbon','texture'].includes(item.effect))continue;
   const sku=p.id+'/'+item.id;
   if(list.has(sku))continue;
   const file=path.join(directory,p.id,...item.reference.split('/'));
   try{
    // Real path must remain inside assets, even if filesystem contains symlinks.
    const trusted=fs.realpathSync(path.join(directory,p.id,'assets'));
    const resolved=fs.realpathSync(file);
    if(!resolved.startsWith(trusted+path.sep))continue;
    const stat=fs.statSync(resolved);
    if(!stat.isFile()||stat.size>8*1024*1024||stat.size<1024)continue;
    list.set(sku,{sku,manufacturerSku:item.sku,brand:p.brand,series:p.series,name:item.name,
      finish:item.finish,effect:item.effect,material:item.material,colorGroup:item.colorGroup,
      file:resolved,mime:/\.png$/i.test(resolved)?'image/png':/\.webp$/i.test(resolved)?'image/webp':'image/jpeg'});
   }catch{continue;}
  }
 }
 return list;
}
export function authorizeFilmSku(sku,config=process.env){
 if(!isFilmSku(sku))throw fail('FILM_NOT_APPROVED');
 const whitelist=typeof config.FILM_APPROVED_SKUS==='string'?config.FILM_APPROVED_SKUS.split(',').map(s=>s.trim()):[];
 if(!whitelist.includes(sku))throw fail('FILM_NOT_APPROVED');
 const record=catalogue().get(sku);
 if(!record)throw fail('FILM_NOT_APPROVED');
 return record;
}
export function loadFilmReference(sku,sha,config=process.env){
 const record=authorizeFilmSku(sku,config);
 const bytes=fs.readFileSync(record.file);
 const digest=createHash('sha256').update(bytes).digest('hex');
 if(digest!==sha)throw fail('FILM_REFERENCE_CHANGED');
 return {bytes,mime:record.mime};
}
export function filmReferenceHash(sku,config=process.env){
 const record=authorizeFilmSku(sku,config);
 return createHash('sha256').update(fs.readFileSync(record.file)).digest('hex');
}
