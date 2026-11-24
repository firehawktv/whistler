# Whistle

Physically modelled train whistle for the browser. DSP lives in `whistle-processor.js` (AudioWorklet); `main.js` is UI + messaging.

## Run
AudioWorklet requires a secure context. `localhost` works on a desktop; an iPad reaching your Mac over `http://192.168.x.x` does **not**. Use https (GitHub Pages, or a tunnel such as `cloudflared`/`ngrok`).

```bash
python3 -m http.server 8000
```

## Tests (Node, no audio device)
```bash
node test/render.mjs   # pitch / level / brightness sweeps, compares against the pitch prediction
node test/glide.mjs    # sweeps each parameter mid-render, checks for NaN, peaks, discontinuities
```
These prove stability and parameter mapping, not how it sounds. Listen on the device.

## Benchmark on the iPad
Open the "Benchmark & stress" panel, start audio, enable the benchmark, raise "Voices" until it breaks, and run the 60 s sweep. Safari's worklet scope may lack `performance.now()`; the panel reports which timer it got. With `Date.now()` only the averages are meaningful, so use the voice stress count and the clock-drift dropout counter to find headroom.
