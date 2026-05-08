'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// eh-tap.js — Word Tap Sync overlay
// Depends on: shared.js (decodeAudioPeaks, sleep),
//             eh-upload.js (EH, ehEl, ehFmt, ehUploadFile),
//             eh-editor.js (initEnhancedEditor, ehRender*, ehPushHistory, ehStartRAF,
//                           ehSetTimelineWidth, ehDecodeWave, round3)
// ─────────────────────────────────────────────────────────────────────────────

const WT_PPS = 80; // pixels per second — matches app.js TAP_PPS

var wtAudio = null;
var wtRafId = null;

// ─── SVG helper (mic icon) ────────────────────────────────────────────────────
function _wtVocalsBtnHTML(label) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/></svg> ${label}`;
}

// ─── Open / start ─────────────────────────────────────────────────────────────
function openWordTapSync() {
  if (!EH.fileId && !EH.audioUrl) {
    ehUploadFile()
      .then(id => { if (id) _startWordTapOverlay(); })
      .catch(() => toast('Upload the audio file first.', 'error'));
  } else {
    _startWordTapOverlay();
  }
}

function _startWordTapOverlay() {
  // Parse lyrics, strip any existing timestamps
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

  // Vocals state
  const audioUrl       = EH.audioUrl || `/api/audio/${EH.fileId}`;
  EH.wtOriginalUrl     = audioUrl;
  EH.wtVocalsUrl       = null;
  EH.wtUseVocals       = false;
  EH.wtSongPeaks       = null;
  EH.wtVocalPeaks      = null;
  EH.wtIsolating       = false;

  // Show overlay first — must be visible before reading clientWidth for canvas sizing
  const overlay = ehEl('wordTapOverlay');
  if (overlay) { overlay.classList.remove('hidden'); overlay.focus(); }

  _wtInitCanvas();

  // Vocals button — show when UVR is known available (use global uvrAvailable from
  // shared.js as primary; fall back to EH.uvrAvail if that's already resolved).
  // EH.uvrAvail starts as null (async check) so we can't rely on it alone.
  const uvrOk = uvrAvailable === true || EH.uvrAvail === true;
  const vBtn = ehEl('wtVocalsBtn');
  if (vBtn) {
    vBtn.style.display = uvrOk ? 'inline-flex' : 'none';
    vBtn.className     = 'btn btn-ghost btn-sm tap-vocals-btn';
    vBtn.disabled      = false;
    vBtn.innerHTML     = _wtVocalsBtnHTML('Vocals');
  }

  // Isolating screen — ensure hidden
  _wtIsolatingHide();

  // Audio — if auto-vocals is on, don't play yet; wait for isolation to finish
  const autoVocals = ehEl('wtVocalsAutoToggle')?.checked && uvrOk;
  if (wtAudio) { wtAudio.pause(); wtAudio.src = ''; }
  wtAudio = new Audio(audioUrl);
  wtAudio.volume = +(ehEl('ehVolumeSlider')?.value ?? 1);
  if (!autoVocals) wtAudio.play();

  // Decode song peaks at WT_PPS resolution for the scrolling waveform
  EH.wtPeaks    = null;
  EH.wtPeaksDur = 0;
  _wtDecodeSongPeaks(audioUrl);

  ehEl('wtPhaseLabel').textContent    = 'Word Tap';
  ehEl('wtCountDisplay').textContent  = `0 / ${EH.wtFlat.length}`;

  _wtUpdateWordDisplay();
  _wtDrawWave();
  _wtStartRaf();

  // Auto-start isolation — audio will begin only after vocals are ready
  if (autoVocals) _wtRunIsolation();
}

// ─── Canvas init ──────────────────────────────────────────────────────────────
function _wtInitCanvas() {
  const canvas = ehEl('wtWaveCanvas');
  if (!canvas) return;
  canvas.width  = canvas.parentElement ? canvas.parentElement.clientWidth : window.innerWidth;
  canvas.height = 64;
}

// ─── Peak decode ──────────────────────────────────────────────────────────────
async function _wtDecodeSongPeaks(url) {
  try {
    const { peaks, duration } = await decodeAudioPeaks(url, WT_PPS);
    EH.wtSongPeaks = peaks;
    EH.wtPeaksDur  = duration;
    if (!EH.wtUseVocals) EH.wtPeaks = EH.wtSongPeaks;
  } catch (_) {}
}

async function _wtDecodeVocalsPeaks(url) {
  try {
    const { peaks, duration } = await decodeAudioPeaks(url, WT_PPS);
    EH.wtVocalPeaks = peaks;
    EH.wtPeaksDur   = duration;
    if (EH.wtUseVocals) EH.wtPeaks = EH.wtVocalPeaks;
  } catch (_) {}
}

// ─── Audio switch (preserve position) ────────────────────────────────────────
// forcePlay: true = always play, false = never play, undefined = mirror wasPlaying
function _wtSwitchAudio(url, forcePlay) {
  if (!url) return;
  const shouldPlay = forcePlay !== undefined ? !!forcePlay : !!(wtAudio && !wtAudio.paused);
  const prevTime   = (wtAudio && isFinite(wtAudio.currentTime)) ? wtAudio.currentTime : 0;
  if (wtAudio) { wtAudio.pause(); wtAudio.src = ''; }
  const audio = new Audio(url);
  wtAudio = audio;
  audio.preload = 'auto';
  audio.volume  = +(ehEl('ehVolumeSlider')?.value ?? 1);
  audio.addEventListener('canplay', function onCanPlay() {
    audio.removeEventListener('canplay', onCanPlay);
    if (audio !== wtAudio) return; // overlay was closed or audio switched again
    if (prevTime > 0.05) audio.currentTime = prevTime;
    if (shouldPlay) audio.play().catch(() => {});
  }, { once: true });
  audio.load();
}

// ─── Isolating screen helpers ─────────────────────────────────────────────────
function _wtIsolatingShow(status, pct) {
  const scr = ehEl('wtIsolatingScreen');
  if (!scr) return;
  scr.classList.remove('hidden');
  const st  = ehEl('wtIsolatingStatus'); if (st)  st.textContent  = status;
  const bar = ehEl('wtIsolatingBar');    if (bar) bar.style.width = pct + '%';
  const p   = ehEl('wtIsolatingPct');   if (p)   p.textContent   = pct + '%';
}

function _wtIsolatingHide() {
  ehEl('wtIsolatingScreen')?.classList.add('hidden');
}

// ─── Vocals isolation (mirrors runTapVocalsIsolation in app-tap.js) ───────────
async function _wtRunIsolation() {
  if (EH.wtIsolating) return;

  // If the file hasn't been uploaded to the server yet (local blob URL only),
  // upload it now so we get a fileId for the isolation API.
  if (!EH.fileId) {
    const btn = ehEl('wtVocalsBtn');
    if (btn) { btn.disabled = true; }
    _wtIsolatingShow('Uploading audio…', 0);
    const id = await ehUploadFile();
    if (!id) {
      _wtIsolatingHide();
      if (btn) { btn.disabled = false; }
      toast('Upload failed — cannot isolate vocals.', 'error');
      return;
    }
  }

  EH.wtIsolating = true;
  const btn      = ehEl('wtVocalsBtn');
  const uvrModel = ehEl('uvrModelSelect')?.value || 'UVR-MDX-NET-Inst_HQ_3';
  if (btn) { btn.disabled = true; btn.classList.add('loading'); }
  _wtIsolatingShow('Loading vocal model…', 0);

  try {
    const form = new FormData();
    form.append('file_id',      EH.fileId);
    form.append('uvr_model_id', uvrModel);
    const r = await fetch('/api/isolate', { method: 'POST', body: form });
    if (!r.ok) throw new Error('Isolation could not be started');
    const { job_id } = await r.json();

    while (EH.wtIsolating) {
      await sleep(1500);
      if (!EH.wtIsolating) break;
      const job = await fetch(`/api/job/${job_id}`).then(r => r.json());
      const pct = typeof job.progress === 'number' ? job.progress : 0;
      const statusMsg = job.status === 'separating_model' ? 'Loading vocal model…'
                      : job.status === 'separating'       ? 'Isolating vocals…'
                      : 'Processing…';
      _wtIsolatingShow(statusMsg, pct);
      if (btn) btn.innerHTML = _wtVocalsBtnHTML(`${pct}%`);

      if (job.status === 'done') {
        EH.wtVocalsUrl = `/api/vocals/${job_id}`;
        EH.wtUseVocals = true;
        EH.wtIsolating = false;
        _wtIsolatingHide();
        // forcePlay=true: always start — audio was held if auto-toggle triggered isolation
        _wtSwitchAudio(EH.wtVocalsUrl, true);
        _wtDecodeVocalsPeaks(EH.wtVocalsUrl);
        if (btn) {
          btn.disabled = false;
          btn.classList.remove('loading');
          btn.classList.add('active');
          btn.innerHTML = _wtVocalsBtnHTML('Vocals ●');
        }
        toast('Vocals isolated — waveform updated.', 'success');
        return;
      }
      if (job.status === 'error') throw new Error(job.error || 'Error');
    }

    // Skipped by user — fall back to original audio and start playing
    _wtIsolatingHide();
    EH.wtIsolating = false;
    if (wtAudio && wtAudio.paused) wtAudio.play().catch(() => {});
    if (btn) { btn.disabled = false; btn.classList.remove('loading'); btn.innerHTML = _wtVocalsBtnHTML('Vocals'); }
  } catch (e) {
    _wtIsolatingHide();
    EH.wtIsolating = false;
    // On error, fall back to original audio and start playing
    if (wtAudio && wtAudio.paused) wtAudio.play().catch(() => {});
    if (btn) { btn.disabled = false; btn.classList.remove('loading'); btn.innerHTML = _wtVocalsBtnHTML('Vocals'); }
    toast('Vocal isolation failed: ' + e.message, 'error');
  }
}

// ─── Toggle vocals (mirrors toggleTapVocals in app-tap.js) ───────────────────
function _wtToggleVocals() {
  if (EH.wtIsolating) return;
  if (!EH.wtVocalsUrl) { _wtRunIsolation(); return; }
  const btn = ehEl('wtVocalsBtn');
  if (EH.wtUseVocals) {
    EH.wtUseVocals = false;
    EH.wtPeaks     = EH.wtSongPeaks;
    _wtSwitchAudio(EH.wtOriginalUrl);
    if (btn) { btn.classList.remove('active'); btn.innerHTML = _wtVocalsBtnHTML('Vocals'); }
  } else {
    EH.wtUseVocals = true;
    EH.wtPeaks     = EH.wtVocalPeaks;
    _wtSwitchAudio(EH.wtVocalsUrl);
    if (btn) { btn.classList.add('active'); btn.innerHTML = _wtVocalsBtnHTML('Vocals ●'); }
  }
}

// ─── Word display update ──────────────────────────────────────────────────────
function _wtUpdateWordDisplay() {
  const cur = EH.wtFlat[EH.wtFlatIdx];
  if (!cur) return;

  const curLineIdx = cur.lineIdx;

  // Line label
  const ll = ehEl('wtLineLabel');
  if (ll) ll.textContent = `Line ${curLineIdx + 1} / ${cur.totalLines}`;

  // Current line — individual word spans (centered)
  const wrap = ehEl('wtWordsWrap');
  if (wrap) {
    wrap.innerHTML = '';
    const lineWords = EH.wtFlat.filter(w => w.lineIdx === curLineIdx);
    lineWords.forEach(w => {
      const flatIdx = EH.wtFlat.indexOf(w);
      const span = document.createElement('span');
      span.className = 'wt-word ' + (
        flatIdx < EH.wtFlatIdx   ? 'wt-done' :
        flatIdx === EH.wtFlatIdx ? 'wt-current' : 'wt-upcoming'
      );
      span.textContent = w.word;
      wrap.appendChild(span);
      if (flatIdx === EH.wtFlatIdx) {
        setTimeout(() => span.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' }), 0);
      }
    });
  }

  // All lines list — done / current / upcoming (same as renderTapLines in app-tap.js)
  const list = ehEl('wtLinesList');
  if (list) {
    list.innerHTML = '';
    const lineTexts = [];
    EH.wtFlat.forEach(w => { lineTexts[w.lineIdx] = w.lineText; });
    lineTexts.forEach((text, li) => {
      if (text === undefined) return;
      const div = document.createElement('div');
      div.className = 'tap-line';
      if (li < curLineIdx) {
        div.classList.add('tap-line-done');
        div.innerHTML = `<span class="tap-line-check">✓</span><span class="tap-line-text">${text}</span>`;
      } else if (li === curLineIdx) {
        div.classList.add('tap-line-current');
        div.innerHTML = `<span class="tap-line-text">${text}</span>`;
      } else {
        div.classList.add('tap-line-upcoming');
        div.innerHTML = `<span class="tap-line-text">${text}</span>`;
      }
      list.appendChild(div);
    });
    list.querySelector('.tap-line-current')
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  ehEl('wtCountDisplay').textContent = `${EH.wtFlatIdx} / ${EH.wtFlat.length}`;
}

// ─── RAF loop ─────────────────────────────────────────────────────────────────
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
    if (EH.wtFlatIdx <= EH.wtFlat.length) wtRafId = requestAnimationFrame(loop);
  }
  wtRafId = requestAnimationFrame(loop);
}

// ─── Scrolling waveform draw ──────────────────────────────────────────────────
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

  const playheadX = Math.floor(w * 0.3); // fixed at 30%, waveform scrolls past it

  if (!EH.wtPeaks) {
    // Loading placeholder — animated sinusoidal bars
    const step = 5;
    const amp  = h * 0.28;
    for (let px = 0; px < w; px += step) {
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

  const peaks      = EH.wtPeaks;
  const timeOffset = t - playheadX / WT_PPS; // time at canvas left edge (x=0)
  const mid        = h / 2;

  for (let px = 0; px < w; px++) {
    const sTime = timeOffset + px / WT_PPS;
    if (sTime < 0 || sTime > dur) continue;
    const sPx = Math.floor(sTime * WT_PPS);
    if (sPx >= peaks.length) continue;
    const amp = peaks[sPx] * mid * 0.92;
    ctx.fillStyle = px < playheadX
      ? (EH.wtUseVocals ? '#16a34a' : '#7c3aed')
      : (EH.wtUseVocals ? '#14532d' : '#22224a');
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

  // Green tick marks for each tapped word
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

// ─── Finish: build segments from tap times ────────────────────────────────────
function _wtFinish(lines) {
  if (wtRafId) cancelAnimationFrame(wtRafId);
  if (wtAudio) { wtAudio.pause(); }

  const songEnd   = wtAudio?.duration || 0;
  const lineCount = EH.wtFlat[EH.wtFlat.length - 1]?.lineIdx + 1 || lines.length;

  // lineIdx → first flat index
  const lineFirstFlat = {};
  EH.wtFlat.forEach((w, fi) => {
    if (lineFirstFlat[w.lineIdx] === undefined) lineFirstFlat[w.lineIdx] = fi;
  });

  const newSegs = [];
  for (let li = 0; li < lineCount; li++) {
    const lineFlat         = EH.wtFlat.filter(w => w.lineIdx === li);
    const lineStartFlatIdx = lineFirstFlat[li];
    const nextLineFlatIdx  = lineFirstFlat[li + 1];

    const lineStart = EH.wtTimes[lineStartFlatIdx] ?? 0;
    const lineEnd   = nextLineFlatIdx !== undefined
      ? (EH.wtTimes[nextLineFlatIdx] ?? songEnd)
      : songEnd;

    const words = lineFlat.map((w, wi) => {
      const fi     = lineStartFlatIdx + wi;
      const start  = EH.wtTimes[fi] ?? round3(lineStart + (lineEnd - lineStart) * wi / lineFlat.length);
      const nextFi = fi + 1;
      const end    = EH.wtTimes[nextFi] !== undefined
        ? EH.wtTimes[nextFi]
        : (wi < lineFlat.length - 1
            ? round3(start + (lineEnd - start) / (lineFlat.length - wi))
            : lineEnd);
      return { word: w.word, start: round3(start), end: round3(end) };
    });

    newSegs.push({
      id:    li,
      start: round3(lineStart),
      end:   round3(lineEnd),
      text:  lines[li] || lineFlat.map(w => w.word).join(' '),
      words,
    });
  }

  EH.segments      = newSegs;
  EH.wtFlat        = [];
  EH.wtTimes       = [];
  EH.wtFlatIdx     = 0;
  EH.wtPeaks       = null;
  EH.wtPeaksDur    = 0;
  EH.wtSongPeaks   = null;
  EH.wtVocalPeaks  = null;
  EH.wtOriginalUrl = null;
  EH.wtVocalsUrl   = null;
  EH.wtUseVocals   = false;
  EH.wtIsolating   = false;

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

  // Show vocals buttons if UVR is available — this path skips initEnhancedEditor
  if (EH.uvrAvail === null) checkUVR(); // async — calls ehUpdateVocalsBtns() when done
  else ehUpdateVocalsBtns();
}

// ─── Close / cancel ───────────────────────────────────────────────────────────
function closeWordTapOverlay() {
  EH.wtFlatIdx     = 0;
  EH.wtFlat        = [];
  EH.wtTimes       = [];
  EH.wtPeaks       = null;
  EH.wtPeaksDur    = 0;
  EH.wtSongPeaks   = null;
  EH.wtVocalPeaks  = null;
  EH.wtOriginalUrl = null;
  EH.wtVocalsUrl   = null;
  EH.wtUseVocals   = false;
  EH.wtIsolating   = false;
  if (wtRafId) { cancelAnimationFrame(wtRafId); wtRafId = null; }
  if (wtAudio) { wtAudio.pause(); wtAudio.src = ''; wtAudio = null; }
  _wtIsolatingHide();
  const overlay = ehEl('wordTapOverlay');
  if (overlay) overlay.classList.add('hidden');
  toast('Word tap sync cancelled.', '');
}

// ─── Keyboard handler ─────────────────────────────────────────────────────────
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
      const orderedLines = [];
      flat.forEach(w => { orderedLines[w.lineIdx] = w.lineText; });
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
      if (wtAudio) {
        const prevTime = EH.wtTimes[EH.wtFlatIdx - 1];
        wtAudio.currentTime = prevTime !== undefined ? Math.max(0, prevTime - 0.3) : 0;
      }
    }
  } else if (e.code === 'KeyS') {
    e.preventDefault();
    const prevT     = EH.wtFlatIdx > 0 ? (EH.wtTimes[EH.wtFlatIdx - 1] ?? 0) : 0;
    const dur       = wtAudio?.duration || 0;
    const remaining = flat.length - EH.wtFlatIdx;
    const gap       = remaining > 0 ? (dur - prevT) / remaining : 0;
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
