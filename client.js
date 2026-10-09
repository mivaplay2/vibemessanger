const SUPABASE_URL = 'https://bknepaougcpebsnddmyo.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_TS5On4xp5bizVk_kJzHNCQ_iW2Mc3Op';

const { createClient } = supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let me = null;
let myId = null;
let currentChatUser = null;
let allUsers = [];
let chatsMeta = {};
let onlineUsers = new Set();
let typingUsers = new Set();
let messageChannel = null;
let profilesChannel = null;
let presenceChannel = null;
let lastDate = null;
let typingTimeout = null;
let amTyping = false;

function colorFromString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return 'hsl(' + (Math.abs(hash) % 360 + 360) % 360 + ', 60%, 50%)';
}

function makeAvatar(name, size) {
  const div = document.createElement('div');
  div.className = 'avatar';
  div.style.background = colorFromString(name);
  div.textContent = name.charAt(0).toUpperCase();
  if (size) { div.style.width = size + 'px'; div.style.height = size + 'px'; div.style.fontSize = (size * 0.42) + 'px'; }
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

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function formatListTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const today = new Date();
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  if (sameDay(d, today)) return formatTime(ts);
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(d, yesterday)) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
}

function lastSeenText(ts) {
  if (!ts) return 'был(а) недавно';
  const diff = Date.now() - new Date(ts).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'был(а) только что';
  if (min < 60) return 'был(а) ' + min + ' мин назад';
  const hours = Math.floor(min / 60);
  if (hours < 24) return 'был(а) ' + hours + ' ч назад';
  return 'был(а) ' + new Date(ts).toLocaleDateString('ru-RU');
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
    email, password,
    options: { data: { username } }
  });
  if (error) return showError('register-error', error.message);
  if (!data.session) toggleAuth('verify');
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
  if (myId) await sb.from('profiles').update({ last_seen: new Date().toISOString() }).eq('id', myId);
  if (messageChannel) await sb.removeChannel(messageChannel);
  if (profilesChannel) await sb.removeChannel(profilesChannel);
  if (presenceChannel) await sb.removeChannel(presenceChannel);
  await sb.auth.signOut();
  location.reload();
});

sb.auth.onAuthStateChange(async (event, session) => {
  if (event === 'SIGNED_IN' && session && !myId) {
    myId = session.user.id;
    const { data: profile } = await sb.from('profiles').select('username').eq('id', myId).maybeSingle();
    if (!profile) {
      const uname = session.user.user_metadata?.username || session.user.email.split('@')[0];
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
  await loadChatsMeta();
  subscribeProfiles();
  subscribePresence();
  renderChats();
}

async function loadAllUsers() {
  const { data } = await sb.from('profiles').select('id, username, last_seen');
  if (data) allUsers = data;
}

async function loadChatsMeta() {
  const { data, error } = await sb
    .from('messages')
    .select('*')
    .or('sender_id.eq.' + myId + ',receiver_id.eq.' + myId + '')
    .order('created_at', { ascending: false });
  if (error || !data) return;

  chatsMeta = {};
  for (const msg of data) {
    const other = msg.sender_id === myId ? msg.receiver_id : msg.sender_id;
    if (!chatsMeta[other]) {
      chatsMeta[other] = { lastMessage: msg, unread: 0 };
    }
    if (msg.receiver_id === myId && !msg.read_at) {
      chatsMeta[other].unread++;
    }
  }
}

function subscribeProfiles() {
  profilesChannel = sb.channel('profiles-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, () => {
      loadAllUsers().then(renderChats);
    })
    .subscribe();
}

function subscribePresence() {
  presenceChannel = sb.channel('online', {
    config: { presence: { key: myId } }
  });

  presenceChannel
    .on('presence', { event: 'sync' }, () => {
      const state = presenceChannel.presenceState();
      onlineUsers = new Set();
      typingUsers = new Set();
      for (const id in state) {
        const metas = state[id];
        for (const m of metas) {
          if (m.online) onlineUsers.add(id);
          if (m.typingTo) typingUsers.add(id);
        }
      }
      renderChats();
      updateHeaderStatus();
    })
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await presenceChannel.track({ online: true, typingTo: null });
      }
    });
}

function setTyping(toId) {
  if (!presenceChannel) return;
  presenceChannel.track({ online: true, typingTo: toId });
}
function stopTyping() {
  if (!presenceChannel) return;
  presenceChannel.track({ online: true, typingTo: null });
}

document.getElementById('search').addEventListener('input', renderChats);

function renderChats() {
  const ul = document.getElementById('chats');
  ul.innerHTML = '';
  const search = document.getElementById('search').value.trim().toLowerCase();

  const items = allUsers
    .filter(u => u.id !== myId)
    .map(u => {
      const meta = chatsMeta[u.id] || { lastMessage: null, unread: 0 };
      return { user: u, meta };
    })
    .filter(({ user }) => !search || user.username.toLowerCase().includes(search))
    .sort((a, b) => {
      const tA = a.meta.lastMessage ? new Date(a.meta.lastMessage.created_at).getTime() : 0;
      const tB = b.meta.lastMessage ? new Date(b.meta.lastMessage.created_at).getTime() : 0;
      return tB - tA;
    });

  items.forEach(({ user, meta }) => {
    const li = document.createElement('li');
    li.className = 'chat-item';
    if (currentChatUser && user.id === currentChatUser.id) li.classList.add('active');
    li.onclick = () => openChat(user);

    const av = makeAvatar(user.username);
    if (onlineUsers.has(user.id)) {
      av.style.boxShadow = '0 0 0 2px var(--online)';
    }
    li.appendChild(av);

    const body = document.createElement('div');
    body.className = 'chat-body';

    const top = document.createElement('div');
    top.className = 'chat-top';
    const nameEl = document.createElement('div');
    nameEl.className = 'chat-name';
    nameEl.textContent = user.username;
    const timeEl = document.createElement('div');
    timeEl.className = 'chat-time';
    if (meta.lastMessage) timeEl.textContent = formatListTime(meta.lastMessage.created_at);
    top.appendChild(nameEl);
    top.appendChild(timeEl);

    const bottom = document.createElement('div');
    bottom.className = 'chat-bottom';
    const preview = document.createElement('div');
    preview.className = 'chat-preview';

    if (typingUsers.has(user.id) && typingToMe(user.id)) {
      preview.textContent = 'печатает...';
      preview.classList.add('typing');
    } else if (meta.lastMessage) {
      const m = meta.lastMessage;
      const isMine = m.sender_id === myId;
      preview.textContent = (isMine ? 'Вы: ' : '') + m.content;
      if (isMine) preview.classList.add('mine-prefix');
    } else {
      preview.textContent = 'Нет сообщений';
    }
    bottom.appendChild(preview);

    if (meta.unread > 0 && !(currentChatUser && currentChatUser.id === user.id)) {
      const badge = document.createElement('div');
      badge.className = 'unread-badge';
      badge.textContent = meta.unread > 99 ? '99+' : meta.unread;
      bottom.appendChild(badge);
    }

    body.appendChild(top);
    body.appendChild(bottom);
    li.appendChild(body);
    ul.appendChild(li);
  });
}

function typingToMe(userId) {
  return typingUsers.has(userId) && currentChatUser && currentChatUser.id === userId;
}

async function openChat(user) {
  currentChatUser = user;
  document.getElementById('chat-header-name').textContent = user.username;
  const headerAv = document.getElementById('chat-avatar');
  headerAv.style.display = 'flex';
  const newAv = makeAvatar(user.username, 40);
  newAv.id = 'chat-avatar';
  headerAv.replaceWith(newAv);

  document.getElementById('messages').innerHTML = '';
  lastDate = null;

  document.getElementById('sidebar').classList.add('hidden');
  document.getElementById('chat').classList.remove('hidden');

  if (messageChannel) await sb.removeChannel(messageChannel);
  await loadHistory(user);
  await markAsRead(user);
  subscribeMessages(user);
  updateHeaderStatus();
  renderChats();
}

function updateHeaderStatus() {
  if (!currentChatUser) return;
  const status = document.getElementById('chat-header-status');
  if (typingUsers.has(currentChatUser.id)) {
    status.textContent = 'печатает...';
    status.className = 'typing';
  } else if (onlineUsers.has(currentChatUser.id)) {
    status.textContent = 'в сети';
    status.className = 'online';
  } else {
    const u = allUsers.find(x => x.id === currentChatUser.id);
    status.textContent = lastSeenText(u?.last_seen);
    status.className = '';
  }
}

async function loadHistory(user) {
  const { data } = await sb
    .from('messages')
    .select('*')
    .or('and(sender_id.eq.' + myId + ',receiver_id.eq.' + user.id + '),and(sender_id.eq.' + user.id + ',receiver_id.eq.' + myId + ')')
    .order('created_at', { ascending: true });
  if (data) {
    data.forEach(renderMessage);
    const box = document.getElementById('messages');
    box.scrollTop = box.scrollHeight;
  }
}

async function markAsRead(user) {
  await sb.from('messages')
    .update({ read_at: new Date().toISOString() })
    .eq('sender_id', user.id)
    .eq('receiver_id', myId)
    .is('read_at', null);
  if (chatsMeta[user.id]) chatsMeta[user.id].unread = 0;
}

function subscribeMessages(user) {
  messageChannel = sb.channel('messages-' + user.id + '-' + Date.now())
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
      const msg = payload.new;
      const relevant = (msg.sender_id === myId && msg.receiver_id === user.id) ||
                       (msg.sender_id === user.id && msg.receiver_id === myId);
      if (!relevant) return;

      const other = msg.sender_id === myId ? msg.receiver_id : msg.sender_id;
      chatsMeta[other] = chatsMeta[other] || { lastMessage: null, unread: 0 };
      chatsMeta[other].lastMessage = msg;
      if (msg.receiver_id === myId && !msg.read_at && (!currentChatUser || currentChatUser.id !== user.id)) {
        chatsMeta[other].unread++;
      }

      if (currentChatUser && currentChatUser.id === user.id) {
        renderMessage(msg);
        const box = document.getElementById('messages');
        box.scrollTop = box.scrollHeight;
      }
      renderChats();

      if (msg.receiver_id === myId && currentChatUser && currentChatUser.id === msg.sender_id) {
        markAsRead(user);
      }
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, (payload) => {
      const msg = payload.new;
      if (msg.read_at) {
        const el = document.querySelector('[data-msg-id="' + msg.id + '"] .check');
        if (el) { el.textContent = 'OK'; el.classList.add('read'); }
      }
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
  row.setAttribute('data-msg-id', msg.id);

  const bubble = document.createElement('div');
  bubble.className = 'msg ' + (isMine ? 'mine' : 'theirs');

  const text = document.createElement('div');
  text.className = 'text';
  text.textContent = msg.content;

  const meta = document.createElement('div');
  meta.className = 'meta';
  const time = document.createElement('span');
  time.textContent = formatTime(msg.created_at);
  meta.appendChild(time);

  if (isMine) {
    const check = document.createElement('span');
    check.className = 'check' + (msg.read_at ? ' read' : '');
    check.textContent = msg.read_at ? 'OK' : 'v';
    meta.appendChild(check);
  }

  bubble.appendChild(text);
  bubble.appendChild(meta);
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
  stopTyping();
  amTyping = false;
});

const inputEl = document.getElementById('input');
inputEl.addEventListener('input', () => {
  if (!currentChatUser) return;
  if (!amTyping) { amTyping = true; setTyping(currentChatUser.id); }
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => { amTyping = false; stopTyping(); }, 2000);
});

document.getElementById('chat-header').addEventListener('click', (e) => {
  if (window.innerWidth <= 700 && (e.target.id === 'chat-header-name' || e.target.id === 'chat-header')) {
    document.getElementById('sidebar').classList.remove('hidden');
    document.getElementById('chat').classList.add('hidden');
    currentChatUser = null;
    renderChats();
  }
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
