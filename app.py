"""
LRC Generator – FastAPI Backend
Whisper transcription + optional UVR5 vocal isolation via audio-separator.
"""

import os
import sys
import io
import uuid
import re
import logging
import threading
from pathlib import Path
from typing import Optional
from difflib import SequenceMatcher

if sys.platform == "win32":
    import subprocess
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# Configure live console logging to sys.stdout
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)]
)
for log_name in ["separator", "uvicorn", "uvicorn.access"]:
    l = logging.getLogger(log_name)
    l.setLevel(logging.INFO)
    if not any(isinstance(h, logging.StreamHandler) for h in l.handlers):
        l.addHandler(logging.StreamHandler(sys.stdout))

from fastapi import FastAPI, UploadFile, File, Form, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.middleware.cors import CORSMiddleware

from lyrics_parser import UniversalLyricsParser
from ttml_engine import TTMLEngine
from syllable_aligner import SyllableAligner

# ─── Setup ────────────────────────────────────────────────────────────────────

app = FastAPI(title="TTML Lyrics Studio")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

for d in ["uploads", "outputs", "static", "projects"]:
    Path(d).mkdir(exist_ok=True)

app.mount("/static", StaticFiles(directory="static"), name="static")

# In-memory stores
jobs: dict = {}
projects: dict = {}

ALLOWED_EXTS = {".mp3", ".flac", ".wav", ".m4a", ".ogg", ".opus", ".aac"}
LYRICS_EXTS = {".lrc", ".ttml", ".xml", ".lyricsplus", ".json", ".vtt", ".srt", ".qrc", ".krc", ".txt", ".lyrics"}
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
    # Allow UUIDs and generated vocals stems like {uuid}_(Vocals)_UVR-MDX-NET-Inst_HQ_3
    clean_id = Path(file_id).stem
    for ext in ALLOWED_EXTS:
        path = Path(f"uploads/{clean_id}{ext}")
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
                 message="Vocals isolated [OK]", vocals_path=vocals_path)
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


def _extract_audio_metadata(file_path: str) -> dict:
    meta = {"title": "", "artist": "", "album": "", "track": 1, "duration": 0.0}
    try:
        import mutagen
        audio = mutagen.File(file_path, easy=True)
        if audio:
            if hasattr(audio, "info") and hasattr(audio.info, "length"):
                meta["duration"] = round(audio.info.length, 3)
            meta["title"] = (audio.get("title") or [""])[0]
            meta["artist"] = (audio.get("artist") or [""])[0]
            meta["album"] = (audio.get("album") or [""])[0]
            tr = (audio.get("tracknumber") or ["1"])[0]
            try:
                meta["track"] = int(str(tr).split("/")[0])
            except Exception:
                meta["track"] = 1
    except Exception:
        pass
    return meta


# ─── Album & Project Management Endpoints ─────────────────────────────────────

@app.post("/api/project/upload_audio")
async def upload_audio_files(files: list[UploadFile] = File(...)):
    """Uploads only audio files to create an album project with tracks."""
    project_id = str(uuid.uuid4())
    saved_audios: list[dict] = []

    for f in files:
        fname = f.filename or ""
        ext = Path(fname).suffix.lower()
        if ext not in ALLOWED_EXTS:
            continue
        content = await f.read()
        file_id = str(uuid.uuid4())
        save_path = Path(f"uploads/{file_id}{ext}")
        save_path.write_bytes(content)
        stem = Path(fname).stem
        saved_audios.append({
            "file_id": file_id,
            "filename": fname,
            "stem": stem,
            "path": str(save_path),
            "ext": ext,
        })

    if not saved_audios:
        return JSONResponse({"error": "No supported audio files uploaded (MP3, FLAC, WAV, M4A, OGG, OPUS, AAC)."}, status_code=400)

    tracks: list[dict] = []
    album_title = ""
    album_artist = ""

    for idx, a_info in enumerate(saved_audios):
        track_file_id = a_info["file_id"]
        track_fname   = a_info["filename"]
        track_path    = a_info["path"]
        stem          = a_info["stem"]

        tag_meta = _extract_audio_metadata(track_path)
        title = tag_meta["title"] or re.sub(r"^\d+[\s._-]+", "", stem).strip() or stem
        artist = tag_meta["artist"] or ""
        album = tag_meta["album"] or ""
        track_nr = tag_meta["track"] or (idx + 1)
        duration = tag_meta["duration"]

        if album and not album_title:
            album_title = album
        if artist and not album_artist:
            album_artist = artist

        # Check embedded audio tags (USLT / SYLT / Vorbis)
        canonical_lyrics: dict[str, Any] = {"meta": {}, "lines": []}
        input_fmt = "none"
        status = "empty"

        embedded = UniversalLyricsParser.parse_embedded_audio_tags(track_path)
        if embedded and embedded.get("lines"):
            canonical_lyrics = embedded
            input_fmt = "embedded"
            has_syls = any(len(l.get("rawSyllabi", [])) > 0 for l in canonical_lyrics.get("lines", []))
            status = "syllable_synced" if has_syls else "line_synced"

        tracks.append({
            "id": f"track-{idx+1}",
            "trackNumber": track_nr,
            "filename": track_fname,
            "fileId": track_file_id,
            "title": title,
            "artist": artist,
            "duration": duration,
            "audioUrl": f"/api/audio/{track_file_id}",
            "inputFormat": input_fmt,
            "status": status,
            "lyrics": canonical_lyrics,
        })

    # Sort tracks by track number
    tracks.sort(key=lambda t: t["trackNumber"])

    project_data = {
        "id": project_id,
        "title": album_title or "My Album",
        "artist": album_artist or "Various Artists",
        "tracks": tracks,
    }
    projects[project_id] = project_data
    return {"project_id": project_id, "project": project_data}


@app.post("/api/project/{project_id}/upload_lyrics")
async def upload_project_lyrics(project_id: str, files: list[UploadFile] = File(...)):
    """Uploads lyrics files and matches them to tracks in an existing project."""
    if project_id not in projects:
        return JSONResponse({"error": "Project not found"}, status_code=404)

    project = projects[project_id]
    matched_count = 0
    match_details = []

    for f in files:
        fname = f.filename or ""
        content = await f.read()
        stem = Path(fname).stem.lower()
        norm_stem = re.sub(r"^\d+[\s._-]+", "", stem).strip()
        track_nr_match = re.match(r"^(\d+)", stem)
        target_nr = int(track_nr_match.group(1)) if track_nr_match else None

        parsed_lyrics = UniversalLyricsParser.parse(content, filename=fname)
        has_syls = any(len(l.get("rawSyllabi", [])) > 0 for l in parsed_lyrics.get("lines", []))
        status = "syllable_synced" if has_syls else ("line_synced" if parsed_lyrics.get("lines") else "raw_lyrics")
        input_fmt = parsed_lyrics.get("meta", {}).get("source", "lrc")

        # Find best matching track in project
        matched_track = None

        # 1. Match by exact track number if available
        if target_nr is not None:
            matched_track = next((t for t in project["tracks"] if t.get("trackNumber") == target_nr), None)

        # 2. Match by stem or normalized stem
        if not matched_track:
            for t in project["tracks"]:
                t_stem = Path(t.get("filename", "")).stem.lower()
                t_norm = re.sub(r"^\d+[\s._-]+", "", t_stem).strip()
                t_title = (t.get("title") or "").lower().strip()

                if stem == t_stem or norm_stem == t_norm or (t_title and t_title in stem) or (norm_stem and norm_stem in t_title):
                    matched_track = t
                    break

        if matched_track:
            matched_track["lyrics"] = parsed_lyrics
            matched_track["inputFormat"] = input_fmt
            matched_track["status"] = status
            matched_count += 1
            match_details.append({"file": fname, "matched_track": matched_track["title"], "track_id": matched_track["id"]})

    return {
        "status": "ok",
        "matched_count": matched_count,
        "details": match_details,
        "project": project,
    }


@app.post("/api/project/{project_id}/track/{track_id}/set_lyrics")
async def set_track_lyrics_direct(project_id: str, track_id: str, request: Request):
    """Directly sets lyrics text or parsed JSON for a specific track."""
    if project_id not in projects:
        return JSONResponse({"error": "Project not found"}, status_code=404)

    project = projects[project_id]
    target_track = next((t for t in project["tracks"] if t["id"] == track_id), None)
    if not target_track:
        return JSONResponse({"error": "Track not found"}, status_code=404)

    data = await request.json()
    raw_text = data.get("text")
    filename = data.get("filename")

    if raw_text is not None:
        parsed = UniversalLyricsParser.parse(raw_text, filename=filename)
        target_track["lyrics"] = parsed
        has_syls = any(len(l.get("rawSyllabi", [])) > 0 for l in parsed.get("lines", []))
        target_track["status"] = "syllable_synced" if has_syls else ("line_synced" if parsed.get("lines") else "raw_lyrics")
        target_track["inputFormat"] = parsed.get("meta", {}).get("source", "custom")
    elif "lyrics" in data:
        target_track["lyrics"] = data["lyrics"]
        has_syls = any(len(l.get("rawSyllabi", [])) > 0 for l in target_track["lyrics"].get("lines", []))
        target_track["status"] = "syllable_synced" if has_syls else "line_synced"

    return {"status": "ok", "track": target_track}


@app.post("/api/project/upload_album")
async def upload_album(files: list[UploadFile] = File(...)):
    """
    Accepts whole album folders / multi-file drops (Audio + LRC/TTML/TXT),
    auto-pairs matching tracks, extracts metadata & embedded tags, and returns Project.
    """
    project_id = str(uuid.uuid4())
    saved_audios: list[dict] = []
    saved_lyrics: dict[str, dict] = {}   # stem_lower -> {filename, content}

    for f in files:
        fname = f.filename or ""
        ext = Path(fname).suffix.lower()
        content = await f.read()

        if ext in ALLOWED_EXTS:
            file_id = str(uuid.uuid4())
            save_path = Path(f"uploads/{file_id}{ext}")
            save_path.write_bytes(content)
            stem = Path(fname).stem
            saved_audios.append({
                "file_id": file_id,
                "filename": fname,
                "stem": stem,
                "path": str(save_path),
                "ext": ext,
            })
        elif ext in LYRICS_EXTS:
            stem = Path(fname).stem.lower()
            norm_stem = re.sub(r"^\d+[\s._-]+", "", stem).strip()
            saved_lyrics[stem] = {"filename": fname, "content": content}
            saved_lyrics[norm_stem] = {"filename": fname, "content": content}

    if not saved_audios:
        return JSONResponse({"error": "No supported audio files uploaded."}, status_code=400)

    tracks: list[dict] = []
    album_title = ""
    album_artist = ""

    for idx, a_info in enumerate(saved_audios):
        track_file_id = a_info["file_id"]
        track_fname   = a_info["filename"]
        track_path    = a_info["path"]
        stem          = a_info["stem"]
        stem_lower    = stem.lower()
        norm_stem     = re.sub(r"^\d+[\s._-]+", "", stem_lower).strip()

        tag_meta = _extract_audio_metadata(track_path)
        title = tag_meta["title"] or re.sub(r"^\d+[\s._-]+", "", stem).strip() or stem
        artist = tag_meta["artist"] or ""
        album = tag_meta["album"] or ""
        track_nr = tag_meta["track"] or (idx + 1)
        duration = tag_meta["duration"]

        if album and not album_title:
            album_title = album
        if artist and not album_artist:
            album_artist = artist

        matched_lrc = saved_lyrics.get(stem_lower) or saved_lyrics.get(norm_stem)
        canonical_lyrics: dict[str, Any] = {"meta": {}, "lines": []}
        input_fmt = "none"
        status = "empty"

        if matched_lrc:
            canonical_lyrics = UniversalLyricsParser.parse(
                matched_lrc["content"], filename=matched_lrc["filename"])
            input_fmt = canonical_lyrics.get("meta", {}).get("source", "lrc")
            has_syls = any(len(l.get("rawSyllabi", [])) > 0 for l in canonical_lyrics.get("lines", []))
            status = "syllable_synced" if has_syls else ("line_synced" if canonical_lyrics.get("lines") else "raw_lyrics")
        else:
            embedded = UniversalLyricsParser.parse_embedded_audio_tags(track_path)
            if embedded and embedded.get("lines"):
                canonical_lyrics = embedded
                input_fmt = "embedded"
                has_syls = any(len(l.get("rawSyllabi", [])) > 0 for l in canonical_lyrics.get("lines", []))
                status = "syllable_synced" if has_syls else "line_synced"

        tracks.append({
            "id": f"track-{idx+1}",
            "trackNumber": track_nr,
            "filename": track_fname,
            "fileId": track_file_id,
            "title": title,
            "artist": artist,
            "duration": duration,
            "audioUrl": f"/api/audio/{track_file_id}",
            "inputFormat": input_fmt,
            "status": status,
            "lyrics": canonical_lyrics,
        })

    tracks.sort(key=lambda t: t["trackNumber"])

    project_data = {
        "id": project_id,
        "title": album_title or "My Album",
        "artist": album_artist or "Various Artists",
        "tracks": tracks,
    }
    projects[project_id] = project_data

    return {"project_id": project_id, "project": project_data}


@app.get("/api/project/{project_id}")
async def get_project(project_id: str):
    if project_id in projects:
        return projects[project_id]
    
    # Try loading from disk
    proj_file = Path(f"projects/{project_id}.json")
    if proj_file.exists():
        try:
            import json
            data = json.loads(proj_file.read_text(encoding="utf-8"))
            projects[project_id] = data
            return data
        except Exception:
            pass

    return JSONResponse({"error": "Project not found"}, status_code=404)


@app.get("/api/project_latest")
async def get_latest_project():
    """Returns the most recently modified project JSON from the projects folder."""
    import json
    p_dir = Path("projects")
    if not p_dir.exists():
        return JSONResponse({"error": "No projects found"}, status_code=404)
    files = list(p_dir.glob("*.json"))
    if not files:
        return JSONResponse({"error": "No projects found"}, status_code=404)
    latest_file = max(files, key=lambda f: f.stat().st_mtime)
    try:
        data = json.loads(latest_file.read_text(encoding="utf-8"))
        projects[data.get("id")] = data
        return data
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)



@app.post("/api/project/save_project")
async def save_project_to_disk(request: Request):
    """Persists a complete project JSON to disk."""
    import json
    data = await request.json()
    project_id = data.get("id") or str(uuid.uuid4())
    data["id"] = project_id
    projects[project_id] = data
    
    proj_file = Path(f"projects/{project_id}.json")
    proj_file.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    return {"status": "ok", "project_id": project_id, "project": data}


@app.post("/api/project/restore_project")
async def restore_project_file(files: list[UploadFile] = File(...)):
    """Restores a project from an uploaded .lrcproj or .json file."""
    import json
    if not files:
        return JSONResponse({"error": "No file uploaded"}, status_code=400)
    
    file = files[0]
    content = await file.read()
    try:
        project_data = json.loads(content.decode("utf-8"))
    except Exception as e:
        return JSONResponse({"error": f"Invalid project file: {e}"}, status_code=400)
    
    project_id = project_data.get("id") or str(uuid.uuid4())
    project_data["id"] = project_id
    projects[project_id] = project_data
    
    proj_file = Path(f"projects/{project_id}.json")
    proj_file.write_text(json.dumps(project_data, indent=2, ensure_ascii=False), encoding="utf-8")
    
    return {"status": "ok", "project_id": project_id, "project": project_data}


@app.post("/api/project/{project_id}/update_track")
async def update_project_track(project_id: str, request: Request):
    if project_id not in projects:
        return JSONResponse({"error": "Project not found"}, status_code=404)

    data = await request.json()
    track_id = data.get("track_id")
    project = projects[project_id]

    for tr in project["tracks"]:
        if tr["id"] == track_id:
            if "lyrics" in data:
                tr["lyrics"] = data["lyrics"]
                has_syls = any(len(l.get("rawSyllabi", [])) > 0 for l in tr["lyrics"].get("lines", []))
                tr["status"] = "syllable_synced" if has_syls else ("line_synced" if tr["lyrics"].get("lines") else "empty")
            if "title" in data:
                tr["title"] = data["title"].strip()
            if "artist" in data:
                tr["artist"] = data["artist"].strip()
            if "status" in data:
                tr["status"] = data["status"]
            return {"status": "ok", "track": tr}

    return JSONResponse({"error": "Track not found"}, status_code=404)


@app.post("/api/project/{project_id}/align_track")
async def align_project_track(project_id: str, request: Request):
    if project_id not in projects:
        return JSONResponse({"error": "Project not found"}, status_code=404)

    data = await request.json()
    track_id = data.get("track_id")
    language = data.get("language", "en")
    mode = data.get("mode", "studio_ai") # "studio_ai" | "fast"
    use_whisper = (mode == "studio_ai") and data.get("use_whisper", True)
    whisper_model = data.get("whisper_model", "base")
    uvr_model_id = data.get("uvr_model_id", "UVR-MDX-NET-Inst_HQ_3")

    project = projects[project_id]
    target_track = next((t for t in project["tracks"] if t["id"] == track_id), None)
    if not target_track:
        return JSONResponse({"error": "Track not found"}, status_code=404)

    file_id = target_track["fileId"]
    audio_path = None
    for ext in ALLOWED_EXTS:
        p = Path(f"uploads/{file_id}{ext}")
        if p.exists():
            audio_path = str(p)
            break

    if not audio_path:
        return JSONResponse({"error": "Audio file not found"}, status_code=404)

    print(f"\n==================================================================", flush=True)
    print(f"[AI Studio] Aligning Track: '{target_track.get('title')}'", flush=True)
    print(f"[AI Studio] Mode: {mode.upper()} | Language: {language} | Whisper: {use_whisper}", flush=True)

    align_audio_path = audio_path

    # If Studio AI mode, isolate vocals with Demucs / UVR5 first
    if mode == "studio_ai":
        try:
            cached_vocals = target_track.get("vocalsPath")
            if cached_vocals and Path(cached_vocals).exists():
                print(f"[AI Studio] Using cached isolated vocals: {cached_vocals}", flush=True)
                align_audio_path = cached_vocals
            else:
                print(f"[AI Studio] Step 1/2: Isolating vocals with UVR-MDX-NET model...", flush=True)
                job_id = str(uuid.uuid4())
                jobs[job_id] = {"status": "running", "progress": 10, "message": "Isolating vocals..."}
                vocals_path = _run_vocal_separation(job_id, audio_path, uvr_model_id)
                if vocals_path and Path(vocals_path).exists() and vocals_path != audio_path:
                    target_track["vocalsPath"] = vocals_path
                    target_track["vocalsUrl"] = f"/api/audio/{Path(vocals_path).stem}"
                    align_audio_path = vocals_path
                    print(f"[AI Studio] Step 1/2 Complete: Vocals saved -> {vocals_path}", flush=True)
        except Exception as e:
            print(f"[AI Studio] Acapella separation error: {e}", flush=True)

    print(f"[AI Studio] Step 2/2: Running Phoneme & Syllable Alignment on: {align_audio_path}...", flush=True)
    aligned_lyrics = SyllableAligner.align_canonical_lyrics(
        align_audio_path,
        target_track["lyrics"],
        language=language,
        use_whisper=use_whisper,
        whisper_model=whisper_model,
    )
    target_track["lyrics"] = aligned_lyrics
    target_track["status"] = "syllable_synced"

    syllable_count = sum(len(l.get("rawSyllabi", [])) for l in aligned_lyrics.get("lines", []))
    print(f"[AI Studio] Alignment Complete! Generated {syllable_count} syllable timestamps.", flush=True)
    print(f"==================================================================\n", flush=True)

    return {
        "status": "ok",
        "track": target_track,
        "vocalsUrl": target_track.get("vocalsUrl"),
    }


@app.post("/api/parse_lyrics")
async def parse_lyrics_endpoint(request: Request):
    data = await request.json()
    text = data.get("text", "")
    filename = data.get("filename")
    parsed = UniversalLyricsParser.parse(text, filename=filename)
    return parsed


@app.post("/api/export_ttml")
async def export_ttml_endpoint(request: Request):
    data = await request.json()
    lyrics = data.get("lyrics", {"meta": {}, "lines": []})
    title = data.get("title", "")
    artist = data.get("artist", "")
    album = data.get("album", "")

    ttml_xml = TTMLEngine.generate_ttml(lyrics, title=title, artist=artist, album=album)
    safe_name = re.sub(r'[<>:"/\\|?*]', "_", f"{artist} - {title}.ttml" if (artist and title) else "lyrics.ttml")
    return Response(
        content=ttml_xml,
        media_type="application/xml; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{safe_name}"'},
    )


@app.post("/api/export_album_zip")
async def export_album_zip_endpoint(request: Request):
    data = await request.json()
    project_id = data.get("project_id")

    if project_id and project_id in projects:
        project = projects[project_id]
        tracks = project["tracks"]
        album_name = project["title"]
    else:
        tracks = data.get("tracks", [])
        album_name = data.get("album_name", "Album_TTML")

    zip_bytes = TTMLEngine.create_album_zip(tracks, album_name=album_name)
    safe_zip_name = re.sub(r'[<>:"/\\|?*]', "_", f"{album_name}_TTML.zip")
    return Response(
        content=zip_bytes,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{safe_zip_name}"'},
    )


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
    abs_audio_path = str(Path(audio_path).resolve())

    _set(job_id, status="separating_model", progress=10,
         message=f"Loading vocal separation model '{uvr_model_id}'...")

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

        print(f"\n[UVR5 / MDX-Net] Lade Modell: {model_file}...", flush=True)
        sep = Separator(
            output_dir=out_dir,
            output_format="WAV",
            normalization_threshold=0.9,
            mdx_params={"hop_length": 1024, "segment_size": 256,
                         "overlap": 0.25, "batch_size": 1},
        )
        sep.load_model(model_filename=model_file)

        _set(job_id, status="separating", progress=25,
             message=f"Isolating vocals with '{uvr_model_id}'...")

        print(f"[UVR5 / MDX-Net] Starte Gesangsisolation auf: {abs_audio_path}...", flush=True)
        output_files = sep.separate(abs_audio_path) or []

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
                 message="Vocals isolated [OK]  Starting Whisper transcription...")
            print(f"[UVR5 / MDX-Net] [OK] Gesangsisolation erfolgreich: {vocals_path}", flush=True)
            return str(vocals_path)

        # Secondary: any file with "vocal" in name (some models use "Vocal", "vocals", etc.)
        for p in resolved:
            if "vocal" in p.stem.lower():
                _set(job_id, progress=48,
                     message=f"Vocals isolated [OK] (detected via '{p.stem}').")
                print(f"[UVR5 / MDX-Net] [OK] Gesangsisolation erfolgreich: {p}", flush=True)
                return str(p)

        # Tertiary: single file returned → probably the vocals stem (MDX models return 1 file)
        if len(resolved) == 1 and resolved[0].exists():
            _set(job_id, progress=48,
                 message=f"Separation complete [OK] (using '{resolved[0].stem}').")
            print(f"[UVR5 / MDX-Net] [OK] Gesangsisolation erfolgreich: {resolved[0]}", flush=True)
            return str(resolved[0])

        # Last resort: first resolvable output
        if resolved and resolved[0].exists():
            _set(job_id, progress=48,
                 message="Separation complete (vocals stem not detected, "
                         "using first output).")
            print(f"[UVR5 / MDX-Net] [OK] Gesangsisolation (Output 1): {resolved[0]}", flush=True)
            return str(resolved[0])

        # Nothing usable — log what we got for debugging.
        print(f"[UVR5 / MDX-Net WARNUNG] Keine Ausgabedateien gefunden. Separator: {output_files!r}", flush=True)
        _set(job_id, message=f"⚠️  No output files found. "
                              f"Separator return: {output_files!r}. "
                              f"Continuing with original audio.")

    except ImportError:
        print("[UVR5 FEHLER] audio-separator ist nicht installiert.", flush=True)
        _set(job_id, message="⚠️  audio-separator not installed – "
                              "skipping vocal isolation. "
                              "Run 'pip install audio-separator[cpu]'.")
    except Exception as exc:
        print(f"[UVR5 FEHLER] Gesangsisolation fehlgeschlagen: {exc!r}", flush=True)
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
