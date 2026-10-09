require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json());

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

const DATA_FILE = path.join(__dirname, 'data.json');
let data = { users: [], messages: [], lastSeen: {} };
if (fs.existsSync(DATA_FILE)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    data.users = parsed.users || [];
    data.messages = parsed.messages || [];
    data.lastSeen = parsed.lastSeen || {};
  } catch (e) {}
}
function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

const onlineUsers = new Map();
app.use(express.static('public'));

app.post('/api/register', async (req, res) => {
  const { email, password, username } = req.body;
  if (!email || !password || !username) {
    return res.status(400).json({ error: 'Заполните все поля' });
  }
  if (data.users.find(u => u.email === email)) {
    return res.status(400).json({ error: 'Пользователь с таким email уже существует' });
  }
  if (data.users.find(u => u.username === username)) {
    return res.status(400).json({ error: 'Этот ник уже занят' });
  }
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
    const newUser = {
      email,
      username,
      password: hashedPassword,
      isVerified: false,
      verificationCode,
      verificationExpires: Date.now() + 15 * 60 * 1000,
    };
    data.users.push(newUser);
    saveData();
    const mailOptions = {
      from: '"Vibemessanger" <' + process.env.EMAIL_USER + '>',
      to: email,
      subject: 'Подтверждение регистрации в Vibemessanger',
      html: '<h2>Добро пожаловать, ' + username + '!</h2>' +
            '<p>Ваш код подтверждения: <strong>' + verificationCode + '</strong></p>' +
            '<p>Код действителен 15 минут.</p>',
    };
    await transporter.sendMail(mailOptions);
    console.log('Verification email sent to:', email);
    res.json({ message: 'Регистрация успешна. Проверьте почту.' });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Ошибка сервера при регистрации' });
  }
});

app.post('/api/verify', (req, res) => {
  const { email, code } = req.body;
  const user = data.users.find(u => u.email === email);
  if (!user) return res.status(400).json({ error: 'Пользователь не найден' });
  if (user.isVerified) return res.status(400).json({ error: 'Почта уже подтверждена' });
  if (Date.now() > user.verificationExpires) {
    return res.status(400).json({ error: 'Код истёк' });
  }
  if (user.verificationCode !== code) {
    return res.status(400).json({ error: 'Неверный код' });
  }
  user.isVerified = true;
  user.verificationCode = null;
  saveData();
  res.json({ message: 'Почта подтверждена' });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const user = data.users.find(u => u.email === email);
  if (!user) return res.status(400).json({ error: 'Неверный email или пароль' });
  if (!user.isVerified) return res.status(403).json({ error: 'Сначала подтвердите почту' });
  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) return res.status(400).json({ error: 'Неверный email или пароль' });
  const token = jwt.sign(
    { email: user.email, username: user.username },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
  res.json({ token, username: user.username });
});

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication error'));
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    socket.user = decoded;
    next();
  } catch (err) {
    next(new Error('Authentication error'));
  }
});

function getUsersPayload() {
  return Array.from(onlineUsers.values()).map(u => ({
    name: u.username,
    online: true,
    lastSeen: data.lastSeen[u.username] || null
  }));
}

io.on('connection', (socket) => {
  const user = socket.user;
  console.log('User connected:', user.username);
  onlineUsers.set(socket.id, { username: user.username, email: user.email });
  io.emit('users', getUsersPayload());

  socket.on('get-history', (withUser) => {
    const from = user.username;
    const msgs = data.messages.filter(m =>
      (m.from === from && m.to === withUser) ||
      (m.from === withUser && m.to === from)
    );
    socket.emit('chat-history', { with: withUser, messages: msgs });
  });

  socket.on('typing', (payload) => {
    if (!payload || !payload.to) return;
    const toUser = String(payload.to);
    for (const [sid, u] of onlineUsers) {
      if (u.username === toUser && sid !== socket.id) {
        io.to(sid).emit('typing', { from: user.username, isTyping: !!payload.isTyping });
      }
    }
  });

  socket.on('message', (msg) => {
    if (!msg || !msg.to || !msg.text) return;
    const fullMsg = {
      from: user.username,
      to: String(msg.to),
      text: String(msg.text).slice(0, 2000),
      time: Date.now()
    };
    data.messages.push(fullMsg);
    saveData();
    socket.emit('message', fullMsg);
    for (const [sid, u] of onlineUsers) {
      if (u.username === fullMsg.to && sid !== socket.id) {
        io.to(sid).emit('message', fullMsg);
      }
    }
  });

  socket.on('disconnect', () => {
    if (user.username) {
      data.lastSeen[user.username] = Date.now();
      saveData();
    }
    onlineUsers.delete(socket.id);
    io.emit('users', getUsersPayload());
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Vibemessanger запущен: http://localhost:' + PORT);
});
