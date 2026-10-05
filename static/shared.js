'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// shared.js — Shared globals and utilities for TTML Lyrics Studio
// ─────────────────────────────────────────────────────────────────────────────

var uvrAvailable = false;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fmt(sec) {
  if (sec == null || isNaN(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

function fmtMs(ms) {
  return fmt((ms || 0) / 1000);
}

function escHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function toast(msg, type = '') {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.className = 'toast hidden';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.className = `toast ${type}`;
  t.classList.remove('hidden');
  clearTimeout(t._tid);
  t._tid = setTimeout(() => t.classList.add('hidden'), 3500);
}

async function checkUVRStatus() {
  try {
    const res = await fetch('/api/uvr_available');
    const data = await res.json();
    uvrAvailable = !!data.available;
  } catch (_) {
    uvrAvailable = false;
  }
  return uvrAvailable;
}

// Check on script load
checkUVRStatus();

// Decode audio file into per-pixel peak amplitudes.
async function decodeAudioPeaks(url, pps) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const resp = await fetch(url);
  if (!resp.ok) { ctx.close(); throw new Error(`Audio fetch failed: ${resp.status}`); }
  const ab = await resp.arrayBuffer();
  const buf = await ctx.decodeAudioData(ab);
  ctx.close();
  const totalPx = Math.ceil(buf.duration * pps);
  const data = buf.getChannelData(0);
  const sRate = buf.sampleRate;
  const peaks = new Float32Array(totalPx);
  for (let px = 0; px < totalPx; px++) {
    const iS = Math.floor(px * sRate / pps);
    const iE = Math.min(Math.ceil((px + 1) * sRate / pps), data.length);
    let mx = 0;
    for (let i = iS; i < iE; i++) {
      const v = Math.abs(data[i]);
      if (v > mx) mx = v;
    }
    peaks[px] = mx;
  }
  return { peaks, duration: buf.duration, audioBuf: buf };
}
