const crypto = require('crypto');
const { pool } = require('./db');

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (error, key) => error ? reject(error) : resolve(`${salt}:${key.toString('hex')}`)));
}
async function validPassword(password, stored) {
  const [salt, expected] = stored.split(':');
  const actual = (await hashPassword(password, salt)).split(':')[1];
  return expected && crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}
function publicUser(user) {
  return { id: user.id, username: user.username, email: user.email, displayName: user.display_name, name: user.display_name, bio: user.bio || '', profilePhotoUrl: user.profile_photo_url || null, isAdmin: !!user.is_admin };
}
function cookies(request) { return Object.fromEntries((request.headers.cookie || '').split(';').filter(Boolean).map(item => { const [key, ...value] = item.trim().split('='); return [key, decodeURIComponent(value.join('='))]; })); }
async function currentUser(request) {
  const token = cookies(request).sc_session;
  if (!token) return null;
  const result = await pool.query('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>NOW()', [digest(token)]);
  return result.rows[0] || null;
}
async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,NOW()+INTERVAL '30 days')", [digest(token), userId]);
  return token;
}
function sessionCookie(token, expired = false) { return `sc_session=${expired ? '' : encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${expired ? 0 : 2592000}; SameSite=Lax${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`; }
module.exports = { pool, digest, hashPassword, validPassword, publicUser, currentUser, createSession, sessionCookie, cookies };
