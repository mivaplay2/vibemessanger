const SUPABASE_URL = 'https://bknepaougcpebsnddmyo.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_TS5On4xp5bizVk_kJzHNCQ_iW2Mc3Op';
const { createClient } = supabase; const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let me = null, myId = null, myAvatarUrl = null;
let currentChatUser = null, allUsers = [], friendships = [], chatsMeta = {};
let msgCache = {}, replyingTo = null, pendingImage = null;
let onlineUsers = new Set(), typingUsers = new Set();
let messageChannel = null, profilesChannel = null, presenceChannel = null, friendsChannel = null;
let lastDate = null, typingTimeout = null, amTyping = false, currentTab = 'chats';

const VOICE_BUCKET = 'chat-audio';
const MAX_VOICE_SECONDS = 180;
const MAX_VOICE_BYTES = 5 * 1024 * 1024;
const VOICE_LABEL = '[Голосовое сообщение]';
let voiceDraft = null;
let sendingMessage = false;
const voiceUrlCache = new Map();

function formatVoiceDuration(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  return Math.floor(value / 60) + ':' + String(value % 60).padStart(2, '0');
}
function messagePreview(msg) {
  if (!msg) return '';
  if (msg.audio_path) return '🎤 Голосовое · ' + formatVoiceDuration(msg.audio_duration);
  return msg.content || (msg.image_url ? '[Фото]' : '');
}
function voiceMime(type) {
  const mime = (type || '').split(';')[0].trim().toLowerCase();
  return { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a' }[mime] ? mime : null;
}
function syncComposer() {
  const active = voiceDraft !== null;
  const recording = active && voiceDraft.phase !== 'ready';
  const panel = document.getElementById('voice-panel');
  panel.classList.toggle('hidden', !active);
  ['input', 'attach-btn', 'emoji-btn'].forEach(id => {
    document.getElementById(id).disabled = sendingMessage || active;
  });
  const mic = document.getElementById('voice-btn');
  mic.disabled = sendingMessage || active;
  mic.classList.toggle('recording', recording);
  document.getElementById('form').querySelector('button[type="submit"]').disabled = sendingMessage || recording;
  document.getElementById('voice-stop').classList.toggle('hidden', !active || voiceDraft.phase !== 'recording');
  document.getElementById('voice-cancel').disabled = sendingMessage;
  const audio = document.getElementById('voice-preview');
  audio.classList.toggle('hidden', !active || voiceDraft.phase !== 'ready');
  if (!active) return;
  document.getElementById('voice-status').textContent = sendingMessage ? 'Отправка голосового…' :
    voiceDraft.phase === 'starting' ? 'Разрешите доступ к микрофону…' :
    voiceDraft.phase === 'recording' ? 'Идёт запись' :
    voiceDraft.phase === 'stopping' ? 'Подготовка записи…' : 'Прослушайте и отправьте';
  document.getElementById('voice-timer').textContent = formatVoiceDuration(voiceDraft.seconds);
}
function releaseVoiceStream(draft) {
  clearInterval(draft.interval);
  clearTimeout(draft.limitTimer);
  if (draft.stream) draft.stream.getTracks().forEach(track => track.stop());
}
async function removeVoiceFile(path) {
  try {
    const { error } = await sb.storage.from(VOICE_BUCKET).remove([path]);
    if (error) console.warn('Не удалось удалить файл голосового:', error.message);
    return !error;
  } catch (error) {
    console.warn('Не удалось удалить файл голосового:', error.message);
    return false;
  }
}
function resetVoiceDraft(removeUpload = true) {
  const draft = voiceDraft;
  voiceDraft = null;
  if (draft) {
    releaseVoiceStream(draft);
    if (draft.recorder && draft.recorder.state !== 'inactive') {
      try { draft.recorder.stop(); } catch (error) { console.warn(error.message); }
    }
    if (draft.previewUrl) URL.revokeObjectURL(draft.previewUrl);
    if (removeUpload && draft.uploadedPath) void removeVoiceFile(draft.uploadedPath);
  }
  const audio = document.getElementById('voice-preview');
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  syncComposer();
}
function stopVoiceRecording() {
  const draft = voiceDraft;
  if (!draft || draft.phase !== 'recording') return;
  draft.phase = 'stopping';
  draft.seconds = Math.min(MAX_VOICE_SECONDS, (performance.now() - draft.startedAt) / 1000);
  clearInterval(draft.interval);
  clearTimeout(draft.limitTimer);
  try { draft.recorder.stop(); }
  catch (error) { resetVoiceDraft(); alert('Не удалось остановить запись: ' + error.message); return; }
  syncComposer();
}
async function startVoiceRecording() {
  if (!currentChatUser || sendingMessage || voiceDraft) return;
  if (!areFriends(currentChatUser.id)) return alert('Сначала добавьте пользователя в друзья');
  if (pendingImage || document.getElementById('input').value.trim()) {
    return alert('Отправьте текст или фото перед записью голосового');
  }
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    return alert('Запись недоступна. Откройте сайт по HTTPS в браузере с поддержкой микрофона');
  }
  const draft = { phase: 'starting', receiverId: currentChatUser.id, senderId: myId, seconds: 0, chunks: [], bytes: 0 };
  voiceDraft = draft;
  clearTimeout(typingTimeout); stopTyping(); amTyping = false;
  document.getElementById('emoji-picker')?.classList.add('hidden');
  syncComposer();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (voiceDraft !== draft) { stream.getTracks().forEach(track => track.stop()); return; }
    draft.stream = stream;
    const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm']
      .find(type => MediaRecorder.isTypeSupported(type));
    draft.recorder = new MediaRecorder(stream, { audioBitsPerSecond: 64000, ...(mimeType ? { mimeType } : {}) });
    if (!voiceMime(draft.recorder.mimeType)) throw new Error('Формат записи этого браузера не поддерживается');
    draft.recorder.ondataavailable = event => {
      if (voiceDraft !== draft || !event.data.size) return;
      draft.chunks.push(event.data); draft.bytes += event.data.size;
      if (draft.bytes > MAX_VOICE_BYTES && draft.phase === 'recording') stopVoiceRecording();
    };
    draft.recorder.onerror = () => {
      if (voiceDraft !== draft) return;
      resetVoiceDraft(); alert('Запись прервалась. Проверьте микрофон и попробуйте снова');
    };
    draft.recorder.onstop = () => {
      releaseVoiceStream(draft);
      if (voiceDraft !== draft) return;
      if (draft.phase === 'recording') draft.seconds = Math.min(MAX_VOICE_SECONDS, (performance.now() - draft.startedAt) / 1000);
      const blob = new Blob(draft.chunks, { type: draft.recorder.mimeType });
      if (!blob.size || draft.seconds < 0.35 || blob.size > MAX_VOICE_BYTES) {
        resetVoiceDraft();
        alert(blob.size > MAX_VOICE_BYTES ? 'Запись слишком большая. Попробуйте записать короче' : 'Запись слишком короткая. Попробуйте снова');
        return;
      }
      draft.blob = blob; draft.chunks = []; draft.phase = 'ready';
      draft.seconds = Math.round(draft.seconds * 10) / 10;
      draft.previewUrl = URL.createObjectURL(blob);
      document.getElementById('voice-preview').src = draft.previewUrl;
      syncComposer();
    };
    stream.getAudioTracks().forEach(track => track.addEventListener('ended', () => {
      if (voiceDraft === draft) stopVoiceRecording();
    }));
    draft.recorder.start(1000);
    draft.startedAt = performance.now(); draft.phase = 'recording';
    draft.interval = setInterval(() => {
      if (voiceDraft !== draft) return;
      draft.seconds = Math.min(MAX_VOICE_SECONDS, (performance.now() - draft.startedAt) / 1000);
      document.getElementById('voice-timer').textContent = formatVoiceDuration(draft.seconds);
    }, 250);
    draft.limitTimer = setTimeout(stopVoiceRecording, MAX_VOICE_SECONDS * 1000);
    syncComposer();
  } catch (error) {
    if (voiceDraft !== draft) return;
    resetVoiceDraft();
    const reason = error.name === 'NotAllowedError' ? 'Разрешите доступ к микрофону в настройках сайта' :
      error.name === 'NotFoundError' ? 'Микрофон не найден' :
      error.name === 'NotReadableError' ? 'Микрофон занят другим приложением' : error.message;
    alert(reason);
  }
}
function setupVoiceMessages() {
  document.getElementById('voice-btn').onclick = startVoiceRecording;
  document.getElementById('voice-stop').onclick = stopVoiceRecording;
  document.getElementById('voice-cancel').onclick = () => { if (!sendingMessage) resetVoiceDraft(); };
  syncComposer();
}
function makeVoicePlayer(msg) {
  const wrap = document.createElement('div'); wrap.className = 'voice-player';
  const label = document.createElement('div'); label.className = 'voice-message-label';
  label.textContent = '🎤 Голосовое · ' + formatVoiceDuration(msg.audio_duration);
  const audio = document.createElement('audio'); audio.controls = true; audio.preload = 'none'; audio.className = 'hidden';
  audio.setAttribute('aria-label', 'Голосовое сообщение');
  const button = document.createElement('button'); button.type = 'button'; button.className = 'voice-load'; button.textContent = '▶ Прослушать';
  button.onclick = async () => {
    if (button.disabled) return;
    button.disabled = true; button.textContent = 'Загрузка…';
    try {
      let cached = voiceUrlCache.get(msg.audio_path);
      if (!cached || cached.expiresAt < Date.now()) {
        const { data, error } = await sb.storage.from(VOICE_BUCKET).createSignedUrl(msg.audio_path, 3600);
        if (error) throw error;
        if (!data?.signedUrl) throw new Error('Не удалось получить ссылку на аудио');
        cached = { url: data.signedUrl, expiresAt: Date.now() + 3500 * 1000 };
        voiceUrlCache.set(msg.audio_path, cached);
      }
      if (!wrap.isConnected) return;
      audio.src = cached.url; audio.classList.remove('hidden'); button.classList.add('hidden');
      try { await audio.play(); } catch (error) { /* Браузер может потребовать повторное нажатие Play. */ }
    } catch (error) {
      button.textContent = '↻ Повторить'; alert('Не удалось загрузить голосовое: ' + error.message);
    } finally { button.disabled = false; }
  };
  audio.addEventListener('error', () => {
    voiceUrlCache.delete(msg.audio_path);
    button.textContent = '↻ Загрузить заново'; button.classList.remove('hidden');
  });
  audio.addEventListener('play', () => {
    document.querySelectorAll('audio').forEach(other => { if (other !== audio) other.pause(); });
  });
  wrap.append(label, audio, button); return wrap;
}
window.addEventListener('pagehide', () => resetVoiceDraft());

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
  const email = document.getElementById('reg-email').value.trim(); const username = document.getElementById('reg-username').value.trim(); const password = document.getElementById('reg-password').value;
  if (!email || !username || !password) return showError('register-error', 'Заполните все поля');
  if (password.length < 6) return showError('register-error', 'Пароль минимум 6 символов');
  const { data: existing } = await sb.from('profiles').select('username').eq('username', username).maybeSingle();
  if (existing) return showError('register-error', 'Такой ник уже занят');
  const { data, error } = await sb.auth.signUp({ email, password, options: { data: { username } } });
  if (error) return showError('register-error', error.message);
  if (!error) toggleAuth('verify');
});

document.getElementById('btn-login').addEventListener('click', async () => {
  const email = document.getElementById('login-email').value.trim(); const password = document.getElementById('login-password').value;
  if (!email || !password) return showError('login-error', 'Заполните все поля');
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) { if (error.message.includes('Email not confirmed')) return showError('login-error', 'Сначала подтвердите почту'); return showError('login-error', error.message); }
});

const btnVerify = document.getElementById('btn-verify');
if (btnVerify) {
  btnVerify.addEventListener('click', async () => {
    const email = (document.getElementById('reg-email').value || document.getElementById('login-email').value).trim(); const token = document.getElementById('verify-code').value.trim();
    if (!token || token.length < 6) return showError('verify-error', 'Введи код');
    btnVerify.textContent = 'Проверка...'; const { error } = await sb.auth.verifyOtp({ email, token, type: 'signup' }); btnVerify.textContent = 'Подтвердить';
    if (error) return showError('verify-error', error.message);
  });
}
document.getElementById('logout-btn').addEventListener('click', async () => {
  if (sendingMessage) return alert('Дождитесь отправки сообщения');
  resetVoiceDraft();
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
  if(!document.getElementById('chat-placeholder')) {
    const p = document.createElement('div'); p.id = 'chat-placeholder'; p.innerHTML = '<div class="logo-glow">✨</div><h2 style="color: #fff; margin-bottom: 8px;">Vibemessanger</h2><p>Выберите чат для начала общения</p>'; document.getElementById('app').appendChild(p);
  }
  document.getElementById('chat').classList.add('hidden');
  setupAttachment(); setupEmojiPicker(); setupCloseBtn(); setupVoiceMessages(); await loadAll(); subscribeAll(); render();
}

async function loadAll() {
  const [u, f, m] = await Promise.all([
    sb.rpc('get_known_profiles'),
    sb.from('friendships').select('*').or(`requester_id.eq.${myId},addressee_id.eq.${myId}`),
    sb.from('messages').select('*').or(`sender_id.eq.${myId},receiver_id.eq.${myId}`).order('created_at', { ascending: false })
  ]);
  if (u.data) allUsers = u.data; if (f.data) friendships = f.data; chatsMeta = {};
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

document.querySelectorAll('.tab').forEach(t => { t.addEventListener('click', () => { currentTab = t.dataset.tab; document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t)); document.getElementById('search').value = ''; render(); }); });

let searchTimeout = null;
document.getElementById('search').addEventListener('input', () => {
  if (currentTab === 'people') { clearTimeout(searchTimeout); searchTimeout = setTimeout(render, 500); } else { render(); }
});

async function render() {
  const ul = document.getElementById('list'); ul.innerHTML = ''; const search = document.getElementById('search').value.trim().toLowerCase();
  const incCount = getIncoming().length; const badge = document.getElementById('req-count');
  if (incCount > 0) { badge.textContent = incCount; badge.classList.add('visible'); } else badge.classList.remove('visible');

  if (currentTab === 'chats') renderChats(ul, search); else if (currentTab === 'requests') renderRequests(ul, search); else await renderPeople(ul, search);
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
    const top = document.createElement('div'); top.className = 'chat-top'; const nameEl = document.createElement('div'); nameEl.className = 'chat-name'; nameEl.textContent = user.username;
    const timeEl = document.createElement('div'); timeEl.className = 'chat-time'; if (meta.lastMessage) timeEl.textContent = formatListTime(meta.lastMessage.created_at);
    top.appendChild(nameEl); top.appendChild(timeEl);
    const bottom = document.createElement('div'); bottom.className = 'chat-bottom'; const preview = document.createElement('div'); preview.className = 'chat-preview';
    if (typingUsers.has(user.id) && currentChatUser?.id === user.id) { preview.textContent = 'печатает...'; preview.classList.add('typing'); }
    else if (meta.lastMessage) { preview.textContent = (meta.lastMessage.sender_id === myId ? 'Вы: ' : '') + messagePreview(meta.lastMessage); } else preview.textContent = 'Нет сообщений';
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
  const body = document.createElement('div'); body.className = 'chat-body'; const top = document.createElement('div'); top.className = 'chat-top'; const nameEl = document.createElement('div'); nameEl.className = 'chat-name'; nameEl.textContent = user.username; top.appendChild(nameEl); body.appendChild(top);
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

async function renderPeople(ul, search) {
  if (!search) { ul.innerHTML = '<div class="empty-state">Введите никнейм для глобального поиска</div>'; return; }
  ul.innerHTML = '<div class="empty-state">Ищем...</div>';
  const { data, error } = await sb.rpc('search_users', { search_query: search });
  ul.innerHTML = '';
  if (error || !data || data.length === 0) { ul.innerHTML = '<div class="empty-state">Пользователь не найден</div>'; return; }
  data.forEach(u => {
    const li = document.createElement('li'); li.className = 'chat-item'; const av = makeAvatar(u.username, null, u.avatar_url); if (onlineUsers.has(u.id)) av.style.boxShadow = '0 0 0 2px var(--online)'; li.appendChild(av);
    const body = document.createElement('div'); body.className = 'chat-body'; const top = document.createElement('div'); top.className = 'chat-top'; const nameEl = document.createElement('div'); nameEl.className = 'chat-name'; nameEl.textContent = u.username; top.appendChild(nameEl); body.appendChild(top);
    const bottom = document.createElement('div'); bottom.className = 'chat-bottom'; const status = document.createElement('div'); status.className = 'item-status'; status.textContent = onlineUsers.has(u.id) ? 'в сети' : lastSeenText(u.last_seen); bottom.appendChild(status); const spacer = document.createElement('div'); spacer.style.flex = '1'; bottom.appendChild(spacer);

    const fs = getFriendship(u.id);
    if (!fs) { const btn = document.createElement('button'); btn.className = 'action-btn add'; btn.textContent = 'Добавить'; btn.onclick = e => { e.stopPropagation(); sendFriendRequest(u.id); }; bottom.appendChild(btn); }
    else if (fs.status === 'accepted') { const btn = document.createElement('button'); btn.className = 'action-btn pending'; btn.textContent = 'В контактах'; btn.onclick = e => { e.stopPropagation(); openChat(u); }; bottom.appendChild(btn); }
    else if (fs.status === 'pending') { const btn = document.createElement('button'); btn.className = 'action-btn pending'; btn.textContent = 'Ожидает'; bottom.appendChild(btn); }
    body.appendChild(bottom); li.appendChild(body); ul.appendChild(li);
  });
}

function setupCloseBtn() {
  const existing = document.getElementById('close-chat-btn-desktop');
  if (existing) { existing.onclick = closeChat; return; }
  const btn = document.createElement('button'); btn.id = 'close-chat-btn-desktop'; btn.innerHTML = '✖'; btn.title = 'Закрыть чат'; btn.onclick = closeChat; document.getElementById('chat-header').appendChild(btn);
}
function closeChat() {
  if (sendingMessage) return alert('Дождитесь отправки сообщения');
  resetVoiceDraft(); clearTimeout(typingTimeout); stopTyping(); amTyping = false;
  document.querySelectorAll('#messages audio').forEach(audio => audio.pause());
  currentChatUser = null; cancelReply(); if(window.cancelImage) cancelImage(); document.getElementById('chat').classList.add('hidden'); document.getElementById('chat-placeholder').classList.remove('hidden'); document.getElementById('sidebar').classList.remove('hidden'); updateTitleBadge(); render();
}
async function openChat(user) {
  if (sendingMessage) return alert('Дождитесь отправки сообщения');
  if (!areFriends(user.id)) { alert('Сначала добавьте пользователя в друзья'); return; }
  resetVoiceDraft(); clearTimeout(typingTimeout); stopTyping(); amTyping = false;
  document.querySelectorAll('#messages audio').forEach(audio => audio.pause());
  currentChatUser = user; cancelReply(); if(window.cancelImage) cancelImage();
  document.getElementById('chat-header-name').textContent = user.username;
  const headerAv = document.getElementById('chat-avatar'); headerAv.style.display = 'flex'; headerAv.replaceWith(makeAvatar(user.username, 40, user.avatar_url)); document.querySelector('.chat-header-info').previousElementSibling.id = 'chat-avatar';
  document.getElementById('messages').innerHTML = ''; lastDate = null; msgCache = {};
  document.getElementById('chat-placeholder').classList.add('hidden'); document.getElementById('chat').classList.remove('hidden');
  if (window.innerWidth <= 768) document.getElementById('sidebar').classList.add('hidden');
  if (messageChannel) await sb.removeChannel(messageChannel); await loadHistory(user); await markAsRead(user); subscribeMessages(user); updateHeaderStatus(); render();
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
      if (msg.sender_id !== myId) playNotification();
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
  if (sendingMessage) return;
  if (!msgCache[id]) return;
  replyingTo = msgCache[id]; document.getElementById('reply-banner').style.display = 'flex';
  const text = escapeHtml(messagePreview(replyingTo));
  document.getElementById('reply-banner').innerHTML = `<div class="reply-content">↪ Ответ: ${text}</div><button type="button" onclick="cancelReply()">✕</button>`; document.getElementById('input').focus();
};
window.cancelReply = function() { replyingTo = null; const rb = document.getElementById('reply-banner'); if(rb) rb.style.display = 'none'; };
window.actionDelete = async function(id) {
  const msg = msgCache[id]; if (!msg || msg.sender_id !== myId || !confirm('Удалить сообщение?')) return;
  const { data, error } = await sb.from('messages').delete().eq('id', id).select('id');
  if (error) return alert('Не удалось удалить сообщение: ' + error.message);
  if (!data?.length) return alert('Сервер не подтвердил удаление');
  if (msg.audio_path) { voiceUrlCache.delete(msg.audio_path); await removeVoiceFile(msg.audio_path); }
  const row = document.querySelector(`[data-msg-id="${CSS.escape(String(id))}"]`);
  row?.querySelector('audio')?.pause(); row?.remove(); delete msgCache[id];
  await loadAll(); render();
};

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
  const box = document.getElementById('messages');
  let row = box.querySelector(`[data-msg-id="${CSS.escape(String(msg.id))}"]`);
  if (!row) {
    const date = formatDate(msg.created_at);
    if (date !== lastDate) {
      const divider = document.createElement('div'); divider.className = 'date-divider';
      divider.textContent = date; box.appendChild(divider); lastDate = date;
    }
    row = document.createElement('div'); row.dataset.msgId = msg.id; box.appendChild(row);
  }
  const mine = msg.sender_id === myId;
  const reply = msg.reply_to ? msgCache[msg.reply_to] : null;
  const bodyKey = JSON.stringify([msg.sender_id, msg.content, msg.image_url, msg.audio_path, msg.audio_duration,
    msg.reply_to, reply?.content, reply?.image_url, reply?.audio_path, reply?.audio_duration, currentChatUser?.username]);
  // Чтение и реакции обновляются без пересоздания audio: воспроизведение продолжается.
  if (row.dataset.bodyKey !== bodyKey) {
    row.dataset.bodyKey = bodyKey; row.className = 'msg-row ' + (mine ? 'mine' : 'theirs'); row.replaceChildren();
    const bubble = document.createElement('div'); bubble.className = 'msg ' + (mine ? 'mine' : 'theirs');
    if (reply) {
      const quote = document.createElement('div'); quote.className = 'msg-quote';
      const author = document.createElement('b'); author.style.color = '#64b5f6';
      author.textContent = reply.sender_id === myId ? 'Вы' : (currentChatUser?.username || '');
      quote.append(author, document.createElement('br'), document.createTextNode(messagePreview(reply)));
      quote.onclick = () => scrollToMsg(reply.id); bubble.appendChild(quote);
    }
    if (msg.image_url) {
      const image = document.createElement('img'); image.className = 'message-image';
      image.src = msg.image_url; image.alt = 'Фото в сообщении';
      image.onclick = () => window.open(msg.image_url, '_blank', 'noopener,noreferrer'); bubble.appendChild(image);
    }
    if (msg.audio_path) bubble.appendChild(makeVoicePlayer(msg));
    if (msg.content && !(msg.audio_path && msg.content === VOICE_LABEL)) {
      const text = document.createElement('div'); text.className = 'text'; text.textContent = msg.content; bubble.appendChild(text);
    }
    const reactions = document.createElement('div'); reactions.className = 'reactions'; bubble.appendChild(reactions);
    const meta = document.createElement('div'); meta.className = 'meta';
    const time = document.createElement('span'); time.textContent = formatTime(msg.created_at); meta.appendChild(time);
    if (mine) { const check = document.createElement('span'); check.className = 'check'; meta.appendChild(check); }
    bubble.appendChild(meta);
    const actions = document.createElement('div'); actions.className = 'msg-actions';
    const action = (label, title, handler) => {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
      button.title = title; button.onclick = handler; actions.appendChild(button);
    };
    action('↩️', 'Ответить', () => actionReply(msg.id));
    action('😀', 'Реакция', event => actionReact(msg.id, event));
    if (mine) action('🗑️', 'Удалить', () => actionDelete(msg.id));
    row.append(bubble, actions);
  }
  const reactions = row.querySelector('.reactions'); reactions.replaceChildren();
  for (const [emoji, users] of Object.entries(msg.reactions || {})) {
    if (!Array.isArray(users) || !users.length) continue;
    const badge = document.createElement('span'); badge.className = 'react-badge' + (users.includes(myId) ? ' active' : '');
    badge.textContent = emoji + ' ' + users.length; badge.onclick = () => toggleReaction(msg.id, emoji); reactions.appendChild(badge);
  }
  const check = row.querySelector('.check');
  if (check) { check.classList.toggle('read', Boolean(msg.read_at)); check.textContent = msg.read_at ? '✓✓' : '✓'; }
}

async function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Не удалось прочитать изображение'));
    reader.onload = event => {
      const image = new Image(); image.onerror = () => reject(new Error('Не удалось открыть изображение'));
      image.onload = () => {
        try {
          const ratio = Math.min(1, 1200 / Math.max(image.width, image.height));
          const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.width * ratio));
          canvas.height = Math.max(1, Math.round(image.height * ratio));
          canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Не удалось сжать изображение')), 'image/jpeg', 0.8);
        } catch (error) { reject(error); }
      };
      image.src = event.target.result;
    };
    reader.readAsDataURL(file);
  });
}

function setupAttachment() {
  if (document.getElementById('chat-image-input')) return;
  const form = document.getElementById('form');
  let attachBtn = document.getElementById('attach-btn');
  if (!attachBtn) { attachBtn = document.createElement('button'); attachBtn.type = 'button'; attachBtn.id = 'attach-btn'; attachBtn.textContent = '📎'; form.insertBefore(attachBtn, document.getElementById('input')); }
  const fileInput = document.createElement('input'); fileInput.id = 'chat-image-input'; fileInput.type = 'file'; fileInput.accept = 'image/jpeg, image/png, image/webp, image/gif'; fileInput.style.display = 'none'; document.body.appendChild(fileInput); attachBtn.onclick = () => fileInput.click();
  const previewBox = document.createElement('div'); previewBox.id = 'image-preview'; previewBox.style.display = 'none'; form.parentNode.insertBefore(previewBox, form);
  fileInput.onchange = e => { const file = e.target.files[0]; if (!file) return; pendingImage = file; previewBox.style.display = 'flex'; previewBox.innerHTML = `<div class="reply-content">📎 Прикреплено: ${escapeHtml(file.name)}</div><button type="button" onclick="cancelImage()">✕</button>`; };
  window.cancelImage = () => { pendingImage = null; fileInput.value = ''; previewBox.style.display = 'none'; };
}
function setupEmojiPicker() {
  if (document.getElementById('emoji-picker')) return;
  const form = document.getElementById('form');
  let emojiBtn = document.getElementById('emoji-btn');
  if (!emojiBtn) { emojiBtn = document.createElement('button'); emojiBtn.type = 'button'; emojiBtn.id = 'emoji-btn'; emojiBtn.textContent = '😀'; form.insertBefore(emojiBtn, form.querySelector('button[type="submit"]')); }
  const picker = document.createElement('div'); picker.id = 'emoji-picker'; picker.className = 'hidden';
  ['😀','😂','😊','😍','😭','😎','😡','👍','🔥','❤️','🎉','🤔','🙄','😴','🥺','✨','💯','🙌','🥰','🥶','💀','🤡','👽','👻','👀','💅','🍻','🚀','💸','🎧'].forEach(emo => { const span = document.createElement('span'); span.textContent = emo; span.className = 'emoji-item'; span.onclick = () => { if (voiceDraft || sendingMessage) return; const input = document.getElementById('input'); input.value += emo; input.focus(); }; picker.appendChild(span); });
  document.getElementById('chat').appendChild(picker); emojiBtn.onclick = (e) => { e.stopPropagation(); picker.classList.toggle('hidden'); }; document.addEventListener('click', (e) => { if (!picker.contains(e.target) && e.target !== emojiBtn) picker.classList.add('hidden'); });
}

async function submitMessage(event) {
  event.preventDefault();
  if (sendingMessage || !currentChatUser) return;
  if (!areFriends(currentChatUser.id)) return alert('Сначала добавьте пользователя в друзья');
  const input = document.getElementById('input'); const text = input.value.trim();
  const voice = voiceDraft; const image = pendingImage; const recipient = currentChatUser.id;
  if (voice && voice.phase !== 'ready') return;
  if (!text && !image && !voice) return;
  if (voice && (voice.receiverId !== recipient || voice.senderId !== myId)) {
    resetVoiceDraft(); return alert('Чат изменился. Запишите голосовое заново');
  }
  const payload = { sender_id: myId, receiver_id: recipient, content: voice ? VOICE_LABEL : text };
  if (replyingTo) payload.reply_to = replyingTo.id;
  const button = document.getElementById('form').querySelector('button[type="submit"]');
  const oldHtml = button.innerHTML; button.innerHTML = '⏳'; sendingMessage = true; syncComposer();
  try {
    if (image) {
      const blob = await compressImage(image); const path = `${myId}-${crypto.randomUUID()}.jpg`;
      const { error } = await sb.storage.from('chat-images').upload(path, blob, { contentType: 'image/jpeg', upsert: false });
      if (error) throw error;
      payload.image_url = sb.storage.from('chat-images').getPublicUrl(path).data.publicUrl;
    }
    let savedMessage = null;
    if (voice) {
      if (!voice.uploadedPath) {
        const mime = voiceMime(voice.blob.type);
        const extension = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a' }[mime];
        if (!extension) throw new Error('Неподдерживаемый формат аудио');
        const path = `${myId}/${recipient}/${crypto.randomUUID()}.${extension}`;
        const { error } = await sb.storage.from(VOICE_BUCKET).upload(path, voice.blob, { contentType: mime, upsert: false });
        if (error) throw error;
        voice.uploadedPath = path;
      }
      payload.audio_path = voice.uploadedPath; payload.audio_duration = voice.seconds;
      // После потери ответа сервера повторная попытка использует уже сохранённое сообщение.
      const { data, error } = await sb.from('messages').select('*').eq('audio_path', voice.uploadedPath).maybeSingle();
      if (error) throw error;
      savedMessage = data;
    }
    if (!savedMessage) {
      const { data, error } = await sb.from('messages').insert(payload).select('*').single();
      if (error) {
        if (voice) {
          const recovered = await sb.from('messages').select('*').eq('audio_path', voice.uploadedPath).maybeSingle();
          if (!recovered.error) savedMessage = recovered.data;
        }
        if (!savedMessage) throw error;
      } else savedMessage = data;
    }
    if (!savedMessage) throw new Error('Сервер не подтвердил отправку');
    chatsMeta[recipient] = { lastMessage: savedMessage, unread: chatsMeta[recipient]?.unread || 0 };
    msgCache[savedMessage.id] = savedMessage; renderMessage(savedMessage);
    document.getElementById('messages').scrollTop = 999999;
    input.value = ''; cancelReply(); if (window.cancelImage) cancelImage();
    if (voice) resetVoiceDraft(false);
    stopTyping(); amTyping = false; render();
  } catch (error) {
    alert('Не удалось отправить сообщение: ' + error.message + '\nПопробуйте отправить ещё раз');
  } finally {
    sendingMessage = false; button.innerHTML = oldHtml; syncComposer();
  }
}

document.getElementById('form').addEventListener('submit', submitMessage);

const inputEl = document.getElementById('input');
inputEl.addEventListener('input', () => {
  if (!currentChatUser) return; if (!amTyping) { amTyping = true; setTyping(currentChatUser.id); }
  clearTimeout(typingTimeout); typingTimeout = setTimeout(() => { amTyping = false; stopTyping(); }, 2000);
});

(async () => {
  const { data: { session } } = await sb.auth.getSession();
  if (session && !myId) {
    myId = session.user.id; const { data: profile } = await sb.from('profiles').select('username, avatar_url').eq('id', myId).maybeSingle();
    if (profile) { me = profile.username; myAvatarUrl = profile.avatar_url; startApp(); }
    else { const uname = session.user.user_metadata?.username || session.user.email.split('@')[0]; await sb.from('profiles').insert({ id: myId, username: uname }); me = uname; startApp(); }
  }
})();
