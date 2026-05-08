# LRCGen — Handover Notes for Next Claude Instance

## What this project is

LRCGen is a web app for generating **LRC karaoke files** — timestamped lyrics files used by music players. It has two modes:

### LRC Mode (Normal)
The original, fully working mode. Built by the user. Handles:
- Audio file upload
- Whisper-based transcription (via Python backend)
- **Line-level tap sync**: user presses Space to mark when each lyric line starts — displays a scrollable list of all lines (done/current/upcoming), scrolling waveform with playhead, vocals isolation via UVR5
- LRC editor with waveform, segment dragging, undo/redo
- Export to `.lrc` format

### Enhanced Mode (Word/Syllable Level)
The feature the user wanted to add. Produces **enhanced LRC** with `<timestamp>word` inline word-level timestamps. Two sub-modes:
- **Word Level**: WhisperX-aligned word timestamps
- **Syllable Level**: word timestamps split proportionally by a dictionary

The enhanced mode has its own upload flow, timeline editor, and word-level tap sync.

---

## File structure

```
static/
  shared.js        — globals: uvrAvailable (var), sleep(), decodeAudioPeaks()
  app-state.js     — S (state object), $(id), fmt, toast, showPhase etc.
  app-upload.js    — handleFile, startTranscription, pollJob
  app-tap.js       — FULLY WORKING line-level tap sync (reference implementation)
  app-editor.js    — LRC editor, init() wires all event listeners
  eh-upload.js     — EH (state object), ehEl, ehFmt, ehUploadFile, checkUVR etc.
  eh-editor.js     — Enhanced timeline editor, ehUpdateVocalsBtns, initEnhancedEditor
  eh-tap.js        — Word-level tap sync (PARTIALLY WORKING — see issues below)
  enhanced.js      — Original monolith (DEAD CODE — superseded by eh-*.js split)
  app.js           — Original monolith (DEAD CODE — superseded by app-*.js split)
```

**Load order in index.html:**
```
shared.js → app-state.js → app-upload.js → app-tap.js → app-editor.js
→ eh-upload.js → eh-editor.js → eh-tap.js
```

**Critical scoping rule**: Only `function` declarations and `var` are global across script files. Never use `const`/`let` for cross-file globals. `EH`, `ehAudio`, `EH_MAX_HIST`, `wtAudio`, `wtRafId` are all `var`.

---

## The EH state object (eh-upload.js)

```js
var EH = {
  fileId, filename, _pendingFile, audioUrl,
  submode,           // 'word' | 'syllable'
  segments,          // array of {id, start, end, text, words:[{word,start,end}]}
  jobId, jobCancelled,
  pps, duration, wavePeaks, decodeId, currentTime, isPlaying, selectedLine,
  history, historyIdx,
  drag,
  lrcHints,
  vocalsJobId, vocalsUrl, vocalsPeaks, useVocalsWave, useVocalsAudio,
  wtFlat, wtFlatIdx, wtTimes, wtPeaks, wtPeaksDur,
  wxAvail, uvrAvail, engine,
  // Added dynamically in eh-tap.js during word tap sync:
  // wtOriginalUrl, wtVocalsUrl, wtUseVocals, wtSongPeaks, wtVocalPeaks, wtIsolating
}
```

---

## What the previous Claude (me) was asked to do

1. Review the split of `app.js` → `app-state.js`, `app-upload.js`, `app-tap.js`, `app-editor.js`
2. Review the split of `enhanced.js` → `eh-upload.js`, `eh-editor.js`, `eh-tap.js`
3. Fix: normal LRC drop zone flickering on drag (dragleave child element)
4. Fix: enhanced vocals audio toggle loading to wrong position (race condition)
5. Fix: vocals buttons not showing after word tap sync completes
6. **Add vocals isolation preview button to the enhanced word tap overlay** — matching what `app-tap.js` already does for line-level tap sync

---

## What the fully working reference looks like (all app-*.js files)

**The entire `app-*.js` suite is the gold standard** — not just `app-tap.js`. The whole LRC mode was fully working before the enhanced mode was attempted. Every `eh-*.js` file is the enhanced equivalent of its `app-*.js` counterpart:

| Reference (working) | Enhanced equivalent (copy & adapt) |
|---|---|
| `app-state.js` — S state, helpers | `eh-upload.js` — EH state, ehEl, ehFmt |
| `app-upload.js` — upload, transcription | `eh-upload.js` — ehUploadFile, startEnhancedTranscription |
| `app-tap.js` — line-level tap sync | `eh-tap.js` — word-level tap sync |
| `app-editor.js` — LRC editor, event wiring | `eh-editor.js` — enhanced timeline editor |

**The previous Claude made the mistake of treating only `app-tap.js` as reference** when in reality the entire `app-*.js` codebase should have been the template. Every feature in the enhanced mode has a direct working analogue in the LRC mode. Always find it there first, copy it, then adapt variable names (`S` → `EH`, `$` → `ehEl`, `fmt` → `ehFmt`, `tapState.*` → `EH.wt*`, etc.).

Key functions in app-tap.js specifically:
- `openTapSync(source)` — sets up state, creates audio (does NOT play yet), shows overlay
- `_makeTapAudio(url)` / `_switchTapAudio(url)` — audio management
- `runTapVocalsIsolation()` — POSTs to `/api/isolate`, polls `/api/job/{id}`, switches audio on done
- `toggleTapVocals()` — toggles between original and vocals audio/waveform
- `_tapIsolatingShow/Hide()` — progress screen
- `decodeTapSong(url)` / `decodeTapVocals(url)` — store peaks in `tapState.songPeaks` / `tapState.vocalPeaks`, set `tapState.wavePeaks` to whichever is active
- `drawTapWaveform()` — scrolling waveform, green when `tapState.useVocals`, purple otherwise
- `renderTapLines()` — ALL lines shown in scrollable list: done (✓, strikethrough) / current (large, highlighted) / upcoming (dimmed)
- `tapMark()` — first Space starts audio AND marks; subsequent Spaces mark lines

**Critically**: audio does NOT play on overlay open. It plays only when the user presses Space the first time (`tapState.started` flag). If vocals auto-toggle is on, isolation runs while audio is paused; playback starts only after isolation completes.

---

## Mistakes I made — learn from these

### Mistake 1: Rewriting instead of copying
**The cardinal sin.** `eh-tap.js` needed vocals isolation that mirrors `app-tap.js` exactly. Instead of copying `runTapVocalsIsolation`, `toggleTapVocals`, `_tapIsolatingShow/Hide`, `_switchTapAudio`, `decodeTapSong/Vocals` and renaming variables, I rewrote everything from scratch. This introduced bugs that didn't exist in the original and cost the user many rounds of debugging.

**Rule**: When adding a feature that mirrors a working one, copy the working code and adapt. Never reimplement.

### Mistake 2: EH.uvrAvail vs uvrAvailable timing
`EH.uvrAvail` starts as `null` and is set async by `checkUVR()`. The vocals button visibility check `EH.uvrAvail ? show : hide` treated `null` as falsy — button never showed.

`uvrAvailable` (shared.js global) is set by `app-editor.js` init at page load and is already resolved by the time the user opens the tap overlay.

**Fix**: Check `uvrAvailable === true || EH.uvrAvail === true` — use both, not just one.

### Mistake 3: Audio playing immediately when auto-vocals is on
`_startWordTapOverlay` called `wtAudio.play()` unconditionally, then called `_wtRunIsolation()` async. So the original song played while the model loaded.

**Fix**: `if (!autoVocals) wtAudio.play()` — hold audio when auto-toggle is checked. Play explicitly in `_wtRunIsolation` on success, and also on skip/error so audio always eventually starts.

### Mistake 4: EH.fileId null when only EH.audioUrl is set
When the user drops a file but hasn't transcribed yet, `EH.audioUrl` is a local blob URL but `EH.fileId` is null. `openWordTapSync` skips upload (condition was `!EH.fileId && !EH.audioUrl`), so `_wtRunIsolation` bailed immediately on `!EH.fileId`.

**Fix**: Upload the file first inside `_wtRunIsolation` if `EH.fileId` is null.

### Mistake 5: Breaking the word display layout repeatedly
The word display (`wt-line-display`) was already correctly centered via CSS (`align-items: center; justify-content: center`). I replaced it with `wt-words-row` (no centering CSS), breaking the layout. Then when adding the lines list back, I created a combined structure that didn't work right either.

**Fix**: Keep `wt-line-display` exactly as it was for the centered word spans. Add `tap-stage > wtLinesList` separately below it for the lines context list. Two separate containers, don't merge them.

### Mistake 6: EH_MAX_HIST declared as const
`EH_MAX_HIST` was declared `const` in `eh-upload.js` and used in `eh-editor.js`. `const` is script-scoped, not global — caused ReferenceError.

**Fix**: `var EH_MAX_HIST = 80`.

### Mistake 7: canplay race condition on audio src swap
Setting `ehAudio.currentTime` immediately after `ehAudio.src = url` fails silently because the audio hasn't loaded yet.

**Fix**: Listen for the `canplay` event before seeking:
```js
ehAudio.addEventListener('canplay', function onCanPlay() {
  ehAudio.removeEventListener('canplay', onCanPlay);
  ehAudio.currentTime = seekTo;
  if (autoPlay) ehAudio.play().catch(() => {});
}, { once: true });
ehAudio.load();
```

---

## Current known issues (not yet fixed)

1. **Timeline waveform misaligned with text** in the enhanced editor — the waveform canvas doesn't line up with the word segments below it. Root cause not yet diagnosed.

2. **Word tap sync line list and word display** are functional but the layout balance between the centered word display and the scrollable lines list below may need CSS tuning.

3. **`enhanced.js` and `app.js`** are dead code (original monoliths before the split). They are still loaded? Check `index.html` — if they are, remove them. If not, they can be deleted.

---

## API endpoints (Python backend)

```
POST /api/upload              — upload audio, returns {file_id}
POST /api/transcribe          — start Whisper transcription, returns {job_id}
POST /api/transcribe_enhanced — start WhisperX word-level transcription, returns {job_id}
GET  /api/job/{job_id}        — poll job: {status, progress, result?, error?}
GET  /api/audio/{file_id}     — serve audio file
POST /api/isolate             — start UVR5 vocal isolation, returns {job_id}
GET  /api/vocals/{job_id}     — serve isolated vocals audio
GET  /api/uvr_available       — {available: bool}
GET  /api/whisperx_available  — {available: bool}
```

---

## General rules for this codebase

1. **Copy, don't rewrite.** If a feature exists and works in LRC mode, copy it to enhanced mode and adapt names.
2. **Check scoping.** Cross-file globals must be `var` or `function`. Never `const`/`let` at module top level.
3. **Two UVR availability flags exist**: `uvrAvailable` (shared.js, set by app-editor.js init) and `EH.uvrAvail` (set async by checkUVR). Check both.
4. **Audio seek after src change**: always wait for `canplay` before setting `currentTime`.
5. **Drop zone dragleave**: check `e.relatedTarget` — only remove `drag-over` when leaving the zone, not when entering a child element.
6. **app-tap.js is the reference**. When in doubt about how something should work in eh-tap.js, read app-tap.js first.
6. **app-xxx.js is the reference**. When in doubt about how something should work in eh-xxx.js, read app-xxx.js first, because it was the working app before I ruined it.
