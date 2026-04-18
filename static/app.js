'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────
const S = {
  fileId:       null,
  filename:     null,
  duration:     0,
  currentTime:  0,
  isPlaying:    false,
  segments:     [],        // { id, start, end, text }
  selectedId:   null,
  jobCancelled: false,

  // zoom: pixels per second
  pps:          80,        // default ~80 px/s
  PPS_MIN:      15,
  PPS_MAX:      600,

  // drag / trim
  drag: null,
  /*  drag = {
        type: 'move' | 'trim-l' | 'trim-r' | 'ruler',
        id,
        startX, startTime,          (for move / ruler)
        origStart, origEnd,         (for trim)
        scrollLeft,
      }
  */

  // decoded audio for canvas waveform
  audioBuf:      null,
  waveformPeaks: null,     // Float32Array, one value per px column (at pps)

  // vocals waveform (available after UVR isolation)
  vocalsJobId:       null,   // job_id whose /api/vocals/ endpoint serves the file
  vocalsAudioBuf:    null,
  vocalsWavePeaks:   null,
  useVocalsWaveform: false,

  // undo / redo
  history: [],             // array of JSON snapshots
  historyIdx: -1,
};

// ─────────────────────────────────────────────────────────────────────────────
// WaveSurfer (audio engine only, hidden)
// ─────────────────────────────────────────────────────────────────────────────
let ws = null;

// ─────────────────────────────────────────────────────────────────────────────
// DOM
// ─────────────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const el = {
  uploadSection:      $('uploadSection'),
  progressSection:    $('progressSection'),
  editorSection:      $('editorSection'),
  dropZone:           $('dropZone'),
  fileInput:          $('fileInput'),
  browseBtn:          $('browseBtn'),
  fileInfo:           $('fileInfo'),
  fileNameDisplay:    $('fileNameDisplay'),
  changeFileBtn:      $('changeFileBtn'),
  lyricsInput:        $('lyricsInput'),
  transcribeBtn:      $('transcribeBtn'),
  modelSelect:        $('modelSelect'),
  langSelect:         $('langSelect'),
  progressLabel:      $('progressLabel'),
  progressBar:        $('progressBar'),
  cancelBtn:          $('cancelBtn'),
  // timeline
  tlScrollArea:       $('tlScrollArea'),
  tlInner:            $('tlInner'),
  rulerCanvas:        $('rulerCanvas'),
  waveCanvasBg:       $('waveCanvasBg'),
  waveCanvasFg:       $('waveCanvasFg'),
  tlSegTrack:         $('tlSegTrack'),
  tlPlayhead:         $('tlPlayhead'),
  // controls
  playPauseBtn:       $('playPauseBtn'),
  iconPlay:           $('iconPlay'),
  iconPause:          $('iconPause'),
  seekBackBtn:        $('seekBackBtn'),
  seekFwdBtn:         $('seekFwdBtn'),
  currentTimeDisplay: $('currentTimeDisplay'),
  durationDisplay:    $('durationDisplay'),
  volumeSlider:       $('volumeSlider'),
  zoomSlider:         $('zoomSlider'),
  zoomInBtn:          $('zoomInBtn'),
  zoomOutBtn:         $('zoomOutBtn'),
  zoomLabel:          $('zoomLabel'),
  addSegmentBtn:      $('addSegmentBtn'),
  sortBtn:            $('sortBtn'),
  retranscribeBtn:    $('retranscribeBtn'),
  // list
  segmentsList:       $('segmentsList'),
  // export
  titleInput:         $('titleInput'),
  artistInput:        $('artistInput'),
  exportBtn:          $('exportBtn'),
  copyLrcBtn:         $('copyLrcBtn'),
  previewToggleBtn:   $('previewToggleBtn'),
  lrcPreview:         $('lrcPreview'),
  toast:              $('toast'),
  // tap sync
  tapSyncBtn:         $('tapSyncBtn'),
  tapSyncOverlay:     $('tapSyncOverlay'),
};

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────
const clamp  = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const fmt    = s => { s = Math.max(0, s); const m = Math.floor(s/60); return `${m}:${(s%60).toFixed(2).padStart(5,'0')}`; };
const fmtLRC = s => { s = Math.max(0, s); const m = Math.floor(s/60); return `[${String(m).padStart(2,'0')}:${(s%60).toFixed(2).padStart(5,'0')}]`; };
const uid    = () => Math.random().toString(36).slice(2);

let toastT = null;
function toast(msg, type='') {
  el.toast.textContent = msg;
  el.toast.className = `toast${type ? ' '+type : ''}`;
  clearTimeout(toastT);
  toastT = setTimeout(() => el.toast.className = 'toast hidden', 2800);
}

function isInput() {
  const t = document.activeElement?.tagName;
  return t === 'INPUT' || t === 'TEXTAREA';
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase switching
// ─────────────────────────────────────────────────────────────────────────────
function showPhase(phase) {
  el.uploadSection.classList.toggle('hidden', phase !== 'upload');
  el.progressSection.classList.toggle('hidden', phase !== 'progress');
  el.editorSection.classList.toggle('hidden', phase !== 'editor');
  document.body.classList.toggle('editor-active', phase === 'editor');
}

// ─────────────────────────────────────────────────────────────────────────────
// File handling
// ─────────────────────────────────────────────────────────────────────────────
function handleFile(file) {
  if (!file) return;
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['mp3','flac','wav','m4a','ogg','opus','aac'].includes(ext)) {
    toast('Format nicht unterstützt.', 'error'); return;
  }
  S.filename = file.name;
  el.fileNameDisplay.textContent = file.name;
  el.fileInfo.classList.remove('hidden');
  el.dropZone.classList.add('hidden');
  el.transcribeBtn.disabled = false;
  S._pendingFile = file;
  updateTapSyncBtn();
}

function updateTapSyncBtn() {
  if (el.tapSyncBtn) {
    el.tapSyncBtn.disabled = !(S._pendingFile && el.lyricsInput.value.trim().length > 0);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Upload & Transcribe
// ─────────────────────────────────────────────────────────────────────────────
async function startTranscription(reuseFileId = null) {
  S.jobCancelled = false;
  const useUVR   = $('uvrToggle')?.checked ?? false;
  const uvrModel = $('uvrModelSelect')?.value ?? 'UVR-MDX-NET-Inst_HQ_3';

  // Clear stale vocals state when not using UVR this run
  if (!useUVR) {
    S.vocalsJobId = null; S.vocalsAudioBuf = null;
    S.vocalsWavePeaks = null; S.useVocalsWaveform = false;
  }

  showPhase('progress');
  setProgressStep(useUVR ? 'separate' : 'whisper');
  setProgress(8, 'Lade Datei hoch…');

  try {
    if (!reuseFileId) {
      const form = new FormData();
      form.append('file', S._pendingFile);
      const r = await fetch('/api/upload', { method:'POST', body:form });
      if (!r.ok) throw new Error((await r.json()).error || 'Upload fehlgeschlagen');
      S.fileId = (await r.json()).file_id;
    }

    setProgress(22, 'Starte Job…');

    const tf = new FormData();
    tf.append('file_id',          S.fileId);
    tf.append('model_name',       el.modelSelect.value);
    tf.append('language',         el.langSelect.value);
    tf.append('lyrics',           el.lyricsInput.value);
    tf.append('vocal_isolation',  useUVR ? 'true' : 'false');
    tf.append('uvr_model_id',     uvrModel);

    const r2 = await fetch('/api/transcribe', { method:'POST', body:tf });
    if (!r2.ok) throw new Error((await r2.json()).error);
    const { job_id } = await r2.json();
    await pollJob(job_id, useUVR);
  } catch(e) {
    if (!S.jobCancelled) { showPhase('upload'); toast(e.message, 'error'); }
  }
}

// ── Progress helpers ──────────────────────────────────────────
function setProgress(pct, msg) {
  el.progressBar.style.width  = pct + '%';
  el.progressLabel.textContent = msg;
}

function setProgressStep(active /* 'separate' | 'whisper' */) {
  const stepsEl = $('progressSteps');
  if (!stepsEl) return;

  const useUVR = $('uvrToggle')?.checked ?? false;
  stepsEl.style.display = useUVR ? 'flex' : 'none';
  if (!useUVR) return;

  const sep = $('stepSeparate');
  const whi = $('stepWhisper');
  if (!sep || !whi) return;

  sep.className = 'progress-step' + (active === 'separate' ? ' active' : ' done');
  whi.className = 'progress-step' + (active === 'whisper'  ? ' active' : '');
}

async function pollJob(jobId, useUVR = false) {
  const delays = [800, 1000, 1500, 2000];
  let i = 0;

  // Progress map: status → [pct, step]
  const statusMap = {
    'separating_model': [28, 'separate'],
    'separating':       [40, 'separate'],
    'loading_model':    [55, 'whisper'],
    'transcribing':     [72, 'whisper'],
  };

  while (!S.jobCancelled) {
    await sleep(delays[Math.min(i++, delays.length - 1)]);
    if (S.jobCancelled) break;

    const r = await fetch(`/api/job/${jobId}`);
    if (!r.ok) { toast('Fehler beim Abfragen.', 'error'); return; }
    const job = await r.json();

    el.progressLabel.textContent = job.message || '…';

    if (statusMap[job.status]) {
      const [pct, step] = statusMap[job.status];
      el.progressBar.style.width = pct + '%';
      setProgressStep(step);
    }
    if (typeof job.progress === 'number' && job.progress > 0) {
      el.progressBar.style.width = job.progress + '%';
    }

    if (job.status === 'done') {
      setProgress(100, 'Fertig!');
      setProgressStep('whisper'); // both done
      // If UVR was used and the job has a vocals file, expose the timeline waveform toggle
      if (useUVR && job.vocals_path) S.vocalsJobId = jobId;
      await sleep(300);
      initEditor(job.result.segments);
      return;
    }
    if (job.status === 'error') {
      showPhase('upload');
      toast(job.error, 'error');
      return;
    }
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// Undo / Redo
// ─────────────────────────────────────────────────────────────────────────────
const MAX_HISTORY = 80;

function snapshotSegs() {
  return JSON.stringify(S.segments.map(s => ({ ...s })));
}

function pushHistory() {
  // drop any redo states ahead of current index
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
  renderSegmentBlocks();
  renderSegmentList();
  updateLrcPreview();
  refreshUndoRedo();
}

function refreshUndoRedo() {
  const undoBtn = $('undoBtn');
  const redoBtn = $('redoBtn');
  if (undoBtn) undoBtn.disabled = S.historyIdx <= 0;
  if (redoBtn) redoBtn.disabled = S.historyIdx >= S.history.length - 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Editor init
// ─────────────────────────────────────────────────────────────────────────────
function initEditor(segs) {
  S.segments   = segs.map(s => ({ id: uid(), start: s.start, end: s.end, text: s.text }));
  S.selectedId = null;
  S.history    = [];
  S.historyIdx = -1;
  // Reset vocals waveform (audio may have changed) but keep vocalsJobId
  S.vocalsAudioBuf   = null;
  S.vocalsWavePeaks  = null;
  S.useVocalsWaveform = false;
  pushHistory();
  showPhase('editor');
  initAudio(`/api/audio/${S.fileId}`);
  renderSegmentList();
  updateWaveVocalsBtn();
  // Pre-decode vocals waveform in the background if available
  if (S.vocalsJobId) decodeVocalsWaveform();
}

// ─────────────────────────────────────────────────────────────────────────────
// Audio  (WaveSurfer for playback + Web Audio for waveform peaks)
// ─────────────────────────────────────────────────────────────────────────────
function initAudio(url) {
  if (ws) { ws.destroy(); ws = null; }

  ws = WaveSurfer.create({
    container:      '#wsHidden',
    waveColor:      '#0000',
    progressColor:  '#0000',
    height:         1,
    interact:       false,
  });
  ws.load(url);
  ws.on('ready', () => {
    S.duration = ws.getDuration();
    el.durationDisplay.textContent = fmt(S.duration);
    initTimeline();
    // Decode audio for canvas waveform
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

// ─────────────────────────────────────────────────────────────────────────────
// Web Audio waveform decode
// ─────────────────────────────────────────────────────────────────────────────
async function decodeAudioForWaveform(url) {
  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
    const resp = await fetch(url);
    const ab   = await resp.arrayBuffer();
    S.audioBuf = await ctx.decodeAudioData(ab);
    computeWaveformPeaks();
    drawWaveformBg();
    drawWaveformFg();
  } catch(e) {
    console.warn('Waveform decode failed:', e);
  }
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

async function decodeVocalsWaveform() {
  if (!S.vocalsJobId) return;
  const url = `/api/vocals/${S.vocalsJobId}`;
  const btn = $('waveVocalsBtn');
  if (btn) btn.classList.add('loading');
  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('Vocals nicht verfügbar');
    const ab   = await resp.arrayBuffer();
    S.vocalsAudioBuf  = await ctx.decodeAudioData(ab);
    ctx.close();
    S.vocalsWavePeaks = _computePeaks(S.vocalsAudioBuf);
    if (btn) { btn.classList.remove('loading'); btn.classList.remove('hidden'); }
    // If already in vocals mode, redraw
    if (S.useVocalsWaveform) { drawWaveformBg(); drawWaveformFg(); }
  } catch (e) {
    console.warn('Vocals waveform decode failed:', e);
    if (btn) btn.classList.remove('loading');
  }
}

function setWaveVocalsMode(on) {
  if (on && !S.vocalsAudioBuf) {
    // Trigger decode first; will redraw when done
    decodeVocalsWaveform();
  }
  S.useVocalsWaveform = on;
  const btn = $('waveVocalsBtn');
  if (btn) btn.classList.toggle('active', on);
  drawWaveformBg();
  drawWaveformFg();
}

function updateWaveVocalsBtn() {
  const btn = $('waveVocalsBtn');
  if (!btn) return;
  btn.classList.toggle('hidden', !S.vocalsJobId);
  btn.classList.toggle('active', S.useVocalsWaveform && !!S.vocalsWavePeaks);
}

// ─────────────────────────────────────────────────────────────────────────────
// Timeline init & layout
// ─────────────────────────────────────────────────────────────────────────────
function totalWidth() {
  return Math.max(Math.ceil(S.duration * S.pps), el.tlScrollArea.clientWidth);
}

function initTimeline() {
  layoutTimeline();
  drawRuler();
  drawWaveformBg();
  drawWaveformFg();
  renderSegmentBlocks();
  updatePlayhead();
}

function layoutTimeline() {
  const w = totalWidth();
  el.tlInner.style.width = w + 'px';
  el.rulerCanvas.width   = w;
  el.waveCanvasBg.width  = w;
  el.waveCanvasFg.width  = w;
  el.waveCanvasBg.style.width = w + 'px';
  el.waveCanvasFg.style.width = w + 'px';
  el.rulerCanvas.style.width  = w + 'px';
}

// ─────────────────────────────────────────────────────────────────────────────
// Ruler
// ─────────────────────────────────────────────────────────────────────────────
function drawRuler() {
  const canvas = el.rulerCanvas;
  const ctx    = canvas.getContext('2d');
  const w      = canvas.width, h = canvas.height;
  const dpr    = window.devicePixelRatio || 1;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#1a1a2a';
  ctx.fillRect(0, 0, w, h);

  // Choose tick spacing
  const minTickPx = 60;
  const intervals = [0.1,0.25,0.5,1,2,5,10,15,30,60,120,300];
  let interval = intervals.find(iv => iv * S.pps >= minTickPx) || 300;

  ctx.strokeStyle = '#2e2e52';
  ctx.fillStyle   = '#64748b';
  ctx.font        = `10px JetBrains Mono, monospace`;
  ctx.textBaseline = 'middle';

  for (let t = 0; t <= S.duration + interval; t += interval) {
    const x = Math.round(t * S.pps) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, h - 8); ctx.lineTo(x, h);
    ctx.strokeStyle = '#2e2e52';
    ctx.stroke();

    // Label
    if (t <= S.duration + interval*0.5) {
      ctx.fillStyle = '#64748b';
      ctx.fillText(fmt(t), x + 3, h/2);
    }
  }

  // Bottom line
  ctx.beginPath();
  ctx.moveTo(0, h-0.5); ctx.lineTo(w, h-0.5);
  ctx.strokeStyle = '#252540';
  ctx.stroke();
}

// ─────────────────────────────────────────────────────────────────────────────
// Waveform canvas
// ─────────────────────────────────────────────────────────────────────────────
function drawWaveformBg() {
  const canvas = el.waveCanvasBg;
  const ctx    = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;

  ctx.clearRect(0,0,w,h);
  ctx.fillStyle = '#0f0f1d';
  ctx.fillRect(0,0,w,h);

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

  ctx.clearRect(0,0,w,h);
  const peaks = _activePeaks();
  if (!peaks || !S.duration) return;

  const progress = S.currentTime / S.duration;
  const fillW    = Math.round(progress * w);
  if (fillW <= 0) return;

  const mid = h / 2;

  // Gradient: accent color (purple for original, green for vocals)
  const grad = ctx.createLinearGradient(0, 0, fillW, 0);
  if (S.useVocalsWaveform) {
    grad.addColorStop(0, '#15803d');
    grad.addColorStop(1, '#16a34a');
  } else {
    grad.addColorStop(0, '#6d28d9');
    grad.addColorStop(1, '#7c3aed');
  }
  ctx.fillStyle = grad;

  for (let x = 0; x < fillW && x < peaks.length; x++) {
    const amp = peaks[x] * mid * 0.95;
    ctx.fillRect(x, mid - amp, 1, amp * 2 || 1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Playhead
// ─────────────────────────────────────────────────────────────────────────────
function updatePlayhead() {
  if (!S.duration) return;
  const x = S.currentTime * S.pps;
  el.tlPlayhead.style.left = x + 'px';

  // Auto-scroll to keep playhead visible
  if (S.isPlaying) {
    const sa    = el.tlScrollArea;
    const vLeft = sa.scrollLeft;
    const vRight= vLeft + sa.clientWidth;
    if (x < vLeft || x > vRight - 80) {
      sa.scrollLeft = x - sa.clientWidth * 0.3;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Segment blocks (Timeline track)
// ─────────────────────────────────────────────────────────────────────────────
function renderSegmentBlocks() {
  // Remove existing blocks
  el.tlSegTrack.querySelectorAll('.seg-block').forEach(b => b.remove());

  S.segments.forEach(seg => {
    const block = document.createElement('div');
    block.className = 'seg-block' + (seg.id === S.selectedId ? ' selected' : '');
    block.dataset.id = seg.id;

    const x = seg.start * S.pps;
    const w = Math.max((seg.end - seg.start) * S.pps, 8);
    block.style.left  = x + 'px';
    block.style.width = w + 'px';

    // Label
    const label = document.createElement('div');
    label.className = 'seg-block-label';
    label.textContent = seg.text || '…';
    block.appendChild(label);

    // Trim handle left
    const trimL = document.createElement('div');
    trimL.className = 'seg-trim seg-trim-l';
    trimL.dataset.role = 'trim-l';
    block.appendChild(trimL);

    // Trim handle right
    const trimR = document.createElement('div');
    trimR.className = 'seg-trim seg-trim-r';
    trimR.dataset.role = 'trim-r';
    block.appendChild(trimR);

    // Double-click → inline edit label
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
  inp.focus();
  inp.select();

  const commit = () => {
    seg.text = inp.value;
    label.textContent = inp.value || '…';
    inp.remove();
    renderSegmentList();
    updateLrcPreview();
    // update list row
    syncListRow(seg.id);
  };
  inp.addEventListener('blur',   commit);
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

// ─────────────────────────────────────────────────────────────────────────────
// Drag & trim  (mouse + touch)
// ─────────────────────────────────────────────────────────────────────────────
function getClientX(e) { return e.touches ? e.touches[0].clientX : e.clientX; }

el.tlSegTrack.addEventListener('mousedown',  onTrackDown);
el.tlSegTrack.addEventListener('touchstart', onTrackDown, { passive:false });

el.rulerCanvas.addEventListener('mousedown',  onRulerDown);
el.rulerCanvas.addEventListener('touchstart', onRulerDown, { passive:false });

// Waveform canvas: click + scrub to seek
el.waveCanvasBg.addEventListener('mousedown',  onRulerDown);
el.waveCanvasBg.addEventListener('touchstart', onRulerDown, { passive:false });
el.waveCanvasFg.addEventListener('mousedown',  onRulerDown);
el.waveCanvasFg.addEventListener('touchstart', onRulerDown, { passive:false });

el.tlScrollArea.addEventListener('click', e => {
  // click on empty track area → seek + deselect
  if (!e.target.closest('.seg-block')) {
    const rect = el.tlScrollArea.getBoundingClientRect();
    const x    = e.clientX - rect.left + el.tlScrollArea.scrollLeft;
    if (S.duration) seekTo(x / S.pps);
    S.selectedId = null;
    el.tlSegTrack.querySelectorAll('.seg-block').forEach(b => b.classList.remove('selected'));
    renderSegmentList();
  }
});

function onRulerDown(e) {
  e.preventDefault();
  // Use the scroll area as reference for x-position (works for ruler + waveform)
  const rect = el.tlScrollArea.getBoundingClientRect();
  const x    = getClientX(e) - rect.left + el.tlScrollArea.scrollLeft;
  const t    = clamp(x / S.pps, 0, S.duration);
  seekTo(t);
  document.body.style.cursor = 'col-resize';
  S.drag = { type:'ruler', startX: getClientX(e) };
}

function onTrackDown(e) {
  const block = e.target.closest('.seg-block');
  if (!block) return;

  e.preventDefault();
  e.stopPropagation();

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
    S.drag = { type:'trim-l', id, origStart: seg.start, origEnd: seg.end, startX: cx, scrollLeft: el.tlScrollArea.scrollLeft };
  } else if (role === 'trim-r') {
    S.drag = { type:'trim-r', id, origStart: seg.start, origEnd: seg.end, startX: cx, scrollLeft: el.tlScrollArea.scrollLeft };
  } else {
    S.drag = { type:'move', id, origStart: seg.start, origEnd: seg.end, startX: cx, scrollLeft: el.tlScrollArea.scrollLeft };
  }
}

document.addEventListener('mousemove',  onDragMove);
document.addEventListener('touchmove',  onDragMove, { passive:false });
document.addEventListener('mouseup',    onDragEnd);
document.addEventListener('touchend',   onDragEnd);

function onDragMove(e) {
  if (!S.drag) return;
  if (e.cancelable) e.preventDefault();

  const cx    = getClientX(e);
  const dg    = S.drag;

  if (dg.type === 'ruler') {
    const rect = el.tlScrollArea.getBoundingClientRect();
    const x    = cx - rect.left + el.tlScrollArea.scrollLeft;
    seekTo(clamp(x / S.pps, 0, S.duration));
    return;
  }

  const deltaX    = cx - dg.startX;
  const deltaSec  = deltaX / S.pps;
  const seg = S.segments.find(s => s.id === dg.id);
  if (!seg) return;

  if (dg.type === 'move') {
    const dur  = dg.origEnd - dg.origStart;
    const ns   = clamp(dg.origStart + deltaSec, 0, S.duration - dur);
    seg.start  = parseFloat(ns.toFixed(3));
    seg.end    = parseFloat((ns + dur).toFixed(3));
  } else if (dg.type === 'trim-l') {
    seg.start = parseFloat(clamp(dg.origStart + deltaSec, 0, dg.origEnd - 0.1).toFixed(3));
  } else if (dg.type === 'trim-r') {
    seg.end   = parseFloat(clamp(dg.origEnd + deltaSec, dg.origStart + 0.1, S.duration).toFixed(3));
  }

  // Live update block position
  const block = el.tlSegTrack.querySelector(`.seg-block[data-id="${dg.id}"]`);
  if (block) {
    block.style.left  = (seg.start * S.pps) + 'px';
    block.style.width = Math.max((seg.end - seg.start) * S.pps, 8) + 'px';
  }

  // Update list row time input live
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

// ─────────────────────────────────────────────────────────────────────────────
// Segment list (bottom panel)
// ─────────────────────────────────────────────────────────────────────────────
function renderSegmentList() {
  const sorted = [...S.segments].sort((a,b) => a.start - b.start);

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
        renderSegmentBlocks();
        updateLrcPreview();
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
      // debounced history push (1.2 s after last keystroke)
      clearTimeout(_textHistoryTimer);
      _textHistoryTimer = setTimeout(pushHistory, 1200);
    });

    const actions = document.createElement('div');
    actions.className = 'row-actions';

    const playBtn = document.createElement('button');
    playBtn.className = 'btn-row-action play'; playBtn.title = 'Ab hier abspielen';
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
    delBtn.className = 'btn-row-action del'; delBtn.title = 'Löschen';
    delBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    delBtn.addEventListener('click', e => {
      e.stopPropagation();
      pushHistory();
      S.segments = S.segments.filter(s => s.id !== seg.id);
      if (S.selectedId === seg.id) S.selectedId = null;
      renderSegmentBlocks();
      renderSegmentList();
      updateLrcPreview();
    });

    actions.appendChild(playBtn);
    actions.appendChild(delBtn);
    row.appendChild(timeInput);
    row.appendChild(textInput);
    row.appendChild(actions);

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
  const active = el.segmentsList.querySelector(`.segment-row[data-id="${id}"]`);
  active?.scrollIntoView({ block:'nearest', behavior:'smooth' });
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

// ─────────────────────────────────────────────────────────────────────────────
// Add segment
// ─────────────────────────────────────────────────────────────────────────────
function addSegmentNow() {
  pushHistory();
  const t = S.currentTime;
  const defaultDur = 3;
  const newSeg = {
    id:    uid(),
    start: parseFloat(t.toFixed(3)),
    end:   parseFloat(Math.min(t + defaultDur, S.duration || t + defaultDur).toFixed(3)),
    text:  '',
  };
  S.segments.push(newSeg);
  S.selectedId = newSeg.id;
  renderSegmentBlocks();
  renderSegmentList();
  updateLrcPreview();

  // scroll block into view
  setTimeout(() => {
    el.tlScrollArea.scrollLeft = Math.max(0, newSeg.start * S.pps - 120);
    const row = el.segmentsList.querySelector(`.segment-row[data-id="${newSeg.id}"]`);
    row?.querySelector('.text-input')?.focus();
  }, 40);
}

// ─────────────────────────────────────────────────────────────────────────────
// Zoom
// ─────────────────────────────────────────────────────────────────────────────
function applyZoom(newPps, focalTime = null) {
  const prevPps = S.pps;
  S.pps = clamp(Math.round(newPps), S.PPS_MIN, S.PPS_MAX);

  // Update slider
  el.zoomSlider.value = S.pps;
  el.zoomLabel.textContent = Math.round((S.pps / 80) * 100) + '%';

  // Keep focal point stable in scroll position
  const sa = el.tlScrollArea;
  const focal = focalTime ?? (sa.scrollLeft + sa.clientWidth/2) / prevPps;
  const scrollTarget = focal * S.pps - sa.clientWidth/2;

  // Recompute peaks if needed
  if (S.audioBuf) {
    computeWaveformPeaks();
  }

  layoutTimeline();
  drawRuler();
  drawWaveformBg();
  drawWaveformFg();
  renderSegmentBlocks();
  updatePlayhead();

  sa.scrollLeft = Math.max(0, scrollTarget);
}

// Ctrl/Cmd + wheel zoom
el.tlScrollArea.addEventListener('wheel', e => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  const rect   = el.tlScrollArea.getBoundingClientRect();
  const mouseX = e.clientX - rect.left + el.tlScrollArea.scrollLeft;
  const focal  = mouseX / S.pps;
  const factor = e.deltaY < 0 ? 1.12 : 0.88;
  applyZoom(S.pps * factor, focal);
}, { passive: false });

// Pinch-to-zoom (touch)
let _pinchDist = null;
el.tlScrollArea.addEventListener('touchstart', e => {
  if (e.touches.length === 2) {
    _pinchDist = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
  }
}, { passive: true });
el.tlScrollArea.addEventListener('touchmove', e => {
  if (e.touches.length === 2 && _pinchDist) {
    const d = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
    applyZoom(S.pps * (d / _pinchDist));
    _pinchDist = d;
    if (e.cancelable) e.preventDefault();
  }
}, { passive: false });
el.tlScrollArea.addEventListener('touchend', () => { _pinchDist = null; });

// ─────────────────────────────────────────────────────────────────────────────
// LRC generation & export
// ─────────────────────────────────────────────────────────────────────────────
function generateLRC() {
  const title  = el.titleInput.value.trim();
  const artist = el.artistInput.value.trim();
  const lines  = [];
  if (title)  lines.push(`[ti:${title}]`);
  if (artist) lines.push(`[ar:${artist}]`);
  lines.push('[by:LRC Generator]');
  lines.push('');
  [...S.segments].sort((a,b) => a.start - b.start).forEach(seg => {
    lines.push(`${fmtLRC(seg.start)}${seg.text.trim()}`);
  });
  return lines.join('\n');
}

function updateLrcPreview() {
  if (!el.lrcPreview.classList.contains('hidden'))
    el.lrcPreview.textContent = generateLRC();
}

async function exportLRC() {
  const res = await fetch('/api/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      segments: S.segments,
      title:    el.titleInput.value.trim(),
      artist:   el.artistInput.value.trim(),
    }),
  });
  if (!res.ok) { toast('Export fehlgeschlagen.', 'error'); return; }
  const blob = await res.blob();
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  const cd = res.headers.get('Content-Disposition') || '';
  const m  = cd.match(/filename="(.+?)"/);
  a.download = m ? m[1] : 'lyrics.lrc';
  a.click();
  URL.revokeObjectURL(url);
  toast('LRC heruntergeladen!', 'success');
}

// ─────────────────────────────────────────────────────────────────────────────
// Keyboard shortcuts
// ─────────────────────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  // Tap sync mode takes full keyboard priority
  if (tapState.active) {
    if (e.code === 'Space')     { e.preventDefault(); tapMark(); return; }
    if (e.code === 'Backspace') { e.preventDefault(); tapUndo(); return; }
    if (e.code === 'Escape')    { e.preventDefault(); closeTapOverlay(); toast('Tap Sync abgebrochen.'); return; }
    return; // swallow all other keys in tap mode
  }

  if (el.editorSection.classList.contains('hidden')) return;
  if (isInput()) return;

  if (e.code === 'Space')      { e.preventDefault(); ws?.playPause(); }
  if (e.code === 'Enter')      { e.preventDefault(); addSegmentNow(); }
  if (e.code === 'ArrowLeft')  { e.preventDefault(); seekTo(S.currentTime - (e.shiftKey ? 10 : 2)); }
  if (e.code === 'ArrowRight') { e.preventDefault(); seekTo(S.currentTime + (e.shiftKey ? 10 : 2)); }
  if (e.code === 'Equal'   && (e.ctrlKey || e.metaKey)) { e.preventDefault(); applyZoom(S.pps * 1.25); }
  if (e.code === 'Minus'   && (e.ctrlKey || e.metaKey)) { e.preventDefault(); applyZoom(S.pps * 0.8);  }
  if (e.code === 'Delete'  || e.code === 'Backspace') {
    if (S.selectedId) {
      pushHistory();
      S.segments = S.segments.filter(s => s.id !== S.selectedId);
      S.selectedId = null;
      renderSegmentBlocks();
      renderSegmentList();
      updateLrcPreview();
    }
  }
  if (e.code === 'KeyZ' && (e.ctrlKey || e.metaKey) && !e.shiftKey) { e.preventDefault(); undo(); }
  if ((e.code === 'KeyZ' && (e.ctrlKey || e.metaKey) && e.shiftKey) ||
      (e.code === 'KeyY' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); redo(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper
// ─────────────────────────────────────────────────────────────────────────────
function parseTime(str) {
  str = str.trim();
  const parts = str.split(':');
  return parts.length === 2
    ? parseFloat(parts[0]) * 60 + parseFloat(parts[1])
    : parseFloat(parts[0]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Window resize
// ─────────────────────────────────────────────────────────────────────────────
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!el.editorSection.classList.contains('hidden')) {
      layoutTimeline();
      drawRuler();
      drawWaveformBg();
      drawWaveformFg();
      renderSegmentBlocks();
      updatePlayhead();
    }
  }, 120);
});

// ─────────────────────────────────────────────────────────────────────────────
// Tap Sync
// ─────────────────────────────────────────────────────────────────────────────
let tapAudio     = null;   // HTMLAudioElement for tap sync playback
let uvrAvailable = false;  // set during init() via /api/uvr_available
const TAP_PPS    = 80;     // pixels per second for the waveform strip

const tapState = {
  active:     false,
  lines:      [],    // string[] — lyric lines
  times:      [],    // number[] — times[i] = start of line i
  currentIdx: 0,     // = times.length; 0 = before first tap
  started:    false, // has first tap (= playback) happened
  rafId:      null,
  source:     'upload', // 'upload' | 'editor'
  // waveform
  wavePeaks:    null,  // Float32Array
  waveDuration: 0,
  // vocals isolation
  originalUrl:    null,
  vocalsUrl:      null,
  useVocals:      false,
  isolating:      false,
  isolationJobId: null,
};

// ── Audio helpers ─────────────────────────────────────────────
function _makeTapAudio(url) {
  if (tapAudio) { tapAudio.pause(); tapAudio.src = ''; }
  tapAudio = new Audio(url);
  tapAudio.preload = 'auto';
  tapAudio.addEventListener('ended', () => {
    if (tapState.active && tapState.times.length > 0) finishTapSync();
  });
  return tapAudio;
}

// ── Open ──────────────────────────────────────────────────────
function openTapSync(source) {
  let lines;

  if (source === 'upload') {
    lines = el.lyricsInput.value.trim().split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) { toast('Bitte Lyrics eingeben.', 'error'); return; }
    if (!S.fileId)     { toast('Kein Audio hochgeladen.', 'error'); return; }
  } else {
    if (!S.segments.length) { toast('Keine Segmente vorhanden.', 'error'); return; }
    if (!S.fileId)           { toast('Kein Audio geladen.', 'error'); return; }
    lines = [...S.segments].sort((a, b) => a.start - b.start).map(s => s.text);
    if (ws && S.isPlaying) ws.pause();
  }

  const audioUrl = `/api/audio/${S.fileId}`;
  _makeTapAudio(audioUrl);

  Object.assign(tapState, {
    active: true, lines, times: [],
    currentIdx: 0, started: false, source,
    wavePeaks: null, waveDuration: 0,
    originalUrl: audioUrl, vocalsUrl: null,
    useVocals: false, isolating: false, isolationJobId: null,
  });

  // Canvas size
  initTapWaveCanvas();

  // Vocals toggle visibility
  const vBtn = $('tapVocalsBtn');
  if (vBtn) {
    vBtn.style.display   = uvrAvailable ? 'inline-flex' : 'none';
    vBtn.className       = 'btn btn-ghost btn-sm tap-vocals-btn';
    vBtn.disabled        = false;
    vBtn.innerHTML       = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/></svg> Vocals`;
  }

  $('tapFinishBtn').disabled = true;
  renderTapLines();
  $('tapSyncOverlay').classList.remove('hidden');
  $('tapSyncOverlay').focus();

  if (tapState.rafId) cancelAnimationFrame(tapState.rafId);
  tapState.rafId = requestAnimationFrame(tapRAF);

  // Decode waveform in background
  decodeTapAudio(audioUrl);
}

// ── RAF loop ──────────────────────────────────────────────────
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

// ── Waveform canvas ───────────────────────────────────────────
function initTapWaveCanvas() {
  const canvas = $('tapWaveCanvas');
  if (!canvas) return;
  canvas.width  = canvas.parentElement ? canvas.parentElement.clientWidth : window.innerWidth;
  canvas.height = 64;
}

async function decodeTapAudio(url) {
  tapState.wavePeaks    = null;
  tapState.waveDuration = 0;
  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
    const resp = await fetch(url);
    const ab   = await resp.arrayBuffer();
    const buf  = await ctx.decodeAudioData(ab);
    ctx.close();

    const totalPx = Math.ceil(buf.duration * TAP_PPS);
    const data    = buf.getChannelData(0);
    const sRate   = buf.sampleRate;
    const peaks   = new Float32Array(totalPx);

    for (let px = 0; px < totalPx; px++) {
      const iStart = Math.floor((px / TAP_PPS) * sRate);
      const iEnd   = Math.min(Math.ceil(((px + 1) / TAP_PPS) * sRate), data.length);
      let max = 0;
      for (let i = iStart; i < iEnd; i++) { const v = Math.abs(data[i]); if (v > max) max = v; }
      peaks[px] = max;
    }
    tapState.wavePeaks    = peaks;
    tapState.waveDuration = buf.duration;
  } catch (e) {
    console.warn('Tap waveform decode failed:', e);
  }
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

  const playheadX = Math.floor(w * 0.3); // playhead fixed at 30% from left

  if (!tapState.wavePeaks) {
    // Waiting for decode — show static line + playhead
    ctx.fillStyle = 'rgba(255,255,255,.07)';
    ctx.fillRect(0, h / 2 - 1, w, 2);
    ctx.fillStyle = 'rgba(255,255,255,.7)';
    ctx.fillRect(playheadX, 0, 1, h);
    return;
  }

  const peaks      = tapState.wavePeaks;
  const timeOffset = t - playheadX / TAP_PPS; // time at x=0
  const mid        = h / 2;

  for (let px = 0; px < w; px++) {
    const sTime = timeOffset + px / TAP_PPS;
    if (sTime < 0 || sTime > dur) continue;
    const sPx = Math.floor(sTime * TAP_PPS);
    if (sPx >= peaks.length) continue;
    const amp = peaks[sPx] * mid * 0.92;
    ctx.fillStyle = px < playheadX ? '#7c3aed' : '#22224a';
    ctx.fillRect(px, mid - amp, 1, amp * 2 || 1);
  }

  // Playhead line
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(playheadX, 0, 1, h);
  // Playhead triangle
  ctx.beginPath();
  ctx.moveTo(playheadX - 5, 0);
  ctx.lineTo(playheadX + 6, 0);
  ctx.lineTo(playheadX + 0.5, 8);
  ctx.fillStyle = '#f8fafc';
  ctx.fill();

  // Tap markers — green lines with line number
  tapState.times.forEach((tapTime, i) => {
    const mx = Math.round(playheadX + (tapTime - t) * TAP_PPS);
    if (mx < 0 || mx > w) return;
    ctx.strokeStyle = 'rgba(16,185,129,.72)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(mx + .5, 0); ctx.lineTo(mx + .5, h); ctx.stroke();
    if (mx > 2 && mx < w - 14) {
      ctx.fillStyle = 'rgba(16,185,129,.85)';
      ctx.font = '9px JetBrains Mono, monospace';
      ctx.fillText(String(i + 1), mx + 2, 11);
    }
  });
}

// ── Vocals isolation toggle ───────────────────────────────────
async function runTapVocalsIsolation() {
  if (tapState.isolating || !S.fileId) return;
  tapState.isolating = true;

  const btn      = $('tapVocalsBtn');
  const uvrModel = $('uvrModelSelect')?.value || 'UVR-MDX-NET-Inst_HQ_3';
  if (btn) { btn.disabled = true; btn.classList.add('loading'); btn.lastChild.textContent = ' Isoliere…'; }

  try {
    const form = new FormData();
    form.append('file_id',      S.fileId);
    form.append('uvr_model_id', uvrModel);
    const r = await fetch('/api/isolate', { method: 'POST', body: form });
    if (!r.ok) throw new Error('Isolation konnte nicht gestartet werden');
    const { job_id } = await r.json();
    tapState.isolationJobId = job_id;

    // Poll until done
    while (tapState.active) {
      await sleep(1500);
      if (!tapState.active) return;
      const jr  = await fetch(`/api/job/${job_id}`);
      const job = await jr.json();

      if (btn) btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/></svg> ${job.progress || 0}%`;

      if (job.status === 'done') {
        tapState.vocalsUrl  = `/api/vocals/${job_id}`;
        tapState.useVocals  = true;
        tapState.isolating  = false;
        _switchTapAudio(tapState.vocalsUrl);
        decodeTapAudio(tapState.vocalsUrl);
        if (btn) { btn.disabled = false; btn.classList.remove('loading'); btn.classList.add('active'); btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/></svg> Vocals ●`; }
        toast('Vocals isoliert — Waveform aktualisiert.', 'success');
        return;
      }
      if (job.status === 'error') throw new Error(job.error || 'Fehler');
    }
  } catch (e) {
    tapState.isolating = false;
    if (btn) { btn.disabled = false; btn.classList.remove('loading'); btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/></svg> Vocals`; }
    toast('Vocals-Isolation fehlgeschlagen: ' + e.message, 'error');
  }
}

function toggleTapVocals() {
  if (!tapState.active || tapState.isolating) return;

  if (!tapState.vocalsUrl) {
    // First time: run isolation
    runTapVocalsIsolation();
    return;
  }

  const btn = $('tapVocalsBtn');
  if (tapState.useVocals) {
    // Switch back to original
    tapState.useVocals = false;
    _switchTapAudio(tapState.originalUrl);
    decodeTapAudio(tapState.originalUrl);
    if (btn) { btn.classList.remove('active'); btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/></svg> Vocals`; }
  } else {
    // Switch to isolated vocals (already processed)
    tapState.useVocals = true;
    _switchTapAudio(tapState.vocalsUrl);
    decodeTapAudio(tapState.vocalsUrl);
    if (btn) { btn.classList.add('active'); btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/></svg> Vocals ●`; }
  }
}

function _switchTapAudio(url) {
  const wasPlaying  = tapState.started && tapAudio && !tapAudio.paused;
  const currentTime = tapAudio ? tapAudio.currentTime : 0;
  _makeTapAudio(url);
  tapAudio.currentTime = currentTime;
  if (wasPlaying) tapAudio.play().catch(() => {});
}

function renderTapLines() {
  const container = $('tapLinesList');
  if (!container) return;
  container.innerHTML = '';

  const idx = tapState.currentIdx; // = times.length

  tapState.lines.forEach((text, i) => {
    const div = document.createElement('div');
    div.className = 'tap-line';
    div.dataset.idx = i;

    if (!tapState.started) {
      // Before first tap: line 0 shown as "next up", rest upcoming
      if (i === 0) {
        div.classList.add('tap-line-next');
        div.innerHTML = `<span class="tap-line-text">${escHTML(text)}</span>`;
      } else {
        div.classList.add('tap-line-upcoming');
        div.innerHTML = `<span class="tap-line-text">${escHTML(text)}</span>`;
      }
    } else if (i < idx - 1) {
      // Done: start time recorded AND next line started
      div.classList.add('tap-line-done');
      div.innerHTML = `
        <span class="tap-line-check">✓</span>
        <span class="tap-line-text">${escHTML(text)}</span>
        <span class="tap-line-time">${fmt(tapState.times[i])}</span>`;
    } else if (i === idx - 1) {
      // Currently singing (start tapped, end not yet)
      div.classList.add('tap-line-current');
      div.innerHTML = `<span class="tap-line-text">${escHTML(text)}</span>`;
    } else {
      // Upcoming
      div.classList.add('tap-line-upcoming');
      div.innerHTML = `<span class="tap-line-text">${escHTML(text)}</span>`;
    }

    container.appendChild(div);
  });

  // Scroll active/next line into view
  const active = container.querySelector('.tap-line-current, .tap-line-next');
  if (active) active.scrollIntoView({ block: 'center', behavior: 'smooth' });

  // Update hint text
  const hEl = $('tapHint');
  if (!hEl) return;
  if (!tapState.started) {
    hEl.innerHTML = `<span class="tap-space-hint">SPACE</span> drücken um Wiedergabe zu starten &amp; erste Zeile zu markieren`;
  } else {
    const remaining = tapState.lines.length - tapState.currentIdx;
    if (remaining > 0) {
      hEl.textContent = `${remaining} ${remaining === 1 ? 'Zeile' : 'Zeilen'} übrig — Space wenn die nächste Zeile beginnt`;
    } else {
      hEl.textContent = 'Alle Zeilen markiert!';
    }
  }
}

function escHTML(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function tapMark() {
  if (!tapState.active) return;
  if (tapState.currentIdx >= tapState.lines.length) return;

  const t = tapAudio ? tapAudio.currentTime : 0;

  if (!tapState.started) {
    // First tap: start playback + record time[0]
    tapState.started = true;
    tapAudio.play().catch(() => {});
    tapState.times.push(t);     // times[0] = start of line 0
    tapState.currentIdx = 1;   // line 0 is now the "currently singing" line
    renderTapLines();
    return;
  }

  // Record start time for next line
  tapState.times.push(t);
  tapState.currentIdx++;

  // Flash the new current line
  const newCur = $('tapLinesList')?.querySelector('.tap-line-current');
  if (newCur) {
    // Re-render first, then trigger flash
  }
  renderTapLines();

  // Briefly flash the current line block
  const curEl = $('tapLinesList')?.querySelector('.tap-line-current');
  if (curEl) {
    curEl.classList.remove('tapped');
    void curEl.offsetWidth; // force reflow
    curEl.classList.add('tapped');
  }

  // Enable finish button once at least 1 line is fully tapped
  const fb = $('tapFinishBtn');
  if (fb) fb.disabled = false;

  // Auto-finish when all lines are tapped
  if (tapState.currentIdx >= tapState.lines.length) {
    if ($('tapHint')) $('tapHint').textContent = 'Alle Zeilen markiert — fertig!';
    setTimeout(finishTapSync, 600);
  }
}

function tapUndo() {
  if (!tapState.active || tapState.times.length === 0) return;

  tapState.times.pop();
  tapState.currentIdx = Math.max(0, tapState.currentIdx - 1);

  if (tapState.currentIdx === 0) {
    // Revert to pre-first-tap state
    tapState.started = false;
    if (tapAudio) { tapAudio.pause(); tapAudio.currentTime = 0; }
    const fb = $('tapFinishBtn');
    if (fb) fb.disabled = true;
  } else {
    // Seek audio back to start of the now-current line
    const seekTime = tapState.times[tapState.currentIdx - 1];
    if (tapAudio) tapAudio.currentTime = seekTime;
  }

  renderTapLines();
  toast('Zurückgegangen.', '');
}

async function finishTapSync() {
  if (!tapState.active) return;

  const lines = tapState.lines;
  const times = tapState.times;

  if (!times.length) { closeTapOverlay(); return; }

  if (tapAudio) tapAudio.pause();

  // Calculate average line duration as fallback for the last segment's end
  const audioDur = (tapAudio && !isNaN(tapAudio.duration)) ? tapAudio.duration : S.duration;
  const avgDur   = times.length > 1
    ? (times[times.length - 1] - times[0]) / (times.length - 1)
    : 3;

  // Build segments (only for lines that got tapped)
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
  closeTapOverlay();

  // Propagate isolation job to timeline vocals toggle
  if (tapState.isolationJobId) S.vocalsJobId = tapState.isolationJobId;

  if (src === 'upload') {
    // File was uploaded before opening the overlay — S.fileId is set
    initEditor(segs);
    toast(`Tap Sync: ${segs.length} Zeilen übernommen.`, 'success');
  } else {
    pushHistory();
    S.segments = segs;
    renderSegmentBlocks();
    renderSegmentList();
    updateLrcPreview();
    // Show vocals waveform toggle if isolation was done during tap sync
    if (tapState.isolationJobId) {
      updateWaveVocalsBtn();
      if (!S.vocalsAudioBuf) decodeVocalsWaveform();
    }
    toast(`Tap Sync: ${segs.length} Zeilen neu eingetaktet.`, 'success');
  }
}

function closeTapOverlay() {
  tapState.active    = false;
  tapState.wavePeaks = null;
  if (tapState.rafId) { cancelAnimationFrame(tapState.rafId); tapState.rafId = null; }
  if (tapAudio) { tapAudio.pause(); tapAudio.src = ''; tapAudio = null; }
  $('tapSyncOverlay').classList.add('hidden');
}

// ─────────────────────────────────────────────────────────────────────────────
// Event bindings
// ─────────────────────────────────────────────────────────────────────────────
function init() {
  // Drag & drop upload
  el.dropZone.addEventListener('dragover', e => {
    e.preventDefault(); el.dropZone.classList.add('drag-over');
  });
  el.dropZone.addEventListener('dragleave', () => el.dropZone.classList.remove('drag-over'));
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

  // UVR toggle
  const uvrToggle      = $('uvrToggle');
  const uvrModelWrap   = $('uvrModelWrap');
  const uvrInstallHint = $('uvrInstallHint');

  // Check if audio-separator is installed
  fetch('/api/uvr_available').then(r => r.json()).then(d => {
    uvrAvailable = d.available;
    if (!d.available && uvrInstallHint) {
      uvrInstallHint.style.display = 'block';
      if (uvrToggle) uvrToggle.disabled = true;
    }
  }).catch(() => {});

  if (uvrToggle && uvrModelWrap) {
    uvrToggle.addEventListener('change', () => {
      uvrModelWrap.classList.toggle('active', uvrToggle.checked);
    });
  }

  // Transcribe
  el.transcribeBtn.addEventListener('click', () => startTranscription());
  el.cancelBtn?.addEventListener('click', () => {
    S.jobCancelled = true; showPhase('upload'); toast('Abgebrochen.');
  });
  el.retranscribeBtn?.addEventListener('click', () => {
    if (ws) { ws.destroy(); ws = null; }
    showPhase('upload');
    startTranscription(S.fileId);
  });

  // Tap Sync — upload file first, then open overlay
  el.tapSyncBtn?.addEventListener('click', async () => {
    if (!S._pendingFile) { toast('Bitte Audiodatei auswählen.', 'error'); return; }
    const lyrics = el.lyricsInput.value.trim().split('\n').map(l => l.trim()).filter(Boolean);
    if (!lyrics.length) { toast('Bitte Lyrics eingeben.', 'error'); return; }

    if (!S.fileId) {
      // Upload first so the overlay can load audio and isolation can run
      el.tapSyncBtn.disabled = true;
      const origHTML = el.tapSyncBtn.innerHTML;
      el.tapSyncBtn.innerHTML = '<span class="spinner-ring" style="width:14px;height:14px;border-width:2px;margin-right:4px"></span>…';
      try {
        const form = new FormData();
        form.append('file', S._pendingFile);
        const r = await fetch('/api/upload', { method: 'POST', body: form });
        if (!r.ok) throw new Error((await r.json()).error || 'Upload fehlgeschlagen');
        S.fileId = (await r.json()).file_id;
      } catch (e) {
        toast('Upload fehlgeschlagen: ' + e.message, 'error');
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
  $('tapCancelBtn')?.addEventListener('click', () => { closeTapOverlay(); toast('Tap Sync abgebrochen.'); });
  $('tapFinishBtn')?.addEventListener('click', finishTapSync);
  $('tapVocalsBtn')?.addEventListener('click', toggleTapVocals);
  $('waveVocalsBtn')?.addEventListener('click', () => setWaveVocalsMode(!S.useVocalsWaveform));

  // Update tap sync button when lyrics change
  el.lyricsInput.addEventListener('input', updateTapSyncBtn);

  // Resize tap wave canvas when window resizes
  window.addEventListener('resize', () => {
    if (tapState.active) initTapWaveCanvas();
  });

  // Transport
  el.playPauseBtn.addEventListener('click', () => ws?.playPause());
  el.seekBackBtn.addEventListener('click',  () => seekTo(S.currentTime - 5));
  el.seekFwdBtn.addEventListener('click',   () => seekTo(S.currentTime + 5));

  // Undo / Redo
  $('undoBtn').addEventListener('click', undo);
  $('redoBtn').addEventListener('click', redo);

  // Zoom controls
  el.zoomSlider.addEventListener('input', () => applyZoom(+el.zoomSlider.value));
  el.zoomInBtn.addEventListener('click',  () => applyZoom(S.pps * 1.3));
  el.zoomOutBtn.addEventListener('click', () => applyZoom(S.pps * 0.77));

  // Segments
  el.addSegmentBtn.addEventListener('click', addSegmentNow);
  el.sortBtn.addEventListener('click', () => {
    S.segments.sort((a,b) => a.start - b.start);
    renderSegmentBlocks();
    renderSegmentList();
    updateLrcPreview();
    toast('Nach Zeitstempel sortiert.');
  });

  // Export
  el.exportBtn.addEventListener('click', exportLRC);
  el.copyLrcBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(generateLRC())
      .then(() => toast('In Zwischenablage kopiert!', 'success'))
      .catch(() => toast('Kopieren fehlgeschlagen.', 'error'));
  });
  el.previewToggleBtn.addEventListener('click', () => {
    const hidden = el.lrcPreview.classList.toggle('hidden');
    el.previewToggleBtn.textContent = hidden ? '👁 Vorschau' : '✕ Vorschau';
    if (!hidden) el.lrcPreview.textContent = generateLRC();
  });
  el.titleInput.addEventListener('input', updateLrcPreview);
  el.artistInput.addEventListener('input', updateLrcPreview);
}

init();
