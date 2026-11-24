// Whistle DSP. Self-contained (no imports) so it loads in an AudioWorklet and in Node tests.
// Model: STK-flute-style jet-driven loop. The bore is one delay line whose length is the full
// round trip of a pipe closed at one end (period = 4 * Leff / c), with a one-pole loss filter.
// A second delay line is the jet travel time. Ports shorten the effective bore.

const C_AIR = 343;
const BORE_SIZE = 4096; // power of 2; max period ~1200 samples at 48k, ok to 96k
const JET_SIZE = 2048;
const NOISE_BP_Q = 0.9;
const JET_K = 7; // jet deflection gain

const DEFAULTS = {
  length: 0.25,   // m, 0.2..2.0
  width: 3,       // cm, 1..10
  pressure: 0.55, // 0..1
  ports: 0,       // 0..4 open ports (discrete)
  portSize: 0.5,  // 0..1
  gap: 0.45,      // 0..1 lip gap, narrow..wide
  turbulence: 0.25, // 0..1
  tone: 0.4       // 0..1 output purity (sine-like) .. edge (bright)
};

function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

// Maps UI parameters to DSP targets. Control rate only (may use pow/sqrt).
// Pure function so it can be unit tested and reused per voice.
function deriveTargets(p, fs, out) {
  const length = clamp(p.length, 0.05, 2.0);
  const width = clamp(p.width, 1, 10);
  const pressure = clamp(p.pressure, 0, 1);
  const ports = clamp(Math.round(p.ports), 0, 4);
  const portSize = clamp(p.portSize, 0, 1);
  const gap = clamp(p.gap, 0, 1);
  const turb = clamp(p.turbulence, 0, 1);
  const tone = clamp(p.tone === undefined ? 0.4 : p.tone, 0, 1);

  const radius = width / 200;
  const portOpen = ports * portSize; // 0..4
  // each fully open port removes ~10% of the sounding length
  const portShrink = 1 - 0.10 * portOpen;
  const leff = (length * portShrink + 1.2 * radius) / (p.ratio || 1); // stylised end correction; ratio = chord interval
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
  const k = (0.85 + 2.5 * pressure * pressure * pressure * pressure + 0.12 * portOpen) * (1.15 - 0.03 * width) * (1 - 0.12 * clamp(length - 0.5, 0, 1.5));
  out.lp = clamp(1 - Math.exp(-2 * Math.PI * f0 * k / fs), 0.02, 0.95);
  // loop highpass keeps sub-f0 modes from running away (the loop is positive feedback at LF)
  const hpRatio = 0.35;
  out.hpR = 1 - 2 * Math.PI * hpRatio * f0 / fs;
  // phase lag of lp minus lead of hp at f0, expressed as delay so pitch lands near the prediction
  const lag = (Math.atan(1 / k) - Math.atan(hpRatio)) / (2 * Math.PI) * period;
  out.boreD = Math.max(8, period - jetNominal * period - lag - 1);
  // output tone filter (two cascaded one-poles, outside the loop): pure sine-like <-> edgy
  const ko = (0.9 + 5.0 * tone * tone + 2.5 * pressure * pressure) * (1.1 - 0.02 * width);
  out.oLp = clamp(1 - Math.exp(-2 * Math.PI * f0 * ko / fs), 0.01, 0.95);
  // breath noise centred a few times above the pitch so the air sound follows the note
  const fn = clamp(f0 * 3.2, 600, 7000);
  const w0 = 2 * Math.PI * fn / fs, alpha = Math.sin(w0) / (2 * NOISE_BP_Q), a0 = 1 + alpha;
  out.nb0 = alpha / a0; out.na1 = -2 * Math.cos(w0) / a0; out.na2 = (1 - alpha) / a0;
  out.loopGain = clamp(1.0 - 0.015 * portOpen, 0.9, 1);
  out.outGain = 0.3 * (0.7 + 0.06 * width);
  return out;
}

class WhistleVoice {
  constructor(fs, ratio, seed) {
    this.fs = fs;
    this.ratio = ratio || 1;
    this._p = Object.assign({}, DEFAULTS);
    this.gate = 0; this.gateT = 0; // breath gate: 0 = not blowing
    this.aAtk = 1 - Math.exp(-1 / (0.012 * fs)); this.aRel = 1 - Math.exp(-1 / (0.035 * fs));
    this.env = 0; this.jit = 0; this.o1 = 0; this.o2 = 0;
    this.bore = new Float32Array(BORE_SIZE);
    this.jet = new Float32Array(JET_SIZE);
    this.bw = 0; this.jw = 0;
    this.tgt = { boreD: 100, jetD: 30, jetGain: 1, wobble: 0, breath: 0, noiseGain: 0, hiss: 0, lp: 0.6, hpR: 0.995, oLp: 0.3, nb0: 0.1, na1: -1, na2: 0.5, loopGain: 1, outGain: 0.3 };
    this.cur = Object.assign({}, this.tgt);
    this.setParams(DEFAULTS);
    Object.assign(this.cur, this.tgt);
    // smoothing coefficients: slower for delay lengths (pitch glide), faster for gains
    this.aSlow = 1 - Math.exp(-1 / (0.05 * fs));
    this.aFast = 1 - Math.exp(-1 / (0.02 * fs));
    this.nx1 = 0; this.nx2 = 0; this.ny1 = 0; this.ny2 = 0;
    this.wobLp = 0;
    this.rng = (0x12345678 ^ Math.imul(seed || 0, 0x9e3779b1)) | 0 || 1;
    this.lpY = 0; this.dcX = 0; this.dcY = 0; this.oX = 0; this.oY = 0;
  }

  setParams(p) {
    Object.assign(this._p, p); this._p.ratio = this.ratio; // chord: whole sounding length divided by the pitch ratio
    deriveTargets(this._p, this.fs, this.tgt);
  }

  // Adds `n` samples into out starting at 0.
  process(out, n) {
    const bore = this.bore, jet = this.jet, cur = this.cur, tgt = this.tgt;
    const BM = BORE_SIZE - 1, JM = JET_SIZE - 1;
    const aS = this.aSlow, aF = this.aFast;
    let bw = this.bw, jw = this.jw;
    let lpY = this.lpY, dcX = this.dcX, dcY = this.dcY, oX = this.oX, oY = this.oY;
    let nx1 = this.nx1, nx2 = this.nx2, ny1 = this.ny1, ny2 = this.ny2, wobLp = this.wobLp;
    let rng = this.rng;
    let gate = this.gate; const gateT = this.gateT, aAtk = this.aAtk, aRel = this.aRel;
    let env = this.env, jit = this.jit, o1 = this.o1, o2 = this.o2;

    for (let i = 0; i < n; i++) {
      cur.boreD += (tgt.boreD - cur.boreD) * aS;
      cur.jetD += (tgt.jetD - cur.jetD) * aS;
      cur.jetGain += (tgt.jetGain - cur.jetGain) * aF;
      cur.wobble += (tgt.wobble - cur.wobble) * aF;
      cur.breath += (tgt.breath - cur.breath) * aF;
      cur.noiseGain += (tgt.noiseGain - cur.noiseGain) * aF;
      cur.hiss += (tgt.hiss - cur.hiss) * aF;
      cur.lp += (tgt.lp - cur.lp) * aF;
      gate += (gateT - gate) * (gateT > gate ? aAtk : aRel);
      cur.hpR += (tgt.hpR - cur.hpR) * aF;
      cur.oLp += (tgt.oLp - cur.oLp) * aF;
      cur.nb0 += (tgt.nb0 - cur.nb0) * aF;
      cur.na1 += (tgt.na1 - cur.na1) * aF;
      cur.na2 += (tgt.na2 - cur.na2) * aF;
      cur.loopGain += (tgt.loopGain - cur.loopGain) * aF;
      cur.outGain += (tgt.outGain - cur.outGain) * aF;

      // white noise -> bandpass
      rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5;
      const w = rng * (1 / 2147483648);
      const nz = cur.nb0 * (w - nx2) - cur.na1 * ny1 - cur.na2 * ny2;
      nx2 = nx1; nx1 = w; ny2 = ny1; ny1 = nz;
      wobLp += 0.002 * (w - wobLp);
      jit += 0.0003 * (w - jit); // slow random drift of the jet: natural pitch/amplitude wander

      // bore output (fractional read, linear)
      let rp = bw + BORE_SIZE - cur.boreD;
      let ri = rp | 0; let rf = rp - ri;
      const y = bore[ri & BM] * (1 - rf) + bore[(ri + 1) & BM] * rf;

      // reflection: lowpass, then DC block
      lpY += cur.lp * (y - lpY);
      const dcOut = lpY - dcX + cur.hpR * dcY; dcX = lpY; dcY = dcOut;
      const refl = dcOut * cur.loopGain;

      // jet deflection = bore feedback + turbulence; delayed by jet travel time
      // onset: more air until the tone has built up (env ~ 0 -> chiff, env ~ 0.2 -> clean)
      const air = cur.noiseGain * (1 + 6 * (env < 0.15 ? 1 - env * 6.67 : 0));
      jet[jw] = refl + air * nz * 2;
      let jp = jw + JET_SIZE - cur.jetD * (1 + 0.05 * (1 - gate) + cur.wobble * wobLp * 30 + 1.5 * jit);
      let ji = jp | 0; let jf = jp - ji;
      let jx = (jet[ji & JM] * (1 - jf) + jet[(ji + 1) & JM] * jf) * cur.jetGain * JET_K;
      jw = (jw + 1) & JM;
      jx = jx > 1 ? 1 : (jx < -1 ? -1 : jx);
      // saturating cubic; jet velocity (pressure) scales the injected pressure
      const jt = cur.breath * gate * (jx - jx * jx * jx * (1 / 3));

      bore[bw] = jt + 0.5 * refl;
      bw = (bw + 1) & BM;

      // output: bore signal + hiss, DC block, soft limit
      env += 0.002 * ((y < 0 ? -y : y) - env);
      const raw = y + cur.hiss * gate * nz * 3 * (1 + 2 * (env < 0.15 ? 1 - env * 6.67 : 0));
      o1 += cur.oLp * (raw - o1); o2 += cur.oLp * (o1 - o2);
      const o = o2 - oX + 0.995 * oY; oX = o2; oY = o;
      const s = o * cur.outGain * 3;
      out[i] += s / (1 + (s < 0 ? -s : s));
    }
    this.bw = bw; this.jw = jw;
    this.lpY = lpY; this.dcX = dcX; this.dcY = dcY; this.oX = oX; this.oY = oY;
    this.nx1 = nx1; this.nx2 = nx2; this.ny1 = ny1; this.ny2 = ny2; this.wobLp = wobLp;
    this.gate = gate;
    this.rng = rng; this.env = env; this.jit = jit; this.o1 = o1; this.o2 = o2;
  }
}

class WhistleProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.voices = [new WhistleVoice(sampleRate, 1, 1)];
    this.gain = 1;
    this.params = Object.assign({}, DEFAULTS);
    this.silent = false;
    // timing (benchmark): performance.now if the worklet scope has it, else Date.now
    this.nowFn = (typeof performance !== 'undefined' && performance.now) ? () => performance.now() : () => Date.now();
    this.nowKind = (typeof performance !== 'undefined' && performance.now) ? 'performance.now' : 'Date.now (1 ms)';
    this.bench = null;
    this.held = false; this.segs = []; // blow pattern: [startFrame, endFrame] pairs
    this.reportEvery = 0;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(m) {
    if (m.type === 'params') {
      Object.assign(this.params, m.p);
      for (let i = 0; i < this.voices.length; i++) this.voices[i].setParams(this.params);
    } else if (m.type === 'voices') {
      // m.ratios: pitch ratio per voice (chord). Allocation happens here, never inside process().
      const r = (m.ratios && m.ratios.length ? m.ratios : [1]).slice(0, 32);
      const vs = [];
      for (let i = 0; i < r.length; i++) { const v = new WhistleVoice(sampleRate, r[i], i + 1); v.setParams(this.params); vs.push(v); }
      this.gain = 1 / Math.sqrt(vs.length);
      this.voices = vs;
    } else if (m.type === 'gate') {
      this.held = !!m.on; if (!m.on) this.segs.length = 0;
    } else if (m.type === 'pattern') {
      // m.steps: [[onMs, offMs], ...] starting now; replaces any running pattern
      let t = currentFrame + Math.round(0.01 * sampleRate); const segs = [];
      for (const st of (m.steps || []).slice(0, 16)) { const a = t, b = a + Math.round(st[0] * sampleRate / 1000); segs.push([a, b]); t = b + Math.round(st[1] * sampleRate / 1000); }
      this.segs = segs;
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
    // gate decided per block (2.7 ms resolution is plenty for peeps); voices smooth it per sample
    let open = this.held; const f = currentFrame, segs = this.segs;
    for (let k = 0; k < segs.length; k++) if (f + n > segs[k][0] && f < segs[k][1]) { open = true; break; }
    const gt = open ? 1 : 0;
    for (let v = 0; v < this.voices.length; v++) this.voices[v].gateT = gt;
    for (let i = 0; i < n; i++) out[i] = 0;
    for (let v = 0; v < this.voices.length; v++) this.voices[v].process(out, n);
    const g = this.gain; if (g !== 1) for (let i = 0; i < n; i++) out[i] *= g;
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
if (typeof globalThis !== 'undefined') globalThis.__whistle = { WhistleProcessor, WhistleVoice, deriveTargets, DEFAULTS };
