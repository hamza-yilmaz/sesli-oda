import {$, el, icon, cleanText, cleanRoomName, initials, hueFor, timeStr, store} from './util.js';
import {settings, saveSettings, rememberRoom} from './settings.js';
import {engine} from './audio.js';
import {Session, roomKey, relayStatus, selfId} from './room.js';
import {SFX, playBeep, playSfx} from './sounds.js';
import {DEFAULT_ROOM, MAX_MEMBERS} from './config.js';

// ---------------------------------------------------------------- durum
let session = null; // lobide göz atma ya da odadaki oturum (aynı nesne)
let inRoom = false;
const views = new Map(); // peerId -> {card, avatar, status, ping, remote, slider, muteBtn}
let meView = null;
let unread = 0;
let titleCount = 0;
const peerPrefs = store.get('sesli_oda_peers', {}); // ada göre ses düzeyi / susturma

// ---------------------------------------------------------------- yardımcılar
function setBtn(btn, iconName, label, {showLabel = false} = {}) {
  btn.replaceChildren(icon(iconName), ...(showLabel ? [el('span', {class: 'lbl', text: label})] : []));
  btn.setAttribute('aria-label', label);
  btn.title = label;
}

function toast(text, {error = false, ms = 4000} = {}) {
  const t = el('div', {class: `card toast${error ? ' err' : ''}`, role: error ? 'alert' : 'status', text});
  $('toasts').append(t);
  setTimeout(() => t.remove(), ms);
}

function lobbyMsg(text, info = false) {
  $('lobbyMsg').textContent = text || '';
  $('lobbyMsg').classList.toggle('info', info);
}

function setSliderFill(input) {
  const min = +input.min, max = +input.max;
  input.style.setProperty('--p', `${((+input.value - min) / (max - min)) * 100}%`);
}

function micErrorText(e) {
  switch (e?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Mikrofon izni verilmedi. Adres çubuğundaki kilit simgesinden izin ver.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'Mikrofon bulunamadı.';
    case 'NotReadableError':
      return 'Mikrofon başka bir uygulama tarafından kullanılıyor.';
    default:
      return `Mikrofon açılamadı: ${e?.message || e}`;
  }
}

function savePeerPrefs() {
  store.set('sesli_oda_peers', peerPrefs);
}

function prefsFor(name) {
  return (peerPrefs[name] ??= {vol: 100, mute: false});
}

// ---------------------------------------------------------------- tema
function applyTheme() {
  document.documentElement.dataset.theme = settings.theme;
  const dark = settings.theme === 'dark' || (settings.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  setBtn($('themeBtn'), dark ? 'sun' : 'moon', dark ? 'Açık temaya geç' : 'Koyu temaya geç');
  document.querySelectorAll('input[name=theme]').forEach((r) => (r.checked = r.value === settings.theme));
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
$('themeBtn').onclick = () => {
  const dark = document.documentElement.dataset.theme === 'dark' || (settings.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  settings.theme = dark ? 'light' : 'dark';
  saveSettings();
  applyTheme();
};

// ---------------------------------------------------------------- lobi
function readRoomFromHash() {
  const m = location.hash.match(/(?:^#|&)oda=([^&]+)/);
  if (!m) return null;
  try {
    return cleanRoomName(decodeURIComponent(m[1]));
  } catch {
    return null;
  }
}

function currentRoomInput() {
  return cleanRoomName($('roomIn').value) || DEFAULT_ROOM;
}

function renderRecent() {
  const box = $('recent');
  box.replaceChildren();
  const rooms = settings.recentRooms.filter((r) => r !== currentRoomInput());
  if (!rooms.length) return;
  box.append(el('span', {class: 'muted', text: 'Son odalar:'}));
  rooms.forEach((r) =>
    box.append(el('button', {class: 'chip', type: 'button', text: `#${r}`, onclick: () => { $('roomIn').value = r; schedulePeek(); renderRecent(); }})),
  );
}

let peekTimer = null;
let peekStarted = 0;
function schedulePeek() {
  clearTimeout(peekTimer);
  peekTimer = setTimeout(peek, 600);
  renderPreview();
}

async function peek() {
  if (inRoom) return;
  const name = currentRoomInput();
  const pw = $('pwIn').value;
  if (pw) {
    // şifreli odayı önizlemek için şifreyle bağlanmak gerekir; şifre yazılırken her tuşta bağlanmayalım
    if (session) await closeSession();
    renderPreview();
    return;
  }
  if (session && session.key === name && !session.closed) return renderPreview();
  if (session) await closeSession();
  const s = new Session(name, name, '');
  session = s;
  peekStarted = Date.now();
  wireSession(s);
  renderPreview();
  await s.open();
}

function renderPreview() {
  const box = $('preview');
  box.replaceChildren();
  const roomName = currentRoomInput();
  if ($('pwIn').value) {
    box.append(icon('lock'), el('span', {}, el('b', {text: `#${roomName}`}), ' şifreli oda — girince odadakileri göreceksin.'));
    return;
  }
  if (!session || session.key !== roomName) {
    box.append(el('span', {class: 'spinner'}), el('span', {text: 'Oda kontrol ediliyor…'}));
    return;
  }
  const members = session.members();
  if (members.length) {
    const av = el('div', {class: 'avatars'}, members.slice(0, 5).map((p) => avatarEl(p.id, p.name)));
    const names = members.map((p) => p.name).slice(0, 3).join(', ') + (members.length > 3 ? ` +${members.length - 3}` : '');
    box.append(av, el('span', {}, el('b', {text: `${members.length} kişi`}), ` #${roomName} odasında: `, names));
    if (members.length >= MAX_MEMBERS) box.append(el('span', {class: 'form-msg', text: 'Oda dolu'}));
  } else if (Date.now() - peekStarted < 7000) {
    box.append(el('span', {class: 'spinner'}), el('span', {}, el('b', {text: `#${roomName}`}), ' aranıyor…'));
  } else {
    box.append(icon('users'), el('span', {}, el('b', {text: `#${roomName}`}), ' şu an boş. İlk giren sen ol!'));
  }
}
setInterval(() => !inRoom && renderPreview(), 2000);

$('roomIn').addEventListener('input', () => { schedulePeek(); renderRecent(); });
$('pwIn').addEventListener('input', schedulePeek);
$('pwBox').addEventListener('toggle', () => { if (!$('pwBox').open && $('pwIn').value) { $('pwIn').value = ''; schedulePeek(); } });

async function closeSession() {
  const s = session;
  session = null;
  if (s) await s.close();
}

$('joinForm').onsubmit = async (e) => {
  e.preventDefault();
  const name = cleanText($('nameIn').value, 24);
  if (!name) {
    lobbyMsg('Önce adını yaz.');
    $('nameIn').focus();
    return;
  }
  const roomName = currentRoomInput();
  const pw = $('pwIn').value;
  settings.name = name;
  saveSettings();

  const btn = $('joinBtn');
  btn.disabled = true;
  lobbyMsg('Mikrofon açılıyor…', true);
  try {
    await engine.start();
  } catch (err) {
    lobbyMsg(micErrorText(err));
    btn.disabled = false;
    return;
  }

  lobbyMsg('Odaya bağlanılıyor…', true);
  const key = await roomKey(roomName, pw);
  if (!session || session.key !== key) {
    await closeSession();
    session = new Session(roomName, key, pw);
    wireSession(session);
  }
  await session.open(); // önizleme oturumu hâlâ açılıyorsa bitmesini bekle
  if (session.members().length >= MAX_MEMBERS) {
    lobbyMsg(`Oda dolu (en fazla ${MAX_MEMBERS} kişi).`);
    btn.disabled = false;
    return;
  }

  rememberRoom(roomName);
  history.replaceState(null, '', `#oda=${encodeURIComponent(roomName)}`);
  enterRoomView(name, roomName, !!pw);
  session.enter(name, engine.outStream);
  session.setState({muted: engine.muted, deaf: deafened});
  btn.disabled = false;
  lobbyMsg('');
};

// ---------------------------------------------------------------- oturum olayları
function wireSession(s) {
  const on = (type, fn) => s.addEventListener(type, (e) => s === session && fn(e.detail));
  on('roster', () => {
    if (inRoom) updateCount();
    else renderPreview();
  });
  on('join', (p) => {
    if (!inRoom) return;
    addPeerView(p);
    sysMsg(`${p.name} odaya katıldı`);
    if (settings.beep) playBeep('in');
    notifyTitle();
  });
  on('leave', (p) => {
    if (!inRoom) return;
    removePeerView(p.id);
    sysMsg(`${p.name || 'Biri'} ayrıldı`);
    if (settings.beep) playBeep('out');
    renderTyping();
  });
  on('update', (p) => inRoom && updatePeerView(p));
  on('stream', (p) => inRoom && attachStream(p));
  on('chat', ({peer, text}) => {
    if (!inRoom) return;
    peer.typingUntil = 0;
    renderTyping();
    addMsg(peer.name, text, false);
    if (!chatVisible()) setUnread(unread + 1);
    notifyTitle();
  });
  on('typing', () => inRoom && renderTyping());
  on('sfx', ({peer, name}) => {
    if (!inRoom) return;
    if (settings.sfx && !deafened) playSfx(name);
    sysMsg(`${peer.name}: ${SFX[name].emoji} ${SFX[name].label}`);
  });
  on('ping', () => views.forEach((v, id) => renderPing(id)));
  let lastJoinErr = 0;
  on('joinerror', (d) => {
    if (Date.now() - lastJoinErr < 15000) return;
    lastJoinErr = Date.now();
    const p = s.peers.get(d?.peerId);
    const who = p?.name ? `${p.name} ile` : 'Bir kişiyle';
    toast(`${who} bağlantı kurulamadı. Ağın doğrudan bağlantıyı engelliyor olabilir; Ayarlar → Bağlantı bölümünden TURN sunucusu ekleyebilirsin.`, {error: true, ms: 9000});
  });
}

// ---------------------------------------------------------------- oda görünümü
function avatarEl(id, name) {
  const a = el('div', {class: 'avatar', 'aria-hidden': 'true', text: initials(name)});
  a.style.setProperty('--h', hueFor(name || id));
  return a;
}

function enterRoomView(name, roomName, locked) {
  inRoom = true;
  $('lobby').hidden = true;
  $('app').hidden = false;
  $('roomTitle').replaceChildren(...(locked ? [icon('lock'), ' '] : []), `#${roomName}`);
  document.title = `#${roomName} · Sesli Oda`;
  $('msgs').replaceChildren(el('p', {class: 'msg-empty', text: 'Henüz mesaj yok. Selam ver!'}));
  $('users').replaceChildren();
  views.clear();
  setUnread(0);

  meView = buildCard({id: selfId, name, me: true});
  $('users').append(meView.card);
  for (const p of session.members()) {
    addPeerView(p);
    if (p.stream) attachStream(p);
  }
  updateCount();
  updateControls();
  sysMsg(`#${roomName} odasına girdin`);
  if (settings.beep) playBeep('in');
}

function buildCard({id, name, me}) {
  const avatar = avatarEl(id, name);
  const status = el('div', {class: 'ustatus'});
  const card = el('div', {class: 'card user', dataset: {id}},
    avatar,
    el('div', {class: 'uname', title: name}, name, me ? el('span', {class: 'you', text: 'sen'}) : null),
    status,
  );
  const v = {card, avatar, status, remote: null, name};
  if (!me) {
    const pref = prefsFor(name);
    const muteBtn = el('button', {class: 'btn sm icon-btn', type: 'button'});
    const slider = el('input', {type: 'range', class: 'slider', min: 0, max: 100, step: 1, value: pref.vol, 'aria-label': `${name} ses düzeyi`});
    setSliderFill(slider);
    slider.addEventListener('input', () => {
      pref.vol = +slider.value;
      setSliderFill(slider);
      applyPeerAudio(id);
    });
    slider.addEventListener('change', savePeerPrefs);
    muteBtn.onclick = () => {
      pref.mute = !pref.mute;
      savePeerPrefs();
      applyPeerAudio(id);
    };
    card.append(el('div', {class: 'uctl'}, muteBtn, slider));
    Object.assign(v, {muteBtn, slider, pref});
  }
  return v;
}

function addPeerView(p) {
  if (views.has(p.id)) return updatePeerView(p);
  const v = buildCard({id: p.id, name: p.name, me: false});
  views.set(p.id, v);
  $('users').append(v.card);
  updatePeerView(p);
  applyPeerAudio(p.id);
}

function updatePeerView(p) {
  const v = views.get(p.id);
  if (!v) return;
  if (p.name !== v.name) {
    // ad değiştiyse kartı (ve ada bağlı ses tercihlerini) yeniden kur
    removePeerView(p.id);
    addPeerView(p);
    if (p.stream) attachStream(p);
    return;
  }
  v.status.replaceChildren(
    ...(p.muted ? [icon('micOff')] : []),
    ...(p.deaf ? [icon('headphonesOff')] : []),
    el('span', {class: 'ping'}),
  );
  v.status.title = [p.muted && 'Mikrofonu kapalı', p.deaf && 'Sesi kapalı'].filter(Boolean).join(' · ');
  renderPing(p.id);
}

function renderPing(id) {
  const v = views.get(id);
  const p = session?.peers.get(id);
  if (!v || !p) return;
  const span = v.status.querySelector('.ping');
  if (!span) return;
  const st = session.connectionState(id);
  if (!p.stream || st === 'connecting' || st === 'new') {
    span.textContent = 'bağlanıyor…';
    span.className = 'ping';
  } else if (st === 'disconnected' || st === 'failed') {
    span.textContent = 'bağlantı koptu';
    span.className = 'ping bad';
  } else if (p.ping != null) {
    span.textContent = `${p.ping} ms`;
    span.className = `ping ${p.ping < 120 ? 'good' : p.ping < 300 ? 'mid' : 'bad'}`;
  } else {
    span.textContent = '';
  }
}

function removePeerView(id) {
  const v = views.get(id);
  if (!v) return;
  v.remote?.dispose();
  v.card.remove();
  views.delete(id);
}

function attachStream(p) {
  const v = views.get(p.id);
  if (!v || !p.stream) return;
  if (v.remote && v.remoteStream === p.stream) return;
  v.remote?.dispose();
  v.remote = engine.attachRemote(p.stream);
  v.remoteStream = p.stream;
  applyPeerAudio(p.id);
  renderPing(p.id);
}

function applyPeerAudio(id) {
  const v = views.get(id);
  if (!v) return;
  const {pref} = v;
  if (v.remote) {
    v.remote.audio.volume = pref.vol / 100;
    v.remote.audio.muted = pref.mute || deafened;
  }
  setBtn(v.muteBtn, pref.mute ? 'volX' : 'vol', pref.mute ? `${v.name} sesini aç` : `${v.name} sesini kapat`);
  v.muteBtn.classList.toggle('off', pref.mute);
  v.slider.disabled = pref.mute;
}

function updateCount() {
  const n = session ? session.memberCount() : 1;
  $('countPill').replaceChildren(icon('users'), `${n} kişi`);
}

// ---------------------------------------------------------------- konuşma göstergesi (rAF)
const dbToLvl = (db) => Math.max(0, Math.min(1, (db + 55) / 40));
function frame() {
  if (inRoom) {
    if (meView) {
      const talking = engine.transmitting;
      meView.card.classList.toggle('speaking', talking);
      meView.avatar.style.setProperty('--lvl', talking ? dbToLvl(engine.level).toFixed(2) : 0);
    }
    for (const [, v] of views) {
      if (!v.remote) continue;
      const db = v.remote.level();
      const talking = db > -52 && !v.pref.mute && !deafened;
      v.card.classList.toggle('speaking', talking);
      v.avatar.style.setProperty('--lvl', talking ? dbToLvl(db).toFixed(2) : 0);
    }
  }
  if ($('settingsDlg').open) renderMeter();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------------------------------------------------------------- sohbet
function chatVisible() {
  return !document.hidden && (matchMedia('(min-width: 861px)').matches || $('app').classList.contains('chat-open'));
}

function setUnread(n) {
  unread = n;
  $('unread').hidden = n === 0;
  $('unread').textContent = n > 9 ? '9+' : String(n);
}

function appendMsg(node) {
  const box = $('msgs');
  box.querySelector('.msg-empty')?.remove();
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  box.append(node);
  while (box.childElementCount > 300) box.firstElementChild.remove();
  if (atBottom || node.classList.contains('mine')) box.scrollTop = box.scrollHeight;
}

function addMsg(who, text, mine) {
  appendMsg(el('div', {class: `msg${mine ? ' mine' : ''}`},
    el('span', {class: 'who', text: who}),
    el('span', {text}),
    el('span', {class: 't', text: timeStr()}),
  ));
}

function sysMsg(text) {
  appendMsg(el('div', {class: 'msg sys', text: `${text} · ${timeStr()}`}));
}

function renderTyping() {
  if (!session) return;
  const now = Date.now();
  const names = session.members().filter((p) => p.typingUntil > now).map((p) => p.name);
  $('typing').textContent =
    names.length === 0 ? '' : names.length === 1 ? `${names[0]} yazıyor…` : names.length === 2 ? `${names[0]} ve ${names[1]} yazıyor…` : 'Birkaç kişi yazıyor…';
}
setInterval(() => inRoom && renderTyping(), 1000);

let typingSent = 0;
let typingStop = null;
$('chatIn').addEventListener('input', () => {
  if (!session || !inRoom) return;
  const now = Date.now();
  if (now - typingSent > 3000) {
    typingSent = now;
    session.sendTyping(true);
  }
  clearTimeout(typingStop);
  typingStop = setTimeout(() => {
    typingSent = 0;
    session?.sendTyping(false);
  }, 2500);
});

$('chatForm').onsubmit = (e) => {
  e.preventDefault();
  const text = cleanText($('chatIn').value, 500);
  if (!text || !session) return;
  clearTimeout(typingStop);
  typingSent = 0;
  session.sendChat(text);
  addMsg(settings.name, text, true);
  $('chatIn').value = '';
};

function setChatOpen(open) {
  $('app').classList.toggle('chat-open', open);
  $('chatToggle').setAttribute('aria-expanded', String(open));
  if (open) {
    setUnread(0);
    $('chatIn').focus();
    $('msgs').scrollTop = $('msgs').scrollHeight;
  }
}
$('chatToggle').onclick = () => setChatOpen(!$('app').classList.contains('chat-open'));
$('chatClose').onclick = () => setChatOpen(false);

function notifyTitle() {
  if (!document.hidden) return;
  titleCount++;
  document.title = `(${titleCount}) ${document.title.replace(/^\(\d+\) /, '')}`;
}

// ---------------------------------------------------------------- kontroller
let deafened = false;
let mutedBeforeDeaf = false;

function updateControls() {
  setBtn($('muteBtn'), engine.muted ? 'micOff' : 'mic', engine.muted ? 'Mikrofonu aç (M)' : 'Mikrofonu kapat (M)');
  $('muteBtn').classList.toggle('off', engine.muted);
  $('muteBtn').setAttribute('aria-pressed', String(engine.muted));
  setBtn($('deafBtn'), deafened ? 'headphonesOff' : 'headphones', deafened ? 'Sesi aç (D)' : 'Sesi kapat (D)');
  $('deafBtn').classList.toggle('off', deafened);
  $('deafBtn').setAttribute('aria-pressed', String(deafened));
  $('pttBtn').hidden = !settings.ptt;
  setBtn($('pttBtn'), 'kbd', `Bas-konuş: ${keyName(settings.pttKey)}`, {showLabel: true});
  $('pttBtn').classList.toggle('on', engine.pttDown);
  if (meView) {
    meView.status.replaceChildren(
      ...(engine.muted ? [icon('micOff')] : []),
      ...(deafened ? [icon('headphonesOff')] : []),
      el('span', {class: 'ping', text: settings.ptt ? `bas-konuş · ${keyName(settings.pttKey)}` : engine.rnnoiseActive ? 'gürültü engelleme açık' : ''}),
    );
  }
}

function setMuted(m) {
  engine.setMuted(m);
  if (!m && deafened) {
    deafened = false;
    views.forEach((_, id) => applyPeerAudio(id));
  }
  session?.setState({muted: engine.muted, deaf: deafened});
  updateControls();
}

function setDeafened(d) {
  deafened = d;
  if (d) {
    mutedBeforeDeaf = engine.muted;
    engine.setMuted(true);
  } else {
    engine.setMuted(mutedBeforeDeaf);
  }
  views.forEach((_, id) => applyPeerAudio(id));
  session?.setState({muted: engine.muted, deaf: deafened});
  updateControls();
}

$('muteBtn').onclick = () => setMuted(!engine.muted);
$('deafBtn').onclick = () => setDeafened(!deafened);

// Bas-konuş: klavye + dokunmatik/fare ile basılı tutma
function setPtt(down) {
  if (engine.pttDown === down) return;
  engine.setPtt(down);
  $('pttBtn').classList.toggle('on', down);
}
const pttBtn = $('pttBtn');
pttBtn.addEventListener('pointerdown', (e) => { pttBtn.setPointerCapture(e.pointerId); setPtt(true); });
['pointerup', 'pointercancel', 'lostpointercapture'].forEach((t) => pttBtn.addEventListener(t, () => setPtt(false)));
pttBtn.addEventListener('contextmenu', (e) => e.preventDefault());

const isTyping = (t) => t instanceof HTMLElement && (t.matches('input:not([type=range]):not([type=checkbox]):not([type=radio]), textarea, select') || t.isContentEditable);
const keyName = (code) => code.replace(/^Key|^Digit/, '').replace(/^Space$/, 'Boşluk');

let capturingKey = false;
window.addEventListener('keydown', (e) => {
  if (capturingKey) {
    e.preventDefault();
    capturingKey = false;
    if (e.code !== 'Escape') settings.pttKey = e.code;
    saveSettings();
    syncSettingsForm();
    updateControls();
    return;
  }
  if (!inRoom || isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
  if (document.querySelector('dialog[open]')) return;
  if (settings.ptt && e.code === settings.pttKey) {
    e.preventDefault();
    if (!e.repeat) setPtt(true);
    return;
  }
  if (e.repeat) return;
  if (e.code === 'KeyM') setMuted(!engine.muted);
  else if (e.code === 'KeyD') setDeafened(!deafened);
});
window.addEventListener('keyup', (e) => {
  if (settings.ptt && e.code === settings.pttKey) setPtt(false);
});
window.addEventListener('blur', () => setPtt(false)); // takılı kalan bas-konuşu önle

// Ayrıl: ilk tıkta onay iste
let leaveArmed = null;
function disarmLeave() {
  clearTimeout(leaveArmed);
  leaveArmed = null;
  setBtn($('leaveBtn'), 'logout', 'Odadan ayrıl', {showLabel: true});
}
$('leaveBtn').onclick = () => {
  if (!leaveArmed) {
    setBtn($('leaveBtn'), 'logout', 'Emin misin?', {showLabel: true});
    leaveArmed = setTimeout(disarmLeave, 4000);
    return;
  }
  disarmLeave();
  leaveRoom();
};

async function leaveRoom() {
  inRoom = false;
  views.forEach((v) => v.remote?.dispose());
  views.clear();
  meView = null;
  setPtt(false);
  engine.stopMic();
  await closeSession();
  if (deafened) setDeafened(false);
  $('app').hidden = true;
  $('app').classList.remove('chat-open');
  $('lobby').hidden = false;
  document.title = 'Sesli Oda';
  titleCount = 0;
  schedulePeek();
}

// Link kopyala
$('copyLinkBtn').onclick = async () => {
  const url = `${location.origin}${location.pathname}#oda=${encodeURIComponent(session?.roomName || DEFAULT_ROOM)}`;
  try {
    await navigator.clipboard.writeText(url);
    toast(session?.password ? 'Link kopyalandı. Şifreyi ayrıca paylaşmayı unutma.' : 'Oda linki kopyalandı.');
  } catch {
    prompt('Linki kopyala:', url);
  }
};

// Soundboard
const sfxGrid = $('sfxGrid');
let lastSfx = 0;
for (const [key, {label, emoji}] of Object.entries(SFX)) {
  sfxGrid.append(el('button', {class: 'btn', type: 'button', onclick: () => {
    if (Date.now() - lastSfx < 2000) return toast('Biraz yavaş, soundboard soğuyor…');
    lastSfx = Date.now();
    playSfx(key);
    session?.sendSfx(key);
    sysMsg(`${settings.name}: ${emoji} ${label}`);
    $('sfxDlg').close();
  }}, el('span', {class: 'emo', text: emoji}), label));
}
$('sfxBtn').onclick = () => $('sfxDlg').showModal();

// Diyaloglarda boşluğa tıklayınca kapat
for (const d of document.querySelectorAll('dialog')) {
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
}

// ---------------------------------------------------------------- ayarlar
let micDirty = false;
let micTimer = null;
function scheduleMicRestart() {
  micDirty = true;
  clearTimeout(micTimer);
  micTimer = setTimeout(async () => {
    if (!engine.src) return;
    try {
      await engine.setMic();
      micDirty = false;
      updateControls();
      $('setNote').textContent = engine.rnnoiseActive || settings.ns !== 'rnnoise' ? '' : 'RNNoise bu tarayıcıda çalışmadı; tarayıcı filtresi kullanılıyor.';
    } catch (e) {
      toast(micErrorText(e), {error: true});
    }
    fillDevices();
  }, 250);
}

async function fillDevices() {
  let devs = [];
  try {
    devs = await navigator.mediaDevices.enumerateDevices();
  } catch {}
  const fill = (sel, kind, cur) => {
    sel.replaceChildren(el('option', {value: '', text: 'Varsayılan'}));
    devs.filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default').forEach((d, i) => {
      sel.append(el('option', {value: d.deviceId, text: d.label || `${kind === 'audioinput' ? 'Mikrofon' : 'Hoparlör'} ${i + 1}`}));
    });
    sel.value = [...sel.options].some((o) => o.value === cur) ? cur : '';
  };
  fill($('micSel'), 'audioinput', settings.mic);
  fill($('spkSel'), 'audiooutput', settings.spk);
  $('spkSel').disabled = !('setSinkId' in HTMLMediaElement.prototype);
  if ($('spkSel').disabled) $('spkSel').title = 'Bu tarayıcı hoparlör seçimini desteklemiyor';
}
navigator.mediaDevices?.addEventListener?.('devicechange', () => $('settingsDlg').open && fillDevices());

function syncSettingsForm() {
  $('gainRange').value = settings.gain;
  $('gainTxt').textContent = `%${settings.gain}`;
  $('thrRange').value = settings.thrDb;
  $('thrTxt').textContent = `${settings.thrDb} dB`;
  [$('gainRange'), $('thrRange')].forEach(setSliderFill);
  $('nsSel').value = settings.ns;
  $('ecChk').checked = settings.ec;
  $('agcChk').checked = settings.agc;
  $('gateChk').checked = settings.gate;
  $('modeVoice').checked = !settings.ptt;
  $('modePtt').checked = settings.ptt;
  $('voiceOpts').hidden = settings.ptt;
  $('pttOpts').hidden = !settings.ptt;
  $('thrRange').disabled = !settings.gate;
  $('pttKeyBtn').textContent = capturingKey ? 'Bir tuşa bas… (Esc: iptal)' : keyName(settings.pttKey);
  $('beepChk').checked = settings.beep;
  $('sfxChk').checked = settings.sfx;
  $('turnUrls').value = settings.turnUrls;
  $('turnUser').value = settings.turnUser;
  $('turnPass').value = settings.turnPass;
  $('meterThr').style.left = `${dbToPct(settings.thrDb)}%`;
  $('meterThr').hidden = settings.ptt || !settings.gate;
}

const dbToPct = (db) => Math.max(0, Math.min(100, ((db + 80) / 80) * 100));
function renderMeter() {
  const pct = engine.src ? dbToPct(engine.level) : 0;
  $('meterFill').style.width = `${pct}%`;
  $('meter').classList.toggle('open', engine.transmitting);
  $('meterTxt').textContent = engine.src ? `${Math.round(engine.level)} dB` : 'mikrofon kapalı';
}

let lobbyTest = false;
async function openSettings() {
  syncSettingsForm();
  $('setNote').textContent = '';
  $('settingsDlg').showModal();
  if (!engine.src) {
    try {
      await engine.start();
      lobbyTest = !inRoom;
    } catch (e) {
      $('setNote').textContent = micErrorText(e);
    }
  }
  fillDevices();
}
$('setBtn').onclick = openSettings;
$('lobbySettingsBtn').onclick = openSettings;
$('settingsDlg').addEventListener('close', () => {
  capturingKey = false;
  saveSettings();
  if (lobbyTest && !inRoom) {
    engine.stopMic(); // lobide test bitti; mikrofonu serbest bırak
    lobbyTest = false;
  }
});

const bindSwitch = (id, key, after) => $(id).addEventListener('change', () => { settings[key] = $(id).checked; saveSettings(); after?.(); });
bindSwitch('ecChk', 'ec', scheduleMicRestart);
bindSwitch('agcChk', 'agc', scheduleMicRestart);
bindSwitch('gateChk', 'gate', () => { engine.syncGate(); syncSettingsForm(); });
bindSwitch('beepChk', 'beep');
bindSwitch('sfxChk', 'sfx');
$('nsSel').onchange = () => { settings.ns = $('nsSel').value; saveSettings(); scheduleMicRestart(); };
$('micSel').onchange = () => { settings.mic = $('micSel').value; saveSettings(); scheduleMicRestart(); };
$('spkSel').onchange = () => {
  settings.spk = $('spkSel').value;
  saveSettings();
  engine.setSink(settings.spk);
  views.forEach((v) => v.remote?.audio.setSinkId?.(settings.spk).catch(() => {}));
};
$('gainRange').oninput = () => {
  settings.gain = +$('gainRange').value;
  $('gainTxt').textContent = `%${settings.gain}`;
  setSliderFill($('gainRange'));
  engine.applyGain();
};
$('thrRange').oninput = () => {
  settings.thrDb = +$('thrRange').value;
  $('thrTxt').textContent = `${settings.thrDb} dB`;
  setSliderFill($('thrRange'));
  $('meterThr').style.left = `${dbToPct(settings.thrDb)}%`;
  engine.syncGate();
};
document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', () => {
  settings.ptt = $('modePtt').checked;
  saveSettings();
  setPtt(false);
  engine.syncGate();
  engine.applyGain();
  syncSettingsForm();
  updateControls();
}));
document.querySelectorAll('input[name=theme]').forEach((r) => r.addEventListener('change', () => {
  settings.theme = r.value;
  saveSettings();
  applyTheme();
}));
$('pttKeyBtn').onclick = () => { capturingKey = true; syncSettingsForm(); };
for (const [id, key] of [['turnUrls', 'turnUrls'], ['turnUser', 'turnUser'], ['turnPass', 'turnPass']]) {
  $(id).addEventListener('change', async () => {
    settings[key] = $(id).value.trim();
    saveSettings();
    if (!inRoom) {
      await closeSession(); // önizleme yeni TURN ayarıyla yeniden bağlansın
      schedulePeek();
    }
  });
}

engine.addEventListener('micended', async () => {
  toast('Mikrofon bağlantısı kesildi, yeniden deneniyor…', {error: true});
  try {
    settings.mic = '';
    await engine.setMic();
    toast('Varsayılan mikrofona geçildi.');
  } catch (e) {
    toast(micErrorText(e), {error: true});
  }
});

// ---------------------------------------------------------------- arka plan / mobil dayanıklılık
function keepAlive() {
  engine.resume();
  views.forEach((v) => {
    if (v.remote?.audio.paused) v.remote.audio.play().catch(() => {});
  });
}
document.addEventListener('visibilitychange', () => {
  keepAlive();
  if (!document.hidden) {
    titleCount = 0;
    document.title = document.title.replace(/^\(\d+\) /, '');
    if (chatVisible()) setUnread(0);
  }
});
window.addEventListener('focus', keepAlive);
document.addEventListener('pointerdown', keepAlive, {passive: true});
setInterval(keepAlive, 5000);

// Ping ve ağ durumu
setInterval(() => inRoom && session?.pingAll(), 4000);
function renderNet() {
  const {open, total} = relayStatus();
  const pill = $('netPill');
  pill.replaceChildren(el('span', {class: 'dot'}), total ? `Ağ ${open}/${total}` : 'Ağ…');
  pill.classList.toggle('bad', total > 0 && open === 0);
  pill.classList.toggle('warn', open > 0 && open < Math.ceil(total / 2));
  $('netLobby').textContent = total ? `Eşleşme ağı: ${open}/${total} röle bağlı` : '';
}
setInterval(renderNet, 2000);
window.addEventListener('offline', () => toast('İnternet bağlantısı koptu. Geri gelince otomatik yeniden bağlanılacak.', {error: true, ms: 6000}));
window.addEventListener('online', () => toast('İnternet geri geldi.'));

// ---------------------------------------------------------------- başlangıç
setBtn($('lobbySettingsBtn'), 'sliders', 'Ses ayarları ve mikrofon testi');
setBtn($('sfxBtn'), 'music', 'Soundboard');
setBtn($('setBtn'), 'sliders', 'Ses ayarları');
setBtn($('copyLinkBtn'), 'link', 'Linki kopyala', {showLabel: true});
setBtn($('chatClose'), 'x', 'Sohbeti kapat');
setBtn($('setClose'), 'x', 'Kapat');
setBtn($('sfxClose'), 'x', 'Kapat');
setBtn($('sendBtn'), 'send', 'Gönder');
$('chatToggle').prepend(icon('chat'));
disarmLeave();
applyTheme();
updateControls();

$('nameIn').value = settings.name;
$('roomIn').value = readRoomFromHash() || settings.recentRooms[0] || '';
renderRecent();
window.addEventListener('hashchange', () => {
  if (inRoom) return;
  const r = readRoomFromHash();
  if (r) { $('roomIn').value = r; schedulePeek(); renderRecent(); }
});

if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection || !window.AudioWorkletNode) {
  lobbyMsg('Bu tarayıcı ya da bağlantı desteklenmiyor. Güncel bir tarayıcıyla HTTPS üzerinden aç.');
  $('joinBtn').disabled = true;
} else {
  peek();
}
(settings.name ? $('joinBtn') : $('nameIn')).focus({preventScroll: true});
