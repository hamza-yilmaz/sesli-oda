// Oda oturumu. Sinyalleşme Trystero ile Nostr ağının birçok rölesi üzerinden
// yapılır: tek bir merkezi sunucu, "oda sahibi" ya da yedek seçimi yoktur.
// Herkes eşittir; biri ayrıldığında oda dağılmaz, bölünmez.
//
// Protokol (tüm gelen veriler doğrulanır ve hız sınırına tabidir):
//   hi   {v, n: ad, m: üye mi, mu: susturuldu, df: sağırlaştırıldı}
//   chat {x: metin}
//   typ  boolean
//   sfx  efekt adı
// Lobide odaya göz atanlar (m:false) listede görünmez; onlara ses ve sohbet gönderilmez.
import {joinRoom, selfId, getRelaySockets} from '../vendor/trystero.mjs';
import {APP_ID, NOSTR_RELAYS, TURN_SERVERS, TURN_CREDENTIALS_URL} from './config.js';
import {settings} from './settings.js';
import {cleanText, makeLimiter, sha256Hex} from './util.js';
import {SFX} from './sounds.js';

export {selfId};

const PROTO = 2;
const MAX_ACTION_BYTES = 4096;

export async function roomKey(name, password) {
  if (!password) return name;
  // Şifre oda kimliğine de katılır: yanlış şifreyle girilen kişi doğru odadakilerle
  // asla eşleşmez (SDP'ler ayrıca bu şifreyle AES-GCM ile şifrelenir).
  return `${name}~${(await sha256Hex(`${APP_ID}|${name}|${password}`)).slice(0, 20)}`;
}

let turnCache = null;
async function iceServers() {
  const list = [...TURN_SERVERS];
  if (TURN_CREDENTIALS_URL) {
    try {
      turnCache ??= await fetch(TURN_CREDENTIALS_URL).then((r) => r.json());
      if (Array.isArray(turnCache)) list.push(...turnCache);
    } catch {
      turnCache = null;
    }
  }
  const urls = settings.turnUrls.split(/[\s,]+/).filter((u) => /^turns?:/i.test(u));
  if (urls.length) list.push({urls, username: settings.turnUser, credential: settings.turnPass});
  return list;
}

export function relayStatus() {
  const sockets = Object.values(getRelaySockets() || {});
  return {open: sockets.filter((s) => s.readyState === 1).length, total: sockets.length};
}

export class Session extends EventTarget {
  peers = new Map();
  member = false;
  me = {name: '', muted: false, deaf: false};
  outStream = null;
  closed = false;

  constructor(roomName, key, password) {
    super();
    this.roomName = roomName;
    this.key = key;
    this.password = password || '';
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, {detail}));
  }

  // Birden çok kez çağrılabilir; hep aynı açılış sözünü döndürür.
  open() {
    return (this.opening ??= this.#open());
  }

  async #open() {
    const config = {appId: APP_ID, maxReceiveBytes: 1 << 20};
    if (NOSTR_RELAYS.length) config.relayConfig = {urls: NOSTR_RELAYS};
    if (this.password) config.password = this.password;
    const turn = await iceServers();
    if (turn.length) config.turnConfig = turn;
    if (this.closed) return;

    this.room = joinRoom(config, this.key, {
      onJoinError: (d) => this.#emit('joinerror', d),
    });

    const limitSize = ({byteLength}) => byteLength <= MAX_ACTION_BYTES;
    const mk = (name) => {
      const a = this.room.makeAction(name);
      a.onReceive = limitSize;
      return a;
    };
    this.aHi = mk('hi');
    this.aChat = mk('chat');
    this.aTyp = mk('typ');
    this.aSfx = mk('sfx');

    this.room.onPeerJoin = (id) => {
      this.#peer(id);
      this.aHi.send(this.#hi(), {target: id}).catch(() => {});
    };
    this.room.onPeerLeave = (id) => this.#drop(id);
    this.room.onPeerStream = (stream, id) => {
      const p = this.#peer(id);
      p.stream = stream;
      if (p.member) this.#emit('stream', p);
    };

    this.aHi.onMessage = (d, {peerId}) => this.#onHi(peerId, d);
    this.aChat.onMessage = (d, {peerId}) => {
      const p = this.peers.get(peerId);
      const text = cleanText(d?.x, 500);
      if (!p?.member || !text || !p.limChat()) return;
      this.#emit('chat', {peer: p, text});
    };
    this.aTyp.onMessage = (d, {peerId}) => {
      const p = this.peers.get(peerId);
      if (!p?.member || typeof d !== 'boolean') return;
      p.typingUntil = d ? Date.now() + 5000 : 0;
      this.#emit('typing', p);
    };
    this.aSfx.onMessage = (d, {peerId}) => {
      const p = this.peers.get(peerId);
      if (!p?.member || typeof d !== 'string' || !Object.hasOwn(SFX, d) || !p.limSfx()) return;
      this.#emit('sfx', {peer: p, name: d});
    };
  }

  #peer(id) {
    let p = this.peers.get(id);
    if (!p) {
      p = {
        id,
        name: null,
        member: false,
        muted: false,
        deaf: false,
        stream: null,
        sentStream: false,
        typingUntil: 0,
        ping: null,
        limHi: makeLimiter(2, 6),
        limChat: makeLimiter(1, 5),
        limSfx: makeLimiter(0.5, 2),
      };
      this.peers.set(id, p);
    }
    return p;
  }

  #hi() {
    return {v: PROTO, n: this.me.name || '', m: this.member, mu: this.me.muted, df: this.me.deaf};
  }

  #onHi(id, d) {
    const p = this.#peer(id);
    if (!d || typeof d !== 'object' || !p.limHi()) return;
    const name = cleanText(d.n, 24);
    const wantsMember = d.m === true && !!name;
    const wasMember = p.member;
    p.name = name;
    p.muted = d.mu === true;
    p.deaf = d.df === true;

    if (wantsMember && !wasMember) {
      p.member = true;
      this.#sendStreamTo(p);
      this.#emit('join', p);
      if (p.stream) this.#emit('stream', p);
    } else if (!wantsMember && wasMember) {
      p.member = false;
      this.#emit('leave', p);
    } else {
      this.#emit('update', p);
    }
    this.#emit('roster');
  }

  #sendStreamTo(p) {
    if (!this.member || !this.outStream || p.sentStream || !p.member) return;
    p.sentStream = true;
    try {
      this.room.addStream(this.outStream, {target: p.id});
    } catch {
      p.sentStream = false;
    }
    setTimeout(() => this.#tuneSender(p.id), 1500);
  }

  // Opus için konuşmaya uygun bit hızı ve yüksek öncelik
  #tuneSender(id) {
    const pc = this.room?.getPeers()[id];
    if (!pc) return;
    for (const s of pc.getSenders()) {
      if (s.track?.kind !== 'audio') continue;
      const params = s.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = 64000;
      params.encodings[0].priority = 'high';
      params.encodings[0].networkPriority = 'high';
      s.setParameters(params).catch(() => {});
    }
  }

  #drop(id) {
    const p = this.peers.get(id);
    if (!p) return;
    this.peers.delete(id);
    if (p.member) this.#emit('leave', p);
    this.#emit('roster');
  }

  members() {
    return [...this.peers.values()].filter((p) => p.member);
  }

  memberCount() {
    return this.members().length + (this.member ? 1 : 0);
  }

  #memberIds() {
    return this.members().map((p) => p.id);
  }

  // Lobiden odaya geç: sesi diğer üyelere gönder ve kendini duyur
  enter(name, outStream) {
    this.me.name = name;
    this.member = true;
    this.outStream = outStream;
    this.members().forEach((p) => this.#sendStreamTo(p));
    this.broadcastState();
  }

  broadcastState() {
    this.aHi?.send(this.#hi()).catch(() => {});
  }

  setState(patch) {
    Object.assign(this.me, patch);
    this.broadcastState();
  }

  sendChat(text) {
    const ids = this.#memberIds();
    if (ids.length) this.aChat.send({x: text}, {target: ids}).catch(() => {});
  }

  sendTyping(on) {
    const ids = this.#memberIds();
    if (ids.length) this.aTyp.send(on, {target: ids}).catch(() => {});
  }

  sendSfx(name) {
    const ids = this.#memberIds();
    if (ids.length) this.aSfx.send(name, {target: ids}).catch(() => {});
  }

  async pingAll() {
    await Promise.all(
      this.members().map(async (p) => {
        try {
          p.ping = await this.room.ping(p.id);
        } catch {
          p.ping = null;
        }
      }),
    );
    this.#emit('ping');
  }

  connectionState(id) {
    return this.room?.getPeers()[id]?.connectionState || 'new';
  }

  async close() {
    this.closed = true;
    const room = this.room;
    this.room = null;
    this.peers.clear();
    if (room) await room.leave().catch(() => {});
  }
}
