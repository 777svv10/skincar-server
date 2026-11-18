// SK-078: structured metadata, never use a car name as an identity key.
// A vehicle's UUID is immutable, while labels and aliases may coincide.
const field=(v,max,required=false)=>{
  if(v==null||v===''){if(required)throw invalid();return null;}
  if(typeof v!=='string')throw invalid();
  const s=v.trim().replace(/\s+/gu,' ');
  if(s.length<1||s.length>max||/[\x00-\x1f\x7f<>]/.test(s))throw invalid();
  return s;
};
const invalid=()=>Object.assign(new Error('INVALID_VEHICLE_METADATA'),{status:400,code:'INVALID_VEHICLE_METADATA'});
export function vehicleMetadata(data,{allowLegacy=false}={}){
  if(data&&typeof data==='object'&&data.metadata!=null){
    const m=data.metadata;
    if(!m||typeof m!=='object'||Array.isArray(m)||Object.keys(m).some(k=>!['make','model','generation','modification','nickname'].includes(k)))throw invalid();
    const make=field(m.make,48,true),model=field(m.model,64,true);
    const generation=field(m.generation,48),modification=field(m.modification,64),nickname=field(m.nickname,48);
    const name=[make,model,generation].filter(Boolean).join(' ').slice(0,80);
    return {make,model,generation,modification,nickname,name};
  }
  if(!allowLegacy)throw invalid();
  const name=field(data?.name,80,true);
  if(name.length<2)throw invalid();
  return {make:null,model:null,generation:null,modification:null,nickname:null,name};
}
export function vehicleView(v){
  return {id:v.id,name:v.name,make:v.make||null,model:v.model||null,generation:v.generation||null,modification:v.modification||null,nickname:v.nickname||null,created_at:v.created_at,photoCount:Number(v.photo_count||1)};
}
