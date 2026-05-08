# Enhanced LRC — Implementation Guide for a React Music Player

This document gives Claude Code everything it needs to implement Enhanced LRC
support in a React / JS music player. It covers the file format, parsing,
data structures, synchronisation logic, and recommended component design.
All format details are derived from the LRCGen tool that produces these files.

---

## 1. What is Enhanced LRC?

Standard LRC gives one timestamp per line:

```
[00:12.34]This is a line of lyrics
[00:15.00]Another line
```

**Enhanced LRC** adds per-word (or per-syllable) timestamps *inline* using
angle-bracket tags. This allows word-by-word or syllable-by-syllable
karaoke-style highlighting as the song plays.

```
[00:12.34]<00:12.34>This <00:12.80>is <00:13.10>a <00:13.40>line <00:13.90>of <00:14.20>lyrics
[00:15.00]<00:15.00>Another <00:15.60>line
```

### 1.1 File header tags

```
[ti:Song Title]
[ar:Artist Name]
[by:LRCGen]
[enhanced:true]
```

`[enhanced:true]` is the reliable signal that this file uses word-level tags.
Always check for it (or scan for `<` tags) before enabling word highlighting.

### 1.2 Timestamp format

Both line timestamps `[mm:ss.xx]` and word timestamps `<mm:ss.xx>` use the
same format: two-digit minutes, colon, seconds with two decimal places.

```
mm:ss.xx
01:23.45  →  83.45 seconds
```

### 1.3 Syllable mode

When LRCGen exports in **syllable** mode, each `<tag>token` represents a
single syllable rather than a full word. Syllables are joined into words
by the display layer (see §4.3). You can detect syllable mode by checking
`[mode:syllable]` in the header — or just treat every token as an atom and
render them with no space between consecutive tokens that belong to the same
original word.

> **Practical tip**: in syllable mode the tokens are split on hyphens during
> generation, so "beau-ti-ful" becomes three tokens: `beau`, `ti`, `ful`.
> They are stored without hyphens. Re-join them visually with no separator.

---

## 2. Parsing

### 2.1 Regex constants

```js
const LINE_TS_RE  = /^\[(\d{1,3}):(\d{2}\.\d{2,3})\]/;      // [mm:ss.xx]
const WORD_TS_RE  = /<(\d{1,3}):(\d{2}\.\d{2,3})>([^<\[]*)/g; // <mm:ss.xx>word
const HEADER_RE   = /^\[(\w+):(.+)\]$/;
```

### 2.2 `parseEnhancedLrc(text)` — full parser

```js
/**
 * Parse an enhanced (or standard) LRC string.
 *
 * Returns:
 * {
 *   meta: { ti, ar, by, enhanced, mode },   // header tags
 *   lines: [
 *     {
 *       start: number,          // line start in seconds
 *       text:  string,          // full plain text of the line
 *       words: [
 *         { word: string, start: number, end: number }
 *       ]
 *     }
 *   ]
 * }
 *
 * If a line has no <word> tags, words[] is empty and you fall back to
 * line-level highlighting.
 */
export function parseEnhancedLrc(text) {
  const meta  = {};
  const lines = [];

  const rawLines = text.replace(/\r\n/g, '\n').split('\n');

  // ── Pass 1: collect all timed lines ──────────────────────────────────────
  const timedRaw = [];   // { ts: number, rest: string }[]

  for (const raw of rawLines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    // Header tag — no body timestamp
    const hm = trimmed.match(/^\[([a-zA-Z_]+):(.+)\]$/);
    if (hm && !/^\d/.test(hm[1])) {
      meta[hm[1].toLowerCase()] = hm[2].trim();
      continue;
    }

    // May have ONE OR MORE leading [mm:ss.xx] stamps (multi-stamp is rare but legal)
    let rest = trimmed;
    let firstTs = null;
    const stampRe = /^\[(\d{1,3}):(\d{2}\.\d{2,3})\]/;

    while (true) {
      const m = rest.match(stampRe);
      if (!m) break;
      const t = parseInt(m[1], 10) * 60 + parseFloat(m[2]);
      if (firstTs === null) firstTs = t;
      rest = rest.slice(m[0].length);
    }

    if (firstTs !== null) {
      timedRaw.push({ ts: firstTs, rest });
    }
  }

  // Sort by timestamp (LRC files are usually sorted, but not guaranteed)
  timedRaw.sort((a, b) => a.ts - b.ts);

  // ── Pass 2: extract word tokens ───────────────────────────────────────────
  for (let i = 0; i < timedRaw.length; i++) {
    const { ts, rest } = timedRaw[i];
    const lineEnd = (timedRaw[i + 1]?.ts) ?? Infinity;

    const words  = [];
    const wordRe = /<(\d{1,3}):(\d{2}\.\d{2,3})>([^<\[]*)/g;
    let   plain  = '';
    let   m;

    while ((m = wordRe.exec(rest)) !== null) {
      const wStart = parseInt(m[1], 10) * 60 + parseFloat(m[2]);
      const wText  = m[3].trim();
      if (!wText) continue;

      // end of word = next word's start (or line end)
      // We'll back-fill end times after collecting all words for this line
      words.push({ word: wText, start: wStart, end: 0 });
      plain += (plain ? ' ' : '') + wText;
    }

    // Back-fill word end times
    for (let j = 0; j < words.length; j++) {
      words[j].end = (words[j + 1]?.start) ?? lineEnd;
    }

    // If no word tags, plain text is the rest stripped of any leftover tags
    if (!plain) {
      plain = rest.replace(/<[^>]+>/g, '').trim();
    }

    lines.push({ start: ts, end: lineEnd, text: plain, words });
  }

  return { meta, lines };
}
```

### 2.3 Detecting enhanced vs. standard LRC

```js
export function isEnhancedLrc(parsedOrText) {
  if (typeof parsedOrText === 'string') {
    return parsedOrText.includes('[enhanced:true]') || /<\d{1,3}:\d{2}/.test(parsedOrText);
  }
  // already parsed
  return parsedOrText.meta?.enhanced === 'true'
    || parsedOrText.lines.some(l => l.words.length > 0);
}
```

---

## 3. Data Structures

After parsing, your player works with this shape throughout:

```ts
interface LrcWord {
  word:  string;   // display token (may be a syllable)
  start: number;   // seconds
  end:   number;   // seconds
}

interface LrcLine {
  start: number;
  end:   number;
  text:  string;   // full plain text (for fallback / search)
  words: LrcWord[];
}

interface ParsedLrc {
  meta: {
    ti?:       string;   // title
    ar?:       string;   // artist
    by?:       string;   // creator
    enhanced?: string;   // "true"
    mode?:     string;   // "word" | "syllable"
  };
  lines: LrcLine[];
}
```

---

## 4. Synchronisation Logic

### 4.1 Finding the active line

```js
/**
 * Returns the index of the currently active line, or -1 if before first line.
 * currentTime is audio.currentTime in seconds.
 */
export function getActiveLine(lines, currentTime) {
  // Walk backwards: the last line whose start <= currentTime is active
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].start <= currentTime) return i;
  }
  return -1;
}
```

### 4.2 Finding the active word within a line

```js
/**
 * Returns the index of the currently active word inside a line's words[],
 * or -1 if before the first word / line has no words.
 */
export function getActiveWord(words, currentTime) {
  if (!words?.length) return -1;
  for (let i = words.length - 1; i >= 0; i--) {
    if (words[i].start <= currentTime) return i;
  }
  return -1;
}
```

### 4.3 Word completion percentage (for karaoke fill animation)

```js
/**
 * How far through the current word are we? Returns 0–1.
 * Use this to drive a CSS clip-path or width on the highlighted word.
 */
export function wordProgress(word, currentTime) {
  if (currentTime <= word.start) return 0;
  if (currentTime >= word.end)   return 1;
  return (currentTime - word.start) / (word.end - word.start);
}
```

### 4.4 Syllable mode — grouping tokens back into words

In syllable mode, consecutive tokens that visually form one word must be
rendered without a space between them. There is no explicit "is_syllable"
flag in the LRC format itself — you detect it via the header `[mode:syllable]`
or `[enhanced:true]` combined with short tokens. The simplest approach for
display is: **always render tokens consecutively with a non-breaking space
between logical words**. To group syllables into words, split the original
`line.text` on spaces and match each token against those words.

```js
/**
 * Groups syllable tokens back into word clusters for display.
 * Returns: Array<{ syllables: LrcWord[], displayWord: string }>
 *
 * Strategy: tokens are assigned to words greedily left-to-right by
 * concatenating token text and comparing against the space-split word list.
 */
export function groupSyllables(words, lineText) {
  const wordList = lineText.split(/\s+/).filter(Boolean);
  const groups   = [];
  let   wi       = 0;   // index into wordList
  let   buf      = '';
  let   group    = [];

  for (const tok of words) {
    group.push(tok);
    buf += tok.word;

    const target = (wordList[wi] || '').replace(/[.,!?"""''…\-]/g, '').toLowerCase();
    if (buf.toLowerCase() === target || !target) {
      groups.push({ syllables: group, displayWord: wordList[wi] || buf });
      wi++;
      buf   = '';
      group = [];
    }
  }

  // Flush any remaining
  if (group.length) {
    groups.push({ syllables: group, displayWord: wordList[wi] || buf });
  }

  return groups;
}
```

---

## 5. React Components

### 5.1 `useLrcSync` hook

```jsx
import { useState, useEffect, useRef, useCallback } from 'react';
import { getActiveLine, getActiveWord } from './lrcUtils';

/**
 * Hook that tracks active line and word index from an audio element ref.
 *
 * Usage:
 *   const { lineIdx, wordIdx } = useLrcSync(audioRef, parsedLrc.lines);
 */
export function useLrcSync(audioRef, lines) {
  const [lineIdx, setLineIdx] = useState(-1);
  const [wordIdx, setWordIdx] = useState(-1);
  const rafRef   = useRef(null);

  const tick = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !lines?.length) {
      rafRef.current = requestAnimationFrame(tick);
      return;
    }
    const t  = audio.currentTime;
    const li = getActiveLine(lines, t);
    const wi = li >= 0 ? getActiveWord(lines[li].words, t) : -1;

    setLineIdx(prev => prev !== li ? li : prev);
    setWordIdx(prev => prev !== wi ? wi : prev);

    rafRef.current = requestAnimationFrame(tick);
  }, [audioRef, lines]);

  useEffect(() => {
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [tick]);

  return { lineIdx, wordIdx };
}
```

### 5.2 `<LyricsDisplay>` — main lyrics component

```jsx
import React, { useRef, useEffect } from 'react';
import { useLrcSync } from './useLrcSync';
import { wordProgress } from './lrcUtils';
import './LyricsDisplay.css';

/**
 * Props:
 *   audioRef   — React ref to <audio> element
 *   lines      — ParsedLrc.lines array
 *   enhanced   — boolean, enable word-level highlighting
 *   onSeek     — (seconds: number) => void, called when user clicks a line
 */
export function LyricsDisplay({ audioRef, lines, enhanced = false, onSeek }) {
  const { lineIdx, wordIdx } = useLrcSync(audioRef, lines);
  const activeRef = useRef(null);

  // Auto-scroll active line into view
  useEffect(() => {
    activeRef.current?.scrollIntoView({
      behavior: 'smooth',
      block:    'center',
    });
  }, [lineIdx]);

  if (!lines?.length) return null;

  return (
    <div className="lyrics-display">
      {lines.map((line, li) => {
        const isActive = li === lineIdx;
        const isPast   = li < lineIdx;

        return (
          <div
            key={li}
            ref={isActive ? activeRef : null}
            className={[
              'lyrics-line',
              isActive ? 'active'    : '',
              isPast   ? 'past'      : '',
            ].join(' ')}
            onClick={() => onSeek?.(line.start)}
          >
            {enhanced && line.words.length > 0
              ? <LineWords
                  words={line.words}
                  isActive={isActive}
                  wordIdx={wordIdx}
                  currentTime={audioRef.current?.currentTime ?? 0}
                />
              : <span className="lyrics-line-text">{line.text}</span>
            }
          </div>
        );
      })}
    </div>
  );
}

/** Renders individual word tokens inside an active line */
function LineWords({ words, isActive, wordIdx, currentTime }) {
  return (
    <span className="lyrics-words">
      {words.map((w, wi) => {
        const isDone    = isActive && wi < wordIdx;
        const isCurrent = isActive && wi === wordIdx;
        const pct       = isCurrent ? wordProgress(w, currentTime) : (isDone ? 1 : 0);

        return (
          <span key={wi} className="lyrics-word-wrap">
            <span
              className={[
                'lyrics-word',
                isDone    ? 'done'    : '',
                isCurrent ? 'current' : '',
              ].join(' ')}
            >
              {/* Karaoke fill: highlighted portion */}
              <span
                className="lyrics-word-fill"
                style={{ width: `${pct * 100}%` }}
              >
                {w.word}
              </span>
              {/* Unhighlighted text behind */}
              {w.word}
            </span>
            {/* Space between words (use   so it's visible) */}
            {wi < words.length - 1 ? ' ' : ''}
          </span>
        );
      })}
    </span>
  );
}
```

### 5.3 CSS for `<LyricsDisplay>` — `LyricsDisplay.css`

```css
/* ── Container ─────────────────────────────────────────────────────── */
.lyrics-display {
  display:        flex;
  flex-direction: column;
  align-items:    center;
  gap:            0.75rem;
  padding:        2rem 1rem 6rem;
  overflow-y:     auto;
  height:         100%;
  scroll-behavior: smooth;
}

/* ── Lines ─────────────────────────────────────────────────────────── */
.lyrics-line {
  cursor:      pointer;
  font-size:   1.2rem;
  font-weight: 500;
  color:       rgba(255, 255, 255, 0.35);
  transition:  color 0.2s ease, transform 0.2s ease, font-size 0.2s ease;
  text-align:  center;
  user-select: none;
  padding:     0.25rem 1rem;
  border-radius: 6px;
}

.lyrics-line:hover {
  color: rgba(255, 255, 255, 0.6);
}

.lyrics-line.past {
  color: rgba(255, 255, 255, 0.25);
}

.lyrics-line.active {
  color:     #ffffff;
  font-size: 1.4rem;
  transform: scale(1.05);
}

/* ── Word-level karaoke ─────────────────────────────────────────────── */
.lyrics-words {
  display:     inline;
  white-space: pre-wrap;
}

/* Each word is a stacking context so the fill overlays it */
.lyrics-word-wrap {
  display:  inline;
}

.lyrics-word {
  position:    relative;
  display:     inline-block;
  color:       rgba(255, 255, 255, 0.35);   /* unfilled color */
  white-space: pre;
}

.lyrics-word.done {
  color: #ffffff;
}

/* The fill layer sits on top and clips to the pct width */
.lyrics-word-fill {
  position:   absolute;
  inset:      0;
  overflow:   hidden;
  color:      #ffffff;               /* filled / active color — change to accent */
  white-space: pre;
  /* Smooth the fill transition; remove if you prefer snappy per-frame updates */
  /* transition: width 0.08s linear; */
}

/* Optional: pulse animation on the current word */
.lyrics-word.current .lyrics-word-fill {
  color: #1db954;   /* e.g. Spotify green — change to your accent */
}
```

### 5.4 `<LyricsDisplay>` usage example

```jsx
import { useRef, useState } from 'react';
import { parseEnhancedLrc, isEnhancedLrc } from './lrcUtils';
import { LyricsDisplay } from './LyricsDisplay';

function MusicPlayer() {
  const audioRef  = useRef(null);
  const [parsed, setParsed]   = useState(null);
  const [enhanced, setEnhanced] = useState(false);

  async function loadLrc(lrcText) {
    const result = parseEnhancedLrc(lrcText);
    setParsed(result);
    setEnhanced(isEnhancedLrc({ meta: result.meta, lines: result.lines }));
  }

  function seekTo(seconds) {
    if (audioRef.current) {
      audioRef.current.currentTime = seconds;
      audioRef.current.play();
    }
  }

  return (
    <div className="player">
      <audio ref={audioRef} src="/path/to/song.mp3" />

      {parsed && (
        <LyricsDisplay
          audioRef={audioRef}
          lines={parsed.lines}
          enhanced={enhanced}
          onSeek={seekTo}
        />
      )}
    </div>
  );
}
```

---

## 6. Performance Notes

| Concern | Recommendation |
|---|---|
| RAF loop frequency | `requestAnimationFrame` runs at 60 fps — plenty for word sync. Cancel it when the component unmounts or the audio pauses. |
| State updates | Wrap `setLineIdx` / `setWordIdx` in equality guards (`prev !== next`) to avoid unnecessary re-renders. |
| Scrolling | Use `scrollIntoView` with `behavior:'smooth'` only on `lineIdx` change, not inside the RAF loop. |
| Large LRC files | The parser is synchronous. Files >10,000 lines should be parsed off the main thread via a Web Worker. |
| Word fill animation | The `width` style drives the karaoke fill. You can skip it for performance on low-end devices and just do binary on/off highlighting. |
| Syllable display | Syllables within a word share no visual separator. Render them with `white-space: pre` and no space character between them. |

---

## 7. Edge Cases

| Case | Handling |
|---|---|
| Line with no `<word>` tags | `words` array is empty; fall back to plain line text |
| Word start === line start | Normal — the first word often starts exactly at the line timestamp |
| Overlapping timestamps | Sort words by `start` ascending after parsing |
| Negative timestamps | Clamp to 0 |
| Multi-stamp lines `[t1][t2]text` | Treat as duplicate lines at both timestamps (standard LRC behaviour); parser above takes the first stamp |
| HTML entities in text | `&amp;` etc. — run through `DOMParser` if your source is untrusted, or just display raw if you control generation |
| UTF-8 BOM | Strip `﻿` from the start of the string before parsing |

```js
// Robustness wrapper
export function safeParseLrc(raw) {
  const text = raw.replace(/^﻿/, '');  // strip BOM
  try {
    return parseEnhancedLrc(text);
  } catch {
    return { meta: {}, lines: [] };
  }
}
```

---

## 8. Complete `lrcUtils.js` module

```js
// lrcUtils.js — drop-in utility for React music players

export function parseEnhancedLrc(text) {
  const meta     = {};
  const lines    = [];
  const rawLines = text.replace(/\r\n/g, '\n').split('\n');
  const timedRaw = [];
  const stampRe  = /^\[(\d{1,3}):(\d{2}\.\d{2,3})\]/;

  for (const raw of rawLines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const hm = trimmed.match(/^\[([a-zA-Z_]+):(.+)\]$/);
    if (hm && !/^\d/.test(hm[1])) {
      meta[hm[1].toLowerCase()] = hm[2].trim();
      continue;
    }

    let rest = trimmed, firstTs = null;
    while (true) {
      const m = rest.match(stampRe);
      if (!m) break;
      const t = parseInt(m[1], 10) * 60 + parseFloat(m[2]);
      if (firstTs === null) firstTs = t;
      rest = rest.slice(m[0].length);
    }
    if (firstTs !== null) timedRaw.push({ ts: firstTs, rest });
  }

  timedRaw.sort((a, b) => a.ts - b.ts);

  for (let i = 0; i < timedRaw.length; i++) {
    const { ts, rest } = timedRaw[i];
    const lineEnd = timedRaw[i + 1]?.ts ?? Infinity;
    const words   = [];
    let   plain   = '';
    const wordRe  = /<(\d{1,3}):(\d{2}\.\d{2,3})>([^<\[]*)/g;
    let   m;

    while ((m = wordRe.exec(rest)) !== null) {
      const wStart = parseInt(m[1], 10) * 60 + parseFloat(m[2]);
      const wText  = m[3].trim();
      if (wText) words.push({ word: wText, start: wStart, end: 0 });
      plain += (plain ? ' ' : '') + wText;
    }

    for (let j = 0; j < words.length; j++) {
      words[j].end = words[j + 1]?.start ?? lineEnd;
    }

    if (!plain) plain = rest.replace(/<[^>]+>/g, '').trim();
    lines.push({ start: ts, end: lineEnd, text: plain, words });
  }

  return { meta, lines };
}

export function isEnhancedLrc(parsed) {
  return parsed.meta?.enhanced === 'true'
    || parsed.lines.some(l => l.words.length > 0);
}

export function safeParseLrc(raw) {
  const text = (raw ?? '').replace(/^﻿/, '');
  try   { return parseEnhancedLrc(text); }
  catch { return { meta: {}, lines: [] }; }
}

export function getActiveLine(lines, currentTime) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].start <= currentTime) return i;
  }
  return -1;
}

export function getActiveWord(words, currentTime) {
  if (!words?.length) return -1;
  for (let i = words.length - 1; i >= 0; i--) {
    if (words[i].start <= currentTime) return i;
  }
  return -1;
}

export function wordProgress(word, currentTime) {
  if (currentTime <= word.start) return 0;
  if (currentTime >= word.end)   return 1;
  return (currentTime - word.start) / (word.end - word.start);
}

export function groupSyllables(words, lineText) {
  const wordList = lineText.split(/\s+/).filter(Boolean);
  const groups   = [];
  let wi = 0, buf = '', group = [];

  for (const tok of words) {
    group.push(tok);
    buf += tok.word;
    const target = (wordList[wi] || '').replace(/[.,!?"""''…\-]/g, '').toLowerCase();
    if (buf.toLowerCase() === target || !target) {
      groups.push({ syllables: group, displayWord: wordList[wi] || buf });
      wi++; buf = ''; group = [];
    }
  }
  if (group.length) groups.push({ syllables: group, displayWord: wordList[wi] || buf });
  return groups;
}
```

---

## 9. Sample Enhanced LRC File

Below is a minimal sample file you can use for testing the parser:

```
[ti:Test Song]
[ar:Test Artist]
[by:LRCGen]
[enhanced:true]

[00:05.00]<00:05.00>Hello <00:05.40>world <00:05.80>this <00:06.10>is <00:06.40>a <00:06.70>test
[00:08.00]<00:08.00>Second <00:08.50>line <00:09.00>of <00:09.30>lyrics
[00:11.00]<00:11.00>Third <00:11.60>line <00:12.20>here
```

Paste this into a `.lrc` file and load it to verify your parser produces
correct `words` arrays for each line.

---

## 10. How LRCGen produces these files (for context)

LRCGen is a FastAPI + Python tool that:

1. Accepts an MP3/WAV upload and optional lyrics text
2. Runs OpenAI Whisper (or WhisperX for better accuracy) with `word_timestamps=True`
3. Aligns auto-detected word timestamps to user-supplied lyrics lines
4. Optionally splits word timestamps into syllable timestamps proportionally
   via `pyphen` (character-count-weighted duration splitting)
5. Exports the `[mm:ss.xx]<mm:ss.xx>word` format via `/api/export_enhanced`

The exported files are standard `.lrc` extension with the `[enhanced:true]`
header tag. Any player that implements the parser in §2 will work.
