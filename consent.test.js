import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {recordConsent,verifyConsent,requireConsent,CONSENT_VERSION,CONSENT_TEXT} from './consent.js';
test('explicit versioned per-photo consent, owner and image binding, server timestamp',async()=>{
 const db=new PGlite();try{
 await db.exec(await readFile(new URL('./schema.sql',import.meta.url),'utf8'));
 await db.query("INSERT INTO users(telegram_id,display_name) VALUES(1,'One'),(2,'Two')");
 const vehicle=randomUUID(),source=Buffer.from('source'),data='data:image/jpeg;base64,'+source.toString('base64');
 await db.query('INSERT INTO vehicles(id,telegram_id,name,source_image) VALUES($1,1,$2,$3)',[vehicle,'Car',source]);
 for(const c of [undefined,{accepted:false,version:CONSENT_VERSION,lang:'ru'},{accepted:true,version:'old',lang:'ru'}])assert.throws(()=>requireConsent(c));
 const r=await recordConsent(db,1,vehicle,data,source,{accepted:true,version:CONSENT_VERSION,lang:'ru'});
 assert(r.accepted_at);await verifyConsent(db,1,r.id,vehicle,data,source);
 await assert.rejects(verifyConsent(db,2,r.id,vehicle,data,source));
 await assert.rejects(verifyConsent(db,1,r.id,randomUUID(),data,source));
 await assert.rejects(verifyConsent(db,1,r.id,vehicle,'data:image/jpeg;base64,bmV3',Buffer.from('new')));
 const row=(await db.query('SELECT * FROM photo_consents')).rows[0];assert.equal(row.text_snapshot,CONSENT_TEXT.ru);assert.equal(row.text_version,CONSENT_VERSION);assert.equal(row.accepted,true);
 }finally{await db.close();}
});
