// Click check: sweep each parameter during rendering, report largest sample-to-sample jump vs the
// largest jump seen in steady state, plus NaN / peak > 1 checks.
globalThis.AudioWorkletProcessor = class {}; globalThis.registerProcessor = () => {}; globalThis.sampleRate = 48000;
await import('../whistle-processor.js');
const { WhistleVoice, DEFAULTS } = globalThis.__whistle;
const fs = 48000;
const ranges = { length: [0.2, 2], width: [1, 10], pressure: [0, 1], ports: [0, 4], portSize: [0, 1], gap: [0, 1], turbulence: [0, 1], tone: [0, 1] };
function run(key, fn) {
  const v = new WhistleVoice(fs, 1, 1); const p = { ...DEFAULTS }; v.gateT = 1; v.setParams(p);
  const blk = new Float32Array(128); let prev = 0, maxJ = 0, peak = 0, bad = false, steadyJ = 0;
  const blocks = Math.round(6 * fs / 128);
  for (let b = 0; b < blocks; b++) {
    const t = b * 128 / fs;
    if (b % 40 === 0) { fn(p, t); v.setParams(p); } // ~60 Hz control messages
    blk.fill(0); v.process(blk, 128);
    for (let i = 0; i < 128; i++) { const x = blk[i]; if (!Number.isFinite(x)) bad = true; const j = Math.abs(x - prev); if (t > 1) maxJ = Math.max(maxJ, j); if (t > 0.5 && t < 1) steadyJ = Math.max(steadyJ, j); peak = Math.max(peak, Math.abs(x)); prev = x; }
  }
  return { key, maxJ: maxJ.toFixed(3), steadyJ: steadyJ.toFixed(3), peak: peak.toFixed(2), bad };
}
for (const [k, [lo, hi]] of Object.entries(ranges)) {
  console.log(JSON.stringify(run(k, (p, t) => { const x = t < 1 ? 0.5 : 0.5 - 0.5 * Math.cos(2 * Math.PI * (t - 1) / 2.5); p[k] = lo + (hi - lo) * (t < 1 ? DEFAULTS[k] / hi : x); })));
}
console.log(JSON.stringify(run('all', (p, t) => { for (const [k, [lo, hi]] of Object.entries(ranges)) p[k] = lo + (hi - lo) * (0.5 + 0.5 * Math.sin(t * (0.9 + 0.37 * Object.keys(ranges).indexOf(k)))); })));
