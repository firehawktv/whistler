'use strict';
const PARAMS = [
  { key: 'length',     label: 'Length',      min: 0.05, max: 2.0, step: 0.005, unit: 'm',  fmt: v => v.toFixed(2) + ' m' },
  { key: 'width',      label: 'Bore width',  min: 1,   max: 10,  step: 0.1,   fmt: v => v.toFixed(1) + ' cm' },
  { key: 'pressure',   label: 'Pressure',    min: 0,   max: 1,   step: 0.005, fmt: v => v.toFixed(2) },
  { key: 'gap',        label: 'Lip gap',     min: 0,   max: 1,   step: 0.005, fmt: v => v < 0.2 ? 'narrow' : v > 0.65 ? 'wide' : 'mid' },
  { key: 'turbulence', label: 'Turbulence',  min: 0,   max: 1,   step: 0.005, fmt: v => v.toFixed(2) },
  { key: 'tone',       label: 'Tone (pure ↔ edgy)', min: 0, max: 1, step: 0.005, fmt: v => v.toFixed(2) },
  { key: 'portSize',   label: 'Port size',   min: 0,   max: 1,   step: 0.005, fmt: v => v.toFixed(2) },
];
const CHORDS = {
  'Single': [1],
  'Chime (minor)': [1, 1.1892, 1.4983],
  'Chime (major)': [1, 1.2599, 1.4983],
  'Wide 3-chamber': [1, 1.3348, 1.7818],
  'Clash': [1, 1.06, 1.4983],
};
const PATTERNS = {
  'Two short':           { steps: [[170, 140], [170, 0]] },
  'Three short':         { steps: [[150, 120], [150, 120], [150, 0]] },
  'Crossing (long-long-short-long)': { steps: [[900, 450], [900, 450], [250, 300], [1500, 0]] },
  'One long':            { steps: [[1400, 0]] },
  'Hold while pressed':  { hold: true },
};
const PRESETS = {
  'Steam whistle': { length: 0.22, width: 3,   pressure: 0.55, ports: 0, portSize: 0.5, gap: 0.45, turbulence: 0.3,  tone: 0.4,  chord: 'Chime (minor)' },
  'Pea whistle':   { length: 0.07, width: 1.5, pressure: 0.6,  ports: 0, portSize: 0.5, gap: 0.4,  turbulence: 0.35, tone: 0.3,  chord: 'Single' },
  'Low chime':     { length: 0.7,  width: 6,   pressure: 0.5,  ports: 0, portSize: 0.5, gap: 0.5,  turbulence: 0.2,  tone: 0.35, chord: 'Chime (major)' },
  'Breathy':       { length: 0.3,  width: 4,   pressure: 0.35, ports: 0, portSize: 0.5, gap: 0.3,  turbulence: 0.7,  tone: 0.3,  chord: 'Single' },
  'Overblown':     { length: 0.3,  width: 3,   pressure: 0.95, ports: 0, portSize: 0.5, gap: 0.45, turbulence: 0.3,  tone: 0.6,  chord: 'Single' },
};
const state = Object.assign({}, PRESETS['Steam whistle']);
let ctx = null, node = null, analyser = null, dirty = false, benchOn = false, sweepTimer = null;
const $ = (id) => document.getElementById(id);
const sliders = {}, valueLabels = {};

function logLine(msg) { const e = $('status'); if (e) { e.textContent = (new Date().toLocaleTimeString() + ' ' + msg + '\n' + e.textContent).slice(0, 600); } }
window.addEventListener('error', (ev) => logLine('ERROR ' + ev.message));
window.addEventListener('unhandledrejection', (ev) => logLine('REJECTED ' + (ev.reason && ev.reason.message || ev.reason)));
function showError(msg) { logLine(msg); const e = $('err'); e.textContent = msg; e.hidden = false; }

function buildUI() {
  const c = $('controls');
  for (const p of PARAMS) {
    const row = document.createElement('div'); row.className = 'row';
    row.innerHTML = `<label><span>${p.label}</span><b></b></label><input type="range" min="${p.min}" max="${p.max}" step="${p.step}">`;
    const input = row.querySelector('input'), out = row.querySelector('b');
    input.value = state[p.key];
    input.addEventListener('input', () => { state[p.key] = +input.value; out.textContent = p.fmt(state[p.key]); dirty = true; });
    out.textContent = p.fmt(state[p.key]);
    sliders[p.key] = input; valueLabels[p.key] = out; c.appendChild(row);
  }
  const pr = document.createElement('div'); pr.className = 'row';
  pr.innerHTML = '<label><span>Open ports</span></label><div class="seg"></div>';
  const seg = pr.querySelector('.seg');
  for (let i = 0; i <= 4; i++) {
    const b = document.createElement('button'); b.textContent = i; b.dataset.n = i;
    b.addEventListener('click', () => { state.ports = i; markPorts(); dirty = true; });
    seg.appendChild(b);
  }
  // ports sit after bore width visually
  c.insertBefore(pr, c.children[3]);
  const cr = document.createElement('div'); cr.className = 'row';
  cr.innerHTML = '<label><span>Chord</span></label><select id="chord"></select>';
  const sel = cr.querySelector('select');
  for (const n of Object.keys(CHORDS)) sel.add(new Option(n, n));
  sel.value = state.chord;
  sel.addEventListener('change', () => { state.chord = sel.value; sendVoices(); });
  c.insertBefore(cr, c.firstChild);
  const pre = $('presets');
  for (const name of Object.keys(PRESETS)) {
    const b = document.createElement('button'); b.textContent = name;
    b.addEventListener('click', () => applyPreset(PRESETS[name]));
    pre.appendChild(b);
  }
  markPorts();
}
function markPorts() { document.querySelectorAll('.seg button').forEach(b => b.classList.toggle('on', +b.dataset.n === state.ports)); }
function sendVoices() {
  if (!node) return;
  const base = CHORDS[state.chord] || [1], n = +$('voices').value;
  // stress: stack extra copies of the chord up to n voices total
  const out = []; for (let i = 0; i < Math.max(n, base.length); i++) out.push(base[i % base.length] * (1 + 0.003 * Math.floor(i / base.length)));
  node.port.postMessage({ type: 'voices', ratios: n <= 1 ? base : out });
}
function syncUI() {
  $('chord').value = state.chord;
  for (const p of PARAMS) { sliders[p.key].value = state[p.key]; valueLabels[p.key].textContent = p.fmt(state[p.key]); }
  markPorts();
}
function applyPreset(p) { Object.assign(state, p); syncUI(); dirty = true; }

// Throttled parameter messaging, ~30 Hz, only when something changed.
setInterval(() => { if (dirty && node) { node.port.postMessage({ type: 'params', p: state }); dirty = false; } }, 33);

async function startAudio() {
  if (ctx) { if (ctx.state !== 'running') await ctx.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC || !(AC.prototype && 'audioWorklet' in AC.prototype) && !window.isSecureContext) {
    showError('AudioWorklet needs a secure context (https or localhost). Plain http to a LAN IP will not work on iPad.'); return;
  }
  try {
    ctx = new AC({ latencyHint: 'interactive' });
    await ctx.resume(); // inside the tap gesture
    await ctx.audioWorklet.addModule('whistle-processor.js');
    node = new AudioWorkletNode(ctx, 'whistle-processor', { numberOfInputs: 0, outputChannelCount: [2] });
    node.port.onmessage = (e) => { if (e.data.type === 'bench') showBench(e.data); };
    analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
    node.connect(analyser); analyser.connect(ctx.destination);
    node.port.postMessage({ type: 'params', p: state }); sendVoices();
    $('start').textContent = 'Audio running (tap to resume if paused)'; logLine('audio started, sampleRate ' + ctx.sampleRate);
    drift.reset(); requestAnimationFrame(drawScope);
  } catch (err) { showError('Audio failed: ' + err.message); ctx = null; }
}
$('start').addEventListener('click', startAudio);

// iOS suspends/interrupts audio on backgrounding; resume on return (resume needs a gesture sometimes, so also offer the button).
document.addEventListener('visibilitychange', () => {
  if (!ctx) return;
  if (document.hidden) ctx.suspend(); else ctx.resume().catch(() => {});
  drift.reset();
});
function watchState() { if (ctx) ctx.onstatechange = () => { $('start').textContent = ctx.state === 'running' ? 'Audio running' : 'Audio ' + ctx.state + ' — tap to resume'; }; }
setInterval(watchState, 1000);

// Scope: cheap, ~30 fps
const cv = $('scope'), g = cv.getContext('2d'); let lastDraw = 0; const tbuf = new Float32Array(1024);
function drawScope(t) {
  requestAnimationFrame(drawScope);
  if (t - lastDraw < 33 || !analyser || document.hidden) return; lastDraw = t;
  analyser.getFloatTimeDomainData(tbuf);
  // trigger on rising zero crossing so the trace holds still
  let s = 0; for (let i = 1; i < 512; i++) if (tbuf[i - 1] < 0 && tbuf[i] >= 0) { s = i; break; }
  g.fillStyle = '#0e1013'; g.fillRect(0, 0, cv.width, cv.height);
  g.strokeStyle = '#e8a33d'; g.lineWidth = 2; g.beginPath();
  for (let i = 0; i < 512; i++) { const x = i / 511 * cv.width, y = cv.height / 2 - tbuf[s + i] * cv.height * 0.9; i ? g.lineTo(x, y) : g.moveTo(x, y); }
  g.stroke();
}

// Dropout monitor: audio clock vs wall clock. Starvation makes the audio clock fall behind.
const drift = {
  base: null, last: 0, drops: 0, worst: 0,
  reset() { this.base = null; },
  sample() {
    if (!ctx || ctx.state !== 'running') return;
    const lag = performance.now() - ctx.currentTime * 1000;
    if (this.base === null) { this.base = lag; this.last = lag; return; }
    const d = lag - this.last; this.last = lag;
    if (d > 8) this.drops++;
    this.worst = Math.max(this.worst, lag - this.base);
  },
};
setInterval(() => drift.sample(), 250);

let lastBench = null;
function showBench(b) { lastBench = b; renderBench(); }
function renderBench() {
  const b = lastBench; if (!b) return;
  $('benchOut').textContent =
`timer: ${b.timer}${b.timer.startsWith('Date') ? '  (coarse: only the averages are trustworthy)' : ''}
voices: ${b.voices}   budget/block: ${b.budgetMs.toFixed(2)} ms
avg  (last 0.5 s): ${b.avgMs.toFixed(3)} ms  (${(100 * b.avgMs / b.budgetMs).toFixed(1)}% of budget)
max  (last 0.5 s): ${b.maxMs.toFixed(3)} ms
avg  (overall):    ${b.totalAvgMs.toFixed(3)} ms
max  (overall):    ${b.totalMaxMs.toFixed(3)} ms
blocks over budget: ${b.over} / ${b.blocks}
clock drift dropouts (audio vs wall): ${drift.drops}   worst lag: ${drift.worst.toFixed(1)} ms`;
}
setInterval(renderBench, 500);
$('benchBtn').addEventListener('click', () => {
  if (!node) { showError('Start audio first.'); return; }
  benchOn = !benchOn; $('benchBtn').textContent = 'Benchmark: ' + (benchOn ? 'on' : 'off'); $('benchBtn').classList.toggle('on', benchOn);
  node.port.postMessage({ type: 'bench', on: benchOn }); drift.drops = 0; drift.worst = 0;
});
$('voices').addEventListener('change', sendVoices);

// 60 s automated sweep of every parameter (acceptance test). Run with benchmark on and watch dropouts.
$('sweepBtn').addEventListener('click', () => {
  if (!node) { showError('Start audio first.'); return; }
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; node.port.postMessage({ type: 'gate', on: false }); $('sweepBtn').textContent = '60 s sweep'; $('sweepBtn').classList.remove('on'); return; }
  const t0 = performance.now(); drift.drops = 0; drift.worst = 0; node.port.postMessage({ type: 'gate', on: true });
  $('sweepBtn').textContent = 'Sweeping… (tap to stop)'; $('sweepBtn').classList.add('on');
  sweepTimer = setInterval(() => {
    const t = (performance.now() - t0) / 1000;
    if (t > 60) { clearInterval(sweepTimer); sweepTimer = null; node.port.postMessage({ type: 'gate', on: false }); $('sweepBtn').textContent = '60 s sweep'; $('sweepBtn').classList.remove('on'); return; }
    PARAMS.forEach((p, i) => { state[p.key] = p.min + (p.max - p.min) * (0.5 + 0.5 * Math.sin(t * (0.35 + 0.17 * i) + i)); });
    state.ports = Math.floor(2.5 + 2.49 * Math.sin(t * 0.21));
    syncUI(); dirty = true;
  }, 33);
});

let starting = false;
function setupBlow() {
  const sel = $('pattern'), btn = $('blow');
  for (const n of Object.keys(PATTERNS)) sel.add(new Option(n, n));
  const press = (e) => {
    e && e.preventDefault();
    if (!node) {
      if (starting) return;
      starting = true;
      startAudio().then(() => { starting = false; if (node) press(); }, () => { starting = false; });
      return;
    }
    if (ctx.state !== 'running') ctx.resume();
    const pat = PATTERNS[sel.value];
    btn.classList.add('on'); logLine('blow: ' + sel.value + ' ctx=' + ctx.state);
    if (pat.hold) node.port.postMessage({ type: 'gate', on: true });
    else { node.port.postMessage({ type: 'pattern', steps: pat.steps }); setTimeout(() => btn.classList.remove('on'), pat.steps.reduce((a, s) => a + s[0] + s[1], 0)); }
  };
  const release = () => { if (PATTERNS[sel.value].hold && node) { node.port.postMessage({ type: 'gate', on: false }); btn.classList.remove('on'); } };
  btn.addEventListener('pointerdown', press);
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) btn.addEventListener(ev, release);
  document.addEventListener('keydown', (e) => { if (e.code === 'Space' && !e.repeat && e.target === document.body) press(e); });
  document.addEventListener('keyup', (e) => { if (e.code === 'Space') release(); });
}
setupBlow();
buildUI();
if (!window.isSecureContext) showError('Not a secure context: AudioWorklet will be unavailable. Serve over https or localhost.');
