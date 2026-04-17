# LRCGen

**The first open-source, free, local, manual and AI-synced lyrics generator.**

Create perfectly timed `.lrc` karaoke/lyrics files from any audio file — fully offline, no subscriptions, no data sent to the cloud.

---

## Features

- **Drag & Drop** upload — MP3, FLAC, WAV, M4A, OGG, OPUS, AAC
- **AI Transcription** via [OpenAI Whisper](https://github.com/openai/whisper) — automatic text *and* timestamps
- **Vocal Isolation** via [UVR5 / audio-separator](https://github.com/nomadkaraoke/python-audio-separator) — strip instrumentals before transcription for dramatically better accuracy
- **Premiere Pro–style Timeline** — zoomable, scrollable, canvas waveform with scrubbing
- **Segment Blocks** — drag to move, drag edges to trim, double-click to edit inline
- **Undo / Redo** — full history (Ctrl+Z / Ctrl+Y), up to 80 steps
- **Manual lyric input** — paste your own lyrics, Whisper aligns them to the audio automatically
- **LRC Export** — download or copy to clipboard, with `[ti:]` / `[ar:]` tags
- **100% local** — runs entirely on your machine, no internet required after model download

---

## Quick Start

### 1. Install dependencies

```bat
install.bat
```

Then install PyTorch for your platform:

```bash
# CPU (works on any machine)
pip install torch torchvision torchaudio

# NVIDIA GPU (much faster — recommended)
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121
```

For GPU-accelerated vocal isolation:
```bash
pip install "audio-separator[gpu]"
```

### 2. Start the server

```bat
start.bat
```

Opens automatically at `http://127.0.0.1:8000`

---

## Manual Installation

```bash
python -m venv venv
venv\Scripts\activate        # Windows
# source venv/bin/activate   # Linux/macOS

pip install fastapi "uvicorn[standard]" python-multipart openai-whisper
pip install "audio-separator[cpu]"
pip install torch torchvision torchaudio

python -m uvicorn app:app --host 127.0.0.1 --port 8000
```

---

## Keyboard Shortcuts (Timeline Editor)

| Key | Action |
|-----|--------|
| `Space` | Play / Pause |
| `Enter` | Add segment at playhead |
| `←` / `→` | Seek ±2s |
| `Shift+←` / `Shift+→` | Seek ±10s |
| `Ctrl+Scroll` | Zoom in / out |
| `Ctrl+Z` | Undo |
| `Ctrl+Y` / `Ctrl+Shift+Z` | Redo |
| `Delete` | Delete selected segment |
| `↑` / `↓` | Navigate between segments |

---

## Vocal Isolation Models (UVR5)

| Model | Speed | Best for |
|-------|-------|---------|
| MDX-Net HQ3 | Fast | General use — **recommended** |
| MDX-Net Voc_FT | Fast | Vocal-optimized songs |
| MDX-Net KARA 2 | Fast | Karaoke tracks, cleanest vocal output |
| Demucs htdemucs_ft | Slow | Best quality, complex mixes |

Models are downloaded automatically on first use (~100–300 MB each).

---

## Tech Stack & Sources

| Component | Library / Project | License |
|-----------|------------------|---------|
| **Backend** | [FastAPI](https://fastapi.tiangolo.com/) | MIT |
| **AI Transcription** | [OpenAI Whisper](https://github.com/openai/whisper) | MIT |
| **Vocal Isolation** | [audio-separator](https://github.com/nomadkaraoke/python-audio-separator) (UVR5 models) | MIT |
| **UVR5 Models** | [Ultimate Vocal Remover](https://github.com/Anjok07/ultimatevocalremovergui) | MIT |
| **Waveform Playback** | [WaveSurfer.js](https://wavesurfer.xyz/) v7 | BSD-3 |
| **Fonts** | [Inter](https://rsms.me/inter/) + [JetBrains Mono](https://www.jetbrains.com/lp/mono/) | OFL |
| **Runtime** | [Python 3.9+](https://python.org) | PSF |
| **Deep Learning** | [PyTorch](https://pytorch.org/) | BSD |

---

## Project Structure

```
LRCGen/
├── app.py              — FastAPI backend, Whisper worker, UVR5 integration
├── requirements.txt    — Python dependencies
├── install.bat         — One-click installer (Windows)
├── start.bat           — Start server + open browser (Windows)
└── static/
    ├── index.html      — Single-page UI
    ├── style.css       — Dark theme (Premiere Pro–inspired)
    └── app.js          — Timeline editor, undo/redo, drag/trim logic
```

---

## License

MIT — free for personal and commercial use.
