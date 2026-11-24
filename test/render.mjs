// Offline harness: renders the voice in Node and reports pitch / level / brightness.
// Usage: node test/render.mjs
import { writeFileSync } from 'node:fs';
globalThis.AudioWorkletProcessor = class {};
globalThis.registerProcessor = () => {};
globalThis.sampleRate = 48000;
await import('../whistle-processor.js');
const { WhistleVoice, DEFAULTS } = globalThis.__whistle;
const fs = 48000;

export function render(params, seconds = 1.5, pre = 0.5) {
  const v = new WhistleVoice(fs, 1, 1);
  v.setParams({ ...DEFAULTS, ...params });
  const total = Math.round(seconds * fs), buf = new Float32Array(total);
  const blk = new Float32Array(128);
  for (let i = 0; i < total; i += 128) { blk.fill(0); v.process(blk, Math.min(128, total - i)); buf.set(blk.subarray(0, Math.min(128, total - i)), i); }
  return buf.subarray(Math.round(pre * fs));
}
function analyse(x) {
  let s = 0, peak = 0, bad = false;
  for (const v of x) { s += v * v; const a = Math.abs(v); if (a > peak) peak = a; if (!Number.isFinite(v)) bad = true; }
  const rms = Math.sqrt(s / x.length);
  // spectrum peak via radix-2 FFT (16384, Hann); also energy-weighted centroid
  const N = 16384, re = new Float64Array(N), im = new Float64Array(N);
  const off = x.length - N;
  for (let i = 0; i < N; i++) re[i] = x[off + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
  for (let i = 1, j = 0; i < N; i++) { let bit = N >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; } }
  for (let len = 2; len <= N; len <<= 1) { const ang = -2 * Math.PI / len; for (let i = 0; i < N; i += len) for (let k = 0; k < len / 2; k++) {
    const wr = Math.cos(ang * k), wi = Math.sin(ang * k), ur = re[i + k], ui = im[i + k];
    const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi, vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
    re[i + k] = ur + vr; im[i + k] = ui + vi; re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi; } }
  const mag = new Float64Array(N / 2); let tot = 0, cen = 0, pk = 1;
  for (let k = 1; k < N / 2; k++) { mag[k] = Math.hypot(re[k], im[k]); tot += mag[k] * mag[k]; cen += k * mag[k] * mag[k]; if (mag[k] > mag[pk]) pk = k; }
  const f0 = pk * fs / N, clarity = tot ? (mag[pk] * mag[pk]) / tot : 0, centroid = tot ? cen / tot * fs / N : 0;
  // brightness: share of energy of first difference vs signal
  let d = 0; for (let i = 1; i < x.length; i++) { const t = x[i] - x[i - 1]; d += t * t; }
  const bright = Math.sqrt(d / (s || 1));
  return { rms, peak, bad, f0, clarity, bright, centroid };
}
export const predicted = (p) => { const q={...DEFAULTS,...p}; return 343/(4*(q.length*(1-0.1*Math.round(q.ports)*q.portSize)+1.2*q.width/200)); };
const fmt = (a) => `rms ${a.rms.toFixed(3)} peak ${a.peak.toFixed(2)} f0 ${a.f0.toFixed(1)} peakShare ${a.clarity.toFixed(2)} centroid ${a.centroid.toFixed(0)}${a.bad ? ' NaN!' : ''}`;
if (process.argv[1].endsWith('render.mjs')) {
  const sweep = (name, key, vals) => { console.log('--- ' + name); for (const v of vals) console.log(String(v).padEnd(6), 'pred', predicted({ [key]: v }).toFixed(0).padStart(4), fmt(analyse(render({ [key]: v })))); };
  console.log('default', fmt(analyse(render({}))));
  sweep('pressure', 'pressure', [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.55, 0.7, 0.8, 0.9, 1]);
  sweep('gap', 'gap', [0, 0.1, 0.2, 0.3, 0.45, 0.55, 0.65, 0.8, 1]);
  sweep('length', 'length', [0.2, 0.3, 0.5, 1.0, 2.0]);
  sweep('width', 'width', [1, 3, 6, 10]);
  sweep('ports', 'ports', [0, 1, 2, 3, 4]);
  sweep('turbulence', 'turbulence', [0, 0.25, 0.6, 1]);
  writeFileSync(process.env.OUT || '/tmp/whistle-default.raw', Buffer.from(render({}, 3).buffer));
}
