// Unpacks verified bundled wheel references before the SkinCar server starts.
// The payload is a local release artifact. The client cannot provide paths or URLs.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const base = __dirname;
const target = path.join(base, 'wheel-references');
const bundlePath = path.join(base, 'wheel-references.tar.gz');
function fail(message){throw new Error('SK065 wheel assets: '+message)}
const compressed = fs.readFileSync(bundlePath);
if(compressed.length > 25*1024*1024) fail('bundle exceeds 25 MiB');
const tar = zlib.gunzipSync(compressed, { maxOutputLength: 35*1024*1024 });
const contents = new Map();
for(let i=0; i+512<=tar.length;){
 const block = tar.subarray(i,i+512);
 if(block.every(b=>b===0)) break;
 const name=block.subarray(0,100).toString('utf8').split('\0',1)[0];
 const type=String.fromCharCode(block[156]);
 const n=block.subarray(124,136).toString('ascii').replace(/\0/g,'').trim();
 const length=parseInt(n||'0',8);
 if(!Number.isSafeInteger(length)||length<0||length>2*1024*1024) fail('invalid member size');
 if(type!=='0'&&type!=='\0') fail('unsupported tar member');
 if(!/^([a-z0-9-]+\.jpg|manifest\.json)$/.test(name)||contents.has(name)) fail('unexpected or duplicate path '+name);
 const offset=i+512;
 if(offset+length>tar.length) fail('truncated member');
 contents.set(name,tar.subarray(offset,offset+length));
 i=offset+Math.ceil(length/512)*512;
}
const raw=contents.get('manifest.json');
if(!raw) fail('manifest missing');
const manifest=JSON.parse(raw.toString('utf8'));
if(manifest.schemaVersion!==1||!Array.isArray(manifest.models)||manifest.models.length!==107) fail('wrong manifest version or count');
const approved=new Set();
for(const item of manifest.models){
 if(typeof item.sku!=='string'||approved.has(item.sku)) fail('duplicate or invalid SKU');
 approved.add(item.sku);
 const buf=contents.get(item.asset);
 if(!buf||!/^([a-z0-9-]+)\.jpg$/.test(item.asset)) fail('missing reference '+item.asset);
 if(buf.length>2*1024*1024||crypto.createHash('sha256').update(buf).digest('hex')!==item.sha256) fail('SHA mismatch '+item.asset);
}
if(contents.size!==manifest.models.length+1) fail('unexpected wheel files');
const stamp=crypto.createHash('sha256').update(compressed).digest('hex');
try{
 if(fs.readFileSync(path.join(target,'.pack.sha256'),'utf8')===stamp) {
  const check=fs.readFileSync(path.join(target,'manifest.json'),'utf8');
  if(check===raw.toString('utf8')) { console.log('SK065 wheel bundle verified (cached)'); process.exit(0); }
 }
}catch{}
const temp=path.join(base,`.wheel-ref-extract-${process.pid}`);
fs.rmSync(temp,{recursive:true,force:true});
fs.mkdirSync(temp,{recursive:true});
try{
 for(const [name,buf] of contents)fs.writeFileSync(path.join(temp,name),buf,{mode:0o644});
 fs.writeFileSync(path.join(temp,'.pack.sha256'),stamp);
 fs.rmSync(target,{recursive:true,force:true});
 fs.renameSync(temp,target);
 console.log(`SK065 wheel references ready: ${manifest.models.length} models`);
}catch(e){fs.rmSync(temp,{recursive:true,force:true});throw e}
