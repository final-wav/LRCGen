# 🗺️ TTML Album Studio — Master Architecture & Implementation Roadmap

> **Target:** Transformation von LRCGen in ein vollwertiges **Album & Batch TTML Time-Synced Lyrics Studio** zur Erstellung, Konvertierung, Bearbeitung und Validierung von silbengenauen Time-Synced Lyrics nach dem **Apple Music TTML Standard**.

---

## 📑 Inhaltsverzeichnis
1. [System-Architektur & Datenmodell (Schema v2)](#1-system-architektur--datenmodell-schema-v2)
2. [Phase 1: Universal Lyrics Ingestion Engine](#phase-1-universal-lyrics-ingestion-engine)
3. [Phase 2: TTML XML Serialization & Batch Export](#phase-2-ttml-xml-serialization--batch-export)
4. [Phase 3: Polyphonie-, Ad-Lib- & Überlappungs-Engine](#phase-3-polyphonie--ad-lib--überlappungs-engine)
5. [Phase 4: Line-to-Syllable AI Forced Aligner & Syllabification](#phase-4-line-to-syllable-ai-forced-aligner--syllabification)
6. [Phase 5: Backend Album & Projekt-Management API](#phase-5-backend-album--projekt-management-api)
7. [Phase 6: Frontend Album Dashboard & Sidebar](#phase-6-frontend-album-dashboard--sidebar)
8. [Phase 7: Multi-Lane Timeline & Syllable Editor](#phase-7-multi-lane-timeline--syllable-editor)
9. [Phase 8: Live Apple Music Karaoke Sweep Player](#phase-8-live-apple-music-karaoke-sweep-player)
10. [Phase 9: Syllable Tap Sync (Multi-Voice)](#phase-9-syllable-tap-sync-multi-voice)
11. [Phase 10: End-to-End Verifikation & Legacy Cleanup](#phase-10-end-to-end-verifikation--legacy-cleanup)

---

## 1. System-Architektur & Datenmodell (Schema v2)

Das gesamte System basiert auf dem **Canonical Schema Version 2**, das als immutable Drehscheibe zwischen allen Input-Formaten, internen Editoren und dem TTML-Export fungiert.

```
                              ┌──────────────────────────────────────────────┐
                              │          INPUT INGESTION ENGINE              │
                              │  (LRC, TTML, VTT, SRT, JSON, QRC, KRC, Tags) │
                              └──────────────────────┬───────────────────────┘
                                                     │
                                                     ▼
                              ┌──────────────────────────────────────────────┐
                              │      CANONICAL SCHEMA v2 DATA MODEL          │
                              │  - Multi-Lane Lines (Start / End in Sec)     │
                              │  - Decoupled Main & Ad-lib Syllabi (in MS)   │
                              │  - Multi-Singer Agents (v1, v2 / Panning)    │
                              │  - Polyphonic Overlap Tracking               │
                              └───────┬──────────────────────────────┬───────┘
                                      │                              │
                     ┌────────────────┴──────────────┐               │
                     ▼                               ▼               ▼
      ┌─────────────────────────────┐  ┌──────────────────┐  ┌───────────────┐
      │   MULTI-LANE TIMELINE &     │  │  AI ALIGNMENT &  │  │  TTML EXPORT  │
      │   KARAOKE SWEEP PLAYER      │  │  SYLLABIFIER     │  │  (Apple XML)  │
      └─────────────────────────────┘  └──────────────────┘  └───────────────┘
```

### Kern-Datenstrukturen (TypeScript / Python Equivalent):

```ts
export interface AlbumProject {
  id: string;
  title: string;
  artist: string;
  year?: string;
  coverUrl?: string;
  tracks: ProjectTrack[];
}

export interface ProjectTrack {
  id: string;
  trackNumber: number;
  filename: string;
  title: string;
  artist: string;
  audioUrl: string;
  duration: number;
  inputFormat: 'lrc' | 'enhanced-lrc' | 'ttml' | 'vtt' | 'srt' | 'lyricsplus' | 'qrc' | 'krc' | 'txt' | 'embedded' | 'none';
  status: 'empty' | 'raw_lyrics' | 'line_synced' | 'syllable_synced' | 'reviewed';
  lyrics: CanonicalLyrics;
}

export interface CanonicalLyrics {
  meta: {
    source: string;
    schemaVersion: 2;
    title?: string;
    artist?: string;
    album?: string;
    timingType: 'Word' | 'Line';
  };
  lines: CanonicalLine[];
}

export interface CanonicalLine {
  id: string;
  start: number;             // Line Start in Sekunden (float, z. B. 40.013)
  end: number;               // Line End in Sekunden (float, z. B. 41.846)
  text: string;              // Reiner Hauptvocal-Text (ohne Ad-libs)
  adlib: string | null;      // Reiner Ad-lib-Text (null wenn keiner)
  rawSyllabi: Syllable[];    // Hauptvocal-Silben
  adlibSyllabi: Syllable[];  // Ad-lib-Silben (leer wenn keine)
  agent: 'v1' | 'v2' | 'v3'; // ttm:agent Zuordnung (v1 = Lead, v2 = Duett/Singer 2)
  side: 'left' | 'right';    // Panning (v1 = Right/Center, v2 = Left)
  isSimultaneous: boolean;   // True wenn die Zeile zeitgleich mit einer anderen läuft
  laneIndex: number;         // Multi-Lane Index (0 = Lead, 1 = Ad-lib, 2 = Overlap)
}

export interface Syllable {
  time: number;              // Syllable Start in MILLISEKUNDEN (int, z. B. 40013)
  duration: number;          // Syllable Dauer in MILLISEKUNDEN (int, z. B. 262)
  text: string;              // Silbentext inkl. echtem Whitespace
  isSubSyllable?: boolean;   // True wenn Teil eines Wortes ohne Leerzeichen ("so" in "social")
}
```

---

## 2. Phase-für-Phase Umsetzungs-Plan

---

### Phase 1: Universal Lyrics Ingestion Engine (`lyrics_parser.py`)
* [ ] **1.1 Format-Erkennungs-Pipeline (Auto-Detection):**
  * Dateiendung-Check (`.lrc`, `.ttml`, `.xml`, `.lyricsplus`, `.json`, `.vtt`, `.srt`, `.qrc`, `.krc`, `.txt`).
  * Inhalts-Sniffer (XML-Root `<tt>`, JSON `syllabus`/`lyrics`, LRC-Stamps `[mm:ss.xx]`, VTT-Header `WEBVTT`).
* [ ] **1.2 Standard & Enhanced LRC Parser:**
  * Multi-Timestamp Auflösung `[00:15.20][01:30.50]Chorus`.
  * Inline-Word-Tags `<mm:ss.xx>word` mit Dauerberechnung (`word[i+1].start - word[i].start`).
  * Klammer-Ad-Lib Extraktion `(adlib)` in `adlib` und `adlibSyllabi`.
* [ ] **1.3 TTML XML & LyricsPlus JSON Parser:**
  * Hierarchischer Tag-Stack (`ttm:role="x-bg"`, `ttm:agent="v1|v2"`).
  * Exakte Millisekunden-Übernahme für Silben und Sub-Silben.
* [ ] **1.4 WebVTT, SRT & Songtext-Formate:**
  * Cue-Parser mit `<v Singer>`-Extraktion und `<c.adlib>`-Tagging.
  * SRT Block-Timer.
  * Plain Text `.txt` & UltraStar Pitch-TXT Tokenizer.
* [ ] **1.5 Embedded Audio Tag Reader:**
  * ID3v2 `USLT` & `SYLT` (MP3).
  * Vorbis Comment `LYRICS` (FLAC/OGG/Opus).
  * QuickTime / MP4 `©lyr` (M4A/AAC).

---

### Phase 2: TTML XML Serialization & Batch Export (`ttml_generator.py`)
* [ ] **2.1 Apple Music TTML Generator:**
  * Konforme XML-Ausgabe mit `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="..." xmlns:lrc="...">`.
  * `<head><metadata>` mit `ttm:title`, `ttm:agent xml:id="v1"`, `ttm:agent xml:id="v2"`.
  * `<p begin="s.mmm" end="s.mmm" ttm:agent="v1">`.
  * Sub-Silben-Integrität: `<span>so</span><span>cial</span> ` (ohne Trenn-Leerzeichen).
  * Semantische Ad-Lib Spans: `<span ttm:role="x-bg"><span begin="..." end="...">...</span></span>`.
* [ ] **2.2 TTML Validator:**
  * Prüfung: Keine negativen Timings, `begin < end`, keine ungeschlossenen XML-Tags.
* [ ] **2.3 Batch Export:**
  * Erstellung von `.zip`-Archiven mit sauberen Dateinamen (`{TrackNr} - {Artist} - {Title}.ttml`).

---

### Phase 3: Polyphonie-, Ad-Lib- & Überlappungs-Engine
* [ ] **3.1 Overlap & Simultaneity Detection:**
  * Erkennung wenn `line[i+1].start < line[i].end` (Stimmen überschneiden sich).
  * Flag `isSimultaneous = true` setzen, **ohne** `line[i].end` an `line[i+1].start` zu stutzen.
  * `deriveEndsFromSyllabi()`: `line.end` passt sich immer dem echten Ende der letzten Silbe an.
* [ ] **3.2 Multi-Lane Layout Algorithmus:**
  * Dynamische Zuweisung von Spuren (Lanes 0, 1, 2) für überlappende Blöcke, damit keine visuellen Kollisionen entstehen.
* [ ] **3.3 Ad-Lib Separator & Merger:**
  * Automatische Zuweisung von geklammerten Texten zu separaten Background-Silbenströmen.
  * Tastatur-Shortcut / UI-Aktion zum Verschieben von Silben zwischen Main- und Ad-Lib-Spur.

---

### Phase 4: Line-to-Syllable AI Forced Aligner & Syllabification (`syllable_aligner.py`)
* [ ] **4.1 Line-Window Constrained Alignment:**
  * Liegt eine zeilensynchronisierte `.lrc` vor, nutzt WhisperX / Wav2Vec2 die Zeilen-Timestamps `[start, end]` als harte Grenzen.
  * Kein akustischer Drift über den Song hinweg.
* [ ] **4.2 Syllable Splitting & Phonemizer:**
  * Wörter werden über `pyphen` (oder Sprachwörterbücher) in Silben unterteilt (`beau-ti-ful`).
  * Dauer-Zuweisung: Proportional nach Vokallänge, Zeichenanzahl und akustischer Hüllkurve.
* [ ] **4.3 Normalisierung & Whitespace Alignment:**
  * Implementierung von `normalizeSyllableSpacing()` zur Vermeidung von künstlichen Binnen-Leerzeichen bei zusammengesetzten Wörtern.

---

### Phase 5: Backend Album & Projekt-Management API (`app.py`)
* [ ] **5.1 Project State Store:**
  * In-Memory & Session Projektverwaltung für Alben (`/api/project/...`).
* [ ] **5.2 Multi-File / Folder Upload Handler:**
  * `POST /api/project/upload`: Akzeptiert Audio-Dateien + zugehörige Lyrics-Dateien in einem Request.
  * **Auto-Pairing:** Gleicht Dateinamen ab (`01-song.mp3` <-> `01-song.lrc` / `song.txt`).
* [ ] **5.3 Batch Alignment Endpoint:**
  * `POST /api/project/align_all`: Führt Forced Alignment sequentiell oder parallel im Hintergrund aus.
  * `GET /api/project/status`: Live-Polling für alle Tracks im Album.
* [ ] **5.4 Single & Batch TTML Export Endpoints:**
  * `POST /api/project/export_track_ttml`
  * `GET /api/project/export_album_zip`

---

### Phase 6: Frontend Album Dashboard & Sidebar (`static/`)
* [ ] **6.1 Album Explorer Sidebar:**
  * Tracklist mit Track-Nummer, Titel, Interpret, Dauer.
  * Status-Badges:
    * 🟣 `Line LRC` (Zeilensynchronisiert)
    * 🟢 `TTML Ready` (Silbensynchronisiert)
    * 🟡 `Plain Text` (Nur Text)
    * ⚪ `Audio Only`
  * 1-Klick Track-Umschalter mit sofortigem Laden im Editor.
* [ ] **6.2 Folder Drag & Drop Zone:**
  * Ganze Albumordner mit `webkitdirectory` hineinziehen.
  * Auto-Erkennung aller Tracks und Lyrics.
* [ ] **6.3 Album Header & Batch Toolbar:**
  * Albumtitel, Artist, Gesamtlaufzeit, Track-Zähler.
  * Buttons: `⚡ Batch Align Album`, `💾 Export All TTML (.zip)`.

---

### Phase 7: Multi-Lane Timeline & Syllable Editor (`eh-editor.js` Refactor)
* [ ] **7.1 Waveform Alignment Fix:**
  * Entfernung von CSS `width: 100%` auf dem Waveform-Canvas.
  * Einheitliche Pixel-Breite (`totalWidth = Math.max(duration * pps, scroll.clientWidth)`).
  * AudioBuffer-Dauer Synchronisation.
* [ ] **7.2 Multi-Lane Rendering:**
  * **Lane 1 (Lead Vocal / v1):** Zeilenblöcke + Silben-Chips.
  * **Lane 2 (Ad-lib / x-bg):** Eigene Spur für Background-Gesang.
  * **Lane 3 (Duet / v2):** Eigene Spur für zweite Stimme.
* [ ] **7.3 Silben-Feinjustierung:**
  * Trim-Handles an den Silben-Rändern (Start/Ende verschieben).
  * Silben trennen (Split) / zusammenfügen (Merge).
  * Hotkeys:
    * `B` = Silbe / Zeile als Ad-lib (`ttm:role="x-bg"`) toggeln.
    * `1` / `2` = Singer Agent `v1` / `v2` zuweisen.
    * `Space` = Play / Pause.
    * `Enter` = Neue Silbe / Zeile am Playhead.

---

### Phase 8: Live Apple Music Karaoke Sweep Player
* [ ] **8.1 CSS-Linear-Gradient Mask Sweep Engine:**
  * Portierung des echten Apple Music Wipe-Effekts (`@keyframes wipe` mit `-webkit-mask-image`).
  * Flüsterleise und GPU-beschleunigt (keine Layout-Reflows bei 60 fps).
* [ ] **8.2 Visuelle Hierarchie:**
  * Lead-Gesang: Groß, Weiß, zentriert / links.
  * Ad-libs (`x-bg`): Kursiv, dezent kleiner, transluzent.
  * Duette (`v2`): Rechtsbündig, farblich subtil differenziert.
* [ ] **8.3 Auto-Scroll & Seek-on-Click:**
  * Klick auf eine Zeile oder Silbe springt sofort zur exakten Audio-Position.

---

### Phase 9: Syllable Tap Sync (Multi-Voice) (`eh-tap.js` Refactor)
* [ ] **9.1 Multi-Voice Tap Engine:**
  * Erstes Drücken von `Space` startet das Audio synchron.
  * `Space` = Silbe tappen.
  * `B + Space` = Ad-lib Silbe tappen.
  * `Backspace` = Silbe zurücknehmen.
  * `S` = Silbe überspringen (interpoliertes Timing).
* [ ] **9.2 Live Waveform Scrolling:**
  * Scrolling Waveform mit fixiertem Playhead bei 30% und grünen Silben-Markern.

---

### Phase 10: End-to-End Verifikation & Legacy Cleanup
* [ ] **10.1 E2E Testing:**
  * Test mit echtem Album-Ordner (MP3/FLAC + LRC/TXT).
  * Konvertierung von Zeilen-LRC -> Silben-TTML.
  * Überprüfung der generierten `.ttml`-Dateien im Sweep Player und in externen TTML-Validatoren.
* [ ] **10.2 Cleanup:**
  * Löschen der toten Monolithen `app.js` und `enhanced.js`.
  * Bereinigung alter LRC-Export-Reste zugunsten der reinen TTML-Pipeline.

---

## 📅 Roadmap Status & Fortschritt

| Phase | Modul | Status |
| :--- | :--- | :--- |
| **Phase 1** | Universal Lyrics Ingestion Parser | ⏳ Bereit zum Start |
| **Phase 2** | TTML XML Generator & Validator | ⏳ Geplant |
| **Phase 3** | Polyphonie- & Ad-Lib Engine | ⏳ Geplant |
| **Phase 4** | Syllable AI Forced Aligner | ⏳ Geplant |
| **Phase 5** | Album Backend API | ⏳ Geplant |
| **Phase 6** | Album Dashboard & Sidebar | ⏳ Geplant |
| **Phase 7** | Multi-Lane Timeline Editor | ⏳ Geplant |
| **Phase 8** | Apple Music Sweep Player | ⏳ Geplant |
| **Phase 9** | Multi-Voice Tap Sync | ⏳ Geplant |
| **Phase 10** | E2E Testing & Cleanup | ⏳ Geplant |

