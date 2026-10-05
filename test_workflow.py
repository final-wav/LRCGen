import httpx
import time
import os
import wave
import struct
import math

def run_test():
    print("=== 1. Checking Server Connection ===")
    try:
        r = httpx.get("http://127.0.0.1:8000/", timeout=5.0)
        print("Server reachable! Status:", r.status_code)
    except Exception as e:
        print("Server connection failed:", e)
        return

    print("\n=== 2. Creating Real Test Audio (10s Sine Tone & Harmonics) ===")
    audio_fn = "test_song_10s.wav"
    with wave.open(audio_fn, "w") as f:
        f.setnchannels(2)
        f.setsampwidth(2)
        f.setframerate(44100)
        for i in range(44100 * 10):
            t = i / 44100.0
            amp = 0.3 * (1.0 + 0.5 * math.sin(2.0 * math.pi * 2.0 * t))
            val1 = int(32767.0 * amp * math.sin(2.0 * math.pi * 220.0 * t))
            val2 = int(32767.0 * amp * 0.5 * math.sin(2.0 * math.pi * 440.0 * t))
            val = max(-32767, min(32767, val1 + val2))
            f.writeframes(struct.pack("<hh", val, val))
    print("Created:", audio_fn, "Size:", os.path.getsize(audio_fn), "bytes")

    print("\n=== 3. Uploading Audio to Server ===")
    with open(audio_fn, "rb") as f:
        r_audio = httpx.post(
            "http://127.0.0.1:8000/api/project/upload_audio",
            files={"files": (audio_fn, f.read(), "audio/wav")},
            timeout=30.0,
        )
    print("Upload Audio response:", r_audio.status_code)
    proj = r_audio.json()["project"]
    proj_id = proj["id"]
    track_id = proj["tracks"][0]["id"]
    print("Project ID:", proj_id, "| Track ID:", track_id)

    print("\n=== 4. Uploading Line-Synced Lyrics ===")
    lrc_content = """[00:01.00]Welcome to the studio
[00:05.00]Separating vocals and aligning syllables
"""
    r_lrc = httpx.post(
        f"http://127.0.0.1:8000/api/project/{proj_id}/upload_lyrics",
        files={"files": ("test_song_10s.lrc", lrc_content.encode("utf-8"), "text/plain")},
        timeout=30.0,
    )
    print("Upload Lyrics response:", r_lrc.status_code, "| Matched tracks:", r_lrc.json()["matched_count"])

    print("\n=== 5. Running Real Studio AI Alignment (Demucs + Syllables) ===")
    t0 = time.time()
    r_align = httpx.post(
        f"http://127.0.0.1:8000/api/project/{proj_id}/align_track",
        json={"track_id": track_id, "mode": "studio_ai", "language": "en", "use_whisper": False},
        timeout=180.0,
    )
    t1 = time.time()
    dur = round(t1 - t0, 2)
    print(f"Align Track completed in {dur} seconds! Status: {r_align.status_code}")

    data = r_align.json()
    print("Track status:", data["track"]["status"])
    print("Vocals URL:", data.get("vocalsUrl"))
    print("\n=== Resulting Syllables ===")
    for idx, line in enumerate(data["track"]["lyrics"]["lines"]):
        syls = [f"{s['text']}({s['time']}ms, {s['duration']}ms)" for s in line.get("rawSyllabi", [])]
        print(f"Line {idx+1}: {line['text']}")
        print("  Syllables:", " ".join(syls))

    # Cleanup
    if os.path.exists(audio_fn):
        os.remove(audio_fn)

if __name__ == "__main__":
    run_test()
