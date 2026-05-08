'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// shared.js — globals available to both app.js and eh-*.js
// Must be loaded first.
// ─────────────────────────────────────────────────────────────────────────────

// Declared with var so they land on window and are visible to all scripts
var uvrAvailable = false;  // set by init() in app.js

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Decode an audio file into per-pixel peak amplitudes.
// pps = pixels per second (resolution). Returns { peaks: Float32Array, duration }
async function decodeAudioPeaks(url, pps) {
  const ctx  = new (window.AudioContext || window.webkitAudioContext)();
  const resp = await fetch(url);
  if (!resp.ok) { ctx.close(); throw new Error(`Audio fetch failed: ${resp.status}`); }
  const ab   = await resp.arrayBuffer();
  const buf  = await ctx.decodeAudioData(ab);
  ctx.close();
  const totalPx = Math.ceil(buf.duration * pps);
  const data    = buf.getChannelData(0);
  const sRate   = buf.sampleRate;
  const peaks   = new Float32Array(totalPx);
  for (let px = 0; px < totalPx; px++) {
    const iS = Math.floor(px * sRate / pps);
    const iE = Math.min(Math.ceil((px + 1) * sRate / pps), data.length);
    let mx = 0;
    for (let i = iS; i < iE; i++) { const v = Math.abs(data[i]); if (v > mx) mx = v; }
    peaks[px] = mx;
  }
  return { peaks, duration: buf.duration };
}
