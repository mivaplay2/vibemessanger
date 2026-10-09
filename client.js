const SUPABASE_URL = 'https://bknepaougcpebsnddmyo.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_TS5On4xp5bizVk_kJzHNCQ_iW2Mc3Op';

const { createClient } = supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let me = null;
let myId = null;
let currentChatUser = null;
let allUsers = [];
let messageChannel = null;
let profilesChannel = null;
let lastDate = null;

function colorFromString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return 'hsl(' + (Math.abs(hash) % 360) + ', 70%, 55%)';
}

function makeAvatar(name, size) {
  const div = document.createElement('div');
  div.className = 'avatar';
  div.style.background = colorFromString(name);
  div.textContent = name.charAt(0).toUpperCase();
  if (size) { div.style.width = size + 'px'; div.style.height = size + 'px'; div.style.fontSize = (size * 0.4) + 'px'; }
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

function toggleAuth(mode) {
  document.getElementById('login-form').classList.toggle('hidden', mode !== 'login');
  document.getElementById('register-form').classList.toggle('hidden', mode !== 'register');
  document.getElementById('verify-form').classList.toggle('hidden', mode !== 'verify');
}
window.toggleAuth = toggleAuth;

function showError(id, msg) {
  const el = document.getElementById(id);
  if (el) { el.textContent = msg; setTimeout(() => el.textContent = '', 5000); }
}

document.getElementById('btn-register').addEventListener('click', async () => {
  const email = document.getElementById('reg-email').value.trim();
  const username = document.getElementById('reg-username').value.trim();
  const password = document.getElementById('reg-password').value;
  if (!email || !username || !password) return showError('register-error', 'Заполните все поля');
  if (password.length < 6) return showError('register-error', 'Пароль минимум 6 символов');

  const { data: existing } = await sb.from('profiles').select('username').eq('username', username).maybeSingle();
  if (existing) return showError('register-error', 'Этот ник уже занят');

  const { data, error } = await sb.auth.signUp({
    email,
    password,
    options: { data: { username } }
  });

  if (error) return showError('register-error', error.message);
  if (data.session) {
    // вошёл сразу (confirm email выключен)
  } else {
    toggleAuth('verify');
  }
});

document.getElementById('btn-login').addEventListener('click', async () => {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  if (!email || !password) return showError('login-error', 'Заполните все поля');

  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) {
    if (error.message.includes('Email not confirmed')) return showError('login-error', 'Сначала подтвердите почту');
    return showError('login-error', error.message);
  }
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  if (messageChannel) await sb.removeChannel(messageChannel);
  if (profilesChannel) await sb.removeChannel(profilesChannel);
  await sb.auth.signOut();
  location.reload();
});

sb.auth.onAuthStateChange(async (event, session) => {
  if (event === 'SIGNED_IN' && session && !myId) {
    const user = session.user;
    myId = user.id;

    const { data: profile } = await sb.from('profiles').select('username').eq('id', myId).maybeSingle();
    if (!profile) {
      const uname = user.user_metadata?.username || user.email.split('@')[0];
      await sb.from('profiles').insert({ id: myId, username: uname });
      me = uname;
    } else {
      me = profile.username;
    }
    startApp();
  }
});

async function startApp() {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  document.getElementById('me').textContent = me;
  const myAv = document.getElementById('my-avatar');
  const newAv = makeAvatar(me);
  newAv.id = 'my-avatar';
  myAv.replaceWith(newAv);

  await loadAllUsers();
  subscribeProfiles();
}

async function loadAllUsers() {
  const { data } = await sb.from('profiles').select('id, username');
  if (data) { allUsers = data; renderUsers(); }
}

function subscribeProfiles() {
  profilesChannel = sb.channel('profiles-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, () => loadAllUsers())
    .subscribe();
}

document.getElementById('search').addEventListener('input', renderUsers);

function renderUsers() {
  const ul = document.getElementById('users');
  ul.innerHTML = '';
  const search = document.getElementById('search').value.trim().toLowerCase();
  allUsers.forEach(u => {
    if (u.id === myId) return;
    if (search && !u.username.toLowerCase().includes(search)) return;
    const li = document.createElement('li');
    li.appendChild(makeAvatar(u.username));
    const nameSpan = document.createElement('span');
    nameSpan.className = 'user-name';
    nameSpan.textContent = u.username;
    li.appendChild(nameSpan);
    li.onclick = () => openChat(u);
    if (currentChatUser && u.id === currentChatUser.id) li.classList.add('active');
    ul.appendChild(li);
  });
}

async function openChat(user) {
  currentChatUser = user;
  document.getElementById('chat-header-name').textContent = user.username;
  document.getElementById('messages').innerHTML = '';
  lastDate = null;
  renderUsers();

  if (messageChannel) await sb.removeChannel(messageChannel);
  await loadHistory(user);
  subscribeMessages(user);
}

async function loadHistory(user) {
  const { data } = await sb
    .from('messages')
    .select('*')
    .or('and(sender_id.eq.' + myId + ',receiver_id.eq.' + user.id + '),and(sender_id.eq.' + user.id + ',receiver_id.eq.' + myId + ')')
    .order('created_at', { ascending: true });

  if (data) {
    data.forEach(msg => renderMessage(msg));
    const box = document.getElementById('messages');
    box.scrollTop = box.scrollHeight;
  }
}

function subscribeMessages(user) {
  messageChannel = sb.channel('messages-' + user.id)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
      const msg = payload.new;
      const relevant = (msg.sender_id === myId && msg.receiver_id === user.id) ||
                       (msg.sender_id === user.id && msg.receiver_id === myId);
      if (!relevant) return;
      renderMessage(msg);
      const box = document.getElementById('messages');
      box.scrollTop = box.scrollHeight;
    })
    .subscribe();
}

function renderMessage(msg) {
  const box = document.getElementById('messages');
  const dayLabel = formatDate(msg.created_at);
  if (dayLabel !== lastDate) {
    const div = document.createElement('div');
    div.className = 'date-divider';
    div.textContent = dayLabel;
    box.appendChild(div);
    lastDate = dayLabel;
  }
  const isMine = msg.sender_id === myId;
  const row = document.createElement('div');
  row.className = 'msg-row ' + (isMine ? 'mine' : 'theirs');
  if (!isMine && currentChatUser) row.appendChild(makeAvatar(currentChatUser.username));

  const bubble = document.createElement('div');
  bubble.className = 'msg ' + (isMine ? 'mine' : 'theirs');
  const text = document.createElement('div');
  text.textContent = msg.content;
  const time = document.createElement('div');
  time.className = 'time';
  time.textContent = new Date(msg.created_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  bubble.appendChild(text);
  bubble.appendChild(time);
  row.appendChild(bubble);
  box.appendChild(row);
}

document.getElementById('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('input');
  const text = input.value.trim();
  if (!text || !currentChatUser) return;

  const { error } = await sb.from('messages').insert({
    sender_id: myId,
    receiver_id: currentChatUser.id,
    content: text
  });
  if (error) { alert('Ошибка: ' + error.message); return; }
  input.value = '';
});

(async () => {
  const { data: { session } } = await sb.auth.getSession();
  if (session && !myId) {
    myId = session.user.id;
    const { data: profile } = await sb.from('profiles').select('username').eq('id', myId).maybeSingle();
    if (profile) { me = profile.username; startApp(); }
    else {
      const uname = session.user.user_metadata?.username || session.user.email.split('@')[0];
      await sb.from('profiles').insert({ id: myId, username: uname });
      me = uname;
      startApp();
    }
  }
})();
