// Oda dizini: hangi odaların açık olduğunu sunucusuz olarak lobiye bildirir.
//
// Her odadaki üyelerden biri ("duyurucu": peer kimliği en küçük olan) odayı
// Nostr rölelerine kısa ömürlü (ephemeral, rölede saklanmayan) bir olayla duyurur:
//   {t:'r', r: oda adı, l: şifreli mi, n: kişi sayısı, m: [adlar] (yalnızca şifresiz odalarda)}
// Lobidekiler bu konuya abone olur ve açılışta {t:'q'} sorusu yollar; duyurucular
// hemen yanıt verir. Oda boşalınca {t:'x'} ile listeden düşer.
// Şifreli odaların yalnızca adı ve kişi sayısı görünür; şifre ya da ondan
// türetilen hiçbir değer yayınlanmaz.
import {createEvent} from '../vendor/trystero.mjs';
import {APP_ID, DIRECTORY_RELAYS} from './config.js';
import {cleanRoomName, cleanText} from './util.js';

const TOPIC = `${APP_ID}:dizin`;
// Trystero'nun Nostr stratejisiyle aynı formül: 20000–29999 arası ephemeral tür
const KIND = ([...TOPIC].reduce((a, c) => a + c.charCodeAt(0), 0) % 1e4) + 2e4;
const ANNOUNCE_MS = 20000;
const EXPIRE_MS = 50000;
const MAX_ROOMS = 30;

export class Directory extends EventTarget {
  rooms = new Map(); // "ad|kilit" -> {name, locked, count, names, seen}
  sockets = new Map();
  seenEvents = new Set();
  subId = `d${Math.random().toString(36).slice(2, 10)}`;
  // Odadayken main.js tarafından doldurulur: () => ilan nesnesi | null
  provider = null;
  #lastAnnounce = 0;
  #replyTimer = null;

  start() {
    DIRECTORY_RELAYS.forEach((url) => this.#connect(url, 0));
    setInterval(() => this.#expire(), 5000);
    setInterval(() => this.announce(), ANNOUNCE_MS);
  }

  #connect(url, attempt) {
    let ws;
    try {
      ws = new WebSocket(url);
    } catch {
      return;
    }
    this.sockets.set(url, ws);
    ws.onopen = () => {
      attempt = 0;
      const since = Math.floor(Date.now() / 1000) - 5;
      ws.send(JSON.stringify(['REQ', this.subId, {kinds: [KIND], '#x': [TOPIC], since}]));
      // Odadaysak hemen ilan et, lobideysek odaları sor
      if (this.provider?.()) this.announce(true);
      else this.query();
    };
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m[0] === 'EVENT' && m[1] === this.subId && m[2]) this.#onEvent(m[2]);
    };
    ws.onclose = () => {
      if (this.sockets.get(url) !== ws) return;
      const delay = Math.min(60000, 3000 * 2 ** attempt);
      setTimeout(() => this.#connect(url, attempt + 1), delay);
    };
  }

  get openCount() {
    return [...this.sockets.values()].filter((s) => s.readyState === 1).length;
  }

  async #publish(obj) {
    const open = [...this.sockets.values()].filter((s) => s.readyState === 1);
    if (!open.length) return;
    const msg = await createEvent(TOPIC, JSON.stringify(obj));
    open.forEach((s) => {
      try {
        s.send(msg);
      } catch {}
    });
  }

  #onEvent(ev) {
    if (typeof ev.id !== 'string' || this.seenEvents.has(ev.id)) return;
    this.seenEvents.add(ev.id);
    if (this.seenEvents.size > 2000) this.seenEvents.clear();
    if (typeof ev.content !== 'string' || ev.content.length > 2000) return;
    let d;
    try {
      d = JSON.parse(ev.content);
    } catch {
      return;
    }
    if (!d || typeof d !== 'object') return;

    if (d.t === 'q') {
      // Biri lobiye geldi; duyurucuysak kısa, rastgele bir gecikmeyle yanıt ver
      if (!this.provider?.()) return;
      clearTimeout(this.#replyTimer);
      this.#replyTimer = setTimeout(() => this.announce(true), 200 + Math.random() * 800);
      return;
    }
    const name = cleanRoomName(d.r);
    if (!name) return;
    const locked = d.l === true;
    const k = `${name}|${locked}`;
    if (d.t === 'x') {
      if (this.rooms.delete(k)) this.#changed();
      return;
    }
    if (d.t !== 'r') return;
    const count = Number.isInteger(d.n) ? Math.max(1, Math.min(99, d.n)) : 1;
    const names = !locked && Array.isArray(d.m) ? d.m.map((x) => cleanText(x, 24)).filter(Boolean).slice(0, 10) : [];
    if (!this.rooms.has(k) && this.rooms.size >= MAX_ROOMS) return;
    this.rooms.set(k, {name, locked, count, names, seen: Date.now()});
    this.#changed();
  }

  #expire() {
    const now = Date.now();
    let changed = false;
    for (const [k, r] of this.rooms) {
      if (now - r.seen > EXPIRE_MS) {
        this.rooms.delete(k);
        changed = true;
      }
    }
    if (changed) this.#changed();
  }

  #changed() {
    this.dispatchEvent(new Event('change'));
  }

  list() {
    return [...this.rooms.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'tr'));
  }

  query() {
    this.#publish({t: 'q'});
  }

  // Odadaysak ve duyurucuysak odayı ilan et. `force` değilse çok sık yayınlamaz.
  announce(force = false) {
    const info = this.provider?.();
    if (!info) return;
    if (!force && Date.now() - this.#lastAnnounce < ANNOUNCE_MS / 2) return;
    this.#lastAnnounce = Date.now();
    this.#publish({t: 'r', v: 2, r: info.name, l: info.locked, n: info.count, ...(info.locked ? {} : {m: info.names})});
  }

  // Oda boşaldı ya da listeden gizlendi
  withdraw(name, locked) {
    this.rooms.delete(`${name}|${locked}`);
    this.#publish({t: 'x', r: name, l: locked});
  }
}

export const directory = new Directory();
