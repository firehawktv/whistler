// Whistle DSP. Self-contained (no imports) so it loads in an AudioWorklet and in Node tests.
// Model: STK-flute-style jet-driven loop. The bore is one delay line whose length is the full
// round trip of a pipe closed at one end (period = 4 * Leff / c), with a one-pole loss filter.
// A second delay line is the jet travel time. Ports shorten the effective bore.

const C_AIR = 343;
const BORE_SIZE = 4096; // power of 2; max period ~1200 samples at 48k, ok to 96k
const JET_SIZE = 2048;
const NOISE_BP_HZ = 3500;
const NOISE_BP_Q = 0.9;
const JET_K = 7; // jet deflection gain

const DEFAULTS = {
  length: 0.25,   // m, 0.2..2.0
  width: 3,       // cm, 1..10
  pressure: 0.55, // 0..1
  ports: 0,       // 0..4 open ports (discrete)
  portSize: 0.5,  // 0..1
  gap: 0.45,      // 0..1 lip gap, narrow..wide
  turbulence: 0.25 // 0..1
};

function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

// Maps UI parameters to DSP targets. Control rate only (may use pow/sqrt).
// Pure function so it can be unit tested and reused per voice.
function deriveTargets(p, fs, out) {
  const length = clamp(p.length, 0.2, 2.0);
  const width = clamp(p.width, 1, 10);
  const pressure = clamp(p.pressure, 0, 1);
  const ports = clamp(Math.round(p.ports), 0, 4);
  const portSize = clamp(p.portSize, 0, 1);
  const gap = clamp(p.gap, 0, 1);
  const turb = clamp(p.turbulence, 0, 1);

  const radius = width / 200;
  const portOpen = ports * portSize; // 0..4
  // each fully open port removes ~10% of the sounding length
  const portShrink = 1 - 0.10 * portOpen;
  const leff = length * portShrink + 1.2 * radius; // stylised end correction
  const period = 4 * leff / C_AIR * fs;

  // jet travel time as a fraction of period: wider gap -> slower, more pressure -> faster
  const jetNominal = 0.32;
  const jetRatio = jetNominal * (0.6 + 0.8 * gap) * (1.15 - 0.3 * pressure);
  const jetD = jetRatio * period;
  out.jetD = clamp(jetD, 2, JET_SIZE - 4);

  // sustain: too wide a gap starves the loop
  const wide = Math.max(0, gap - 0.55);
  out.jetGain = clamp(1 - 2.2 * wide, 0.05, 1);
  // narrow gap -> unstable, breathy
  const narrow = Math.max(0, 0.30 - gap) / 0.30; // 0..1
  out.wobble = narrow * 0.6;
  out.breath = pressure;
  out.noiseGain = 0.04 + 0.25 * turb + 0.5 * narrow;
  out.hiss = 0.2 * turb * Math.sqrt(pressure) + 0.1 * narrow * pressure;
  // loop lowpass tied to the pitch so the fundamental wins the mode competition.
  // more pressure and open ports -> brighter (can jump to higher modes); wider bore -> darker.
  const f0 = fs / period;
  const k = (0.85 + 2.2 * pressure * pressure * pressure + 0.12 * portOpen) * (1.15 - 0.03 * width) * (1 - 0.12 * clamp(length - 0.5, 0, 1.5));
  out.lp = clamp(1 - Math.exp(-2 * Math.PI * f0 * k / fs), 0.02, 0.95);
  // loop highpass keeps sub-f0 modes from running away (the loop is positive feedback at LF)
  const hpRatio = 0.35;
  out.hpR = 1 - 2 * Math.PI * hpRatio * f0 / fs;
  // phase lag of lp minus lead of hp at f0, expressed as delay so pitch lands near the prediction
  const lag = (Math.atan(1 / k) - Math.atan(hpRatio)) / (2 * Math.PI) * period;
  out.boreD = Math.max(8, period - jetNominal * period - lag - 1);
  out.loopGain = clamp(1.0 - 0.015 * portOpen, 0.9, 1);
  out.outGain = 0.3 * (0.7 + 0.06 * width);
  return out;
}

class WhistleVoice {
  constructor(fs) {
    this.fs = fs;
    this.bore = new Float32Array(BORE_SIZE);
    this.jet = new Float32Array(JET_SIZE);
    this.bw = 0; this.jw = 0;
    this.tgt = { boreD: 100, jetD: 30, jetGain: 1, wobble: 0, breath: 0, noiseGain: 0, hiss: 0, lp: 0.6, hpR: 0.995, loopGain: 1, outGain: 0.3 };
    this.cur = Object.assign({}, this.tgt);
    deriveTargets(DEFAULTS, fs, this.tgt);
    Object.assign(this.cur, this.tgt);
    // smoothing coefficients: slower for delay lengths (pitch glide), faster for gains
    this.aSlow = 1 - Math.exp(-1 / (0.05 * fs));
    this.aFast = 1 - Math.exp(-1 / (0.02 * fs));
    // noise bandpass (RBJ, constant 0 dB peak): b0 = alpha, b1 = 0, b2 = -alpha
    const w0 = 2 * Math.PI * NOISE_BP_HZ / fs, alpha = Math.sin(w0) / (2 * NOISE_BP_Q), a0 = 1 + alpha;
    this.nb0 = alpha / a0; this.na1 = -2 * Math.cos(w0) / a0; this.na2 = (1 - alpha) / a0;
    this.nx1 = 0; this.nx2 = 0; this.ny1 = 0; this.ny2 = 0;
    this.wobLp = 0;
    this.rng = 0x12345678 | 0;
    this.lpY = 0; this.dcX = 0; this.dcY = 0; this.oX = 0; this.oY = 0;
  }

  setParams(p) { deriveTargets(p, this.fs, this.tgt); }

  // Adds `n` samples into out starting at 0.
  process(out, n) {
    const bore = this.bore, jet = this.jet, cur = this.cur, tgt = this.tgt;
    const BM = BORE_SIZE - 1, JM = JET_SIZE - 1;
    const aS = this.aSlow, aF = this.aFast;
    let bw = this.bw, jw = this.jw;
    let lpY = this.lpY, dcX = this.dcX, dcY = this.dcY, oX = this.oX, oY = this.oY;
    let nx1 = this.nx1, nx2 = this.nx2, ny1 = this.ny1, ny2 = this.ny2, wobLp = this.wobLp;
    let rng = this.rng;
    const nb0 = this.nb0, na1 = this.na1, na2 = this.na2;

    for (let i = 0; i < n; i++) {
      cur.boreD += (tgt.boreD - cur.boreD) * aS;
      cur.jetD += (tgt.jetD - cur.jetD) * aS;
      cur.jetGain += (tgt.jetGain - cur.jetGain) * aF;
      cur.wobble += (tgt.wobble - cur.wobble) * aF;
      cur.breath += (tgt.breath - cur.breath) * aF;
      cur.noiseGain += (tgt.noiseGain - cur.noiseGain) * aF;
      cur.hiss += (tgt.hiss - cur.hiss) * aF;
      cur.lp += (tgt.lp - cur.lp) * aF;
      cur.hpR += (tgt.hpR - cur.hpR) * aF;
      cur.loopGain += (tgt.loopGain - cur.loopGain) * aF;
      cur.outGain += (tgt.outGain - cur.outGain) * aF;

      // white noise -> bandpass
      rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5;
      const w = rng * (1 / 2147483648);
      const nz = nb0 * w - nb0 * nx2 - na1 * ny1 - na2 * ny2;
      nx2 = nx1; nx1 = w; ny2 = ny1; ny1 = nz;
      wobLp += 0.002 * (w - wobLp);

      // bore output (fractional read, linear)
      let rp = bw + BORE_SIZE - cur.boreD;
      let ri = rp | 0; let rf = rp - ri;
      const y = bore[ri & BM] * (1 - rf) + bore[(ri + 1) & BM] * rf;

      // reflection: lowpass, then DC block
      lpY += cur.lp * (y - lpY);
      const dcOut = lpY - dcX + cur.hpR * dcY; dcX = lpY; dcY = dcOut;
      const refl = dcOut * cur.loopGain;

      // jet deflection = bore feedback + turbulence; delayed by jet travel time
      jet[jw] = refl + cur.noiseGain * nz * 2;
      let jp = jw + JET_SIZE - cur.jetD * (1 + cur.wobble * wobLp * 30);
      let ji = jp | 0; let jf = jp - ji;
      let jx = (jet[ji & JM] * (1 - jf) + jet[(ji + 1) & JM] * jf) * cur.jetGain * JET_K;
      jw = (jw + 1) & JM;
      jx = jx > 1 ? 1 : (jx < -1 ? -1 : jx);
      // saturating cubic; jet velocity (pressure) scales the injected pressure
      const jt = cur.breath * (jx - jx * jx * jx * (1 / 3));

      bore[bw] = jt + 0.5 * refl;
      bw = (bw + 1) & BM;

      // output: bore signal + hiss, DC block, soft limit
      const raw = y + cur.hiss * nz * 3;
      const o = raw - oX + 0.995 * oY; oX = raw; oY = o;
      const s = o * cur.outGain * 3;
      out[i] += s / (1 + (s < 0 ? -s : s));
    }
    this.bw = bw; this.jw = jw;
    this.lpY = lpY; this.dcX = dcX; this.dcY = dcY; this.oX = oX; this.oY = oY;
    this.nx1 = nx1; this.nx2 = nx2; this.ny1 = ny1; this.ny2 = ny2; this.wobLp = wobLp;
    this.rng = rng;
  }
}

class WhistleProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.voices = [new WhistleVoice(sampleRate)];
    this.params = Object.assign({}, DEFAULTS);
    this.silent = false;
    // timing (benchmark): performance.now if the worklet scope has it, else Date.now
    this.nowFn = (typeof performance !== 'undefined' && performance.now) ? () => performance.now() : () => Date.now();
    this.nowKind = (typeof performance !== 'undefined' && performance.now) ? 'performance.now' : 'Date.now (1 ms)';
    this.bench = null;
    this.reportEvery = 0;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(m) {
    if (m.type === 'params') {
      Object.assign(this.params, m.p);
      for (let i = 0; i < this.voices.length; i++) this.voices[i].setParams(this.params);
    } else if (m.type === 'voices') {
      // allocation happens here, never inside process()
      const n = clamp(m.n | 0, 1, 32);
      while (this.voices.length < n) {
        const v = new WhistleVoice(sampleRate); v.setParams(this.params); this.voices.push(v);
      }
      this.voices.length = n;
    } else if (m.type === 'bench') {
      this.bench = m.on ? { blocks: 0, sum: 0, max: 0, winSum: 0, winN: 0, winMax: 0, over: 0 } : null;
      this.reportEvery = Math.round(sampleRate / 128 / 2); // ~2 reports/s
    }
  }

  process(inputs, outputs) {
    const out = outputs[0][0];
    const n = out.length;
    const b = this.bench;
    const t0 = b ? this.nowFn() : 0;
    for (let i = 0; i < n; i++) out[i] = 0;
    for (let v = 0; v < this.voices.length; v++) this.voices[v].process(out, n);
    // copy mono to other channels
    const chs = outputs[0];
    for (let c = 1; c < chs.length; c++) chs[c].set(out);
    if (b) {
      const dt = this.nowFn() - t0;
      b.blocks++; b.sum += dt; if (dt > b.max) b.max = dt;
      b.winSum += dt; b.winN++; if (dt > b.winMax) b.winMax = dt;
      if (dt > (n / sampleRate) * 1000) b.over++;
      if (b.winN >= this.reportEvery) {
        this.port.postMessage({ type: 'bench', timer: this.nowKind, avgMs: b.winSum / b.winN, maxMs: b.winMax,
          totalAvgMs: b.sum / b.blocks, totalMaxMs: b.max, blocks: b.blocks, over: b.over,
          budgetMs: (n / sampleRate) * 1000, voices: this.voices.length, frame: currentFrame });
        b.winSum = 0; b.winN = 0; b.winMax = 0;
      }
    }
    return true;
  }
}

if (typeof registerProcessor === 'function') registerProcessor('whistle-processor', WhistleProcessor);
if (typeof globalThis !== 'undefined') globalThis.__whistle = { WhistleVoice, deriveTargets, DEFAULTS };
