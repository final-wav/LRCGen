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
      const mainWrap = document.createElement('div');
      mainWrap.className = 'karaoke-vocal-wrap karaoke-main-wrap';

      const baseP = document.createElement('p');
      baseP.className = 'karaoke-main-vocal karaoke-vocal-base';

      const activeP = document.createElement('p');
      activeP.className = 'karaoke-main-vocal karaoke-vocal-active';
      activeP.setAttribute('aria-hidden', 'true');

      if (rawSylls.length > 0) {
        rawSylls.forEach((syl, sIdx) => {
          const spanBase = document.createElement('span');
          spanBase.className = 'syl-token' + (isPast ? ' finished' : '');
          spanBase.textContent = syl.text;
          spanBase.dataset.sIdx = sIdx;
          baseP.appendChild(spanBase);

          const spanActive = document.createElement('span');
          spanActive.className = 'syl-token' + (isPast ? ' finished' : '');
          spanActive.textContent = syl.text;
          spanActive.dataset.sIdx = sIdx;
          activeP.appendChild(spanActive);
        });
      } else {
        baseP.textContent = line.text || '';
        activeP.textContent = line.text || '';
      }
      mainWrap.appendChild(baseP);
      mainWrap.appendChild(activeP);
      lineDiv.appendChild(mainWrap);
    }

    // Background vocal / ad-lib container (if present)
    const adlibSylls = isLineMode ? [] : (line.adlibSyllabi || []);
    const adlibText  = line.adlib || '';
    if (adlibSylls.length > 0 || adlibText) {
      const adlibWrap = document.createElement('div');
      adlibWrap.className = 'karaoke-vocal-wrap karaoke-adlib-wrap';

      const baseP = document.createElement('p');
      baseP.className = 'karaoke-adlib-vocal karaoke-vocal-base';

      const activeP = document.createElement('p');
      activeP.className = 'karaoke-adlib-vocal karaoke-vocal-active';
      activeP.setAttribute('aria-hidden', 'true');

      if (adlibSylls.length > 0) {
        adlibSylls.forEach((syl, sIdx) => {
          const spanBase = document.createElement('span');
          spanBase.className = 'syl-token adlib' + (isPast ? ' finished' : '');
          spanBase.textContent = syl.text;
          spanBase.dataset.sIdx = sIdx;
          baseP.appendChild(spanBase);

          const spanActive = document.createElement('span');
          spanActive.className = 'syl-token adlib' + (isPast ? ' finished' : '');
          spanActive.textContent = syl.text;
          spanActive.dataset.sIdx = sIdx;
          activeP.appendChild(spanActive);
        });
      } else {
        const text = adlibText.startsWith('(') ? adlibText : `(${adlibText})`;
        baseP.textContent = text;
        activeP.textContent = text;
      }
      adlibWrap.appendChild(baseP);
      adlibWrap.appendChild(activeP);
      lineDiv.appendChild(adlibWrap);
    }

    frag.appendChild(lineDiv);
  });

  stage.appendChild(frag);
  container.appendChild(stage);
}

// ─── Cumulative Reveal & Gaussian Scale-Wave Engine (commits 8973886 & cea9992) ─
function _syncSweepLine(lineEl, line, curTimeSec) {
  const mainWrap = lineEl.querySelector('.karaoke-main-wrap');
  if (mainWrap) {
    _applyContinuousSweep(mainWrap, line.rawSyllabi || [], line, curTimeSec);
  }

  const adlibWrap = lineEl.querySelector('.karaoke-adlib-wrap');
  if (adlibWrap) {
    _applyContinuousSweep(adlibWrap, line.adlibSyllabi || [], line, curTimeSec);
  }
}

function _applyContinuousSweep(vocalWrap, syllabi, line, curTimeSec) {
  const baseSpans = vocalWrap.querySelectorAll('.karaoke-vocal-base .syl-token');
  const activeEl  = vocalWrap.querySelector('.karaoke-vocal-active');
  if (!activeEl) return;

  if (!baseSpans.length || !syllabi.length || baseSpans.length !== syllabi.length) {
    const dur = Math.max(0.001, line.end - line.start);
    const progress = Math.max(0, Math.min(1, (curTimeSec - line.start) / dur));
    const revealPx = vocalWrap.offsetWidth * progress;
    const mask = revealPx < 1
      ? 'linear-gradient(to right, transparent, transparent)'
      : `linear-gradient(to right, white 0%, white calc(${revealPx}px - 24px), rgba(255, 255, 255, 0.65) calc(${revealPx}px - 4px), transparent ${revealPx}px)`;
    activeEl.style.webkitMaskImage = mask;
    activeEl.style.maskImage       = mask;
    return;
  }

  const lineStartSec = syllabi[0].time / 1000;
  const lineEndSec   = (syllabi[syllabi.length - 1].time + syllabi[syllabi.length - 1].duration) / 1000;

  if (curTimeSec < lineStartSec) {
    activeEl.style.webkitMaskImage = 'linear-gradient(to right, transparent, transparent)';
    activeEl.style.maskImage       = 'linear-gradient(to right, transparent, transparent)';
    for (let s = 0; s < baseSpans.length; s++) baseSpans[s].style.transform = '';
    return;
  }

  if (curTimeSec >= lineEndSec) {
    activeEl.style.webkitMaskImage = '';
    activeEl.style.maskImage       = '';
    for (let s = 0; s < baseSpans.length; s++) baseSpans[s].style.transform = '';
    return;
  }

  // Calculate cumulative revealPx across the line
  let revealPx = 0;
  for (let s = 0; s < syllabi.length; s++) {
    const syl = syllabi[s];
    const span = baseSpans[s];
    if (!span) continue;
    const sylStart = syl.time / 1000;
    const sylEnd   = (syl.time + syl.duration) / 1000;

    if (curTimeSec >= sylEnd) {
      revealPx = baseSpans[s + 1]?.offsetLeft ?? (span.offsetLeft + span.offsetWidth);
    } else if (curTimeSec >= sylStart) {
      const progress = (curTimeSec - sylStart) / Math.max(0.001, sylEnd - sylStart);
      revealPx = span.offsetLeft + span.offsetWidth * progress;
      break;
    } else {
      break;
    }
  }

  // 1. One cumulative gradient mask on the active layer
  const mask = revealPx < 1
    ? 'linear-gradient(to right, transparent, transparent)'
    : `linear-gradient(to right, white 0%, white calc(${revealPx}px - 24px), rgba(255, 255, 255, 0.65) calc(${revealPx}px - 4px), transparent ${revealPx}px)`;
  activeEl.style.webkitMaskImage = mask;
  activeEl.style.maskImage       = mask;

  // 2. Smooth Gaussian Scale-Wave along the reveal front (commit 8973886 & cea9992)
  // Each letter/syllable briefly swells up along a bell curve as the reveal front sweeps over it
  const bump  = 0.08;
  const sigma = 50; // px — spread of the bump
  for (let s = 0; s < baseSpans.length; s++) {
    const span = baseSpans[s];
    const center = span.offsetLeft + span.offsetWidth * 0.5;
    const dist   = revealPx - center;
    const scale  = revealPx < 1 ? 1 : 1 + bump * Math.exp(-(dist * dist) / (2 * sigma * sigma));
    span.style.transform = scale > 1.002 ? `scale(${scale.toFixed(3)})` : '';
  }
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

  // ── Continuous Apple Music Reveal & Gaussian Scale Wave (commit 8973886) ───
  if (typeof Studio !== 'undefined' && Studio.workflowMode === 'line') {
    return;
  }

  lineElements.forEach((lineEl, i) => {
    const line = lines[i];
    if (!line) return;

    const isActive = activeGroup.includes(i);
    if (isActive) {
      _syncSweepLine(lineEl, line, curTimeSec);
    } else if (line.end < curTimeSec) {
      // Past line: fully revealed (no mask)
      const actives = lineEl.querySelectorAll('.karaoke-vocal-active');
      actives.forEach(act => {
        act.style.webkitMaskImage = '';
        act.style.maskImage = '';
      });
      const spans = lineEl.querySelectorAll('.karaoke-vocal-base .syl-token');
      spans.forEach(sp => { sp.style.transform = ''; });
    } else {
      // Future line: completely hidden
      const actives = lineEl.querySelectorAll('.karaoke-vocal-active');
      actives.forEach(act => {
        act.style.webkitMaskImage = 'linear-gradient(to right, transparent, transparent)';
        act.style.maskImage = 'linear-gradient(to right, transparent, transparent)';
      });
      const spans = lineEl.querySelectorAll('.karaoke-vocal-base .syl-token');
      spans.forEach(sp => { sp.style.transform = ''; });
    }
  });
}
