const SUPABASE_URL = 'https://bknepaougcpebsnddmyo.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_TS5On4xp5bizVk_kJzHNCQ_iW2Mc3Op';

const { createClient } = supabase; const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let me = null, myId = null, myAvatarUrl = null;
let currentChatUser = null, allUsers = [], friendships = [], chatsMeta = {};
let msgCache = {}, replyingTo = null, pendingImage = null;
let onlineUsers = new Set(), typingUsers = new Set();
let messageChannel = null, profilesChannel = null, presenceChannel = null, friendsChannel = null;
let lastDate = null, typingTimeout = null, amTyping = false;
let currentTab = 'chats';

function escapeHtml(text) { return !text ? '' : text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;"); }
function colorFromString(str) { let hash = 0; for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash); return 'hsl(' + (Math.abs(hash) % 360 + 360) % 360 + ', 60%, 50%)'; }
function makeAvatar(name, size, avatarUrl) {
  const div = document.createElement('div'); div.className = 'avatar';
  if (avatarUrl) { div.style.backgroundImage = `url(${avatarUrl})`; div.style.backgroundSize = 'cover'; div.style.backgroundPosition = 'center'; div.textContent = ''; }
  else { div.style.background = colorFromString(name); div.textContent = name.charAt(0).toUpperCase(); }
  if (size) { div.style.width = size + 'px'; div.style.height = size + 'px'; div.style.fontSize = (size * 0.42) + 'px'; }
  return div;
}

function formatDate(ts) {
  const d = new Date(ts), today = new Date(), yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Сегодня'; if (d.toDateString() === yesterday.toDateString()) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}
function formatTime(ts) { return new Date(ts).toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit' }); }
function formatListTime(ts) {
  if (!ts) return ''; const d = new Date(ts), today = new Date(), yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return formatTime(ts); if (d.toDateString() === yesterday.toDateString()) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day:'2-digit', month:'2-digit' });
}
function lastSeenText(ts) {
  if (!ts) return 'Был(а) недавно'; const min = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
  if (min < 1) return 'Был(а) только что'; if (min < 60) return `Был(а) ${min} мин назад`;
  if (min < 1440) return `Был(а) ${Math.floor(min/60)} ч назад`; return 'Был(а) ' + new Date(ts).toLocaleDateString('ru-RU');
}

// === ЗВУКИ И БЕЙДЖИ ===
function playNotification() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator(); const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = 'sine'; osc.frequency.setValueAtTime(800, ctx.currentTime); osc.frequency.exponentialRampToValueAtTime(300, ctx.currentTime + 0.1);
    gain.gain.setValueAtTime(0.3, ctx.currentTime); gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.1);
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.15);
  } catch(e) {}
}
function updateTitleBadge() {
  let total = 0; for (const id in chatsMeta) total += chatsMeta[id].unread || 0;
  document.title = total > 0 ? `(${total}) Vibemessanger` : 'Vibemessanger';
}

function toggleAuth(mode) {
  document.getElementById('login-form').classList.toggle('hidden', mode !== 'login');
  document.getElementById('register-form').classList.toggle('hidden', mode !== 'register');
  const vf = document.getElementById('verify-form'); if(vf) vf.classList.toggle('hidden', mode !== 'verify');
}
window.toggleAuth = toggleAuth;
function showError(id, msg) { const el = document.getElementById(id); if (el) { el.textContent = msg; setTimeout(() => el.textContent = '', 5000); } }

document.getElementById('btn-register').addEventListener('click', async () => {
  const email = document.getElementById('reg-email').value.trim(), username = document.getElementById('reg-username').value.trim(), password = document.getElementById('reg-password').value;
  if (!email || !username || !password) return showError('register-error', 'Заполните все поля');
  if (password.length < 6) return showError('register-error', 'Пароль минимум 6 символов');
  const { data: existing } = await sb.from('profiles').select('username').eq('username', username).maybeSingle();
  if (existing) return showError('register-error', 'Такой ник уже занят');
  const { data, error } = await sb.auth.signUp({ email, password, options: { data: { username } } });
  if (error) return showError('register-error', error.message);
  if (!data.session) toggleAuth('verify');
});
document.getElementById('btn-login').addEventListener('click', async () => {
  const email = document.getElementById('login-email').value.trim(), password = document.getElementById('login-password').value;
  if (!email || !password) return showError('login-error', 'Заполните все поля');
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) { if (error.message.includes('Email not confirmed')) return showError('login-error', 'Сначала подтвердите почту'); return showError('login-error', error.message); }
});
const btnVerify = document.getElementById('btn-verify');
if (btnVerify) {
  btnVerify.addEventListener('click', async () => {
    const email = document.getElementById('reg-email').value.trim(), token = document.getElementById('verify-code').value.trim();
    if (!token || token.length < 6) return showError('verify-error', 'Введи код из письма');
    btnVerify.textContent = 'Проверка...'; const { error } = await sb.auth.verifyOtp({ email, token, type: 'signup' }); btnVerify.textContent = 'Подтвердить';
    if (error) return showError('verify-error', error.message);
  });
}
document.getElementById('logout-btn').addEventListener('click', async () => {
  if (myId) await sb.from('profiles').update({ last_seen: new Date().toISOString() }).eq('id', myId);
  [messageChannel, profilesChannel, presenceChannel, friendsChannel].forEach(ch => ch && sb.removeChannel(ch));
  await sb.auth.signOut(); location.reload();
});

sb.auth.onAuthStateChange(async (event, session) => {
  if (event === 'SIGNED_IN' && session && !myId) {
    myId = session.user.id;
    const { data: profile } = await sb.from('profiles').select('username, avatar_url').eq('id', myId).maybeSingle();
    if (!profile) { const uname = session.user.user_metadata?.username || session.user.email.split('@')[0]; await sb.from('profiles').insert({ id: myId, username: uname }); me = uname; }
    else { me = profile.username; myAvatarUrl = profile.avatar_url; }
    startApp();
  }
});

// === НАСТРОЙКИ ПРОФИЛЯ ===
function setupAvatarUpload(avatarEl) {
  avatarEl.style.cursor = 'pointer'; avatarEl.title = 'Сменить аватарку';
  const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/jpeg, image/png, image/webp'; input.style.display = 'none'; document.body.appendChild(input);
  avatarEl.onclick = () => input.click();
  input.onchange = (e) => {
    const file = e.target.files[0]; if (!file) return; const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = async () => {
        const canvas = document.createElement('canvas'); const MAX = 150; let w = img.width, h = img.height;
        if (w > h) { if (w > MAX) { h *= MAX / w; w = MAX; } } else { if (h > MAX) { w *= MAX / h; h = MAX; } }
        canvas.width = w; canvas.height = h; const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0, w, h);
        const base64 = canvas.toDataURL('image/jpeg', 0.8);
        const { error } = await sb.from('profiles').update({ avatar_url: base64 }).eq('id', myId);
        if (error) { alert('Ошибка: ' + error.message); return; }
        myAvatarUrl = base64; avatarEl.style.backgroundImage = `url(${base64})`; avatarEl.style.backgroundSize = 'cover'; avatarEl.textContent = '';
      }; img.src = ev.target.result;
    }; reader.readAsDataURL(file);
  };
}
function setupProfileSettings() {
  const meEl = document.getElementById('me'); meEl.title = "Сменить никнейм";
  meEl.onclick = async () => {
    const newName = prompt('Введите новый никнейм:', me);
    if(newName && newName.trim() !== '' && newName !== me) {
      const { error } = await sb.from('profiles').update({ username: newName.trim() }).eq('id', myId);
      if(!error) { me = newName.trim(); meEl.textContent = me; render(); } else alert('Ошибка: Такое имя уже занято или недопустимо');
    }
  };
}

async function startApp() {
  document.getElementById('auth-screen').style.display = 'none'; document.getElementById('app').style.display = 'flex';
  document.getElementById('me').textContent = me; setupProfileSettings();
  const myAv = document.getElementById('my-avatar'); const newAv = makeAvatar(me, null, myAvatarUrl); newAv.id = 'my-avatar'; myAv.replaceWith(newAv); setupAvatarUpload(newAv);
  
  const form = document.getElementById('form');
  if(!document.getElementById('reply-banner')) { const banner = document.createElement('div'); banner.id = 'reply-banner'; form.parentNode.insertBefore(banner, form); }
  
  // Создаем заглушку чата
  if(!document.getElementById('chat-placeholder')) {
    const p = document.createElement('div'); p.id = 'chat-placeholder';
    p.innerHTML = '<div class="logo-glow">✨</div><h2 style="color: #fff; margin-bottom: 8px;">Vibemessanger</h2><p>Выберите чат для начала общения</p>';
    document.getElementById('app').appendChild(p);
  }
  document.getElementById('chat').classList.add('hidden'); // прячем сам чат со старта

  setupAttachment(); setupEmojiPicker(); setupCloseBtn();
  await loadAll(); subscribeAll(); render();
}

async function loadAll() {
  const [u, f, m] = await Promise.all([
    sb.from('profiles').select('id, username, last_seen, avatar_url'),
    sb.from('friendships').select('*').or(`requester_id.eq.${myId},addressee_id.eq.${myId}`),
    sb.from('messages').select('*').or(`sender_id.eq.${myId},receiver_id.eq.${myId}`).order('created_at', { ascending: false })
  ]);
  if (u.data) allUsers = u.data; if (f.data) friendships = f.data;
  chatsMeta = {};
  if (m.data) for (const msg of m.data) {
    const other = msg.sender_id === myId ? msg.receiver_id : msg.sender_id;
    if (!chatsMeta[other]) chatsMeta[other] = { lastMessage: msg, unread: 0 };
    if (msg.receiver_id === myId && !msg.read_at) chatsMeta[other].unread++;
  }
  updateTitleBadge();
}

function subscribeAll() {
  profilesChannel = sb.channel('profiles-changes').on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, () => loadAll().then(render)).subscribe();
  friendsChannel = sb.channel('friendships-changes').on('postgres_changes', { event: '*', schema: 'public', table: 'friendships' }, () => loadAll().then(render)).subscribe();
  presenceChannel = sb.channel('online', { config: { presence: { key: myId } } })
    .on('presence', { event: 'sync' }, () => {
      const state = presenceChannel.presenceState(); onlineUsers = new Set(); typingUsers = new Set();
      for (const id in state) for (const m of state[id]) { if (m.online) onlineUsers.add(id); if (m.typingTo) typingUsers.add(id); }
      render(); updateHeaderStatus();
    }).subscribe(async (status) => { if (status === 'SUBSCRIBED') await presenceChannel.track({ online: true, typingTo: null }); });
}
function setTyping(toId) { if (presenceChannel) presenceChannel.track({ online: true, typingTo: toId }); }
function stopTyping() { if (presenceChannel) presenceChannel.track({ online: true, typingTo: null }); }
function getFriendship(otherId) { return friendships.find(f => (f.requester_id === myId && f.addressee_id === otherId) || (f.requester_id === otherId && f.addressee_id === myId)); }
function areFriends(otherId) { const f = getFriendship(otherId); return f && f.status === 'accepted'; }
function getIncoming() { return friendships.filter(f => f.status === 'pending' && f.addressee_id === myId); }
function getOutgoing() { return friendships.filter(f => f.status === 'pending' && f.requester_id === myId); }

async function sendFriendRequest(toId) { await sb.from('friendships').insert({ requester_id: myId, addressee_id: toId }); await loadAll(); render(); }
async function acceptFriend(fid) { await sb.from('friendships').update({ status: 'accepted' }).eq('id', fid); await loadAll(); render(); }
async function rejectFriend(fid) { await sb.from('friendships').delete().eq('id', fid); await loadAll(); render(); }

document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => { currentTab = t.dataset.tab; document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t)); document.getElementById('search').value = ''; render(); });
});
document.getElementById('search').addEventListener('input', render);

function render() {
  const ul = document.getElementById('list'); ul.innerHTML = ''; const search = document.getElementById('search').value.trim().toLowerCase();
  const incCount = getIncoming().length; const badge = document.getElementById('req-count');
  if (incCount > 0) { badge.textContent = incCount; badge.classList.add('visible'); } else badge.classList.remove('visible');
  if (currentTab === 'chats') renderChats(ul, search); else if (currentTab === 'requests') renderRequests(ul, search); else renderPeople(ul, search);
}

function renderChats(ul, search) {
  const friendIds = friendships.filter(f => f.status === 'accepted').map(f => f.requester_id === myId ? f.addressee_id : f.requester_id);
  const items = allUsers.filter(u => u.id !== myId && friendIds.includes(u.id)).filter(u => !search || u.username.toLowerCase().includes(search))
    .map(u => ({ user: u, meta: chatsMeta[u.id] || { lastMessage: null, unread: 0 } })).sort((a,b) => (b.meta.lastMessage ? new Date(b.meta.lastMessage.created_at).getTime() : 0) - (a.meta.lastMessage ? new Date(a.meta.lastMessage.created_at).getTime() : 0));
  if (!items.length) { ul.innerHTML = '<div class="empty-state">Пока нет диалогов.</div>'; return; }
  items.forEach(({ user, meta }) => {
    const li = document.createElement('li'); li.className = 'chat-item'; if (currentChatUser && user.id === currentChatUser.id) li.classList.add('active'); li.onclick = () => openChat(user);
    const av = makeAvatar(user.username, null, user.avatar_url); if (onlineUsers.has(user.id)) av.style.boxShadow = '0 0 0 2px var(--online)'; li.appendChild(av);
    const body = document.createElement('div'); body.className = 'chat-body';
    const top = document.createElement('div'); top.className = 'chat-top';
    const nameEl = document.createElement('div'); nameEl.className = 'chat-name'; nameEl.textContent = user.username;
    const timeEl = document.createElement('div'); timeEl.className = 'chat-time'; if (meta.lastMessage) timeEl.textContent = formatListTime(meta.lastMessage.created_at);
    top.appendChild(nameEl); top.appendChild(timeEl);
    const bottom = document.createElement('div'); bottom.className = 'chat-bottom';
    const preview = document.createElement('div'); preview.className = 'chat-preview';
    if (typingUsers.has(user.id) && currentChatUser?.id === user.id) { preview.textContent = 'печатает...'; preview.classList.add('typing'); }
    else if (meta.lastMessage) { preview.textContent = (meta.lastMessage.sender_id === myId ? 'Вы: ' : '') + (meta.lastMessage.image_url && !meta.lastMessage.content ? '[Фото]' : meta.lastMessage.content); } else preview.textContent = 'Нет сообщений';
    bottom.appendChild(preview);
    if (meta.unread > 0 && !(currentChatUser?.id === user.id)) { const b = document.createElement('div'); b.className = 'unread-badge'; b.textContent = meta.unread > 99 ? '99+' : meta.unread; bottom.appendChild(b); }
    body.appendChild(top); body.appendChild(bottom); li.appendChild(body); ul.appendChild(li);
  });
}

function renderRequests(ul, search) {
  const incoming = getIncoming(), outgoing = getOutgoing();
  if (!incoming.length && !outgoing.length) { ul.innerHTML = '<div class="empty-state">Заявок нет</div>'; return; }
  const createTitle = t => { const el = document.createElement('div'); el.className = 'section-title'; el.style.padding = '8px 16px'; el.textContent = t; ul.appendChild(el); };
  if (incoming.length) { createTitle('Входящие'); incoming.forEach(f => { const user = allUsers.find(u => u.id === f.requester_id); if (user && (!search || user.username.toLowerCase().includes(search))) ul.appendChild(buildRequestItem(user, 'incoming', f.id)); }); }
  if (outgoing.length) { createTitle('Исходящие'); outgoing.forEach(f => { const user = allUsers.find(u => u.id === f.addressee_id); if (user && (!search || user.username.toLowerCase().includes(search))) ul.appendChild(buildRequestItem(user, 'outgoing', f.id)); }); }
}
function buildRequestItem(user, type, fid) {
  const li = document.createElement('li'); li.className = 'chat-item'; li.appendChild(makeAvatar(user.username, null, user.avatar_url));
  const body = document.createElement('div'); body.className = 'chat-body';
  const top = document.createElement('div'); top.className = 'chat-top'; const nameEl = document.createElement('div'); nameEl.className = 'chat-name'; nameEl.textContent = user.username; top.appendChild(nameEl); body.appendChild(top);
  const bottom = document.createElement('div'); bottom.className = 'chat-bottom'; const spacer = document.createElement('div'); spacer.style.flex = '1'; bottom.appendChild(spacer);
  if (type === 'incoming') {
    const accept = document.createElement('button'); accept.className = 'action-btn accept'; accept.textContent = 'Принять'; accept.onclick = e => { e.stopPropagation(); acceptFriend(fid); };
    const reject = document.createElement('button'); reject.className = 'action-btn reject'; reject.textContent = 'Отклонить'; reject.onclick = e => { e.stopPropagation(); rejectFriend(fid); };
    bottom.appendChild(accept); bottom.appendChild(reject);
  } else {
    const cancel = document.createElement('button'); cancel.className = 'action-btn cancel'; cancel.textContent = 'Отменить'; cancel.onclick = e => { e.stopPropagation(); rejectFriend(fid); }; bottom.appendChild(cancel);
  }
  body.appendChild(bottom); li.appendChild(body); return li;
}
function renderPeople(ul, search) {
  const items = allUsers.filter(u => u.id !== myId).filter(u => !search || u.username.toLowerCase().includes(search));
  if (!items.length) { ul.innerHTML = '<div class="empty-state">Никого не найдено</div>'; return; }
  items.forEach(u => {
    const li = document.createElement('li'); li.className = 'chat-item'; const av = makeAvatar(u.username, null, u.avatar_url); if (onlineUsers.has(u.id)) av.style.boxShadow = '0 0 0 2px var(--online)'; li.appendChild(av);
    const body = document.createElement('div'); body.className = 'chat-body'; const top = document.createElement('div'); top.className = 'chat-top'; const nameEl = document.createElement('div'); nameEl.className = 'chat-name'; nameEl.textContent = u.username; top.appendChild(nameEl); body.appendChild(top);
    const bottom = document.createElement('div'); bottom.className = 'chat-bottom'; const status = document.createElement('div'); status.className = 'item-status'; status.textContent = onlineUsers.has(u.id) ? 'в сети' : lastSeenText(u.last_seen); bottom.appendChild(status); const spacer = document.createElement('div'); spacer.style.flex = '1'; bottom.appendChild(spacer);
    const fs = getFriendship(u.id);
    if (!fs) { const btn = document.createElement('button'); btn.className = 'action-btn add'; btn.textContent = 'Добавить'; btn.onclick = e => { e.stopPropagation(); sendFriendRequest(u.id); }; bottom.appendChild(btn); }
    else if (fs.status === 'accepted') { const btn = document.createElement('button'); btn.className = 'action-btn pending'; btn.textContent = 'В друзьях'; btn.onclick = e => { e.stopPropagation(); openChat(u); }; bottom.appendChild(btn); }
    else if (fs.status === 'pending') { const btn = document.createElement('button'); btn.className = 'action-btn pending'; btn.textContent = 'Заявка отправлена'; bottom.appendChild(btn); }
    body.appendChild(bottom); li.appendChild(body); ul.appendChild(li);
  });
}

// === ЧАТ И ЛОГИКА ===
function setupCloseBtn() {
  if(document.getElementById('close-chat-btn-desktop')) return;
  const btn = document.createElement('button'); btn.id = 'close-chat-btn-desktop'; btn.innerHTML = '✖'; btn.title = 'Закрыть чат';
  btn.onclick = closeChat;
  document.getElementById('chat-header').appendChild(btn);
}
function closeChat() {
  currentChatUser = null; cancelReply(); if(window.cancelImage) cancelImage();
  document.getElementById('chat').classList.add('hidden');
  document.getElementById('chat-placeholder').classList.remove('hidden');
  document.getElementById('sidebar').classList.remove('hidden'); // всегда показываем сайдбар при закрытии
  updateTitleBadge(); render();
}

async function openChat(user) {
  if (!areFriends(user.id)) { alert('Сначала добавьте пользователя в друзья'); return; }
  currentChatUser = user; cancelReply(); if(window.cancelImage) cancelImage();
  document.getElementById('chat-header-name').textContent = user.username;
  const headerAv = document.getElementById('chat-avatar'); headerAv.style.display = 'flex'; headerAv.replaceWith(makeAvatar(user.username, 40, user.avatar_url)); document.querySelector('.chat-header-info').previousElementSibling.id = 'chat-avatar';
  document.getElementById('messages').innerHTML = ''; lastDate = null; msgCache = {};
  
  document.getElementById('chat-placeholder').classList.add('hidden');
  document.getElementById('chat').classList.remove('hidden');
  if (window.innerWidth <= 768) document.getElementById('sidebar').classList.add('hidden'); // Прячем сайдбар ТОЛЬКО на мобилках

  if (messageChannel) await sb.removeChannel(messageChannel);
  await loadHistory(user); await markAsRead(user); subscribeMessages(user); updateHeaderStatus(); render();
}

function updateHeaderStatus() {
  if (!currentChatUser) return; const status = document.getElementById('chat-header-status');
  if (typingUsers.has(currentChatUser.id)) { status.textContent = 'печатает...'; status.className = 'typing'; }
  else if (onlineUsers.has(currentChatUser.id)) { status.textContent = 'в сети'; status.className = 'online'; }
  else { const u = allUsers.find(x => x.id === currentChatUser.id); status.textContent = lastSeenText(u?.last_seen); status.className = ''; }
}

async function loadHistory(user) {
  const { data } = await sb.from('messages').select('*').or(`and(sender_id.eq.${myId},receiver_id.eq.${user.id}),and(sender_id.eq.${user.id},receiver_id.eq.${myId})`).order('created_at', { ascending: true });
  if (data) { data.forEach(m => { msgCache[m.id] = m; renderMessage(m); }); document.getElementById('messages').scrollTop = 999999; }
}
async function markAsRead(user) {
  await sb.from('messages').update({ read_at: new Date().toISOString() }).eq('sender_id', user.id).eq('receiver_id', myId).is('read_at', null);
  if (chatsMeta[user.id]) chatsMeta[user.id].unread = 0; updateTitleBadge();
}

function subscribeMessages(user) {
  messageChannel = sb.channel('messages-' + user.id + '-' + Date.now())
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
      const msg = payload.new; const relevant = (msg.sender_id === myId && msg.receiver_id === user.id) || (msg.sender_id === user.id && msg.receiver_id === myId);
      if (!relevant) return; const other = msg.sender_id === myId ? msg.receiver_id : msg.sender_id;
      chatsMeta[other] = chatsMeta[other] || { lastMessage: null, unread: 0 }; chatsMeta[other].lastMessage = msg;
      
      if (msg.sender_id !== myId) playNotification(); // Звук при получении сообщения
      
      if (msg.receiver_id === myId && !msg.read_at && (!currentChatUser || currentChatUser.id !== user.id)) chatsMeta[other].unread++;
      if (currentChatUser && currentChatUser.id === user.id) { msgCache[msg.id] = msg; renderMessage(msg); document.getElementById('messages').scrollTop = 999999; }
      updateTitleBadge(); render();
      if (msg.receiver_id === myId && currentChatUser?.id === msg.sender_id) markAsRead(user);
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, (payload) => {
      const msg = payload.new; if ((msg.sender_id === myId && msg.receiver_id === currentChatUser?.id) || (msg.sender_id === currentChatUser?.id && msg.receiver_id === myId)) { msgCache[msg.id] = msg; renderMessage(msg); }
    })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages' }, (payload) => {
      delete msgCache[payload.old.id]; const el = document.querySelector(`[data-msg-id="${payload.old.id}"]`); if (el) el.remove();
    }).subscribe();
}

window.actionReply = function(id) {
  replyingTo = msgCache[id]; document.getElementById('reply-banner').style.display = 'flex';
  const text = replyingTo.image_url && !replyingTo.content ? '[Фотография]' : escapeHtml(replyingTo.content);
  document.getElementById('reply-banner').innerHTML = `<div class="reply-content">↪ Ответ: ${text}</div><button type="button" onclick="cancelReply()">✕</button>`;
  document.getElementById('input').focus();
};
window.cancelReply = function() { replyingTo = null; const rb = document.getElementById('reply-banner'); if(rb) rb.style.display = 'none'; };
window.actionDelete = async function(id) { if (confirm('Удалить сообщение?')) await sb.from('messages').delete().eq('id', id); };

let activeReactionMsg = null;
window.actionReact = function(id, e) {
  e.stopPropagation(); activeReactionMsg = id; let p = document.getElementById('reaction-picker');
  if(!p) {
    p = document.createElement('div'); p.id = 'reaction-picker';
    ['👍','❤️','🔥','😂','😢','😡','💯'].forEach(emo => { const s = document.createElement('span'); s.textContent = emo; s.onclick = () => { window.toggleReaction(activeReactionMsg, emo); p.classList.add('hidden'); }; p.appendChild(s); });
    document.body.appendChild(p); document.addEventListener('click', (ev) => { if(!p.contains(ev.target)) p.classList.add('hidden'); });
  }
  p.style.top = (e.pageY - 50) + 'px'; p.style.left = Math.max(10, e.pageX - 100) + 'px'; p.classList.remove('hidden');
};
window.toggleReaction = async function(msgId, emo) {
  const msg = msgCache[msgId]; if(!msg) return; let rx = msg.reactions || {}; if(!rx[emo]) rx[emo] = [];
  const idx = rx[emo].indexOf(myId); if(idx > -1) { rx[emo].splice(idx, 1); if(rx[emo].length===0) delete rx[emo]; } else rx[emo].push(myId);
  await sb.from('messages').update({reactions: rx}).eq('id', msgId);
};
window.scrollToMsg = function(id) { const el = document.querySelector(`[data-msg-id="${id}"]`); if(el) el.scrollIntoView({behavior: 'smooth', block: 'center'}); };

function renderMessage(msg) {
  const box = document.getElementById('messages'); let row = document.querySelector(`[data-msg-id="${msg.id}"]`);
  if (!row) {
    const dl = formatDate(msg.created_at); if (dl !== lastDate) { const div = document.createElement('div'); div.className = 'date-divider'; div.textContent = dl; box.appendChild(div); lastDate = dl; }
    row = document.createElement('div'); row.setAttribute('data-msg-id', msg.id); box.appendChild(row);
  }
  const isMine = msg.sender_id === myId; row.className = `msg-row ${isMine ? 'mine' : 'theirs'}`;
  let html = `<div class="msg ${isMine ? 'mine' : 'theirs'}">`;
  
  if (msg.reply_to && msgCache[msg.reply_to]) {
    const r = msgCache[msg.reply_to];
    html += `<div class="msg-quote" onclick="scrollToMsg(${r.id})"><b style="color: #64b5f6;">${r.sender_id === myId ? 'Вы' : escapeHtml(currentChatUser ? currentChatUser.username : '')}</b><br>${r.image_url && !r.content ? '[Фото]' : escapeHtml(r.content)}</div>`;
  }
  if (msg.image_url) html += `<div style="margin-bottom: 6px;"><img src="${msg.image_url}" style="max-width: 100%; border-radius: 8px; cursor: pointer; display: block;" onclick="window.open('${msg.image_url}', '_blank')"></div>`;
  if (msg.content) html += `<div class="text">${escapeHtml(msg.content)}</div>`;
  
  if (msg.reactions && Object.keys(msg.reactions).length > 0) {
    html += `<div class="reactions">`;
    for (let emo in msg.reactions) {
       const users = msg.reactions[emo]; if(users.length === 0) continue;
       html += `<span class="react-badge ${users.includes(myId) ? 'active' : ''}" onclick="toggleReaction(${msg.id}, '${emo}')">${emo} ${users.length}</span>`;
    }
    html += `</div>`;
  }
  html += `<div class="meta"><span>${formatTime(msg.created_at)}</span>`;
  if (isMine) html += `<span class="check ${msg.read_at ? 'read' : ''}">${msg.read_at ? '✓✓' : '✓'}</span>`;
  html += `</div></div><div class="msg-actions"><button onclick="actionReply(${msg.id})" title="Ответить">↩️</button><button onclick="actionReact(${msg.id}, event)" title="Реакция">😀</button>`;
  if (isMine) html += `<button onclick="actionDelete(${msg.id})" title="Удалить">🗑️</button>`;
  row.innerHTML = html + `</div>`;
}

// === ВЛОЖЕНИЯ И ОТПРАВКА ===
async function compressImage(file) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas'); const MAX = 1200; let w = img.width, h = img.height;
        if (w > h) { if (w > MAX) { h *= MAX / w; w = MAX; } } else { if (h > MAX) { w *= MAX / h; h = MAX; } }
        canvas.width = w; canvas.height = h; const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob(blob => resolve(blob), 'image/jpeg', 0.8);
      }; img.src = e.target.result;
    }; reader.readAsDataURL(file);
  });
}

function setupAttachment() {
  if (document.getElementById('attach-btn')) return;
  const form = document.getElementById('form'); const attachBtn = document.createElement('button'); attachBtn.type = 'button'; attachBtn.id = 'attach-btn'; attachBtn.innerHTML = '📎'; form.insertBefore(attachBtn, document.getElementById('input'));
  const fileInput = document.createElement('input'); fileInput.type = 'file'; fileInput.accept = 'image/jpeg, image/png, image/webp, image/gif'; fileInput.style.display = 'none'; document.body.appendChild(fileInput);
  attachBtn.onclick = () => fileInput.click();
  const previewBox = document.createElement('div'); previewBox.id = 'image-preview'; previewBox.style.display = 'none'; form.parentNode.insertBefore(previewBox, form);
  fileInput.onchange = e => {
    const file = e.target.files[0]; if (!file) return; pendingImage = file;
    previewBox.style.display = 'flex'; previewBox.innerHTML = `<div class="reply-content">📎 Прикреплено: ${file.name}</div><button type="button" onclick="cancelImage()">✕</button>`;
  };
  window.cancelImage = () => { pendingImage = null; fileInput.value = ''; previewBox.style.display = 'none'; };
}

function setupEmojiPicker() {
  if (document.getElementById('emoji-btn')) return;
  const form = document.getElementById('form'); const submitBtn = form.querySelector('button[type="submit"]');
  const emojiBtn = document.createElement('button'); emojiBtn.type = 'button'; emojiBtn.id = 'emoji-btn'; emojiBtn.innerHTML = '😀'; form.insertBefore(emojiBtn, submitBtn);
  const picker = document.createElement('div'); picker.id = 'emoji-picker'; picker.className = 'hidden';
  ['😀','😂','😊','😍','😭','😎','😡','👍','🔥','❤️','🎉','🤔','🙄','😴','🥺','✨','💯','🙌','🥰','🥶','💀','🤡','👽','👻','👀','💅','🍻','🚀','💸','🎧'].forEach(emo => { const span = document.createElement('span'); span.textContent = emo; span.className = 'emoji-item'; span.onclick = () => { const input = document.getElementById('input'); input.value += emo; input.focus(); }; picker.appendChild(span); });
  document.getElementById('chat').appendChild(picker);
  emojiBtn.onclick = (e) => { e.stopPropagation(); picker.classList.toggle('hidden'); }; document.addEventListener('click', (e) => { if (!picker.contains(e.target) && e.target !== emojiBtn) picker.classList.add('hidden'); });
}

const form = document.getElementById('form'); const newForm = form.cloneNode(true); form.parentNode.replaceChild(newForm, form);
newForm.addEventListener('submit', async (e) => {
  e.preventDefault(); const input = document.getElementById('input'); const text = input.value.trim();
  if (!text && !pendingImage) return; if (!currentChatUser) return;
  
  const submitBtn = newForm.querySelector('button[type="submit"]'); const oldHtml = submitBtn.innerHTML; submitBtn.innerHTML = '⏳'; submitBtn.disabled = true;
  let uploadedUrl = null;
  if (pendingImage) {
    const blob = await compressImage(pendingImage); const ext = pendingImage.name.split('.').pop() || 'jpg'; const fileName = `${myId}-${Date.now()}.${ext}`;
    const { data, error } = await sb.storage.from('chat-images').upload(fileName, blob, { contentType: pendingImage.type });
    if (error) { alert('Ошибка загрузки: ' + error.message); submitBtn.innerHTML = oldHtml; submitBtn.disabled = false; return; }
    uploadedUrl = sb.storage.from('chat-images').getPublicUrl(fileName).data.publicUrl;
  }
  
  const payload = { sender_id: myId, receiver_id: currentChatUser.id, content: text };
  if (replyingTo) payload.reply_to = replyingTo.id; if (uploadedUrl) payload.image_url = uploadedUrl;
  
  const { error } = await sb.from('messages').insert(payload);
  if (error) alert('Ошибка: ' + error.message);
  input.value = ''; cancelReply(); if(window.cancelImage) cancelImage(); stopTyping(); amTyping = false; submitBtn.innerHTML = oldHtml; submitBtn.disabled = false;
});

const inputEl = document.getElementById('input');
inputEl.addEventListener('input', () => {
  if (!currentChatUser) return; if (!amTyping) { amTyping = true; setTyping(currentChatUser.id); }
  clearTimeout(typingTimeout); typingTimeout = setTimeout(() => { amTyping = false; stopTyping(); }, 2000);
});

// Кнопка "назад" (для телефонов)
document.getElementById('back-btn').addEventListener('click', closeChat);

(async () => {
  const { data: { session } } = await sb.auth.getSession();
  if (session && !myId) {
    myId = session.user.id;
    const { data: profile } = await sb.from('profiles').select('username, avatar_url').eq('id', myId).maybeSingle();
    if (profile) { me = profile.username; myAvatarUrl = profile.avatar_url; startApp(); }
    else { const uname = session.user.user_metadata?.username || session.user.email.split('@')[0]; await sb.from('profiles').insert({ id: myId, username: uname }); me = uname; startApp(); }
  }
})();


// Update 639272289835759035
