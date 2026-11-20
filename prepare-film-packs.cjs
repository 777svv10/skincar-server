// SK-091: deterministic, authenticated release asset unpacker for film-packs.
// Required so a GitHub web upload can transfer one binary archive instead of 306 nested files.
// No URLs, client-controlled paths or third-party runtime dependencies are used.
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const zlib=require('node:zlib');

const base=__dirname;
const file=path.join(base,'film-packs.bundle.tar.gz');
const target=path.join(base,'film-packs');
const EXPECTED_HASH='b7ad65d498b74dd253438c69ab54595ebdfea4a09bb33ff7f4c3edde47ce6677';
const PACK_COUNTS=Object.freeze({'vega-color-ppf':76,'vega-color-premium':41,'iristek-colors':34});
const packIds=Object.keys(PACK_COUNTS);
const fail=m=>{throw new Error('SK091 film assets: '+m)};
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const json=b=>JSON.parse(b.toString('utf8'));

if(!fs.existsSync(file))fail('film-packs.bundle.tar.gz missing — upload the root-only patch first');
const compressed=fs.readFileSync(file);
if(compressed.length>20*1024*1024)fail('bundle exceeds 20MiB');
if(digest(compressed)!==EXPECTED_HASH)fail('bundle SHA-256 mismatch');
try {
 const current=json(fs.readFileSync(path.join(target,'index.json')));
 if(fs.readFileSync(path.join(target,'.bundle.sha256'),'utf8')===EXPECTED_HASH &&
    Array.isArray(current.packs)&&current.packs.length===3&&
    current.packs.every(p=>p.active&&PACK_COUNTS[p.id])){
     console.log('SK091 film references ready (cached): 151');
     process.exit(0);
 }
}catch{}
const raw=zlib.gunzipSync(compressed,{maxOutputLength:32*1024*1024});
const contents=new Map();
for(let i=0;i+512<=raw.length;){
 const head=raw.subarray(i,i+512);
 if(head.every(b=>b===0))break;
 const name=head.subarray(0,100).toString('utf8').split('\0',1)[0];
 const type=String.fromCharCode(head[156]);
 const oct=head.subarray(124,136).toString('ascii').replace(/\0/g,'').trim();
 const length=parseInt(oct||'0',8);
 const allowed=/^film-packs\/(?:index\.json|(?:vega-color-ppf|vega-color-premium|iristek-colors)\/(?:pack\.json|assets\/(?:thumbs|references)\/[a-zA-Z0-9_.-]+\.webp))$/;
 if(!allowed.test(name)||contents.has(name))fail('unexpected or repeated path '+name);
 if(type!=='0'&&type!=='\0')fail('tar type not supported');
 if(!Number.isSafeInteger(length)||length<1||length>3*1024*1024)fail('invalid entry size');
 const pos=i+512;
 if(pos+length>raw.length)fail('truncated tar');
 const buf=raw.subarray(pos,pos+length);
 if(name.endsWith('.webp') && (buf.toString('ascii',0,4)!=='RIFF'||buf.toString('ascii',8,12)!=='WEBP'))fail('invalid WebP '+name);
 contents.set(name,buf);
 i=pos+Math.ceil(length/512)*512;
}
if(contents.size!==306)fail('expected 306 files, got '+contents.size);
const index=json(contents.get('film-packs/index.json'));
if(index.schemaVersion!==1||!Array.isArray(index.packs)||index.packs.length!==3)fail('index schema error');
let models=0;
for(const id of packIds){
 const registry=index.packs.find(p=>p.id===id && p.active===true);
 if(!registry)fail('missing active pack '+id);
 const pack=json(contents.get('film-packs/'+id+'/pack.json'));
 if(pack.id!==id || pack.schemaVersion!==1 || !Array.isArray(pack.models) || pack.models.length!==PACK_COUNTS[id])fail('invalid pack '+id);
 for(const m of pack.models){
  if(!m.id||!m.sku||!m.name||typeof m.reference!=='string'||typeof m.preview!=='string')fail('bad film metadata '+id);
  if(!contents.has('film-packs/'+id+'/'+m.reference)||!contents.has('film-packs/'+id+'/'+m.preview))fail('missing asset '+id+'/'+m.id);
  models++;
 }
}
if(models!==151)fail('expected 151 SKUs');
// SK-091.1: Never rename the film-packs directory itself. On Railway it can be
// a mounted volume, so moving it outside the mount causes EXDEV and crashes.
// Instead write a temporary file in *each destination directory* and rename
// within that same filesystem. The manifest is installed last; no cleanup of
// existing packs occurs, avoiding accidental loss of user/server assets.
fs.mkdirSync(target,{recursive:true});
function atomicWrite(rel,buf){
 const dest=path.join(target,...rel.split('/'));
 const dir=path.dirname(dest);
 fs.mkdirSync(dir,{recursive:true});
 const tmp=path.join(dir,'.'+path.basename(dest)+'.sk0911-'+crypto.randomUUID()+'.tmp');
 try{
  fs.writeFileSync(tmp,buf,{mode:0o644});
  fs.renameSync(tmp,dest); // Same destination directory / mount.
 }finally{
  try{fs.rmSync(tmp,{force:true});}catch{}
 }
}
try{
 for(const [name,buf] of contents){
  if(name==='film-packs/index.json')continue;
  atomicWrite(name.slice('film-packs/'.length),buf);
 }
 // Install index after all pack.json and WebP references have been written.
 atomicWrite('index.json',contents.get('film-packs/index.json'));
 atomicWrite('.bundle.sha256',Buffer.from(EXPECTED_HASH,'utf8'));
 console.log('SK091 film references ready: '+models+' models, '+contents.size+' files');
}catch(e){
 // Leave pre-existing content intact. The stamp is written only on success.
 fail('mount-safe install failed: '+e.message);
}
