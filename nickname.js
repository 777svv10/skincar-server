const reserved = new Set(['admin','administrator','support','skincar','skincartuning','skincartuning_bot','moderator','official','system','help','telegram']);
export function normalizeNickname(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/^@/, '').toLowerCase();
  return /^[a-z0-9_]{3,24}$/.test(name) && !reserved.has(name) ? name : null;
}
export async function claimNickname(db, userId, value) {
  const nickname = normalizeNickname(value);
  if (!nickname) return {status:400, code:'INVALID_NICKNAME'};
  try {
    const {rows} = await db.query('UPDATE users SET nickname=$2,updated_at=now() WHERE telegram_id=$1 RETURNING *',[userId,nickname]);
    return {status:200,user:rows[0]};
  } catch (error) {
    if(error.code === '23505') return {status:409,code:'NICKNAME_TAKEN'};
    throw error;
  }
}

