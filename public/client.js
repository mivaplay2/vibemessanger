const socket = io();
let me = null;
let currentChat = null;
let allUsers = [];
let lastDate = null;
let typingTimeout = null;
let isTyping = false;

function colorFromString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash) % 360;
  return 'hsl(' + h + ', 70%, 55%)';
}

function makeAvatar(name, size) {
  const div = document.createElement('div');
  div.className = 'avatar';
  div.style.background = colorFromString(name);
  div.textContent = name.charAt(0).toUpperCase();
  if (size) {
    div.style.width = size + 'px';
    div.style.height = size + 'px';
    div.style.fontSize = (size * 0.4) + 'px';
  }
  return div;
}

function formatDate(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  if (sameDay(d, today)) return 'Сегодня';
  if (sameDay(d, yesterday)) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

document.getElementById('login').addEventListener('submit', (e) => {
  e.preventDefault();
  const username = document.getElementById('username').value.trim();
  if (!username) return;
  socket.emit('login', username);
});

socket.on('login-ok', (username) => {
  me = username;
  document.getElementById('login').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  document.getElementById('me').textContent = me;
  const myAv = document.getElementById('my-avatar');
  const newAv = makeAvatar(me);
  newAv.id = 'my-avatar';
  myAv.replaceWith(newAv);
});

socket.on('login-error', (msg) => alert(msg));

socket.on('users', (users) => {
  allUsers = users;
  renderUsers();
});

document.getElementById('search').addEventListener('input', renderUsers);

function renderUsers() {
  const ul = document.getElementById('users');
  ul.innerHTML = '';
  const search = document.getElementById('search').value.trim().toLowerCase();
  allUsers.forEach(u => {
    if (u.name === me) return;
    if (search && !u.name.toLowerCase().includes(search)) return;
    const li = document.createElement('li');
    li.appendChild(makeAvatar(u.name));
    const nameSpan = document.createElement('span');
    nameSpan.className = 'user-name';
    nameSpan.textContent = u.name;
    li.appendChild(nameSpan);
    li.onclick = () => openChat(u.name);
    if (u.name === currentChat) li.classList.add('active');
    ul.appendChild(li);
  });
}

function openChat(user) {
  currentChat = user;
  document.getElementById('chat-header-name').textContent = user;
  document.getElementById('chat-header-status').textContent = 'онлайн';
  document.getElementById('messages').innerHTML = '';
  document.getElementById('typing-indicator').textContent = '';
  lastDate = null;
  socket.emit('get-history', user);
  renderUsers();
}

socket.on('chat-history', (payload) => {
  if (payload.with !== currentChat) return;
  const box = document.getElementById('messages');
  box.innerHTML = '';
  lastDate = null;
  payload.messages.forEach(renderMessage);
  box.scrollTop = box.scrollHeight;
});

socket.on('message', (msg) => {
  const other = msg.from === me ? msg.to : msg.from;
  if (other !== currentChat) return;
  renderMessage(msg);
  const box = document.getElementById('messages');
  box.scrollTop = box.scrollHeight;
  document.getElementById('typing-indicator').textContent = '';
});

socket.on('typing', (payload) => {
  if (payload.from !== currentChat) return;
  document.getElementById('typing-indicator').textContent = payload.isTyping ? payload.from + ' печатает...' : '';
});

function renderMessage(msg) {
  const box = document.getElementById('messages');
  const dayLabel = formatDate(msg.time);
  if (dayLabel !== lastDate) {
    const div = document.createElement('div');
    div.className = 'date-divider';
    div.textContent = dayLabel;
    box.appendChild(div);
    lastDate = dayLabel;
  }
  const row = document.createElement('div');
  row.className = 'msg-row ' + (msg.from === me ? 'mine' : 'theirs');
  if (msg.from !== me) {
    row.appendChild(makeAvatar(msg.from));
  }
  const bubble = document.createElement('div');
  bubble.className = 'msg ' + (msg.from === me ? 'mine' : 'theirs');
  const text = document.createElement('div');
  text.textContent = msg.text;
  const time = document.createElement('div');
  time.className = 'time';
  time.textContent = new Date(msg.time).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  bubble.appendChild(text);
  bubble.appendChild(time);
  row.appendChild(bubble);
  box.appendChild(row);
}

const input = document.getElementById('input');
input.addEventListener('input', () => {
  if (!currentChat) return;
  if (!isTyping) {
    isTyping = true;
    socket.emit('typing', { to: currentChat, isTyping: true });
  }
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    isTyping = false;
    socket.emit('typing', { to: currentChat, isTyping: false });
  }, 1500);
});

document.getElementById('form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || !currentChat) return;
  socket.emit('message', { to: currentChat, text: text });
  input.value = '';
  isTyping = false;
  socket.emit('typing', { to: currentChat, isTyping: false });
});
