const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { pool, hashPassword, validPassword, publicUser, currentUser, createSession, sessionCookie } = require('./auth');
const { ok, fail } = require('./response');

/* ---------------------------------------------------------------------------
   REALTIME SOCKET REGISTRY

   This used to live in src/realtime.js and was imported through a try/catch in
   BOTH server.js and here. When that one file was missing from a deploy, both
   imports threw, addClient/notifyUser silently became no-ops, and every realtime
   feature died without a single error: sockets still connected and received
   realtime:ready, but nothing was ever pushed. That is exactly what broke live
   message delivery and incoming calls in production.

   It now lives in this file and is exported, so there is no separate file whose
   absence can disable realtime, and no silent fallback. src/realtime.js is no
   longer imported by anything.
--------------------------------------------------------------------------- */
const socketsByUser = new Map();
function addClient(userId, socket) {
  const key = Number(userId);
  if (!socketsByUser.has(key)) socketsByUser.set(key, new Set());
  socketsByUser.get(key).add(socket);
  socket.on('close', () => {
    const set = socketsByUser.get(key);
    if (!set) return;
    set.delete(socket);
    if (!set.size) socketsByUser.delete(key);
  });
}
function notifyUser(userId, event, data) {
  const set = socketsByUser.get(Number(userId));
  if (!set) return false;
  const payload = JSON.stringify({ event, data });
  let delivered = 0;
  set.forEach(socket => { if (socket.readyState === 1) { socket.send(payload); delivered++; } });
  return delivered > 0;
}
function isUserOnline(userId) {
  const set = socketsByUser.get(Number(userId));
  if (!set) return false;
  for (const socket of set) if (socket.readyState === 1) return true;
  return false;
}

const upload = multer({ dest: path.join(__dirname, '..', 'uploads'), limits: { fileSize: 5 * 1024 * 1024 } });
const root = path.join(__dirname, '..');
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(root, { index: false }));
const clientDist = path.join(root, 'client-dist');
if (fs.existsSync(clientDist)) app.use('/react', express.static(clientDist));

const input = value => String(value || '').trim();
async function requireUser(request, response, next) {
  try { request.user = await currentUser(request); if (!request.user) return fail(response, 401, 'Authentication required.'); next(); }
  catch (error) { next(error); }
}
function userQueryFields() { return 'id,username,email,display_name,bio,profile_photo_url,is_admin'; }
async function hasConnection(userId, friendId) {
  const result = await pool.query(`SELECT 1 FROM connections WHERE user_id=$1 AND friend_id=$2
    UNION SELECT 1 FROM connection_requests WHERE ((sender_id=$1 AND receiver_id=$2) OR (sender_id=$2 AND receiver_id=$1)) AND status='accepted' LIMIT 1`, [userId, friendId]);
  return result.rowCount > 0;
}
// posts.place_id is a FK to places(id) (a client-supplied VARCHAR), so a post can
// only reference a place row that already exists. This upserts the place first and
// returns a valid place_id, so posting a brand-new pinned/searched spot never fails
// the foreign key. Returns null when there is no place to attach (a placeless post).
async function ensurePlace(place) {
  if (!place) return null;
  const lat = place.lat ?? place.latitude;
  const lng = place.lng ?? place.longitude;
  const latNum = lat === '' || lat == null ? null : Number(lat);
  const lngNum = lng === '' || lng == null ? null : Number(lng);
  const hasCoords = Number.isFinite(latNum) && Number.isFinite(lngNum);
  let id = input(place.id);
  if (!id && !hasCoords && !input(place.name)) return null; // nothing usable
  if (!id) id = hasCoords ? `geo:${latNum.toFixed(5)}:${lngNum.toFixed(5)}` : `place:${crypto.randomBytes(6).toString('hex')}`;
  id = id.slice(0, 180);
  const name = (input(place.name) || id).slice(0, 180);
  await pool.query(
    `INSERT INTO places(id,name,address,latitude,longitude) VALUES($1,$2,$3,$4,$5)
     ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,
       address=COALESCE(EXCLUDED.address,places.address),
       latitude=COALESCE(EXCLUDED.latitude,places.latitude),
       longitude=COALESCE(EXCLUDED.longitude,places.longitude)`,
    [id, name, input(place.address) || null, hasCoords ? latNum : null, hasCoords ? lngNum : null]
  );
  return id;
}

app.get('/api/health', (_request, response) => ok(response, { status: 'healthy' }));
app.post('/api/auth/signup', async (request, response, next) => {
  try {
    const data = request.body; const username = input(data.username).toLowerCase(); const email = input(data.email || data.identifier).toLowerCase(); const name = input(data.name || data.displayName || username); const password = String(data.password || '');
    if (!/^[a-z0-9_]{3,30}$/.test(username) || !/^\S+@\S+\.\S+$/.test(email) || password.length < 8 || !name) return fail(response, 400, 'Use a valid username, email, name, and password of at least 8 characters.');
    const user = (await pool.query(`INSERT INTO users(username,email,password_hash,display_name) VALUES($1,$2,$3,$4) RETURNING ${userQueryFields()}`, [username, email, await hashPassword(password), name])).rows[0];
    await pool.query('INSERT INTO user_settings(user_id) VALUES($1) ON CONFLICT DO NOTHING', [user.id]);
    response.set('Set-Cookie', sessionCookie(await createSession(user.id))); return ok(response, { user: publicUser(user) }, 201);
  } catch (error) { next(error); }
});
app.post('/api/auth/login', async (request, response, next) => {
  try { const identity = input(request.body.identity || request.body.identifier || request.body.email).toLowerCase(); const user = (await pool.query(`SELECT ${userQueryFields()},password_hash FROM users WHERE LOWER(username)=$1 OR LOWER(email)=$1`, [identity])).rows[0]; if (!user || !(await validPassword(String(request.body.password || ''), user.password_hash))) return fail(response, 401, 'Invalid username/email or password.'); response.set('Set-Cookie', sessionCookie(await createSession(user.id))); return ok(response, { user: publicUser(user) }); } catch (error) { next(error); }
});
app.post('/api/auth/logout', async (request, response, next) => { try { const token = request.headers.cookie?.match(/(?:^|; )sc_session=([^;]*)/)?.[1]; if (token) await pool.query('DELETE FROM sessions WHERE token_hash=$1', [require('./auth').digest(decodeURIComponent(token))]); response.set('Set-Cookie', sessionCookie('', true)); return ok(response); } catch (error) { next(error); } });
app.post('/api/auth/forgot-password', async (request, response, next) => { try { const email = input(request.body.email).toLowerCase(); const user = (await pool.query('SELECT id FROM users WHERE LOWER(email)=$1', [email])).rows[0]; if (!user) return ok(response, { message: 'If that email exists, reset instructions have been created.' }); const token = crypto.randomBytes(32).toString('hex'); await pool.query("INSERT INTO password_reset_tokens(token_hash,user_id,expires_at) VALUES($1,$2,NOW()+INTERVAL '1 hour')", [crypto.createHash('sha256').update(token).digest('hex'), user.id]); return ok(response, { message: 'Reset token created. Connect an email provider before exposing this token to users.', resetToken: token }); } catch (error) { next(error); } });
app.post('/api/auth/reset-password', async (request, response, next) => { try { const token = input(request.body.token); const password = String(request.body.password || ''); if (password.length < 8) return fail(response, 400, 'Password must be at least 8 characters.'); const hash = crypto.createHash('sha256').update(token).digest('hex'); const row = (await pool.query("SELECT user_id FROM password_reset_tokens WHERE token_hash=$1 AND expires_at>NOW() AND used_at IS NULL", [hash])).rows[0]; if (!row) return fail(response, 400, 'Reset token is invalid or expired.'); await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [await require('./auth').hashPassword(password), row.user_id]); await pool.query('UPDATE password_reset_tokens SET used_at=NOW() WHERE token_hash=$1', [hash]); return ok(response); } catch (error) { next(error); } });
app.get('/api/auth/me', requireUser, (request, response) => ok(response, { user: publicUser(request.user) }));

app.use('/api', requireUser);
app.get('/api/users/search', async (request, response, next) => { try { const q = `%${input(request.query.q).toLowerCase()}%`; const rows = (await pool.query(`SELECT ${userQueryFields()} FROM users WHERE id<>$1 AND (LOWER(username) LIKE $2 OR LOWER(display_name) LIKE $2) ORDER BY username LIMIT 20`, [request.user.id, q])).rows; return ok(response, { users: rows.map(publicUser) }); } catch (error) { next(error); } });
app.get('/api/users/:userId', async (request, response, next) => { try { const row = (await pool.query(`SELECT ${userQueryFields()} FROM users WHERE id=$1`, [Number(request.params.userId)])).rows[0]; if (!row) return fail(response, 404, 'User not found.'); return ok(response, { user: publicUser(row) }); } catch (error) { next(error); } });
app.get('/api/profile', (request, response) => ok(response, { user: publicUser(request.user) }));
app.patch('/api/profile', async (request, response, next) => { try { const name = input(request.body.displayName || request.body.name) || request.user.display_name; const bio = input(request.body.bio); const row = (await pool.query('UPDATE users SET display_name=$1,bio=$2 WHERE id=$3 RETURNING ' + userQueryFields(), [name, bio, request.user.id])).rows[0]; return ok(response, { user: publicUser(row) }); } catch (error) { next(error); } });
app.post('/api/profile/photo', upload.single('photo'), async (request, response, next) => { try { if (!request.file) return fail(response, 400, 'Photo is required.'); const url = `/uploads/${request.file.filename}`; const row = (await pool.query('UPDATE users SET profile_photo_url=$1 WHERE id=$2 RETURNING ' + userQueryFields(), [url, request.user.id])).rows[0]; return ok(response, { user: publicUser(row) }); } catch (error) { next(error); } });
app.delete('/api/profile/photo', async (request, response, next) => { try { await pool.query('UPDATE users SET profile_photo_url=NULL WHERE id=$1', [request.user.id]); return ok(response); } catch (error) { next(error); } });

app.get('/api/connections', async (request, response, next) => { try { const connections = (await pool.query(`SELECT DISTINCT u.* FROM users u WHERE u.id IN (SELECT friend_id FROM connections WHERE user_id=$1 UNION SELECT CASE WHEN sender_id=$1 THEN receiver_id ELSE sender_id END FROM connection_requests WHERE (sender_id=$1 OR receiver_id=$1) AND status='accepted') ORDER BY u.username`, [request.user.id])).rows.map(publicUser); return ok(response, { connections, users: connections }); } catch (error) { next(error); } });
app.get('/api/connections/requests', async (request, response, next) => { try { const incoming = (await pool.query(`SELECT cr.id AS request_id,u.* FROM connection_requests cr JOIN users u ON u.id=cr.sender_id WHERE cr.receiver_id=$1 AND cr.status='pending'`, [request.user.id])).rows.map(row => ({ ...publicUser(row), id: row.request_id, requestId: row.request_id, userId: row.id })); const outgoing = (await pool.query(`SELECT cr.id AS request_id,u.* FROM connection_requests cr JOIN users u ON u.id=cr.receiver_id WHERE cr.sender_id=$1 AND cr.status='pending'`, [request.user.id])).rows.map(row => ({ ...publicUser(row), requestId: row.request_id, userId: row.id })); return ok(response, { incoming, outgoing }); } catch (error) { next(error); } });
app.post('/api/connections/request', async (request, response, next) => { try { const target = Number(request.body.userId); if (!target || target === request.user.id) return fail(response, 400, 'Invalid connection target.'); const connected = await pool.query('SELECT 1 FROM connections WHERE user_id=$1 AND friend_id=$2', [request.user.id, target]); if (connected.rowCount) return fail(response, 409, 'You are already connected.'); const pending = await pool.query("SELECT 1 FROM connection_requests WHERE sender_id=$1 AND receiver_id=$2 AND status='pending'", [request.user.id, target]); if (pending.rowCount) return fail(response, 409, 'A request is already pending.'); const connectionRequest = (await pool.query('INSERT INTO connection_requests(sender_id,receiver_id) VALUES($1,$2) RETURNING id', [request.user.id, target])).rows[0]; const body=`${request.user.display_name} wants to connect with you.`; await pool.query("INSERT INTO notifications(user_id,type,title,body,actor_id,request_id) VALUES($1,'connection_request','New connection request',$2,$3,$4)", [target, body, request.user.id, connectionRequest.id]); notifyUser(target,'notification',{type:'connection_request',title:'New connection request',body,actorId:request.user.id,requestId:connectionRequest.id}); return ok(response, { requestId: connectionRequest.id }, 201); } catch (error) { next(error); } });
app.post('/api/connections/requests/:id/:action(accept|reject)', async (request, response, next) => { try { const status = request.params.action === 'accept' ? 'accepted' : 'declined'; const row = (await pool.query("UPDATE connection_requests SET status=$1,updated_at=NOW() WHERE id=$2 AND receiver_id=$3 AND status='pending' RETURNING sender_id", [status, request.params.id, request.user.id])).rows[0]; if (!row) return fail(response, 404, 'Request not found.'); await pool.query('UPDATE notifications SET read_at=NOW() WHERE request_id=$1', [request.params.id]); if (status === 'accepted') { await pool.query('INSERT INTO connections(user_id,friend_id) VALUES($1,$2),($2,$1) ON CONFLICT DO NOTHING', [request.user.id, row.sender_id]); const body=`${request.user.display_name} accepted your connection request.`; await pool.query("INSERT INTO notifications(user_id,type,title,body,actor_id,request_id) VALUES($1,'connection_accepted','Connection request accepted',$2,$3,$4)", [row.sender_id, body, request.user.id, request.params.id]); notifyUser(row.sender_id,'notification',{type:'connection_accepted',title:'Connection request accepted',body,actorId:request.user.id,requestId:Number(request.params.id)}); } return ok(response); } catch (error) { next(error); } });
app.delete('/api/connections/requests/:id', async (request, response, next) => { try { await pool.query("DELETE FROM connection_requests WHERE id=$1 AND sender_id=$2 AND status='pending'", [request.params.id, request.user.id]); return ok(response); } catch (error) { next(error); } });
app.get('/api/messages/:userId', async (request, response, next) => { try { const friendId = Number(request.params.userId); if (!(await hasConnection(request.user.id, friendId))) return fail(response, 403, 'You can message accepted friends only.'); const messages = (await pool.query('SELECT id,sender_id,receiver_id,content,kind,meta,call_id,created_at FROM direct_messages WHERE (sender_id=$1 AND receiver_id=$2) OR (sender_id=$2 AND receiver_id=$1) ORDER BY created_at ASC LIMIT 200', [request.user.id, friendId])).rows; return ok(response, { messages }); } catch (error) { next(error); } });
app.post('/api/messages/:userId', async (request, response, next) => { try { const friendId = Number(request.params.userId); const content = input(request.body.content); if (!(await hasConnection(request.user.id, friendId))) return fail(response, 403, 'You can message accepted friends only.'); if (!content) return fail(response, 400, 'Message is required.'); const message = (await pool.query('INSERT INTO direct_messages(sender_id,receiver_id,content) VALUES($1,$2,$3) RETURNING *', [request.user.id, friendId, content])).rows[0]; notifyUser(friendId,'message:new',{message}); return ok(response, { message }, 201); } catch (error) { next(error); } });

app.get('/api/notifications', async (request, response, next) => { try { const notifications = (await pool.query("SELECT n.*,u.display_name AS actor_name FROM notifications n LEFT JOIN users u ON u.id=n.actor_id WHERE n.user_id=$1 ORDER BY n.created_at DESC LIMIT 50", [request.user.id])).rows; return ok(response, { notifications }); } catch (error) { next(error); } });
app.get('/api/feed', async (request, response, next) => { try { const feed = (await pool.query(`SELECT p.*, pl.name AS place_name, pl.latitude AS place_lat, pl.longitude AS place_lng, u.username, u.display_name, u.profile_photo_url FROM posts p JOIN users u ON u.id=p.user_id LEFT JOIN places pl ON pl.id=p.place_id WHERE p.user_id=$1 OR p.user_id IN (SELECT friend_id FROM connections WHERE user_id=$1) ORDER BY p.created_at DESC LIMIT 50`, [request.user.id])).rows; return ok(response, { feed }); } catch (error) { next(error); } });
app.post('/api/posts', async (request, response, next) => { try { const content = input(request.body.content); if (!content) return fail(response, 400, 'Post content is required.'); const place = request.body.place || (request.body.placeId ? { id: request.body.placeId, name: request.body.placeName, lat: request.body.lat, lng: request.body.lng } : null); let placeId = null; try { placeId = await ensurePlace(place); } catch (placeError) { console.warn('Place upsert failed; posting without a place:', placeError.message); placeId = null; } const post = (await pool.query('INSERT INTO posts(user_id,content,place_id) VALUES($1,$2,$3) RETURNING *', [request.user.id, content, placeId])).rows[0]; const rating = Number(request.body.rating); if (placeId && Number.isInteger(rating) && rating >= 1 && rating <= 5) { await pool.query('INSERT INTO place_ratings(place_id,user_id,rating,review) VALUES($1,$2,$3,$4) ON CONFLICT(place_id,user_id) DO UPDATE SET rating=EXCLUDED.rating,review=EXCLUDED.review,updated_at=NOW()', [placeId, request.user.id, rating, content]).catch(ratingError => console.warn('Rating save skipped:', ratingError.message)); } const enriched = (await pool.query(`SELECT p.*, pl.name AS place_name, pl.latitude AS place_lat, pl.longitude AS place_lng, u.username, u.display_name, u.profile_photo_url FROM posts p LEFT JOIN places pl ON pl.id=p.place_id JOIN users u ON u.id=p.user_id WHERE p.id=$1`, [post.id])).rows[0]; return ok(response, { post: enriched }, 201); } catch (error) { next(error); } });
app.post('/api/places/:placeId/rating', async (request, response, next) => { try { const rating = Number(request.body.rating); if (!Number.isInteger(rating) || rating < 1 || rating > 5) return fail(response, 400, 'Rating must be an integer from 1 to 5.'); const row = (await pool.query('INSERT INTO place_ratings(place_id,user_id,rating,review) VALUES($1,$2,$3,$4) ON CONFLICT(place_id,user_id) DO UPDATE SET rating=EXCLUDED.rating,review=EXCLUDED.review,updated_at=NOW() RETURNING *', [request.params.placeId, request.user.id, rating, input(request.body.review)])).rows[0]; return ok(response, { rating: row }); } catch (error) { next(error); } });
app.post('/api/invite', async (request, response, next) => { try { const code = crypto.randomBytes(5).toString('hex'); await pool.query('INSERT INTO invites(code,user_id) VALUES($1,$2)', [code, request.user.id]); return ok(response, { code }, 201); } catch (error) { next(error); } });
app.post('/api/reactions', async (request, response, next) => { try { const itemType = input(request.body.itemType); const itemId = input(request.body.itemId); const reaction = input(request.body.reaction); if (!['place', 'news'].includes(itemType) || !itemId || !['like', 'dislike'].includes(reaction)) return fail(response, 400, 'Invalid reaction.'); await pool.query('INSERT INTO content_reactions(user_id,item_type,item_id,reaction) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,item_type,item_id) DO UPDATE SET reaction=EXCLUDED.reaction', [request.user.id, itemType, itemId, reaction]); return ok(response); } catch (error) { next(error); } });
app.post('/api/circles', async (request, response, next) => { const client=await pool.connect(); try { const name=input(request.body.name); const memberIds=[...new Set((request.body.memberIds || []).map(Number).filter(id=>id && id!==request.user.id))]; if (!name) return fail(response,400,'Circle name is required.'); if (memberIds.length<2) return fail(response,400,'Select at least two accepted friends.'); for (const memberId of memberIds) if (!(await hasConnection(request.user.id,memberId))) return fail(response,403,'All group members must be accepted friends.'); await client.query('BEGIN'); const circle=(await client.query('INSERT INTO circles(owner_id,name) VALUES($1,$2) RETURNING *',[request.user.id,name])).rows[0]; await client.query("INSERT INTO circle_members(circle_id,user_id,role) VALUES($1,$2,'owner')",[circle.id,request.user.id]); for (const memberId of memberIds) await client.query("INSERT INTO circle_members(circle_id,user_id,role) VALUES($1,$2,'member')",[circle.id,memberId]); await client.query('COMMIT'); const memberRows=(await pool.query(`SELECT ${userQueryFields()} FROM users WHERE id = ANY($1::bigint[])`,[[request.user.id,...memberIds]])).rows.map(publicUser); const payload={circle,members:memberRows,memberIds:[request.user.id,...memberIds]}; memberIds.forEach(memberId=>notifyUser(memberId,'circle:new',payload)); return ok(response,payload,201); } catch(error) { await client.query('ROLLBACK'); next(error); } finally { client.release(); } });
app.get('/api/circles', async (request, response, next) => { try { const circles=(await pool.query(`SELECT c.*,COUNT(cm.user_id)::int AS member_count,MAX(m.created_at) AS last_message_at FROM circles c JOIN circle_members cm ON cm.circle_id=c.id LEFT JOIN messages m ON m.circle_id=c.id WHERE c.id IN (SELECT circle_id FROM circle_members WHERE user_id=$1) GROUP BY c.id ORDER BY c.created_at DESC`,[request.user.id])).rows; return ok(response,{circles}); } catch(error) { next(error); } });
app.post('/api/circles/:circleId/messages', async (request, response, next) => { try { const content = input(request.body.content); const member = await pool.query('SELECT 1 FROM circle_members WHERE circle_id=$1 AND user_id=$2', [request.params.circleId, request.user.id]); if (!member.rowCount) return fail(response, 403, 'You are not a member of this circle.'); if (!content) return fail(response, 400, 'Message is required.'); const message = (await pool.query('INSERT INTO messages(circle_id,sender_id,content) VALUES($1,$2,$3) RETURNING *', [request.params.circleId, request.user.id, content])).rows[0]; const members=(await pool.query('SELECT user_id FROM circle_members WHERE circle_id=$1 AND user_id<>$2',[request.params.circleId,request.user.id])).rows; members.forEach(memberRow=>notifyUser(memberRow.user_id,'message:new',{message,circleId:Number(request.params.circleId)})); return ok(response, { message }, 201); } catch (error) { next(error); } });
app.get('/api/circles/:circleId/messages', async (request, response, next) => { try { const messages = (await pool.query('SELECT m.*,u.display_name FROM messages m JOIN users u ON u.id=m.sender_id JOIN circle_members cm ON cm.circle_id=m.circle_id WHERE m.circle_id=$1 AND cm.user_id=$2 ORDER BY m.created_at ASC LIMIT 200', [request.params.circleId, request.user.id])).rows; return ok(response, { messages }); } catch (error) { next(error); } });
app.post('/api/circles/:circleId/calls', async (request, response, next) => { try { const roomCode = crypto.randomBytes(8).toString('hex'); const call = (await pool.query("INSERT INTO group_calls(circle_id,started_by,room_code) SELECT $1,$2,$3 WHERE EXISTS (SELECT 1 FROM circle_members WHERE circle_id=$1 AND user_id=$2) RETURNING *", [request.params.circleId, request.user.id, roomCode])).rows[0]; if (!call) return fail(response, 403, 'You are not a member of this circle.'); const circle=(await pool.query('SELECT * FROM circles WHERE id=$1',[request.params.circleId])).rows[0]; const memberRows=(await pool.query('SELECT user_id FROM circle_members WHERE circle_id=$1',[request.params.circleId])).rows; const memberIds=memberRows.map(r=>Number(r.user_id)); const callType=request.body.callType==='video'?'video':'audio'; const payload={call,callType,circle,memberIds,startedBy:publicUser(request.user)}; memberIds.filter(id=>id!==Number(request.user.id)).forEach(id=>notifyUser(id,'call:group-incoming',payload)); return ok(response, payload, 201); } catch (error) { next(error); } });
/* ---- Call history as a persistent conversation entry -----------------------
   One row in direct_messages per finished call, kind='call', carrying the call id.
   A unique index on direct_messages.call_id means a retried or duplicated event is
   a no-op (ON CONFLICT DO NOTHING) rather than a second bubble. Both participants
   see the same row because a 1:1 conversation is a single pair of ids, and both are
   pushed the same message:new event so it appears without a refresh.           */
function formatCallDuration(seconds){ const m=Math.floor(seconds/60), s=seconds%60; return m ? `${m}m ${s}s` : `${s}s`; }
async function recordCallHistory(call, status) {
  if (!call || !call.id) return null;
  const type = call.call_type === 'video' ? 'video' : 'audio';
  const noun = type === 'video' ? 'Video' : 'Audio';
  let seconds = 0;
  if (status === 'ended' && call.answered_at && call.ended_at) {
    seconds = Math.max(0, Math.round((new Date(call.ended_at).getTime() - new Date(call.answered_at).getTime()) / 1000));
  }
  const label = status === 'ended' ? `${noun} call · ${formatCallDuration(seconds)}`
    : status === 'declined' ? `${noun} call declined`
    : `Missed ${type} call`;
  const meta = { callType: type, status, seconds, callerId: Number(call.caller_id), calleeId: Number(call.callee_id) };
  try {
    const row = (await pool.query(
      `INSERT INTO direct_messages(sender_id,receiver_id,content,kind,meta,call_id)
       VALUES($1,$2,$3,'call',$4::jsonb,$5) ON CONFLICT DO NOTHING RETURNING *`,
      [call.caller_id, call.callee_id, label, JSON.stringify(meta), call.id]
    )).rows[0];
    if (!row) return null; // already recorded for this call
    notifyUser(call.caller_id, 'message:new', { message: row });
    notifyUser(call.callee_id, 'message:new', { message: row });
    return row;
  } catch (error) { console.warn('Call history not recorded:', error.message); return null; }
}
// Authorisation for in-call events: the sender must actually be one of the two
// participants of that call, and the addressed user must be the other one. This is
// what stops a client from using a reaction (or any call event) to poke a stranger.
async function callParticipants(callId) {
  try {
    const row = (await pool.query("SELECT caller_id, callee_id, status FROM call_sessions WHERE id=$1", [Number(callId)])).rows[0];
    return row || null;
  } catch (error) { return null; }
}
async function isCallPair(callId, fromUserId, toUserId) {
  const row = await callParticipants(callId);
  if (!row) return false;
  if (!['ringing', 'active'].includes(row.status)) return false;
  const a = Number(row.caller_id), b = Number(row.callee_id);
  const f = Number(fromUserId), t = Number(toUserId);
  return (f === a && t === b) || (f === b && t === a);
}

// A socket dropping (tab closed, network lost) must not leave the other side ringing.
async function endStaleCallsFor(userId) {
  try {
    const rows = (await pool.query(
      "UPDATE call_sessions SET status='ended', ended_at=NOW() WHERE (caller_id=$1 OR callee_id=$1) AND status IN ('ringing','active') RETURNING *",
      [Number(userId)]
    )).rows;
    for (const call of rows) {
      notifyUser(call.caller_id, 'call:ended', { call, reason: 'disconnected' });
      notifyUser(call.callee_id, 'call:ended', { call, reason: 'disconnected' });
      await recordCallHistory(call, call.answered_at ? 'ended' : 'missed');
    }
    return rows.length;
  } catch (error) { console.warn('Stale call cleanup failed:', error.message); return 0; }
}

// ICE servers come from the server so TURN credentials are never baked into the
// page. STUN-only is the default; set TURN_URLS (+ TURN_USERNAME / TURN_CREDENTIAL)
// in the environment to make calls work across symmetric NATs and mobile networks.
app.get('/api/rtc-config', (request, response) => {
  const stun = (process.env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302').split(',').map(s=>s.trim()).filter(Boolean);
  const iceServers = [{ urls: stun }];
  if (process.env.TURN_URLS) {
    const entry = { urls: process.env.TURN_URLS.split(',').map(s=>s.trim()).filter(Boolean) };
    if (process.env.TURN_USERNAME) entry.username = process.env.TURN_USERNAME;
    if (process.env.TURN_CREDENTIAL) entry.credential = process.env.TURN_CREDENTIAL;
    iceServers.push(entry);
  }
  return ok(response, { iceServers, hasTurn: !!process.env.TURN_URLS });
});

app.post('/api/calls', async (request, response, next) => { try { const calleeId=Number(request.body.calleeId); const callType=request.body.callType==='video'?'video':'audio'; if (!(await hasConnection(request.user.id,calleeId))) return fail(response,403,'Calls are available to accepted friends only.'); const busy=(await pool.query("SELECT 1 FROM call_sessions WHERE (caller_id=$1 OR callee_id=$1) AND status IN ('ringing','active') LIMIT 1",[calleeId])).rowCount>0; const call=(await pool.query("INSERT INTO call_sessions(caller_id,callee_id,call_type) VALUES($1,$2,$3) RETURNING *",[request.user.id,calleeId,callType])).rows[0]; const delivered=notifyUser(calleeId,'call:incoming',{call,caller:publicUser(request.user)}); return ok(response,{call,recipientOnline:isUserOnline(calleeId),delivered,recipientBusy:busy},201); } catch(error) { next(error); } });
app.post('/api/calls/:callId/respond', async (request, response, next) => { try { const accept=request.body.accept===true; const call=(await pool.query("UPDATE call_sessions SET status=$1, answered_at=CASE WHEN $4 THEN NOW() ELSE answered_at END WHERE id=$2 AND callee_id=$3 AND status='ringing' RETURNING *",[accept?'active':'declined',request.params.callId,request.user.id,accept])).rows[0]; if(!call) return fail(response,404,'Call request not found.'); notifyUser(call.caller_id,'call:response',{call,accepted:accept,reason:request.body.reason||null}); if(!accept) await recordCallHistory(call,'declined'); return ok(response,{call}); } catch(error) { next(error); } });
app.post('/api/calls/:callId/end', async (request, response, next) => { try { const call=(await pool.query("UPDATE call_sessions SET status='ended',ended_at=NOW() WHERE id=$1 AND (caller_id=$2 OR callee_id=$2) AND status IN ('ringing','active') RETURNING *",[request.params.callId,request.user.id])).rows[0]; if(!call) return fail(response,404,'Call not found.'); notifyUser(call.caller_id,'call:ended',{call}); notifyUser(call.callee_id,'call:ended',{call}); await recordCallHistory(call, call.answered_at ? 'ended' : 'missed'); return ok(response,{call}); } catch(error) { next(error); } });
// One call that powers the whole Messages list: every accepted friend (so a chat can
// be started before any message exists), every circle the user belongs to, each with
// its last message and an unread count derived from conversation_reads. Unread is
// therefore durable across reloads instead of living only in browser memory.
app.get('/api/conversations', async (request, response, next) => {
  try {
    const me = request.user.id;
    const direct = (await pool.query(`
      WITH friend_ids AS (
        SELECT friend_id AS id FROM connections WHERE user_id=$1
        UNION SELECT CASE WHEN sender_id=$1 THEN receiver_id ELSE sender_id END FROM connection_requests WHERE (sender_id=$1 OR receiver_id=$1) AND status='accepted'
      )
      SELECT u.id AS peer_id, u.username, u.display_name, u.profile_photo_url,
             lm.content AS last_content, lm.created_at AS last_at, lm.sender_id AS last_sender_id,
             COALESCE(uc.cnt,0)::int AS unread
      FROM friend_ids f
      JOIN users u ON u.id=f.id
      LEFT JOIN LATERAL (
        SELECT content, created_at, sender_id FROM direct_messages
        WHERE (sender_id=$1 AND receiver_id=u.id) OR (sender_id=u.id AND receiver_id=$1)
        ORDER BY created_at DESC LIMIT 1
      ) lm ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS cnt FROM direct_messages dm
        WHERE dm.sender_id=u.id AND dm.receiver_id=$1
          AND dm.created_at > COALESCE((SELECT last_read_at FROM conversation_reads WHERE user_id=$1 AND kind='dm' AND peer_id=u.id), 'epoch'::timestamptz)
      ) uc ON TRUE
      ORDER BY lm.created_at DESC NULLS LAST, u.display_name`, [me])).rows;
    const groups = (await pool.query(`
      SELECT c.id AS peer_id, c.name, c.owner_id,
             (SELECT COUNT(*)::int FROM circle_members WHERE circle_id=c.id) AS member_count,
             lm.content AS last_content, lm.created_at AS last_at, lm.sender_id AS last_sender_id, lm.display_name AS last_sender_name,
             COALESCE(uc.cnt,0)::int AS unread
      FROM circles c
      JOIN circle_members me ON me.circle_id=c.id AND me.user_id=$1
      LEFT JOIN LATERAL (
        SELECT m.content, m.created_at, m.sender_id, u.display_name FROM messages m JOIN users u ON u.id=m.sender_id
        WHERE m.circle_id=c.id ORDER BY m.created_at DESC LIMIT 1
      ) lm ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS cnt FROM messages m
        WHERE m.circle_id=c.id AND m.sender_id<>$1
          AND m.created_at > COALESCE((SELECT last_read_at FROM conversation_reads WHERE user_id=$1 AND kind='circle' AND peer_id=c.id), 'epoch'::timestamptz)
      ) uc ON TRUE
      ORDER BY lm.created_at DESC NULLS LAST, c.name`, [me])).rows;
    return ok(response, { direct, groups });
  } catch (error) { next(error); }
});
app.post('/api/conversations/:kind/:peerId/read', async (request, response, next) => {
  try {
    const kind = request.params.kind === 'circle' ? 'circle' : 'dm';
    const peerId = Number(request.params.peerId);
    if (!Number.isFinite(peerId) || peerId <= 0) return fail(response, 400, 'Invalid conversation id.');
    await pool.query(`INSERT INTO conversation_reads(user_id,kind,peer_id,last_read_at) VALUES($1,$2,$3,NOW())
      ON CONFLICT(user_id,kind,peer_id) DO UPDATE SET last_read_at=NOW()`, [request.user.id, kind, peerId]);
    return ok(response, { read: true });
  } catch (error) { next(error); }
});

app.get('/api/state', async (request, response, next) => { try { const row = (await pool.query('SELECT dark_mode AS "darkMode",live_location AS "liveLocation",friend_activity AS "friendActivity",digest,discoverable,saved_places AS "savedPlaces",saved_events AS "savedEvents" FROM user_settings WHERE user_id=$1', [request.user.id])).rows[0]; return ok(response, row ? { found: true, ...row, settings: { liveLocation: row.liveLocation, friendActivity: row.friendActivity, digest: row.digest, discoverable: row.discoverable } } : { found: false }); } catch (error) { next(error); } });
app.post('/api/state', async (request, response, next) => { try { const d = request.body; await pool.query(`INSERT INTO user_settings(user_id,dark_mode,live_location,friend_activity,digest,discoverable,saved_places,saved_events) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(user_id) DO UPDATE SET dark_mode=EXCLUDED.dark_mode,live_location=EXCLUDED.live_location,friend_activity=EXCLUDED.friend_activity,digest=EXCLUDED.digest,discoverable=EXCLUDED.discoverable,saved_places=EXCLUDED.saved_places,saved_events=EXCLUDED.saved_events,updated_at=NOW()`, [request.user.id, !!d.darkMode, !!d.settings?.liveLocation, d.settings?.friendActivity !== false, !!d.settings?.digest, d.settings?.discoverable !== false, JSON.stringify(d.savedPlaces || []), JSON.stringify(d.savedEvents || [])]); return ok(response); } catch (error) { next(error); } });

// ---- Live location (privacy-gated). A user's coordinates are only ever
// returned to an ACCEPTED friend, and only while that user has live_location
// sharing switched on in their settings. Storing coordinates and sharing them
// are two separate switches: POST stores, user_settings.live_location shares.
app.post('/api/location', async (request, response, next) => { try { const lat = Number(request.body.latitude ?? request.body.lat); const lng = Number(request.body.longitude ?? request.body.lng); const accuracyRaw = request.body.accuracy; const accuracy = accuracyRaw == null || accuracyRaw === '' ? null : Number(accuracyRaw); if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return fail(response, 400, 'Valid latitude and longitude are required.'); await pool.query(`INSERT INTO user_locations(user_id,latitude,longitude,accuracy,updated_at) VALUES($1,$2,$3,$4,NOW()) ON CONFLICT(user_id) DO UPDATE SET latitude=EXCLUDED.latitude,longitude=EXCLUDED.longitude,accuracy=EXCLUDED.accuracy,updated_at=NOW()`, [request.user.id, lat, lng, Number.isFinite(accuracy) ? accuracy : null]); return ok(response, { updated: true }); } catch (error) { next(error); } });
app.delete('/api/location', async (request, response, next) => { try { await pool.query('DELETE FROM user_locations WHERE user_id=$1', [request.user.id]); return ok(response); } catch (error) { next(error); } });
app.get('/api/locations', async (request, response, next) => { try { const locations = (await pool.query(`SELECT ul.user_id, ul.latitude, ul.longitude, ul.accuracy, ul.updated_at, u.username, u.display_name FROM user_locations ul JOIN users u ON u.id=ul.user_id JOIN user_settings s ON s.user_id=ul.user_id WHERE s.live_location=TRUE AND ul.user_id IN (SELECT friend_id FROM connections WHERE user_id=$1) ORDER BY ul.updated_at DESC`, [request.user.id])).rows; return ok(response, { locations }); } catch (error) { next(error); } });
app.get('/api/location/:userId', async (request, response, next) => { try { const friendId = Number(request.params.userId); if (!(await hasConnection(request.user.id, friendId))) return fail(response, 403, 'You can view accepted friends only.'); const row = (await pool.query(`SELECT ul.user_id, ul.latitude, ul.longitude, ul.accuracy, ul.updated_at FROM user_locations ul JOIN user_settings s ON s.user_id=ul.user_id WHERE ul.user_id=$1 AND s.live_location=TRUE`, [friendId])).rows[0]; if (!row) return fail(response, 404, 'That friend is not sharing their location right now.'); return ok(response, { location: row }); } catch (error) { next(error); } });

app.use((error, _request, response, _next) => { console.error(error); return fail(response, error.code === '23505' ? 409 : 500, error.code === '23505' ? 'Username, email, or request already exists.' : 'Server error.'); });
app.get('/react', (_request, response) => response.sendFile(path.join(clientDist, 'index.html')));
app.get('*', (_request, response) => response.sendFile(path.join(root, 'socialcircle.html')));

async function initialize() { await pool.query(fs.readFileSync(path.join(root, 'schema.sql'), 'utf8')); const password = process.env.ADMIN_PASSWORD || 'admin@123'; await pool.query(`INSERT INTO users(username,email,password_hash,display_name,is_admin) VALUES('admin','admin@socialcircle.local',$1,'Administrator',TRUE) ON CONFLICT(username) DO UPDATE SET password_hash=EXCLUDED.password_hash,is_admin=TRUE`, [await hashPassword(password)]); }
initialize().catch(error => { console.error('Database startup failed:', error.message); process.exit(1); });
module.exports = { createApp: () => app, addClient, notifyUser, isUserOnline, endStaleCallsFor, isCallPair };
