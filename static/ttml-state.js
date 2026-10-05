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
    toast('Rückgängig ausgeführt (Ctrl+Z)', '');
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
    toast('Wiederholen ausgeführt (Ctrl+Y)', '');
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

    // Lane allocation: find first lane where end <= curr.start
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

    if (curr.laneIndex === undefined || curr.isSimultaneous) {
      curr.laneIndex = assignedLane;
    }

    // Keep syllables aligned to the line's lane if they don't have custom lane assignments
    const targetLane = curr.laneIndex !== undefined ? curr.laneIndex : assignedLane;
    (curr.rawSyllabi || []).forEach(s => {
      if (s.lane === undefined || (curr.isSimultaneous && s.lane === 0)) {
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
  if (typeof updateSweepPlayer === 'function') updateSweepPlayer(true);
  refreshUndoRedoBtns();
}

async function saveActiveTrackToBackend() {
  const tr = getActiveTrack();
  if (!tr) return;

  // Persist project snapshot immediately in localStorage so reload never loses anything
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
        title: tr.title,
        artist: tr.artist,
        status: tr.status,
      }),
    });
  } catch (e) {
    console.warn('Track auto-save failed:', e);
  }
}
