const { createApp, addClient, notifyUser, isUserOnline, endStaleCallsFor, isCallPair } = require('./src/app');
const http = require('http');
const { currentUser } = require('./src/auth');
let WebSocketServer = null;
try {
  ({ WebSocketServer } = require('ws'));
} catch (error) {
  console.error('FATAL: the "ws" package is missing, so realtime messaging and calling cannot work. Run npm install.');
}

const ALLOWED_REACTIONS = new Set(['thumbsup','heart','laugh','clap','wow','party']);

const port = Number(process.env.PORT) || 3000;
const app = createApp();
const server = http.createServer(app);
const sockets = WebSocketServer ? new WebSocketServer({ server, path: '/realtime' }) : null;

if (sockets) sockets.on('connection', async (socket, request) => {
  const user = await currentUser({ headers: request.headers }).catch(() => null);
  if (!user) return socket.close(1008, 'Authentication required');
  addClient(user.id, socket);
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });
  socket.send(JSON.stringify({ event: 'realtime:ready', data: { userId: user.id } }));

  socket.on('message', raw => {
    try {
      const message = JSON.parse(raw.toString());
      // Client keepalive; nothing to do but keep the connection warm.
      if (message.event === 'ping') { socket.isAlive = true; return; }
      // WebRTC signalling relay: SDP offers/answers and ICE candidates are passed
      // straight through to the addressed user, stamped with the real sender id so
      // the recipient can never be spoofed by the payload.
      if (message.event === 'call:signal' && message.data && message.data.toUserId) {
        notifyUser(message.data.toUserId, 'call:signal', { ...message.data, fromUserId: user.id });
        return;
      }
      // In-call reactions. Authorised server-side: the sender must be a participant
      // of that call and the recipient must be the other participant, so a reaction
      // can never be delivered to an unrelated user. Nothing is persisted.
      if (message.event === 'call:reaction' && message.data && message.data.toUserId && message.data.callId) {
        const allowed = ALLOWED_REACTIONS.has(String(message.data.reaction));
        if (!allowed) return;
        isCallPair(message.data.callId, user.id, message.data.toUserId).then(okPair => {
          if (!okPair) return;
          notifyUser(message.data.toUserId, 'call:reaction', {
            callId: message.data.callId, reaction: String(message.data.reaction), fromUserId: user.id
          });
        }).catch(() => {});
      }
    } catch { /* Ignore malformed realtime messages. */ }
  });

  // When a user's last socket goes away, end any call they were in so the other
  // side stops ringing instead of hanging on a call that can never connect.
  socket.on('close', () => {
    setTimeout(() => {
      if (!isUserOnline(user.id)) endStaleCallsFor(user.id);
    }, 1500); // brief grace period for a page reload reconnecting
  });
});

// Drop sockets that stopped answering, so the registry does not accumulate
// half-open connections that silently swallow notifications.
const heartbeat = sockets ? setInterval(() => {
  sockets.clients.forEach(socket => {
    if (socket.isAlive === false) return socket.terminate();
    socket.isAlive = false;
    try { socket.ping(); } catch { /* socket already gone */ }
  });
}, 30000) : null;
if (sockets) sockets.on('close', () => { if (heartbeat) clearInterval(heartbeat); });

server.listen(port, '0.0.0.0', () => {
  console.log(`Social Circle listening on port ${port}`);
  console.log(sockets ? 'Realtime transport ready on /realtime' : 'Realtime transport DISABLED (ws package missing)');
});
