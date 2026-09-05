const { createApp } = require('./src/app');
const http = require('http');
const { currentUser } = require('./src/auth');
let WebSocketServer = null;
let addClient = () => {};
let notifyUser = () => {};
try {
  ({ WebSocketServer } = require('ws'));
  ({ addClient, notifyUser } = require('./src/realtime'));
} catch (error) {
  console.warn('Realtime transport unavailable; starting HTTP server only.');
}

const port = Number(process.env.PORT) || 3000;
const app = createApp();
const server = http.createServer(app);
const sockets = WebSocketServer ? new WebSocketServer({ server, path: '/realtime' }) : null;
if (sockets) sockets.on('connection', async (socket, request) => {
  const user = await currentUser({ headers: request.headers }).catch(() => null);
  if (!user) return socket.close(1008, 'Authentication required');
  addClient(user.id, socket);
  socket.send(JSON.stringify({ event: 'realtime:ready', data: { userId: user.id } }));
  socket.on('message', raw => {
    try {
      const message = JSON.parse(raw.toString());
      if (message.event === 'call:signal' && message.data?.toUserId) notifyUser(message.data.toUserId, 'call:signal', { ...message.data, fromUserId: user.id });
    } catch { /* Ignore malformed realtime messages. */ }
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Social Circle listening on port ${port}`);
});
