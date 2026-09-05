const clients = new Map();

function addClient(userId, socket) {
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(socket);
  socket.on('close', () => { const userClients = clients.get(userId); if (!userClients) return; userClients.delete(socket); if (!userClients.size) clients.delete(userId); });
}
function notifyUser(userId, event, data) {
  const userClients = clients.get(Number(userId));
  if (!userClients) return;
  const payload = JSON.stringify({ event, data });
  userClients.forEach(socket => { if (socket.readyState === 1) socket.send(payload); });
}
module.exports = { addClient, notifyUser };
