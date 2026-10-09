const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const DATA_FILE = path.join(__dirname, 'data.json');
let data = { messages: [] };
if (fs.existsSync(DATA_FILE)) {
  try { data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) {}
}
function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

const onlineUsers = new Map();

app.use(express.static('public'));

io.on('connection', (socket) => {
  console.log('connected:', socket.id);

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
    io.emit('users', Array.from(onlineUsers.values()));
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
    onlineUsers.delete(socket.id);
    io.emit('users', Array.from(onlineUsers.values()));
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log('Сервер запущен: http://localhost:' + PORT);
});
