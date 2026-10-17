'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// ttml-player.js — Live Apple Music Karaoke Sweep Player
// ModernMusicPlayer Architecture: Multi-Vocalist, Concurrent & Simultaneous Wipes
// ─────────────────────────────────────────────────────────────────────────────

var _syncActiveSet = new Set();
var _syncLastCt = -1;
var _syncLastActiveKey = '';
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

    const isLineMode = (typeof Studio !== 'undefined' && Studio.workflowMode === 'line');
    const rawSylls = isLineMode ? [] : (line.rawSyllabi || []);
    const hasMainVocal = rawSylls.length > 0 || (line.text && line.text.trim().length > 0);

    // Main vocal container (only render if line actually has lead vocals)
    if (hasMainVocal) {
      const mainP = document.createElement('p');
      mainP.className = 'karaoke-main-vocal';

      if (rawSylls.length > 0) {
        const words = [];
        let curWord = [];
        rawSylls.forEach((syl, sIdx) => {
          curWord.push({ syl, sIdx });
          if (/\s$/.test(syl.text) || sIdx === rawSylls.length - 1) {
            words.push(curWord);
            curWord = [];
          }
        });
        if (curWord.length) words.push(curWord);

        words.forEach((wSyls, wIdx) => {
          const wordSpan = document.createElement('span');
          wordSpan.className = 'word-token';
          wordSpan.dataset.wIdx = wIdx;

          wSyls.forEach(({ syl, sIdx }) => {
            const span = document.createElement('span');
            span.className = 'syl-token' + (isPast ? ' finished' : '');
            span.textContent = syl.text;
            span.dataset.sIdx = sIdx;
            wordSpan.appendChild(span);
          });
          mainP.appendChild(wordSpan);
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
        const words = [];
        let curWord = [];
        adlibSylls.forEach((syl, sIdx) => {
          curWord.push({ syl, sIdx });
          if (/\s$/.test(syl.text) || sIdx === adlibSylls.length - 1) {
            words.push(curWord);
            curWord = [];
          }
        });
        if (curWord.length) words.push(curWord);

        words.forEach((wSyls, wIdx) => {
          const wordSpan = document.createElement('span');
          wordSpan.className = 'word-token adlib';
          wordSpan.dataset.wIdx = wIdx;

          wSyls.forEach(({ syl, sIdx }) => {
            const span = document.createElement('span');
            span.className = 'syl-token adlib' + (isPast ? ' finished' : '');
            span.textContent = syl.text;
            span.dataset.sIdx = sIdx;
            wordSpan.appendChild(span);
          });
          adlibP.appendChild(wordSpan);
        });
      } else {
        const text = adlibText.startsWith('(') ? adlibText : `(${adlibText})`;
        adlibP.textContent = text;
      }
      lineDiv.appendChild(adlibP);
    }

    frag.appendChild(lineDiv);
  });

  stage.appendChild(frag);
  container.appendChild(stage);
}

// ─── Apple Music Syllable Sweep (1:1 ModernMusicPlayer Engine) ───────────────
function _injectSyllables(lineEl, line, ct) {
  const positionMs = ct * 1000;
  const pRate = (Studio.audio ? Studio.audio.playbackRate : Studio.playbackRate) || 1.0;

  // Main vocal — drives the line's primary wipe
  const mainP = lineEl.querySelector('.karaoke-main-vocal');
  if (mainP && line.rawSyllabi?.length) {
    _activateSyllableGroup(mainP, line.rawSyllabi, positionMs, pRate);
  }

  // Background vocal (ad-lib) — same wipe machinery
  const adlibP = lineEl.querySelector('.karaoke-adlib-vocal');
  if (adlibP && line.adlibSyllabi?.length) {
    _activateSyllableGroup(adlibP, line.adlibSyllabi, positionMs, pRate);
  }
}

function _activateSyllableGroup(container, syllabi, positionMs, pRate = 1.0) {
  const spans = container.querySelectorAll('.syl-token');
  if (spans.length !== syllabi.length) return;

  // 1. Group syllabi into words (tokens without trailing space belong to the same word)
  const words = [];
  let curWord = [];
  syllabi.forEach((syl, idx) => {
    curWord.push({ syl, idx, span: spans[idx] });
    if (/\s$/.test(syl.text) || idx === syllabi.length - 1) {
      words.push(curWord);
      curWord = [];
    }
  });
  if (curWord.length) words.push(curWord);

  const wordEls = container.querySelectorAll('.word-token, .syl-wrap');

  // 2. Animate word-level breathing curve (calculated per WORD, not per syllable!)
  words.forEach((wSyls, wIdx) => {
    const firstSyl  = wSyls[0].syl;
    const lastSyl   = wSyls[wSyls.length - 1].syl;
    const wordStart = firstSyl.time;
    const wordEnd   = lastSyl.time + lastSyl.duration;
    const wordDur   = wordEnd - wordStart;

    const wordEl = wordEls[wIdx] || wSyls[0].span.parentElement;

    if (wordEl) {
      wordEl.removeEventListener('animationend', _onWordAnimationEnd);
      wordEl.classList.remove('highlight');
      wordEl.style.removeProperty('--word-dur');
      wordEl.style.removeProperty('--word-del');
      wordEl.style.removeProperty('--word-lift');
      wordEl.style.removeProperty('--word-scale');

      if (positionMs < wordEnd) {
        const overlapMs = wIdx > 0 ? Math.min(70, Math.max(50, Math.round(wordDur * 0.25))) : 0;
        const rawDelay  = (wordStart - overlapMs) - positionMs;
        const rawDur    = wordDur + overlapMs;

        const durMs   = Math.round(rawDur / pRate);
        const delayMs = Math.round(rawDelay / pRate);

        // Word lift & micro-scale (calibrated directly from Apple Music recording measurement):
        // Active words float up by minimal 1.0px up to 1.35px on sustained notes.
        const durProgress = Math.min(Math.max((wordDur - 160) / 400, 0), 1);
        const liftPx = 1.0 + durProgress * 0.35;
        const scaleFactor = 1.015 + durProgress * 0.02;

        wordEl.style.setProperty('--word-dur', `${durMs}ms`);
        wordEl.style.setProperty('--word-del', `${delayMs}ms`);
        wordEl.style.setProperty('--word-lift', `${liftPx.toFixed(2)}px`);
        wordEl.style.setProperty('--word-scale', scaleFactor.toFixed(3));
        wordEl.classList.add('highlight');
        wordEl.addEventListener('animationend', _onWordAnimationEnd);
      }
    }
  });

  // 3. Syllable-level optical mask wipe (sequential light sweep across letters)
  syllabi.forEach((syl, idx) => {
    const span = spans[idx];
    const sylEndMs = syl.time + syl.duration;

    span.removeEventListener('animationend', _onWipeEnd);
    span.removeEventListener('animationend', _onFadeOutEnd);
    span.classList.remove('highlight', 'finished', 'fading-out');
    span.style.removeProperty('--syl-dur');
    span.style.removeProperty('--syl-del');
    delete span.dataset.text;

    if (positionMs >= sylEndMs) {
      span.classList.add('finished');
    } else {
      const overlapMs = idx > 0 ? Math.min(70, Math.max(50, Math.round(syl.duration * 0.25))) : 0;
      const rawDelayMs = (syl.time - overlapMs) - positionMs;
      const rawDurMs   = syl.duration + overlapMs;

      const durMs   = Math.round(rawDurMs / pRate);
      const delayMs = Math.round(rawDelayMs / pRate);

      span.dataset.text = syl.text;
      span.style.setProperty('--syl-dur', `${durMs}ms`);
      span.style.setProperty('--syl-del', `${delayMs}ms`);

      span.classList.add('highlight');
      span.addEventListener('animationend', _onWipeEnd);
    }
  });
}

function _onWordAnimationEnd(e) {
  if (e.animationName !== 'word-breathe' && e.animationName !== 'word-adlib-breathe') return;
  const wordEl = e.currentTarget;
  wordEl.removeEventListener('animationend', _onWordAnimationEnd);
  wordEl.classList.remove('highlight');
  wordEl.style.removeProperty('--word-dur');
  wordEl.style.removeProperty('--word-del');
  wordEl.style.removeProperty('--word-lift');
  wordEl.style.removeProperty('--word-scale');
}

function _onWipeEnd(e) {
  if (e.animationName !== 'wipe') return;
  const span = e.currentTarget;
  span.removeEventListener('animationend', _onWipeEnd);
  span.classList.remove('highlight');
  span.style.removeProperty('--syl-dur');
  span.style.removeProperty('--syl-del');
  delete span.dataset.text;
  span.classList.add('finished');
}

function _resetLineText(lineEl) {
  const wordEls = lineEl.querySelectorAll('.word-token, .syl-wrap');
  wordEls.forEach(wordEl => {
    wordEl.removeEventListener('animationend', _onWordAnimationEnd);
    wordEl.classList.remove('highlight');
    wordEl.style.removeProperty('--word-dur');
    wordEl.style.removeProperty('--word-del');
    wordEl.style.removeProperty('--word-lift');
    wordEl.style.removeProperty('--word-scale');
  });

  const spans = lineEl.querySelectorAll('.syl-token');
  if (!spans.length) return;
  spans.forEach(span => {
    span.removeEventListener('animationend', _onWipeEnd);
    const wasActive = span.classList.contains('finished') || span.classList.contains('highlight');
    span.classList.remove('highlight');
    span.style.removeProperty('--syl-dur');
    span.style.removeProperty('--syl-del');
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

  // Handle active class toggling, distance-based hierarchy and centering
  if (activeKey !== _syncLastActiveKey) {
    const minA = activeGroup.length ? activeGroup[0] : -1;
    const maxA = activeGroup.length ? activeGroup[activeGroup.length - 1] : -1;

    lineElements.forEach((el, i) => {
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
    });

    // Smooth Dual/Multi-Active Centering via GPU translateY transform
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

      const tY = Math.round((stageH / 2) - (totalGroupH / 2) - top);
      activeStage.style.transform = `translateY(${tY}px)`;
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
