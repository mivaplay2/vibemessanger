const SUPABASE_URL = 'https://bknepaougcpebsnddmyo.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_TS5On4xp5bizVk_kJzHNCQ_iW2Mc3Op';

const { createClient } = supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let me = null, myId = null;
let currentChatUser = null;
let allUsers = [];
let friendships = [];
let chatsMeta = {};
let onlineUsers = new Set();
let typingUsers = new Set();
let messageChannel = null, profilesChannel = null, presenceChannel = null, friendsChannel = null;
let lastDate = null;
let typingTimeout = null, amTyping = false;
let currentTab = 'chats';

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
  const d = new Date(ts), today = new Date(), yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a,b) => a.toDateString() === b.toDateString();
  if (sameDay(d, today)) return 'Сегодня';
  if (sameDay(d, yesterday)) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}
function formatTime(ts) { return new Date(ts).toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit' }); }
function formatListTime(ts) {
  if (!ts) return '';
  const d = new Date(ts), today = new Date(), yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a,b) => a.toDateString() === b.toDateString();
  if (sameDay(d, today)) return formatTime(ts);
  if (sameDay(d, yesterday)) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day:'2-digit', month:'2-digit' });
}
function lastSeenText(ts) {
  if (!ts) return 'был(а) недавно';
  const diff = Date.now() - new Date(ts).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'был(а) только что';
  if (min < 60) return 'был(а) ' + min + ' мин назад';
  const h = Math.floor(min/60);
  if (h < 24) return 'был(а) ' + h + ' ч назад';
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

// === AUTH ===
document.getElementById('btn-register').addEventListener('click', async () => {
  const email = document.getElementById('reg-email').value.trim();
  const username = document.getElementById('reg-username').value.trim();
  const password = document.getElementById('reg-password').value;
  if (!email || !username || !password) return showError('register-error', 'Заполните все поля');
  if (password.length < 6) return showError('register-error', 'Пароль минимум 6 символов');
  const { data: existing } = await sb.from('profiles').select('username').eq('username', username).maybeSingle();
  if (existing) return showError('register-error', 'Этот ник уже занят');
  const { data, error } = await sb.auth.signUp({ email, password, options: { data: { username } } });
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
  [messageChannel, profilesChannel, presenceChannel, friendsChannel].forEach(ch => ch && sb.removeChannel(ch));
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
    } else me = profile.username;
    startApp();
  }
});

async function startApp() {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  document.getElementById('me').textContent = me;
  const myAv = document.getElementById('my-avatar');
  const newAv = makeAvatar(me); newAv.id = 'my-avatar';
  myAv.replaceWith(newAv);

  await loadAll();
  subscribeAll();
  render();
}

async function loadAll() {
  const [u, f, m] = await Promise.all([
    sb.from('profiles').select('id, username, last_seen'),
    sb.from('friendships').select('*').or('requester_id.eq.' + myId + ',addressee_id.eq.' + myId + ''),
    sb.from('messages').select('*').or('sender_id.eq.' + myId + ',receiver_id.eq.' + myId + '').order('created_at', { ascending: false })
  ]);
  if (u.data) allUsers = u.data;
  if (f.data) friendships = f.data;
  chatsMeta = {};
  if (m.data) for (const msg of m.data) {
    const other = msg.sender_id === myId ? msg.receiver_id : msg.sender_id;
    if (!chatsMeta[other]) chatsMeta[other] = { lastMessage: msg, unread: 0 };
    if (msg.receiver_id === myId && !msg.read_at) chatsMeta[other].unread++;
  }
}

function subscribeAll() {
  profilesChannel = sb.channel('profiles-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, () => loadAll().then(render))
    .subscribe();

  friendsChannel = sb.channel('friendships-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships' }, () => loadAll().then(render))
    .subscribe();

  presenceChannel = sb.channel('online', { config: { presence: { key: myId } } })
    .on('presence', { event: 'sync' }, () => {
      const state = presenceChannel.presenceState();
      onlineUsers = new Set(); typingUsers = new Set();
      for (const id in state) {
        for (const m of state[id]) {
          if (m.online) onlineUsers.add(id);
          if (m.typingTo) typingUsers.add(id);
        }
      }
      render(); updateHeaderStatus();
    })
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') await presenceChannel.track({ online: true, typingTo: null });
    });
}
function setTyping(toId) { if (presenceChannel) presenceChannel.track({ online: true, typingTo: toId }); }
function stopTyping() { if (presenceChannel) presenceChannel.track({ online: true, typingTo: null }); }

// === FRIENDS HELPERS ===
function getFriendship(otherId) {
  return friendships.find(f =>
    (f.requester_id === myId && f.addressee_id === otherId) ||
    (f.requester_id === otherId && f.addressee_id === myId)
  );
}
function areFriends(otherId) {
  const f = getFriendship(otherId);
  return f && f.status === 'accepted';
}
function getIncoming() {
  return friendships.filter(f => f.status === 'pending' && f.addressee_id === myId);
}
function getOutgoing() {
  return friendships.filter(f => f.status === 'pending' && f.requester_id === myId);
}

async function sendFriendRequest(toId) {
  const { error } = await sb.from('friendships').insert({ requester_id: myId, addressee_id: toId });
  if (error) { alert('Ошибка: ' + error.message); return; }
  await loadAll(); render();
}
async function acceptFriend(fid) {
  const { error } = await sb.from('friendships').update({ status: 'accepted' }).eq('id', fid);
  if (error) { alert('Ошибка: ' + error.message); return; }
  await loadAll(); render();
}
async function rejectFriend(fid) {
  await sb.from('friendships').delete().eq('id', fid);
  await loadAll(); render();
}

// === TABS ===
document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => {
    currentTab = t.dataset.tab;
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
    document.getElementById('search').value = '';
    render();
  });
});
document.getElementById('search').addEventListener('input', render);

// === RENDER ===
function render() {
  const ul = document.getElementById('list');
  ul.innerHTML = '';
  const search = document.getElementById('search').value.trim().toLowerCase();

  // update requests badge
  const incCount = getIncoming().length;
  const badge = document.getElementById('req-count');
  if (incCount > 0) { badge.textContent = incCount; badge.classList.add('visible'); }
  else badge.classList.remove('visible');

  if (currentTab === 'chats') renderChats(ul, search);
  else if (currentTab === 'requests') renderRequests(ul, search);
  else renderPeople(ul, search);
}

function renderChats(ul, search) {
  const friendIds = friendships.filter(f => f.status === 'accepted')
    .map(f => f.requester_id === myId ? f.addressee_id : f.requester_id);

  const items = allUsers
    .filter(u => u.id !== myId && friendIds.includes(u.id))
    .filter(u => !search || u.username.toLowerCase().includes(search))
    .map(u => ({ user: u, meta: chatsMeta[u.id] || { lastMessage: null, unread: 0 } }))
    .sort((a,b) => {
      const tA = a.meta.lastMessage ? new Date(a.meta.lastMessage.created_at).getTime() : 0;
      const tB = b.meta.lastMessage ? new Date(b.meta.lastMessage.created_at).getTime() : 0;
      return tB - tA;
    });

  if (!items.length) { ul.innerHTML = '<div class="empty-state">Пока нет друзей.<br>Открой вкладку «Люди» и добавь кого-нибудь.</div>'; return; }

  items.forEach(({ user, meta }) => {
    const li = document.createElement('li');
    li.className = 'chat-item';
    if (currentChatUser && user.id === currentChatUser.id) li.classList.add('active');
    li.onclick = () => openChat(user);

    const av = makeAvatar(user.username);
    if (onlineUsers.has(user.id)) av.style.boxShadow = '0 0 0 2px var(--online)';
    li.appendChild(av);

    const body = document.createElement('div'); body.className = 'chat-body';
    const top = document.createElement('div'); top.className = 'chat-top';
    const nameEl = document.createElement('div'); nameEl.className = 'chat-name'; nameEl.textContent = user.username;
    const timeEl = document.createElement('div'); timeEl.className = 'chat-time';
    if (meta.lastMessage) timeEl.textContent = formatListTime(meta.lastMessage.created_at);
    top.appendChild(nameEl); top.appendChild(timeEl);

    const bottom = document.createElement('div'); bottom.className = 'chat-bottom';
    const preview = document.createElement('div'); preview.className = 'chat-preview';
    if (typingUsers.has(user.id) && currentChatUser && currentChatUser.id === user.id) {
      preview.textContent = 'печатает...'; preview.classList.add('typing');
    } else if (meta.lastMessage) {
      preview.textContent = (meta.lastMessage.sender_id === myId ? 'Вы: ' : '') + meta.lastMessage.content;
    } else preview.textContent = 'Нет сообщений';
    bottom.appendChild(preview);

    if (meta.unread > 0 && !(currentChatUser && currentChatUser.id === user.id)) {
      const b = document.createElement('div'); b.className = 'unread-badge'; b.textContent = meta.unread > 99 ? '99+' : meta.unread;
      bottom.appendChild(b);
    }
    body.appendChild(top); body.appendChild(bottom); li.appendChild(body); ul.appendChild(li);
  });
}

function renderRequests(ul, search) {
  const incoming = getIncoming();
  const outgoing = getOutgoing();

  if (!incoming.length && !outgoing.length) {
    ul.innerHTML = '<div class="empty-state">Заявок нет</div>';
    return;
  }

  if (incoming.length) {
    const title = document.createElement('div');
    title.className = 'section-title';
    title.style.padding = '8px 16px';
    title.textContent = 'Входящие';
    ul.appendChild(title);
    incoming.forEach(f => {
      const user = allUsers.find(u => u.id === f.requester_id);
      if (!user) return;
      if (search && !user.username.toLowerCase().includes(search)) return;
      ul.appendChild(buildRequestItem(user, 'incoming', f.id));
    });
  }
  if (outgoing.length) {
    const title = document.createElement('div');
    title.className = 'section-title';
    title.style.padding = '8px 16px';
    title.textContent = 'Исходящие';
    ul.appendChild(title);
    outgoing.forEach(f => {
      const user = allUsers.find(u => u.id === f.addressee_id);
      if (!user) return;
      if (search && !user.username.toLowerCase().includes(search)) return;
      ul.appendChild(buildRequestItem(user, 'outgoing', f.id));
    });
  }
}

function buildRequestItem(user, type, fid) {
  const li = document.createElement('li'); li.className = 'chat-item';
  const av = makeAvatar(user.username);
  li.appendChild(av);
  const body = document.createElement('div'); body.className = 'chat-body';
  const top = document.createElement('div'); top.className = 'chat-top';
  const nameEl = document.createElement('div'); nameEl.className = 'chat-name'; nameEl.textContent = user.username;
  top.appendChild(nameEl); body.appendChild(top);

  const bottom = document.createElement('div'); bottom.className = 'chat-bottom';
  const spacer = document.createElement('div'); spacer.style.flex = '1';
  bottom.appendChild(spacer);

  if (type === 'incoming') {
    const accept = document.createElement('button'); accept.className = 'action-btn accept'; accept.textContent = 'Принять';
    accept.onclick = e => { e.stopPropagation(); acceptFriend(fid); };
    const reject = document.createElement('button'); reject.className = 'action-btn reject'; reject.textContent = 'Отклонить';
    reject.onclick = e => { e.stopPropagation(); rejectFriend(fid); };
    bottom.appendChild(accept); bottom.appendChild(reject);
  } else {
    const cancel = document.createElement('button'); cancel.className = 'action-btn cancel'; cancel.textContent = 'Отменить';
    cancel.onclick = e => { e.stopPropagation(); rejectFriend(fid); };
    bottom.appendChild(cancel);
  }
  body.appendChild(bottom); li.appendChild(body);
  return li;
}

function renderPeople(ul, search) {
  const items = allUsers
    .filter(u => u.id !== myId)
    .filter(u => !search || u.username.toLowerCase().includes(search));

  if (!items.length) { ul.innerHTML = '<div class="empty-state">Никого не найдено</div>'; return; }

  items.forEach(u => {
    const li = document.createElement('li'); li.className = 'chat-item';
    const av = makeAvatar(u.username);
    if (onlineUsers.has(u.id)) av.style.boxShadow = '0 0 0 2px var(--online)';
    li.appendChild(av);

    const body = document.createElement('div'); body.className = 'chat-body';
    const top = document.createElement('div'); top.className = 'chat-top';
    const nameEl = document.createElement('div'); nameEl.className = 'chat-name'; nameEl.textContent = u.username;
    top.appendChild(nameEl); body.appendChild(top);

    const bottom = document.createElement('div'); bottom.className = 'chat-bottom';
    const status = document.createElement('div'); status.className = 'item-status';
    status.textContent = onlineUsers.has(u.id) ? 'в сети' : lastSeenText(u.last_seen);
    bottom.appendChild(status);
    const spacer = document.createElement('div'); spacer.style.flex = '1';
    bottom.appendChild(spacer);

    const fs = getFriendship(u.id);
    if (!fs) {
      const btn = document.createElement('button'); btn.className = 'action-btn add'; btn.textContent = 'Добавить';
      btn.onclick = e => { e.stopPropagation(); sendFriendRequest(u.id); };
      bottom.appendChild(btn);
    } else if (fs.status === 'accepted') {
      const btn = document.createElement('button'); btn.className = 'action-btn pending'; btn.textContent = 'В друзьях';
      btn.onclick = e => { e.stopPropagation(); openChat(u); };
      bottom.appendChild(btn);
    } else if (fs.status === 'pending') {
      const btn = document.createElement('button'); btn.className = 'action-btn pending'; btn.textContent = 'Заявка отправлена';
      bottom.appendChild(btn);
    } else {
      const btn = document.createElement('button'); btn.className = 'action-btn add'; btn.textContent = 'Добавить';
      btn.onclick = e => { e.stopPropagation(); sendFriendRequest(u.id); };
      bottom.appendChild(btn);
    }
    body.appendChild(bottom); li.appendChild(body); ul.appendChild(li);
  });
}

// === CHAT ===
async function openChat(user) {
  if (!areFriends(user.id)) { alert('Сначала добавьте пользователя в друзья'); return; }
  currentChatUser = user;
  document.getElementById('chat-header-name').textContent = user.username;
  const headerAv = document.getElementById('chat-avatar');
  headerAv.style.display = 'flex';
  const newAv = makeAvatar(user.username, 40); newAv.id = 'chat-avatar';
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
  render();
}

function updateHeaderStatus() {
  if (!currentChatUser) return;
  const status = document.getElementById('chat-header-status');
  if (typingUsers.has(currentChatUser.id)) { status.textContent = 'печатает...'; status.className = 'typing'; }
  else if (onlineUsers.has(currentChatUser.id)) { status.textContent = 'в сети'; status.className = 'online'; }
  else { const u = allUsers.find(x => x.id === currentChatUser.id); status.textContent = lastSeenText(u?.last_seen); status.className = ''; }
}

async function loadHistory(user) {
  const { data } = await sb.from('messages').select('*')
    .or('and(sender_id.eq.' + myId + ',receiver_id.eq.' + user.id + '),and(sender_id.eq.' + user.id + ',receiver_id.eq.' + myId + ')')
    .order('created_at', { ascending: true });
  if (data) { data.forEach(renderMessage); document.getElementById('messages').scrollTop = 999999; }
}

async function markAsRead(user) {
  await sb.from('messages').update({ read_at: new Date().toISOString() })
    .eq('sender_id', user.id).eq('receiver_id', myId).is('read_at', null);
  if (chatsMeta[user.id]) chatsMeta[user.id].unread = 0;
}

function subscribeMessages(user) {
  messageChannel = sb.channel('messages-' + user.id + '-' + Date.now())
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
      const msg = payload.new;
      const relevant = (msg.sender_id === myId && msg.receiver_id === user.id) || (msg.sender_id === user.id && msg.receiver_id === myId);
      if (!relevant) return;
      const other = msg.sender_id === myId ? msg.receiver_id : msg.sender_id;
      chatsMeta[other] = chatsMeta[other] || { lastMessage: null, unread: 0 };
      chatsMeta[other].lastMessage = msg;
      if (msg.receiver_id === myId && !msg.read_at && (!currentChatUser || currentChatUser.id !== user.id)) chatsMeta[other].unread++;
      if (currentChatUser && currentChatUser.id === user.id) {
        renderMessage(msg);
        document.getElementById('messages').scrollTop = 999999;
      }
      render();
      if (msg.receiver_id === myId && currentChatUser && currentChatUser.id === msg.sender_id) markAsRead(user);
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, (payload) => {
      if (payload.new.read_at) {
        const el = document.querySelector('[data-msg-id="' + payload.new.id + '"] .check');
        if (el) { el.textContent = '✓✓'; el.classList.add('read'); }
      }
    })
    .subscribe();
}

function renderMessage(msg) {
  const box = document.getElementById('messages');
  const dayLabel = formatDate(msg.created_at);
  if (dayLabel !== lastDate) {
    const div = document.createElement('div'); div.className = 'date-divider'; div.textContent = dayLabel;
    box.appendChild(div); lastDate = dayLabel;
  }
  const isMine = msg.sender_id === myId;
  const row = document.createElement('div');
  row.className = 'msg-row ' + (isMine ? 'mine' : 'theirs');
  row.setAttribute('data-msg-id', msg.id);
  const bubble = document.createElement('div'); bubble.className = 'msg ' + (isMine ? 'mine' : 'theirs');
  const text = document.createElement('div'); text.className = 'text'; text.textContent = msg.content;
  const meta = document.createElement('div'); meta.className = 'meta';
  const time = document.createElement('span'); time.textContent = formatTime(msg.created_at);
  meta.appendChild(time);
  if (isMine) {
    const check = document.createElement('span');
    check.className = 'check' + (msg.read_at ? ' read' : '');
    check.textContent = msg.read_at ? '✓✓' : '✓';
    meta.appendChild(check);
  }
  bubble.appendChild(text); bubble.appendChild(meta); row.appendChild(bubble); box.appendChild(row);
}

document.getElementById('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('input');
  const text = input.value.trim();
  if (!text || !currentChatUser) return;
  const { error } = await sb.from('messages').insert({ sender_id: myId, receiver_id: currentChatUser.id, content: text });
  if (error) { alert('Ошибка: ' + error.message); return; }
  input.value = ''; stopTyping(); amTyping = false;
});

const inputEl = document.getElementById('input');
inputEl.addEventListener('input', () => {
  if (!currentChatUser) return;
  if (!amTyping) { amTyping = true; setTyping(currentChatUser.id); }
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => { amTyping = false; stopTyping(); }, 2000);
});

document.getElementById('back-btn').addEventListener('click', () => {
  document.getElementById('sidebar').classList.remove('hidden');
  document.getElementById('chat').classList.add('hidden');
  currentChatUser = null;
  render();
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
      me = uname; startApp();
    }
  }
})();
