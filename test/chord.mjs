globalThis.AudioWorkletProcessor = class {}; globalThis.registerProcessor = () => {}; globalThis.sampleRate = 48000;
await import('../whistle-processor.js');
const { WhistleVoice, DEFAULTS } = globalThis.__whistle;
const fs = 48000, N = 16384;
for (const r of [1, 1.1892, 1.4983]) {
  const v = new WhistleVoice(fs, r, 3); v.gateT = 1; v.setParams({ ...DEFAULTS, length: 0.22 });
  const b = new Float32Array(128), x = new Float32Array(fs);
  for (let i = 0; i < fs; i += 128) { b.fill(0); v.process(b, 128); x.set(b.subarray(0, Math.min(128, fs - i)), i); }
  // zero-crossing pitch over last 0.25 s
  let z = 0, first = -1, last = -1; for (let i = fs - 12000; i < fs - 1; i++) if (x[i] < 0 && x[i + 1] >= 0) { if (first < 0) first = i; last = i; z++; }
  console.log('ratio', r, 'pitch', (fs * (z - 1) / (last - first)).toFixed(1), 'peak', Math.max(...x).toFixed(2));
}
