const socket = io();
let me = null;
let currentChat = null;

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
  document.getElementById('me').textContent = 'Пользователь: ' + me;
});

socket.on('login-error', (msg) => {
  alert(msg);
});

socket.on('users', (users) => {
  const ul = document.getElementById('users');
  ul.innerHTML = '';
  users.forEach(u => {
    if (u === me) return;
    const li = document.createElement('li');
    li.textContent = u;
    li.onclick = () => openChat(u);
    if (u === currentChat) li.classList.add('active');
    ul.appendChild(li);
  });
});

function openChat(user) {
  currentChat = user;
  document.getElementById('chat-header').textContent = user;
  document.getElementById('messages').innerHTML = '';
  socket.emit('get-history', user);
  document.querySelectorAll('#users li').forEach(li => {
    li.classList.toggle('active', li.textContent === user);
  });
}

socket.on('chat-history', (payload) => {
  if (payload.with !== currentChat) return;
  const box = document.getElementById('messages');
  box.innerHTML = '';
  payload.messages.forEach(renderMessage);
  box.scrollTop = box.scrollHeight;
});

socket.on('message', (msg) => {
  const other = msg.from === me ? msg.to : msg.from;
  if (other !== currentChat) return;
  renderMessage(msg);
  const box = document.getElementById('messages');
  box.scrollTop = box.scrollHeight;
});

function renderMessage(msg) {
  const box = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'msg ' + (msg.from === me ? 'mine' : 'theirs');
  const text = document.createElement('div');
  text.textContent = msg.text;
  const time = document.createElement('div');
  time.className = 'time';
  time.textContent = new Date(msg.time).toLocaleTimeString();
  div.appendChild(text);
  div.appendChild(time);
  box.appendChild(div);
}

document.getElementById('form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('input');
  const text = input.value.trim();
  if (!text || !currentChat) return;
  socket.emit('message', { to: currentChat, text: text });
  input.value = '';
});
