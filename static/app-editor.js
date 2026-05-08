'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// app-editor.js — Audio, timeline, waveform, segments, zoom, export, init
// Depends on: shared.js, app-state.js, app-upload.js
// ─────────────────────────────────────────────────────────────────────────────

var MAX_HISTORY = 80;

// ─── Undo / Redo ─────────────────────────────────────────────────────────────
function snapshotSegs() { return JSON.stringify(S.segments.map(s => ({ ...s }))); }

function pushHistory() {
  S.history.splice(S.historyIdx + 1);
  S.history.push(snapshotSegs());
  if (S.history.length > MAX_HISTORY) S.history.shift();
  S.historyIdx = S.history.length - 1;
  refreshUndoRedo();
}

function undo() {
  if (S.historyIdx <= 0) return;
  S.historyIdx--;
  S.segments = JSON.parse(S.history[S.historyIdx]);
  afterHistoryJump();
}

function redo() {
  if (S.historyIdx >= S.history.length - 1) return;
  S.historyIdx++;
  S.segments = JSON.parse(S.history[S.historyIdx]);
  afterHistoryJump();
}

function afterHistoryJump() {
  renderSegmentBlocks(); renderSegmentList(); updateLrcPreview(); refreshUndoRedo();
}

function refreshUndoRedo() {
  const u = $('undoBtn'), r = $('redoBtn');
  if (u) u.disabled = S.historyIdx <= 0;
  if (r) r.disabled = S.historyIdx >= S.history.length - 1;
}

// ─── Editor init ──────────────────────────────────────────────────────────────
function initEditor(segs) {
  S.segments   = segs.map(s => ({ id: uid(), start: s.start, end: s.end, text: s.text }));
  S.selectedId = null;
  S.history    = [];
  S.historyIdx = -1;
  S.vocalsAudioBuf   = null;
  S.vocalsWavePeaks  = null;
  S.useVocalsWaveform = false;
  pushHistory();
  showPhase('editor');
  initAudio(`/api/audio/${S.fileId}`);
  renderSegmentList();
  updateWaveVocalsBtn();
  if (S.vocalsJobId) decodeVocalsWaveform();
}

// ─── Audio (WaveSurfer) ───────────────────────────────────────────────────────
function initAudio(url) {
  if (ws) { ws.destroy(); ws = null; }
  ws = WaveSurfer.create({
    container:     '#wsHidden',
    waveColor:     '#0000',
    progressColor: '#0000',
    height:        1,
    interact:      false,
  });
  ws.load(url);
  ws.on('ready', () => {
    S.duration = ws.getDuration();
    el.durationDisplay.textContent = fmt(S.duration);
    initTimeline();
    decodeAudioForWaveform(url);
  });
  ws.on('timeupdate', t => {
    S.currentTime = t;
    el.currentTimeDisplay.textContent = fmt(t);
    drawWaveformFg();
    updatePlayhead();
    autoHighlightList();
  });
  ws.on('play',   () => setPlaying(true));
  ws.on('pause',  () => setPlaying(false));
  ws.on('finish', () => setPlaying(false));
  el.volumeSlider.addEventListener('input', () => ws?.setVolume(+el.volumeSlider.value));
}

function setPlaying(v) {
  S.isPlaying = v;
  el.iconPlay.classList.toggle('hidden', v);
  el.iconPause.classList.toggle('hidden', !v);
}

function seekTo(t) {
  if (!ws || !S.duration) return;
  t = clamp(t, 0, S.duration);
  if (typeof ws.setTime === 'function') ws.setTime(t);
  else ws.seekTo(t / S.duration);
}

// ─── Waveform decode ──────────────────────────────────────────────────────────
async function decodeAudioForWaveform(url) {
  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
    const resp = await fetch(url);
    const ab   = await resp.arrayBuffer();
    S.audioBuf = await ctx.decodeAudioData(ab);
    ctx.close();
    computeWaveformPeaks();
    drawWaveformBg();
    drawWaveformFg();
  } catch (e) { console.warn('Waveform decode failed:', e); }
}

function _computePeaks(buf) {
  if (!buf || !S.duration) return null;
  const totalPx = Math.ceil(S.duration * S.pps);
  const data    = buf.getChannelData(0);
  const sRate   = buf.sampleRate;
  const peaks   = new Float32Array(totalPx);
  for (let px = 0; px < totalPx; px++) {
    const iS = Math.floor((px / S.pps) * sRate);
    const iE = Math.min(Math.ceil(((px + 1) / S.pps) * sRate), data.length);
    let max = 0;
    for (let i = iS; i < iE; i++) { const v = Math.abs(data[i]); if (v > max) max = v; }
    peaks[px] = max;
  }
  return peaks;
}

function computeWaveformPeaks() {
  if (S.audioBuf)      S.waveformPeaks  = _computePeaks(S.audioBuf);
  if (S.vocalsAudioBuf) S.vocalsWavePeaks = _computePeaks(S.vocalsAudioBuf);
}

function _activePeaks() {
  return (S.useVocalsWaveform && S.vocalsWavePeaks) ? S.vocalsWavePeaks : S.waveformPeaks;
}

// ─── Vocals waveform ──────────────────────────────────────────────────────────
async function decodeVocalsWaveform() {
  if (!S.vocalsJobId) return;
  const url = `/api/vocals/${S.vocalsJobId}`;
  const btn = $('waveVocalsBtn');
  if (btn) btn.classList.add('loading');
  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('Vocals not available');
    const ab  = await resp.arrayBuffer();
    S.vocalsAudioBuf  = await ctx.decodeAudioData(ab);
    ctx.close();
    S.vocalsWavePeaks = _computePeaks(S.vocalsAudioBuf);
    if (btn) { btn.classList.remove('loading'); btn.classList.remove('hidden'); }
    if (S.useVocalsWaveform) { drawWaveformBg(); drawWaveformFg(); }
  } catch (e) {
    console.warn('Vocals waveform decode failed:', e);
    if (btn) btn.classList.remove('loading');
  }
}

async function setWaveVocalsMode(on) {
  const btn = $('waveVocalsBtn');
  if (on && !S.vocalsJobId) {
    if (!uvrAvailable || !S.fileId) return;
    if (btn) { btn.classList.add('loading'); btn.disabled = true; }
    try {
      const uvrModel = $('uvrModelSelect')?.value || 'UVR-MDX-NET-Inst_HQ_3';
      const form = new FormData();
      form.append('file_id',      S.fileId);
      form.append('uvr_model_id', uvrModel);
      const r = await fetch('/api/isolate', { method: 'POST', body: form });
      if (!r.ok) throw new Error('Isolation could not be started');
      const { job_id } = await r.json();
      while (true) {
        await sleep(1500);
        const job = await fetch(`/api/job/${job_id}`).then(r => r.json());
        if (btn) btn.title = `Vocals: ${job.progress || 0}%`;
        if (job.status === 'done') { S.vocalsJobId = job_id; break; }
        if (job.status === 'error') throw new Error(job.error || 'Error');
      }
    } catch (e) {
      if (btn) { btn.classList.remove('loading'); btn.disabled = false; }
      toast('Vocal isolation failed: ' + e.message, 'error');
      return;
    }
    if (btn) { btn.classList.remove('loading'); btn.disabled = false; }
  }
  if (on && !S.vocalsAudioBuf) decodeVocalsWaveform();
  S.useVocalsWaveform = on;
  if (btn) btn.classList.toggle('active', on);
  drawWaveformBg();
  drawWaveformFg();
}

function updateWaveVocalsBtn() {
  const btn = $('waveVocalsBtn');
  if (!btn) return;
  btn.classList.toggle('hidden', !uvrAvailable || !S.fileId);
  btn.classList.toggle('active', S.useVocalsWaveform && !!S.vocalsWavePeaks);
}

// ─── Timeline ─────────────────────────────────────────────────────────────────
function totalWidth() {
  return Math.max(Math.ceil(S.duration * S.pps), el.tlScrollArea.clientWidth);
}

function initTimeline() {
  layoutTimeline(); drawRuler(); drawWaveformBg(); drawWaveformFg();
  renderSegmentBlocks(); updatePlayhead();
}

function layoutTimeline() {
  const w = totalWidth();
  el.tlInner.style.width       = w + 'px';
  el.rulerCanvas.width         = w;
  el.waveCanvasBg.width        = w;
  el.waveCanvasFg.width        = w;
  el.waveCanvasBg.style.width  = w + 'px';
  el.waveCanvasFg.style.width  = w + 'px';
  el.rulerCanvas.style.width   = w + 'px';
}

// ─── Ruler ────────────────────────────────────────────────────────────────────
function drawRuler() {
  const canvas = el.rulerCanvas;
  const ctx    = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#1a1a2a';
  ctx.fillRect(0, 0, w, h);

  const minTickPx = 60;
  const intervals = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const interval  = intervals.find(iv => iv * S.pps >= minTickPx) || 300;

  ctx.font         = '10px JetBrains Mono, monospace';
  ctx.textBaseline = 'middle';

  for (let t = 0; t <= S.duration + interval; t += interval) {
    const x = Math.round(t * S.pps) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, h - 8); ctx.lineTo(x, h);
    ctx.strokeStyle = '#2e2e52'; ctx.stroke();
    if (t <= S.duration + interval * 0.5) {
      ctx.fillStyle = '#64748b';
      ctx.fillText(fmt(t), x + 3, h / 2);
    }
  }
  ctx.beginPath();
  ctx.moveTo(0, h - 0.5); ctx.lineTo(w, h - 0.5);
  ctx.strokeStyle = '#252540'; ctx.stroke();
}

// ─── Waveform canvases ────────────────────────────────────────────────────────
function drawWaveformBg() {
  const canvas = el.waveCanvasBg;
  const ctx    = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#0f0f1d';
  ctx.fillRect(0, 0, w, h);
  const peaks = _activePeaks();
  if (!peaks) return;
  const mid = h / 2;
  ctx.fillStyle = S.useVocalsWaveform ? '#166534' : '#2e2e5a';
  for (let x = 0; x < w && x < peaks.length; x++) {
    const amp = peaks[x] * mid * 0.95;
    ctx.fillRect(x, mid - amp, 1, amp * 2 || 1);
  }
}

function drawWaveformFg() {
  const canvas = el.waveCanvasFg;
  const ctx    = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const peaks = _activePeaks();
  if (!peaks || !S.duration) return;
  const fillW = Math.round((S.currentTime / S.duration) * w);
  if (fillW <= 0) return;
  const mid  = h / 2;
  const grad = ctx.createLinearGradient(0, 0, fillW, 0);
  if (S.useVocalsWaveform) {
    grad.addColorStop(0, '#15803d'); grad.addColorStop(1, '#16a34a');
  } else {
    grad.addColorStop(0, '#6d28d9'); grad.addColorStop(1, '#7c3aed');
  }
  ctx.fillStyle = grad;
  for (let x = 0; x < fillW && x < peaks.length; x++) {
    const amp = peaks[x] * mid * 0.95;
    ctx.fillRect(x, mid - amp, 1, amp * 2 || 1);
  }
}

// ─── Playhead ─────────────────────────────────────────────────────────────────
function updatePlayhead() {
  if (!S.duration) return;
  const x = S.currentTime * S.pps;
  el.tlPlayhead.style.left = x + 'px';
  if (S.isPlaying) {
    const sa = el.tlScrollArea;
    const vLeft = sa.scrollLeft, vRight = vLeft + sa.clientWidth;
    if (x < vLeft || x > vRight - 80) sa.scrollLeft = x - sa.clientWidth * 0.3;
  }
}

// ─── Segment blocks ───────────────────────────────────────────────────────────
function renderSegmentBlocks() {
  el.tlSegTrack.querySelectorAll('.seg-block').forEach(b => b.remove());
  S.segments.forEach(seg => {
    const block = document.createElement('div');
    block.className = 'seg-block' + (seg.id === S.selectedId ? ' selected' : '');
    block.dataset.id = seg.id;
    block.style.left  = (seg.start * S.pps) + 'px';
    block.style.width = Math.max((seg.end - seg.start) * S.pps, 8) + 'px';

    const label = document.createElement('div');
    label.className = 'seg-block-label';
    label.textContent = seg.text || '…';
    block.appendChild(label);

    const trimL = document.createElement('div');
    trimL.className = 'seg-trim seg-trim-l';
    trimL.dataset.role = 'trim-l';
    block.appendChild(trimL);

    const trimR = document.createElement('div');
    trimR.className = 'seg-trim seg-trim-r';
    trimR.dataset.role = 'trim-r';
    block.appendChild(trimR);

    block.addEventListener('dblclick', e => {
      e.stopPropagation();
      startInlineEdit(seg, block, label);
    });
    el.tlSegTrack.appendChild(block);
  });
}

function startInlineEdit(seg, block, label) {
  if (block.querySelector('.seg-inline-edit')) return;
  const inp = document.createElement('input');
  inp.className = 'seg-inline-edit';
  inp.value = seg.text;
  block.appendChild(inp);
  inp.focus(); inp.select();
  const commit = () => {
    seg.text = inp.value;
    label.textContent = inp.value || '…';
    inp.remove();
    renderSegmentList();
    updateLrcPreview();
    syncListRow(seg.id);
  };
  inp.addEventListener('blur', commit);
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
    if (e.key === 'Escape') { inp.value = seg.text; inp.blur(); }
    e.stopPropagation();
  });
}

function syncListRow(id) {
  const row = el.segmentsList.querySelector(`.segment-row[data-id="${id}"]`);
  if (!row) return;
  const seg = S.segments.find(s => s.id === id);
  if (!seg) return;
  row.querySelector('.text-input').value = seg.text;
}

// ─── Drag & trim ──────────────────────────────────────────────────────────────
function getClientX(e) { return e.touches ? e.touches[0].clientX : e.clientX; }

function onRulerDown(e) {
  e.preventDefault();
  const rect = el.tlScrollArea.getBoundingClientRect();
  const x    = getClientX(e) - rect.left + el.tlScrollArea.scrollLeft;
  seekTo(clamp(x / S.pps, 0, S.duration));
  document.body.style.cursor = 'col-resize';
  S.drag = { type: 'ruler', startX: getClientX(e) };
}

function onTrackDown(e) {
  const block = e.target.closest('.seg-block');
  if (!block) return;
  e.preventDefault(); e.stopPropagation();
  const id  = block.dataset.id;
  const seg = S.segments.find(s => s.id === id);
  if (!seg) return;
  S.selectedId = id;
  el.tlSegTrack.querySelectorAll('.seg-block').forEach(b =>
    b.classList.toggle('selected', b.dataset.id === id));
  highlightListRow(id);
  const role = e.target.dataset.role;
  const cx   = getClientX(e);
  if (role === 'trim-l') {
    S.drag = { type: 'trim-l', id, origStart: seg.start, origEnd: seg.end, startX: cx };
  } else if (role === 'trim-r') {
    S.drag = { type: 'trim-r', id, origStart: seg.start, origEnd: seg.end, startX: cx };
  } else {
    S.drag = { type: 'move',   id, origStart: seg.start, origEnd: seg.end, startX: cx };
  }
}

function onDragMove(e) {
  if (!S.drag) return;
  if (e.cancelable) e.preventDefault();
  const cx = getClientX(e);
  const dg = S.drag;

  if (dg.type === 'ruler') {
    const rect = el.tlScrollArea.getBoundingClientRect();
    const x    = cx - rect.left + el.tlScrollArea.scrollLeft;
    seekTo(clamp(x / S.pps, 0, S.duration));
    return;
  }

  const deltaSec = (cx - dg.startX) / S.pps;
  const seg = S.segments.find(s => s.id === dg.id);
  if (!seg) return;

  if (dg.type === 'move') {
    const dur = dg.origEnd - dg.origStart;
    const ns  = clamp(dg.origStart + deltaSec, 0, S.duration - dur);
    seg.start = parseFloat(ns.toFixed(3));
    seg.end   = parseFloat((ns + dur).toFixed(3));
  } else if (dg.type === 'trim-l') {
    seg.start = parseFloat(clamp(dg.origStart + deltaSec, 0, dg.origEnd - 0.1).toFixed(3));
  } else {
    seg.end = parseFloat(clamp(dg.origEnd + deltaSec, dg.origStart + 0.1, S.duration).toFixed(3));
  }

  const block = el.tlSegTrack.querySelector(`.seg-block[data-id="${dg.id}"]`);
  if (block) {
    block.style.left  = (seg.start * S.pps) + 'px';
    block.style.width = Math.max((seg.end - seg.start) * S.pps, 8) + 'px';
  }
  const row = el.segmentsList.querySelector(`.segment-row[data-id="${dg.id}"]`);
  if (row && document.activeElement !== row.querySelector('.time-input')) {
    row.querySelector('.time-input').value = fmt(seg.start);
  }
  updateLrcPreview();
}

function onDragEnd() {
  if (!S.drag) return;
  const wasSegOp = ['move','trim-l','trim-r'].includes(S.drag.type);
  S.drag = null;
  document.body.style.cursor = '';
  if (wasSegOp) pushHistory();
  renderSegmentList();
  updateLrcPreview();
}

// ─── Segment list ─────────────────────────────────────────────────────────────
function renderSegmentList() {
  const sorted = [...S.segments].sort((a, b) => a.start - b.start);
  el.segmentsList.innerHTML = '';
  sorted.forEach(seg => {
    const row = document.createElement('div');
    row.className = 'segment-row' + (seg.id === S.selectedId ? ' active' : '');
    row.dataset.id = seg.id;

    const timeInput = document.createElement('input');
    timeInput.type = 'text'; timeInput.className = 'time-input';
    timeInput.value = fmt(seg.start); timeInput.title = 'M:SS.ms';
    timeInput.addEventListener('focus', () => seekTo(seg.start));
    timeInput.addEventListener('change', () => {
      const t = parseTime(timeInput.value);
      if (!isNaN(t)) {
        pushHistory();
        const dur = seg.end - seg.start;
        seg.start = clamp(parseFloat(t.toFixed(3)), 0, S.duration);
        seg.end   = parseFloat(Math.min(seg.start + dur, S.duration).toFixed(3));
        timeInput.value = fmt(seg.start);
        renderSegmentBlocks(); updateLrcPreview();
      }
    });

    const textInput = document.createElement('input');
    textInput.type = 'text'; textInput.className = 'text-input';
    textInput.value = seg.text; textInput.placeholder = 'Lyrics…';
    let _textHistoryTimer;
    textInput.addEventListener('input', () => {
      seg.text = textInput.value;
      const block = el.tlSegTrack.querySelector(`.seg-block[data-id="${seg.id}"]`);
      if (block) block.querySelector('.seg-block-label').textContent = textInput.value || '…';
      updateLrcPreview();
      clearTimeout(_textHistoryTimer);
      _textHistoryTimer = setTimeout(pushHistory, 1200);
    });

    const actions = document.createElement('div');
    actions.className = 'row-actions';

    const playBtn = document.createElement('button');
    playBtn.className = 'btn-row-action play';
    playBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><path d="M8 5v14l11-7z"/></svg>`;
    playBtn.addEventListener('click', e => {
      e.stopPropagation();
      S.selectedId = seg.id;
      seekTo(seg.start);
      if (!S.isPlaying) ws?.play();
      highlightListRow(seg.id);
      el.tlSegTrack.querySelectorAll('.seg-block').forEach(b =>
        b.classList.toggle('selected', b.dataset.id === seg.id));
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'btn-row-action del';
    delBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    delBtn.addEventListener('click', e => {
      e.stopPropagation();
      pushHistory();
      S.segments = S.segments.filter(s => s.id !== seg.id);
      if (S.selectedId === seg.id) S.selectedId = null;
      renderSegmentBlocks(); renderSegmentList(); updateLrcPreview();
    });

    actions.appendChild(playBtn); actions.appendChild(delBtn);
    row.appendChild(timeInput); row.appendChild(textInput); row.appendChild(actions);

    row.addEventListener('click', e => {
      if (e.target === timeInput || e.target === textInput) return;
      S.selectedId = seg.id;
      seekTo(seg.start);
      highlightListRow(seg.id);
      el.tlSegTrack.querySelectorAll('.seg-block').forEach(b =>
        b.classList.toggle('selected', b.dataset.id === seg.id));
    });

    el.segmentsList.appendChild(row);
  });
}

function highlightListRow(id) {
  el.segmentsList.querySelectorAll('.segment-row').forEach(r =>
    r.classList.toggle('active', r.dataset.id === id));
  el.segmentsList.querySelector(`.segment-row[data-id="${id}"]`)
    ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function autoHighlightList() {
  if (!S.duration) return;
  const t = S.currentTime;
  let bestId = null, bestStart = -Infinity;
  for (const seg of S.segments) {
    if (seg.start <= t && seg.start > bestStart) { bestStart = seg.start; bestId = seg.id; }
  }
  if (bestId && bestId !== S._autoId) {
    S._autoId = bestId;
    if (!S.drag) {
      highlightListRow(bestId);
      el.tlSegTrack.querySelectorAll('.seg-block').forEach(b =>
        b.classList.toggle('selected', b.dataset.id === bestId));
    }
  }
}

// ─── Add segment ──────────────────────────────────────────────────────────────
function addSegmentNow() {
  pushHistory();
  const t = S.currentTime;
  const newSeg = {
    id:    uid(),
    start: parseFloat(t.toFixed(3)),
    end:   parseFloat(Math.min(t + 3, S.duration || t + 3).toFixed(3)),
    text:  '',
  };
  S.segments.push(newSeg);
  S.selectedId = newSeg.id;
  renderSegmentBlocks(); renderSegmentList(); updateLrcPreview();
  setTimeout(() => {
    el.tlScrollArea.scrollLeft = Math.max(0, newSeg.start * S.pps - 120);
    el.segmentsList.querySelector(`.segment-row[data-id="${newSeg.id}"]`)
      ?.querySelector('.text-input')?.focus();
  }, 40);
}

// ─── Zoom ─────────────────────────────────────────────────────────────────────
function applyZoom(newPps, focalTime) {
  const prevPps = S.pps;
  S.pps = clamp(Math.round(newPps), S.PPS_MIN, S.PPS_MAX);
  el.zoomSlider.value = S.pps;
  el.zoomLabel.textContent = Math.round((S.pps / 80) * 100) + '%';
  const sa    = el.tlScrollArea;
  const focal = focalTime ?? (sa.scrollLeft + sa.clientWidth / 2) / prevPps;
  if (S.audioBuf) computeWaveformPeaks();
  layoutTimeline(); drawRuler(); drawWaveformBg(); drawWaveformFg();
  renderSegmentBlocks(); updatePlayhead();
  sa.scrollLeft = Math.max(0, focal * S.pps - sa.clientWidth / 2);
}

// ─── LRC generation & export ──────────────────────────────────────────────────
function generateLRC() {
  const title  = el.titleInput.value.trim();
  const artist = el.artistInput.value.trim();
  const lines  = [];
  if (title)  lines.push(`[ti:${title}]`);
  if (artist) lines.push(`[ar:${artist}]`);
  lines.push('[by:LRC Generator]');
  lines.push('');
  [...S.segments].sort((a, b) => a.start - b.start).forEach(seg =>
    lines.push(`${fmtLRC(seg.start)}${seg.text.trim()}`));
  return lines.join('\n');
}

function updateLrcPreview() {
  if (!el.lrcPreview.classList.contains('hidden'))
    el.lrcPreview.textContent = generateLRC();
}

async function exportLRC() {
  const res = await fetch('/api/export', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      segments: S.segments,
      title:    el.titleInput.value.trim(),
      artist:   el.artistInput.value.trim(),
    }),
  });
  if (!res.ok) { toast('Export failed.', 'error'); return; }
  const blob = await res.blob();
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  const m = (res.headers.get('Content-Disposition') || '').match(/filename="(.+?)"/);
  a.download = m ? m[1] : 'lyrics.lrc';
  a.click();
  URL.revokeObjectURL(url);
  toast('LRC downloaded!', 'success');
}

// ─── Init — wire up all events ────────────────────────────────────────────────
function init() {
  // Drop zone
  el.dropZone.addEventListener('dragover', e => {
    e.preventDefault(); el.dropZone.classList.add('drag-over');
  });
  el.dropZone.addEventListener('dragleave', e => {
    // Only remove highlight when leaving the drop zone itself, not its children
    if (!el.dropZone.contains(e.relatedTarget)) el.dropZone.classList.remove('drag-over');
  });
  el.dropZone.addEventListener('drop', e => {
    e.preventDefault(); el.dropZone.classList.remove('drag-over');
    handleFile(e.dataTransfer.files[0]);
  });
  el.dropZone.addEventListener('click', e => {
    if (e.target === el.browseBtn || el.browseBtn.contains(e.target)) return;
    el.fileInput.click();
  });
  el.browseBtn.addEventListener('click', e => { e.stopPropagation(); el.fileInput.click(); });
  el.fileInput.addEventListener('change', () => handleFile(el.fileInput.files[0]));
  el.changeFileBtn.addEventListener('click', () => {
    S._pendingFile = null; S.fileId = null;
    el.fileInfo.classList.add('hidden');
    el.dropZone.classList.remove('hidden');
    el.transcribeBtn.disabled = true;
    if (el.tapSyncBtn) el.tapSyncBtn.disabled = true;
    el.fileInput.value = '';
  });

  // UVR availability check
  fetch('/api/uvr_available').then(r => r.json()).then(d => {
    uvrAvailable = d.available;
    const tapVocalsCard  = $('tapVocalsLyricsCard');
    const uvrInstallHint = $('uvrInstallHint');
    const uvrToggle      = $('uvrToggle');
    if (d.available) {
      if (tapVocalsCard) tapVocalsCard.style.display = '';
    } else {
      if (tapVocalsCard)  tapVocalsCard.style.display  = 'none';
      if (uvrInstallHint) uvrInstallHint.style.display = 'block';
      if (uvrToggle)      uvrToggle.disabled = true;
    }
  }).catch(() => {});

  const uvrToggle    = $('uvrToggle');
  const uvrModelWrap = $('uvrModelWrap');
  if (uvrToggle && uvrModelWrap) {
    uvrToggle.addEventListener('change', () =>
      uvrModelWrap.classList.toggle('active', uvrToggle.checked));
  }

  // Transcription
  el.transcribeBtn.addEventListener('click', () => startTranscription());
  el.cancelBtn?.addEventListener('click', () => {
    S.jobCancelled = true; showPhase('upload'); toast('Cancelled.');
  });
  el.retranscribeBtn?.addEventListener('click', () => {
    if (ws) { ws.destroy(); ws = null; }
    showPhase('upload');
    startTranscription(S.fileId);
  });

  // New Song
  $('newSongBtn')?.addEventListener('click', () => {
    if (S.segments && S.segments.length && !confirm('Discard current session and load a new song?')) return;
    if (ws) { try { ws.destroy(); } catch (_) {} ws = null; }
    Object.assign(S, {
      _pendingFile: null, fileId: null, filename: '',
      segments: [], selectedIdx: -1,
      vocalsJobId: null, vocalsAudioBuf: null, vocalsWavePeaks: null, useVocalsWaveform: false,
      jobCancelled: false,
    });
    S.history.length = 0; S.historyIdx = -1;
    refreshUndoRedo();
    el.fileInfo.classList.add('hidden');
    el.dropZone.classList.remove('hidden');
    el.transcribeBtn.disabled = true;
    if (el.tapSyncBtn)       el.tapSyncBtn.disabled = true;
    if (el.fileInput)        el.fileInput.value = '';
    if (el.lyricsInput)      el.lyricsInput.value = '';
    if (el.fileNameDisplay)  el.fileNameDisplay.textContent = '';
    const wvb = $('waveVocalsBtn'); if (wvb) wvb.classList.add('hidden');
    showPhase('upload');
    toast('Ready for a new song.', 'success');
  });

  // Tap Sync (upload → open)
  el.tapSyncBtn?.addEventListener('click', async () => {
    if (!S._pendingFile) { toast('Please select an audio file.', 'error'); return; }
    const lyrics = el.lyricsInput.value.trim().split('\n').map(l => l.trim()).filter(Boolean);
    if (!lyrics.length) { toast('Please enter lyrics.', 'error'); return; }
    if (!S.fileId) {
      el.tapSyncBtn.disabled = true;
      const origHTML = el.tapSyncBtn.innerHTML;
      el.tapSyncBtn.innerHTML = '<span class="spinner-ring" style="width:14px;height:14px;border-width:2px;margin-right:4px"></span>…';
      try {
        const form = new FormData();
        form.append('file', S._pendingFile);
        const r = await fetch('/api/upload', { method: 'POST', body: form });
        if (!r.ok) throw new Error((await r.json()).error || 'Upload failed');
        S.fileId = (await r.json()).file_id;
      } catch (e) {
        toast('Upload failed: ' + e.message, 'error');
        el.tapSyncBtn.innerHTML = origHTML;
        updateTapSyncBtn();
        return;
      }
      el.tapSyncBtn.innerHTML = origHTML;
      updateTapSyncBtn();
    }
    openTapSync('upload');
  });

  $('tapSyncEditorBtn')?.addEventListener('click', () => openTapSync('editor'));
  $('tapCancelBtn')?.addEventListener('click', () => { closeTapOverlay(); toast('Tap Sync cancelled.'); });
  $('tapFinishBtn')?.addEventListener('click', finishTapSync);
  $('tapVocalsBtn')?.addEventListener('click', toggleTapVocals);
  $('tapIsolatingSkip')?.addEventListener('click', () => {
    tapState.isolating = false;
    _tapIsolatingHide();
    const btn = $('tapVocalsBtn');
    if (btn) { btn.disabled = false; btn.classList.remove('loading'); btn.innerHTML = tapVocalsBtnHTML('Vocals'); }
  });
  $('waveVocalsBtn')?.addEventListener('click', () => setWaveVocalsMode(!S.useVocalsWaveform));

  // Lyrics input → update tap sync button
  el.lyricsInput.addEventListener('input', updateTapSyncBtn);

  // Transport
  el.playPauseBtn.addEventListener('click', () => ws?.playPause());
  el.seekBackBtn.addEventListener('click',  () => seekTo(S.currentTime - 5));
  el.seekFwdBtn.addEventListener('click',   () => seekTo(S.currentTime + 5));

  // Undo / Redo
  $('undoBtn').addEventListener('click', undo);
  $('redoBtn').addEventListener('click', redo);

  // Zoom
  el.zoomSlider.addEventListener('input', () => applyZoom(+el.zoomSlider.value));
  el.zoomInBtn.addEventListener('click',  () => applyZoom(S.pps * 1.3));
  el.zoomOutBtn.addEventListener('click', () => applyZoom(S.pps * 0.77));

  // Ctrl+wheel zoom
  el.tlScrollArea.addEventListener('wheel', e => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const rect  = el.tlScrollArea.getBoundingClientRect();
    const mouseX = e.clientX - rect.left + el.tlScrollArea.scrollLeft;
    applyZoom(S.pps * (e.deltaY < 0 ? 1.12 : 0.88), mouseX / S.pps);
  }, { passive: false });

  // Pinch-to-zoom
  var _pinchDist = null;
  el.tlScrollArea.addEventListener('touchstart', e => {
    if (e.touches.length === 2)
      _pinchDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX,
                              e.touches[0].clientY - e.touches[1].clientY);
  }, { passive: true });
  el.tlScrollArea.addEventListener('touchmove', e => {
    if (e.touches.length === 2 && _pinchDist) {
      const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX,
                           e.touches[0].clientY - e.touches[1].clientY);
      applyZoom(S.pps * (d / _pinchDist));
      _pinchDist = d;
      if (e.cancelable) e.preventDefault();
    }
  }, { passive: false });
  el.tlScrollArea.addEventListener('touchend', () => { _pinchDist = null; });

  // Track drag
  el.tlSegTrack.addEventListener('mousedown',  onTrackDown);
  el.tlSegTrack.addEventListener('touchstart', onTrackDown, { passive: false });
  el.rulerCanvas.addEventListener('mousedown',  onRulerDown);
  el.rulerCanvas.addEventListener('touchstart', onRulerDown, { passive: false });
  el.waveCanvasBg.addEventListener('mousedown',  onRulerDown);
  el.waveCanvasBg.addEventListener('touchstart', onRulerDown, { passive: false });
  el.waveCanvasFg.addEventListener('mousedown',  onRulerDown);
  el.waveCanvasFg.addEventListener('touchstart', onRulerDown, { passive: false });
  document.addEventListener('mousemove',  onDragMove);
  document.addEventListener('touchmove',  onDragMove, { passive: false });
  document.addEventListener('mouseup',    onDragEnd);
  document.addEventListener('touchend',   onDragEnd);

  // Click on empty track → seek + deselect
  el.tlScrollArea.addEventListener('click', e => {
    if (!e.target.closest('.seg-block')) {
      const rect = el.tlScrollArea.getBoundingClientRect();
      const x    = e.clientX - rect.left + el.tlScrollArea.scrollLeft;
      if (S.duration) seekTo(x / S.pps);
      S.selectedId = null;
      el.tlSegTrack.querySelectorAll('.seg-block').forEach(b => b.classList.remove('selected'));
      renderSegmentList();
    }
  });

  // Segments
  el.addSegmentBtn.addEventListener('click', addSegmentNow);
  el.sortBtn.addEventListener('click', () => {
    S.segments.sort((a, b) => a.start - b.start);
    renderSegmentBlocks(); renderSegmentList(); updateLrcPreview();
    toast('Sorted by timestamp.');
  });

  // Export
  el.exportBtn.addEventListener('click', exportLRC);
  el.copyLrcBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(generateLRC())
      .then(() => toast('Copied to clipboard!', 'success'))
      .catch(() => toast('Copy failed.', 'error'));
  });
  el.previewToggleBtn.addEventListener('click', () => {
    const hidden = el.lrcPreview.classList.toggle('hidden');
    el.previewToggleBtn.textContent = hidden ? '👁 Preview' : '✕ Preview';
    if (!hidden) el.lrcPreview.textContent = generateLRC();
  });
  el.titleInput.addEventListener('input',  updateLrcPreview);
  el.artistInput.addEventListener('input', updateLrcPreview);

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (tapState.active) {
      if (e.code === 'Space')     { e.preventDefault(); tapMark(); return; }
      if (e.code === 'Backspace') { e.preventDefault(); tapUndo(); return; }
      if (e.code === 'Escape')    { e.preventDefault(); closeTapOverlay(); toast('Tap Sync cancelled.'); return; }
      return;
    }
    if (el.editorSection.classList.contains('hidden')) return;
    if (isInput()) return;
    if (e.code === 'Space')      { e.preventDefault(); ws?.playPause(); }
    if (e.code === 'Enter')      { e.preventDefault(); addSegmentNow(); }
    if (e.code === 'ArrowLeft')  { e.preventDefault(); seekTo(S.currentTime - (e.shiftKey ? 10 : 2)); }
    if (e.code === 'ArrowRight') { e.preventDefault(); seekTo(S.currentTime + (e.shiftKey ? 10 : 2)); }
    if (e.code === 'Equal' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); applyZoom(S.pps * 1.25); }
    if (e.code === 'Minus' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); applyZoom(S.pps * 0.8);  }
    if ((e.code === 'Delete' || e.code === 'Backspace') && S.selectedId) {
      pushHistory();
      S.segments = S.segments.filter(s => s.id !== S.selectedId);
      S.selectedId = null;
      renderSegmentBlocks(); renderSegmentList(); updateLrcPreview();
    }
    if (e.code === 'KeyZ' && (e.ctrlKey || e.metaKey) && !e.shiftKey) { e.preventDefault(); undo(); }
    if ((e.code === 'KeyZ' && (e.ctrlKey || e.metaKey) && e.shiftKey) ||
        (e.code === 'KeyY' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); redo(); }
  });

  // Resize
  var resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!el.editorSection.classList.contains('hidden')) {
        layoutTimeline(); drawRuler(); drawWaveformBg(); drawWaveformFg();
        renderSegmentBlocks(); updatePlayhead();
      }
      if (tapState.active) initTapWaveCanvas();
    }, 120);
  });
}

init();
