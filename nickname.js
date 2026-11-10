const reserved = new Set(['admin','administrator','support','skincar','skincartuning','skincartuning_bot','moderator','official','system','help','telegram']);
export function normalizeNickname(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/^@/, '').toLowerCase();
  return /^[a-z0-9_]{3,24}$/.test(name) && !reserved.has(name) ? name : null;
}
export async function nicknameQuota(db,userId){
 const r=await db.query("SELECT changed_at FROM nickname_changes WHERE telegram_id=$1 AND changed_at>now()-interval '30 days' ORDER BY changed_at",[userId]);
 return {remaining:Math.max(0,2-r.rows.length),nextAllowedAt:r.rows.length>=2?new Date(new Date(r.rows[0].changed_at).getTime()+30*86400000).toISOString():null};
}
export async function claimNickname(db,userId,value){
 const nickname=normalizeNickname(value);if(!nickname)return {status:400,code:'INVALID_NICKNAME'};
 const c=await db.connect();try{
  await c.query('BEGIN');const u=(await c.query('SELECT * FROM users WHERE telegram_id=$1 FOR UPDATE',[userId])).rows[0];
  if(!u){await c.query('ROLLBACK');return {status:404,code:'USER_NOT_FOUND'};}
  let quota=await nicknameQuota(c,userId);
  if(u.nickname===nickname){await c.query('COMMIT');return {status:200,user:u,quota};}
  if(u.nickname&&quota.remaining===0){await c.query('ROLLBACK');return {status:429,code:'NICKNAME_LIMIT',quota};}
  const {rows}=await c.query('UPDATE users SET nickname=$2,updated_at=now() WHERE telegram_id=$1 RETURNING *',[userId,nickname]);
  if(u.nickname)await c.query('INSERT INTO nickname_changes(telegram_id) VALUES($1)',[userId]);
  quota=await nicknameQuota(c,userId);await c.query('COMMIT');return {status:200,user:rows[0],quota};
 }catch(e){await c.query('ROLLBACK');if(e.code==='23505')return {status:409,code:'NICKNAME_TAKEN'};throw e;}finally{c.release();}
}
