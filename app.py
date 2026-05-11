"""
LRC Generator – FastAPI Backend
Whisper transcription + optional UVR5 vocal isolation via audio-separator.
"""

import os
import uuid
import re
import threading
from pathlib import Path
from typing import Optional
from difflib import SequenceMatcher

from fastapi import FastAPI, UploadFile, File, Form, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.middleware.cors import CORSMiddleware

# ─── Setup ────────────────────────────────────────────────────────────────────

app = FastAPI(title="LRC Generator")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

for d in ["uploads", "outputs", "static"]:
    Path(d).mkdir(exist_ok=True)

app.mount("/static", StaticFiles(directory="static"), name="static")

# In-memory job store
jobs: dict = {}

ALLOWED_EXTS = {".mp3", ".flac", ".wav", ".m4a", ".ogg", ".opus", ".aac"}
MIME_MAP = {
    ".mp3": "audio/mpeg", ".flac": "audio/flac", ".wav": "audio/wav",
    ".m4a": "audio/mp4",  ".ogg": "audio/ogg",  ".opus": "audio/opus",
    ".aac": "audio/aac",
}

# UVR5 model catalogue  { id: (filename, description, stems_key_for_vocals) }
# stems_key_for_vocals: which output stem name contains the clean vocals
UVR_MODELS = {
    "UVR-MDX-NET-Inst_HQ_3": {
        "filename":    "UVR-MDX-NET-Inst_HQ_3.onnx",
        "description": "MDX-Net HQ3 – fast & very accurate (recommended)",
        "vocals_stem": "Vocals",
    },
    "UVR-MDX-NET-Voc_FT": {
        "filename":    "UVR-MDX-NET-Voc_FT.onnx",
        "description": "MDX-Net Voc_FT – vocal-optimized",
        "vocals_stem": "Vocals",
    },
    "UVR_MDXNET_KARA_2": {
        "filename":    "UVR_MDXNET_KARA_2.onnx",
        "description": "MDX-Net KARA 2 – Karaoke removal, cleaner voice",
        "vocals_stem": "Vocals",
    },
    "htdemucs_ft": {
        "filename":    "htdemucs_ft",
        "description": "Demucs htdemucs_ft – best quality, slower",
        "vocals_stem": "vocals",
    },
}


# ─── Routes ───────────────────────────────────────────────────────────────────

@app.get("/")
async def root():
    return FileResponse("static/index.html")


@app.get("/api/uvr_available")
async def uvr_available():
    """Check whether audio-separator is importable."""
    try:
        import audio_separator  # noqa: F401
        return {"available": True}
    except ImportError:
        return {"available": False}


@app.get("/api/uvr_models")
async def uvr_models():
    return {
        "models": [
            {"id": k, "description": v["description"]}
            for k, v in UVR_MODELS.items()
        ]
    }


@app.post("/api/upload")
async def upload_audio(file: UploadFile = File(...)):
    ext = Path(file.filename).suffix.lower()
    if ext not in ALLOWED_EXTS:
        return JSONResponse({"error": f"Format not supported: {ext}"}, status_code=400)

    file_id   = str(uuid.uuid4())
    save_path = Path(f"uploads/{file_id}{ext}")
    save_path.write_bytes(await file.read())
    return {"file_id": file_id, "filename": file.filename}


@app.get("/api/audio/{file_id}")
async def serve_audio(file_id: str):
    if not re.fullmatch(r"[0-9a-f\-]{36}", file_id):
        return JSONResponse({"error": "Invalid ID"}, status_code=400)
    for ext in ALLOWED_EXTS:
        path = Path(f"uploads/{file_id}{ext}")
        if path.exists():
            return FileResponse(str(path), media_type=MIME_MAP.get(ext, "audio/mpeg"))
    return JSONResponse({"error": "File not found"}, status_code=404)


@app.post("/api/transcribe")
async def transcribe(
    file_id:          str  = Form(...),
    model_name:       str  = Form("base"),
    language:         str  = Form(""),
    lyrics:           str  = Form(""),
    vocal_isolation:  str  = Form("false"),   # "true" | "false"
    uvr_model_id:     str  = Form("UVR-MDX-NET-Inst_HQ_3"),
):
    allowed_whisper = {"tiny", "base", "small", "medium", "large", "large-v2", "large-v3"}
    if model_name not in allowed_whisper:
        return JSONResponse({"error": "Invalid Whisper model name"}, status_code=400)

    if not re.fullmatch(r"[0-9a-f\-]{36}", file_id):
        return JSONResponse({"error": "Invalid file ID"}, status_code=400)

    if uvr_model_id not in UVR_MODELS:
        uvr_model_id = "UVR-MDX-NET-Inst_HQ_3"

    audio_path = None
    for ext in ALLOWED_EXTS:
        p = Path(f"uploads/{file_id}{ext}")
        if p.exists():
            audio_path = str(p)
            break

    if not audio_path:
        return JSONResponse({"error": "Audio file not found"}, status_code=404)

    job_id = str(uuid.uuid4())
    jobs[job_id] = {"status": "pending", "message": "Starting…",
                    "result": None, "error": None, "progress": 0}

    use_uvr = vocal_isolation.lower() == "true"

    threading.Thread(
        target=_run_job,
        args=(job_id, audio_path, model_name, language.strip() or None,
              lyrics.strip(), use_uvr, uvr_model_id),
        daemon=True,
    ).start()

    return {"job_id": job_id}


@app.get("/api/job/{job_id}")
async def get_job(job_id: str):
    if not re.fullmatch(r"[0-9a-f\-]{36}", job_id):
        return JSONResponse({"error": "Invalid ID"}, status_code=400)
    if job_id not in jobs:
        return JSONResponse({"error": "Job not found"}, status_code=404)
    return jobs[job_id]


@app.post("/api/isolate")
async def isolate_vocals(
    file_id:      str = Form(...),
    uvr_model_id: str = Form("UVR-MDX-NET-Inst_HQ_3"),
):
    """Vocal isolation only — no Whisper. Returns a job_id to poll via /api/job/{job_id}."""
    if not re.fullmatch(r"[0-9a-f\-]{36}", file_id):
        return JSONResponse({"error": "Invalid file ID"}, status_code=400)
    if uvr_model_id not in UVR_MODELS:
        uvr_model_id = "UVR-MDX-NET-Inst_HQ_3"

    audio_path = None
    for ext in ALLOWED_EXTS:
        p = Path(f"uploads/{file_id}{ext}")
        if p.exists():
            audio_path = str(p)
            break
    if not audio_path:
        return JSONResponse({"error": "Audio file not found"}, status_code=404)

    job_id = str(uuid.uuid4())
    jobs[job_id] = {"status": "pending", "message": "Starting vocal isolation…",
                    "result": None, "error": None, "progress": 0}

    threading.Thread(
        target=_run_isolation_job,
        args=(job_id, audio_path, uvr_model_id),
        daemon=True,
    ).start()
    return {"job_id": job_id}


@app.get("/api/vocals/{job_id}")
async def serve_vocals(job_id: str):
    """Serve the isolated vocals audio for a completed isolation job."""
    if not re.fullmatch(r"[0-9a-f\-]{36}", job_id):
        return JSONResponse({"error": "Invalid ID"}, status_code=400)
    job = jobs.get(job_id)
    if not job:
        return JSONResponse({"error": "Job not found"}, status_code=404)
    if job["status"] != "done":
        return JSONResponse({"error": "Not yet finished"}, status_code=202)
    path = Path(job.get("vocals_path", ""))
    if not path.exists():
        return JSONResponse({"error": "Vocals file not found"}, status_code=404)
    ext = path.suffix.lower()
    return FileResponse(str(path), media_type=MIME_MAP.get(ext, "audio/wav"))


def _run_isolation_job(job_id: str, audio_path: str, uvr_model_id: str):
    try:
        vocals_path = _run_vocal_separation(job_id, audio_path, uvr_model_id)
        if Path(vocals_path).resolve() != Path(audio_path).resolve():
            _set(job_id, status="done", progress=100,
                 message="Vocals isolated ✓", vocals_path=vocals_path)
        else:
            _set(job_id, status="error", progress=100,
                 error="Vocal isolation failed (falling back to original)",
                 message="Isolation failed — try a different model.")
    except Exception as exc:
        _set(job_id, status="error", error=str(exc), message=f"Error: {exc}")


@app.post("/api/export")
async def export_lrc(request: Request):
    data     = await request.json()
    segments = data.get("segments", [])
    title    = data.get("title",    "").strip()
    artist   = data.get("artist",   "").strip()

    lines = []
    if title:  lines.append(f"[ti:{title}]")
    if artist: lines.append(f"[ar:{artist}]")
    lines.append("[by:LRC Generator]")
    lines.append("")

    for seg in sorted(segments, key=lambda s: s["start"]):
        s   = float(seg["start"])
        m   = int(s // 60)
        sec = s % 60
        lines.append(f"[{m:02d}:{sec:05.2f}]{seg['text'].strip()}")

    lrc      = "\n".join(lines)
    raw_name = f"{artist} - {title}.lrc" if (artist and title) else "lyrics.lrc"
    safe     = re.sub(r'[<>:"/\\|?*]', "_", raw_name)
    return Response(
        content=lrc,
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{safe}"'},
    )


# ─── Enhanced mode endpoints ──────────────────────────────────────────────────

@app.get("/api/whisperx_available")
async def whisperx_available():
    try:
        import whisperx  # noqa: F401
        return {"available": True}
    except ImportError:
        return {"available": False}


@app.post("/api/transcribe_enhanced")
async def transcribe_enhanced(
    file_id:         str = Form(...),
    model_name:      str = Form("base"),
    language:        str = Form(""),
    lyrics:          str = Form(""),
    vocal_isolation: str = Form("false"),
    uvr_model_id:    str = Form("UVR-MDX-NET-Inst_HQ_3"),
    mode:            str = Form("word"),   # "word" | "syllable"
    segment_hints:   str = Form(""),       # JSON: [{start,end,text}] from dropped LRC
):
    allowed_whisper = {"tiny", "base", "small", "medium", "large", "large-v2", "large-v3"}
    if model_name not in allowed_whisper:
        return JSONResponse({"error": "Invalid Whisper model name"}, status_code=400)
    if not re.fullmatch(r"[0-9a-f\-]{36}", file_id):
        return JSONResponse({"error": "Invalid file ID"}, status_code=400)
    if uvr_model_id not in UVR_MODELS:
        uvr_model_id = "UVR-MDX-NET-Inst_HQ_3"

    audio_path = None
    for ext in ALLOWED_EXTS:
        p = Path(f"uploads/{file_id}{ext}")
        if p.exists():
            audio_path = str(p)
            break
    if not audio_path:
        return JSONResponse({"error": "Audio file not found"}, status_code=404)

    # Parse segment hints from LRC if provided
    import json as _json
    hints: list = []
    if segment_hints.strip():
        try:
            hints = _json.loads(segment_hints)
            if not isinstance(hints, list):
                hints = []
        except Exception:
            hints = []

    job_id = str(uuid.uuid4())
    jobs[job_id] = {"status": "pending", "message": "Starting…",
                    "result": None, "error": None, "progress": 0}
    use_uvr = vocal_isolation.lower() == "true"

    threading.Thread(
        target=_run_enhanced_job,
        args=(job_id, audio_path, model_name, language.strip() or None,
              lyrics.strip(), use_uvr, uvr_model_id, mode, hints),
        daemon=True,
    ).start()
    return {"job_id": job_id}


@app.post("/api/export_enhanced")
async def export_enhanced(request: Request):
    data     = await request.json()
    segments = data.get("segments", [])
    title    = data.get("title",    "").strip()
    artist   = data.get("artist",   "").strip()
    mode     = data.get("mode",     "word")

    def fmt(t: float) -> str:
        m = int(t // 60); s = t % 60
        return f"{m:02d}:{s:05.2f}"

    lines = []
    if title:  lines.append(f"[ti:{title}]")
    if artist: lines.append(f"[ar:{artist}]")
    lines.append("[by:LRC Generator]")
    lines.append("[enhanced:true]")
    lines.append("")

    for seg in sorted(segments, key=lambda s: s["start"]):
        line_ts = f"[{fmt(seg['start'])}]"
        words   = seg.get("words", [])
        if words:
            word_parts = "".join(f"<{fmt(w['start'])}>{w['word']}<{fmt(w['end'])}>" for w in words)
            lines.append(f"{line_ts}{word_parts}")
        else:
            lines.append(f"{line_ts}{seg['text'].strip()}")

    lrc     = "\n".join(lines)
    ext     = "lrc"
    raw_name = f"{artist} - {title}.{ext}" if (artist and title) else "lyrics_enhanced.lrc"
    safe    = re.sub(r'[<>:"/\\|?*]', "_", raw_name)
    return Response(
        content=lrc,
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{safe}"'},
    )


# ─── Main worker ──────────────────────────────────────────────────────────────

def _set(job_id, **kw):
    jobs[job_id].update(kw)


def _run_job(job_id: str, audio_path: str, model_name: str,
             language: Optional[str], lyrics: str,
             use_uvr: bool, uvr_model_id: str):
    try:
        transcribe_path = audio_path   # may be replaced by vocals stem

        # ── Step 1: Vocal isolation ────────────────────────────────────────────
        if use_uvr:
            transcribe_path = _run_vocal_separation(job_id, audio_path, uvr_model_id)
            # Expose isolated file via /api/vocals/{job_id} if we got a real stems file
            if Path(transcribe_path).resolve() != Path(audio_path).resolve():
                jobs[job_id]["vocals_path"] = transcribe_path

        # ── Step 2: Whisper ────────────────────────────────────────────────────
        _set(job_id, status="loading_model", progress=50,
             message=f"Loading Whisper model '{model_name}'… "
                     f"(the model is downloaded on first run)")

        import whisper
        model = whisper.load_model(model_name)

        _set(job_id, status="transcribing", progress=65,
             message="Transcribing audio… This may take several minutes depending on length.")

        opts: dict = {"word_timestamps": True, "verbose": False}
        if language:
            opts["language"] = language

        result = model.transcribe(transcribe_path, **opts)

        # Word list for alignment
        all_words: list = []
        for seg in result.get("segments", []):
            for w in seg.get("words", []):
                word = w["word"].strip()
                if word:
                    all_words.append({"word": word, "start": w["start"], "end": w["end"]})

        raw_segments = []
        for s in result.get("segments", []):
            words = []
            for w in s.get("words", []):
                word = w.get("word", "").strip()
                if word:
                    words.append({
                        "word":  word,
                        "start": round(w["start"], 3),
                        "end":   round(w["end"],   3),
                    })
            raw_segments.append({
                "id":    s["id"],
                "start": round(s["start"], 3),
                "end":   round(s["end"],   3),
                "text":  s["text"].strip(),
                "words": words,
            })

        if lyrics:
            user_lines = [l.strip() for l in lyrics.splitlines() if l.strip()]
            segments   = _align_lyrics(all_words, user_lines) if (user_lines and all_words) else raw_segments
        else:
            segments = raw_segments

        _set(job_id, status="done", progress=100, message="Done!",
             result={"segments": segments, "language": result.get("language", "?")})

    except Exception as exc:
        _set(job_id, status="error", error=str(exc), message=f"Error: {exc}")


# ─── Enhanced job ─────────────────────────────────────────────────────────────

def _run_enhanced_job(job_id: str, audio_path: str, model_name: str,
                      language: Optional[str], lyrics: str,
                      use_uvr: bool, uvr_model_id: str, mode: str,
                      segment_hints: list = None):
    """
    segment_hints: optional list of {start, end, text} dicts parsed from a
    dropped LRC file.  When provided and WhisperX is available, we skip free
    transcription and feed the hints directly into whisperx.align() so that
    wav2vec2 does forced phoneme alignment inside each pre-known line window —
    giving much tighter word timestamps than auto-segmentation would.
    """
    segment_hints = segment_hints or []

    try:
        transcribe_path = audio_path
        if use_uvr:
            transcribe_path = _run_vocal_separation(job_id, audio_path, uvr_model_id)
            if Path(transcribe_path).resolve() != Path(audio_path).resolve():
                jobs[job_id]["vocals_path"] = transcribe_path

        # ── Try WhisperX ──────────────────────────────────────────────────────
        try:
            import whisperx
            import torch
            device       = "cuda" if torch.cuda.is_available() else "cpu"
            compute_type = "float16" if device == "cuda" else "int8"

            _set(job_id, status="loading_model", progress=50,
                 message=f"Loading WhisperX model '{model_name}'…")

            wx_model = whisperx.load_model(model_name, device, compute_type=compute_type)
            audio_arr = whisperx.load_audio(transcribe_path)

            if segment_hints:
                # ── LRC-guided path ───────────────────────────────────────────
                # The LRC already has correct line timestamps. We preserve them
                # exactly and distribute word timestamps proportionally within
                # each line by character count.  Then we optionally refine with
                # WhisperX forced alignment per-line for better word precision.
                _set(job_id, status="aligning", progress=65,
                     message="Using LRC timestamps — distributing word timing…")

                raw_segments = _proportional_word_timestamps(segment_hints)

                # Try WhisperX forced alignment per-line to refine word timestamps
                try:
                    if language:
                        lang = language
                    else:
                        all_text = " ".join(h.get("text", "") for h in segment_hints)
                        lang = _detect_language_from_text(all_text, fallback="en")

                    _set(job_id, status="aligning", progress=75,
                         message=f"Refining word timestamps with wav2vec2 (lang={lang})…")

                    align_model, metadata = whisperx.load_align_model(
                        language_code=lang, device=device)

                    hint_segs = [
                        {"start": float(h["start"]), "end": float(h["end"]),
                         "text":  str(h["text"])}
                        for h in segment_hints if h.get("text", "").strip()
                    ]
                    aligned = whisperx.align(hint_segs, align_model, metadata,
                                             audio_arr, device)

                    # Only adopt whisperx result if it produced plausible output
                    # (same number of segments and no zero-duration words)
                    wx_segs = aligned.get("segments", [])
                    if len(wx_segs) == len(raw_segments):
                        refined = []
                        ok = True
                        for i, s in enumerate(wx_segs):
                            words = []
                            for w in s.get("words", []):
                                word = w.get("word", "").strip()
                                ws   = w.get("start", 0)
                                we   = w.get("end",   0)
                                if not word or we <= ws:
                                    ok = False; break
                                words.append({"word": word,
                                              "start": round(ws, 3),
                                              "end":   round(we, 3)})
                            if not ok: break
                            refined.append({
                                "id":    i,
                                "start": round(float(segment_hints[i]["start"]), 3),
                                "end":   round(float(segment_hints[i]["end"]),   3),
                                "text":  segment_hints[i]["text"],
                                "words": words,
                            })
                        if ok and refined:
                            raw_segments = refined
                except Exception as wx_err:
                    # WhisperX refinement failed — keep proportional fallback
                    pass

                lang = language or _detect_language_from_text(
                    " ".join(h.get("text","") for h in segment_hints), "en")
                used_engine = "whisperx+lrc"

            else:
                # ── Standard path (no LRC hints) ──────────────────────────────
                # If lyrics were provided, detect language from text first so
                # we don't let Whisper guess the wrong language from singing.
                if language:
                    pre_lang = language
                elif lyrics:
                    pre_lang = _detect_language_from_text(lyrics, fallback=None)
                else:
                    pre_lang = None   # let Whisper detect from audio

                _set(job_id, status="transcribing", progress=60,
                     message="Transcribing with WhisperX…")

                result = wx_model.transcribe(audio_arr, language=pre_lang)

                _set(job_id, status="aligning", progress=75,
                     message="Running phoneme alignment (wav2vec2)…")

                lang = result.get("language", pre_lang or "en")
                align_model, metadata = whisperx.load_align_model(
                    language_code=lang, device=device)
                result = whisperx.align(result["segments"], align_model,
                                        metadata, audio_arr, device)

                raw_segments = []
                for i, s in enumerate(result.get("segments", [])):
                    words = []
                    for w in s.get("words", []):
                        word = w.get("word", "").strip()
                        if word:
                            words.append({
                                "word":  word,
                                "start": round(w.get("start", 0), 3),
                                "end":   round(w.get("end",   0), 3),
                            })
                    raw_segments.append({
                        "id":    i,
                        "start": round(s["start"], 3),
                        "end":   round(s["end"],   3),
                        "text":  s["text"].strip(),
                        "words": words,
                    })
                used_engine = "whisperx"

        except ImportError:
            # ── WhisperX not installed — fall back to plain Whisper ───────────
            _set(job_id, status="loading_model", progress=50,
                 message=f"Loading Whisper model '{model_name}'… (WhisperX not installed)")
            import whisper
            wh_model = whisper.load_model(model_name)
            _set(job_id, status="transcribing", progress=65,
                 message="Transcribing with Whisper (word timestamps)…")
            opts: dict = {"word_timestamps": True, "verbose": False}
            if language:
                opts["language"] = language
            result = wh_model.transcribe(transcribe_path, **opts)

            raw_segments = []
            for s in result.get("segments", []):
                words = []
                for w in s.get("words", []):
                    word = w.get("word", "").strip()
                    if word:
                        words.append({
                            "word":  word,
                            "start": round(w["start"], 3),
                            "end":   round(w["end"],   3),
                        })
                raw_segments.append({
                    "id":    s["id"],
                    "start": round(s["start"], 3),
                    "end":   round(s["end"],   3),
                    "text":  s["text"].strip(),
                    "words": words,
                })
            lang = result.get("language", "?")
            used_engine = "whisper"

        # ── Map to lyrics lines ───────────────────────────────────────────────
        if segment_hints and used_engine == "whisperx+lrc":
            # LRC-guided path: raw_segments already has correct line timestamps
            # and word-level timing — use as-is.
            segments = raw_segments
        elif segment_hints:
            # Plain Whisper fallback with hints: assign words to lines by time window.
            segments = _align_to_hints(raw_segments, segment_hints)
        elif lyrics:
            user_lines     = [l.strip() for l in lyrics.splitlines() if l.strip()]
            all_words_flat = [w for seg in raw_segments for w in seg["words"]]
            if user_lines and all_words_flat:
                segments = _align_lyrics(all_words_flat, user_lines)
            else:
                segments = raw_segments
        else:
            segments = raw_segments

        # ── Syllable split ────────────────────────────────────────────────────
        if mode == "syllable":
            segments = _split_to_syllables(segments)

        _set(job_id, status="done", progress=100, message="Done!",
             result={"segments": segments, "language": lang, "mode": mode,
                     "engine": used_engine})

    except Exception as exc:
        _set(job_id, status="error", error=str(exc), message=f"Error: {exc}")


def _detect_language_from_text(text: str, fallback: str = "en") -> str:
    """
    Detect language from lyrics text — far more reliable than audio detection
    on singing.  Tries langdetect first, falls back to a simple Unicode heuristic.
    """
    if not text or not text.strip():
        return fallback
    try:
        from langdetect import detect
        return detect(text) or fallback
    except Exception:
        pass
    # Simple heuristic: count printable non-ASCII chars.
    # If >80 % of chars are ASCII the text is almost certainly a Latin-script
    # language — default to English since that's the most common case.
    ascii_ratio = sum(1 for c in text if ord(c) < 128) / max(len(text), 1)
    return fallback if ascii_ratio >= 0.75 else fallback


def _proportional_word_timestamps(hints: list) -> list:
    """
    Given LRC line hints [{start, end, text}], build segments with word-level
    timestamps distributed proportionally by character count within each line.
    Line boundaries are preserved exactly — no audio analysis involved.
    """
    segments = []
    for i, h in enumerate(hints):
        text       = str(h.get("text", "")).strip()
        h_start    = float(h["start"])
        h_end      = float(h["end"])
        word_texts = text.split()

        if not word_texts:
            segments.append({"id": i, "start": round(h_start, 3),
                              "end": round(h_end, 3), "text": text, "words": []})
            continue

        duration    = max(h_end - h_start, 0.001)
        total_chars = sum(len(w) for w in word_texts) or 1
        words = []
        t = h_start
        for w in word_texts:
            dur = duration * (len(w) / total_chars)
            words.append({"word": w, "start": round(t, 3), "end": round(t + dur, 3)})
            t += dur

        segments.append({"id": i, "start": round(h_start, 3),
                          "end": round(h_end, 3), "text": text, "words": words})
    return segments


def _align_to_hints(raw_segments: list, hints: list) -> list:
    """
    Whisper fallback + LRC hints: instead of fuzzy text matching, assign
    Whisper-detected words to lines using the LRC time windows.
    Each hint {start, end, text} becomes a segment; words whose start time
    falls within [hint.start, hint.end] are attached to it.
    """
    # Flatten all detected words sorted by time
    all_words = sorted(
        [w for seg in raw_segments for w in seg["words"]],
        key=lambda w: w["start"]
    )

    segments = []
    for i, h in enumerate(hints):
        h_start = float(h["start"])
        h_end   = float(h["end"])
        text    = str(h.get("text", "")).strip()

        # Words whose start falls within this line's window
        line_words = [w for w in all_words if h_start <= w["start"] < h_end]

        segments.append({
            "id":    i,
            "start": round(h_start, 3),
            "end":   round(h_end,   3),
            "text":  text,
            "words": line_words,
        })

    return segments


def _split_to_syllables(segments: list) -> list:
    """Split word timestamps proportionally across detected syllables."""
    try:
        import pyphen
        dic = pyphen.Pyphen(lang="en")
    except ImportError:
        return segments   # pyphen not installed — return words as-is

    result = []
    for seg in segments:
        new_words = []
        for w in seg.get("words", []):
            raw      = w["word"]
            clean    = re.sub(r"[.,!?\"'""''…\-]", "", raw).strip()
            parts    = dic.inserted(clean).split("-") if clean else [raw]
            if len(parts) <= 1:
                new_words.append(w)
                continue
            duration    = w["end"] - w["start"]
            total_chars = sum(len(p) for p in parts) or 1
            t = w["start"]
            for part in parts:
                part_dur = duration * (len(part) / total_chars)
                new_words.append({
                    "word":        part,
                    "start":       round(t,            3),
                    "end":         round(t + part_dur, 3),
                    "is_syllable": True,
                })
                t += part_dur
        result.append({**seg, "words": new_words})
    return result


# ─── Vocal separation ──────────────────────────────────────────────────────────

def _run_vocal_separation(job_id: str, audio_path: str, uvr_model_id: str) -> str:
    """
    Run audio-separator with the chosen UVR5 model.
    Returns the path to the isolated vocals file.
    Falls back to the original path on any error so transcription can still run.
    """
    model_info = UVR_MODELS[uvr_model_id]
    model_file = model_info["filename"]
    stem_key   = model_info["vocals_stem"]   # e.g. "Vocals" or "vocals"

    _set(job_id, status="separating_model", progress=10,
         message=f"Loading vocal separation model '{uvr_model_id}'… "
                 f"(first run: approx. 100–300 MB download)")

    out_dir_path = Path("uploads").resolve()
    out_dir      = str(out_dir_path)

    # Helper: given whatever audio-separator returns (abs path, rel path, or bare
    # filename), find the real file on disk.
    def _resolve(f: str) -> Optional[Path]:
        if not f:
            return None
        p = Path(f)
        candidates = [p, out_dir_path / p.name, Path.cwd() / p]
        for c in candidates:
            try:
                if c.exists():
                    return c.resolve()
            except OSError:
                pass
        return None

    # Snapshot uploads dir BEFORE separation so we can identify new files after.
    try:
        before_files = {p.name for p in out_dir_path.iterdir() if p.is_file()}
    except OSError:
        before_files = set()

    try:
        from audio_separator.separator import Separator  # type: ignore

        sep = Separator(
            output_dir=out_dir,
            output_format="WAV",
            normalization_threshold=0.9,
            mdx_params={"hop_length": 1024, "segment_size": 256,
                         "overlap": 0.25, "batch_size": 1},
        )
        sep.load_model(model_filename=model_file)

        _set(job_id, status="separating", progress=25,
             message=f"Isolating vocals with '{uvr_model_id}'… "
                     f"This can take 1–3 minutes (depending on CPU/GPU and song length).")

        output_files = sep.separate(audio_path) or []

        # Resolve every returned path into something that actually exists on disk.
        resolved = [r for r in (_resolve(f) for f in output_files) if r is not None]

        # Fallback: if the library returned nothing usable, diff the output dir.
        if not resolved:
            try:
                after_files = {p.name for p in out_dir_path.iterdir() if p.is_file()}
                new_names   = after_files - before_files
                resolved    = [out_dir_path / n for n in new_names]
            except OSError:
                resolved = []

        # Prefer a path whose stem matches the expected vocals key.
        vocals_path = None
        for p in resolved:
            if stem_key.lower() in p.stem.lower():
                vocals_path = p
                break

        if vocals_path and vocals_path.exists():
            _set(job_id, progress=48,
                 message="Vocals isolated ✓  Starting Whisper transcription…")
            return str(vocals_path)

        # Secondary: any file with "vocal" in name (some models use "Vocal", "vocals", etc.)
        for p in resolved:
            if "vocal" in p.stem.lower():
                _set(job_id, progress=48,
                     message=f"Vocals isolated ✓ (detected via '{p.stem}').")
                return str(p)

        # Tertiary: single file returned → probably the vocals stem (MDX models return 1 file)
        if len(resolved) == 1 and resolved[0].exists():
            _set(job_id, progress=48,
                 message=f"Separation complete (using '{resolved[0].stem}').")
            return str(resolved[0])

        # Last resort: first resolvable output
        if resolved and resolved[0].exists():
            _set(job_id, progress=48,
                 message="Separation complete (vocals stem not detected, "
                         "using first output).")
            return str(resolved[0])

        # Nothing usable — log what we got for debugging.
        _set(job_id, message=f"⚠️  No output files found. "
                              f"Separator return: {output_files!r}. "
                              f"Continuing with original audio.")

    except ImportError:
        _set(job_id, message="⚠️  audio-separator not installed – "
                              "skipping vocal isolation. "
                              "Run 'pip install audio-separator[cpu]'.")
    except Exception as exc:
        _set(job_id, message=f"⚠️  Vocal isolation failed ({exc!r}) – "
                              f"continuing with original audio.")

    # Safe fallback: original audio
    return audio_path


# ─── Lyrics alignment ──────────────────────────────────────────────────────────

def _tokenize(text: str) -> list[str]:
    return re.findall(r"\b\w+\b", text.lower())


def _align_lyrics(all_words: list, user_lines: list) -> list:
    w_flat = [(_tokenize(w["word"]) or [""])[0] for w in all_words]
    segments, pos = [], 0

    for i, line in enumerate(user_lines):
        line_tokens = _tokenize(line)
        n = len(line_tokens)

        if not line_tokens:
            t = segments[-1]["end"] + 0.1 if segments else 0.0
            segments.append({"id": i, "start": round(t, 3), "end": round(t + 2, 3), "text": line})
            continue

        window     = max(n * 5, 40)
        search_end = min(pos + window, max(len(w_flat) - n + 1, pos + 1))

        best_score, best_start = -1.0, pos
        for start in range(pos, search_end):
            score = SequenceMatcher(None, line_tokens, w_flat[start:start + n]).ratio()
            if score > best_score:
                best_score, best_start = score, start

        end_idx = min(best_start + n - 1, len(all_words) - 1)
        if best_start < len(all_words):
            t_start = all_words[best_start]["start"]
            t_end   = all_words[end_idx]["end"]
        else:
            t_start = segments[-1]["end"] + 0.1 if segments else 0.0
            t_end   = t_start + 2.0

        segments.append({"id": i, "start": round(t_start, 3),
                         "end": round(t_end, 3), "text": line})
        pos = best_start + max(n // 2, 1)

    # Attach words to each aligned segment based on time range
    for seg in segments:
        seg["words"] = [
            w for w in all_words
            if w["start"] >= seg["start"] and w["end"] <= seg["end"] + 0.1
        ]
    return segments


# ─── Entry point ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="127.0.0.1", port=8000, reload=True)
