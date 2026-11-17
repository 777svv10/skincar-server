// SK-065: server-owned allowlisted wheel references (never external URLs from the browser).
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,resolve,basename} from 'node:path';
const directory=dirname(fileURLToPath(import.meta.url));
const root=resolve(directory,'wheel-references');
const manifest=JSON.parse(readFileSync(resolve(root,'manifest.json'),'utf8'));
if(manifest.schemaVersion!==1||!Array.isArray(manifest.models))throw Error('Invalid wheel reference manifest');
const modelMap=new Map();
const skuPattern=/^(bmw-oem|vossen|bbs)\/[a-z0-9][a-z0-9-]{0,79}$/;
for(const item of manifest.models){
 if(!item||!skuPattern.test(item.sku)||!/^([a-z0-9-]+)\.jpg$/.test(item.asset)||basename(item.asset)!==item.asset||!(/^[a-f0-9]{64}$/.test(item.sha256))||typeof item.name!=='string'||modelMap.has(item.sku))throw Error('Unsafe or duplicate wheel record');
 modelMap.set(item.sku,Object.freeze({...item}));
}
export const ALL_WHEEL_SKUS=Object.freeze([...modelMap.keys()]);
export const WHEEL_MANIFEST_REVISION=manifest.manifestRevision;
export function isWheelSku(value){return typeof value==='string'&&skuPattern.test(value)&&modelMap.has(value);}
export function wheelRecord(sku){return modelMap.get(sku)||null;}
const csv=s=>new Set(String(s||'').split(',').map(v=>v.trim()).filter(Boolean));
export function wheelAccess(config=process.env,userId){
 const mode=['pilot','live'].includes(config.WHEEL_GENERATION_MODE)?config.WHEEL_GENERATION_MODE:'off';
 const approved=csv(config.WHEEL_APPROVED_SKUS); // explicit SKU allowlist only, no wildcards
 const testers=csv(config.WHEEL_PILOT_TESTER_IDS);
 const userAllowed=mode==='live'||(mode==='pilot'&&testers.has(String(userId)));
 return {mode,availableSkus:userAllowed?ALL_WHEEL_SKUS.filter(sku=>approved.has(sku)):[],manifestRevision:WHEEL_MANIFEST_REVISION};
}
export function wheelProblem(status,code){return Object.assign(new Error(code),{status,code});}
export function authorizeWheelSku(sku,config=process.env,userId){
 if(!isWheelSku(sku))throw wheelProblem(400,'WHEEL_NOT_FOUND');
 const status=wheelAccess(config,userId);
 if(status.mode==='off')throw wheelProblem(503,'WHEEL_GENERATION_DISABLED');
 if(!status.availableSkus.includes(sku))throw wheelProblem(403,'WHEEL_NOT_APPROVED');
 return wheelRecord(sku);
}
export function loadWheelReference(sku,expectedHash){
 const record=wheelRecord(sku);
 if(!record)throw wheelProblem(400,'WHEEL_NOT_FOUND');
 if(typeof expectedHash!=='string'||expectedHash!==record.sha256)throw wheelProblem(409,'WHEEL_REFERENCE_CHANGED');
 const path=resolve(root,record.asset);
 if(!path.startsWith(root+'/'))throw wheelProblem(500,'WHEEL_REFERENCE_UNAVAILABLE');
 let bytes;
 try{bytes=readFileSync(path);}catch{throw wheelProblem(503,'WHEEL_REFERENCE_UNAVAILABLE');}
 if(createHash('sha256').update(bytes).digest('hex')!==expectedHash||bytes.length>2*1024*1024)throw wheelProblem(503,'WHEEL_REFERENCE_UNAVAILABLE');
 return {bytes,mime:'image/jpeg',name:record.name,brand:record.brand,sku};
}
