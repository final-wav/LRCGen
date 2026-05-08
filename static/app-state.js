'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// app-state.js — Global state, DOM cache, shared utilities
// Loaded first. Everything declared here is var/function → on window.
// ─────────────────────────────────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }

// ─── App state ────────────────────────────────────────────────────────────────
var S = {
  fileId:       null,
  filename:     null,
  duration:     0,
  currentTime:  0,
  isPlaying:    false,
  segments:     [],
  selectedId:   null,
  jobCancelled: false,

  pps:     80,
  PPS_MIN: 15,
  PPS_MAX: 600,

  drag: null,

  audioBuf:      null,
  waveformPeaks: null,

  vocalsJobId:       null,
  vocalsAudioBuf:    null,
  vocalsWavePeaks:   null,
  useVocalsWaveform: false,

  history:    [],
  historyIdx: -1,
};

// ─── WaveSurfer instance ──────────────────────────────────────────────────────
var ws = null;

// ─── Cached DOM elements ──────────────────────────────────────────────────────
var el = {
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
  tlScrollArea:       $('tlScrollArea'),
  tlInner:            $('tlInner'),
  rulerCanvas:        $('rulerCanvas'),
  waveCanvasBg:       $('waveCanvasBg'),
  waveCanvasFg:       $('waveCanvasFg'),
  tlSegTrack:         $('tlSegTrack'),
  tlPlayhead:         $('tlPlayhead'),
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
  segmentsList:       $('segmentsList'),
  titleInput:         $('titleInput'),
  artistInput:        $('artistInput'),
  exportBtn:          $('exportBtn'),
  copyLrcBtn:         $('copyLrcBtn'),
  previewToggleBtn:   $('previewToggleBtn'),
  lrcPreview:         $('lrcPreview'),
  toast:              $('toast'),
  tapSyncBtn:         $('tapSyncBtn'),
  tapSyncOverlay:     $('tapSyncOverlay'),
};

// ─── Utilities ────────────────────────────────────────────────────────────────
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function fmt(s) {
  s = Math.max(0, s);
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toFixed(2).padStart(5, '0')}`;
}

function fmtLRC(s) {
  s = Math.max(0, s);
  const m = Math.floor(s / 60);
  return `[${String(m).padStart(2, '0')}:${(s % 60).toFixed(2).padStart(5, '0')}]`;
}

function uid() { return Math.random().toString(36).slice(2); }

function escHTML(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseTime(str) {
  str = str.trim();
  const parts = str.split(':');
  return parts.length === 2
    ? parseFloat(parts[0]) * 60 + parseFloat(parts[1])
    : parseFloat(parts[0]);
}

function isInput() {
  const t = document.activeElement?.tagName;
  return t === 'INPUT' || t === 'TEXTAREA';
}

var toastT = null;
function toast(msg, type) {
  el.toast.textContent = msg;
  el.toast.className = `toast${type ? ' ' + type : ''}`;
  clearTimeout(toastT);
  toastT = setTimeout(() => el.toast.className = 'toast hidden', 2800);
}

function showPhase(phase) {
  el.uploadSection.classList.toggle('hidden',   phase !== 'upload');
  el.progressSection.classList.toggle('hidden', phase !== 'progress');
  el.editorSection.classList.toggle('hidden',   phase !== 'editor');
  document.body.classList.toggle('editor-active', phase === 'editor');
}
