const clients = new Map();

function addClient(userId, socket) {
  const key = Number(userId);
  if (!clients.has(key)) clients.set(key, new Set());
  clients.get(key).add(socket);
  socket.on('close', () => { const userClients = clients.get(key); if (!userClients) return; userClients.delete(socket); if (!userClients.size) clients.delete(key); });
}
function notifyUser(userId, event, data) {
  const userClients = clients.get(Number(userId));
  if (!userClients) return;
  const payload = JSON.stringify({ event, data });
  userClients.forEach(socket => { if (socket.readyState === 1) socket.send(payload); });
}
module.exports = { addClient, notifyUser };
