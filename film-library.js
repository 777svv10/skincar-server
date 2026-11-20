// SK-089: Explicit public_beta enables all authenticated testers without falsely
// declaring owner-supplied film reference metadata or image rights verified.
// Real commercial live continues to require independently approved rights and SKU allowlist.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const directory=path.join(path.dirname(fileURLToPath(import.meta.url)),'film-packs');
const validId=s=>typeof s==='string'&&/^[a-z0-9][a-z0-9-]{1,63}$/.test(s);
const validAsset=s=>typeof s==='string'&&/^assets\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)*\.(?:webp|png|jpe?g)$/i.test(s)&&!s.includes('..');
const csv=s=>new Set(String(s||'').split(',').map(v=>v.trim()).filter(Boolean));
export const isFilmSku=s=>typeof s==='string'&&s.length<=150&&s.split('/').length===2&&s.split('/').every(validId);
export const FILM_ZONES=Object.freeze(['full','hood','roof','mirrors','accents']);
function fail(code,status=409){return Object.assign(new Error(code),{status,code});}
function catalogue(){
 let index;try{index=JSON.parse(fs.readFileSync(path.join(directory,'index.json'),'utf8'));}catch{return new Map();}
 if(index?.schemaVersion!==1||!Array.isArray(index.packs)||index.packs.length>150)return new Map();
 const list=new Map();
 for(const p of index.packs){
  if(p?.active!==true||!validId(p.id))continue;
  let data;try{data=JSON.parse(fs.readFileSync(path.join(directory,p.id,'pack.json'),'utf8'));}catch{continue;}
  if(data?.schemaVersion!==1||data.id!==p.id||!Array.isArray(data.models)||data.models.length>5000)continue;
  for(const item of data.models){
   if(!validId(item?.id)||!validAsset(item.reference)||
     typeof item.sku!=='string'||!item.sku.trim()||item.sku.length>100||
     typeof item.name!=='string'||!item.name.trim()||item.name.length>160||
     !['vinyl','ppf'].includes(item.material)||!['gloss','matte','satin'].includes(item.finish)||
     !['solid','metallic','pearl','chrome','chameleon','carbon','texture'].includes(item.effect))continue;
   const sku=p.id+'/'+item.id;
   if(list.has(sku))continue;
   const file=path.join(directory,p.id,...item.reference.split('/'));
   try{
    const trusted=fs.realpathSync(path.join(directory,p.id,'assets'));
    const resolved=fs.realpathSync(file);
    if(!resolved.startsWith(trusted+path.sep))continue;
    const stat=fs.statSync(resolved);
    if(!stat.isFile()||stat.size>8*1024*1024||stat.size<1024)continue;
    list.set(sku,{sku,manufacturerSku:item.sku,brand:p.brand,series:p.series,name:item.name,
      finish:item.finish,effect:item.effect,material:item.material,colorGroup:item.colorGroup,
      skuVerified:item.skuVerified===true,imageRights:item.imageRights,
      file:resolved,mime:/\.png$/i.test(resolved)?'image/png':/\.webp$/i.test(resolved)?'image/webp':'image/jpeg'});
   }catch{continue;}
  }
 }
 return list;
}
export function filmAccess(config=process.env,userId){
 // Explicit public_beta permits all authenticated users to test owner-provided
 // unverified references without claiming that provenance or image rights are cleared.
 const mode=['off','pilot','public_beta','live'].includes(config.FILM_GENERATION_MODE)?config.FILM_GENERATION_MODE:'off';
 const testers=csv(config.FILM_PILOT_TESTER_IDS);
 const allowlist=csv(config.FILM_APPROVED_SKUS);
 const allowed=mode==='public_beta'||mode==='live'||(mode==='pilot'&&testers.has(String(userId)));
 const entries=allowed?[...catalogue().values()]:[];
 const availableSkus=entries.filter(r=>{
  if(allowlist.size>0&&!allowlist.has(r.sku))return false;
  // Commercial live has a strict rights + SKU verification gate AND an explicit SKU allowlist.
  if(mode==='live')return allowlist.has(r.sku)&&r.skuVerified===true&&r.imageRights==='approved';
  return true; // Public beta or individually authorized pilot; references remain unverified.
 }).map(r=>r.sku);
 return {mode,availableSkus};
}
export function authorizeFilmSku(sku,config=process.env,userId){
 if(!isFilmSku(sku))throw fail('FILM_NOT_APPROVED');
 const state=filmAccess(config,userId);
 if(state.mode==='off')throw fail('FILM_GENERATION_DISABLED',503);
 if(!state.availableSkus.includes(sku))throw fail('FILM_NOT_APPROVED');
 const record=catalogue().get(sku);
 if(!record)throw fail('FILM_NOT_APPROVED');
 return record;
}
export function loadFilmReference(sku,sha,config=process.env,userId){
 const record=authorizeFilmSku(sku,config,userId);
 const bytes=fs.readFileSync(record.file);
 const digest=createHash('sha256').update(bytes).digest('hex');
 if(digest!==sha)throw fail('FILM_REFERENCE_CHANGED');
 return {bytes,mime:record.mime};
}
export function filmReferenceHash(sku,config=process.env,userId){
 const record=authorizeFilmSku(sku,config,userId);
 return createHash('sha256').update(fs.readFileSync(record.file)).digest('hex');
}
