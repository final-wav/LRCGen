'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// eh-upload.js — EH state + upload + transcription + phase switching
// Depends on: shared.js (uvrAvailable, sleep, decodeAudioPeaks)
// ─────────────────────────────────────────────────────────────────────────────

// ─── State ────────────────────────────────────────────────────────────────────
var EH = {
  fileId:       null,
  filename:     '',
  _pendingFile: null,
  audioUrl:     null,

  submode:      'word',   // 'word' | 'syllable'
  segments:     [],
  jobId:        null,
  jobCancelled: false,

  // timeline
  pps:          80,
  duration:     0,
  wavePeaks:    null,
  decodeId:     0,
  currentTime:  0,
  isPlaying:    false,
  selectedLine: null,

  // undo/redo
  history:      [],
  historyIdx:   -1,

  // drag
  drag:         null,

  // LRC hint segments from a dropped .lrc file
  lrcHints:     null,

  // vocals
  vocalsJobId:    null,
  vocalsUrl:      null,
  audioBuf:       null,
  vocalsAudioBuf: null,
  vocalsPeaks:    null,
  useVocalsWave:  false,
  useVocalsAudio: false,

  // word tap sync
  wtFlat:       [],
  wtFlatIdx:    0,
  wtTimes:      [],
  wtPeaks:      null,
  wtPeaksDur:   0,

  wxAvail:      null,
  uvrAvail:     null,
  engine:       '',
};

var ehAudio     = null;
var ehRafId     = null;
var EH_MAX_HIST = 80;

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
    const timedRaw = [];

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

    const hints = timedRaw.map((item, i) => ({
      start: item.ts,
      end:   timedRaw[i + 1]?.ts ?? item.ts + 5,
      text:  item.rest.replace(/<[\d:\.]+>/g, '').trim(),
    })).filter(h => h.text);

    if (!hints.length) { toast('No timed lines found in .lrc file.', 'error'); return; }

    EH.lrcHints = hints;

    const ta = ehEl('ehLyricsInput');
    if (ta) {
      ta.value = hints.map(h => h.text).join('\n');
      ta.dispatchEvent(new Event('input'));
    }
    toast(`Imported ${hints.length} lines + timestamps from ${file.name}`, 'success');
  };
  reader.readAsText(file, 'utf-8');
}

// ─── Upload handling ──────────────────────────────────────────────────────────
function ehHandleFile(file) {
  if (!file) return;
  const ext = file.name.split('.').pop().toLowerCase();
  if (ext === 'lrc') { ehHandleLrcDrop(file); return; }
  if (!['mp3','flac','wav','m4a','ogg','opus','aac'].includes(ext)) {
    toast('Format not supported.', 'error'); return;
  }
  EH._pendingFile = file;
  EH.filename     = file.name;
  const fi = ehEl('ehFileInfo'), dz = ehEl('ehDropZone');
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
  if (EH.fileId) return EH.fileId;
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
    const useUvr = !!ehEl('ehUvrToggle')?.checked;
    const uvrMdl = ehEl('ehUvrModelSelect')?.value || 'UVR-MDX-NET-Inst_HQ_3';
    const model  = ehEl('modelSelect')?.value      || 'base';
    const lang   = ehEl('langSelect')?.value        || '';
    const lyrics = ehEl('ehLyricsInput')?.value?.trim() || '';

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
    await sleep(1200);
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
      if (job.vocals_path) {
        EH.vocalsJobId = jobId;
        EH.vocalsUrl   = `/api/vocals/${jobId}`;
      }
      await sleep(250);
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

// ─── Phase switching ──────────────────────────────────────────────────────────
function ehShowPhase(phase) {
  ['ehUploadSection','ehProgressSection','ehEditorSection'].forEach(id => {
    const el = ehEl(id);
    if (!el) return;
    const target = `eh${phase.charAt(0).toUpperCase() + phase.slice(1)}Section`;
    el.classList.toggle('hidden', id !== target);
  });
}
