// Ses kapısı (noise gate) + seviye ölçer. Ses iş parçacığında çalıştığı için
// sekme arka plandayken de kısılmaz ve konuşmanın başını kesmez.
class GateProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.enabled = true;
    this.thrDb = -50;
    this.holdS = 0.3;
    this.env = 1;
    this.open = true;
    this.holdUntil = 0;
    this.peakDb = -120;
    this.sinceReport = 0;
    this.attack = 1 - Math.exp(-1 / (sampleRate * 0.004));
    this.release = 1 - Math.exp(-1 / (sampleRate * 0.08));
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (typeof d.enabled === 'boolean') this.enabled = d.enabled;
      if (Number.isFinite(d.thrDb)) this.thrDb = d.thrDb;
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length || !output || !output.length) return true;
    const ch0 = input[0];
    const n = ch0.length;

    let sum = 0;
    for (let i = 0; i < n; i++) sum += ch0[i] * ch0[i];
    const rms = Math.sqrt(sum / n);
    const db = rms > 1e-7 ? 20 * Math.log10(rms) : -120;

    if (db > this.thrDb) {
      this.open = true;
      this.holdUntil = currentTime + this.holdS;
    } else if (currentTime > this.holdUntil) {
      this.open = false;
    }
    const target = !this.enabled || this.open ? 1 : 0;
    const coef = target > this.env ? this.attack : this.release;

    let env = this.env;
    for (let c = 0; c < output.length; c++) {
      const src = input[c] || ch0;
      const dst = output[c];
      env = this.env;
      for (let i = 0; i < n; i++) {
        env += (target - env) * coef;
        dst[i] = src[i] * env;
      }
    }
    this.env = env;

    if (db > this.peakDb) this.peakDb = db;
    this.sinceReport += n;
    if (this.sinceReport >= sampleRate / 30) {
      this.port.postMessage({db: this.peakDb, open: target === 1});
      this.peakDb = -120;
      this.sinceReport = 0;
    }
    return true;
  }
}

registerProcessor('sesli-gate', GateProcessor);
