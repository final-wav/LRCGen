'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// ttml-editor.js — Multi-Lane Timeline, Syllable Editor, Waveform & Inspector
// ─────────────────────────────────────────────────────────────────────────────

function initStudioEditor() {
  // Timeline Zoom
  const zoomSlider = document.getElementById('zoomSlider');
  const zoomInBtn  = document.getElementById('zoomInBtn');
  const zoomOutBtn = document.getElementById('zoomOutBtn');
  const scrollArea = document.getElementById('tlScrollArea');

  if (zoomSlider) zoomSlider.addEventListener('input', e => applyZoom(+e.target.value));
  if (zoomInBtn)  zoomInBtn.addEventListener('click', () => applyZoom(Studio.pps * 1.3));
  if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => applyZoom(Studio.pps * 0.77));

  if (scrollArea) {
    scrollArea.addEventListener('wheel', e => {
      if (e.ctrlKey) {
        e.preventDefault();
        const redLineTime = (Studio.audio ? Studio.audio.currentTime : Studio.currentTime) || 0;
        applyZoom(Studio.pps * (e.deltaY < 0 ? 1.18 : 0.85), redLineTime);
      }
    }, { passive: false });
  }

  // Transport Controls
  document.getElementById('playPauseBtn')?.addEventListener('click', togglePlayPause);
  document.getElementById('seekBackBtn')?.addEventListener('click', () => seekAudio(-5));
  document.getElementById('seekFwdBtn')?.addEventListener('click',  () => seekAudio(+5));
  document.getElementById('volumeSlider')?.addEventListener('input', e => {
    Studio.volume = +e.target.value;
    if (Studio.audio) Studio.audio.volume = Studio.volume;
  });

  // Playback Speed Selector (0.25x, 0.5x, 0.75x, 1.0x)
  const speedSelect = document.getElementById('speedSelect');
  if (speedSelect) {
    speedSelect.value = String(Studio.playbackRate || 1);
    speedSelect.addEventListener('change', e => {
      const rate = parseFloat(e.target.value) || 1.0;
      Studio.playbackRate = rate;
      if (Studio.audio) Studio.audio.playbackRate = rate;
    });
  }

  // Undo / Redo
  document.getElementById('undoBtn')?.addEventListener('click', undo);
  document.getElementById('redoBtn')?.addEventListener('click', redo);

  // Line & Lane & Syllable Batch Actions
  document.getElementById('addLaneBtn')?.addEventListener('click', addVocalLane);
  document.getElementById('addLaneBtnMini')?.addEventListener('click', addVocalLane);
  document.getElementById('removeLaneBtn')?.addEventListener('click', removeVocalLane);
  document.getElementById('removeLaneBtnMini')?.addEventListener('click', removeVocalLane);
  document.getElementById('copySylBtn')?.addEventListener('click', copySelectedSyllables);
  document.getElementById('pasteSylBtn')?.addEventListener('click', pasteSyllables);
  document.getElementById('dupSylBtn')?.addEventListener('click', duplicateSelectedSyllables);
  document.getElementById('delSylBtn')?.addEventListener('click', deleteSelectedSyllables);
  document.getElementById('undoBtn')?.addEventListener('click', undo);
  document.getElementById('redoBtn')?.addEventListener('click', redo);
  document.getElementById('addLineBtn')?.addEventListener('click', addNewLineAtPlayhead);
  document.getElementById('snapToggleBtn')?.addEventListener('click', toggleSnapping);
  document.getElementById('sortLinesBtn')?.addEventListener('click', sortLinesByTimestamp);
  document.getElementById('alignTrackBtn')?.addEventListener('click', runTrackAlignment);
  document.getElementById('exportTrackTtmlBtn')?.addEventListener('click', exportSingleTrackTTML);
  document.getElementById('tapSyncModalBtn')?.addEventListener('click', () => {
    if (typeof openMultiVoiceTapSync === 'function') openMultiVoiceTapSync();
  });

  // Vocals Waveform Toggle
  document.getElementById('waveVocalsBtn')?.addEventListener('click', toggleVocalsWave);
  document.getElementById('vocalsAudioBtn')?.addEventListener('click', toggleVocalsAudio);

  // Timeline Mousedown / Marquee / Seek Handlers
  const tlInner = document.getElementById('tlInner');
  if (tlInner) {
    tlInner.addEventListener('mousedown', handleTimelineMouseDown);
  }
  const rulerTrack = document.getElementById('tlRulerTrack');
  if (rulerTrack) {
    rulerTrack.addEventListener('mousedown', e => {
      const rect = rulerTrack.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      seekToTimelinePx(clickX);
    });
  }
  const waveTrack = document.getElementById('tlWaveTrack');
  if (waveTrack) {
    waveTrack.addEventListener('mousedown', e => {
      const rect = waveTrack.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      seekToTimelinePx(clickX);
    });
  }

  function seekToTimelinePx(px) {
    const seekTime = Math.max(0, Math.min(Studio.duration || 1000, px / Studio.pps));
    if (Studio.audio) {
      Studio.audio.currentTime = seekTime;
      Studio.currentTime = seekTime;
      updatePlayheadDOM();
      if (typeof updateSweepPlayer === 'function') updateSweepPlayer(false);
    }
  }

  // Global Keyboard Shortcuts
  window.addEventListener('keydown', handleEditorKeyDown);
  window.addEventListener('resize', handleEditorResize);

  // Drag, Trim & Marquee listeners
  window.addEventListener('mousemove', handleDragMove);
  window.addEventListener('mouseup', handleDragEnd);
}

// ─── Line Selection & Vocal Role Helpers ─────────────────────────────────────
function selectLine(lineId) {
  Studio.selectedLineId = lineId;
  const lyrics = getActiveLyrics();
  const line = (lyrics.lines || []).find(l => l.id === lineId);
  if (line) {
    if (Studio.selectedSyllables.size === 0) {
      Studio.selectedSylIdx = 0;
      Studio.selectedIsAdlib = false;
    }
  }
  renderTimelineLines();
  renderInspectorLines();
}

function toggleSingerAgent(newAgent) {
  const lyrics = getActiveLyrics();
  const line = (lyrics.lines || []).find(l => l.id === Studio.selectedLineId);
  if (!line) return;

  pushHistory();
  line.agent = newAgent || (line.agent === 'v2' ? 'v1' : 'v2');
  line.side = line.agent === 'v2' ? 'left' : 'right';
  line.laneIndex = line.agent === 'v2' ? 1 : 0;
  
  (line.rawSyllabi || []).forEach(s => {
    if (s.lane === undefined || s.lane === 0 || s.lane === 1) {
      s.lane = line.agent === 'v2' ? 1 : 0;
    }
  });

  saveActiveTrackToBackend();
  refreshEditorViews();
  toast(`Stimme auf ${line.agent.toUpperCase()} (${line.side}) geändert.`, 'success');
}

function toggleAdlibRole() {
  const lyrics = getActiveLyrics();
  const line = (lyrics.lines || []).find(l => l.id === Studio.selectedLineId);
  if (!line) return;

  pushHistory();
  if (line.adlib) {
    line.text = line.adlib;
    line.adlib = null;
    line.rawSyllabi = (line.adlibSyllabi || []).map(s => ({ ...s, lane: line.agent === 'v2' ? 1 : 0 }));
    line.adlibSyllabi = [];
  } else {
    line.adlib = line.text;
    line.text = '';
    line.adlibSyllabi = (line.rawSyllabi || []).map(s => ({ ...s, lane: 3 }));
    line.rawSyllabi = [];
  }

  saveActiveTrackToBackend();
  refreshEditorViews();
  toast(line.adlib ? 'Zeile als Ad-lib (x-bg) markiert.' : 'Zeile als Hauptgesang markiert.', 'success');
}

function toggleSnapping() {
  Studio.snapEnabled = !Studio.snapEnabled;
  updateSnapBtnUI();
  toast(Studio.snapEnabled ? 'Magnetisches Snappen: EIN [S]' : 'Magnetisches Snappen: AUS [S]', 'success');
}

function updateSnapBtnUI() {
  const btn = document.getElementById('snapToggleBtn');
  if (btn) {
    btn.classList.toggle('active', !!Studio.snapEnabled);
  }
}

// ─── Audio Initialization ───────────────────────────────────────────────────
function initStudioAudio(url) {
  if (Studio.audio) {
    Studio.audio.pause();
    Studio.audio.src = '';
  }

  Studio.audio = new Audio(url);
  Studio.audio.volume = Studio.volume;
  Studio.audio.playbackRate = Studio.playbackRate || 1.0;
  Studio.duration = 0;
  Studio.currentTime = 0;
  Studio.isPlaying = false;
  Studio.wavePeaks = null;
  Studio.audioBuf = null;
  Studio.vocalsWavePeaks = null;
  Studio.vocalsAudioBuf = null;

  Studio.audio.addEventListener('loadedmetadata', () => {
    Studio.duration = Studio.audio.duration;
    const durEl = document.getElementById('durationDisplay');
    if (durEl) durEl.textContent = fmt(Studio.duration);

    layoutTimeline();
    decodeAudioForWaveform(url);
  });

  Studio.audio.addEventListener('timeupdate', () => {
    if (!Studio.audio || Studio.audio.paused) {
      Studio.currentTime = Studio.audio.currentTime;
      const timeEl = document.getElementById('currentTimeDisplay');
      if (timeEl) timeEl.textContent = fmt(Studio.currentTime);
      updatePlayheadDOM();
      if (typeof updateSweepPlayer === 'function') updateSweepPlayer(false);
    }
  });

  Studio.audio.addEventListener('play',  () => setPlayUI(true));
  Studio.audio.addEventListener('pause', () => setPlayUI(false));
  Studio.audio.addEventListener('ended', () => setPlayUI(false));

  startStudioRAF();
}

function togglePlayPause() {
  if (!Studio.audio) return;
  if (Studio.isPlaying) Studio.audio.pause();
  else Studio.audio.play().catch(() => {});
}

function setPlayUI(playing) {
  Studio.isPlaying = playing;
  document.getElementById('iconPlay')?.classList.toggle('hidden', playing);
  document.getElementById('iconPause')?.classList.toggle('hidden', !playing);
}

function seekAudio(delta) {
  if (!Studio.audio || !Studio.duration) return;
  Studio.audio.currentTime = Math.max(0, Math.min(Studio.duration, Studio.audio.currentTime + delta));
}

// ─── Timeline Layout & Tiled Canvas Rendering (No Blur, No Canvas Crash) ───
const TILE_WIDTH = 2048;

function getTimelineTotalWidth() {
  const scrollArea = document.getElementById('tlScrollArea');
  const clientW = scrollArea ? scrollArea.clientWidth : 800;
  return Math.max(Math.ceil((Studio.duration || 10) * Studio.pps), clientW, 800);
}

function layoutTimeline() {
  const totalW = getTimelineTotalWidth();
  const inner  = document.getElementById('tlInner');

  if (inner) inner.style.width = totalW + 'px';
  renderRulerTiles();
  renderWaveformTiles();

  renderTimelineLines();
  renderTimelineSyllables();
  updatePlayheadDOM();
}

function handleEditorResize() {
  if (document.getElementById('mainWorkspace')?.classList.contains('hidden')) return;
  layoutTimeline();
}

function applyZoom(newPps, anchorTime = null) {
  const scrollArea = document.getElementById('tlScrollArea');
  const oldPps = Studio.pps;
  const targetPps = Math.max(20, Math.min(1600, newPps));
  if (Math.abs(targetPps - oldPps) < 0.001) return;

  // Anchor time: current playhead position (the red line)
  const redLineTime = (Studio.audio ? Studio.audio.currentTime : Studio.currentTime) || 0;
  const curTime = anchorTime !== null ? anchorTime : redLineTime;

  let relOffset = null;
  if (scrollArea) {
    const playheadPx = curTime * oldPps;
    relOffset = playheadPx - scrollArea.scrollLeft;
    // If the red line was outside the visible screen, center it in the viewport
    if (relOffset < 0 || relOffset > scrollArea.clientWidth) {
      relOffset = scrollArea.clientWidth / 2;
    }
  }

  Studio.pps = targetPps;
  const slider = document.getElementById('zoomSlider');
  if (slider) slider.value = Studio.pps;
  const label = document.getElementById('zoomLabel');
  if (label) label.textContent = `${Math.round(Studio.pps / 80 * 100)}%`;

  if (Studio.audioBuf)       Studio.wavePeaks       = computePeaksFromBuffer(Studio.audioBuf);
  if (Studio.vocalsAudioBuf) Studio.vocalsWavePeaks = computePeaksFromBuffer(Studio.vocalsAudioBuf);

  layoutTimeline();

  if (scrollArea && relOffset !== null) {
    const newPlayheadPx = curTime * Studio.pps;
    scrollArea.scrollLeft = Math.max(0, newPlayheadPx - relOffset);
  }
}

// ─── Waveform Decoding & Tiled GPU Canvas Drawing ───────────────────────────
async function decodeAudioForWaveform(url) {
  try {
    const { peaks, duration, audioBuf } = await decodeAudioPeaks(url, Studio.pps);
    Studio.audioBuf  = audioBuf;
    Studio.wavePeaks = peaks;
    renderWaveformTiles();
  } catch (e) {
    console.warn('Waveform decode failed:', e);
  }
}

function computePeaksFromBuffer(buf) {
  if (!buf) return null;
  const totalPx = Math.ceil((Studio.duration || buf.duration) * Studio.pps);
  const data    = buf.getChannelData(0);
  const sRate   = buf.sampleRate;
  const peaks   = new Float32Array(totalPx);
  for (let px = 0; px < totalPx; px++) {
    const iS = Math.floor(px * sRate / Studio.pps);
    const iE = Math.min(Math.ceil((px + 1) * sRate / Studio.pps), data.length);
    let mx = 0;
    for (let i = iS; i < iE; i++) {
      const v = Math.abs(data[i]);
      if (v > mx) mx = v;
    }
    peaks[px] = mx;
  }
  return peaks;
}

function renderRulerTiles() {
  const container = document.getElementById('tlRulerTrack');
  if (!container) return;
  container.innerHTML = '';

  const totalW = getTimelineTotalWidth();
  const numTiles = Math.ceil(totalW / TILE_WIDTH);
  const pps = Studio.pps;
  const h = 26;

  const step = pps >= 800 ? 0.25 : pps >= 400 ? 0.5 : pps >= 160 ? 1 : pps >= 60 ? 5 : pps >= 25 ? 10 : 30;

  for (let tileIdx = 0; tileIdx < numTiles; tileIdx++) {
    const tileStartX = tileIdx * TILE_WIDTH;
    const tileW = Math.min(TILE_WIDTH, totalW - tileStartX);
    if (tileW <= 0) break;

    const canvas = document.createElement('canvas');
    canvas.width = tileW;
    canvas.height = h;
    canvas.style.width = `${tileW}px`;
    canvas.style.height = `${h}px`;

    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#1c1c1c';
    ctx.fillRect(0, 0, tileW, h);

    ctx.font = '10px JetBrains Mono, Consolas, monospace';
    ctx.textBaseline = 'middle';

    const startSec = Math.max(0, Math.floor((tileStartX / pps) / step) * step);
    const endSec   = Math.min(Studio.duration || 100000, ((tileStartX + tileW) / pps) + step);

    for (let t = startSec; t <= endSec; t += step) {
      const vx = Math.round(t * pps - tileStartX);
      if (vx < 0 || vx >= tileW) continue;

      ctx.beginPath();
      ctx.moveTo(vx + 0.5, h - 7);
      ctx.lineTo(vx + 0.5, h);
      ctx.strokeStyle = '#383838';
      ctx.stroke();

      const m = Math.floor(t / 60);
      const s = Math.floor(t % 60);
      const ms = Math.round((t % 1) * 100);
      const label = step < 1 ? `${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
      ctx.fillStyle = '#8e8e8e';
      ctx.fillText(label, vx + 4, h / 2);
    }

    container.appendChild(canvas);
  }
}

function renderWaveformTiles() {
  const container = document.getElementById('tlWaveTrack');
  if (!container) return;
  container.innerHTML = '';

  const totalW = getTimelineTotalWidth();
  const numTiles = Math.ceil(totalW / TILE_WIDTH);
  const h = 72;
  const mid = h / 2;

  const peaks = (Studio.useVocalsWave && Studio.vocalsWavePeaks) ? Studio.vocalsWavePeaks : Studio.wavePeaks;
  const isVoc = Studio.useVocalsWave && Studio.vocalsWavePeaks;
  const fillColor = isVoc ? '#00b4d8' : '#1473e6';

  for (let tileIdx = 0; tileIdx < numTiles; tileIdx++) {
    const tileStartX = tileIdx * TILE_WIDTH;
    const tileW = Math.min(TILE_WIDTH, totalW - tileStartX);
    if (tileW <= 0) break;

    const canvas = document.createElement('canvas');
    canvas.width = tileW;
    canvas.height = h;
    canvas.style.width = `${tileW}px`;
    canvas.style.height = `${h}px`;

    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#121212';
    ctx.fillRect(0, 0, tileW, h);

    if (peaks && peaks.length > 0) {
      ctx.fillStyle = fillColor;
      for (let vx = 0; vx < tileW; vx++) {
        const px = tileStartX + vx;
        if (px >= peaks.length) break;
        const amp = peaks[px];
        if (amp <= 0.001) continue;
        const bh = Math.max(1, amp * h * 0.92);
        ctx.fillRect(vx, mid - bh / 2, 1, bh);
      }
    }

    container.appendChild(canvas);
  }
}

var lastRenderedSecFormatted = '';

function updatePlayheadDOM() {
  const ph = document.getElementById('tlPlayhead');
  if (!ph) return;
  const x = (Studio.currentTime || 0) * Studio.pps;
  ph.style.left = `${x}px`;

  if (Studio.isPlaying) {
    const scroll = document.getElementById('tlScrollArea');
    if (scroll) {
      const visW = scroll.clientWidth;
      const left = scroll.scrollLeft;
      if (x > left + visW * 0.85) scroll.scrollLeft = x - visW * 0.3;
      if (x < left) scroll.scrollLeft = Math.max(0, x - 40);
    }
  }
}

function startStudioRAF() {
  if (Studio.rafId) cancelAnimationFrame(Studio.rafId);

  function loop() {
    if (Studio.audio && !Studio.audio.paused) {
      Studio.currentTime = Studio.audio.currentTime;
      const formatted = fmt(Studio.currentTime);
      if (formatted !== lastRenderedSecFormatted) {
        lastRenderedSecFormatted = formatted;
        const timeEl = document.getElementById('currentTimeDisplay');
        if (timeEl) timeEl.textContent = formatted;
      }
      updatePlayheadDOM();
      if (typeof updateSweepPlayer === 'function') {
        updateSweepPlayer(false);
      }
    }
    Studio.rafId = requestAnimationFrame(loop);
  }

  Studio.rafId = requestAnimationFrame(loop);
}

// ─── Multi-Lane Timeline Rendering ───────────────────────────────────────────
function renderTimelineLines() {
  const track = document.getElementById('tlLinesTrack');
  if (!track) return;
  track.innerHTML = '';

  const lyrics = getActiveLyrics();
  const lines  = lyrics.lines || [];

  // Add horizontal lane guide line between Lines 1 and Lines 2
  const guide = document.createElement('div');
  guide.className = 'tl-lines-track-guide';
  track.appendChild(guide);

  lines.forEach(line => {
    const x = line.start * Studio.pps;
    const w = Math.max(6, (line.end - line.start) * Studio.pps);
    const trackLane = line.laneIndex !== undefined ? line.laneIndex : (line.agent === 'v2' ? 1 : 0);
    const topPx = trackLane === 1 ? 43 : 3;
    const blockH = 34;

    const div = document.createElement('div');
    div.className = 'tl-line-block' +
      (line.id === Studio.selectedLineId ? ' selected' : '') +
      (line.agent === 'v2' ? ' duet-v2' : '') +
      (trackLane > 0 ? ` lane-offset-${trackLane}` : '');
    div.style.left   = `${x}px`;
    div.style.width  = `${w}px`;
    div.style.top    = `${topPx}px`;
    div.style.height = `${blockH}px`;
    div.dataset.lineId = line.id;

    const span = document.createElement('span');
    span.className = 'tl-line-text';
    span.textContent = line.text || (line.adlib ? `(${line.adlib})` : '…');
    div.appendChild(span);

    // Left & Right Trim Handles
    const el = document.createElement('div'); el.className = 'tl-edge tl-edge-l';
    const er = document.createElement('div'); er.className = 'tl-edge tl-edge-r';
    div.appendChild(el); div.appendChild(er);

    el.addEventListener('mousedown', e => startDrag(e, 'line', line.id, null, 'left'));
    er.addEventListener('mousedown', e => startDrag(e, 'line', line.id, null, 'right'));
    div.addEventListener('mousedown', e => {
      if (e.target.classList.contains('tl-edge')) return;
      selectLine(line.id);
      startDrag(e, 'line', line.id, null, 'move');
    });

    div.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      editLineText(line.id, div);
    });
    track.appendChild(div);
  });
}

// ─── Syllable Selection Helpers ─────────────────────────────────────────────
function getSyllableKey(lineId, isAdlib, sIdx) {
  return `${lineId}__${isAdlib ? 'ad' : 'raw'}__${sIdx}`;
}

function isSyllableSelected(lineId, isAdlib, sIdx) {
  return Studio.selectedSyllables.has(getSyllableKey(lineId, isAdlib, sIdx));
}

function selectSingleSyllable(lineId, sIdx, isAdlib) {
  Studio.selectedSyllables.clear();
  Studio.selectedLineId = lineId;
  Studio.selectedSylIdx = sIdx;
  Studio.selectedIsAdlib = isAdlib;

  const lyrics = getActiveLyrics();
  const line = (lyrics.lines || []).find(l => l.id === lineId);
  if (line) {
    const list = isAdlib ? line.adlibSyllabi : line.rawSyllabi;
    const syl = list ? list[sIdx] : null;
    if (syl) {
      Studio.selectedSyllables.set(getSyllableKey(lineId, isAdlib, sIdx), { lineId, isAdlib, sIdx, syl });
    }
  }

  updateSelectionBadge();
  renderTimelineSyllables();
}

function toggleSyllableSelection(lineId, sIdx, isAdlib) {
  const key = getSyllableKey(lineId, isAdlib, sIdx);
  if (Studio.selectedSyllables.has(key)) {
    Studio.selectedSyllables.delete(key);
    if (Studio.selectedSyllables.size === 0) {
      Studio.selectedSylIdx = null;
    }
  } else {
    const lyrics = getActiveLyrics();
    const line = (lyrics.lines || []).find(l => l.id === lineId);
    if (line) {
      const list = isAdlib ? line.adlibSyllabi : line.rawSyllabi;
      const syl = list ? list[sIdx] : null;
      if (syl) {
        Studio.selectedSyllables.set(key, { lineId, isAdlib, sIdx, syl });
        Studio.selectedLineId = lineId;
        Studio.selectedSylIdx = sIdx;
        Studio.selectedIsAdlib = isAdlib;
      }
    }
  }

  updateSelectionBadge();
  renderTimelineSyllables();
}

function clearSyllableSelection() {
  Studio.selectedSyllables.clear();
  Studio.selectedSylIdx = null;
  Studio.selectedIsAdlib = false;
  updateSelectionBadge();
  renderTimelineSyllables();
}

function selectAllSyllables() {
  Studio.selectedSyllables.clear();
  const lyrics = getActiveLyrics();
  (lyrics.lines || []).forEach(line => {
    (line.rawSyllabi || []).forEach((syl, sIdx) => {
      Studio.selectedSyllables.set(getSyllableKey(line.id, false, sIdx), { lineId: line.id, isAdlib: false, sIdx, syl });
    });
    (line.adlibSyllabi || []).forEach((syl, sIdx) => {
      Studio.selectedSyllables.set(getSyllableKey(line.id, true, sIdx), { lineId: line.id, isAdlib: true, sIdx, syl });
    });
  });
  updateSelectionBadge();
  renderTimelineSyllables();
  toast(`${Studio.selectedSyllables.size} Silben ausgewählt (Alle)`, 'success');
}

function updateSelectionBadge() {
  const badge = document.getElementById('tlSelectionBadge');
  if (!badge) return;
  const count = Studio.selectedSyllables.size;
  if (count > 0) {
    badge.textContent = `${count} ausgewählt`;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function addVocalLane() {
  Studio.numLanes = (Studio.numLanes || 4) + 1;
  renderTimelineSyllables();
  toast(`Ebene hinzugefügt (Jetzt ${Studio.numLanes} Ebenen)`, 'success');
}

function removeVocalLane() {
  if ((Studio.numLanes || 4) <= 2) {
    toast('Mindestens 2 Ebenen bleiben erhalten.', 'error');
    return;
  }
  Studio.numLanes = (Studio.numLanes || 4) - 1;
  renderTimelineSyllables();
  toast(`Ebene entfernt (noch ${Studio.numLanes} Ebenen)`, 'success');
}

// ─── Multi-Lane Timeline Rendering ───────────────────────────────────────────
function renderTimelineSyllables() {
  const track = document.getElementById('tlSyllablesTrack');
  if (!track) return;
  track.innerHTML = '';

  const lyrics = getActiveLyrics();
  const lines  = lyrics.lines || [];

  // Determine highest lane in use
  let maxLane = 0;
  lines.forEach(l => {
    (l.rawSyllabi || []).forEach(s => {
      const ln = s.lane !== undefined ? s.lane : 0;
      if (ln > maxLane) maxLane = ln;
    });
    (l.adlibSyllabi || []).forEach(s => {
      const ln = s.lane !== undefined ? s.lane : 3;
      if (ln > maxLane) maxLane = ln;
    });
  });

  Studio.numLanes = Math.max(Studio.numLanes || 4, maxLane + 1, 4);
  const laneH = Studio.laneHeight || 44;
  const totalH = Studio.numLanes * laneH;
  track.style.height = `${totalH}px`;

  // Update left labels header
  const headerCell = document.getElementById('tlLanesHeaderCell');
  if (headerCell) {
    headerCell.style.height = `${totalH + 28}px`;
  }
  const labelsWrap = document.getElementById('tlLanesLabelsWrap');
  if (labelsWrap) {
    labelsWrap.innerHTML = '';
    for (let i = 0; i < Studio.numLanes; i++) {
      const lbl = document.createElement('div');
      lbl.className = `tl-lane-label-item lane-${i}`;
      lbl.style.height = `${laneH}px`;
      lbl.textContent = `Ebene ${i + 1}`;
      labelsWrap.appendChild(lbl);
    }
  }

  // Horizontal lane guide lines
  for (let i = 1; i < Studio.numLanes; i++) {
    const guide = document.createElement('div');
    guide.className = 'tl-lane-guide';
    guide.style.top = `${i * laneH}px`;
    track.appendChild(guide);
  }

  // Render Syllables
  lines.forEach(line => {
    // 1. Raw Syllables (Default to lane 0 or assigned lane)
    (line.rawSyllabi || []).forEach((syl, sIdx) => {
      const lane = Math.min(Studio.numLanes - 1, syl.lane !== undefined ? syl.lane : 0);
      const x = (syl.time / 1000) * Studio.pps;
      const w = Math.max(4, (syl.duration / 1000) * Studio.pps);
      const isSelected = isSyllableSelected(line.id, false, sIdx);

      const chip = document.createElement('div');
      chip.className = 'syl-chip' +
        ` lane-${lane}` +
        (syl.isSubSyllable ? ' sub-syl' : '') +
        (line.agent === 'v2' ? ' duet' : '') +
        (isSelected ? (Studio.selectedSyllables.size > 1 ? ' multi-selected' : ' selected') : '');
      chip.style.left  = `${x}px`;
      chip.style.width = `${w}px`;
      chip.style.top   = `${lane * laneH + 4}px`;
      chip.dataset.lineId = line.id;
      chip.dataset.sIdx = sIdx;
      chip.dataset.isAdlib = '0';

      const span = document.createElement('span');
      span.className = 'syl-chip-text';
      span.textContent = syl.text;
      chip.appendChild(span);

      const el = document.createElement('div'); el.className = 'tl-edge tl-edge-l';
      const er = document.createElement('div'); er.className = 'tl-edge tl-edge-r';
      chip.appendChild(el); chip.appendChild(er);

      el.addEventListener('mousedown', e => startDrag(e, 'syl', line.id, sIdx, 'left', false));
      er.addEventListener('mousedown', e => startDrag(e, 'syl', line.id, sIdx, 'right', false));
      chip.addEventListener('mousedown', e => {
        if (e.target.classList.contains('tl-edge')) return;
        if (e.shiftKey || e.ctrlKey || e.metaKey) {
          e.preventDefault();
          e.stopPropagation();
          toggleSyllableSelection(line.id, sIdx, false);
          return;
        }
        if (!isSyllableSelected(line.id, false, sIdx)) {
          selectSingleSyllable(line.id, sIdx, false);
        }
        startDrag(e, 'syl', line.id, sIdx, 'move', false);
      });
      chip.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        editSyllableText(line.id, sIdx, false, chip);
      });
      track.appendChild(chip);
    });

    // 2. Ad-lib Syllables
    (line.adlibSyllabi || []).forEach((syl, sIdx) => {
      const lane = syl.lane !== undefined ? syl.lane : Math.min(3, Studio.numLanes - 1);
      const x = (syl.time / 1000) * Studio.pps;
      const w = Math.max(4, (syl.duration / 1000) * Studio.pps);
      const isSelected = isSyllableSelected(line.id, true, sIdx);

      const chip = document.createElement('div');
      chip.className = 'syl-chip adlib' +
        ` lane-${lane}` +
        (isSelected ? (Studio.selectedSyllables.size > 1 ? ' multi-selected' : ' selected') : '');
      chip.style.left  = `${x}px`;
      chip.style.width = `${w}px`;
      chip.style.top   = `${lane * laneH + 4}px`;
      chip.dataset.lineId = line.id;
      chip.dataset.sIdx = sIdx;
      chip.dataset.isAdlib = '1';

      const span = document.createElement('span');
      span.className = 'syl-chip-text';
      span.textContent = syl.text;
      chip.appendChild(span);

      const el = document.createElement('div'); el.className = 'tl-edge tl-edge-l';
      const er = document.createElement('div'); er.className = 'tl-edge tl-edge-r';
      chip.appendChild(el); chip.appendChild(er);

      el.addEventListener('mousedown', e => startDrag(e, 'syl', line.id, sIdx, 'left', true));
      er.addEventListener('mousedown', e => startDrag(e, 'syl', line.id, sIdx, 'right', true));
      chip.addEventListener('mousedown', e => {
        if (e.target.classList.contains('tl-edge')) return;
        if (e.shiftKey || e.ctrlKey || e.metaKey) {
          e.preventDefault();
          e.stopPropagation();
          toggleSyllableSelection(line.id, sIdx, true);
          return;
        }
        if (!isSyllableSelected(line.id, true, sIdx)) {
          selectSingleSyllable(line.id, sIdx, true);
        }
        startDrag(e, 'syl', line.id, sIdx, 'move', true);
      });
      chip.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        editSyllableText(line.id, sIdx, true, chip);
      });
      track.appendChild(chip);
    });
  });
}

// ─── Marquee Selection Engine (Windows Desktop Style) ──────────────────────
function handleTimelineMouseDown(e) {
  // If clicking directly on a chip, line block, or trim handle, let their drag handler proceed
  if (e.target.closest('.syl-chip') || e.target.closest('.tl-edge') || e.target.closest('.tl-line-block')) return;

  const inner = document.getElementById('tlInner');
  if (!inner) return;

  const initialKeys = new Set((e.shiftKey || e.ctrlKey || e.metaKey) ? Studio.selectedSyllables.keys() : []);
  if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
    Studio.selectedSyllables.clear();
    Studio.selectedSylIdx = null;
    updateSelectionBadge();
    renderTimelineSyllables();
  }

  const innerRect = inner.getBoundingClientRect();
  const startInnerX = e.clientX - innerRect.left;
  const startInnerY = e.clientY - innerRect.top;

  Studio.marquee = {
    active: true,
    moved: false,
    startClientX: e.clientX,
    startClientY: e.clientY,
    startInnerX,
    startInnerY,
    initialKeys,
  };
}

// ─── Drag & Trim & Multi-Batch Move Engine ──────────────────────────────────
function startDrag(e, type, lineId, sylIdx, handle, isAdlib = false) {
  e.preventDefault();
  e.stopPropagation();

  const lyrics = getActiveLyrics();
  const line   = (lyrics.lines || []).find(l => l.id === lineId);
  if (!line) return;

  pushHistory();

  if (type === 'line') {
    Studio.drag = {
      type: 'line', lineId, handle, startX: e.clientX,
      origStart: line.start, origEnd: line.end,
      origRawSylls: JSON.parse(JSON.stringify(line.rawSyllabi || [])),
      origAdlibSylls: JSON.parse(JSON.stringify(line.adlibSyllabi || [])),
    };
  } else {
    // Multi-Syllable Batch Drag
    const sylList = isAdlib ? line.adlibSyllabi : line.rawSyllabi;
    const syl = sylList ? sylList[sylIdx] : null;
    if (!syl) return;

    if (!isSyllableSelected(lineId, isAdlib, sylIdx)) {
      Studio.selectedSyllables.clear();
      Studio.selectedSyllables.set(getSyllableKey(lineId, isAdlib, sylIdx), { lineId, isAdlib, sIdx: sylIdx, syl });
      Studio.selectedLineId = lineId;
      Studio.selectedSylIdx = sylIdx;
      Studio.selectedIsAdlib = isAdlib;
      updateSelectionBadge();
    }

    const items = [];
    Studio.selectedSyllables.forEach(item => {
      const l = (lyrics.lines || []).find(li => li.id === item.lineId);
      if (!l) return;
      const list = item.isAdlib ? l.adlibSyllabi : l.rawSyllabi;
      const s = list ? list[item.sIdx] : null;
      if (!s) return;
      const origLane = s.lane !== undefined ? s.lane : (item.isAdlib ? 3 : (l.agent === 'v2' ? 1 : 0));
      items.push({
        lineId: item.lineId,
        isAdlib: item.isAdlib,
        sIdx: item.sIdx,
        syl: s,
        origTime: s.time,
        origDur: s.duration,
        origLane: origLane,
      });
    });

    Studio.drag = {
      type: 'syl_multi',
      handle,
      startX: e.clientX,
      startY: e.clientY,
      items,
    };
  }
}

function handleDragMove(e) {
  // 1. Handle Marquee Selection (Windows-style rubberband)
  if (Studio.marquee && Studio.marquee.active) {
    const dist = Math.hypot(e.clientX - Studio.marquee.startClientX, e.clientY - Studio.marquee.startClientY);
    if (dist > 3) {
      Studio.marquee.moved = true;
    }

    if (Studio.marquee.moved) {
      const inner = document.getElementById('tlInner');
      const box = document.getElementById('tlMarqueeBox');
      if (!inner || !box) return;

      const innerRect = inner.getBoundingClientRect();
      const curInnerX = e.clientX - innerRect.left;
      const curInnerY = e.clientY - innerRect.top;

      const x1 = Math.min(Studio.marquee.startInnerX, curInnerX);
      const y1 = Math.min(Studio.marquee.startInnerY, curInnerY);
      const w = Math.abs(curInnerX - Studio.marquee.startInnerX);
      const h = Math.abs(curInnerY - Studio.marquee.startInnerY);

      box.style.left = `${x1}px`;
      box.style.top = `${y1}px`;
      box.style.width = `${w}px`;
      box.style.height = `${h}px`;
      box.classList.remove('hidden');

      const selLeft   = Math.min(Studio.marquee.startClientX, e.clientX);
      const selRight  = Math.max(Studio.marquee.startClientX, e.clientX);
      const selTop    = Math.min(Studio.marquee.startClientY, e.clientY);
      const selBottom = Math.max(Studio.marquee.startClientY, e.clientY);

      // Test intersection with all chips in viewport client coordinates
      const chips = document.querySelectorAll('.syl-chip');
      const lyrics = getActiveLyrics();

      chips.forEach(chip => {
        const chipLineId  = chip.dataset.lineId;
        const chipSIdx    = parseInt(chip.dataset.sIdx, 10);
        const chipIsAdlib = chip.dataset.isAdlib === '1';
        const key         = getSyllableKey(chipLineId, chipIsAdlib, chipSIdx);

        const cr = chip.getBoundingClientRect();
        const intersects = !(cr.right < selLeft || cr.left > selRight || cr.bottom < selTop || cr.top > selBottom);

        if (intersects) {
          if (!Studio.selectedSyllables.has(key)) {
            const line = (lyrics.lines || []).find(l => l.id === chipLineId);
            if (line) {
              const list = chipIsAdlib ? line.adlibSyllabi : line.rawSyllabi;
              const syl = list ? list[chipSIdx] : null;
              if (syl) {
                Studio.selectedSyllables.set(key, { lineId: chipLineId, isAdlib: chipIsAdlib, sIdx: chipSIdx, syl });
              }
            }
          }
          chip.classList.add('multi-selected');
          chip.classList.remove('selected');
        } else {
          if (!Studio.marquee.initialKeys.has(key)) {
            Studio.selectedSyllables.delete(key);
            chip.classList.remove('multi-selected');
            chip.classList.remove('selected');
          }
        }
      });

      updateSelectionBadge();
    }
    return;
  }

  // 2. Handle Object Dragging
  if (!Studio.drag) return;
  const dg = Studio.drag;
  const rawDeltaSec = (e.clientX - dg.startX) / Studio.pps;
  let deltaSec = rawDeltaSec;
  let deltaMs  = Math.round(deltaSec * 1000);
  const laneH    = Studio.laneHeight || 44;
  const deltaLane = Math.round((e.clientY - dg.startY) / laneH);

  const lyrics = getActiveLyrics();
  const snapLineEl = document.getElementById('tlSnapLine');
  let snappedSec = null;

  // ── Adobe Premiere Magnetic Snapping Engine (Snap Distance + Force Threshold) ──
  const SNAP_DIST_PX = 12; // Snap radius in screen pixels
  const snapThresholdSec = SNAP_DIST_PX / Studio.pps;

  if (Studio.snapEnabled && !e.altKey) {
    // Collect all snap candidate boundaries across the timeline
    const snapCandidates = [];
    
    // Playhead is always a snap target
    const playheadTime = (Studio.audio ? Studio.audio.currentTime : Studio.currentTime) || 0;
    snapCandidates.push(playheadTime);

    if (dg.type === 'line') {
      // Line blocks of other lines
      (lyrics.lines || []).forEach(l => {
        if (l.id !== dg.lineId) {
          snapCandidates.push(l.start);
          snapCandidates.push(l.end);
        }
      });

      const lineDur = dg.origEnd - dg.origStart;
      let rawStart = Math.max(0, dg.origStart + rawDeltaSec);
      let rawEnd   = rawStart + lineDur;

      if (dg.handle === 'move') {
        let bestDist = snapThresholdSec;
        let snapDelta = 0;

        snapCandidates.forEach(cand => {
          // Snap start edge to candidate
          const distStart = Math.abs(cand - rawStart);
          if (distStart < bestDist) {
            bestDist = distStart;
            snapDelta = cand - dg.origStart;
            snappedSec = cand;
          }
          // Snap end edge to candidate
          const distEnd = Math.abs(cand - rawEnd);
          if (distEnd < bestDist) {
            bestDist = distEnd;
            snapDelta = (cand - lineDur) - dg.origStart;
            snappedSec = cand;
          }
        });

        if (snappedSec !== null) {
          deltaSec = snapDelta;
          deltaMs  = Math.round(deltaSec * 1000);
        }
      } else if (dg.handle === 'left') {
        let bestDist = snapThresholdSec;
        snapCandidates.forEach(cand => {
          const dist = Math.abs(cand - rawStart);
          if (dist < bestDist && cand < dg.origEnd - 0.05) {
            bestDist = dist;
            deltaSec = cand - dg.origStart;
            snappedSec = cand;
          }
        });
      } else if (dg.handle === 'right') {
        let bestDist = snapThresholdSec;
        snapCandidates.forEach(cand => {
          const dist = Math.abs(cand - rawEnd);
          if (dist < bestDist && cand > dg.origStart + 0.05) {
            bestDist = dist;
            deltaSec = cand - dg.origEnd;
            snappedSec = cand;
          }
        });
      }
    } else if (dg.type === 'syl_multi') {
      // Find drag selection's min and max time bounds
      let minOrigTime = Infinity;
      let maxOrigEnd  = -Infinity;
      const draggedKeys = new Set(dg.items.map(it => getSyllableKey(it.lineId, it.isAdlib, it.sIdx)));

      dg.items.forEach(it => {
        if (it.origTime < minOrigTime) minOrigTime = it.origTime;
        if (it.origTime + it.origDur > maxOrigEnd) maxOrigEnd = it.origTime + it.origDur;
      });

      // Syllables outside selection + line edges + playhead
      (lyrics.lines || []).forEach(l => {
        snapCandidates.push(l.start);
        snapCandidates.push(l.end);
        (l.rawSyllabi || []).forEach((s, sIdx) => {
          if (!draggedKeys.has(getSyllableKey(l.id, false, sIdx))) {
            snapCandidates.push(s.time / 1000);
            snapCandidates.push((s.time + s.duration) / 1000);
          }
        });
        (l.adlibSyllabi || []).forEach((s, sIdx) => {
          if (!draggedKeys.has(getSyllableKey(l.id, true, sIdx))) {
            snapCandidates.push(s.time / 1000);
            snapCandidates.push((s.time + s.duration) / 1000);
          }
        });
      });

      const rawStartSec = (minOrigTime / 1000) + rawDeltaSec;
      const rawEndSec   = (maxOrigEnd / 1000) + rawDeltaSec;

      if (dg.handle === 'move') {
        let bestDist = snapThresholdSec;
        let snapDelta = 0;

        snapCandidates.forEach(cand => {
          // Snap leading edge
          const distStart = Math.abs(cand - rawStartSec);
          if (distStart < bestDist) {
            bestDist = distStart;
            snapDelta = cand - (minOrigTime / 1000);
            snappedSec = cand;
          }
          // Snap trailing edge
          const distEnd = Math.abs(cand - rawEndSec);
          if (distEnd < bestDist) {
            bestDist = distEnd;
            snapDelta = cand - (maxOrigEnd / 1000);
            snappedSec = cand;
          }
        });

        if (snappedSec !== null) {
          deltaSec = snapDelta;
          deltaMs  = Math.round(deltaSec * 1000);
        }
      } else if (dg.handle === 'left') {
        let bestDist = snapThresholdSec;
        snapCandidates.forEach(cand => {
          const dist = Math.abs(cand - rawStartSec);
          if (dist < bestDist) {
            bestDist = dist;
            deltaSec = cand - (minOrigTime / 1000);
            deltaMs  = Math.round(deltaSec * 1000);
            snappedSec = cand;
          }
        });
      } else if (dg.handle === 'right') {
        let bestDist = snapThresholdSec;
        snapCandidates.forEach(cand => {
          const dist = Math.abs(cand - rawEndSec);
          if (dist < bestDist) {
            bestDist = dist;
            deltaSec = cand - (maxOrigEnd / 1000);
            deltaMs  = Math.round(deltaSec * 1000);
            snappedSec = cand;
          }
        });
      }
    }
  }

  // Visual magnetic indicator guide line
  if (snapLineEl) {
    if (snappedSec !== null) {
      const snapPx = snappedSec * Studio.pps;
      snapLineEl.style.left = `${snapPx}px`;
      snapLineEl.classList.remove('hidden');
    } else {
      snapLineEl.classList.add('hidden');
    }
  }

  if (dg.type === 'line') {
    const line = (lyrics.lines || []).find(l => l.id === dg.lineId);
    if (!line) return;

    if (dg.handle === 'move') {
      const dur = dg.origEnd - dg.origStart;
      const newStart = Math.max(0, dg.origStart + deltaSec);
      line.start = Math.round(newStart * 1000) / 1000;
      line.end   = Math.round((newStart + dur) * 1000) / 1000;
      // Shift syllables
      line.rawSyllabi = dg.origRawSylls.map(s => ({ ...s, time: Math.max(0, s.time + deltaMs) }));
      line.adlibSyllabi = dg.origAdlibSylls.map(s => ({ ...s, time: Math.max(0, s.time + deltaMs) }));
    } else if (dg.handle === 'left') {
      line.start = Math.round(Math.max(0, Math.min(dg.origEnd - 0.1, dg.origStart + deltaSec)) * 1000) / 1000;
    } else {
      line.end = Math.round(Math.max(dg.origStart + 0.1, dg.origEnd + deltaSec) * 1000) / 1000;
    }
  } else if (dg.type === 'syl_multi') {
    dg.items.forEach(item => {
      if (!item.syl) return;
      if (dg.handle === 'move') {
        item.syl.time = Math.max(0, item.origTime + deltaMs);
        const targetLane = Math.max(0, Math.min((Studio.numLanes || 4) - 1, item.origLane + deltaLane));
        item.syl.lane = targetLane;
      } else if (dg.handle === 'left') {
        const newTime = Math.max(0, item.origTime + deltaMs);
        const newDur  = Math.max(40, item.origDur - deltaMs);
        item.syl.time = newTime;
        item.syl.duration = newDur;
      } else if (dg.handle === 'right') {
        item.syl.duration = Math.max(40, item.origDur + deltaMs);
      }
    });
  }

  renderTimelineLines();
  renderTimelineSyllables();
}

function handleDragEnd(e) {
  const snapLineEl = document.getElementById('tlSnapLine');
  if (snapLineEl) snapLineEl.classList.add('hidden');

  if (Studio.marquee && Studio.marquee.active) {
    const box = document.getElementById('tlMarqueeBox');
    if (box) box.classList.add('hidden');

    if (!Studio.marquee.moved && e) {
      // User performed a simple click on empty timeline area -> Seek playhead
      const inner = document.getElementById('tlInner');
      if (inner) {
        const innerRect = inner.getBoundingClientRect();
        const clickX = e.clientX - innerRect.left;
        const seekTime = Math.max(0, Math.min(Studio.duration || 1000, clickX / Studio.pps));
        if (Studio.audio) {
          Studio.audio.currentTime = seekTime;
          Studio.currentTime = seekTime;
          updatePlayheadDOM();
          if (typeof updateSweepPlayer === 'function') updateSweepPlayer(false);
        }
      }
    }

    Studio.marquee = null;
    updateSelectionBadge();
    renderTimelineSyllables();
  }

  if (Studio.drag) {
    Studio.drag = null;
    const lyrics = getActiveLyrics();
    if (lyrics && lyrics.lines) {
      deriveLineBoundsFromSyllables(lyrics);
      lyrics.lines.sort((a, b) => a.start - b.start);
      for (let i = 1; i < lyrics.lines.length; i++) {
        lyrics.lines[i].isSimultaneous = lyrics.lines[i].start < lyrics.lines[i - 1].end;
      }
    }
    saveActiveTrackToBackend();
    renderTimelineLines();
    renderInspectorLines();
    if (typeof updateSweepPlayer === 'function') updateSweepPlayer(true);
  }
}

// ─── Clipboard Operations (Copy, Paste, Duplicate, Delete) ─────────────────
function copySelectedSyllables() {
  const lyrics = getActiveLyrics();
  const lines = lyrics.lines || [];

  // 1. If syllables are selected via multi-selection / chip click
  if (Studio.selectedSyllables.size > 0) {
    const items = [];
    const lineMap = new Map(); // lineId -> { line, syls: [] }

    Studio.selectedSyllables.forEach(sel => {
      const l = lines.find(line => line.id === sel.lineId);
      if (!l) return;
      const list = sel.isAdlib ? l.adlibSyllabi : l.rawSyllabi;
      const s = list ? list[sel.sIdx] : null;
      if (!s) return;

      const lane = s.lane !== undefined ? s.lane : (sel.isAdlib ? 3 : (l.agent === 'v2' ? 1 : 0));
      const item = {
        lineId: l.id,
        agent: l.agent || 'v1',
        side: l.side || 'right',
        laneIndex: l.laneIndex || 0,
        text: s.text,
        time: s.time,
        duration: s.duration,
        isSubSyllable: !!s.isSubSyllable,
        lane: lane,
        isAdlib: !!sel.isAdlib,
      };
      items.push(item);

      if (!lineMap.has(l.id)) {
        lineMap.set(l.id, { line: l, syls: [] });
      }
      lineMap.get(l.id).syls.push(item);
    });

    if (!items.length) {
      toast('Keine Silben zum Kopieren ausgewählt.', 'error');
      return;
    }

    items.sort((a, b) => a.time - b.time);
    const minTime = items[0].time;

    // Build structured line groups in order of appearance
    const lineGroups = [];
    lineMap.forEach((val, lineId) => {
      val.syls.sort((a, b) => a.time - b.time);
      lineGroups.push({
        origLineId: lineId,
        agent: val.line.agent || 'v1',
        side: val.line.side || 'right',
        laneIndex: val.line.laneIndex || 0,
        text: val.line.text || '',
        adlib: val.line.adlib || null,
        minTime: val.syls[0].time,
        relLineStart: val.syls[0].time - minTime,
        syls: val.syls.map(s => ({
          ...s,
          relTime: s.time - minTime,
        })),
      });
    });
    lineGroups.sort((a, b) => a.minTime - b.minTime);

    Studio.clipboard = {
      type: 'syllables',
      minTime: minTime,
      lineGroups: lineGroups,
      items: items.map(it => ({
        ...it,
        relTime: it.time - minTime,
      })),
    };

    toast(`${items.length} Silben kopiert (${lineGroups.length} Zeile(n)) [Ctrl+C]`, 'success');
    return;
  }

  // 2. If a Line block is selected (and no individual syllables selected)
  if (Studio.selectedLineId) {
    const l = lines.find(line => line.id === Studio.selectedLineId);
    if (l) {
      const lineStartMs = Math.round(l.start * 1000);
      const rawSyls = (l.rawSyllabi || []).map(s => ({
        ...s,
        relTime: s.time - lineStartMs,
        isAdlib: false,
        lane: s.lane !== undefined ? s.lane : (l.agent === 'v2' ? 1 : 0),
      }));
      const adlibSyls = (l.adlibSyllabi || []).map(s => ({
        ...s,
        relTime: s.time - lineStartMs,
        isAdlib: true,
        lane: s.lane !== undefined ? s.lane : 3,
      }));
      const allSyls = [...rawSyls, ...adlibSyls].sort((a, b) => a.time - b.time);

      Studio.clipboard = {
        type: 'lines',
        minTime: lineStartMs,
        lineGroups: [{
          origLineId: l.id,
          agent: l.agent || 'v1',
          side: l.side || 'right',
          laneIndex: l.laneIndex || 0,
          text: l.text || '',
          adlib: l.adlib || null,
          duration: (l.end - l.start),
          syls: allSyls,
        }],
        items: allSyls,
      };

      toast(`Zeile "${(l.text || 'Zeile').slice(0, 25)}" kopiert [Ctrl+C]`, 'success');
      return;
    }
  }

  toast('Keine Silben oder Zeile zum Kopieren ausgewählt.', 'error');
}

function pasteSyllables() {
  if (!Studio.clipboard || !Studio.clipboard.lineGroups?.length) {
    toast('Zwischenablage ist leer. Bitte zuerst Silben/Zeilen kopieren (Ctrl+C).', 'error');
    return;
  }

  const lyrics = getActiveLyrics();
  if (!lyrics.lines) lyrics.lines = [];
  pushHistory();

  const playheadSec = Studio.currentTime || 0;
  const playheadMs = Math.round(playheadSec * 1000);

  Studio.selectedSyllables.clear();
  let totalPastedSyllables = 0;

  // Create newly timed lines at playhead position for each line group in clipboard
  Studio.clipboard.lineGroups.forEach((grp, gIdx) => {
    const rawSyls = [];
    const adlibSyls = [];

    grp.syls.forEach(s => {
      const newSyl = {
        text: s.text,
        time: playheadMs + s.relTime,
        duration: s.duration,
        isSubSyllable: !!s.isSubSyllable,
        lane: s.lane !== undefined ? s.lane : (s.isAdlib ? 3 : (grp.agent === 'v2' ? 1 : 0)),
      };
      if (s.isAdlib || s.lane === 3) {
        adlibSyls.push(newSyl);
      } else {
        rawSyls.push(newSyl);
      }
      totalPastedSyllables++;
    });

    rawSyls.sort((a, b) => a.time - b.time);
    adlibSyls.sort((a, b) => a.time - b.time);

    const allStarts = [...rawSyls.map(s => s.time), ...adlibSyls.map(s => s.time)];
    const allEnds   = [...rawSyls.map(s => s.time + s.duration), ...adlibSyls.map(s => s.time + s.duration)];

    const lStart = allStarts.length > 0 ? (Math.min(...allStarts) / 1000) : (playheadSec + (grp.relLineStart || 0) / 1000);
    const lEnd   = allEnds.length > 0   ? (Math.max(...allEnds) / 1000)   : (lStart + (grp.duration || 3.0));

    const lineText = rawSyls.length > 0 ? rawSyls.map(s => s.text).join('').trim() : (grp.text || 'New Line');
    const lineAdlib = adlibSyls.length > 0 ? adlibSyls.map(s => s.text).join('').trim() : grp.adlib;

    const newLine = {
      id: `L-${Date.now()}-${gIdx}-${Math.random().toString(36).substring(2, 6)}`,
      start: Math.round(lStart * 1000) / 1000,
      end: Math.round(lEnd * 1000) / 1000,
      text: lineText,
      adlib: lineAdlib,
      rawSyllabi: rawSyls,
      adlibSyllabi: adlibSyls,
      agent: grp.agent || 'v1',
      side: grp.side || (grp.agent === 'v2' ? 'left' : 'right'),
      isSimultaneous: false,
      laneIndex: grp.laneIndex || (grp.agent === 'v2' ? 1 : 0),
    };

    lyrics.lines.push(newLine);

    // Select syllables in new line
    rawSyls.forEach((syl, sIdx) => {
      Studio.selectedSyllables.set(getSyllableKey(newLine.id, false, sIdx), {
        lineId: newLine.id, isAdlib: false, sIdx, syl,
      });
    });
    adlibSyls.forEach((syl, sIdx) => {
      Studio.selectedSyllables.set(getSyllableKey(newLine.id, true, sIdx), {
        lineId: newLine.id, isAdlib: true, sIdx, syl,
      });
    });

    if (gIdx === 0) {
      Studio.selectedLineId = newLine.id;
    }
  });

  // Sort all lines by start time
  lyrics.lines.sort((a, b) => a.start - b.start);

  // Recalculate isSimultaneous flags
  for (let i = 1; i < lyrics.lines.length; i++) {
    lyrics.lines[i].isSimultaneous = lyrics.lines[i].start < lyrics.lines[i - 1].end;
  }

  saveActiveTrackToBackend();
  updateSelectionBadge();
  refreshEditorViews();
  if (typeof updateSweepPlayer === 'function') updateSweepPlayer(true);

  toast(`${totalPastedSyllables} Silben an Position ${fmt(playheadSec)} eingefügt (Ctrl+V)`, 'success');
}

function duplicateSelectedSyllables() {
  if (Studio.selectedSyllables.size === 0 && !Studio.selectedLineId) {
    toast('Keine Silben oder Zeile zum Duplizieren ausgewählt.', 'error');
    return;
  }

  copySelectedSyllables();
  if (!Studio.clipboard || !Studio.clipboard.lineGroups?.length) return;

  // Find max end relative time among copied items
  let maxEndMs = 0;
  Studio.clipboard.items.forEach(it => {
    const end = (it.relTime || 0) + (it.duration || 0);
    if (end > maxEndMs) maxEndMs = end;
  });

  // Calculate new playhead time right after the selection (+100ms gap)
  const minTime = Studio.clipboard.minTime || 0;
  Studio.currentTime = Math.round((minTime + maxEndMs + 100)) / 1000;
  updatePlayheadDOM();

  pasteSyllables();
  toast('Silben/Zeilen dupliziert (Ctrl+D)', 'success');
}

function deleteSelectedItems() {
  const lyrics = getActiveLyrics();

  if (Studio.selectedSyllables.size > 0) {
    pushHistory();
    let delCount = 0;
    Studio.selectedSyllables.forEach(sel => {
      const line = (lyrics.lines || []).find(l => l.id === sel.lineId);
      if (!line) return;
      const list = sel.isAdlib ? line.adlibSyllabi : line.rawSyllabi;
      if (list && list[sel.sIdx]) {
        list.splice(sel.sIdx, 1);
        delCount++;
      }
    });
    clearSyllableSelection();
    saveActiveTrackToBackend();
    refreshEditorViews();
    toast(`${delCount} Silbe(n) gelöscht.`, 'success');
  } else if (Studio.selectedLineId) {
    pushHistory();
    const idx = (lyrics.lines || []).findIndex(l => l.id === Studio.selectedLineId);
    if (idx >= 0) {
      lyrics.lines.splice(idx, 1);
      Studio.selectedLineId = null;
      saveActiveTrackToBackend();
      refreshEditorViews();
      toast('Zeile gelöscht.', 'success');
    }
  }
}

function deleteSelectedSyllables() {
  deleteSelectedItems();
}

function addNewLineAtPlayhead() {
  const lyrics = getActiveLyrics();
  pushHistory();
  const t = Studio.currentTime || 0;
  const newLine = {
    id: `L-${Date.now()}`,
    start: Math.round(t * 1000) / 1000,
    end: Math.round((t + 3.0) * 1000) / 1000,
    text: 'New Line',
    adlib: null,
    rawSyllabi: [],
    adlibSyllabi: [],
    agent: 'v1',
    side: 'right',
    isSimultaneous: false,
    laneIndex: 0,
  };
  lyrics.lines.push(newLine);
  lyrics.lines.sort((a, b) => a.start - b.start);
  selectLine(newLine.id);
  saveActiveTrackToBackend();
  refreshEditorViews();
}

function sortLinesByTimestamp() {
  const lyrics = getActiveLyrics();
  pushHistory();
  lyrics.lines.sort((a, b) => a.start - b.start);
  saveActiveTrackToBackend();
  refreshEditorViews();
  toast('Sorted lines by timestamp.', 'success');
}

async function runTrackAlignment() {
  const track = getActiveTrack();
  if (!track || !Studio.project?.id) return;
  const btn = document.getElementById('alignTrackBtn');
  const mode = document.getElementById('alignModeSelect')?.value || 'studio_ai';
  const lang = document.getElementById('langSelect')?.value || 'en';
  const whisperModel = document.getElementById('whisperModelSelect')?.value || 'base';

  if (btn) {
    btn.disabled = true;
    btn.textContent = mode === 'studio_ai' ? 'Isoliere Acapella…' : 'Berechne Silben…';
  }

  try {
    if (mode === 'studio_ai') {
      setTimeout(() => {
        if (btn && btn.disabled) btn.textContent = 'WhisperX CTC Phonem-Scan…';
      }, 3000);
    }

    const resp = await fetch(`/api/project/${Studio.project.id}/align_track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        track_id: track.id,
        mode: mode,
        language: lang,
        use_whisper: mode === 'studio_ai',
        whisper_model: whisperModel,
      }),
    });
    if (!resp.ok) throw new Error('Alignment fehlgeschlagen');
    const data = await resp.json();

    track.lyrics = data.track.lyrics;
    track.status = data.track.status;
    if (data.vocalsUrl) {
      track.vocalsUrl = data.vocalsUrl;
      // Pre-decode vocals waveform for the vocals wave button
      decodeAudioPeaks(data.vocalsUrl, Studio.pps).then(res => {
        Studio.vocalsAudioBuf = res.audioBuf;
        Studio.vocalsWavePeaks = res.peaks;
        toast('Acapella-Gesangsspur bereit.', 'success');
      }).catch(() => {});
    }

    if (typeof renderAlbumSidebar === 'function') renderAlbumSidebar();
    refreshEditorViews();
    toast(mode === 'studio_ai' ? 'Studio KI Silben-Ausrichtung abgeschlossen.' : 'Silben schnell ausgerichtet.', 'success');
  } catch (err) {
    toast(`Alignment Fehler: ${err.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Align Syllables';
    }
  }
}

// ─── Inline Text Editing ────────────────────────────────────────────────────
function editLineText(lineId, divEl) {
  const lyrics = getActiveLyrics();
  const line = (lyrics.lines || []).find(l => l.id === lineId);
  if (!line) return;

  const currentText = line.text || line.adlib || '';

  if (divEl) {
    const textSpan = divEl.querySelector('.tl-line-text');
    if (textSpan && !divEl.querySelector('.tl-inline-input')) {
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.value = currentText;
      inp.className = 'tl-inline-input';
      textSpan.style.display = 'none';
      divEl.appendChild(inp);
      inp.focus();
      inp.select();

      let committed = false;
      const commit = () => {
        if (committed) return;
        committed = true;
        const newText = inp.value.trim();
        if (newText && newText !== currentText) {
          pushHistory();
          if (line.adlib && !line.text) line.adlib = newText;
          else line.text = newText;
          saveActiveTrackToBackend();
        }
        refreshEditorViews();
      };

      inp.addEventListener('keydown', e => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { committed = true; refreshEditorViews(); }
      });
      inp.addEventListener('click', e => e.stopPropagation());
      inp.addEventListener('mousedown', e => e.stopPropagation());
      inp.addEventListener('blur', commit);
      return;
    }
  }

  // Fallback prompt
  const newText = prompt('Edit Line Text:', currentText);
  if (newText === null || newText.trim() === currentText) return;

  pushHistory();
  if (line.adlib && !line.text) {
    line.adlib = newText.trim();
  } else {
    line.text = newText.trim();
  }
  saveActiveTrackToBackend();
  refreshEditorViews();
}

function editSyllableText(lineId, sylIdx, isAdlib, chipEl) {
  const lyrics = getActiveLyrics();
  const line = (lyrics.lines || []).find(l => l.id === lineId);
  if (!line) return;
  const list = isAdlib ? line.adlibSyllabi : line.rawSyllabi;
  const syl = list ? list[sylIdx] : null;
  if (!syl) return;

  if (chipEl) {
    const textSpan = chipEl.querySelector('.syl-chip-text');
    if (textSpan && !chipEl.querySelector('.tl-inline-input')) {
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.value = syl.text;
      inp.className = 'tl-inline-input';
      textSpan.style.display = 'none';
      chipEl.appendChild(inp);
      inp.focus();
      inp.select();

      let committed = false;
      const commit = () => {
        if (committed) return;
        committed = true;
        const newText = inp.value;
        if (newText !== syl.text) {
          pushHistory();
          syl.text = newText;
          saveActiveTrackToBackend();
        }
        refreshEditorViews();
      };

      inp.addEventListener('keydown', e => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { committed = true; refreshEditorViews(); }
      });
      inp.addEventListener('click', e => e.stopPropagation());
      inp.addEventListener('mousedown', e => e.stopPropagation());
      inp.addEventListener('blur', commit);
      return;
    }
  }

  const newText = prompt('Edit Syllable:', syl.text);
  if (newText === null || newText === syl.text) return;

  pushHistory();
  syl.text = newText;
  saveActiveTrackToBackend();
  refreshEditorViews();
}

// ─── Inspector Table Rendering ──────────────────────────────────────────────
function renderInspectorLines() {
  const list = document.getElementById('inspectorLinesList');
  if (!list) return;
  list.innerHTML = '';

  const lyrics = getActiveLyrics();
  const lines  = lyrics.lines || [];

  lines.forEach((line, idx) => {
    const row = document.createElement('div');
    row.className = 'inspector-row' + (line.id === Studio.selectedLineId ? ' active' : '');
    row.dataset.id = line.id;

    row.innerHTML = `
      <div class="insp-time-col">
        <input type="text" class="insp-time-input" value="${fmt(line.start)}" data-field="start">
      </div>
      <div class="insp-text-col">
        <input type="text" class="insp-text-input" value="${escHTML(line.text || line.adlib || '')}" placeholder="Zeilentext eingeben">
        <div class="insp-syl-badges">
          ${(line.rawSyllabi || []).map((s, sIdx) => `<span class="insp-syl-pill" data-sidx="${sIdx}" data-adlib="0" title="Klicken zum Bearbeiten der Silbe">${escHTML(s.text)}</span>`).join('')}
          ${(line.adlibSyllabi || []).map((s, sIdx) => `<span class="insp-syl-pill adlib" data-sidx="${sIdx}" data-adlib="1" title="Klicken zum Bearbeiten der Ad-lib-Silbe">${escHTML(s.text)}</span>`).join('')}
        </div>
      </div>
      <div class="insp-role-col">
        <button class="btn-insp-role ${line.agent === 'v2' ? 'duet' : ''}" title="Toggle Singer Agent (v1 / v2)">${line.agent || 'v1'}</button>
        <button class="btn-insp-bg ${line.adlib ? 'active' : ''}" title="Toggle Ad-lib (x-bg)">BG</button>
        <button class="btn-insp-del" title="Zeile löschen" style="background:transparent; border:none; color:var(--text-muted); cursor:pointer; font-size:14px; padding:0 4px;" onmouseover="this.style.color='#f87171'" onmouseout="this.style.color='var(--text-muted)'">✕</button>
      </div>
    `;

    row.querySelector('.btn-insp-del')?.addEventListener('click', e => {
      e.stopPropagation();
      pushHistory();
      const lIdx = (lines || []).findIndex(l => l.id === line.id);
      if (lIdx >= 0) {
        lines.splice(lIdx, 1);
        if (Studio.selectedLineId === line.id) Studio.selectedLineId = null;
        saveActiveTrackToBackend();
        refreshEditorViews();
        toast('Zeile gelöscht.', 'success');
      }
    });

    const timeInput = row.querySelector('.insp-time-input');
    timeInput?.addEventListener('click', e => e.stopPropagation());
    timeInput?.addEventListener('mousedown', e => e.stopPropagation());
    timeInput?.addEventListener('change', e => {
      const parts = e.target.value.trim().split(':');
      let newSec = 0;
      if (parts.length === 2) {
        newSec = parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
      } else {
        newSec = parseFloat(parts[0]);
      }
      if (isNaN(newSec) || newSec < 0) return;

      pushHistory();
      const deltaSec = newSec - line.start;
      const deltaMs = Math.round(deltaSec * 1000);
      const dur = line.end - line.start;
      line.start = Math.round(newSec * 1000) / 1000;
      line.end = Math.round((newSec + dur) * 1000) / 1000;

      (line.rawSyllabi || []).forEach(s => { s.time = Math.max(0, s.time + deltaMs); });
      (line.adlibSyllabi || []).forEach(s => { s.time = Math.max(0, s.time + deltaMs); });

      const lyrics = getActiveLyrics();
      if (lyrics && lyrics.lines) {
        lyrics.lines.sort((a, b) => a.start - b.start);
      }
      saveActiveTrackToBackend();
      refreshEditorViews();
    });

    const textInput = row.querySelector('.insp-text-input');
    textInput?.addEventListener('click', e => e.stopPropagation());
    textInput?.addEventListener('mousedown', e => e.stopPropagation());
    textInput?.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        textInput.blur();
      }
    });
    textInput?.addEventListener('change', e => {
      const val = e.target.value.trim();
      if (val === (line.text || line.adlib || '')) return;
      pushHistory();
      if (line.adlib && !line.text) line.adlib = val;
      else line.text = val;
      saveActiveTrackToBackend();
      renderTimelineLines();
      if (typeof updateSweepPlayer === 'function') updateSweepPlayer(true);
    });

    // Syllable Pills click to edit
    row.querySelectorAll('.insp-syl-pill').forEach(pill => {
      pill.addEventListener('click', e => {
        e.stopPropagation();
        const sIdx = parseInt(pill.dataset.sidx, 10);
        const isAd = pill.dataset.adlib === '1';
        const list = isAd ? line.adlibSyllabi : line.rawSyllabi;
        const syl = list ? list[sIdx] : null;
        if (!syl) return;

        const inp = document.createElement('input');
        inp.type = 'text';
        inp.value = syl.text;
        inp.className = 'insp-syl-input';
        inp.style.cssText = 'width: 52px; font-size: 11px; padding: 0 3px; background: #1c2333; color: #fff; border: 1px solid #3b82f6; border-radius: 2px; outline: none;';

        pill.replaceWith(inp);
        inp.focus();
        inp.select();

        let committed = false;
        const commit = () => {
          if (committed) return;
          committed = true;
          const newVal = inp.value;
          if (newVal !== syl.text) {
            pushHistory();
            syl.text = newVal;
            saveActiveTrackToBackend();
            renderTimelineSyllables();
            if (typeof updateSweepPlayer === 'function') updateSweepPlayer(true);
          }
          renderInspectorLines();
        };

        inp.addEventListener('keydown', ev => {
          ev.stopPropagation();
          if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
          else if (ev.key === 'Escape') { committed = true; renderInspectorLines(); }
        });
        inp.addEventListener('blur', commit);
        inp.addEventListener('click', ev => ev.stopPropagation());
        inp.addEventListener('mousedown', ev => ev.stopPropagation());
      });
    });

    row.querySelector('.btn-insp-role').addEventListener('click', e => {
      e.stopPropagation();
      toggleSingerAgent(line.agent === 'v2' ? 'v1' : 'v2');
    });

    row.querySelector('.btn-insp-bg').addEventListener('click', e => {
      e.stopPropagation();
      selectLine(line.id);
      toggleAdlibRole();
    });

    row.addEventListener('click', () => selectLine(line.id));
    list.appendChild(row);
  });
}

// ─── Vocals Isolation Controls ──────────────────────────────────────────────
async function toggleVocalsWave() {
  const track = getActiveTrack();
  const vocalsUrl = Studio.vocalsUrl || track?.vocalsUrl;
  const btn = document.getElementById('waveVocalsBtn');
  
  Studio.useVocalsWave = !Studio.useVocalsWave;
  if (btn) btn.classList.toggle('active', Studio.useVocalsWave);

  if (Studio.useVocalsWave && !Studio.vocalsWavePeaks && vocalsUrl) {
    toast('Lade Gesangs-Waveform…', '');
    try {
      const res = await decodeAudioPeaks(vocalsUrl, Studio.pps);
      Studio.vocalsAudioBuf = res.audioBuf;
      Studio.vocalsWavePeaks = res.peaks;
    } catch (e) {}
  }

  renderWaveformTiles();
}

async function toggleVocalsAudio() {
  const track = getActiveTrack();
  const vocalsUrl = Studio.vocalsUrl || track?.vocalsUrl;
  const btn = document.getElementById('vocalsAudioBtn');

  if (!vocalsUrl) {
    toast('Noch keine Acapella vorhanden. Klicke zuerst auf "Align Syllables"!', 'error');
    return;
  }

  Studio.useVocalsAudio = !Studio.useVocalsAudio;
  if (btn) btn.classList.toggle('active', Studio.useVocalsAudio);

  if (Studio.audio) {
    const seekTo = Studio.audio.currentTime;
    const wasPlay = !Studio.audio.paused;
    Studio.audio.src = Studio.useVocalsAudio ? vocalsUrl : track.audioUrl;
    Studio.audio.addEventListener('canplay', function onCanPlay() {
      Studio.audio.removeEventListener('canplay', onCanPlay);
      Studio.audio.currentTime = seekTo;
      if (wasPlay) Studio.audio.play().catch(() => {});
    }, { once: true });
    Studio.audio.load();
    toast(Studio.useVocalsAudio ? 'Acapella-Gesang solo aktiviert' : 'Master-Audio aktiviert', 'success');
  }
}

// ─── Keyboard Event Handler ──────────────────────────────────────────────────
function handleEditorKeyDown(e) {
  const tag = document.activeElement?.tagName;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;

  if (e.code === 'Space') {
    e.preventDefault();
    togglePlayPause();
  } else if (e.code === 'KeyS' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    if (typeof saveAlbumProjectFile === 'function') saveAlbumProjectFile();
  } else if (e.code === 'KeyC' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    copySelectedSyllables();
  } else if (e.code === 'KeyV' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    pasteSyllables();
  } else if (e.code === 'KeyD' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    duplicateSelectedSyllables();
  } else if (e.code === 'KeyA' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    selectAllSyllables();
  } else if (e.code === 'Delete' || e.code === 'Backspace') {
    if (Studio.selectedSyllables.size > 0 || Studio.selectedLineId) {
      e.preventDefault();
      deleteSelectedItems();
    }
  } else if (e.code === 'Escape') {
    clearSyllableSelection();
  } else if (e.code === 'KeyS' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    toggleSnapping();
  } else if (e.code === 'KeyB') {
    e.preventDefault();
    toggleAdlibRole();
  } else if (e.code === 'Digit1') {
    e.preventDefault();
    toggleSingerAgent('v1');
  } else if (e.code === 'Digit2') {
    e.preventDefault();
    toggleSingerAgent('v2');
  } else if (e.code === 'Enter') {
    e.preventDefault();
    addNewLineAtPlayhead();
  } else if (e.code === 'KeyZ' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
  } else if (e.code === 'KeyY' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    redo();
  } else if (e.code === 'ArrowLeft') {
    e.preventDefault();
    seekAudio(e.shiftKey ? -10 : -2);
  } else if (e.code === 'ArrowRight') {
    e.preventDefault();
    seekAudio(e.shiftKey ? 10 : 2);
  }
}
