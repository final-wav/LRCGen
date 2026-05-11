'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// eh-editor.js — Timeline, waveform, vocals, playback, editing, export, init
// Depends on: shared.js, eh-upload.js
// ─────────────────────────────────────────────────────────────────────────────

const EH_PPS_BASE = 80;

// ─── Editor init ──────────────────────────────────────────────────────────────
function initEnhancedEditor(segments) {
  EH.segments    = segments.map((s, i) => ({ ...s, id: i }));
  EH.history     = [];
  EH.historyIdx  = -1;
  EH.selectedLine = null;
  ehShowPhase('editor');

  if (ehAudio) { ehAudio.pause(); ehAudio.src = ''; }
  ehAudio = new Audio(EH.audioUrl);
  ehAudio.volume = +(ehEl('ehVolumeSlider')?.value ?? 1);
  ehAudio.addEventListener('ended', () => {
    EH.isPlaying = false;
    ehUpdatePlayUI();
  });
  ehAudio.addEventListener('loadedmetadata', () => {
    EH.duration = ehAudio.duration;
    const dd = ehEl('ehDurationDisplay');
    if (dd) dd.textContent = ehFmt(EH.duration);
    ehSetTimelineWidth();
    ehDecodeWave(EH.audioUrl);
  });

  EH.audioBuf       = null;
  EH.vocalsAudioBuf = null;
  EH.vocalsPeaks    = null;
  EH.useVocalsWave  = false;
  EH.useVocalsAudio = false;
  // If UVR check hasn't resolved yet, trigger it — it calls ehUpdateVocalsBtns() when done
  if (EH.uvrAvail === null) checkUVR();
  else ehUpdateVocalsBtns();
  if (EH.vocalsJobId) ehDecodeVocalsWave();

  const badge = ehEl('ehEngineBadge');
  if (badge) badge.textContent = `Engine: ${EH.engine}`;

  ehRenderLineBlocks();
  ehRenderWordChips();
  ehRenderSegList();
  ehRefreshUndoRedo();
  ehStartRAF();
  ehResizeCanvases();
}

// ─── Timeline setup ───────────────────────────────────────────────────────────
function ehSetTimelineWidth() {
  const w = Math.max(EH.duration * EH.pps, 800);
  const inner = ehEl('ehTlInner');
  if (inner) inner.style.width = w + 'px';
  const rc = ehEl('ehRulerCanvas');
  if (rc) { rc.width = w; rc.style.width = w + 'px'; ehDrawRuler(rc); }
  const wc = ehEl('ehWaveCanvas');
  if (wc) { wc.width = w; wc.style.width = w + 'px'; ehDrawWave(wc); }
}

function ehResizeCanvases() {
  const rc = ehEl('ehRulerCanvas');
  const wc = ehEl('ehWaveCanvas');
  const scroll = ehEl('ehScrollArea');
  if (!scroll) return;
  const totalW = Math.max(EH.duration * EH.pps, scroll.clientWidth, 800);
  if (rc) { rc.width = totalW; rc.style.width = totalW + 'px'; ehDrawRuler(rc); }
  if (wc) { wc.width = totalW; wc.style.width = totalW + 'px'; ehDrawWave(wc); }
  const inner = ehEl('ehTlInner');
  if (inner) inner.style.width = totalW + 'px';
}

// ─── Ruler ────────────────────────────────────────────────────────────────────
function ehDrawRuler(canvas) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#0b0b14';
  ctx.fillRect(0, 0, w, h);

  const step = EH.pps >= 200 ? 1 : EH.pps >= 80 ? 5 : EH.pps >= 30 ? 10 : 30;
  ctx.fillStyle   = '#4a5568';
  ctx.strokeStyle = '#252540';
  ctx.font        = '9px JetBrains Mono, monospace';
  ctx.textBaseline = 'middle';

  for (let t = 0; t <= EH.duration + step; t += step) {
    const x = Math.round(t * EH.pps);
    ctx.beginPath(); ctx.moveTo(x, h - 7); ctx.lineTo(x, h);
    ctx.strokeStyle = '#252540'; ctx.stroke();
    const m = Math.floor(t / 60), s = Math.floor(t % 60);
    ctx.fillStyle = '#4a5568';
    ctx.fillText(`${m}:${String(s).padStart(2,'0')}`, x + 2, h / 2);
  }
}

// ─── Peaks recompute from stored AudioBuffer (mirrors _computePeaks in app-editor.js)
function _ehComputePeaks(buf) {
  if (!buf) return null;
  const totalPx = Math.ceil(buf.duration * EH.pps);
  const data    = buf.getChannelData(0);
  const sRate   = buf.sampleRate;
  const peaks   = new Float32Array(totalPx);
  for (let px = 0; px < totalPx; px++) {
    const iS = Math.floor((px / EH.pps) * sRate);
    const iE = Math.min(Math.ceil(((px + 1) / EH.pps) * sRate), data.length);
    let max = 0;
    for (let i = iS; i < iE; i++) { const v = Math.abs(data[i]); if (v > max) max = v; }
    peaks[px] = max;
  }
  return peaks;
}

// ─── Waveform decode + draw ───────────────────────────────────────────────────
async function ehDecodeWave(url) {
  const myId = ++EH.decodeId;
  EH.wavePeaks = null;
  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
    const resp = await fetch(url);
    if (!resp.ok) { ctx.close(); return; }
    const ab   = await resp.arrayBuffer();
    const buf  = await ctx.decodeAudioData(ab);
    ctx.close();
    if (myId !== EH.decodeId) return;
    EH.audioBuf  = buf;
    EH.wavePeaks = _ehComputePeaks(buf);
    const wc = ehEl('ehWaveCanvas');
    if (wc) ehDrawWave(wc);
  } catch (_) {}
}

// ─── Vocals waveform ──────────────────────────────────────────────────────────
async function ehDecodeVocalsWave() {
  if (!EH.vocalsUrl) return;
  const btn = ehEl('ehVocalsWaveBtn');
  if (btn) btn.classList.add('loading');
  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
    const resp = await fetch(EH.vocalsUrl);
    if (!resp.ok) throw new Error('Vocals not available');
    const ab   = await resp.arrayBuffer();
    EH.vocalsAudioBuf = await ctx.decodeAudioData(ab);
    ctx.close();
    EH.vocalsPeaks = _ehComputePeaks(EH.vocalsAudioBuf);
    if (btn) { btn.classList.remove('loading'); btn.classList.remove('hidden'); }
    if (EH.useVocalsWave) { const wc = ehEl('ehWaveCanvas'); if (wc) ehDrawWave(wc); }
  } catch (e) {
    console.warn('Vocals waveform decode failed:', e);
    if (btn) btn.classList.remove('loading');
  }
}

async function ehRunIsolation(loadingBtn) {
  if (!EH.fileId) return false;
  if (loadingBtn) { loadingBtn.classList.add('loading'); loadingBtn.disabled = true; }
  try {
    const uvrModel = ehEl('ehUvrModelSelect')?.value || 'UVR-MDX-NET-Inst_HQ_3';
    const form = new FormData();
    form.append('file_id',      EH.fileId);
    form.append('uvr_model_id', uvrModel);
    const r = await fetch('/api/isolate', { method: 'POST', body: form });
    if (!r.ok) throw new Error('Isolation failed to start');
    const { job_id } = await r.json();
    while (true) {
      await sleep(1500);
      const job = await fetch(`/api/job/${job_id}`).then(r => r.json());
      if (loadingBtn) loadingBtn.title = `Vocals: ${job.progress || 0}%`;
      if (job.status === 'done') { EH.vocalsJobId = job_id; EH.vocalsUrl = `/api/vocals/${job_id}`; break; }
      if (job.status === 'error') throw new Error(job.error || 'Isolation error');
    }
    if (loadingBtn) { loadingBtn.classList.remove('loading'); loadingBtn.disabled = false; }
    return true;
  } catch (e) {
    if (loadingBtn) { loadingBtn.classList.remove('loading'); loadingBtn.disabled = false; }
    toast('Vocal isolation failed: ' + e.message, 'error');
    return false;
  }
}

function ehUpdateVocalsBtns() {
  const show = !!((EH.uvrAvail || uvrAvailable) && EH.fileId);
  ehEl('ehVocalsWaveBtn')?.classList.toggle('hidden', !show);
  ehEl('ehVocalsAudioBtn')?.classList.toggle('hidden', !show);
  ehEl('ehVocalsWaveBtn')?.classList.toggle('active', EH.useVocalsWave && !!EH.vocalsPeaks);
  ehEl('ehVocalsAudioBtn')?.classList.toggle('active', EH.useVocalsAudio);
  // Vocals Preview card on the pre-sync upload screen
  const uvrOk = EH.uvrAvail === true || uvrAvailable === true;
  const wtCard = ehEl('wtVocalsPreviewCard');
  if (wtCard) wtCard.style.display = uvrOk ? '' : 'none';
}

async function ehToggleVocalsWave() {
  const on  = !EH.useVocalsWave;
  const btn = ehEl('ehVocalsWaveBtn');
  if (on && !EH.vocalsJobId) {
    const ok = await ehRunIsolation(btn);
    if (!ok) return;
  }
  EH.useVocalsWave = on;
  if (on && !EH.vocalsPeaks) ehDecodeVocalsWave();
  ehUpdateVocalsBtns();
  const wc = ehEl('ehWaveCanvas'); if (wc) ehDrawWave(wc);
}

async function ehToggleVocalsAudio() {
  const on  = !EH.useVocalsAudio;
  const btn = ehEl('ehVocalsAudioBtn');
  if (on && !EH.vocalsJobId) {
    const ok = await ehRunIsolation(btn);
    if (!ok) return;
  }
  EH.useVocalsAudio = on;
  const url = on ? EH.vocalsUrl : EH.audioUrl;
  if (ehAudio && url) {
    const seekTo   = ehAudio.currentTime;
    const autoPlay = !ehAudio.paused;
    ehAudio.src = url;
    // Wait for enough metadata so currentTime seek is reliable
    ehAudio.addEventListener('canplay', function onCanPlay() {
      ehAudio.removeEventListener('canplay', onCanPlay);
      ehAudio.currentTime = seekTo;
      if (autoPlay) ehAudio.play().catch(() => {});
    }, { once: true });
    ehAudio.load();
  }
  ehUpdateVocalsBtns();
}

function ehDrawWave(canvas) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#0f0f1d';
  ctx.fillRect(0, 0, w, h);
  const peaks = (EH.useVocalsWave && EH.vocalsPeaks) ? EH.vocalsPeaks : EH.wavePeaks;
  if (!peaks || !peaks.length) {
    ctx.fillStyle = 'rgba(124,58,237,.18)';
    const BAR_W = 3, GAP = 2;
    for (let x = 0; x < w; x += BAR_W + GAP) {
      const bh = (Math.sin(x * 0.04) * 0.4 + 0.5) * h * 0.5;
      ctx.fillRect(x, (h - bh) / 2, BAR_W, bh);
    }
    return;
  }
  const isVocals = EH.useVocalsWave && EH.vocalsPeaks;
  const t = ehAudio ? ehAudio.currentTime : 0;
  const playX = t * EH.pps;
  for (let px = 0; px < w && px < peaks.length; px++) {
    const amp = peaks[px];
    const bh  = Math.max(1, amp * h * 0.92);
    ctx.fillStyle = px < playX
      ? (isVocals ? '#22c55e' : '#7c3aed')
      : '#22224a';
    ctx.fillRect(px, (h - bh) / 2, 1, bh);
  }
}

// ─── RAF loop ─────────────────────────────────────────────────────────────────
function ehStartRAF() {
  if (ehRafId) cancelAnimationFrame(ehRafId);
  function loop() {
    if (!EH.isPlaying && !ehAudio) return;
    EH.currentTime = ehAudio ? ehAudio.currentTime : 0;
    ehUpdatePlayheadDOM();
    const td = ehEl('ehTimeDisplay');
    if (td) td.textContent = ehFmt(EH.currentTime);
    const wc = ehEl('ehWaveCanvas');
    if (wc) ehDrawWave(wc);
    ehRafId = requestAnimationFrame(loop);
  }
  ehRafId = requestAnimationFrame(loop);
}

function ehUpdatePlayheadDOM() {
  const ph = ehEl('ehPlayhead');
  if (!ph) return;
  const x = EH.currentTime * EH.pps;
  ph.style.transform = `translateX(${x}px)`;
  const scroll = ehEl('ehScrollArea');
  if (scroll && EH.isPlaying) {
    const visW = scroll.clientWidth;
    const left = scroll.scrollLeft;
    if (x > left + visW * 0.85) scroll.scrollLeft = x - visW * 0.3;
    if (x < left) scroll.scrollLeft = Math.max(0, x - 40);
  }
}

// ─── Playback controls ────────────────────────────────────────────────────────
function ehTogglePlay() {
  if (!ehAudio) return;
  if (EH.isPlaying) { ehAudio.pause(); EH.isPlaying = false; }
  else              { ehAudio.play();  EH.isPlaying = true;  }
  ehUpdatePlayUI();
}
function ehUpdatePlayUI() {
  const ip = ehEl('ehIconPlay'), ipa = ehEl('ehIconPause');
  if (ip)  ip.classList.toggle('hidden', EH.isPlaying);
  if (ipa) ipa.classList.toggle('hidden', !EH.isPlaying);
}
function ehSeek(delta) {
  if (!ehAudio) return;
  ehAudio.currentTime = Math.max(0, Math.min(EH.duration, ehAudio.currentTime + delta));
}

// ─── Zoom ─────────────────────────────────────────────────────────────────────
function ehApplyZoom(newPps) {
  const t = EH.currentTime;
  EH.pps = Math.max(15, Math.min(600, newPps));
  const sl = ehEl('ehZoomSlider');
  if (sl) sl.value = EH.pps;
  const lbl = ehEl('ehZoomLabel');
  if (lbl) lbl.textContent = Math.round(EH.pps / EH_PPS_BASE * 100) + '%';
  if (EH.audioBuf)       EH.wavePeaks   = _ehComputePeaks(EH.audioBuf);
  if (EH.vocalsAudioBuf) EH.vocalsPeaks = _ehComputePeaks(EH.vocalsAudioBuf);
  ehResizeCanvases();
  ehRenderLineBlocks();
  ehRenderWordChips();
  ehUpdatePlayheadDOM();
  const scroll = ehEl('ehScrollArea');
  if (scroll) scroll.scrollLeft = Math.max(0, t * EH.pps - scroll.clientWidth * 0.3);
}

// ─── Render line blocks ───────────────────────────────────────────────────────
function ehRenderLineBlocks() {
  const track = ehEl('ehLineTrack');
  if (!track) return;
  track.innerHTML = '';
  EH.segments.forEach(seg => {
    const x = seg.start * EH.pps;
    const w = Math.max(4, (seg.end - seg.start) * EH.pps);
    const div = document.createElement('div');
    div.className = 'en-line-block' + (EH.selectedLine === seg.id ? ' selected' : '');
    div.style.cssText = `left:${x}px;width:${w}px`;
    div.dataset.segId = seg.id;

    const txt = document.createElement('span');
    txt.className = 'en-line-block-text';
    txt.textContent = seg.text;
    div.appendChild(txt);

    const el = document.createElement('div');
    el.className = 'en-line-edge en-line-edge-l';
    const er = document.createElement('div');
    er.className = 'en-line-edge en-line-edge-r';
    div.appendChild(el); div.appendChild(er);

    el.addEventListener('mousedown', e => ehStartLineDrag(e, seg.id, 'left'));
    er.addEventListener('mousedown', e => ehStartLineDrag(e, seg.id, 'right'));
    div.addEventListener('mousedown', e => {
      if (e.target.classList.contains('en-line-edge')) return;
      ehSelectLine(seg.id);
      ehStartLineDrag(e, seg.id, 'move');
    });
    div.addEventListener('dblclick', () => ehEditLine(seg.id));

    track.appendChild(div);
  });
}

// ─── Render word chips ────────────────────────────────────────────────────────
function ehRenderWordChips() {
  const track = ehEl('ehWordTrack');
  if (!track) return;
  track.innerHTML = '';
  EH.segments.forEach(seg => {
    (seg.words || []).forEach((w, wi) => {
      const x  = w.start * EH.pps;
      const wd = Math.max(4, (w.end - w.start) * EH.pps);
      const chip = document.createElement('div');
      chip.className = 'en-word-chip' + (w.is_syllable ? ' syllable' : '');
      chip.style.cssText = `left:${x}px;width:${wd}px`;
      chip.dataset.segId   = seg.id;
      chip.dataset.wordIdx = wi;

      const span = document.createElement('span');
      span.className = 'en-word-chip-text';
      span.textContent = w.word;
      chip.appendChild(span);

      const el = document.createElement('div');
      el.className = 'en-word-edge en-word-edge-l';
      const er = document.createElement('div');
      er.className = 'en-word-edge en-word-edge-r';
      chip.appendChild(el); chip.appendChild(er);

      el.addEventListener('mousedown', e => ehStartWordDrag(e, seg.id, wi, 'left'));
      er.addEventListener('mousedown', e => ehStartWordDrag(e, seg.id, wi, 'right'));
      chip.addEventListener('mousedown', e => {
        if (e.target.classList.contains('en-word-edge')) return;
        ehStartWordDrag(e, seg.id, wi, 'move');
      });
      chip.addEventListener('dblclick', () => ehEditWord(seg.id, wi));

      track.appendChild(chip);
    });
  });
}

// ─── Select line ──────────────────────────────────────────────────────────────
function ehSelectLine(segId) {
  EH.selectedLine = segId;
  document.querySelectorAll('.en-line-block').forEach(el =>
    el.classList.toggle('selected', +el.dataset.segId === segId));
}

// ─── Drag: line block ─────────────────────────────────────────────────────────
function ehStartLineDrag(e, segId, handle) {
  e.preventDefault(); e.stopPropagation();
  const seg = EH.segments.find(s => s.id === segId);
  if (!seg) return;
  ehSelectLine(segId);
  EH.drag = { type: 'line', handle, segId,
    startX: e.clientX, origStart: seg.start, origEnd: seg.end,
    origWords: seg.words ? seg.words.map(w => ({...w})) : [] };

  function onMove(e2) {
    if (!EH.drag) return;
    const dx  = (e2.clientX - EH.drag.startX) / EH.pps;
    const seg = EH.segments.find(s => s.id === EH.drag.segId);
    if (!seg) return;
    if (EH.drag.handle === 'move') {
      const newStart = Math.max(0, EH.drag.origStart + dx);
      const dur = EH.drag.origEnd - EH.drag.origStart;
      seg.start = round3(newStart);
      seg.end   = round3(newStart + dur);
      seg.words = EH.drag.origWords.map(w => ({
        ...w,
        start: round3(Math.max(seg.start, w.start + dx)),
        end:   round3(Math.min(seg.end,   w.end   + dx)),
      }));
    } else if (EH.drag.handle === 'left') {
      seg.start = round3(Math.max(0, Math.min(EH.drag.origEnd - 0.05, EH.drag.origStart + dx)));
      seg.words = (seg.words || []).map(w => ({
        ...w, start: Math.max(seg.start, w.start), end: Math.max(seg.start, w.end),
      }));
    } else {
      seg.end = round3(Math.max(EH.drag.origStart + 0.05, EH.drag.origEnd + dx));
      seg.words = (seg.words || []).map(w => ({
        ...w, end: Math.min(seg.end, w.end), start: Math.min(seg.end, w.start),
      }));
    }
    ehRenderLineBlocks();
    ehRenderWordChips();
  }

  function onUp() {
    if (EH.drag) ehPushHistory();
    EH.drag = null;
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    ehRenderSegList();
  }
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

// ─── Drag: word chip ──────────────────────────────────────────────────────────
function ehStartWordDrag(e, segId, wordIdx, handle) {
  e.preventDefault(); e.stopPropagation();
  const seg  = EH.segments.find(s => s.id === segId);
  if (!seg || !seg.words) return;
  const word = seg.words[wordIdx];
  if (!word) return;
  EH.drag = { type: 'word', handle, segId, wordIdx,
    startX: e.clientX, origStart: word.start, origEnd: word.end };

  function onMove(e2) {
    if (!EH.drag) return;
    const seg = EH.segments.find(s => s.id === EH.drag.segId);
    if (!seg || !seg.words) return;
    const w = seg.words[EH.drag.wordIdx];
    if (!w) return;
    const dx = (e2.clientX - EH.drag.startX) / EH.pps;
    const prevEnd   = EH.drag.wordIdx > 0
      ? seg.words[EH.drag.wordIdx - 1].end : seg.start;
    const nextStart = EH.drag.wordIdx < seg.words.length - 1
      ? seg.words[EH.drag.wordIdx + 1].start : seg.end;
    if (EH.drag.handle === 'move') {
      const dur = EH.drag.origEnd - EH.drag.origStart;
      const ns  = round3(Math.max(prevEnd, Math.min(nextStart - dur, EH.drag.origStart + dx)));
      w.start = ns; w.end = round3(ns + dur);
    } else if (EH.drag.handle === 'left') {
      w.start = round3(Math.max(prevEnd, Math.min(EH.drag.origEnd - 0.02, EH.drag.origStart + dx)));
    } else {
      w.end = round3(Math.max(EH.drag.origStart + 0.02, Math.min(nextStart, EH.drag.origEnd + dx)));
    }
    ehRenderWordChips();
  }

  function onUp() {
    if (EH.drag) ehPushHistory();
    EH.drag = null;
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    ehRenderSegList();
  }
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

function round3(n) { return Math.round(n * 1000) / 1000; }

// ─── Inline edit ──────────────────────────────────────────────────────────────
function ehEditLine(segId) {
  const seg = EH.segments.find(s => s.id === segId);
  if (!seg) return;
  const newText = prompt('Edit line:', seg.text);
  if (newText === null) return;
  ehPushHistory();
  seg.text = newText.trim();
  ehRenderLineBlocks();
  ehRenderSegList();
}

function ehEditWord(segId, wordIdx) {
  const seg = EH.segments.find(s => s.id === segId);
  if (!seg || !seg.words) return;
  const w = seg.words[wordIdx];
  if (!w) return;
  const newWord = prompt('Edit word:', w.word);
  if (newWord === null) return;
  ehPushHistory();
  w.word = newWord.trim();
  ehRenderWordChips();
  ehRenderSegList();
}

// ─── Segment list (bottom panel) ─────────────────────────────────────────────
function ehRenderSegList() {
  ehUpdatePreview();
  const list = ehEl('ehSegmentsList');
  if (!list) return;
  list.innerHTML = '';
  EH.segments.forEach(seg => {
    const row = document.createElement('div');
    row.className = 'en-seg-row';

    const hdr = document.createElement('div');
    hdr.className = 'en-seg-row-header';
    hdr.innerHTML = `
      <span class="en-seg-time-badge">${ehFmt(seg.start)}</span>
      <span class="en-seg-text">${seg.text}</span>`;
    hdr.addEventListener('click', () => {
      ehSelectLine(seg.id);
      if (ehAudio) ehAudio.currentTime = seg.start;
    });
    row.appendChild(hdr);

    if (seg.words && seg.words.length) {
      const ww = document.createElement('div');
      ww.className = 'en-seg-words';
      seg.words.forEach(w => {
        const badge = document.createElement('span');
        badge.className = 'en-word-badge';
        badge.innerHTML = `<span class="en-word-badge-word">${w.word}</span>
          <span class="en-word-badge-ts">${ehFmt(w.start)}</span>`;
        ww.appendChild(badge);
      });
      row.appendChild(ww);
    }
    list.appendChild(row);
  });
}

// ─── Undo / Redo ──────────────────────────────────────────────────────────────
function ehSnapshot() { return JSON.stringify(EH.segments); }

function ehPushHistory() {
  EH.history.splice(EH.historyIdx + 1);
  EH.history.push(ehSnapshot());
  if (EH.history.length > EH_MAX_HIST) EH.history.shift();
  EH.historyIdx = EH.history.length - 1;
  ehRefreshUndoRedo();
}

function ehUndo() {
  if (EH.historyIdx <= 0) return;
  EH.historyIdx--;
  EH.segments = JSON.parse(EH.history[EH.historyIdx]);
  ehRenderLineBlocks(); ehRenderWordChips(); ehRenderSegList();
  ehRefreshUndoRedo();
}

function ehRedo() {
  if (EH.historyIdx >= EH.history.length - 1) return;
  EH.historyIdx++;
  EH.segments = JSON.parse(EH.history[EH.historyIdx]);
  ehRenderLineBlocks(); ehRenderWordChips(); ehRenderSegList();
  ehRefreshUndoRedo();
}

function ehRefreshUndoRedo() {
  const u = ehEl('ehUndoBtn'), r = ehEl('ehRedoBtn');
  if (u) u.disabled = EH.historyIdx <= 0;
  if (r) r.disabled = EH.historyIdx >= EH.history.length - 1;
}

// ─── New Song ─────────────────────────────────────────────────────────────────
function ehNewSong() {
  if (EH.segments.length && !confirm('Discard current session and load a new song?')) return;
  if (ehAudio) { ehAudio.pause(); ehAudio.src = ''; ehAudio = null; }
  if (ehRafId) { cancelAnimationFrame(ehRafId); ehRafId = null; }
  Object.assign(EH, {
    fileId: null, filename: '', _pendingFile: null, audioUrl: null,
    segments: [], jobId: null, jobCancelled: false,
    history: [], historyIdx: -1, selectedLine: null,
    wavePeaks: null, audioBuf: null, vocalsAudioBuf: null,
    duration: 0, currentTime: 0, isPlaying: false,
    lrcHints: null,
    vocalsJobId: null, vocalsUrl: null, vocalsPeaks: null,
    useVocalsWave: false, useVocalsAudio: false,
  });
  ehUpdateVocalsBtns();
  const fi = ehEl('ehFileInfo'), dz = ehEl('ehDropZone'), fi2 = ehEl('ehFileInput');
  if (fi)  fi.classList.add('hidden');
  if (dz)  dz.classList.remove('hidden');
  if (fi2) fi2.value = '';
  const li = ehEl('ehLyricsInput');
  if (li) li.value = '';
  ehShowPhase('upload');
  updateEhButtons();
}

// ─── Timeline click to seek ───────────────────────────────────────────────────
function ehTimelineClick(e) {
  if (EH.drag) return;
  const inner = ehEl('ehTlInner');
  if (!inner) return;
  const rect = inner.getBoundingClientRect();
  const x = e.clientX - rect.left;
  if (ehAudio) ehAudio.currentTime = Math.max(0, Math.min(EH.duration, x / EH.pps));
}

// ─── Export ───────────────────────────────────────────────────────────────────
async function ehExport(download) {
  try {
    const r = await fetch('/api/export_enhanced', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        segments: EH.segments,
        title:    ehEl('ehTitleInput')?.value?.trim() || '',
        artist:   ehEl('ehArtistInput')?.value?.trim() || '',
        mode:     EH.submode,
      }),
    });
    if (!r.ok) { toast('Export failed.', 'error'); return; }
    const blob = await r.blob();
    const cd   = r.headers.get('Content-Disposition') || '';
    const filename = cd.match(/filename="(.+)"/)?.[1] || 'lyrics_enhanced.lrc';
    if (download) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast('Downloaded!', 'success');
    } else {
      const text = await blob.text();
      navigator.clipboard.writeText(text)
        .then(() => toast('Copied to clipboard!', 'success'))
        .catch(() => toast('Copy failed.', 'error'));
    }
  } catch (e) { toast('Export error: ' + e.message, 'error'); }
}

// ─── Add Line at playhead ─────────────────────────────────────────────────────
function ehAddLine() {
  ehPushHistory();
  const t = EH.currentTime;
  const dur = 3;
  const newSeg = {
    id:    Date.now(),
    start: parseFloat(t.toFixed(3)),
    end:   parseFloat(Math.min(t + dur, EH.duration || t + dur).toFixed(3)),
    text:  '',
    words: [],
  };
  EH.segments.push(newSeg);
  EH.segments.sort((a, b) => a.start - b.start);
  ehRenderLineBlocks();
  ehRenderWordChips();
  ehRenderSegList();
  ehRefreshUndoRedo();
  ehUpdatePreview();
  toast('Line added — double-click to edit.', '');
}

// ─── Sort segments ────────────────────────────────────────────────────────────
function ehSortSegs() {
  ehPushHistory();
  EH.segments.sort((a, b) => a.start - b.start);
  ehRenderLineBlocks();
  ehRenderWordChips();
  ehRenderSegList();
  ehRefreshUndoRedo();
  ehUpdatePreview();
  toast('Sorted by timestamp.', '');
}

// ─── Retry / re-transcribe ────────────────────────────────────────────────────
function ehRetranscribe() {
  if (EH.segments.length && !confirm('Go back to re-transcribe? The current segments will be reset.')) return;
  EH.segments   = [];
  EH.history    = [];
  EH.historyIdx = -1;
  if (ehAudio) { ehAudio.pause(); }
  ehShowPhase('upload');
  toast('Ready to re-transcribe.', '');
}

// ─── Generate LRC text client-side ───────────────────────────────────────────
function ehGenerateLrcText() {
  const title  = ehEl('ehTitleInput')?.value?.trim() || '';
  const artist = ehEl('ehArtistInput')?.value?.trim() || '';
  const lines  = [];
  if (title)  lines.push(`[ti:${title}]`);
  if (artist) lines.push(`[ar:${artist}]`);
  lines.push('[by:LRC Generator]');
  lines.push('[enhanced:true]');
  lines.push('');
  [...EH.segments].sort((a, b) => a.start - b.start).forEach(seg => {
    const lineTs = `[${ehFmt(seg.start)}]`;
    const words  = seg.words || [];
    if (words.length) {
      lines.push(lineTs + words.map(w => `<${ehFmt(w.start)}>${w.word}<${ehFmt(w.end)}>`).join(''));
    } else {
      lines.push(lineTs + (seg.text || '').trim());
    }
  });
  return lines.join('\n');
}

function ehUpdatePreview() {
  const pre = ehEl('ehLrcPreview');
  if (pre && !pre.classList.contains('hidden')) {
    pre.textContent = ehGenerateLrcText();
  }
}

// ─── Editor keyboard handler ──────────────────────────────────────────────────
function ehHandleKey(e) {
  const tag = document.activeElement?.tagName;
  if (['INPUT','TEXTAREA','SELECT'].includes(tag)) return;
  if (ehEl('ehEditorSection')?.classList.contains('hidden')) return;
  if (!ehEl('enhanced-root') || ehEl('enhanced-root').style.display === 'none') return;

  if (e.code === 'Space') {
    e.preventDefault(); ehTogglePlay();
  } else if (e.code === 'Enter') {
    e.preventDefault(); ehAddLine();
  } else if (e.code === 'ArrowLeft') {
    e.preventDefault(); ehSeek(e.shiftKey ? -10 : -2);
  } else if (e.code === 'ArrowRight') {
    e.preventDefault(); ehSeek(e.shiftKey ? 10 : 2);
  } else if (e.code === 'Equal' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault(); ehApplyZoom(EH.pps * 1.25);
  } else if (e.code === 'Minus' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault(); ehApplyZoom(EH.pps * 0.8);
  } else if (e.code === 'KeyZ' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    if (e.shiftKey) ehRedo(); else ehUndo();
  } else if (e.code === 'KeyY' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault(); ehRedo();
  }
}

// ─── Init — wire up all event listeners ──────────────────────────────────────
function initEnhanced() {
  // Mode tabs
  document.querySelectorAll('.mode-tab').forEach(btn =>
    btn.addEventListener('click', () => switchMode(btn.dataset.mode)));

  // Enhanced sub-tabs
  document.querySelectorAll('.en-subtab').forEach(btn =>
    btn.addEventListener('click', () => switchEnhancedMode(btn.dataset.submode)));

  // WhisperX "continue anyway"
  ehEl('ehContinueAnywayBtn')?.addEventListener('click', () =>
    ehEl('ehWhisperxWarn')?.classList.add('hidden'));

  // UVR toggle
  ehEl('ehUvrToggle')?.addEventListener('change', updateEhButtons);

  // Drop zone
  const dz = ehEl('ehDropZone');
  if (dz) {
    dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
    dz.addEventListener('drop', e => {
      e.preventDefault(); dz.classList.remove('drag-over');
      ehHandleFile(e.dataTransfer.files[0]);
    });
    dz.addEventListener('click', e => {
      if (e.target.id === 'ehBrowseBtn' || e.target.closest('#ehBrowseBtn')) return;
      ehEl('ehFileInput')?.click();
    });
  }
  ehEl('ehBrowseBtn')?.addEventListener('click', e => {
    e.stopPropagation(); ehEl('ehFileInput')?.click();
  });
  ehEl('ehFileInput')?.addEventListener('change', e => ehHandleFile(e.target.files[0]));
  ehEl('ehChangeFileBtn')?.addEventListener('click', () => {
    EH._pendingFile = null; EH.fileId = null; EH.lrcHints = null;
    ehEl('ehFileInfo')?.classList.add('hidden');
    ehEl('ehDropZone')?.classList.remove('hidden');
    ehEl('ehFileInput').value = '';
    updateEhButtons();
  });

  // Lyrics textarea — .lrc drop target
  const lrcWrap    = ehEl('ehLyricsDropWrap');
  const lrcOverlay = ehEl('ehLrcDropOverlay');
  if (lrcWrap) {
    lrcWrap.addEventListener('dragover', e => {
      const hasLrc = [...(e.dataTransfer.items || [])].some(
        i => i.kind === 'file' && (i.type === '' || i.getAsFile()?.name?.endsWith('.lrc'))
      );
      if (!hasLrc) return;
      e.preventDefault(); e.stopPropagation();
      lrcWrap.classList.add('drag-lrc');
      lrcOverlay?.classList.remove('hidden');
    });
    lrcWrap.addEventListener('dragleave', e => {
      if (lrcWrap.contains(e.relatedTarget)) return;
      lrcWrap.classList.remove('drag-lrc');
      lrcOverlay?.classList.add('hidden');
    });
    lrcWrap.addEventListener('drop', e => {
      lrcWrap.classList.remove('drag-lrc');
      lrcOverlay?.classList.add('hidden');
      const file = e.dataTransfer.files[0];
      if (!file) return;
      if (file.name.toLowerCase().endsWith('.lrc')) {
        e.preventDefault(); e.stopPropagation();
        ehHandleLrcDrop(file);
      }
    });
  }

  // Transcribe
  ehEl('ehTranscribeBtn')?.addEventListener('click', () => startEnhancedTranscription());

  // Tap Sync (upload → word tap)
  ehEl('ehTapSyncBtn')?.addEventListener('click', async () => {
    const raw = ehEl('ehLyricsInput')?.value?.trim() || '';
    if (!raw) { toast('Enter lyrics first.', 'error'); return; }
    ehEl('ehTapSyncBtn').disabled = true;
    try { await ehUploadFile(); }
    catch (e) { toast('Upload failed: ' + e.message, 'error'); ehEl('ehTapSyncBtn').disabled = false; return; }
    ehEl('ehTapSyncBtn').disabled = false;
    openWordTapSync();
  });

  // Cancel
  ehEl('ehCancelBtn')?.addEventListener('click', () => {
    EH.jobCancelled = true; ehShowPhase('upload');
  });

  // Vocals buttons
  ehEl('ehVocalsWaveBtn')?.addEventListener('click', ehToggleVocalsWave);
  ehEl('ehVocalsAudioBtn')?.addEventListener('click', ehToggleVocalsAudio);

  // New Song
  ehEl('ehNewSongBtn')?.addEventListener('click', ehNewSong);

  // Word tap from editor
  ehEl('ehWordTapBtn')?.addEventListener('click', () => {
    const raw = ehEl('ehLyricsInput')?.value?.trim() || '';
    if (raw) { openWordTapSync(); }
    else {
      ehEl('ehLyricsInput').value = EH.segments.map(s => s.text).join('\n');
      openWordTapSync();
    }
  });

  // Word tap cancel
  ehEl('wtCancelBtn')?.addEventListener('click', closeWordTapOverlay);

  // Word tap vocals
  ehEl('wtVocalsBtn')?.addEventListener('click', _wtToggleVocals);
  ehEl('wtIsolatingSkip')?.addEventListener('click', () => {
    EH.wtIsolating = false; // breaks the polling loop in _wtRunIsolation
    _wtIsolatingHide();
  });

  // Playback controls
  ehEl('ehPlayPauseBtn')?.addEventListener('click', ehTogglePlay);
  ehEl('ehSeekBackBtn')?.addEventListener('click', () => ehSeek(-5));
  ehEl('ehSeekFwdBtn')?.addEventListener('click',  () => ehSeek(+5));
  ehEl('ehVolumeSlider')?.addEventListener('input', e => {
    if (ehAudio) ehAudio.volume = +e.target.value;
    if (wtAudio) wtAudio.volume = +e.target.value;
  });

  // Zoom
  ehEl('ehZoomSlider')?.addEventListener('input', e => ehApplyZoom(+e.target.value));
  ehEl('ehZoomInBtn')?.addEventListener('click',  () => ehApplyZoom(EH.pps * 1.3));
  ehEl('ehZoomOutBtn')?.addEventListener('click', () => ehApplyZoom(EH.pps * 0.77));
  ehEl('ehScrollArea')?.addEventListener('wheel', e => {
    if (e.ctrlKey) { e.preventDefault(); ehApplyZoom(EH.pps * (e.deltaY < 0 ? 1.15 : 0.87)); }
  }, { passive: false });

  // Timeline seek
  ehEl('ehTlInner')?.addEventListener('click', ehTimelineClick);

  // Undo/Redo
  ehEl('ehUndoBtn')?.addEventListener('click', ehUndo);
  ehEl('ehRedoBtn')?.addEventListener('click', ehRedo);

  // Add Line / Sort / Retry
  ehEl('ehAddLineBtn')?.addEventListener('click', ehAddLine);
  ehEl('ehSortBtn')?.addEventListener('click', ehSortSegs);
  ehEl('ehRetryBtn')?.addEventListener('click', ehRetranscribe);

  // Export
  ehEl('ehExportBtn')?.addEventListener('click', () => ehExport(true));
  ehEl('ehCopyBtn')?.addEventListener('click',   () => ehExport(false));

  // Preview toggle
  ehEl('ehPreviewToggleBtn')?.addEventListener('click', () => {
    const pre = ehEl('ehLrcPreview');
    const btn = ehEl('ehPreviewToggleBtn');
    if (!pre || !btn) return;
    const hidden = pre.classList.toggle('hidden');
    btn.textContent = hidden ? '👁 Preview' : '✕ Preview';
    if (!hidden) pre.textContent = ehGenerateLrcText();
  });
  ehEl('ehTitleInput')?.addEventListener('input',  ehUpdatePreview);
  ehEl('ehArtistInput')?.addEventListener('input', ehUpdatePreview);

  // Global keyboard
  window.addEventListener('keydown', e => {
    if (!ehEl('wordTapOverlay')?.classList.contains('hidden')) {
      wtHandleKey(e); return;
    }
    ehHandleKey(e);
  });

  // Resize
  window.addEventListener('resize', () => {
    if (!ehEl('ehEditorSection')?.classList.contains('hidden')) ehResizeCanvases();
    if (!ehEl('wordTapOverlay')?.classList.contains('hidden'))  _wtInitCanvas();
  });
}

// Run after DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initEnhanced);
} else {
  initEnhanced();
}
