'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// app-tap.js — Tap Sync overlay (line-level)
// Depends on: shared.js (sleep, uvrAvailable), app-state.js (S, $, fmt, uid, escHTML, clamp),
//             app-editor.js (initEditor, pushHistory, renderSegmentBlocks,
//                            renderSegmentList, updateLrcPreview, updateWaveVocalsBtn,
//                            decodeVocalsWaveform, seekTo)
// ─────────────────────────────────────────────────────────────────────────────

const TAP_PPS = 80; // pixels per second for scrolling waveform — same as EH WT_PPS

var tapAudio = null;

var tapState = {
  active:     false,
  lines:      [],
  times:      [],
  currentIdx: 0,
  started:    false,
  rafId:      null,
  source:     'upload',
  wavePeaks:    null,
  songPeaks:    null,
  vocalPeaks:   null,
  waveDuration: 0,
  songDecodeId:  0,
  vocalDecodeId: 0,
  originalUrl:    null,
  vocalsUrl:      null,
  useVocals:      false,
  isolating:      false,
  isolationJobId: null,
};

// ─── SVG icon helper ──────────────────────────────────────────────────────────
function tapVocalsBtnHTML(label) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/></svg> ${label}`;
}

// ─── Audio ────────────────────────────────────────────────────────────────────
function _makeTapAudio(url) {
  if (tapAudio) { tapAudio.pause(); tapAudio.src = ''; }
  tapAudio = new Audio(url);
  tapAudio.preload = 'auto';
  tapAudio.addEventListener('ended', () => {
    if (tapState.active && tapState.times.length > 0) finishTapSync();
  });
  return tapAudio;
}

function _switchTapAudio(url) {
  if (!url) return;
  const wasPlaying  = tapState.started && tapAudio && !tapAudio.paused;
  const currentTime = (tapAudio && isFinite(tapAudio.currentTime)) ? tapAudio.currentTime : 0;
  _makeTapAudio(url);
  try { tapAudio.currentTime = currentTime; } catch (_) {}
  if (wasPlaying) tapAudio.play().catch(() => {});
}

// ─── Open ─────────────────────────────────────────────────────────────────────
function openTapSync(source) {
  let lines;
  if (source === 'upload') {
    lines = el.lyricsInput.value.trim().split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) { toast('Please enter lyrics.', 'error'); return; }
    if (!S.fileId)     { toast('No audio uploaded.', 'error'); return; }
  } else {
    if (!S.segments.length) { toast('No segments available.', 'error'); return; }
    if (!S.fileId)           { toast('No audio loaded.', 'error'); return; }
    lines = [...S.segments].sort((a, b) => a.start - b.start).map(s => s.text);
    if (ws && S.isPlaying) ws.pause();
  }

  const audioUrl = `/api/audio/${S.fileId}`;
  _makeTapAudio(audioUrl);

  Object.assign(tapState, {
    active: true, lines, times: [],
    currentIdx: 0, started: false, source,
    wavePeaks: null, songPeaks: null, vocalPeaks: null, waveDuration: 0,
    songDecodeId: 0, vocalDecodeId: 0,
    originalUrl: audioUrl, vocalsUrl: null,
    useVocals: false, isolating: false, isolationJobId: null,
  });

  const vBtn = $('tapVocalsBtn');
  if (vBtn) {
    vBtn.style.display = uvrAvailable ? 'inline-flex' : 'none';
    vBtn.className     = 'btn btn-ghost btn-sm tap-vocals-btn';
    vBtn.disabled      = false;
    vBtn.innerHTML     = tapVocalsBtnHTML('Vocals');
  }

  $('tapFinishBtn').disabled = true;
  renderTapLines();
  $('tapSyncOverlay').classList.remove('hidden');
  $('tapSyncOverlay').focus();

  initTapWaveCanvas();
  if (tapState.rafId) cancelAnimationFrame(tapState.rafId);
  tapState.rafId = requestAnimationFrame(tapRAF);

  decodeTapSong(audioUrl);

  if (source === 'upload' && $('tapVocalsAutoToggle')?.checked && uvrAvailable) {
    runTapVocalsIsolation();
  }
}

// ─── RAF loop ─────────────────────────────────────────────────────────────────
function tapRAF() {
  if (!tapState.active) return;
  const t   = tapAudio ? tapAudio.currentTime : 0;
  const dur = tapAudio ? (tapAudio.duration || 0) : 0;

  const tEl = $('tapTimeDisplay');
  if (tEl) tEl.textContent = fmt(t);
  const cEl = $('tapCountDisplay');
  if (cEl) cEl.textContent = `${tapState.times.length} / ${tapState.lines.length}`;
  if (dur > 0) {
    const pb = $('tapAudioProgress');
    if (pb) pb.style.width = ((t / dur) * 100).toFixed(2) + '%';
  }
  drawTapWaveform();
  tapState.rafId = requestAnimationFrame(tapRAF);
}

// ─── Waveform canvas ──────────────────────────────────────────────────────────
function initTapWaveCanvas() {
  const canvas = $('tapWaveCanvas');
  if (!canvas) return;
  canvas.width  = canvas.parentElement ? canvas.parentElement.clientWidth : window.innerWidth;
  canvas.height = 64;
}

// Peak decode — wraps shared.js decodeAudioPeaks at TAP_PPS resolution
async function decodeTapSong(url) {
  const myId = ++tapState.songDecodeId;
  tapState.songPeaks = null;
  if (!tapState.useVocals) tapState.wavePeaks = null;
  try {
    const { peaks, duration } = await decodeAudioPeaks(url, TAP_PPS);
    if (myId !== tapState.songDecodeId) return;
    tapState.songPeaks    = peaks;
    tapState.waveDuration = duration;
    if (!tapState.useVocals) tapState.wavePeaks = tapState.songPeaks;
  } catch (e) { console.warn('Tap song waveform decode failed:', e); }
}

async function decodeTapVocals(url) {
  const myId = ++tapState.vocalDecodeId;
  tapState.vocalPeaks = null;
  if (tapState.useVocals) tapState.wavePeaks = null;
  try {
    const { peaks, duration } = await decodeAudioPeaks(url, TAP_PPS);
    if (myId !== tapState.vocalDecodeId) return;
    tapState.vocalPeaks   = peaks;
    tapState.waveDuration = duration;
    if (tapState.useVocals) tapState.wavePeaks = tapState.vocalPeaks;
  } catch (e) { console.warn('Tap vocal waveform decode failed:', e); }
}

function drawTapWaveform() {
  const canvas = $('tapWaveCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const t   = tapAudio ? tapAudio.currentTime : 0;
  const dur = tapState.waveDuration;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#07070f';
  ctx.fillRect(0, 0, w, h);

  const playheadX = Math.floor(w * 0.3);

  if (!tapState.wavePeaks) {
    const amp = h * 0.28;
    for (let px = 0; px < w; px += 5) {
      const a = Math.abs(Math.sin(px * 0.07)) * amp + 4;
      ctx.fillStyle = px < playheadX ? 'rgba(124,58,237,.35)' : 'rgba(255,255,255,.12)';
      ctx.fillRect(px, h / 2 - a, 3, a * 2);
    }
    ctx.fillStyle = 'rgba(255,255,255,.8)';
    ctx.fillRect(playheadX, 0, 1, h);
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillText('Loading waveform…', playheadX + 8, h / 2 + 4);
    return;
  }

  const peaks      = tapState.wavePeaks;
  const timeOffset = t - playheadX / TAP_PPS;
  const mid        = h / 2;

  for (let px = 0; px < w; px++) {
    const sTime = timeOffset + px / TAP_PPS;
    if (sTime < 0 || sTime > dur) continue;
    const sPx = Math.floor(sTime * TAP_PPS);
    if (sPx >= peaks.length) continue;
    const amp = peaks[sPx] * mid * 0.92;
    ctx.fillStyle = px < playheadX
      ? (tapState.useVocals ? '#16a34a' : '#7c3aed')
      : (tapState.useVocals ? '#14532d' : '#22224a');
    ctx.fillRect(px, mid - amp, 1, amp * 2 || 1);
  }

  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(playheadX, 0, 1, h);
  ctx.beginPath();
  ctx.moveTo(playheadX - 5, 0);
  ctx.lineTo(playheadX + 6, 0);
  ctx.lineTo(playheadX + 0.5, 8);
  ctx.fillStyle = '#f8fafc'; ctx.fill();

  tapState.times.forEach((tapTime, i) => {
    const mx = Math.round(playheadX + (tapTime - t) * TAP_PPS);
    if (mx < 0 || mx > w) return;
    ctx.strokeStyle = 'rgba(16,185,129,.72)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(mx + .5, 0); ctx.lineTo(mx + .5, h); ctx.stroke();
    if (mx > 2 && mx < w - 14) {
      ctx.fillStyle = 'rgba(16,185,129,.85)';
      ctx.font = '9px JetBrains Mono, monospace';
      ctx.fillText(String(i + 1), mx + 2, 11);
    }
  });
}

// ─── Vocals isolation ─────────────────────────────────────────────────────────
function _tapIsolatingShow(status, pct) {
  const scr = $('tapIsolatingScreen');
  if (!scr) return;
  scr.classList.remove('hidden');
  const st = $('tapIsolatingStatus'); if (st) st.textContent = status;
  const bar = $('tapIsolatingBar');   if (bar) bar.style.width = pct + '%';
  const p   = $('tapIsolatingPct');   if (p)   p.textContent  = pct + '%';
}

function _tapIsolatingHide() {
  $('tapIsolatingScreen')?.classList.add('hidden');
}

async function runTapVocalsIsolation() {
  if (tapState.isolating || !S.fileId) return;
  tapState.isolating = true;
  const btn      = $('tapVocalsBtn');
  const uvrModel = $('tapVocalsModelSelect')?.value || $('uvrModelSelect')?.value || 'UVR-MDX-NET-Inst_HQ_3';
  if (btn) { btn.disabled = true; btn.classList.add('loading'); }
  _tapIsolatingShow('Loading vocal model…', 0);

  try {
    const form = new FormData();
    form.append('file_id',      S.fileId);
    form.append('uvr_model_id', uvrModel);
    const r = await fetch('/api/isolate', { method: 'POST', body: form });
    if (!r.ok) throw new Error('Isolation could not be started');
    const { job_id } = await r.json();
    tapState.isolationJobId = job_id;

    while (tapState.active && tapState.isolating) {
      await sleep(1500);
      if (!tapState.active || !tapState.isolating) break;
      const job = await fetch(`/api/job/${job_id}`).then(r => r.json());
      const pct = typeof job.progress === 'number' ? job.progress : 0;
      const statusMsg = job.status === 'separating_model' ? 'Loading vocal model…'
                      : job.status === 'separating'       ? 'Isolating vocals…'
                      : 'Processing…';
      _tapIsolatingShow(statusMsg, pct);
      if (btn) btn.innerHTML = tapVocalsBtnHTML(`${pct}%`);

      if (job.status === 'done') {
        tapState.vocalsUrl = `/api/vocals/${job_id}`;
        tapState.useVocals = true;
        tapState.isolating = false;
        _tapIsolatingHide();
        _switchTapAudio(tapState.vocalsUrl);
        decodeTapVocals(tapState.vocalsUrl);
        if (btn) { btn.disabled = false; btn.classList.remove('loading'); btn.classList.add('active'); btn.innerHTML = tapVocalsBtnHTML('Vocals ●'); }
        toast('Vocals isolated — waveform updated.', 'success');
        return;
      }
      if (job.status === 'error') throw new Error(job.error || 'Error');
    }
    // Skipped by user
    _tapIsolatingHide();
    tapState.isolating = false;
    if (btn) { btn.disabled = false; btn.classList.remove('loading'); btn.innerHTML = tapVocalsBtnHTML('Vocals'); }
  } catch (e) {
    _tapIsolatingHide();
    tapState.isolating = false;
    if (btn) { btn.disabled = false; btn.classList.remove('loading'); btn.innerHTML = tapVocalsBtnHTML('Vocals'); }
    toast('Vocal isolation failed: ' + e.message, 'error');
  }
}

function toggleTapVocals() {
  if (!tapState.active || tapState.isolating) return;
  if (!tapState.vocalsUrl) { runTapVocalsIsolation(); return; }
  const btn = $('tapVocalsBtn');
  if (tapState.useVocals) {
    tapState.useVocals = false;
    tapState.wavePeaks = tapState.songPeaks;
    _switchTapAudio(tapState.originalUrl);
    if (btn) { btn.classList.remove('active'); btn.innerHTML = tapVocalsBtnHTML('Vocals'); }
  } else {
    tapState.useVocals = true;
    tapState.wavePeaks = tapState.vocalPeaks;
    _switchTapAudio(tapState.vocalsUrl);
    if (btn) { btn.classList.add('active'); btn.innerHTML = tapVocalsBtnHTML('Vocals ●'); }
  }
}

// ─── Line display ─────────────────────────────────────────────────────────────
function renderTapLines() {
  const container = $('tapLinesList');
  if (!container) return;
  container.innerHTML = '';
  const idx = tapState.currentIdx;

  tapState.lines.forEach((text, i) => {
    const div = document.createElement('div');
    div.className = 'tap-line';
    div.dataset.idx = i;

    if (!tapState.started) {
      div.classList.add(i === 0 ? 'tap-line-next' : 'tap-line-upcoming');
      div.innerHTML = `<span class="tap-line-text">${escHTML(text)}</span>`;
    } else if (i < idx - 1) {
      div.classList.add('tap-line-done');
      div.innerHTML = `<span class="tap-line-check">✓</span>
        <span class="tap-line-text">${escHTML(text)}</span>
        <span class="tap-line-time">${fmt(tapState.times[i])}</span>`;
    } else if (i === idx - 1) {
      div.classList.add('tap-line-current');
      div.innerHTML = `<span class="tap-line-text">${escHTML(text)}</span>`;
    } else {
      div.classList.add('tap-line-upcoming');
      div.innerHTML = `<span class="tap-line-text">${escHTML(text)}</span>`;
    }
    container.appendChild(div);
  });

  container.querySelector('.tap-line-current, .tap-line-next')
    ?.scrollIntoView({ block: 'center', behavior: 'smooth' });

  const hEl = $('tapHint');
  if (!hEl) return;
  if (!tapState.started) {
    hEl.innerHTML = `<span class="tap-space-hint">SPACE</span> to start playback &amp; mark the first line`;
  } else {
    const remaining = tapState.lines.length - tapState.currentIdx;
    hEl.textContent = remaining > 0
      ? `${remaining} ${remaining === 1 ? 'line' : 'lines'} remaining — Space when the next line begins`
      : 'All lines marked!';
  }
}

// ─── Tap / Undo ───────────────────────────────────────────────────────────────
function tapMark() {
  if (!tapState.active || tapState.currentIdx >= tapState.lines.length) return;
  const t = tapAudio ? tapAudio.currentTime : 0;

  if (!tapState.started) {
    tapState.started = true;
    tapAudio.play().catch(() => {});
    tapState.times.push(t);
    tapState.currentIdx = 1;
    renderTapLines();
    return;
  }

  tapState.times.push(t);
  tapState.currentIdx++;
  renderTapLines();

  const curEl = $('tapLinesList')?.querySelector('.tap-line-current');
  if (curEl) { curEl.classList.remove('tapped'); void curEl.offsetWidth; curEl.classList.add('tapped'); }

  const fb = $('tapFinishBtn');
  if (fb) fb.disabled = false;

  if (tapState.currentIdx >= tapState.lines.length) {
    if ($('tapHint')) $('tapHint').textContent = 'All lines marked — done!';
    setTimeout(finishTapSync, 600);
  }
}

function tapUndo() {
  if (!tapState.active || tapState.times.length === 0) return;
  tapState.times.pop();
  tapState.currentIdx = Math.max(0, tapState.currentIdx - 1);
  if (tapState.currentIdx === 0) {
    tapState.started = false;
    if (tapAudio) { tapAudio.pause(); tapAudio.currentTime = 0; }
    const fb = $('tapFinishBtn'); if (fb) fb.disabled = true;
  } else {
    if (tapAudio) tapAudio.currentTime = tapState.times[tapState.currentIdx - 1];
  }
  renderTapLines();
  toast('Went back.', '');
}

// ─── Finish ───────────────────────────────────────────────────────────────────
async function finishTapSync() {
  if (!tapState.active) return;
  const lines = tapState.lines, times = tapState.times;
  if (!times.length) { closeTapOverlay(); return; }
  if (tapAudio) tapAudio.pause();

  const audioDur = (tapAudio && !isNaN(tapAudio.duration)) ? tapAudio.duration : S.duration;
  const avgDur   = times.length > 1
    ? (times[times.length - 1] - times[0]) / (times.length - 1) : 3;

  const segs = lines.slice(0, times.length).map((text, i) => ({
    id:    uid(),
    start: parseFloat(times[i].toFixed(3)),
    end:   parseFloat((i < times.length - 1
      ? times[i + 1]
      : Math.min(times[i] + avgDur, audioDur || times[i] + avgDur)
    ).toFixed(3)),
    text,
  }));

  const src = tapState.source;
  const isolationJobId = tapState.isolationJobId;
  closeTapOverlay();

  if (isolationJobId) S.vocalsJobId = isolationJobId;

  if (src === 'upload') {
    initEditor(segs);
    toast(`Tap Sync: ${segs.length} lines applied.`, 'success');
  } else {
    pushHistory();
    S.segments = segs;
    renderSegmentBlocks(); renderSegmentList(); updateLrcPreview();
    if (isolationJobId) {
      updateWaveVocalsBtn();
      if (!S.vocalsAudioBuf) decodeVocalsWaveform();
    }
    toast(`Tap Sync: ${segs.length} lines re-tapped.`, 'success');
  }
}

// ─── Close ────────────────────────────────────────────────────────────────────
function closeTapOverlay() {
  tapState.active    = false;
  tapState.isolating = false;
  tapState.wavePeaks = null;
  tapState.songPeaks = null;
  tapState.vocalPeaks = null;
  if (tapState.rafId) { cancelAnimationFrame(tapState.rafId); tapState.rafId = null; }
  if (tapAudio) { tapAudio.pause(); tapAudio.src = ''; tapAudio = null; }
  _tapIsolatingHide();
  $('tapSyncOverlay').classList.add('hidden');
}
