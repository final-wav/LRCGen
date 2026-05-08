'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// enhanced.js — Enhanced Mode (Word / Syllable level LRC)
// ─────────────────────────────────────────────────────────────────────────────

// ─── State ────────────────────────────────────────────────────────────────────
const EH = {
  fileId:       null,
  filename:     '',
  _pendingFile: null,
  audioUrl:     null,

  submode:      'word',   // 'word' | 'syllable'
  segments:     [],       // [{id,start,end,text,words:[{word,start,end}]}]
  jobId:        null,
  jobCancelled: false,

  // timeline
  pps:          80,       // pixels per second (zoom)
  duration:     0,
  wavePeaks:    null,
  decodeId:     0,
  currentTime:  0,
  isPlaying:    false,
  selectedLine: null,     // segment id

  // undo/redo
  history:      [],
  historyIdx:   -1,

  // drag
  drag:         null,

  // LRC hint segments from a dropped .lrc file [{start,end,text}]
  lrcHints:     null,

  // vocals
  vocalsJobId:  null,   // job_id whose /api/vocals/ serves the isolated file
  vocalsUrl:    null,
  vocalsPeaks:  null,
  useVocalsWave: false,
  useVocalsAudio: false,

  // word tap sync (single-phase flat word list)
  wtFlat:       [],       // [{lineIdx, wordIdx, word, lineText, totalLines}]
  wtFlatIdx:    0,        // index of current word being tapped
  wtTimes:      [],       // tap time for each flat word index
  wtPeaks:      null,     // Float32Array at WT_PPS resolution for scrolling waveform
  wtPeaksDur:   0,        // duration of decoded audio in seconds

  wxAvail:      null,     // null | true | false
  uvrAvail:     null,     // null | true | false
  engine:       '',       // 'whisperx' | 'whisper'
};

let ehAudio = null;
let ehRafId = null;
const EH_MAX_HIST = 80;

function ehEl(id) { return document.getElementById(id); }
function ehFmt(t) {
  const m = Math.floor(t / 60), s = t % 60;
  return `${m}:${String(Math.floor(s)).padStart(2,'0')}.${String(Math.floor((s%1)*100)).padStart(2,'0')}`;
}

// ─── Mode switching ───────────────────────────────────────────────────────────
function switchMode(mode) {
  ehEl('lrc-root').style.display      = mode === 'lrc'      ? '' : 'none';
  ehEl('enhanced-root').style.display = mode === 'enhanced' ? '' : 'none';
  document.querySelectorAll('.mode-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.mode === mode));
  if (mode === 'enhanced' && EH.wxAvail === null)  checkWhisperX();
  if (mode === 'enhanced' && EH.uvrAvail === null) checkUVR();
}

function switchEnhancedMode(submode) {
  EH.submode = submode;
  document.querySelectorAll('.en-subtab').forEach(t =>
    t.classList.toggle('active', t.dataset.submode === submode));
  const syllNote = ehEl('ehSyllableNote');
  const tapBtn   = ehEl('ehTapSyncBtn');
  if (submode === 'syllable') {
    if (syllNote) syllNote.classList.remove('hidden');
    if (tapBtn)   tapBtn.style.display = 'none';
  } else {
    if (syllNote) syllNote.classList.add('hidden');
    if (tapBtn)   tapBtn.style.display = '';
  }
  updateEhButtons();
}

// ─── Capability checks ────────────────────────────────────────────────────────
async function checkWhisperX() {
  try {
    const r = await fetch('/api/whisperx_available');
    const d = await r.json();
    EH.wxAvail = d.available;
  } catch (_) { EH.wxAvail = false; }
  const warn = ehEl('ehWhisperxWarn');
  if (warn) warn.classList.toggle('hidden', EH.wxAvail);
}

async function checkUVR() {
  try {
    const r = await fetch('/api/uvr_available');
    const d = await r.json();
    EH.uvrAvail = d.available;
  } catch (_) { EH.uvrAvail = false; }
  // Refresh button visibility (file might already be loaded)
  ehUpdateVocalsBtns();
}

// ─── LRC file import ──────────────────────────────────────────────────────────
function _lrcTs(mm, ss) { return parseInt(mm, 10) * 60 + parseFloat(ss); }

function ehHandleLrcDrop(file) {
  if (!file) return;
  const ext = file.name.split('.').pop().toLowerCase();
  if (ext !== 'lrc') { toast('Drop a .lrc file here.', 'error'); return; }

  const reader = new FileReader();
  reader.onload = e => {
    const text     = e.target.result.replace(/\r\n/g, '\n');
    const stampRe  = /^\[(\d{1,3}):(\d{2}\.\d{2,3})\]/;
    const headerRe = /^\[[a-zA-Z_]+:[^\]]*\]$/;
    const timedRaw = [];   // {ts, rest}

    for (const raw of text.split('\n')) {
      const t = raw.trim();
      if (!t || headerRe.test(t)) continue;
      let rest = t, firstTs = null;
      while (true) {
        const m = rest.match(stampRe);
        if (!m) break;
        if (firstTs === null) firstTs = _lrcTs(m[1], m[2]);
        rest = rest.slice(m[0].length);
      }
      if (firstTs !== null) timedRaw.push({ ts: firstTs, rest });
    }

    timedRaw.sort((a, b) => a.ts - b.ts);

    // Build hint segments with start/end/text
    const hints = timedRaw.map((item, i) => ({
      start: item.ts,
      end:   timedRaw[i + 1]?.ts ?? item.ts + 5,   // last line gets +5s buffer
      text:  item.rest.replace(/<[\d:\.]+>/g, '').trim(),  // strip word tags
    })).filter(h => h.text);

    if (!hints.length) { toast('No timed lines found in .lrc file.', 'error'); return; }

    // Store hints for transcription request
    EH.lrcHints = hints;

    // Populate lyrics textarea with plain text
    const ta = ehEl('ehLyricsInput');
    if (ta) {
      ta.value = hints.map(h => h.text).join('\n');
      ta.dispatchEvent(new Event('input'));
    }

    toast(`Imported ${hints.length} lines + timestamps from ${file.name} — will use for precise alignment`, 'success');
  };
  reader.readAsText(file, 'utf-8');
}

// ─── Upload handling ──────────────────────────────────────────────────────────
function ehHandleFile(file) {
  if (!file) return;
  const ext = file.name.split('.').pop().toLowerCase();
  // Route .lrc files to the lyrics importer instead
  if (ext === 'lrc') { ehHandleLrcDrop(file); return; }
  if (!['mp3','flac','wav','m4a','ogg','opus','aac'].includes(ext)) {
    toast('Format not supported.', 'error'); return;
  }
  EH._pendingFile = file;
  EH.filename     = file.name;
  const fi = ehEl('ehFileInfo');
  const dz = ehEl('ehDropZone');
  if (fi) fi.classList.remove('hidden');
  if (dz) dz.classList.add('hidden');
  const fn = ehEl('ehFileNameDisplay');
  if (fn) fn.textContent = file.name;
  updateEhButtons();
}

function updateEhButtons() {
  const hasFile = !!EH._pendingFile;
  const tapBtn  = ehEl('ehTapSyncBtn');
  const trBtn   = ehEl('ehTranscribeBtn');
  if (trBtn) trBtn.disabled = !hasFile;
  if (tapBtn) tapBtn.disabled = !hasFile || EH.submode === 'syllable';

  const mw = ehEl('ehUvrModelWrap');
  if (mw) mw.classList.toggle('active', !!ehEl('ehUvrToggle')?.checked);
}

async function ehUploadFile() {
  if (!EH._pendingFile) return null;
  if (EH.fileId) return EH.fileId;  // already uploaded
  const form = new FormData();
  form.append('file', EH._pendingFile);
  const r = await fetch('/api/upload', { method: 'POST', body: form });
  if (!r.ok) throw new Error('Upload failed');
  const { file_id } = await r.json();
  EH.fileId   = file_id;
  EH.audioUrl = `/api/audio/${file_id}`;
  return file_id;
}

// ─── Enhanced transcription ───────────────────────────────────────────────────
async function startEnhancedTranscription() {
  EH.jobCancelled = false;
  try {
    const fileId = await ehUploadFile();
    if (!fileId) return;

    ehShowPhase('progress');
    const useUvr  = !!ehEl('ehUvrToggle')?.checked;
    const uvrMdl  = ehEl('ehUvrModelSelect')?.value || 'UVR-MDX-NET-Inst_HQ_3';
    const model   = ehEl('modelSelect')?.value      || 'base';
    const lang    = ehEl('langSelect')?.value        || '';
    const lyrics  = ehEl('ehLyricsInput')?.value?.trim() || '';

    if (useUvr) {
      ehEl('ehProgressSteps')?.style.setProperty('display', '');
      ehProgressStep('ehStepSeparate');
    } else {
      ehEl('ehProgressSteps')?.style.setProperty('display', 'none');
    }

    const form = new FormData();
    form.append('file_id',         fileId);
    form.append('model_name',      model);
    form.append('language',        lang);
    form.append('lyrics',          lyrics);
    form.append('vocal_isolation', useUvr ? 'true' : 'false');
    form.append('uvr_model_id',    uvrMdl);
    form.append('mode',            EH.submode);
    if (EH.lrcHints?.length) {
      form.append('segment_hints', JSON.stringify(EH.lrcHints));
    }

    const r = await fetch('/api/transcribe_enhanced', { method: 'POST', body: form });
    if (!r.ok) throw new Error('Could not start transcription');
    const { job_id } = await r.json();
    EH.jobId = job_id;

    await pollEnhancedJob(job_id);
  } catch (e) {
    if (!EH.jobCancelled) {
      ehShowPhase('upload');
      toast('Transcription failed: ' + e.message, 'error');
    }
  }
}

async function pollEnhancedJob(jobId) {
  while (!EH.jobCancelled) {
    await new Promise(res => setTimeout(res, 1200));
    if (EH.jobCancelled) break;
    let job;
    try {
      const r = await fetch(`/api/job/${jobId}`);
      job = await r.json();
    } catch (_) { continue; }

    const lbl = ehEl('ehProgressLabel');
    const bar = ehEl('ehProgressBar');
    if (lbl) lbl.textContent = job.message || '';
    if (bar && typeof job.progress === 'number') bar.style.width = job.progress + '%';

    // step indicator
    const status = job.status || '';
    if (status === 'separating_model' || status === 'separating') {
      ehProgressStep('ehStepSeparate');
    } else if (status === 'loading_model' || status === 'transcribing') {
      ehProgressStep('ehStepWhisper');
    } else if (status === 'aligning') {
      ehProgressStep('ehStepAlign');
    }

    if (job.status === 'done') {
      const seg = job.result?.segments || [];
      EH.engine = job.result?.engine || 'whisper';
      // Capture vocals job ID if UVR was used
      if (job.vocals_path) {
        EH.vocalsJobId = jobId;
        EH.vocalsUrl   = `/api/vocals/${jobId}`;
      }
      await new Promise(res => setTimeout(res, 250));
      initEnhancedEditor(seg);
      return;
    }
    if (job.status === 'error') {
      ehShowPhase('upload');
      toast(job.error || 'Transcription error', 'error');
      return;
    }
  }
}

function ehProgressStep(activeId) {
  ['ehStepSeparate','ehStepWhisper','ehStepAlign'].forEach(id => {
    const el = ehEl(id);
    if (!el) return;
    el.classList.toggle('active', id === activeId);
  });
}

// ─── Editor init ─────────────────────────────────────────────────────────────
function initEnhancedEditor(segments) {
  EH.segments    = segments.map((s, i) => ({ ...s, id: i }));
  EH.history     = [];
  EH.historyIdx  = -1;
  EH.selectedLine = null;
  ehShowPhase('editor');

  // Init audio
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

  // Vocals state reset (keep vocalsJobId/vocalsUrl from job, but reset decoded data)
  EH.vocalsPeaks    = null;
  EH.useVocalsWave  = false;
  EH.useVocalsAudio = false;
  ehUpdateVocalsBtns();
  if (EH.vocalsJobId) ehDecodeVocalsWave();  // decode in background

  // Engine badge
  const badge = ehEl('ehEngineBadge');
  if (badge) badge.textContent = `Engine: ${EH.engine}`;

  ehRenderLineBlocks();
  ehRenderWordChips();
  ehRenderSegList();
  ehRefreshUndoRedo();
  ehStartRAF();
  ehResizeCanvases();
}

// ─── Phase switching ──────────────────────────────────────────────────────────
function ehShowPhase(phase) {
  ['ehUploadSection','ehProgressSection','ehEditorSection'].forEach(id => {
    const el = ehEl(id);
    if (!el) return;
    el.classList.toggle('hidden', id !== `eh${phase.charAt(0).toUpperCase()+phase.slice(1)}Section`);
  });
}

// ─── Timeline setup ───────────────────────────────────────────────────────────
function ehSetTimelineWidth() {
  const w = Math.max(EH.duration * EH.pps, 800);
  const inner = ehEl('ehTlInner');
  if (inner) inner.style.width = w + 'px';
  const rc = ehEl('ehRulerCanvas');
  if (rc) { rc.width = w; ehDrawRuler(rc); }
  const wc = ehEl('ehWaveCanvas');
  if (wc) { wc.width = w; ehDrawWave(wc); }
}

function ehResizeCanvases() {
  const rc = ehEl('ehRulerCanvas');
  const wc = ehEl('ehWaveCanvas');
  const scroll = ehEl('ehScrollArea');
  if (!scroll) return;
  const totalW = Math.max(EH.duration * EH.pps, scroll.clientWidth, 800);
  if (rc) { rc.width = totalW; ehDrawRuler(rc); }
  if (wc) { wc.width = totalW; ehDrawWave(wc); }
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

// ─── Waveform decode + draw ───────────────────────────────────────────────────
async function ehDecodeWave(url) {
  const myId = ++EH.decodeId;
  EH.wavePeaks = null;
  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
    const resp = await fetch(url);
    if (!resp.ok) { ctx.close(); return; }
    const ab  = await resp.arrayBuffer();
    const buf = await ctx.decodeAudioData(ab);
    ctx.close();
    if (myId !== EH.decodeId) return;

    const totalPx = Math.ceil(buf.duration * EH.pps);
    const data    = buf.getChannelData(0);
    const sRate   = buf.sampleRate;
    const peaks   = new Float32Array(totalPx);
    for (let px = 0; px < totalPx; px++) {
      const start = Math.floor(px * sRate / EH.pps);
      const end   = Math.floor((px + 1) * sRate / EH.pps);
      let mx = 0;
      for (let i = start; i < end && i < data.length; i++) {
        const v = Math.abs(data[i]);
        if (v > mx) mx = v;
      }
      peaks[px] = mx;
    }
    EH.wavePeaks = peaks;
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
    const ab  = await resp.arrayBuffer();
    const buf = await ctx.decodeAudioData(ab);
    ctx.close();
    const totalPx = Math.ceil(buf.duration * EH.pps);
    const data    = buf.getChannelData(0);
    const sRate   = buf.sampleRate;
    const peaks   = new Float32Array(totalPx);
    for (let px = 0; px < totalPx; px++) {
      const s = Math.floor(px * sRate / EH.pps);
      const e = Math.floor((px + 1) * sRate / EH.pps);
      let mx = 0;
      for (let i = s; i < e && i < data.length; i++) { const v = Math.abs(data[i]); if (v > mx) mx = v; }
      peaks[px] = mx;
    }
    EH.vocalsPeaks = peaks;
    if (btn) { btn.classList.remove('loading'); btn.classList.remove('hidden'); }
    if (EH.useVocalsWave) { const wc = ehEl('ehWaveCanvas'); if (wc) ehDrawWave(wc); }
  } catch (e) {
    console.warn('Vocals waveform decode failed:', e);
    if (btn) btn.classList.remove('loading');
  }
}

// Run vocal isolation and store job id + url in EH state. Returns true on success.
async function ehRunIsolation(loadingBtn) {
  if (!EH.fileId) return false;
  if (loadingBtn) { loadingBtn.classList.add('loading'); loadingBtn.disabled = true; }
  try {
    const uvrModel = ehEl('ehUvrModelSelect')?.value || 'UVR-MDX-NET-Inst_HQ_3';
    const form = new FormData();
    form.append('file_id', EH.fileId);
    form.append('uvr_model_id', uvrModel);
    const r = await fetch('/api/isolate', { method: 'POST', body: form });
    if (!r.ok) throw new Error('Isolation failed to start');
    const { job_id } = await r.json();
    while (true) {
      await new Promise(res => setTimeout(res, 1500));
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
  // Show buttons whenever UVR is available and a file is loaded
  // (clicking will trigger isolation on demand if not yet done)
  const show = !!(EH.uvrAvail && EH.fileId);
  ehEl('ehVocalsWaveBtn')?.classList.toggle('hidden', !show);
  ehEl('ehVocalsAudioBtn')?.classList.toggle('hidden', !show);
  ehEl('ehVocalsWaveBtn')?.classList.toggle('active', EH.useVocalsWave && !!EH.vocalsPeaks);
  ehEl('ehVocalsAudioBtn')?.classList.toggle('active', EH.useVocalsAudio);
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
    const t = ehAudio.currentTime;
    const wasPlaying = !ehAudio.paused;
    ehAudio.src = url;
    ehAudio.load();
    ehAudio.currentTime = t;
    if (wasPlaying) ehAudio.play();
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
  // Use vocals peaks if in vocals waveform mode and they're decoded
  const peaks = (EH.useVocalsWave && EH.vocalsPeaks) ? EH.vocalsPeaks : EH.wavePeaks;
  if (!peaks || !peaks.length) {
    // placeholder bars
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
    const amp  = peaks[px];
    const bh   = Math.max(1, amp * h * 0.92);
    ctx.fillStyle = px < playX
      ? (isVocals ? '#22c55e' : '#7c3aed')   // green for vocals, purple for full
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
    const ap = ehEl('wtAudioProgress');
    if (ap && EH.duration > 0) ap.style.width = (EH.currentTime / EH.duration * 100) + '%';
    // Redraw wave to move played portion
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
  // auto-scroll
  const scroll = ehEl('ehScrollArea');
  if (scroll && EH.isPlaying) {
    const visW  = scroll.clientWidth;
    const left  = scroll.scrollLeft;
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
  ehResizeCanvases();
  ehRenderLineBlocks();
  ehRenderWordChips();
  ehUpdatePlayheadDOM();
  // restore scroll position
  const scroll = ehEl('ehScrollArea');
  if (scroll) scroll.scrollLeft = Math.max(0, t * EH.pps - scroll.clientWidth * 0.3);
}
const EH_PPS_BASE = 80;

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
  if (EH.submode === 'syllable') {
    // show word track label differently
  }
  EH.segments.forEach(seg => {
    (seg.words || []).forEach((w, wi) => {
      const x = w.start * EH.pps;
      const wd = Math.max(4, (w.end - w.start) * EH.pps);
      const chip = document.createElement('div');
      chip.className = 'en-word-chip' + (w.is_syllable ? ' syllable' : '');
      chip.style.cssText = `left:${x}px;width:${wd}px`;
      chip.dataset.segId  = seg.id;
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

// ─── Select line ─────────────────────────────────────────────────────────────
function ehSelectLine(segId) {
  EH.selectedLine = segId;
  document.querySelectorAll('.en-line-block').forEach(el =>
    el.classList.toggle('selected', +el.dataset.segId === segId));
}

// ─── Drag: line block ─────────────────────────────────────────────────────────
function ehStartLineDrag(e, segId, handle) {
  e.preventDefault();
  e.stopPropagation();
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
    } else { // right
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
  e.preventDefault();
  e.stopPropagation();
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
    const prevEnd  = EH.drag.wordIdx > 0 ? seg.words[EH.drag.wordIdx - 1].end   : seg.start;
    const nextStart= EH.drag.wordIdx < seg.words.length-1 ? seg.words[EH.drag.wordIdx + 1].start : seg.end;

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

// ─── Inline edit ─────────────────────────────────────────────────────────────
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

// ─── Segment list (bottom panel) ──────────────────────────────────────────────
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

// ─── Undo / Redo ─────────────────────────────────────────────────────────────
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

// ─── New Song (enhanced) ──────────────────────────────────────────────────────
function ehNewSong() {
  if (EH.segments.length && !confirm('Discard current session and load a new song?')) return;
  if (ehAudio) { ehAudio.pause(); ehAudio.src = ''; ehAudio = null; }
  if (ehRafId) { cancelAnimationFrame(ehRafId); ehRafId = null; }
  Object.assign(EH, {
    fileId: null, filename: '', _pendingFile: null, audioUrl: null,
    segments: [], jobId: null, jobCancelled: false,
    history: [], historyIdx: -1, selectedLine: null,
    wavePeaks: null, duration: 0, currentTime: 0, isPlaying: false,
    lrcHints: null,
    vocalsJobId: null, vocalsUrl: null, vocalsPeaks: null,
    useVocalsWave: false, useVocalsAudio: false,
  });
  ehUpdateVocalsBtns();
  const fi = ehEl('ehFileInfo'), dz = ehEl('ehDropZone'), fi2 = ehEl('ehFileInput');
  if (fi) fi.classList.add('hidden');
  if (dz) dz.classList.remove('hidden');
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

// ─── Add Line at playhead ────────────────────────────────────────────────────
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
  EH.segments  = [];
  EH.history   = [];
  EH.historyIdx = -1;
  if (ehAudio) { ehAudio.pause(); }
  ehShowPhase('upload');
  toast('Ready to re-transcribe.', '');
}

// ─── Generate Enhanced LRC text client-side ───────────────────────────────────
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
      lines.push(lineTs + words.map(w => `<${ehFmt(w.start)}>${w.word}`).join(''));
    } else {
      lines.push(lineTs + (seg.text || '').trim());
    }
  });
  return lines.join('\n');
}

// ─── Update preview panel if visible ─────────────────────────────────────────
function ehUpdatePreview() {
  const pre = ehEl('ehLrcPreview');
  if (pre && !pre.classList.contains('hidden')) {
    pre.textContent = ehGenerateLrcText();
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// WORD TAP SYNC — single-phase, word by word, start to finish
// Space = tap start of current word · Backspace = undo · S = skip word
// ═════════════════════════════════════════════════════════════════════════════

let wtAudio = null;
let wtRafId = null;

// EH.wtFlat    = [{lineIdx, wordIdx, word}]  — flattened all words
// EH.wtFlatIdx = current position in wtFlat
// EH.wtTimes   = [t0, t1, ...]              — tap time for each flat word

function openWordTapSync() {
  if (!EH.fileId && !EH.audioUrl) {
    ehUploadFile().then(id => { if (id) _startWordTapOverlay(); })
      .catch(() => toast('Upload the audio file first.', 'error'));
  } else {
    _startWordTapOverlay();
  }
}

function _startWordTapOverlay() {
  // Parse lyrics, strip any LRC timestamps
  const raw = ehEl('ehLyricsInput')?.value?.trim() || '';
  const lines = raw.split('\n')
    .map(l => l.replace(/^\[\d{1,3}:\d{2}\.\d{2,3}\]/, '').replace(/<[\d:.]+>/g, '').trim())
    .filter(Boolean);
  if (!lines.length) { toast('Enter lyrics first.', 'error'); return; }

  // Build flat word list
  EH.wtFlat = [];
  lines.forEach((line, li) => {
    line.split(/\s+/).filter(Boolean).forEach((word, wi) => {
      EH.wtFlat.push({ lineIdx: li, wordIdx: wi, word, lineText: line, totalLines: lines.length });
    });
  });
  EH.wtFlatIdx = 0;
  EH.wtTimes   = [];

  // Show overlay FIRST — must be visible before reading clientWidth for canvas
  const overlay = ehEl('wordTapOverlay');
  if (overlay) { overlay.classList.remove('hidden'); overlay.focus(); }

  // Size the canvas now that the overlay is visible and has a layout
  _wtInitCanvas();

  // Audio
  if (wtAudio) { wtAudio.pause(); wtAudio.src = ''; }
  wtAudio = new Audio(EH.audioUrl || `/api/audio/${EH.fileId}`);
  wtAudio.volume = +(ehEl('ehVolumeSlider')?.value ?? 1);
  wtAudio.play();

  // Always decode fresh peaks for the tap waveform (own WT_PPS resolution)
  EH.wtPeaks    = null;
  EH.wtPeaksDur = 0;
  _wtDecodePeaks(EH.audioUrl || `/api/audio/${EH.fileId}`);

  ehEl('wtPhaseLabel').textContent = 'Word Tap';
  ehEl('wtCountDisplay').textContent = `0 / ${EH.wtFlat.length}`;

  _wtUpdateWordDisplay();
  _wtDrawWave();
  _wtStartRaf();
}

const WT_PPS = 80; // pixels per second — same as normal tap sync

function _wtInitCanvas() {
  const canvas = ehEl('wtWaveCanvas');
  if (!canvas) return;
  canvas.width  = canvas.parentElement ? canvas.parentElement.clientWidth : window.innerWidth;
  canvas.height = 64;
}

// Reuse _decodePeaks() from app.js (loaded before enhanced.js, same TAP_PPS=80 resolution)
async function _wtDecodePeaks(url) {
  try {
    const { peaks, duration } = await _decodePeaks(url);
    EH.wtPeaks    = peaks;
    EH.wtPeaksDur = duration;
  } catch (_) {}
}

function _wtUpdateWordDisplay() {
  const cur = EH.wtFlat[EH.wtFlatIdx];
  if (!cur) return;

  // Line label
  const ll = ehEl('wtLineLabel');
  if (ll) ll.textContent = `Line ${cur.lineIdx + 1} / ${cur.totalLines}`;

  // Word display — show all words of current line, highlight current
  const wrap = ehEl('wtWordsWrap');
  if (!wrap) return;
  wrap.innerHTML = '';

  // Find all words in this line
  const lineWords = EH.wtFlat.filter(w => w.lineIdx === cur.lineIdx);
  lineWords.forEach(w => {
    const flatIdx = EH.wtFlat.indexOf(w);
    const span = document.createElement('span');
    span.className = 'wt-word ' + (
      flatIdx < EH.wtFlatIdx  ? 'wt-done' :
      flatIdx === EH.wtFlatIdx ? 'wt-current' : 'wt-upcoming'
    );
    span.textContent = w.word;
    wrap.appendChild(span);
    // Scroll current word into view
    if (flatIdx === EH.wtFlatIdx) {
      setTimeout(() => span.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' }), 0);
    }
  });

  ehEl('wtCountDisplay').textContent = `${EH.wtFlatIdx} / ${EH.wtFlat.length}`;
}

function _wtStartRaf() {
  if (wtRafId) cancelAnimationFrame(wtRafId);
  function loop() {
    if (!wtAudio) return;
    const t   = wtAudio.currentTime;
    const dur = wtAudio.duration || 1;
    const td  = ehEl('wtTimeDisplay');
    if (td) td.textContent = ehFmt(t);
    const ap = ehEl('wtAudioProgress');
    if (ap) ap.style.width = (t / dur * 100) + '%';
    _wtDrawWave();
    // Keep running while tapping is in progress (stop only after last word is recorded)
    if (EH.wtFlatIdx <= EH.wtFlat.length) wtRafId = requestAnimationFrame(loop);
  }
  wtRafId = requestAnimationFrame(loop);
}

function _wtDrawWave() {
  const canvas = ehEl('wtWaveCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const t   = wtAudio ? wtAudio.currentTime : 0;
  const dur = EH.wtPeaksDur || 1;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#07070f';
  ctx.fillRect(0, 0, w, h);

  const playheadX = Math.floor(w * 0.3); // fixed at 30% from left, waveform scrolls past it

  if (!EH.wtPeaks) {
    // Loading placeholder
    const barW = 3, step = 5;
    const amp = h * 0.28;
    for (let px = 0; px < w; px += step) {
      const a = Math.abs(Math.sin(px * 0.07)) * amp + 4;
      ctx.fillStyle = px < playheadX ? 'rgba(124,58,237,.35)' : 'rgba(255,255,255,.12)';
      ctx.fillRect(px, h / 2 - a, barW, a * 2);
    }
    ctx.fillStyle = 'rgba(255,255,255,.8)';
    ctx.fillRect(playheadX, 0, 1, h);
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillText('Loading waveform…', playheadX + 8, h / 2 + 4);
    return;
  }

  const peaks      = EH.wtPeaks;
  const timeOffset = t - playheadX / WT_PPS; // time at left edge (x=0)
  const mid        = h / 2;

  for (let px = 0; px < w; px++) {
    const sTime = timeOffset + px / WT_PPS;
    if (sTime < 0 || sTime > dur) continue;
    const sPx = Math.floor(sTime * WT_PPS);
    if (sPx >= peaks.length) continue;
    const amp = peaks[sPx] * mid * 0.92;
    ctx.fillStyle = px < playheadX ? '#7c3aed' : '#22224a';
    ctx.fillRect(px, mid - amp, 1, amp * 2 || 1);
  }

  // Playhead line + triangle
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(playheadX, 0, 1, h);
  ctx.beginPath();
  ctx.moveTo(playheadX - 5, 0);
  ctx.lineTo(playheadX + 6, 0);
  ctx.lineTo(playheadX + 0.5, 8);
  ctx.fillStyle = '#f8fafc';
  ctx.fill();

  // Tap markers — one green tick per tapped word
  EH.wtTimes.forEach((tapTime, i) => {
    if (tapTime === undefined) return;
    const mx = Math.round(playheadX + (tapTime - t) * WT_PPS);
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

function _wtFinish(lines) {
  if (wtRafId) cancelAnimationFrame(wtRafId);
  if (wtAudio) { wtAudio.pause(); }

  // Build segments — line start = first word's time, line end = next line's first word or song end
  const songEnd = wtAudio?.duration || 0;
  const lineCount = EH.wtFlat[EH.wtFlat.length - 1]?.lineIdx + 1 || lines.length;

  // Group tap times by line
  const lineFirstFlat = {}; // lineIdx → first flat index
  EH.wtFlat.forEach((w, fi) => {
    if (lineFirstFlat[w.lineIdx] === undefined) lineFirstFlat[w.lineIdx] = fi;
  });

  const newSegs = [];
  for (let li = 0; li < lineCount; li++) {
    const lineFlat = EH.wtFlat.filter(w => w.lineIdx === li);
    const lineStartFlatIdx = lineFirstFlat[li];
    const nextLineStartFlatIdx = lineFirstFlat[li + 1];

    const lineStart = EH.wtTimes[lineStartFlatIdx] ?? 0;
    const lineEnd   = nextLineStartFlatIdx !== undefined
      ? (EH.wtTimes[nextLineStartFlatIdx] ?? songEnd)
      : songEnd;

    const words = lineFlat.map((w, wi) => {
      const fi    = lineStartFlatIdx + wi;
      const start = EH.wtTimes[fi] ?? round3(lineStart + (lineEnd - lineStart) * wi / lineFlat.length);
      const nextFi = fi + 1;
      const end   = EH.wtTimes[nextFi] !== undefined
        ? EH.wtTimes[nextFi]
        : (wi < lineFlat.length - 1
            ? round3(start + (lineEnd - start) / (lineFlat.length - wi))
            : lineEnd);
      return { word: w.word, start: round3(start), end: round3(end) };
    });

    newSegs.push({
      id: li,
      start: round3(lineStart),
      end:   round3(lineEnd),
      text:  lines[li] || lineFlat.map(w => w.word).join(' '),
      words,
    });
  }

  EH.segments   = newSegs;
  EH.wtFlat     = [];
  EH.wtTimes    = [];
  EH.wtFlatIdx  = 0;
  EH.wtPeaks    = null;
  EH.wtPeaksDur = 0;

  const overlay = ehEl('wordTapOverlay');
  if (overlay) overlay.classList.add('hidden');

  toast('Word tap sync complete!', 'success');
  ehShowPhase('editor');

  if (!ehAudio) {
    ehAudio = new Audio(EH.audioUrl || `/api/audio/${EH.fileId}`);
    ehAudio.volume = +(ehEl('ehVolumeSlider')?.value ?? 1);
    ehAudio.addEventListener('loadedmetadata', () => {
      EH.duration = ehAudio.duration;
      const dd = ehEl('ehDurationDisplay');
      if (dd) dd.textContent = ehFmt(EH.duration);
      ehSetTimelineWidth();
      ehDecodeWave(EH.audioUrl || `/api/audio/${EH.fileId}`);
    });
  }
  ehRenderLineBlocks();
  ehRenderWordChips();
  ehRenderSegList();
  ehPushHistory();
  ehRefreshUndoRedo();
  ehStartRAF();
}

function closeWordTapOverlay() {
  EH.wtFlatIdx  = 0;
  EH.wtFlat     = [];
  EH.wtTimes    = [];
  EH.wtPeaks    = null;
  EH.wtPeaksDur = 0;
  if (wtRafId) { cancelAnimationFrame(wtRafId); wtRafId = null; }
  if (wtAudio) { wtAudio.pause(); wtAudio.src = ''; wtAudio = null; }
  const overlay = ehEl('wordTapOverlay');
  if (overlay) overlay.classList.add('hidden');
  toast('Word tap sync cancelled.', '');
}

// ─── Keyboard handler for word tap overlay (single-phase) ────────────────────
function wtHandleKey(e) {
  if (e.code === 'Escape') { closeWordTapOverlay(); return; }
  if (ehEl('wordTapOverlay')?.classList.contains('hidden')) return;

  const flat = EH.wtFlat;
  if (!flat || !flat.length) return;

  if (e.code === 'Space') {
    e.preventDefault();
    const t = wtAudio ? wtAudio.currentTime : 0;
    EH.wtTimes[EH.wtFlatIdx] = t;
    EH.wtFlatIdx++;
    if (EH.wtFlatIdx >= flat.length) {
      // All words tapped — build segments
      const lines = [...new Set(flat.map(w => w.lineText))];
      // Rebuild proper lines array in order
      const orderedLines = [];
      let lastLi = -1;
      flat.forEach(w => {
        if (w.lineIdx !== lastLi) { orderedLines[w.lineIdx] = w.lineText; lastLi = w.lineIdx; }
      });
      _wtFinish(orderedLines);
    } else {
      _wtUpdateWordDisplay();
    }
  } else if (e.code === 'Backspace') {
    e.preventDefault();
    if (EH.wtFlatIdx > 0) {
      EH.wtFlatIdx--;
      delete EH.wtTimes[EH.wtFlatIdx];
      _wtUpdateWordDisplay();
      // Seek audio back slightly for context
      if (wtAudio && EH.wtTimes[EH.wtFlatIdx - 1] !== undefined) {
        wtAudio.currentTime = Math.max(0, EH.wtTimes[EH.wtFlatIdx - 1] - 0.3);
      }
    }
  } else if (e.code === 'KeyS') {
    e.preventDefault();
    // Skip: assign proportional time between last tapped and a lookahead guess
    const prevT = EH.wtFlatIdx > 0 ? (EH.wtTimes[EH.wtFlatIdx - 1] ?? 0) : 0;
    const dur   = wtAudio?.duration || 0;
    const remaining = flat.length - EH.wtFlatIdx;
    const gap = remaining > 0 ? (dur - prevT) / remaining : 0;
    EH.wtTimes[EH.wtFlatIdx] = round3(prevT + gap * 0.5);
    EH.wtFlatIdx++;
    if (EH.wtFlatIdx >= flat.length) {
      const orderedLines = [];
      flat.forEach(w => { orderedLines[w.lineIdx] = w.lineText; });
      _wtFinish(orderedLines);
    } else {
      _wtUpdateWordDisplay();
    }
  }
}

// ─── Enhanced keyboard handler (editor view) ──────────────────────────────────
function ehHandleKey(e) {
  // Don't handle if focused on input/textarea
  const tag = document.activeElement?.tagName;
  if (['INPUT','TEXTAREA','SELECT'].includes(tag)) return;
  // Only handle if enhanced editor is visible
  if (ehEl('ehEditorSection')?.classList.contains('hidden')) return;
  if (!ehEl('enhanced-root') || ehEl('enhanced-root').style.display === 'none') return;

  if (e.code === 'Space') {
    e.preventDefault();
    ehTogglePlay();
  } else if (e.code === 'Enter') {
    e.preventDefault();
    ehAddLine();
  } else if (e.code === 'ArrowLeft') {
    e.preventDefault();
    ehSeek(e.shiftKey ? -10 : -2);
  } else if (e.code === 'ArrowRight') {
    e.preventDefault();
    ehSeek(e.shiftKey ? 10 : 2);
  } else if (e.code === 'Equal' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    ehApplyZoom(EH.pps * 1.25);
  } else if (e.code === 'Minus' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    ehApplyZoom(EH.pps * 0.8);
  } else if (e.code === 'KeyZ' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    if (e.shiftKey) ehRedo(); else ehUndo();
  } else if (e.code === 'KeyY' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    ehRedo();
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
function initEnhanced() {
  // Mode tab clicks
  document.querySelectorAll('.mode-tab').forEach(btn => {
    btn.addEventListener('click', () => switchMode(btn.dataset.mode));
  });

  // Enhanced sub-tab clicks
  document.querySelectorAll('.en-subtab').forEach(btn => {
    btn.addEventListener('click', () => switchEnhancedMode(btn.dataset.submode));
  });

  // WhisperX "continue anyway" button
  ehEl('ehContinueAnywayBtn')?.addEventListener('click', () => {
    ehEl('ehWhisperxWarn')?.classList.add('hidden');
  });

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

  // Lyrics textarea — drop target for .lrc files
  const lrcWrap = ehEl('ehLyricsDropWrap');
  const lrcOverlay = ehEl('ehLrcDropOverlay');
  if (lrcWrap) {
    lrcWrap.addEventListener('dragover', e => {
      const hasLrc = [...(e.dataTransfer.items || [])].some(
        i => i.kind === 'file' && (i.type === '' || i.getAsFile()?.name?.endsWith('.lrc'))
      );
      if (!hasLrc) return;  // ignore non-lrc drags (let audio go to main dropzone)
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
      // non-lrc drops fall through to the page-level handler (audio dropzone)
    });
  }

  // Transcribe button
  ehEl('ehTranscribeBtn')?.addEventListener('click', () => startEnhancedTranscription());

  // Tap Sync button (upload → word tap)
  ehEl('ehTapSyncBtn')?.addEventListener('click', async () => {
    const raw = ehEl('ehLyricsInput')?.value?.trim() || '';
    if (!raw) { toast('Enter lyrics first.', 'error'); return; }
    ehEl('ehTapSyncBtn').disabled = true;
    try { await ehUploadFile(); } catch (e) { toast('Upload failed: ' + e.message, 'error'); ehEl('ehTapSyncBtn').disabled = false; return; }
    ehEl('ehTapSyncBtn').disabled = false;
    openWordTapSync();
  });

  // Cancel button
  ehEl('ehCancelBtn')?.addEventListener('click', () => {
    EH.jobCancelled = true; ehShowPhase('upload');
  });

  // Vocals waveform / audio toggle
  ehEl('ehVocalsWaveBtn')?.addEventListener('click', ehToggleVocalsWave);
  ehEl('ehVocalsAudioBtn')?.addEventListener('click', ehToggleVocalsAudio);

  // New Song (editor)
  ehEl('ehNewSongBtn')?.addEventListener('click', ehNewSong);

  // Word tap from editor
  ehEl('ehWordTapBtn')?.addEventListener('click', () => {
    const raw = ehEl('ehLyricsInput')?.value?.trim() || '';
    if (raw) { openWordTapSync(); }
    else {
      // rebuild lyrics from existing segments
      const synth = EH.segments.map(s => s.text).join('\n');
      ehEl('ehLyricsInput').value = synth;
      openWordTapSync();
    }
  });

  // Word tap cancel
  ehEl('wtCancelBtn')?.addEventListener('click', closeWordTapOverlay);

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

  // Click on timeline to seek
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
  ehEl('ehTitleInput')?.addEventListener('input', ehUpdatePreview);
  ehEl('ehArtistInput')?.addEventListener('input', ehUpdatePreview);

  // Global keyboard
  window.addEventListener('keydown', e => {
    // Word tap overlay takes priority
    if (!ehEl('wordTapOverlay')?.classList.contains('hidden')) {
      wtHandleKey(e); return;
    }
    ehHandleKey(e);
  });

  // Resize
  window.addEventListener('resize', () => {
    if (!ehEl('ehEditorSection')?.classList.contains('hidden')) {
      ehResizeCanvases();
    }
    // Keep tap wave canvas sized while overlay is open
    if (!ehEl('wordTapOverlay')?.classList.contains('hidden')) {
      _wtInitCanvas();
    }
  });
}

// Run after DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initEnhanced);
} else {
  initEnhanced();
}
