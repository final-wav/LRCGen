'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// ttml-player.js — Live Apple Music Karaoke Sweep Player
// ModernMusicPlayer Architecture: Multi-Vocalist, Concurrent & Simultaneous Wipes
// ─────────────────────────────────────────────────────────────────────────────

var _syncActiveSet = new Set();
var _syncLastCt = -1;
var _syncLastActiveKey = '';
var playerLastTrackId = null;

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
    let lastStarted = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].start <= curTimeSec) lastStarted = i;
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

    // Main vocal container
    const mainP = document.createElement('p');
    mainP.className = 'karaoke-main-vocal';

    const rawSylls = line.rawSyllabi || [];
    if (rawSylls.length > 0) {
      rawSylls.forEach((syl, sIdx) => {
        const wrap = document.createElement('span');
        wrap.className = 'syl-wrap';
        const span = document.createElement('span');
        span.className = 'syl-token' + (isPast ? ' finished' : '');
        span.textContent = syl.text;
        span.dataset.sIdx = sIdx;
        wrap.appendChild(span);
        mainP.appendChild(wrap);
      });
    } else {
      mainP.textContent = line.text || '';
    }
    lineDiv.appendChild(mainP);

    // Background vocal / ad-lib container (if present)
    const adlibSylls = line.adlibSyllabi || [];
    const adlibText  = line.adlib || '';
    if (adlibSylls.length > 0 || adlibText) {
      const bgP = document.createElement('p');
      bgP.className = 'karaoke-adlib-vocal';

      if (adlibSylls.length > 0) {
        adlibSylls.forEach((syl, sIdx) => {
          const wrap = document.createElement('span');
          wrap.className = 'syl-wrap';
          const span = document.createElement('span');
          span.className = 'syl-token adlib' + (isPast ? ' finished' : '');
          span.textContent = syl.text;
          span.dataset.sIdx = sIdx;
          wrap.appendChild(span);
          bgP.appendChild(wrap);
        });
      } else {
        bgP.textContent = `(${adlibText})`;
      }
      lineDiv.appendChild(bgP);
    }

    frag.appendChild(lineDiv);
  });

  stage.appendChild(frag);
  container.appendChild(stage);
}

// ─── Parallel CSS Syllable Sweep Injection Engine ───────────────────────────
function _injectSyllables(lineEl, line, ct) {
  const positionMs = ct * 1000;

  // 1. Main Vocal Sweep
  const mainP = lineEl.querySelector('.karaoke-main-vocal');
  if (mainP && line.rawSyllabi?.length) {
    _activateSyllableGroup(mainP.querySelectorAll('.syl-token'), line.rawSyllabi, positionMs);
  }

  // 2. Background Vocal (Ad-lib) Sweep — runs concurrently with independent timing
  const adlibP = lineEl.querySelector('.karaoke-adlib-vocal');
  if (adlibP && line.adlibSyllabi?.length) {
    _activateSyllableGroup(adlibP.querySelectorAll('.syl-token'), line.adlibSyllabi, positionMs);
  }
}

function _onWipeEnd(e) {
  if (e.animationName !== 'wipe') return;
  const span = e.currentTarget;
  span.removeEventListener('animationend', _onWipeEnd);
  span.classList.remove('highlight');
  span.style.removeProperty('--syl-dur');
  span.style.removeProperty('--syl-lift');
  span.style.removeProperty('--syl-del');
  delete span.dataset.text;
  span.classList.add('finished');
}

function _activateSyllableGroup(spans, syllabi, positionMs) {
  if (!spans || !syllabi || spans.length !== syllabi.length) return;
  const pRate = (Studio.audio ? Studio.audio.playbackRate : Studio.playbackRate) || 1.0;

  syllabi.forEach((syl, idx) => {
    const span = spans[idx];
    const sylEndMs = syl.time + syl.duration;

    span.removeEventListener('animationend', _onWipeEnd);
    span.classList.remove('highlight', 'finished');
    span.style.removeProperty('--syl-dur');
    span.style.removeProperty('--syl-lift');
    span.style.removeProperty('--syl-del');
    delete span.dataset.text;

    if (positionMs >= sylEndMs) {
      span.classList.add('finished');
    } else {
      const overlapMs = idx > 0 ? Math.min(70, Math.round(syl.duration * 0.3)) : 0;
      const rawDelayMs = (syl.time - overlapMs) - positionMs;
      const rawDurMs   = syl.duration + overlapMs;
      const liftPx     = Math.min(Math.max((syl.duration - 180) / 250, 0), 1) * 0.55;

      // Scale duration & delay inversely with playbackRate
      const durMs = Math.round(rawDurMs / pRate);
      const delayMs = Math.round(rawDelayMs / pRate);

      span.dataset.text = syl.text;
      span.style.setProperty('--syl-dur', `${durMs}ms`);
      span.style.setProperty('--syl-lift', `${liftPx.toFixed(2)}px`);
      span.style.setProperty('--syl-del', `${delayMs}ms`);
      span.classList.add('highlight');
      span.addEventListener('animationend', _onWipeEnd);
    }
  });
}

function _resetLineText(lineEl) {
  const spans = lineEl.querySelectorAll('.syl-token');
  spans.forEach(span => {
    span.removeEventListener('animationend', _onWipeEnd);
    const wasActive = span.classList.contains('finished') || span.classList.contains('highlight');
    span.classList.remove('highlight');
    span.style.removeProperty('--syl-dur');
    span.style.removeProperty('--syl-lift');
    span.style.removeProperty('--syl-del');
    delete span.dataset.text;
    if (wasActive) {
      span.classList.add('finished');
    }
  });
}

function updateSweepPlayer(forceRerender = false) {
  const container = document.getElementById('ttmlSweepPlayerContainer');
  if (!container) return;

  const stage = container.querySelector('.karaoke-lines-stage');
  if (forceRerender || playerLastTrackId !== Studio.activeTrackId || !stage || !stage.children.length) {
    renderSweepPlayer();
  }

  const activeStage = container.querySelector('.karaoke-lines-stage');
  const lyrics = getActiveLyrics();
  const lines  = lyrics.lines || [];
  if (!lines.length || !activeStage) return;

  // Toggle paused class on container to sync animations with audio pause
  const isAudioPlaying = Studio.audio && !Studio.audio.paused;
  container.classList.toggle('karaoke-paused', !isAudioPlaying);

  const curTimeSec = Studio.currentTime || (Studio.audio ? Studio.audio.currentTime : 0);
  const activeGroup = getActiveLineGroup(lines, curTimeSec);
  const activeKey   = activeGroup.join(',');
  const lineElements = activeStage.querySelectorAll('.karaoke-line');

  // Handle active class toggling and simultaneous bounding box centering
  if (activeKey !== _syncLastActiveKey) {
    const minA = activeGroup.length ? activeGroup[0] : -1;
    const maxA = activeGroup.length ? activeGroup[activeGroup.length - 1] : -1;

    lineElements.forEach((el, i) => {
      if (activeGroup.includes(i)) {
        el.classList.add('active');
        el.classList.remove('past');
      } else if (i < minA) {
        el.classList.add('past');
        el.classList.remove('active');
      } else {
        el.classList.remove('active', 'past');
      }
    });

    // Smooth Dual/Multi-Active Centering via GPU translateY transform
    if (minA >= 0 && maxA >= 0 && minA < lineElements.length && maxA < lineElements.length) {
      const stageH = container.clientHeight || 400;
      const paddingTop = parseInt(getComputedStyle(activeStage).paddingTop, 10) || 160;

      // Center around the active group smoothly
      let top = paddingTop;
      for (let i = 0; i < minA; i++) {
        top += (lineElements[i].offsetHeight || 44) + 18;
      }

      let totalGroupH = 0;
      for (let i = minA; i <= maxA; i++) {
        totalGroupH += (lineElements[i].offsetHeight || 44);
        if (i < maxA) totalGroupH += 18;
      }

      const tY = Math.round((stageH / 2) - (totalGroupH / 2) - top);
      activeStage.style.transform = `translateY(${tY}px)`;
    }

    _syncLastActiveKey = activeKey;
  }

  // ── CSS Syllable Sweep Synchronization (Zero-Jank GPU Engine) ───────────
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
    _syncActiveSet.clear();
  }

  // Inject CSS animations for newly active lines (all concurrent lines get animated simultaneously)
  for (const idx of nowActive) {
    if (!_syncActiveSet.has(idx) || scrubbed) {
      const lineEl = lineElements[idx];
      if (lineEl && lines[idx]) {
        _injectSyllables(lineEl, lines[idx], curTimeSec);
      }
    }
  }

  // Reset lines that just exited
  for (const idx of _syncActiveSet) {
    if (!nowActive.has(idx)) {
      const lineEl = lineElements[idx];
      if (lineEl) _resetLineText(lineEl);
    }
  }

  _syncActiveSet = nowActive;
}
