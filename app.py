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
        "description": "MDX-Net HQ3 – schnell & sehr präzise (empfohlen)",
        "vocals_stem": "Vocals",
    },
    "UVR-MDX-NET-Voc_FT": {
        "filename":    "UVR-MDX-NET-Voc_FT.onnx",
        "description": "MDX-Net Voc_FT – vocal-optimiert",
        "vocals_stem": "Vocals",
    },
    "UVR_MDXNET_KARA_2": {
        "filename":    "UVR_MDXNET_KARA_2.onnx",
        "description": "MDX-Net KARA 2 – Karaoke-Removal, sauberere Stimme",
        "vocals_stem": "Vocals",
    },
    "htdemucs_ft": {
        "filename":    "htdemucs_ft",
        "description": "Demucs htdemucs_ft – beste Qualität, langsamer",
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
        return JSONResponse({"error": f"Format nicht unterstützt: {ext}"}, status_code=400)

    file_id   = str(uuid.uuid4())
    save_path = Path(f"uploads/{file_id}{ext}")
    save_path.write_bytes(await file.read())
    return {"file_id": file_id, "filename": file.filename}


@app.get("/api/audio/{file_id}")
async def serve_audio(file_id: str):
    if not re.fullmatch(r"[0-9a-f\-]{36}", file_id):
        return JSONResponse({"error": "Ungültige ID"}, status_code=400)
    for ext in ALLOWED_EXTS:
        path = Path(f"uploads/{file_id}{ext}")
        if path.exists():
            return FileResponse(str(path), media_type=MIME_MAP.get(ext, "audio/mpeg"))
    return JSONResponse({"error": "Datei nicht gefunden"}, status_code=404)


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
        return JSONResponse({"error": "Ungültiger Whisper-Modellname"}, status_code=400)

    if not re.fullmatch(r"[0-9a-f\-]{36}", file_id):
        return JSONResponse({"error": "Ungültige Datei-ID"}, status_code=400)

    if uvr_model_id not in UVR_MODELS:
        uvr_model_id = "UVR-MDX-NET-Inst_HQ_3"

    audio_path = None
    for ext in ALLOWED_EXTS:
        p = Path(f"uploads/{file_id}{ext}")
        if p.exists():
            audio_path = str(p)
            break

    if not audio_path:
        return JSONResponse({"error": "Audio-Datei nicht gefunden"}, status_code=404)

    job_id = str(uuid.uuid4())
    jobs[job_id] = {"status": "pending", "message": "Wird gestartet…",
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
        return JSONResponse({"error": "Ungültige ID"}, status_code=400)
    if job_id not in jobs:
        return JSONResponse({"error": "Job nicht gefunden"}, status_code=404)
    return jobs[job_id]


@app.post("/api/isolate")
async def isolate_vocals(
    file_id:      str = Form(...),
    uvr_model_id: str = Form("UVR-MDX-NET-Inst_HQ_3"),
):
    """Vocal isolation only — no Whisper. Returns a job_id to poll via /api/job/{job_id}."""
    if not re.fullmatch(r"[0-9a-f\-]{36}", file_id):
        return JSONResponse({"error": "Ungültige Datei-ID"}, status_code=400)
    if uvr_model_id not in UVR_MODELS:
        uvr_model_id = "UVR-MDX-NET-Inst_HQ_3"

    audio_path = None
    for ext in ALLOWED_EXTS:
        p = Path(f"uploads/{file_id}{ext}")
        if p.exists():
            audio_path = str(p)
            break
    if not audio_path:
        return JSONResponse({"error": "Audio-Datei nicht gefunden"}, status_code=404)

    job_id = str(uuid.uuid4())
    jobs[job_id] = {"status": "pending", "message": "Starte Vocal Isolation…",
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
        return JSONResponse({"error": "Ungültige ID"}, status_code=400)
    job = jobs.get(job_id)
    if not job:
        return JSONResponse({"error": "Job nicht gefunden"}, status_code=404)
    if job["status"] != "done":
        return JSONResponse({"error": "Noch nicht fertig"}, status_code=202)
    path = Path(job.get("vocals_path", ""))
    if not path.exists():
        return JSONResponse({"error": "Vocals-Datei nicht gefunden"}, status_code=404)
    ext = path.suffix.lower()
    return FileResponse(str(path), media_type=MIME_MAP.get(ext, "audio/wav"))


def _run_isolation_job(job_id: str, audio_path: str, uvr_model_id: str):
    try:
        vocals_path = _run_vocal_separation(job_id, audio_path, uvr_model_id)
        if Path(vocals_path).resolve() != Path(audio_path).resolve():
            _set(job_id, status="done", progress=100,
                 message="Vocals isoliert ✓", vocals_path=vocals_path)
        else:
            _set(job_id, status="error", progress=100,
                 error="Vocal Isolation fehlgeschlagen (Fallback auf Original)",
                 message="Isolation fehlgeschlagen — versuche ein anderes Modell.")
    except Exception as exc:
        _set(job_id, status="error", error=str(exc), message=f"Fehler: {exc}")


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
             message=f"Lade Whisper-Modell '{model_name}'… "
                     f"(beim ersten Start wird das Modell heruntergeladen)")

        import whisper
        model = whisper.load_model(model_name)

        _set(job_id, status="transcribing", progress=65,
             message="Transkribiere Audio… Das kann je nach Länge einige Minuten dauern.")

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

        raw_segments = [
            {"id": s["id"], "start": round(s["start"], 3),
             "end": round(s["end"], 3), "text": s["text"].strip()}
            for s in result.get("segments", [])
        ]

        if lyrics:
            user_lines = [l.strip() for l in lyrics.splitlines() if l.strip()]
            segments   = _align_lyrics(all_words, user_lines) if (user_lines and all_words) else raw_segments
        else:
            segments = raw_segments

        _set(job_id, status="done", progress=100, message="Fertig!",
             result={"segments": segments, "language": result.get("language", "?")})

    except Exception as exc:
        _set(job_id, status="error", error=str(exc), message=f"Fehler: {exc}")


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
         message=f"Lade Vocal-Separations-Modell '{uvr_model_id}'… "
                 f"(beim ersten Start: ca. 100–300 MB Download)")

    try:
        from audio_separator.separator import Separator  # type: ignore

        out_dir = str(Path("uploads"))

        sep = Separator(
            output_dir=out_dir,
            output_format="WAV",
            normalization_threshold=0.9,
            mdx_params={"hop_length": 1024, "segment_size": 256,
                         "overlap": 0.25, "batch_size": 1},
        )
        sep.load_model(model_filename=model_file)

        _set(job_id, status="separating", progress=25,
             message=f"Isoliere Vocals mit '{uvr_model_id}'… "
                     f"Das kann 1–3 Minuten dauern (je nach CPU/GPU und Song-Länge).")

        output_files: list = sep.separate(audio_path)

        # Find the stem that contains vocals
        vocals_path = None
        for f in output_files:
            stem = Path(f).stem
            if stem_key.lower() in stem.lower():
                vocals_path = f
                break

        if vocals_path and Path(vocals_path).exists():
            _set(job_id, progress=48,
                 message="Vocals isoliert ✓  Starte Whisper-Transkription…")
            return vocals_path

        # Fallback: just use whatever the first output is
        if output_files and Path(output_files[0]).exists():
            _set(job_id, progress=48,
                 message="Separation abgeschlossen (Vocals-Stem nicht erkannt, "
                         "verwende ersten Output).")
            return output_files[0]

    except ImportError:
        _set(job_id, message="⚠️  audio-separator nicht installiert – "
                              "überspringe Vocal Isolation. "
                              "Führe 'pip install audio-separator[cpu]' aus.")
    except Exception as exc:
        _set(job_id, message=f"⚠️  Vocal Isolation fehlgeschlagen ({exc}) – "
                              f"fahre mit Original-Audio fort.")

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

    return segments


# ─── Entry point ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="127.0.0.1", port=8000, reload=True)
