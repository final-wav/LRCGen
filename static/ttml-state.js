'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// ttml-state.js — Global State & Data Models for TTML Lyrics Studio
// ─────────────────────────────────────────────────────────────────────────────

var MAX_STUDIO_HIST = 80;

var Studio = {
  project: {
    id: null,
    title: 'Untitled Project',
    artist: 'Various Artists',
    tracks: [],
  },
  activeTrackId: null,

  // Playback
  audio: null,
  duration: 0,
  currentTime: 0,
  isPlaying: false,
  volume: 1.0,
  playbackRate: 1.0,
  pps: 80, // pixels per second

  // Waveforms
  audioBuf: null,
  wavePeaks: null,
  vocalsAudioBuf: null,
  vocalsWavePeaks: null,
  useVocalsWave: false,
  useVocalsAudio: false,
  vocalsUrl: null,

  // Selection & Editing
  selectedLineId: null,
  lineSelected: false,
  selectedLineIds: new Set(),
  selectedSylIdx: null,
  selectedIsAdlib: false,
  selectedSyllables: new Map(), // key -> { lineId, isAdlib, sIdx, syl }
  clipboard: null,              // { type: 'syllables', items: [...] }
  numLanes: 4,                  // Default workspace lanes (Ebene 1..4+)
  laneHeight: 44,               // px per lane height
  drag: null,
  marquee: null,                // Marquee box selection state
  snapEnabled: true,            // Adobe Premiere magnetic snapping (S-Key toggle)

  // Undo / Redo
  history: [],
  historyIdx: -1,

  // Queue & Tabs
  activeInspTab: 'inspector', // 'inspector' | 'queue' | 'import'
  pendingQueueId: null,       // Currently selected line in queue

  // Workflow Mode: 'text' (1. Plain text) | 'line' (2. Line-sync) | 'syllable' (3. Syllable tuning)
  workflowMode: 'syllable',

  // Animation frame
  rafId: null,
};

function getActiveTrack() {
  if (!Studio.project || !Studio.project.tracks) return null;
  return Studio.project.tracks.find(t => t.id === Studio.activeTrackId) || null;
}

function getActiveLyrics() {
  const tr = getActiveTrack();
  if (!tr) return { meta: {}, lines: [] };
  if (!tr.lyrics) tr.lyrics = { meta: {}, lines: [] };
  if (!tr.lyrics.lines) tr.lyrics.lines = [];
  return tr.lyrics;
}

function pushHistory() {
  const lyrics = getActiveLyrics();
  Studio.history.splice(Studio.historyIdx + 1);
  Studio.history.push(JSON.stringify(lyrics));
  if (Studio.history.length > MAX_STUDIO_HIST) Studio.history.shift();
  Studio.historyIdx = Studio.history.length - 1;
  refreshUndoRedoBtns();
}

function undo() {
  if (Studio.historyIdx <= 0) return;
  Studio.historyIdx--;
  const track = getActiveTrack();
  if (track) {
    track.lyrics = JSON.parse(Studio.history[Studio.historyIdx]);
    refreshUndoRedoBtns();
    saveActiveTrackToBackend();
    refreshEditorViews();
    toast('Undo (Ctrl+Z)', '');
  }
}

function redo() {
  if (Studio.historyIdx >= Studio.history.length - 1) return;
  Studio.historyIdx++;
  const track = getActiveTrack();
  if (track) {
    track.lyrics = JSON.parse(Studio.history[Studio.historyIdx]);
    refreshUndoRedoBtns();
    saveActiveTrackToBackend();
    refreshEditorViews();
    toast('Redo (Ctrl+Y)', '');
  }
}

function refreshUndoRedoBtns() {
  const u = document.getElementById('undoBtn');
  const r = document.getElementById('redoBtn');
  if (u) u.disabled = Studio.historyIdx <= 0;
  if (r) r.disabled = Studio.historyIdx >= Studio.history.length - 1;
}

function deriveLineBoundsFromSyllables(lyrics) {
  if (!lyrics || !lyrics.lines || !Array.isArray(lyrics.lines)) return;
  lyrics.lines.forEach(line => {
    // CRITICAL LOCK: Never overwrite user-defined line.start and line.end!
    // The user's line boundaries are the ground truth from Line Sync.
    if (line.start == null || line.end == null || isNaN(line.start) || isNaN(line.end)) {
      const rawS = line.rawSyllabi || [];
      const adlibS = line.adlibSyllabi || [];
      const allStarts = [...rawS.map(s => s.time), ...adlibS.map(s => s.time)];
      const allEnds = [...rawS.map(s => s.time + s.duration), ...adlibS.map(s => s.time + s.duration)];
      if (allStarts.length > 0) {
        const realStart = Math.min(...allStarts) / 1000;
        const realEnd = Math.max(...allEnds) / 1000;
        line.start = Math.round(realStart * 1000) / 1000;
        line.end = Math.round(realEnd * 1000) / 1000;
      }
    }
    const rawS = line.rawSyllabi || [];
    if (rawS.length > 0 && (!line.text || line.text === 'New Line' || line.text === 'Neue Zeile')) {
      line.text = rawS.map(s => s.text).join('').trim();
    }
  });

  // Calculate isSimultaneous and assign conflict-free visual lanes
  const laneEnds = [0.0];
  lyrics.lines.forEach((curr, i) => {
    if (i > 0) {
      const prev = lyrics.lines[i - 1];
      curr.isSimultaneous = curr.start < prev.end - 0.05;
    } else {
      curr.isSimultaneous = false;
    }

    // Lane allocation: only auto-assign if laneIndex is not explicitly set
    if (curr.laneIndex === undefined) {
      let assignedLane = 0;
      let foundLane = false;
      for (let lIdx = 0; lIdx < laneEnds.length; lIdx++) {
        if (curr.start >= laneEnds[lIdx] - 0.05) {
          laneEnds[lIdx] = curr.end;
          assignedLane = lIdx;
          foundLane = true;
          break;
        }
      }
      if (!foundLane) {
        laneEnds.push(curr.end);
        assignedLane = laneEnds.length - 1;
      }
      curr.laneIndex = assignedLane;
    }

    // Keep syllables aligned to the line's lane if they don't have custom lane assignments
    const targetLane = curr.laneIndex !== undefined ? curr.laneIndex : 0;
    (curr.rawSyllabi || []).forEach(s => {
      if (s.lane === undefined) {
        s.lane = targetLane;
      }
    });
  });
}

function refreshEditorViews() {
  const lyrics = getActiveLyrics();
  if (lyrics) deriveLineBoundsFromSyllables(lyrics);
  if (typeof renderTimelineLines === 'function') renderTimelineLines();
  if (typeof renderTimelineSyllables === 'function') renderTimelineSyllables();
  if (typeof renderInspectorLines === 'function') renderInspectorLines();
  if (typeof renderQueueLines === 'function') renderQueueLines();
  if (typeof updateInspectorCounters === 'function') updateInspectorCounters();
  if (typeof updateSweepPlayer === 'function') updateSweepPlayer(true);
  refreshUndoRedoBtns();
}

let _autosaveTimer = null;
let _autosaveDebounce = null;

function updateAutosaveIndicator(timeStr = null) {
  const badge = document.getElementById('autosaveStatusBadge');
  if (!badge) return;
  const t = timeStr || new Date().toLocaleTimeString();
  badge.textContent = `Saved ${t}`;
  badge.style.color = '#4ade80';
  badge.style.borderColor = 'rgba(74, 222, 128, 0.3)';
  setTimeout(() => {
    if (badge) {
      badge.style.color = 'var(--text-muted)';
      badge.style.borderColor = 'var(--border2)';
    }
  }, 4000);
}

async function triggerProjectAutosave(silent = true) {
  if (!Studio.project || !Studio.project.id) return;
  if (!Studio.project.tracks || !Studio.project.tracks.length) return;

  const currentTrack = getActiveTrack();
  if (currentTrack) {
    currentTrack.numLanes = Studio.numLanes || 4;
  }

  const payload = {
    ...Studio.project,
    savedAt: new Date().toISOString(),
    numLanes: Studio.numLanes || 4,
    language: Studio.project.language || document.getElementById('langSelect')?.value || 'de',
  };

  const jsonStr = JSON.stringify(payload);

  // 1. Immediately store in browser localStorage
  try {
    localStorage.setItem('lrcgen_active_project', jsonStr);
    if (Studio.activeTrackId) {
      localStorage.setItem('lrcgen_active_track_id', Studio.activeTrackId);
    }
  } catch (e) {}

  // 2. Persist to backend disk file + rolling autosave history
  try {
    const res = await fetch(`/api/project/${Studio.project.id}/autosave`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: jsonStr,
    });
    if (res.ok) {
      updateAutosaveIndicator();
      if (!silent) toast('Project autosaved to disk.', 'success');
    }
  } catch (e) {
    console.warn('Autosave fetch error:', e);
  }
}

async function saveActiveTrackToBackend() {
  const tr = getActiveTrack();
  if (!tr) return;

  // Persist project snapshot immediately in localStorage
  try {
    if (Studio.project) {
      localStorage.setItem('lrcgen_active_project', JSON.stringify(Studio.project));
      if (Studio.activeTrackId) {
        localStorage.setItem('lrcgen_active_track_id', Studio.activeTrackId);
      }
    }
  } catch (e) {}

  if (!Studio.project?.id) return;
  try {
    await fetch(`/api/project/${Studio.project.id}/update_track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        track_id: tr.id,
        lyrics: tr.lyrics,
        unplacedLines: tr.unplacedLines || [],
        title: tr.title,
        artist: tr.artist,
        status: tr.status,
      }),
    });
    updateAutosaveIndicator();
  } catch (e) {
    console.warn('Track auto-save failed:', e);
  }

  // Debounced full project autosave to disk (after 1.5 seconds of inactivity)
  if (_autosaveDebounce) clearTimeout(_autosaveDebounce);
  _autosaveDebounce = setTimeout(() => {
    triggerProjectAutosave(true);
  }, 1500);
}

// Global 60-second Autosave Loop and beforeunload beacon
function startAutosaveLoop() {
  if (_autosaveTimer) clearInterval(_autosaveTimer);
  _autosaveTimer = setInterval(() => {
    triggerProjectAutosave(true);
  }, 60000); // exactly 60 seconds

  window.addEventListener('beforeunload', () => {
    if (Studio.project && Studio.project.id) {
      const payload = JSON.stringify({
        ...Studio.project,
        savedAt: new Date().toISOString(),
        numLanes: Studio.numLanes || 4,
      });
      try {
        localStorage.setItem('lrcgen_active_project', payload);
        navigator.sendBeacon(`/api/project/${Studio.project.id}/autosave`, payload);
      } catch (e) {}
    }
  });
}

// Initialize on script load
if (typeof window !== 'undefined') {
  startAutosaveLoop();
}
