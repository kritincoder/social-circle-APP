const { createApp } = require('./src/app');
const http = require('http');
const { WebSocketServer } = require('ws');
const { currentUser } = require('./src/auth');
const { addClient, notifyUser } = require('./src/realtime');

const port = Number(process.env.PORT) || 3000;
const app = createApp();
const server = http.createServer(app);
const sockets = new WebSocketServer({ server, path: '/realtime' });
sockets.on('connection', async (socket, request) => {
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
