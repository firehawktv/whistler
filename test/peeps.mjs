// Drives the real processor: sends a pattern and prints a coarse level meter (one char per 25 ms).
globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage() {} }; } };
globalThis.registerProcessor = () => {}; globalThis.sampleRate = 48000; globalThis.currentFrame = 0;
await import('../whistle-processor.js');
const P = new globalThis.__whistle.WhistleProcessor();
const steps = JSON.parse(process.argv[2] || '[[200,150],[200,150]]');
const out = [[new Float32Array(128), new Float32Array(128)]];
P.onMessage({ type: 'pattern', steps });
let line = '', acc = 0, n = 0, bad = false;
for (let b = 0; b < 48000 * 2 / 128; b++) {
  currentFrame = b * 128; P.process([], out);
  for (const x of out[0][0]) { acc += x * x; n++; if (!Number.isFinite(x)) bad = true; }
  if (n >= 1200) { const r = Math.sqrt(acc / n); line += ' .:-=+*#'[Math.min(7, Math.floor(r / 0.025))]; acc = 0; n = 0; }
}
console.log(line, bad ? 'NaN!' : '');
