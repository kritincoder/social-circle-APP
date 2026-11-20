const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { pool, hashPassword, validPassword, publicUser, currentUser, createSession, sessionCookie } = require('./auth');
const { ok, fail } = require('./response');
const { storage, MAX_IMAGE_BYTES, MAX_VIDEO_BYTES } = require('./storage');

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

// Bytes are held in memory and handed to the storage driver, which decides
// where they are written. Nothing is written to a path baked into the image.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_VIDEO_BYTES } });
const uploadImage = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES } });
const root = path.join(__dirname, '..');
const app = express();
const STARTED_AT = new Date().toISOString();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
// Previously this was express.static(root), which served the whole project
// directory — including src/*.js and schema.sql — to the public internet. The
// page loads no local asset other than user uploads, so only the upload
// directory is exposed, and it is served from wherever the driver put it (which
// may be a mounted volume outside the project).
app.use('/uploads', express.static(storage.root, {
  index: false,
  dotfiles: 'deny',
  // Uploads are user-supplied bytes; never let a browser sniff them into
  // something executable, and never render one as a document on our origin.
  setHeaders(response) {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Disposition', 'inline');
    response.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'");
  }
}));
const clientDist = path.join(root, 'client-dist');
if (fs.existsSync(clientDist)) app.use('/react', express.static(clientDist));

const input = value => String(value || '').trim();
async function requireUser(request, response, next) {
  try { request.user = await currentUser(request); if (!request.user) return fail(response, 401, 'Authentication required.'); next(); }
  catch (error) { next(error); }
}
function userQueryFields() { return 'id,username,email,display_name,bio,profile_photo_url,is_admin,district'; }
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
    `INSERT INTO places(id,name,address,latitude,longitude,district,category) VALUES($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,
       address=COALESCE(EXCLUDED.address,places.address),
       latitude=COALESCE(EXCLUDED.latitude,places.latitude),
       longitude=COALESCE(EXCLUDED.longitude,places.longitude),
       district=COALESCE(EXCLUDED.district,places.district),
       category=COALESCE(EXCLUDED.category,places.category)`,
    [id, name, input(place.address) || null, hasCoords ? latNum : null, hasCoords ? lngNum : null,
     input(place.district) || null, input(place.category) || null]
  );
  return id;
}

// Hashes of the files that make up this build. This replaces reading the
// source over HTTP for deployment verification, which is no longer possible
// (and should never have been).
app.get('/api/version', (_request, response) => {
  const digest = file => {
    try {
      const buffer = fs.readFileSync(path.join(root, file));
      const normalised = buffer.toString('utf8').replace(/\r\n/g, '\n').replace(/\n+$/, '');
      return crypto.createHash('sha256').update(normalised).digest('hex').slice(0, 16);
    } catch { return null; }
  };
  return ok(response, {
    files: {
      'socialcircle.html': digest('socialcircle.html'),
      'server.js': digest('server.js'),
      'src/app.js': digest('src/app.js'),
      'src/auth.js': digest('src/auth.js'),
      'src/storage.js': digest('src/storage.js'),
      'schema.sql': digest('schema.sql')
    },
    storageDriver: storage.name,
    uploadRoot: storage.root,
    startedAt: STARTED_AT
  });
});
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
app.patch('/api/profile', async (request, response, next) => { try { const name = input(request.body.displayName || request.body.name) || request.user.display_name; const bio = input(request.body.bio); const district = request.body.district === undefined ? request.user.district : (input(request.body.district).slice(0, 80) || null); const row = (await pool.query('UPDATE users SET display_name=$1,bio=$2,district=$3 WHERE id=$4 RETURNING ' + userQueryFields(), [name, bio, district, request.user.id])).rows[0]; return ok(response, { user: publicUser(row) }); } catch (error) { next(error); } });
app.post('/api/profile/photo', uploadImage.single('photo'), async (request, response, next) => {
  try {
    if (!request.file) return fail(response, 400, 'Photo is required.');
    // The driver sniffs the bytes and rejects anything that is not a real image.
    const put = await storage.put(request.file.buffer, { kind: 'image', ownerId: request.user.id, scope: 'avatars' });
    if (put.error) return fail(response, 400, put.error);
    const previous = (await pool.query('SELECT profile_photo_url FROM users WHERE id=$1', [request.user.id])).rows[0];
    const row = (await pool.query('UPDATE users SET profile_photo_url=$1 WHERE id=$2 RETURNING ' + userQueryFields(),
      [put.url, request.user.id])).rows[0];
    // Remove the file the row used to point at, so replacing an avatar does not
    // leak storage forever.
    const oldKey = storage.keyFromUrl(previous && previous.profile_photo_url);
    if (oldKey && oldKey !== put.key) await storage.remove(oldKey);
    return ok(response, { user: publicUser(row) });
  } catch (error) { next(error); }
});
app.delete('/api/profile/photo', async (request, response, next) => {
  try {
    const previous = (await pool.query('SELECT profile_photo_url FROM users WHERE id=$1', [request.user.id])).rows[0];
    await pool.query('UPDATE users SET profile_photo_url=NULL WHERE id=$1', [request.user.id]);
    const key = storage.keyFromUrl(previous && previous.profile_photo_url);
    if (key) await storage.remove(key);
    return ok(response);
  } catch (error) { next(error); }
});

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
app.post('/api/reactions', async (request, response, next) => { try { const itemType = input(request.body.itemType); const itemId = input(request.body.itemId); const reaction = input(request.body.reaction); if (!['place', 'news', 'event'].includes(itemType) || !itemId || !['like', 'dislike'].includes(reaction)) return fail(response, 400, 'Invalid reaction.'); await pool.query('INSERT INTO content_reactions(user_id,item_type,item_id,reaction) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,item_type,item_id) DO UPDATE SET reaction=EXCLUDED.reaction', [request.user.id, itemType, itemId, reaction]); return ok(response); } catch (error) { next(error); } });
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

/* ============================================================
   CIRCLE REVIEWS, DISTRICT EVENTS, DISCOVERY
   Every query below is scoped server-side to the authenticated
   user's real connections. The client cannot widen that scope by
   passing a different user id, and nothing here invents content:
   a row is returned only if a real user created it.
   ============================================================ */

// The caller's circle: their accepted connections, plus themselves. Used by
// every "from your circle" query so the scope can never be set by the client.
const CIRCLE_SQL = '(SELECT $1::bigint UNION SELECT friend_id FROM connections WHERE user_id=$1)';

// Genuine reviews written by the caller's circle. Authorship comes from the
// join on users, so a review can never be attributed to someone who did not
// write it. Only rows with actual review text are returned, because a bare
// 1-5 star with no words is not a review worth putting in a social feed.
app.get('/api/reviews/circle', async (request, response, next) => {
  try {
    const limit = Math.min(Math.max(Number(request.query.limit) || 30, 1), 100);
    const district = input(request.query.district);
    const rows = (await pool.query(
      `SELECT r.id, r.rating, r.review, r.created_at, r.updated_at,
              r.place_id, pl.name AS place_name, pl.address AS place_address,
              pl.district AS place_district, pl.category AS place_category,
              pl.latitude AS place_lat, pl.longitude AS place_lng,
              u.id AS author_id, u.username AS author_username,
              u.display_name AS author_name, u.profile_photo_url AS author_photo,
              (u.id = $1) AS is_me
         FROM place_ratings r
         JOIN users u ON u.id = r.user_id
         JOIN places pl ON pl.id = r.place_id
        WHERE r.user_id IN ${CIRCLE_SQL}
          AND length(btrim(r.review)) > 0
          AND ($2 = '' OR pl.district = $2)
        ORDER BY r.created_at DESC
        LIMIT ${limit}`,
      [request.user.id, district]
    )).rows;
    return ok(response, { reviews: rows });
  } catch (error) { next(error); }
});

// Reviews for one place. Circle reviews first, then everyone else's, each
// clearly flagged, so the client never has to guess which is which and an
// outside rating is never shown as if a friend had written it.
app.get('/api/places/:placeId/reviews', async (request, response, next) => {
  try {
    const rows = (await pool.query(
      `SELECT r.id, r.rating, r.review, r.created_at,
              u.id AS author_id, u.username AS author_username,
              u.display_name AS author_name, u.profile_photo_url AS author_photo,
              (r.user_id IN ${CIRCLE_SQL}) AS in_circle,
              (u.id = $1) AS is_me
         FROM place_ratings r
         JOIN users u ON u.id = r.user_id
        WHERE r.place_id = $2 AND length(btrim(r.review)) > 0
        ORDER BY (r.user_id IN ${CIRCLE_SQL}) DESC, r.created_at DESC
        LIMIT 60`,
      [request.user.id, request.params.placeId]
    )).rows;
    const summary = (await pool.query(
      `SELECT COUNT(*)::int AS total, ROUND(AVG(rating)::numeric, 2) AS average,
              COUNT(*) FILTER (WHERE user_id IN ${CIRCLE_SQL})::int AS circle_total
         FROM place_ratings WHERE place_id = $2`,
      [request.user.id, request.params.placeId]
    )).rows[0];
    return ok(response, { reviews: rows, summary });
  } catch (error) { next(error); }
});

/* ---------- events ---------- */
// There is no verified public events API covering Indian districts, so events
// here are posted by real members. Each row keeps its author, its real date
// and its source; no date is ever shifted forward to make an old event look
// current, and an event with no future date simply stops being listed.
const EVENT_CATEGORIES = ['Educational', 'Technology', 'Hackathon', 'Workshop', 'School & College',
  'Cultural', 'Exhibition', 'Community', 'Sports', 'Public Activity', 'Food', 'Music'];

app.get('/api/events', async (request, response, next) => {
  try {
    const district = input(request.query.district);
    const scope = input(request.query.scope); // '' | 'circle' | 'mine'
    const category = input(request.query.category);
    const includePast = request.query.includePast === '1';
    const limit = Math.min(Math.max(Number(request.query.limit) || 40, 1), 100);
    const rows = (await pool.query(
      `SELECT e.*, u.username AS author_username, u.display_name AS author_name,
              u.profile_photo_url AS author_photo, (e.created_by = $1) AS is_mine,
              (SELECT COUNT(*) FROM event_interest i WHERE i.event_id = e.id)::int AS interest_total,
              (SELECT COUNT(*) FROM event_interest i
                WHERE i.event_id = e.id AND i.user_id IN ${CIRCLE_SQL} AND i.user_id <> $1)::int AS circle_interest,
              EXISTS (SELECT 1 FROM event_interest i WHERE i.event_id = e.id AND i.user_id = $1) AS my_interest
         FROM events e
         JOIN users u ON u.id = e.created_by
        WHERE ($2 = '' OR e.district = $2)
          AND ($3 = '' OR e.category = $3)
          AND ($4 OR COALESCE(e.ends_at, e.starts_at) >= NOW())
          AND ($5 = '' OR ($5 = 'mine' AND e.created_by = $1)
                       OR ($5 = 'circle' AND e.created_by IN ${CIRCLE_SQL}))
        ORDER BY e.starts_at ASC
        LIMIT ${limit}`,
      [request.user.id, district, category, includePast, scope]
    )).rows;
    return ok(response, {
      events: rows,
      district: district || request.user.district || null,
      categories: EVENT_CATEGORIES,
      generatedAt: new Date().toISOString()
    });
  } catch (error) { next(error); }
});

app.post('/api/events', async (request, response, next) => {
  try {
    const title = input(request.body.title).slice(0, 200);
    if (!title) return fail(response, 400, 'An event title is required.');
    const startsAt = new Date(request.body.startsAt || request.body.starts_at || '');
    if (Number.isNaN(startsAt.getTime())) return fail(response, 400, 'A valid start date and time is required.');
    const endsRaw = request.body.endsAt || request.body.ends_at;
    let endsAt = null;
    if (endsRaw) {
      endsAt = new Date(endsRaw);
      if (Number.isNaN(endsAt.getTime())) return fail(response, 400, 'The end date is not a valid date.');
      if (endsAt < startsAt) return fail(response, 400, 'The end time cannot be before the start time.');
    }
    // An event that is already over cannot be posted as upcoming. This is the
    // guard that stops the old "stale events presented as current" problem.
    if (new Date(endsAt || startsAt) < new Date()) return fail(response, 400, 'That event has already finished.');
    const category = EVENT_CATEGORIES.includes(input(request.body.category)) ? input(request.body.category) : 'Community';
    const district = input(request.body.district).slice(0, 80) || request.user.district || null;
    const lat = request.body.lat ?? request.body.latitude;
    const lng = request.body.lng ?? request.body.longitude;
    const latNum = lat === '' || lat == null ? null : Number(lat);
    const lngNum = lng === '' || lng == null ? null : Number(lng);
    const sourceUrl = input(request.body.sourceUrl).slice(0, 500) || null;
    if (sourceUrl && !/^https?:\/\//i.test(sourceUrl)) return fail(response, 400, 'The source link must start with http:// or https://');
    let row;
    try {
      row = (await pool.query(
        `INSERT INTO events(created_by,title,description,category,district,venue,latitude,longitude,starts_at,ends_at,source,source_url)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [request.user.id, title, input(request.body.description).slice(0, 2000), category, district,
         input(request.body.venue).slice(0, 200) || null,
         Number.isFinite(latNum) ? latNum : null, Number.isFinite(lngNum) ? lngNum : null,
         startsAt.toISOString(), endsAt ? endsAt.toISOString() : null,
         request.user.is_admin ? 'admin' : 'member', sourceUrl]
      )).rows[0];
    } catch (error) {
      if (error && error.code === '23505') return fail(response, 409, 'That event has already been posted for this district and time.');
      throw error;
    }
    return ok(response, { event: row });
  } catch (error) { next(error); }
});

// Only the author (or an admin) may change or remove an event.
app.delete('/api/events/:eventId', async (request, response, next) => {
  try {
    const row = (await pool.query('SELECT created_by FROM events WHERE id=$1', [Number(request.params.eventId)])).rows[0];
    if (!row) return fail(response, 404, 'That event no longer exists.');
    if (Number(row.created_by) !== Number(request.user.id) && !request.user.is_admin) return fail(response, 403, 'Only the person who posted an event can remove it.');
    await pool.query('DELETE FROM events WHERE id=$1', [Number(request.params.eventId)]);
    return ok(response);
  } catch (error) { next(error); }
});

app.post('/api/events/:eventId/interest', async (request, response, next) => {
  try {
    const eventId = Number(request.params.eventId);
    const exists = (await pool.query('SELECT 1 FROM events WHERE id=$1', [eventId])).rows[0];
    if (!exists) return fail(response, 404, 'That event no longer exists.');
    const going = request.body.going === true || input(request.body.status) === 'going';
    if (request.body.interested === false) {
      await pool.query('DELETE FROM event_interest WHERE event_id=$1 AND user_id=$2', [eventId, request.user.id]);
      return ok(response, { interested: false });
    }
    await pool.query(
      `INSERT INTO event_interest(event_id,user_id,status) VALUES($1,$2,$3)
       ON CONFLICT(event_id,user_id) DO UPDATE SET status=EXCLUDED.status`,
      [eventId, request.user.id, going ? 'going' : 'interested']
    );
    return ok(response, { interested: true, status: going ? 'going' : 'interested' });
  } catch (error) { next(error); }
});

/* ---------- discovery deck (the swipe cards) ---------- */
// Real places and real upcoming events, minus anything this user already
// swiped away. Nothing is generated: if there is not enough local content the
// deck is short and the client shows an honest empty state.
app.get('/api/discover', async (request, response, next) => {
  try {
    const district = input(request.query.district) || request.user.district || '';
    const limit = Math.min(Math.max(Number(request.query.limit) || 20, 1), 50);
    const places = (await pool.query(
      `SELECT pl.id, pl.name, pl.address, pl.district, pl.category, pl.latitude, pl.longitude,
              (SELECT COUNT(*) FROM place_ratings r WHERE r.place_id = pl.id
                AND r.user_id IN ${CIRCLE_SQL})::int AS circle_reviews,
              (SELECT ROUND(AVG(r.rating)::numeric,1) FROM place_ratings r WHERE r.place_id = pl.id
                AND r.user_id IN ${CIRCLE_SQL}) AS circle_rating,
              (SELECT COUNT(*) FROM place_ratings r WHERE r.place_id = pl.id)::int AS total_reviews
         FROM places pl
        WHERE ($2 = '' OR pl.district = $2)
          AND NOT EXISTS (SELECT 1 FROM content_reactions c
                           WHERE c.user_id = $1 AND c.item_type = 'place' AND c.item_id = pl.id)
        ORDER BY (SELECT COUNT(*) FROM place_ratings r WHERE r.place_id = pl.id
                   AND r.user_id IN ${CIRCLE_SQL}) DESC, pl.created_at DESC
        LIMIT ${limit}`,
      [request.user.id, district]
    )).rows;
    const events = (await pool.query(
      `SELECT e.id, e.title, e.description, e.category, e.district, e.venue,
              e.starts_at, e.ends_at, e.latitude, e.longitude,
              u.display_name AS author_name,
              (SELECT COUNT(*) FROM event_interest i WHERE i.event_id = e.id
                AND i.user_id IN ${CIRCLE_SQL} AND i.user_id <> $1)::int AS circle_interest
         FROM events e JOIN users u ON u.id = e.created_by
        WHERE COALESCE(e.ends_at, e.starts_at) >= NOW()
          AND ($2 = '' OR e.district = $2)
          AND NOT EXISTS (SELECT 1 FROM content_reactions c
                           WHERE c.user_id = $1 AND c.item_type = 'event' AND c.item_id = e.id::text)
        ORDER BY e.starts_at ASC
        LIMIT ${limit}`,
      [request.user.id, district]
    )).rows;
    return ok(response, { places, events, district: district || null });
  } catch (error) { next(error); }
});

// Districts that actually have content, so the picker is not a hardcoded list.
app.get('/api/districts', async (request, response, next) => {
  try {
    const rows = (await pool.query(
      `SELECT d AS name,
              SUM(places_count)::int AS places,
              SUM(events_count)::int AS events
         FROM (
           SELECT district AS d, COUNT(*) AS places_count, 0 AS events_count
             FROM places WHERE district IS NOT NULL AND district <> '' GROUP BY district
           UNION ALL
           SELECT district AS d, 0 AS places_count, COUNT(*) AS events_count
             FROM events WHERE district IS NOT NULL AND district <> ''
               AND COALESCE(ends_at, starts_at) >= NOW() GROUP BY district
         ) t
        GROUP BY d ORDER BY d`
    )).rows;
    return ok(response, { districts: rows, mine: request.user.district || null });
  } catch (error) { next(error); }
});


/* ============================================================
   STAGE 3 — GROUP PLANNING
   Outings, polls, attendance, shortlists and the calendar.

   Access rules are enforced here in SQL, never in the client:
     - an outing is visible to its creator, its invited participants,
       and the members of its circle. Nobody else, ever.
     - a poll inherits its parent's access rule.
     - a single-choice poll replaces a member's previous vote inside a
       transaction, so one member can never hold two votes.
     - attendance has a per-row `visible` flag; counts shown to other
       people only ever count rows where it is true.
   ============================================================ */

// Membership test used by every outing route. Returns the outing row plus the
// caller's role, or null when the caller has no business seeing it.
async function outingAccess(outingId, userId) {
  const id = Number(outingId);
  if (!Number.isFinite(id)) return null;
  const row = (await pool.query(
    `SELECT o.*,
            (o.created_by = $2) AS is_owner,
            EXISTS (SELECT 1 FROM outing_participants p
                     WHERE p.outing_id = o.id AND p.user_id = $2) AS is_participant,
            EXISTS (SELECT 1 FROM circle_members m
                     WHERE m.circle_id = o.circle_id AND m.user_id = $2) AS is_circle_member,
            (SELECT rsvp FROM outing_participants p
              WHERE p.outing_id = o.id AND p.user_id = $2) AS my_rsvp
       FROM outings o WHERE o.id = $1`,
    [id, userId]
  )).rows[0];
  if (!row) return null;
  if (!row.is_owner && !row.is_participant && !row.is_circle_member) return null;
  return row;
}

// Everyone who may see an outing, used to fan out notifications.
async function outingAudience(outingId) {
  const rows = (await pool.query(
    `SELECT DISTINCT user_id FROM (
       SELECT created_by AS user_id FROM outings WHERE id = $1
       UNION SELECT user_id FROM outing_participants WHERE outing_id = $1
       UNION SELECT m.user_id FROM circle_members m
              JOIN outings o ON o.circle_id = m.circle_id WHERE o.id = $1
     ) t`, [outingId])).rows;
  return rows.map(r => Number(r.user_id));
}

const OUTING_STATUS = ['planning', 'voting', 'confirmed', 'completed', 'cancelled'];

/* ---------- outings ---------- */
app.get('/api/outings', async (request, response, next) => {
  try {
    const scope = input(request.query.scope); // '' | 'mine' | 'invited'
    const rows = (await pool.query(
      `SELECT o.*, u.display_name AS owner_name, u.profile_photo_url AS owner_photo,
              c.name AS circle_name,
              (o.created_by = $1) AS is_owner,
              (SELECT rsvp FROM outing_participants p WHERE p.outing_id=o.id AND p.user_id=$1) AS my_rsvp,
              (SELECT COUNT(*) FROM outing_options x WHERE x.outing_id=o.id)::int AS option_count,
              (SELECT COUNT(*) FROM outing_participants p WHERE p.outing_id=o.id)::int AS participant_count,
              (SELECT COUNT(*) FROM outing_participants p WHERE p.outing_id=o.id AND p.rsvp='yes')::int AS yes_count
         FROM outings o
         JOIN users u ON u.id = o.created_by
         LEFT JOIN circles c ON c.id = o.circle_id
        WHERE (o.created_by = $1
               OR EXISTS (SELECT 1 FROM outing_participants p WHERE p.outing_id=o.id AND p.user_id=$1)
               OR EXISTS (SELECT 1 FROM circle_members m WHERE m.circle_id=o.circle_id AND m.user_id=$1))
          AND ($2 = '' OR ($2='mine' AND o.created_by=$1) OR ($2='invited' AND o.created_by<>$1))
        ORDER BY (o.status IN ('planning','voting')) DESC,
                 COALESCE(o.proposed_date, o.created_at) ASC
        LIMIT 60`,
      [request.user.id, scope]
    )).rows;
    return ok(response, { outings: rows, statuses: OUTING_STATUS });
  } catch (error) { next(error); }
});

app.get('/api/outings/:outingId', async (request, response, next) => {
  try {
    const outing = await outingAccess(request.params.outingId, request.user.id);
    if (!outing) return fail(response, 404, 'That outing does not exist, or you were not invited to it.');
    const options = (await pool.query(
      `SELECT x.*, pl.name AS place_name, pl.address AS place_address, pl.district AS place_district,
              pl.category AS place_category, e.title AS event_title, e.starts_at AS event_starts_at,
              e.venue AS event_venue, u.display_name AS added_by_name,
              (SELECT COUNT(*) FROM poll_votes v
                 JOIN poll_options po ON po.id = v.option_id
                 JOIN polls p ON p.id = po.poll_id
                WHERE p.outing_id = x.outing_id
                  AND ((po.place_id IS NOT NULL AND po.place_id = x.place_id)
                    OR (po.event_id IS NOT NULL AND po.event_id = x.event_id)))::int AS votes
         FROM outing_options x
         JOIN users u ON u.id = x.added_by
         LEFT JOIN places pl ON pl.id = x.place_id
         LEFT JOIN events e ON e.id = x.event_id
        WHERE x.outing_id = $1 ORDER BY x.created_at ASC`, [outing.id])).rows;
    const participants = (await pool.query(
      `SELECT p.user_id, p.role, p.rsvp, u.display_name, u.username, u.profile_photo_url
         FROM outing_participants p JOIN users u ON u.id = p.user_id
        WHERE p.outing_id = $1 ORDER BY p.role DESC, u.display_name ASC`, [outing.id])).rows;
    const polls = (await pool.query(
      `SELECT id, question, allow_multiple, closes_at, closed_at, created_at
         FROM polls WHERE outing_id = $1 ORDER BY created_at DESC`, [outing.id])).rows;
    return ok(response, { outing, options, participants, polls });
  } catch (error) { next(error); }
});

app.post('/api/outings', async (request, response, next) => {
  const client = await pool.connect();
  try {
    const title = input(request.body.title).slice(0, 200);
    if (!title) return fail(response, 400, 'Give the outing a title.');
    let proposed = null;
    if (request.body.proposedDate) {
      proposed = new Date(request.body.proposedDate);
      if (Number.isNaN(proposed.getTime())) return fail(response, 400, 'That proposed date is not a valid date.');
    }
    const circleId = request.body.circleId ? Number(request.body.circleId) : null;
    // A circle may only be attached by one of its own members.
    if (circleId) {
      const member = (await client.query('SELECT 1 FROM circle_members WHERE circle_id=$1 AND user_id=$2', [circleId, request.user.id])).rows[0];
      if (!member) return fail(response, 403, 'You are not a member of that circle.');
    }
    // Invitees must be accepted connections, so an outing cannot be used to
    // push content at strangers.
    const inviteIds = [...new Set((request.body.inviteIds || []).map(Number).filter(n => n && n !== Number(request.user.id)))];
    for (const id of inviteIds) {
      const friend = (await client.query('SELECT 1 FROM connections WHERE user_id=$1 AND friend_id=$2', [request.user.id, id])).rows[0];
      if (!friend) return fail(response, 400, 'You can only invite people you are connected to.');
    }
    await client.query('BEGIN');
    const outing = (await client.query(
      `INSERT INTO outings(created_by,circle_id,title,description,proposed_date,district)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [request.user.id, circleId, title, input(request.body.description).slice(0, 2000),
       proposed ? proposed.toISOString() : null,
       input(request.body.district).slice(0, 80) || request.user.district || null]
    )).rows[0];
    await client.query(
      `INSERT INTO outing_participants(outing_id,user_id,role,rsvp) VALUES($1,$2,'owner','yes')
       ON CONFLICT DO NOTHING`, [outing.id, request.user.id]);
    for (const id of inviteIds) {
      await client.query(
        `INSERT INTO outing_participants(outing_id,user_id,role) VALUES($1,$2,'invitee')
         ON CONFLICT DO NOTHING`, [outing.id, id]);
    }
    await client.query('COMMIT');
    // Tell the people who were actually invited.
    for (const id of inviteIds) {
      await pool.query(
        `INSERT INTO notifications(user_id,type,title,body) VALUES($1,'outing_invite',$2,$3)`,
        [id, 'Outing invite', `${request.user.display_name} invited you to "${title}"`]
      ).catch(() => {});
      notifyUser(id, 'notification', { type: 'outing_invite', outingId: outing.id });
    }
    return ok(response, { outing });
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); next(error); }
  finally { client.release(); }
});

app.patch('/api/outings/:outingId', async (request, response, next) => {
  try {
    const outing = await outingAccess(request.params.outingId, request.user.id);
    if (!outing) return fail(response, 404, 'That outing does not exist, or you were not invited to it.');
    if (!outing.is_owner) return fail(response, 403, 'Only the person who created an outing can change it.');
    const status = input(request.body.status);
    if (status && !OUTING_STATUS.includes(status)) return fail(response, 400, 'That is not a valid outing status.');
    const title = request.body.title === undefined ? outing.title : (input(request.body.title).slice(0, 200) || outing.title);
    const description = request.body.description === undefined ? outing.description : input(request.body.description).slice(0, 2000);
    let proposed = outing.proposed_date;
    if (request.body.proposedDate !== undefined) {
      if (!request.body.proposedDate) proposed = null;
      else {
        const d = new Date(request.body.proposedDate);
        if (Number.isNaN(d.getTime())) return fail(response, 400, 'That proposed date is not a valid date.');
        proposed = d.toISOString();
      }
    }
    // Confirming an outing may name the winning option, which must belong to it.
    let decided = outing.decided_option_id;
    if (request.body.decidedOptionId !== undefined) {
      if (!request.body.decidedOptionId) decided = null;
      else {
        const opt = (await pool.query('SELECT 1 FROM outing_options WHERE id=$1 AND outing_id=$2',
          [Number(request.body.decidedOptionId), outing.id])).rows[0];
        if (!opt) return fail(response, 400, 'That option does not belong to this outing.');
        decided = Number(request.body.decidedOptionId);
      }
    }
    const row = (await pool.query(
      `UPDATE outings SET title=$1, description=$2, proposed_date=$3,
              status=$4, decided_option_id=$5, updated_at=NOW()
        WHERE id=$6 RETURNING *`,
      [title, description, proposed, status || outing.status, decided, outing.id]
    )).rows[0];
    if (status && status !== outing.status) {
      for (const id of await outingAudience(outing.id)) {
        if (Number(id) === Number(request.user.id)) continue;
        notifyUser(id, 'notification', { type: 'outing_status', outingId: outing.id, status });
      }
    }
    return ok(response, { outing: row });
  } catch (error) { next(error); }
});

app.delete('/api/outings/:outingId', async (request, response, next) => {
  try {
    const outing = await outingAccess(request.params.outingId, request.user.id);
    if (!outing) return fail(response, 404, 'That outing does not exist, or you were not invited to it.');
    if (!outing.is_owner) return fail(response, 403, 'Only the person who created an outing can delete it.');
    await pool.query('DELETE FROM outings WHERE id=$1', [outing.id]);
    return ok(response);
  } catch (error) { next(error); }
});

// RSVP. Any participant may set their own, and only their own.
app.post('/api/outings/:outingId/rsvp', async (request, response, next) => {
  try {
    const outing = await outingAccess(request.params.outingId, request.user.id);
    if (!outing) return fail(response, 404, 'That outing does not exist, or you were not invited to it.');
    const rsvp = input(request.body.rsvp);
    if (!['pending', 'yes', 'no', 'maybe'].includes(rsvp)) return fail(response, 400, 'Pick yes, no or maybe.');
    await pool.query(
      `INSERT INTO outing_participants(outing_id,user_id,role,rsvp) VALUES($1,$2,'invitee',$3)
       ON CONFLICT(outing_id,user_id) DO UPDATE SET rsvp=EXCLUDED.rsvp`,
      [outing.id, request.user.id, rsvp]);
    return ok(response, { rsvp });
  } catch (error) { next(error); }
});

// Add a real place or event as an option.
app.post('/api/outings/:outingId/options', async (request, response, next) => {
  try {
    const outing = await outingAccess(request.params.outingId, request.user.id);
    if (!outing) return fail(response, 404, 'That outing does not exist, or you were not invited to it.');
    if (['completed', 'cancelled'].includes(outing.status)) return fail(response, 400, 'That outing is closed.');
    const kind = input(request.body.kind);
    if (!['place', 'event'].includes(kind)) return fail(response, 400, 'An option must be a place or an event.');
    let placeId = null, eventId = null;
    if (kind === 'place') {
      placeId = input(request.body.placeId);
      if (!placeId) return fail(response, 400, 'Which place?');
      const exists = (await pool.query('SELECT 1 FROM places WHERE id=$1', [placeId])).rows[0];
      if (!exists) return fail(response, 400, 'That place is not in the catalogue.');
    } else {
      eventId = Number(request.body.eventId);
      const exists = (await pool.query('SELECT 1 FROM events WHERE id=$1', [eventId])).rows[0];
      if (!exists) return fail(response, 400, 'That event no longer exists.');
    }
    let row;
    try {
      row = (await pool.query(
        `INSERT INTO outing_options(outing_id,kind,place_id,event_id,note,added_by)
         VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
        [outing.id, kind, placeId, eventId, input(request.body.note).slice(0, 500), request.user.id]
      )).rows[0];
    } catch (error) {
      if (error && error.code === '23505') return fail(response, 409, 'That option is already on this outing.');
      throw error;
    }
    return ok(response, { option: row });
  } catch (error) { next(error); }
});

app.delete('/api/outings/:outingId/options/:optionId', async (request, response, next) => {
  try {
    const outing = await outingAccess(request.params.outingId, request.user.id);
    if (!outing) return fail(response, 404, 'That outing does not exist, or you were not invited to it.');
    const opt = (await pool.query('SELECT * FROM outing_options WHERE id=$1 AND outing_id=$2',
      [Number(request.params.optionId), outing.id])).rows[0];
    if (!opt) return fail(response, 404, 'That option is not on this outing.');
    // Whoever added it, or the outing owner, may remove it.
    if (Number(opt.added_by) !== Number(request.user.id) && !outing.is_owner) {
      return fail(response, 403, 'Only the person who added an option, or the outing owner, can remove it.');
    }
    await pool.query('DELETE FROM outing_options WHERE id=$1', [opt.id]);
    return ok(response);
  } catch (error) { next(error); }
});

/* ---------- polls ---------- */
// Access to a poll is exactly the access to its parent circle or outing.
async function pollAccess(pollId, userId) {
  const id = Number(pollId);
  if (!Number.isFinite(id)) return null;
  const row = (await pool.query(
    `SELECT p.*, (p.created_by = $2) AS is_owner,
            (p.closed_at IS NOT NULL OR (p.closes_at IS NOT NULL AND p.closes_at <= NOW())) AS is_closed
       FROM polls p WHERE p.id = $1`, [id, userId])).rows[0];
  if (!row) return null;
  if (row.circle_id) {
    const m = (await pool.query('SELECT 1 FROM circle_members WHERE circle_id=$1 AND user_id=$2', [row.circle_id, userId])).rows[0];
    if (!m) return null;
  } else if (row.outing_id) {
    const o = await outingAccess(row.outing_id, userId);
    if (!o) return null;
  } else return null;
  return row;
}
async function pollPayload(poll, userId) {
  const options = (await pool.query(
    `SELECT o.id, o.label, o.place_id, o.event_id, o.position,
            pl.name AS place_name, e.title AS event_title, e.starts_at AS event_starts_at,
            (SELECT COUNT(*) FROM poll_votes v WHERE v.option_id = o.id)::int AS votes,
            EXISTS (SELECT 1 FROM poll_votes v WHERE v.option_id = o.id AND v.user_id = $2) AS my_vote
       FROM poll_options o
       LEFT JOIN places pl ON pl.id = o.place_id
       LEFT JOIN events e ON e.id = o.event_id
      WHERE o.poll_id = $1 ORDER BY o.position ASC, o.id ASC`, [poll.id, userId])).rows;
  const voters = (await pool.query(
    'SELECT COUNT(DISTINCT user_id)::int AS n FROM poll_votes WHERE poll_id=$1', [poll.id])).rows[0];
  return { poll, options, voterCount: voters.n };
}

app.get('/api/polls', async (request, response, next) => {
  try {
    const circleId = request.query.circleId ? Number(request.query.circleId) : null;
    const outingId = request.query.outingId ? Number(request.query.outingId) : null;
    if (circleId) {
      const m = (await pool.query('SELECT 1 FROM circle_members WHERE circle_id=$1 AND user_id=$2', [circleId, request.user.id])).rows[0];
      if (!m) return fail(response, 403, 'You are not a member of that circle.');
    }
    if (outingId && !(await outingAccess(outingId, request.user.id))) {
      return fail(response, 404, 'That outing does not exist, or you were not invited to it.');
    }
    const rows = (await pool.query(
      `SELECT p.*, u.display_name AS owner_name, c.name AS circle_name,
              (p.created_by=$1) AS is_owner,
              (p.closed_at IS NOT NULL OR (p.closes_at IS NOT NULL AND p.closes_at <= NOW())) AS is_closed,
              (SELECT COUNT(DISTINCT v.user_id) FROM poll_votes v WHERE v.poll_id=p.id)::int AS voter_count,
              EXISTS (SELECT 1 FROM poll_votes v WHERE v.poll_id=p.id AND v.user_id=$1) AS i_voted
         FROM polls p
         JOIN users u ON u.id=p.created_by
         LEFT JOIN circles c ON c.id=p.circle_id
        WHERE ($2::bigint IS NULL OR p.circle_id=$2)
          AND ($3::bigint IS NULL OR p.outing_id=$3)
          AND (EXISTS (SELECT 1 FROM circle_members m WHERE m.circle_id=p.circle_id AND m.user_id=$1)
            OR EXISTS (SELECT 1 FROM outings o WHERE o.id=p.outing_id
                        AND (o.created_by=$1
                          OR EXISTS (SELECT 1 FROM outing_participants op WHERE op.outing_id=o.id AND op.user_id=$1)
                          OR EXISTS (SELECT 1 FROM circle_members m2 WHERE m2.circle_id=o.circle_id AND m2.user_id=$1))))
        ORDER BY p.created_at DESC LIMIT 50`,
      [request.user.id, circleId, outingId]
    )).rows;
    return ok(response, { polls: rows });
  } catch (error) { next(error); }
});

app.get('/api/polls/:pollId', async (request, response, next) => {
  try {
    const poll = await pollAccess(request.params.pollId, request.user.id);
    if (!poll) return fail(response, 404, 'That poll does not exist, or you cannot see it.');
    return ok(response, await pollPayload(poll, request.user.id));
  } catch (error) { next(error); }
});

app.post('/api/polls', async (request, response, next) => {
  const client = await pool.connect();
  try {
    const question = input(request.body.question).slice(0, 300);
    if (!question) return fail(response, 400, 'What is the question?');
    const circleId = request.body.circleId ? Number(request.body.circleId) : null;
    const outingId = request.body.outingId ? Number(request.body.outingId) : null;
    if (!circleId && !outingId) return fail(response, 400, 'A poll must belong to a circle or an outing.');
    if (circleId) {
      const m = (await client.query('SELECT 1 FROM circle_members WHERE circle_id=$1 AND user_id=$2', [circleId, request.user.id])).rows[0];
      if (!m) return fail(response, 403, 'You are not a member of that circle.');
    }
    if (outingId && !(await outingAccess(outingId, request.user.id))) {
      return fail(response, 404, 'That outing does not exist, or you were not invited to it.');
    }
    const options = (request.body.options || []).map(o => (typeof o === 'string' ? { label: o } : o))
      .filter(o => o && (input(o.label) || o.placeId || o.eventId)).slice(0, 10);
    if (options.length < 2) return fail(response, 400, 'Give the poll at least two options.');
    let closesAt = null;
    if (request.body.closesAt) {
      closesAt = new Date(request.body.closesAt);
      if (Number.isNaN(closesAt.getTime())) return fail(response, 400, 'That closing time is not a valid date.');
      if (closesAt <= new Date()) return fail(response, 400, 'The closing time has to be in the future.');
    }
    await client.query('BEGIN');
    const poll = (await client.query(
      `INSERT INTO polls(created_by,circle_id,outing_id,question,allow_multiple,closes_at)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [request.user.id, circleId, outingId, question, request.body.allowMultiple === true,
       closesAt ? closesAt.toISOString() : null]
    )).rows[0];
    let pos = 0;
    for (const o of options) {
      const placeId = input(o.placeId) || null;
      const eventId = o.eventId ? Number(o.eventId) : null;
      let label = input(o.label).slice(0, 200);
      if (!label && placeId) {
        label = (await client.query('SELECT name FROM places WHERE id=$1', [placeId])).rows[0]?.name || placeId;
      }
      if (!label && eventId) {
        label = (await client.query('SELECT title FROM events WHERE id=$1', [eventId])).rows[0]?.title || ('Event ' + eventId);
      }
      await client.query(
        `INSERT INTO poll_options(poll_id,label,place_id,event_id,position) VALUES($1,$2,$3,$4,$5)`,
        [poll.id, label || ('Option ' + (pos + 1)), placeId, eventId, pos++]);
    }
    await client.query('COMMIT');
    // Notify the group the poll belongs to.
    const audience = circleId
      ? (await pool.query('SELECT user_id FROM circle_members WHERE circle_id=$1', [circleId])).rows.map(r => Number(r.user_id))
      : await outingAudience(outingId);
    for (const id of audience) {
      if (Number(id) === Number(request.user.id)) continue;
      await pool.query(`INSERT INTO notifications(user_id,type,title,body) VALUES($1,'poll_new',$2,$3)`,
        [id, 'New poll', `${request.user.display_name}: ${question}`]).catch(() => {});
      notifyUser(id, 'notification', { type: 'poll_new', pollId: poll.id });
    }
    return ok(response, await pollPayload(poll, request.user.id));
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); next(error); }
  finally { client.release(); }
});

// The creator may change the options, but only while nobody has voted and the
// poll is still open — otherwise earlier votes would silently change meaning.
app.patch('/api/polls/:pollId', async (request, response, next) => {
  const client = await pool.connect();
  try {
    const poll = await pollAccess(request.params.pollId, request.user.id);
    if (!poll) return fail(response, 404, 'That poll does not exist, or you cannot see it.');
    if (!poll.is_owner) return fail(response, 403, 'Only the person who created a poll can change it.');
    if (request.body.close === true) {
      const row = (await client.query('UPDATE polls SET closed_at=NOW() WHERE id=$1 RETURNING *', [poll.id])).rows[0];
      return ok(response, await pollPayload(row, request.user.id));
    }
    if (poll.is_closed) return fail(response, 400, 'That poll is closed.');
    if (Array.isArray(request.body.options)) {
      const voted = (await client.query('SELECT 1 FROM poll_votes WHERE poll_id=$1 LIMIT 1', [poll.id])).rows[0];
      if (voted) return fail(response, 400, 'People have already voted, so the options can no longer be changed. Close this poll and start a new one.');
      const options = request.body.options.map(o => (typeof o === 'string' ? { label: o } : o))
        .filter(o => o && (input(o.label) || o.placeId || o.eventId)).slice(0, 10);
      if (options.length < 2) return fail(response, 400, 'Give the poll at least two options.');
      await client.query('BEGIN');
      await client.query('DELETE FROM poll_options WHERE poll_id=$1', [poll.id]);
      let pos = 0;
      for (const o of options) {
        await client.query(`INSERT INTO poll_options(poll_id,label,place_id,event_id,position) VALUES($1,$2,$3,$4,$5)`,
          [poll.id, input(o.label).slice(0, 200) || ('Option ' + (pos + 1)), input(o.placeId) || null,
           o.eventId ? Number(o.eventId) : null, pos++]);
      }
      await client.query('COMMIT');
    }
    const question = request.body.question === undefined ? poll.question : (input(request.body.question).slice(0, 300) || poll.question);
    const row = (await client.query('UPDATE polls SET question=$1 WHERE id=$2 RETURNING *', [question, poll.id])).rows[0];
    return ok(response, await pollPayload(row, request.user.id));
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); next(error); }
  finally { client.release(); }
});

// Voting. One vote per member unless the creator allowed multiple; the replace
// happens inside a transaction so a double-submit cannot leave two rows.
app.post('/api/polls/:pollId/vote', async (request, response, next) => {
  const client = await pool.connect();
  try {
    const poll = await pollAccess(request.params.pollId, request.user.id);
    if (!poll) return fail(response, 404, 'That poll does not exist, or you cannot see it.');
    if (poll.is_closed) return fail(response, 400, 'That poll has closed.');
    const ids = [...new Set((Array.isArray(request.body.optionIds) ? request.body.optionIds
      : [request.body.optionId]).map(Number).filter(Number.isFinite))];
    if (!ids.length) return fail(response, 400, 'Pick an option.');
    if (!poll.allow_multiple && ids.length > 1) return fail(response, 400, 'This poll allows one choice only.');
    const owned = (await client.query('SELECT id FROM poll_options WHERE poll_id=$1 AND id = ANY($2::bigint[])',
      [poll.id, ids])).rows.map(r => Number(r.id));
    if (owned.length !== ids.length) return fail(response, 400, 'One of those options does not belong to this poll.');
    await client.query('BEGIN');
    if (!poll.allow_multiple) {
      await client.query('DELETE FROM poll_votes WHERE poll_id=$1 AND user_id=$2', [poll.id, request.user.id]);
    }
    for (const id of owned) {
      await client.query(
        `INSERT INTO poll_votes(poll_id,option_id,user_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
        [poll.id, id, request.user.id]);
    }
    await client.query('COMMIT');
    return ok(response, await pollPayload(poll, request.user.id));
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); next(error); }
  finally { client.release(); }
});

app.delete('/api/polls/:pollId/vote', async (request, response, next) => {
  try {
    const poll = await pollAccess(request.params.pollId, request.user.id);
    if (!poll) return fail(response, 404, 'That poll does not exist, or you cannot see it.');
    if (poll.is_closed) return fail(response, 400, 'That poll has closed.');
    await pool.query('DELETE FROM poll_votes WHERE poll_id=$1 AND user_id=$2', [poll.id, request.user.id]);
    return ok(response, await pollPayload(poll, request.user.id));
  } catch (error) { next(error); }
});

/* ---------- who's going ---------- */
// Attendance is not public. `visible` defaults to true but the owner can hide
// it, and every count returned to anyone else only counts visible rows.
app.get('/api/events/:eventId/attendance', async (request, response, next) => {
  try {
    const eventId = Number(request.params.eventId);
    const exists = (await pool.query('SELECT 1 FROM events WHERE id=$1', [eventId])).rows[0];
    if (!exists) return fail(response, 404, 'That event no longer exists.');
    const mine = (await pool.query('SELECT status, visible FROM event_interest WHERE event_id=$1 AND user_id=$2',
      [eventId, request.user.id])).rows[0] || null;
    const counts = (await pool.query(
      `SELECT status, COUNT(*)::int AS n FROM event_interest
        WHERE event_id=$1 AND (visible = TRUE OR user_id = $2)
        GROUP BY status`, [eventId, request.user.id])).rows;
    // Named attendees: only people in the caller's circle who chose to be visible.
    const circle = (await pool.query(
      `SELECT i.status, u.id, u.username, u.display_name, u.profile_photo_url
         FROM event_interest i JOIN users u ON u.id = i.user_id
        WHERE i.event_id = $1 AND i.visible = TRUE AND i.status IN ('interested','going')
          AND i.user_id IN (SELECT friend_id FROM connections WHERE user_id = $2)
        ORDER BY i.status DESC, u.display_name ASC LIMIT 40`, [eventId, request.user.id])).rows;
    return ok(response, {
      me: mine,
      counts: counts.reduce((a, r) => (a[r.status] = r.n, a), { interested: 0, going: 0, not_going: 0 }),
      circleAttendees: circle
    });
  } catch (error) { next(error); }
});

app.post('/api/events/:eventId/attendance', async (request, response, next) => {
  try {
    const eventId = Number(request.params.eventId);
    const exists = (await pool.query('SELECT 1 FROM events WHERE id=$1', [eventId])).rows[0];
    if (!exists) return fail(response, 404, 'That event no longer exists.');
    const status = input(request.body.status);
    if (status === 'clear') {
      await pool.query('DELETE FROM event_interest WHERE event_id=$1 AND user_id=$2', [eventId, request.user.id]);
      return ok(response, { me: null });
    }
    if (!['interested', 'going', 'not_going'].includes(status)) {
      return fail(response, 400, 'Status must be interested, going or not_going.');
    }
    const visible = request.body.visible === undefined ? true : request.body.visible === true;
    const row = (await pool.query(
      `INSERT INTO event_interest(event_id,user_id,status,visible) VALUES($1,$2,$3,$4)
       ON CONFLICT(event_id,user_id) DO UPDATE SET status=EXCLUDED.status, visible=EXCLUDED.visible, updated_at=NOW()
       RETURNING status, visible`,
      [eventId, request.user.id, status, visible])).rows[0];
    return ok(response, { me: row });
  } catch (error) { next(error); }
});

/* ---------- shortlist (swipe-right) ---------- */
// Swipe decisions already persist in content_reactions. This reads the keeps
// back so "Shortlist" survives a refresh and a device change.
app.get('/api/shortlist', async (request, response, next) => {
  try {
    const places = (await pool.query(
      `SELECT pl.id, pl.name, pl.address, pl.district, pl.category, c.created_at AS saved_at
         FROM content_reactions c JOIN places pl ON pl.id = c.item_id
        WHERE c.user_id=$1 AND c.item_type='place' AND c.reaction='like'
        ORDER BY c.created_at DESC LIMIT 100`, [request.user.id])).rows;
    const events = (await pool.query(
      `SELECT e.id, e.title, e.description, e.category, e.district, e.venue, e.starts_at, e.ends_at,
              c.created_at AS saved_at
         FROM content_reactions c JOIN events e ON e.id::text = c.item_id
        WHERE c.user_id=$1 AND c.item_type='event' AND c.reaction='like'
          AND COALESCE(e.ends_at, e.starts_at) >= NOW()
        ORDER BY e.starts_at ASC LIMIT 100`, [request.user.id])).rows;
    return ok(response, { places, events });
  } catch (error) { next(error); }
});

app.delete('/api/shortlist/:kind/:itemId', async (request, response, next) => {
  try {
    const kind = input(request.params.kind);
    if (!['place', 'event'].includes(kind)) return fail(response, 400, 'Not a shortlist kind.');
    await pool.query('DELETE FROM content_reactions WHERE user_id=$1 AND item_type=$2 AND item_id=$3',
      [request.user.id, kind, input(request.params.itemId)]);
    return ok(response);
  } catch (error) { next(error); }
});

/* ---------- calendar ---------- */
// One read-only view over three genuinely different kinds of date, kept
// distinguishable rather than flattened: an official event date, a user-created
// outing date, and a shortlisted event. Past items are never returned.
app.get('/api/calendar', async (request, response, next) => {
  try {
    const days = Math.min(Math.max(Number(request.query.days) || 60, 1), 365);
    const rows = (await pool.query(
      `SELECT 'event' AS kind, e.id::text AS id, e.title, e.starts_at AS at, e.ends_at,
              e.venue, e.district, e.category, i.status AS my_status, NULL::text AS outing_status
         FROM event_interest i JOIN events e ON e.id = i.event_id
        WHERE i.user_id = $1 AND i.status IN ('interested','going')
          AND COALESCE(e.ends_at, e.starts_at) BETWEEN NOW() - INTERVAL '1 day' AND NOW() + ($2 || ' days')::interval
       UNION ALL
       SELECT 'shortlist' AS kind, e.id::text, e.title, e.starts_at, e.ends_at,
              e.venue, e.district, e.category, NULL, NULL
         FROM content_reactions c JOIN events e ON e.id::text = c.item_id
        WHERE c.user_id = $1 AND c.item_type='event' AND c.reaction='like'
          AND NOT EXISTS (SELECT 1 FROM event_interest i2 WHERE i2.event_id=e.id AND i2.user_id=$1)
          AND COALESCE(e.ends_at, e.starts_at) BETWEEN NOW() - INTERVAL '1 day' AND NOW() + ($2 || ' days')::interval
       UNION ALL
       SELECT 'outing' AS kind, o.id::text, o.title, o.proposed_date, NULL,
              NULL, o.district, NULL, p.rsvp, o.status
         FROM outings o
         LEFT JOIN outing_participants p ON p.outing_id=o.id AND p.user_id=$1
        WHERE o.proposed_date IS NOT NULL
          AND o.status NOT IN ('cancelled','completed')
          AND (o.created_by=$1
            OR EXISTS (SELECT 1 FROM outing_participants p2 WHERE p2.outing_id=o.id AND p2.user_id=$1)
            OR EXISTS (SELECT 1 FROM circle_members m WHERE m.circle_id=o.circle_id AND m.user_id=$1))
          AND o.proposed_date BETWEEN NOW() - INTERVAL '1 day' AND NOW() + ($2 || ' days')::interval
       ORDER BY at ASC`,
      [request.user.id, String(days)]
    )).rows;
    return ok(response, { items: rows, from: new Date().toISOString(), days });
  } catch (error) { next(error); }
});

app.get('/react', (_request, response) => response.sendFile(path.join(clientDist, 'index.html')));
app.get('*', (_request, response) => response.sendFile(path.join(root, 'socialcircle.html')));


/* ============================================================
   PLACE CATALOGUE SEED
   Real, verifiable Delhi-NCR locations: name, address, district,
   category and coordinates. This is factual place information so
   "Discover Places" is not empty on a fresh install — it carries
   NO ratings, NO review text and NO social proof. Every rating or
   review in the app is written by a real signed-in member.
   ON CONFLICT DO NOTHING, so a place edited later is never
   overwritten by a redeploy.
   ============================================================ */
const SEED_PLACES = [
  ['seed:kunzum-hauz-khas', 'Kunzum Travel Cafe', 'Hauz Khas Village, New Delhi', 'South Delhi', 'Cafe', 28.5540, 77.1946],
  ['seed:sunder-nursery', 'Sunder Nursery', 'Nizamuddin, New Delhi', 'South East Delhi', 'Outdoors', 28.5980, 77.2500],
  ['seed:hauz-khas-lake', 'Hauz Khas Lake and Deer Park', 'Deer Park Road, Hauz Khas, New Delhi', 'South Delhi', 'Outdoors', 28.5565, 77.2010],
  ['seed:cp-inner-circle', 'Connaught Place Inner Circle', 'Inner Circle, Connaught Place, New Delhi', 'New Delhi', 'Market', 28.6330, 77.2195],
  ['seed:champa-gali', 'Champa Gali', 'Saidulajab, Saket, New Delhi', 'South Delhi', 'Arts', 28.5300, 77.2010],
  ['seed:select-citywalk', 'Select Citywalk', 'District Centre, Saket, New Delhi', 'South Delhi', 'Shopping', 28.5280, 77.2190],
  ['seed:dilli-haat', 'Dilli Haat INA', 'Sri Aurobindo Marg, INA, New Delhi', 'South Delhi', 'Market', 28.5736, 77.2088],
  ['seed:lodhi-art-district', 'Lodhi Art District', 'Lodhi Colony, New Delhi', 'South East Delhi', 'Arts', 28.5830, 77.2270],
  ['seed:humayuns-tomb', "Humayun's Tomb", 'Mathura Road, Nizamuddin East, New Delhi', 'South East Delhi', 'Heritage', 28.5933, 77.2507],
  ['seed:qutub-minar', 'Qutub Minar', 'Mehrauli, New Delhi', 'South Delhi', 'Heritage', 28.5245, 77.1855],
  ['seed:red-fort', 'Red Fort', 'Netaji Subhash Marg, Chandni Chowk, Delhi', 'Central Delhi', 'Heritage', 28.6562, 77.2410],
  ['seed:chandni-chowk', 'Chandni Chowk Market', 'Chandni Chowk, Delhi', 'Central Delhi', 'Market', 28.6506, 77.2303],
  ['seed:cyber-hub', 'DLF CyberHub', 'DLF Cyber City, Gurugram', 'Gurugram', 'Food', 28.4950, 77.0890],
  ['seed:vasant-kunj-market', 'Vasant Kunj Market', 'Vasant Kunj, New Delhi', 'South West Delhi', 'Cafe', 28.5215, 77.1560],
  ['seed:india-gate', 'India Gate and Kartavya Path', 'Rajpath Area, New Delhi', 'New Delhi', 'Outdoors', 28.6129, 77.2295],
  ['seed:majnu-ka-tila', 'Majnu ka Tila', 'New Aruna Nagar, Civil Lines, Delhi', 'North Delhi', 'Food', 28.7041, 77.2280],
  ['seed:north-campus', 'Delhi University North Campus', 'University Enclave, Delhi', 'North Delhi', 'Education', 28.6889, 77.2089],
  ['seed:nehru-place', 'Nehru Place', 'Nehru Place, New Delhi', 'South East Delhi', 'Shopping', 28.5483, 77.2513],
  ['seed:jnu-campus', 'Jawaharlal Nehru University', 'New Mehrauli Road, New Delhi', 'South West Delhi', 'Education', 28.5383, 77.1641],
  ['seed:iit-delhi', 'IIT Delhi', 'Hauz Khas, New Delhi', 'South Delhi', 'Education', 28.5450, 77.1926]
];
async function seedPlaceCatalogue() {
  for (const [id, name, address, district, category, lat, lng] of SEED_PLACES) {
    await pool.query(
      `INSERT INTO places(id,name,address,district,category,latitude,longitude)
       VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING`,
      [id, name, address, district, category, lat, lng]
    );
  }
}

async function initialize() { await pool.query(fs.readFileSync(path.join(root, 'schema.sql'), 'utf8')); const password = process.env.ADMIN_PASSWORD || 'admin@123'; await pool.query(`INSERT INTO users(username,email,password_hash,display_name,is_admin) VALUES('admin','admin@socialcircle.local',$1,'Administrator',TRUE) ON CONFLICT(username) DO UPDATE SET password_hash=EXCLUDED.password_hash,is_admin=TRUE`, [await hashPassword(password)]); await seedPlaceCatalogue(); }
initialize().catch(error => { console.error('Database startup failed:', error.message); process.exit(1); });
module.exports = { createApp: () => app, addClient, notifyUser, isUserOnline, endStaleCallsFor, isCallPair };
