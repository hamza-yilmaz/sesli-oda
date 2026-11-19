import {store} from './util.js';

const KEY = 'sesli_oda_v2';
const old = store.get('sesli_oda_cfg', {}); // v1 ayarlarını devral

const defaults = {
  name: typeof old.name === 'string' ? old.name : '',
  theme: old.mode === 'dark' || old.mode === 'light' ? old.mode : 'system',
  ns: 'rnnoise', // 'rnnoise' | 'browser' | 'off'
  ec: old.ec ?? true,
  agc: old.agc ?? true,
  gate: old.gate ?? true,
  thrDb: -50,
  gain: old.gain ?? 100,
  mic: old.mic || '',
  spk: old.spk || '',
  ptt: old.ptt ?? false,
  pttKey: old.pttKey || 'Space',
  beep: old.beep ?? true,
  sfx: true,
  turnUrls: '',
  turnUser: '',
  turnPass: '',
  recentRooms: [],
};

export const settings = {...defaults, ...store.get(KEY, {})};

export function saveSettings() {
  store.set(KEY, settings);
}

export function rememberRoom(name) {
  settings.recentRooms = [name, ...settings.recentRooms.filter((r) => r !== name)].slice(0, 5);
  saveSettings();
}
