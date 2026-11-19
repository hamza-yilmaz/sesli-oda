// Giriş/çıkış bipleri ve soundboard efektleri (sentezlenir, dosya gerekmez).
import {engine} from './audio.js';

export const SFX = {
  tada: {label: 'Tada', emoji: '🎉'},
  laugh: {label: 'Kahkaha', emoji: '😂'},
  laser: {label: 'Lazer', emoji: '⚡'},
  airhorn: {label: 'Korna', emoji: '📢'},
  drum: {label: 'Ba-dum-tss', emoji: '🥁'},
  boo: {label: 'Yuh', emoji: '👎'},
};

function tone(ctx, {type = 'sine', freqs, start, dur, vol = 0.08, glideTo}) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.connect(g).connect(ctx.destination);
  freqs.forEach(([f, at]) => o.frequency.setValueAtTime(f, start + at));
  if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, start + dur);
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(vol, start + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  o.start(start);
  o.stop(start + dur + 0.02);
}

function noiseBurst(ctx, start, dur, vol, hp = 6000) {
  const len = Math.ceil(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const s = ctx.createBufferSource();
  s.buffer = buf;
  const f = ctx.createBiquadFilter();
  f.type = 'highpass';
  f.frequency.value = hp;
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, start);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  s.connect(f).connect(g).connect(ctx.destination);
  s.start(start);
}

export function playBeep(kind) {
  const ctx = engine.ctx;
  if (!ctx) return;
  const t = ctx.currentTime;
  const [a, b] = kind === 'in' ? [523.25, 783.99] : [783.99, 523.25];
  tone(ctx, {freqs: [[a, 0], [b, 0.08]], start: t, dur: 0.25, vol: 0.06});
}

export function playSfx(name) {
  const ctx = engine.ctx;
  if (!ctx || !SFX[name]) return;
  engine.resume();
  const t = ctx.currentTime;
  switch (name) {
    case 'tada':
      tone(ctx, {type: 'triangle', freqs: [[440, 0], [554.37, 0.1], [659.25, 0.2], [880, 0.3]], start: t, dur: 0.7, vol: 0.12});
      break;
    case 'laugh':
      [0, 0.13, 0.26, 0.39, 0.52].forEach((o, i) =>
        tone(ctx, {type: 'sawtooth', freqs: [[340 - i * 18, 0]], glideTo: 260 - i * 18, start: t + o, dur: 0.1, vol: 0.05}),
      );
      break;
    case 'laser':
      tone(ctx, {type: 'sawtooth', freqs: [[1200, 0]], glideTo: 90, start: t, dur: 0.35, vol: 0.08});
      break;
    case 'airhorn':
      [0, 0.28].forEach((o) => {
        tone(ctx, {type: 'square', freqs: [[466.16, 0]], start: t + o, dur: 0.24, vol: 0.06});
        tone(ctx, {type: 'square', freqs: [[587.33, 0]], start: t + o, dur: 0.24, vol: 0.04});
      });
      break;
    case 'drum':
      tone(ctx, {freqs: [[180, 0]], glideTo: 60, start: t, dur: 0.18, vol: 0.25});
      tone(ctx, {freqs: [[140, 0]], glideTo: 50, start: t + 0.18, dur: 0.18, vol: 0.25});
      noiseBurst(ctx, t + 0.42, 0.6, 0.15);
      break;
    case 'boo':
      tone(ctx, {type: 'sawtooth', freqs: [[220, 0]], glideTo: 110, start: t, dur: 0.8, vol: 0.06});
      break;
  }
}
