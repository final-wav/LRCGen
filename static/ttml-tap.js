'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// ttml-tap.js — Multi-Voice Syllable Tap Sync Overlay
// ─────────────────────────────────────────────────────────────────────────────

var tapAudio = null;
var tapRafId = null;

var TapSync = {
  active: false,
  flatTokens: [],
  flatIdx: 0,
  timestamps: [],
  started: false,
  peaks: null,
  duration: 0,
  activeVoice: 'v1',
};

function openMultiVoiceTapSync() {
  const track = getActiveTrack();
  if (!track || !track.audioUrl) {
    toast('Select an audio track first.', 'error');
    return;
  }

  const lyrics = getActiveLyrics();
  const lines  = lyrics.lines || [];

  // Build flat token list from lines or plain text
  TapSync.flatTokens = [];
  lines.forEach((line, lIdx) => {
    const rawTokens = (line.text || line.adlib || '').split(/\s+/).filter(Boolean);
    rawTokens.forEach((tok, wIdx) => {
      TapSync.flatTokens.push({
        lineIdx: lIdx,
        wordIdx: wIdx,
        text: tok,
        isAdlib: !!line.adlib,
        agent: line.agent || 'v1',
        lineText: line.text || line.adlib || '',
      });
    });
  });

  if (!TapSync.flatTokens.length) {
    toast('No lyrics text available to tap sync.', 'error');
    return;
  }

  TapSync.flatIdx = 0;
  TapSync.timestamps = [];
  TapSync.started = false;
  TapSync.activeVoice = 'v1';

  const overlay = document.getElementById('ttmlTapOverlay');
  if (overlay) {
    overlay.classList.remove('hidden');
    overlay.focus();
  }

  // Audio setup
  if (tapAudio) { tapAudio.pause(); tapAudio.src = ''; }
  tapAudio = new Audio(track.audioUrl);
  tapAudio.volume = Studio.volume;

  // Waveform peak decoding
  decodeAudioPeaks(track.audioUrl, 80).then(({ peaks, duration }) => {
    TapSync.peaks = peaks;
    TapSync.duration = duration;
    initTapCanvas();
  }).catch(() => {});

  updateTapUI();
  startTapRAF();
}

function initTapCanvas() {
  const canvas = document.getElementById('tapWaveCanvas');
  if (!canvas) return;
  canvas.width = canvas.parentElement ? canvas.parentElement.clientWidth : window.innerWidth;
  canvas.height = 64;
}

function updateTapUI() {
  const cur = TapSync.flatTokens[TapSync.flatIdx];
  const countEl = document.getElementById('tapCountDisplay');
  const lineLabelEl = document.getElementById('tapLineLabel');
  const wordsWrap = document.getElementById('tapWordsWrap');

  if (countEl) countEl.textContent = `${TapSync.flatIdx} / ${TapSync.flatTokens.length}`;

  if (!cur) return;
  if (lineLabelEl) lineLabelEl.textContent = `Line ${cur.lineIdx + 1} (${cur.agent})`;

  if (wordsWrap) {
    wordsWrap.innerHTML = '';
    const curLineTokens = TapSync.flatTokens.filter(t => t.lineIdx === cur.lineIdx);
    curLineTokens.forEach(tok => {
      const idx = TapSync.flatTokens.indexOf(tok);
      const span = document.createElement('span');
      span.className = 'tap-word-pill' +
        (idx < TapSync.flatIdx ? ' done' : '') +
        (idx === TapSync.flatIdx ? ' current' : '') +
        (tok.isAdlib ? ' adlib' : '');
      span.textContent = tok.text;
      wordsWrap.appendChild(span);
    });
  }
}

function startTapRAF() {
  if (tapRafId) cancelAnimationFrame(tapRafId);
  function loop() {
    if (tapAudio) {
      const t = tapAudio.currentTime || 0;
      const timeEl = document.getElementById('tapTimeDisplay');
      if (timeEl) timeEl.textContent = fmt(t);
      drawTapWaveform(t);
    }
    if (!document.getElementById('ttmlTapOverlay')?.classList.contains('hidden')) {
      tapRafId = requestAnimationFrame(loop);
    }
  }
  tapRafId = requestAnimationFrame(loop);
}

function drawTapWaveform(curTime) {
  const canvas = document.getElementById('tapWaveCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#07070f';
  ctx.fillRect(0, 0, w, h);

  const playheadX = Math.floor(w * 0.3); // Fixed at 30%
  const pps = 80;

  if (TapSync.peaks) {
    const timeOffset = curTime - playheadX / pps;
    const mid = h / 2;
    for (let px = 0; px < w; px++) {
      const sTime = timeOffset + px / pps;
      if (sTime < 0 || sTime > TapSync.duration) continue;
      const sPx = Math.floor(sTime * pps);
      if (sPx >= TapSync.peaks.length) continue;
      const amp = TapSync.peaks[sPx] * mid * 0.92;
      ctx.fillStyle = px < playheadX ? '#7c3aed' : '#22224a';
      ctx.fillRect(px, mid - amp, 1, amp * 2 || 1);
    }
  }

  // Playhead line
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(playheadX, 0, 1, h);

  // Tapped markers
  TapSync.timestamps.forEach(ts => {
    if (ts == null) return;
    const mx = Math.round(playheadX + (ts - curTime) * pps);
    if (mx >= 0 && mx <= w) {
      ctx.fillStyle = '#10b981';
      ctx.fillRect(mx, 0, 1, h);
    }
  });
}

function finishTapSync() {
  if (tapRafId) cancelAnimationFrame(tapRafId);
  if (tapAudio) { tapAudio.pause(); tapAudio.src = ''; }

  const track = getActiveTrack();
  if (!track) return;

  const linesCount = TapSync.flatTokens[TapSync.flatTokens.length - 1]?.lineIdx + 1 || 1;
  const newLines = [];

  for (let li = 0; li < linesCount; li++) {
    const lineTokens = TapSync.flatTokens.filter(t => t.lineIdx === li);
    const lineFirstIdx = TapSync.flatTokens.indexOf(lineTokens[0]);
    const lineStart = TapSync.timestamps[lineFirstIdx] ?? 0;
    const lineEnd   = TapSync.timestamps[lineFirstIdx + lineTokens.length] ?? (lineStart + 3.0);

    const isAdlib = lineTokens[0]?.isAdlib;
    const agent   = lineTokens[0]?.agent || 'v1';

    const rawSyllabi = lineTokens.map((tok, wi) => {
      const fi = lineFirstIdx + wi;
      const tStart = TapSync.timestamps[fi] ?? lineStart;
      const tEnd   = TapSync.timestamps[fi + 1] ?? (tStart + 0.3);
      return {
        time: Math.round(tStart * 1000),
        duration: Math.max(50, Math.round((tEnd - tStart) * 1000)),
        text: tok.text + (wi < lineTokens.length - 1 ? ' ' : ''),
      };
    });

    newLines.push({
      id: `L-${li + 1}`,
      start: Math.round(lineStart * 1000) / 1000,
      end:   Math.round(lineEnd * 1000) / 1000,
      text:  isAdlib ? '' : lineTokens.map(t => t.text).join(' '),
      adlib: isAdlib ? lineTokens.map(t => t.text).join(' ') : null,
      rawSyllabi: isAdlib ? [] : rawSyllabi,
      adlibSyllabi: isAdlib ? rawSyllabi : [],
      agent: agent,
      side: agent === 'v2' ? 'left' : 'right',
      isSimultaneous: false,
      laneIndex: isAdlib ? 1 : 0,
    });
  }

  pushHistory();
  track.lyrics = {
    meta: { ...(track.lyrics?.meta || {}), timingType: 'Word' },
    lines: newLines,
  };
  track.status = 'syllable_synced';

  closeTapOverlay();
  saveActiveTrackToBackend();
  refreshEditorViews();
  toast('Tap sync saved!', 'success');
}

function closeTapOverlay() {
  if (tapRafId) cancelAnimationFrame(tapRafId);
  if (tapAudio) { tapAudio.pause(); tapAudio.src = ''; }
  document.getElementById('ttmlTapOverlay')?.classList.add('hidden');
}

// Global Key Handler for Tap Overlay
window.addEventListener('keydown', e => {
  const overlay = document.getElementById('ttmlTapOverlay');
  if (!overlay || overlay.classList.contains('hidden')) return;

  if (e.code === 'Escape') {
    e.preventDefault();
    closeTapOverlay();
    return;
  }

  if (e.code === 'Space') {
    e.preventDefault();
    if (!TapSync.started) {
      TapSync.started = true;
      if (tapAudio) tapAudio.play().catch(() => {});
    }
    const t = tapAudio ? tapAudio.currentTime : 0;
    TapSync.timestamps[TapSync.flatIdx] = t;
    TapSync.flatIdx++;

    if (TapSync.flatIdx >= TapSync.flatTokens.length) {
      finishTapSync();
    } else {
      updateTapUI();
    }
  } else if (e.code === 'Backspace') {
    e.preventDefault();
    if (TapSync.flatIdx > 0) {
      TapSync.flatIdx--;
      delete TapSync.timestamps[TapSync.flatIdx];
      updateTapUI();
      if (tapAudio) {
        const prevT = TapSync.timestamps[TapSync.flatIdx - 1];
        if (prevT !== undefined) tapAudio.currentTime = Math.max(0, prevT - 0.2);
      }
    }
  } else if (e.code === 'KeyB') {
    // Toggle current token as Ad-lib
    const cur = TapSync.flatTokens[TapSync.flatIdx];
    if (cur) {
      cur.isAdlib = !cur.isAdlib;
      updateTapUI();
    }
  }
});
