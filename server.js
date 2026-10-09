const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const DATA_FILE = path.join(__dirname, 'data.json');
let data = { messages: [], lastSeen: {} };
if (fs.existsSync(DATA_FILE)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    data.messages = parsed.messages || [];
    data.lastSeen = parsed.lastSeen || {};
  } catch (e) {}
}
function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

const onlineUsers = new Map();

app.use(express.static('public'));

function getUsersPayload() {
  return Array.from(onlineUsers.values()).map(name => ({
    name,
    online: true,
    lastSeen: data.lastSeen[name] || null
  }));
}

io.on('connection', (socket) => {
  socket.on('login', (username) => {
    username = String(username || '').trim().slice(0, 20);
    if (!username) return;
    const taken = Array.from(onlineUsers.values()).includes(username);
    if (taken) {
      socket.emit('login-error', 'Этот ник уже занят');
      return;
    }
    onlineUsers.set(socket.id, username);
    socket.emit('login-ok', username);
    io.emit('users', getUsersPayload());
    console.log('login:', username);
  });

  socket.on('get-history', (withUser) => {
    const from = onlineUsers.get(socket.id);
    if (!from) return;
    const msgs = data.messages.filter(m =>
      (m.from === from && m.to === withUser) ||
      (m.from === withUser && m.to === from)
    );
    socket.emit('chat-history', { with: withUser, messages: msgs });
  });

  socket.on('typing', (payload) => {
    const from = onlineUsers.get(socket.id);
    if (!from || !payload || !payload.to) return;
    const toUser = String(payload.to);
    for (const [sid, name] of onlineUsers) {
      if (name === toUser && sid !== socket.id) {
        io.to(sid).emit('typing', { from, isTyping: !!payload.isTyping });
      }
    }
  });

  socket.on('message', (msg) => {
    const from = onlineUsers.get(socket.id);
    if (!from || !msg || !msg.to || !msg.text) return;
    const fullMsg = {
      from: from,
      to: String(msg.to),
      text: String(msg.text).slice(0, 2000),
      time: Date.now()
    };
    data.messages.push(fullMsg);
    saveData();
    socket.emit('message', fullMsg);
    for (const [sid, name] of onlineUsers) {
      if (name === fullMsg.to && sid !== socket.id) {
        io.to(sid).emit('message', fullMsg);
      }
    }
  });

  socket.on('disconnect', () => {
    const username = onlineUsers.get(socket.id);
    if (username) {
      data.lastSeen[username] = Date.now();
      saveData();
    }
    onlineUsers.delete(socket.id);
    io.emit('users', getUsersPayload());
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log('Vibemessanger запущен: http://localhost:' + PORT);
});
