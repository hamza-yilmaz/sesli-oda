// Ses motoru. Tek bir AudioContext uygulama boyunca yaşar ve hiç kapatılmaz;
// böylece mikrofon değiştiğinde karşı tarafların analizörleri bozulmaz.
//
// Giden zincir:  mikrofon → [RNNoise] → kapı (worklet) → kazanç (sustur/PTT) → hedef
// Hedefin ses izi hiç değişmez, bu yüzden mikrofon değiştirmek için
// WebRTC yeniden anlaşması gerekmez.
import {loadRnnoise, RnnoiseWorkletNode} from '../vendor/noise/index.js';
import {settings} from './settings.js';

const vendor = (p) => new URL(`../vendor/noise/${p}`, import.meta.url).href;

export class AudioEngine extends EventTarget {
  ctx = null;
  rawStream = null;
  src = null;
  rnn = null;
  gate = null;
  gain = null;
  dest = null;
  muted = false;
  pttDown = false;
  level = -120; // dBFS, kapı öncesi
  gateOpen = true;
  rnnoiseActive = false;
  outTrackUsed = false;
  #rnnoiseWasm = null;
  #rnnoiseModule = false;

  get outTrack() {
    return this.dest?.stream.getAudioTracks()[0] || null;
  }
  get outStream() {
    return this.dest?.stream || null;
  }
  get transmitting() {
    if (this.muted || !this.src) return false;
    if (settings.ptt) return this.pttDown;
    return settings.gate ? this.gateOpen : this.level > settings.thrDb;
  }

  async start() {
    if (!this.ctx) await this.#createContext(48000);
    await this.resume();
    if (this.src) return;
    try {
      await this.setMic();
    } catch (e) {
      // Firefox, farklı örnekleme hızındaki mikrofonu 48 kHz bağlama izin vermez.
      if (e?.name === 'NotSupportedError' && this.ctx.sampleRate === 48000 && !this.outTrackUsed) {
        await this.ctx.close();
        this.ctx = null;
        await this.#createContext(undefined);
        await this.setMic();
      } else {
        throw e;
      }
    }
  }

  async #createContext(sampleRate) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx(sampleRate ? {sampleRate, latencyHint: 'interactive'} : {latencyHint: 'interactive'});
    this.#rnnoiseModule = false;
    await this.ctx.audioWorklet.addModule(new URL('./worklets/gate.js', import.meta.url).href);
    this.gate = new AudioWorkletNode(this.ctx, 'sesli-gate', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
    });
    this.gate.port.onmessage = (e) => {
      this.level = e.data.db;
      this.gateOpen = e.data.open;
    };
    this.gain = this.ctx.createGain();
    this.dest = this.ctx.createMediaStreamDestination();
    this.gate.connect(this.gain).connect(this.dest);
    this.syncGate();
    this.applyGain();
    if (settings.spk) this.setSink(settings.spk);
  }

  async resume() {
    if (this.ctx && this.ctx.state !== 'running') await this.ctx.resume().catch(() => {});
  }

  async #ensureRnnoise() {
    if (this.ctx.sampleRate !== 48000) return false;
    if (!this.#rnnoiseModule) {
      this.#rnnoiseWasm ??= await loadRnnoise({url: vendor('rnnoise.wasm'), simdUrl: vendor('rnnoise_simd.wasm')});
      await this.ctx.audioWorklet.addModule(vendor('rnnoiseWorklet.js'));
      this.#rnnoiseModule = true;
    }
    return true;
  }

  // Mikrofonu (yeniden) açar ve zinciri kurar. Ayar değişince de çağrılır.
  async setMic() {
    const useRnnoise = settings.ns === 'rnnoise' && (await this.#ensureRnnoise().catch(() => false));
    const constraints = {
      audio: {
        echoCancellation: settings.ec,
        autoGainControl: settings.agc,
        noiseSuppression: settings.ns === 'browser' || (settings.ns === 'rnnoise' && !useRnnoise),
        channelCount: 1,
        ...(settings.mic ? {deviceId: {exact: settings.mic}} : {}),
      },
    };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      if (settings.mic && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) {
        settings.mic = ''; // seçili cihaz çıkarılmış; varsayılana dön
        delete constraints.audio.deviceId;
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } else {
        throw e;
      }
    }

    let newSrc;
    try {
      newSrc = this.ctx.createMediaStreamSource(stream); // Firefox'ta NotSupportedError atabilir
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      throw e;
    }

    // Eski zinciri sök
    this.src?.disconnect();
    this.rnn?.disconnect();
    this.rnn?.destroy?.();
    this.rnn = null;
    this.rawStream?.getTracks().forEach((t) => t.stop());

    this.rawStream = stream;
    this.src = newSrc;
    if (useRnnoise) {
      this.rnn = new RnnoiseWorkletNode(this.ctx, {maxChannels: 1, wasmBinary: this.#rnnoiseWasm});
      this.src.connect(this.rnn).connect(this.gate);
    } else {
      this.src.connect(this.gate);
    }
    this.rnnoiseActive = useRnnoise;
    this.outTrackUsed = true;

    // Mikrofon çıkarılırsa ya da başka uygulama alırsa haber ver
    stream.getAudioTracks()[0]?.addEventListener('ended', () => {
      if (this.rawStream === stream) this.dispatchEvent(new Event('micended'));
    });
    this.dispatchEvent(new Event('change'));
  }

  syncGate() {
    this.gate?.port.postMessage({enabled: settings.gate && !settings.ptt, thrDb: settings.thrDb});
  }

  applyGain() {
    if (!this.gain) return;
    const open = !this.muted && (!settings.ptt || this.pttDown);
    this.gain.gain.setTargetAtTime(open ? settings.gain / 100 : 0, this.ctx.currentTime, 0.015);
  }

  setMuted(m) {
    this.muted = m;
    this.applyGain();
  }

  setPtt(down) {
    this.pttDown = down;
    this.applyGain();
  }

  setSink(id) {
    if (this.ctx?.setSinkId) this.ctx.setSinkId(id || '').catch(() => {});
  }

  // Karşı taraftan gelen akış için oynatıcı + seviye analizörü
  attachRemote(stream) {
    const audio = new Audio();
    audio.autoplay = true;
    audio.srcObject = stream;
    if (settings.spk && audio.setSinkId) audio.setSinkId(settings.spk).catch(() => {});
    audio.play().catch(() => {});
    let analyser = null;
    let srcNode = null;
    if (this.ctx) {
      analyser = this.ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.3;
      srcNode = this.ctx.createMediaStreamSource(stream);
      srcNode.connect(analyser);
    }
    const buf = new Float32Array(analyser ? analyser.fftSize : 0);
    return {
      audio,
      level() {
        if (!analyser) return -120;
        analyser.getFloatTimeDomainData(buf);
        let s = 0;
        for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
        const rms = Math.sqrt(s / buf.length);
        return rms > 1e-7 ? 20 * Math.log10(rms) : -120;
      },
      dispose() {
        srcNode?.disconnect();
        audio.pause();
        audio.srcObject = null;
      },
    };
  }

  stopMic() {
    this.src?.disconnect();
    this.rnn?.disconnect();
    this.rnn?.destroy?.();
    this.rnn = null;
    this.src = null;
    this.rawStream?.getTracks().forEach((t) => t.stop());
    this.rawStream = null;
    this.level = -120;
  }
}

export const engine = new AudioEngine();
