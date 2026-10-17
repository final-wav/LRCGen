'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// ttml-player.js — Live Apple Music Karaoke Sweep Player
// ModernMusicPlayer Architecture: Multi-Vocalist, Concurrent & Simultaneous Wipes
// ─────────────────────────────────────────────────────────────────────────────

var _syncActiveSet = new Set();
var _syncLastCt = -1;
var _syncLastActiveKey = '';
var _syncLastPaused = null;
var _cachedStage = null;
var _cachedLineEls = [];
var playerLastTrackId = null;

const _DIST_CLASSES = [
  'active', 'post-active-line', 'next-active-line',
  'prev-2', 'next-2', 'prev-3', 'next-3', 'prev-4', 'next-4'
];

function initSweepPlayer() {
  const container = document.getElementById('ttmlSweepPlayerContainer');
  if (!container) return;

  container.addEventListener('click', e => {
    const lineEl = e.target.closest('.karaoke-line');
    if (!lineEl) return;
    const startSec = parseFloat(lineEl.dataset.start || '0');
    if (Studio.audio) {
      Studio.audio.currentTime = startSec;
      Studio.currentTime = startSec;
      updatePlayheadDOM();
      if (Studio.audio.paused) Studio.audio.play().catch(() => {});
      updateSweepPlayer(false);
    }
  });
}

function getActiveLineGroup(lines, curTimeSec) {
  if (!lines || !lines.length) return [];
  const activeGroup = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.start <= curTimeSec && curTimeSec < l.end) {
      activeGroup.push(i);
    }
  }

  // Fallback between lines: keep most recently started line active
  if (activeGroup.length === 0) {
    const allZero = lines.every(l => (l.start || 0) === 0 && (l.end || 0) === 0);
    if (allZero) return [0];

    let lastStarted = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].start <= curTimeSec && (lines[i].end > 0 || lines[i].start > 0)) {
        lastStarted = i;
      }
    }
    if (lastStarted >= 0) activeGroup.push(lastStarted);
    else activeGroup.push(0);
  }

  return activeGroup;
}

function renderSweepPlayer() {
  const container = document.getElementById('ttmlSweepPlayerContainer');
  if (!container) return;

  _syncActiveSet.clear();
  _syncLastCt = -1;
  _syncLastActiveKey = '';
  _syncLastPaused = null;
  _cachedStage = null;
  _cachedLineEls = [];
  playerLastTrackId = Studio.activeTrackId;
  container.innerHTML = '';

  const lyrics = getActiveLyrics();
  const lines  = lyrics.lines || [];
  if (!lines.length) {
    container.innerHTML = `<div class="karaoke-empty">Keine Lyrics für diesen Track vorhanden.</div>`;
    return;
  }

  const curTimeSec = Studio.currentTime || 0;
  const activeGroup = getActiveLineGroup(lines, curTimeSec);

  // Inner lines stage container for GPU translateY transform scrolling
  const stage = document.createElement('div');
  stage.className = 'karaoke-lines-stage';
  stage.id = 'karaokeLinesStage';

  const frag = document.createDocumentFragment();
  const lineEls = [];

  lines.forEach((line, i) => {
    const lineDiv = document.createElement('div');
    const isPast   = line.end < curTimeSec;
    const isActive = activeGroup.includes(i);
    const agent   = line.agent || (line.side === 'left' ? 'v2' : 'v1');
    const side    = line.side || (agent === 'v2' ? 'left' : 'right');
    const isSimul = line.isSimultaneous || (i > 0 && line.start < lines[i - 1].end - 0.05);

    lineDiv.className = `karaoke-line singer-${agent} singer-${side}` +
      (isActive ? ' active' : '') +
      (isPast ? ' past' : '') +
      (isSimul ? ' simultaneous' : '');
    lineDiv.dataset.idx = i;
    lineDiv.dataset.start = line.start;
    lineDiv.dataset.end = line.end;

    const isLineMode = (typeof Studio !== 'undefined' && Studio.workflowMode === 'line');
    const rawSylls = isLineMode ? [] : (line.rawSyllabi || []);
    const hasMainVocal = rawSylls.length > 0 || (line.text && line.text.trim().length > 0);

    // Main vocal container (only render if line actually has lead vocals)
    if (hasMainVocal) {
      const mainP = document.createElement('p');
      mainP.className = 'karaoke-main-vocal';

      if (rawSylls.length > 0) {
        rawSylls.forEach((syl, sIdx) => {
          const wrapSpan = document.createElement('span');
          wrapSpan.className = 'syl-wrap';

          const span = document.createElement('span');
          span.className = 'syl-token' + (isPast ? ' finished' : '');
          span.textContent = syl.text;
          span.dataset.sIdx = sIdx;
          wrapSpan.appendChild(span);
          mainP.appendChild(wrapSpan);
        });
      } else {
        mainP.textContent = line.text || '';
      }
      lineDiv.appendChild(mainP);
    }

    // Background vocal / ad-lib container (if present)
    const adlibSylls = isLineMode ? [] : (line.adlibSyllabi || []);
    const adlibText  = line.adlib || '';
    if (adlibSylls.length > 0 || adlibText) {
      const adlibP = document.createElement('p');
      adlibP.className = 'karaoke-adlib-vocal';

      if (adlibSylls.length > 0) {
        adlibSylls.forEach((syl, sIdx) => {
          const wrapSpan = document.createElement('span');
          wrapSpan.className = 'syl-wrap';

          const span = document.createElement('span');
          span.className = 'syl-token adlib' + (isPast ? ' finished' : '');
          span.textContent = syl.text;
          span.dataset.sIdx = sIdx;
          wrapSpan.appendChild(span);
          adlibP.appendChild(wrapSpan);
        });
      } else {
        const text = adlibText.startsWith('(') ? adlibText : `(${adlibText})`;
        adlibP.textContent = text;
      }
      lineDiv.appendChild(adlibP);
    }

    frag.appendChild(lineDiv);
    lineEls.push(lineDiv);
  });

  stage.appendChild(frag);
  container.appendChild(stage);
  _cachedStage = stage;
  _cachedLineEls = lineEls;
}

// ─── Apple Music Syllable Sweep (1:1 ModernMusicPlayer Engine) ───────────────
function _injectSyllables(lineEl, line, ct) {
  const positionMs = ct * 1000;
  const pRate = (Studio.audio ? Studio.audio.playbackRate : Studio.playbackRate) || 1.0;

  // Main vocal — drives the line's primary wipe
  const mainP = lineEl.querySelector('.karaoke-main-vocal');
  if (mainP && line.rawSyllabi?.length) {
    _activateSyllableGroup(mainP.querySelectorAll('.syl-token'), line.rawSyllabi, positionMs, pRate);
  }

  // Background vocal (ad-lib) — same wipe machinery
  const adlibP = lineEl.querySelector('.karaoke-adlib-vocal');
  if (adlibP && line.adlibSyllabi?.length) {
    _activateSyllableGroup(adlibP.querySelectorAll('.syl-token'), line.adlibSyllabi, positionMs, pRate);
  }
}

// Apply wipe state to a group of pre-rendered syllable spans.
// Port of ModernMusicPlayer lyrics-sync.js. The base text never moves; the
// lift is applied only to the ::after overlay via the `wipe` keyframes.
function _activateSyllableGroup(spans, syllabi, positionMs, pRate = 1.0) {
  if (spans.length !== syllabi.length) return;

  syllabi.forEach((syl, idx) => {
    const span = spans[idx];
    const sylEndMs = syl.time + syl.duration;

    // Wipe any leftover state from a previous activation cycle
    span.removeEventListener('animationend', _onWipeEnd);
    span.removeEventListener('animationend', _onFadeOutEnd);
    span.classList.remove('highlight', 'finished', 'fading-out');
    span.style.removeProperty('--syl-dur');
    span.style.removeProperty('--syl-del');
    span.style.removeProperty('--syl-lift');
    span.style.removeProperty('--syl-glow');
    delete span.dataset.text;

    if (positionMs >= sylEndMs) {
      span.classList.add('finished');
    } else {
      // ORDER MATTERS: data-text + custom props before .highlight, otherwise
      // the ::after animation resolves once with fallback values.
      // Exact time-synced delay and duration without artificial offsets;
      // scaled by playback rate so the CSS clock matches the audio clock.
      const delayMs = Math.round((syl.time - positionMs) / pRate);
      const durMs   = Math.max(1, Math.round(syl.duration / pRate));

      span.dataset.text = syl.text;
      span.style.setProperty('--syl-dur', `${durMs}ms`);
      span.style.setProperty('--syl-del', `${delayMs}ms`);

      // Velocity Lift: short/fast syllables (<250ms) stay flat; longer held vowels (>500ms) lift up to 1.055
      let lift = 1.0;
      let glowAlpha = 0;
      if (durMs >= 500) {
        lift = 1.055;
        glowAlpha = 0.50;
      } else if (durMs > 250) {
        // Smoothly interpolate between 250ms and 500ms
        const t = (durMs - 250) / 250;
        lift = 1.0 + 0.055 * t;
        glowAlpha = 0.50 * t;
      }
      span.style.setProperty('--syl-lift', lift.toFixed(4));
      span.style.setProperty('--syl-glow', glowAlpha.toFixed(2));

      span.classList.add('highlight');
      span.addEventListener('animationend', _onWipeEnd);
    }
  });
}

function _onWipeEnd(e) {
  if (e.animationName !== 'wipe') return;
  const span = e.currentTarget;
  span.removeEventListener('animationend', _onWipeEnd);
  span.classList.remove('highlight');
  span.style.removeProperty('--syl-dur');
  span.style.removeProperty('--syl-del');
  span.style.removeProperty('--syl-lift');
  span.style.removeProperty('--syl-glow');
  delete span.dataset.text;
  span.classList.add('finished');
}

function _resetLineText(lineEl) {
  const spans = lineEl.querySelectorAll('.syl-token');
  if (!spans.length) return;
  spans.forEach(span => {
    span.removeEventListener('animationend', _onWipeEnd);
    const wasActive = span.classList.contains('finished') || span.classList.contains('highlight');
    span.classList.remove('highlight');
    span.style.removeProperty('--syl-dur');
    span.style.removeProperty('--syl-del');
    span.style.removeProperty('--syl-lift');
    span.style.removeProperty('--syl-glow');
    delete span.dataset.text;

    if (wasActive) {
      span.classList.add('finished');
      span.classList.add('fading-out');
      span.addEventListener('animationend', _onFadeOutEnd, { once: true });
    }
  });
}

function _onFadeOutEnd(e) {
  if (e.animationName !== 'syllable-fade-out' && e.animationName !== 'syllable-adlib-fade-out') return;
  const span = e.currentTarget;
  span.classList.remove('fading-out', 'finished');
}

function updateSweepPlayer(forceRerender = false) {
  const container = document.getElementById('ttmlSweepPlayerContainer');
  if (!container) return;

  if (forceRerender || playerLastTrackId !== Studio.activeTrackId || !_cachedStage || !_cachedStage.isConnected || !_cachedLineEls.length) {
    renderSweepPlayer();
  }

  const activeStage = _cachedStage;
  const lineElements = _cachedLineEls;
  const lyrics = getActiveLyrics();
  const lines  = lyrics.lines || [];
  if (!lines.length || !activeStage || !lineElements.length) return;

  // Toggle paused class on container only when paused state changes
  const isPaused = !(Studio.audio && !Studio.audio.paused);
  if (isPaused !== _syncLastPaused) {
    _syncLastPaused = isPaused;
    container.classList.toggle('karaoke-paused', isPaused);
  }

  const curTimeSec = Studio.currentTime || (Studio.audio ? Studio.audio.currentTime : 0);
  const activeGroup = getActiveLineGroup(lines, curTimeSec);
  const activeKey   = activeGroup.join(',');

  // Handle active class toggling, distance-based hierarchy and centering
  if (activeKey !== _syncLastActiveKey) {
    const minA = activeGroup.length ? activeGroup[0] : -1;
    const maxA = activeGroup.length ? activeGroup[activeGroup.length - 1] : -1;

    // Read layout metrics BEFORE mutating classes to prevent forced synchronous layout
    let tY = null;
    if (minA >= 0 && maxA >= 0 && minA < lineElements.length && maxA < lineElements.length) {
      const stageH = container.clientHeight || 400;
      const paddingTop = 160;

      let top = paddingTop;
      for (let i = 0; i < minA; i++) {
        top += (lineElements[i].offsetHeight || 44) + 18;
      }

      let totalGroupH = 0;
      for (let i = minA; i <= maxA; i++) {
        totalGroupH += (lineElements[i].offsetHeight || 44);
        if (i < maxA) totalGroupH += 18;
      }

      tY = Math.round((stageH / 2) - (totalGroupH / 2) - top);
    }

    for (let i = 0; i < lineElements.length; i++) {
      const el = lineElements[i];
      el.classList.remove(..._DIST_CLASSES);
      if (activeGroup.includes(i)) {
        el.classList.add('active');
      } else {
        const dist = i < minA ? i - minA : i - maxA;
        if      (dist === -1) el.classList.add('post-active-line');
        else if (dist === 1)  el.classList.add('next-active-line');
        else if (dist === -2) el.classList.add('prev-2');
        else if (dist === 2)  el.classList.add('next-2');
        else if (dist === -3) el.classList.add('prev-3');
        else if (dist === 3)  el.classList.add('next-3');
        else if (dist <= -4)  el.classList.add('prev-4');
        else if (dist >= 4)   el.classList.add('next-4');
      }
    }

    if (tY !== null) {
      activeStage.style.transform = `translate3d(0, ${tY}px, 0)`;
    }

    _syncLastActiveKey = activeKey;
  }

  // ── CSS Syllable Sweep Synchronization (Zero-Jank GPU Engine) ───────────
  if (typeof Studio !== 'undefined' && Studio.workflowMode === 'line') {
    return;
  }

  const scrubbed = _syncLastCt >= 0 && Math.abs(curTimeSec - _syncLastCt) > 0.4;
  _syncLastCt = curTimeSec;

  const nowActive = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].start <= curTimeSec && curTimeSec < lines[i].end && (lines[i].rawSyllabi?.length || lines[i].adlibSyllabi?.length)) {
      nowActive.add(i);
    }
  }

  if (scrubbed) {
    for (const idx of _syncActiveSet) {
      if (!nowActive.has(idx)) {
        const lineEl = lineElements[idx];
        if (lineEl) _resetLineText(lineEl);
      }
    }
    _syncActiveSet = new Set();
    for (const idx of nowActive) {
      _syncActiveSet.add(idx);
      const lineEl = lineElements[idx];
      if (lineEl && lines[idx]) {
        _injectSyllables(lineEl, lines[idx], curTimeSec);
      }
    }
    return;
  }

  // Newly-active lines: inject syllable spans ONCE — CSS runs on its own after that.
  for (const idx of nowActive) {
    if (_syncActiveSet.has(idx)) continue;
    _syncActiveSet.add(idx);
    const lineEl = lineElements[idx];
    if (lineEl && lines[idx]) {
      _injectSyllables(lineEl, lines[idx], curTimeSec);
    }
  }

  // Lines that left their active window: reset to plain text (grey)
  for (const idx of [..._syncActiveSet]) {
    if (!nowActive.has(idx)) {
      _syncActiveSet.delete(idx);
      const lineEl = lineElements[idx];
      if (lineEl) _resetLineText(lineEl);
    }
  }
}
