"""
Universal Lyrics Ingestion Parser — Canonical Schema Version 2
Supports: LRC, Enhanced LRC, TTML XML, LyricsPlus JSON, WebVTT, SRT,
          QRC, KRC, UltraStar TXT, Plain Text, and Embedded Audio Tags.
"""

import re
import json
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Dict, List, Optional, Any, Tuple, Union


def _time_to_seconds(time_str: str) -> float:
    """Parse [mm:ss.xx], [hh:mm:ss.xxx], mm:ss.xx, or raw seconds to float."""
    time_str = time_str.strip().strip("[]<>()")
    if not time_str:
        return 0.0
    if time_str.endswith("s"):
        time_str = time_str[:-1]

    parts = time_str.split(":")
    try:
        if len(parts) == 3:
            h, m, s = float(parts[0]), float(parts[1]), float(parts[2].replace(",", "."))
            return h * 3600 + m * 60 + s
        elif len(parts) == 2:
            m, s = float(parts[0]), float(parts[1].replace(",", "."))
            return m * 60 + s
        else:
            return float(parts[0].replace(",", "."))
    except ValueError:
        return 0.0


def _sec_to_ms(sec: float) -> int:
    return int(round(sec * 1000))


def _extract_adlib_from_text(text: str) -> Tuple[str, Optional[str]]:
    """Extract parenthesized ad-lib substrings, returning (clean_main_text, clean_adlib_text)."""
    adlibs = []

    def repl(m):
        content = m.group(1).strip()
        if content:
            adlibs.append(content)
        return ""

    # Match (adlib) or [adlib] that is not a timestamp
    clean_text = re.sub(r"\(([^)]+)\)", repl, text)
    clean_text = re.sub(r"\s+", " ", clean_text).strip()
    adlib_text = " ".join(adlibs).strip() if adlibs else None
    return clean_text, adlib_text


class UniversalLyricsParser:
    """Detects and parses any audio lyrics format into Canonical Schema v2."""

    @classmethod
    def parse(cls, content: Union[str, bytes], filename: Optional[str] = None) -> Dict[str, Any]:
        """Main entry point to auto-detect and parse lyrics text or file content."""
        if isinstance(content, bytes):
            # Try utf-8, fallback to latin-1 / gbk
            for enc in ["utf-8-sig", "utf-8", "gb18030", "latin-1"]:
                try:
                    text = content.decode(enc)
                    break
                except UnicodeDecodeError:
                    continue
            else:
                text = content.decode("utf-8", errors="replace")
        else:
            text = content

        text = text.replace("\ufeff", "").strip()
        ext = Path(filename).suffix.lower() if filename else ""

        # 1. XML / TTML detection
        if ext in [".ttml", ".xml"] or text.startswith("<tt") or "<tt xmlns" in text:
            return cls.parse_ttml(text)

        # 2. QRC XML detection
        if ext == ".qrc" or "<QrcInfos" in text or "<LyricInfo" in text:
            return cls.parse_qrc(text)

        # 3. JSON / LyricsPlus detection
        if ext in [".lyricsplus", ".json"] or (text.startswith("{") and '"lyrics"' in text):
            try:
                return cls.parse_lyricsplus(text)
            except Exception:
                pass

        # 4. WebVTT detection
        if ext == ".vtt" or text.startswith("WEBVTT"):
            return cls.parse_vtt(text)

        # 5. SubRip (.srt) detection
        if ext == ".srt" or re.search(r"^\d+\r?\n\d{2}:\d{2}:\d{2}", text, re.MULTILINE):
            return cls.parse_srt(text)

        # 6. Kugou KRC detection
        if ext == ".krc" or re.search(r"\[\d+,\d+\]<\d+,\d+,\d+>", text):
            return cls.parse_krc(text)

        # 7. UltraStar TXT detection
        if "#BPM:" in text or re.search(r"^:\s*\d+\s+\d+\s+\d+", text, re.MULTILINE):
            return cls.parse_ultrastar(text)

        # 8. Enhanced LRC vs Standard LRC detection
        if re.search(r"<\d{1,3}:\d{2}", text):
            return cls.parse_enhanced_lrc(text)
        elif re.search(r"\[\d{1,3}:\d{2}", text):
            return cls.parse_standard_lrc(text)

        # 9. Fallback to Plain Text
        return cls.parse_plain_text(text)

    # ─── 1. Apple Music TTML XML Parser ──────────────────────────────────────
    @classmethod
    def parse_ttml(cls, xml_text: str) -> Dict[str, Any]:
        meta = {
            "source": "ttml",
            "schemaVersion": 2,
            "timingType": "Word",
            "title": "",
            "artist": "",
        }
        lines: List[Dict[str, Any]] = []

        try:
            # Clean default namespaces to avoid complex xpath prefixes
            clean_xml = re.sub(r'\sxmlns="[^"]+"', '', xml_text, count=1)
            root = ET.fromstring(clean_xml)
        except Exception:
            return cls.parse_plain_text(xml_text)

        # Extract title/artist from metadata
        title_el = root.find(".//metadata/*[@name='title']") or root.find(".//metadata/title")
        if title_el is not None and title_el.text:
            meta["title"] = title_el.text.strip()

        # Parse body lines
        p_elements = root.findall(".//p")
        for p in p_elements:
            p_begin = _time_to_seconds(p.get("begin", "0"))
            p_end = _time_to_seconds(p.get("end", "0"))
            agent = p.get("{http://www.w3.org/ns/ttml#metadata}agent") or p.get("ttm:agent") or "v1"

            raw_syllabi: List[Dict[str, Any]] = []
            adlib_syllabi: List[Dict[str, Any]] = []

            # Traverse child nodes / spans
            for node in p:
                if node.tag.endswith("span") or node.tag == "span":
                    role = node.get("{http://www.w3.org/ns/ttml#metadata}role") or node.get("ttm:role") or ""
                    is_bg = "x-bg" in role or role == "background"

                    # Check nested spans inside bg span
                    sub_spans = node.findall(".//span") or node.findall("span")
                    if sub_spans:
                        for s_span in sub_spans:
                            s_begin = _time_to_seconds(s_span.get("begin", str(p_begin)))
                            s_end = _time_to_seconds(s_span.get("end", str(p_end)))
                            raw_txt = (s_span.text or "")
                            raw_tail = (s_span.tail or "")
                            has_space = " " in raw_tail or "\n" in raw_tail or raw_txt.endswith(" ")
                            clean_txt = raw_txt.strip()
                            if clean_txt:
                                if has_space:
                                    clean_txt += " "
                                syl = {
                                    "time": _sec_to_ms(s_begin),
                                    "duration": max(1, _sec_to_ms(s_end - s_begin)),
                                    "text": clean_txt,
                                }
                                if is_bg:
                                    adlib_syllabi.append(syl)
                                else:
                                    raw_syllabi.append(syl)
                    else:
                        s_begin = _time_to_seconds(node.get("begin", str(p_begin)))
                        s_end = _time_to_seconds(node.get("end", str(p_end)))
                        raw_txt = (node.text or "")
                        raw_tail = (node.tail or "")
                        has_space = " " in raw_tail or "\n" in raw_tail or raw_txt.endswith(" ")
                        clean_txt = raw_txt.strip()
                        if clean_txt:
                            if has_space:
                                clean_txt += " "
                            syl = {
                                "time": _sec_to_ms(s_begin),
                                "duration": max(1, _sec_to_ms(s_end - s_begin)),
                                "text": clean_txt,
                            }
                            if is_bg:
                                adlib_syllabi.append(syl)
                            else:
                                raw_syllabi.append(syl)

            # Reconstruct clean line texts
            main_text = "".join(s["text"] for s in raw_syllabi).strip()
            adlib_text = "".join(s["text"] for s in adlib_syllabi).strip() if adlib_syllabi else None

            # If line had no spans, take p.text
            if not main_text and not adlib_text:
                full_p_text = "".join(p.itertext()).strip()
                main_text, adlib_text = _extract_adlib_from_text(full_p_text)

            # Auto-calculate line end from last syllable if 0
            if p_end <= p_begin and (raw_syllabi or adlib_syllabi):
                all_syls = raw_syllabi + adlib_syllabi
                max_ms = max((s["time"] + s["duration"]) for s in all_syls)
                p_end = max_ms / 1000.0

            lines.append({
                "id": str(len(lines)),
                "start": round(p_begin, 3),
                "end": round(p_end, 3),
                "text": main_text,
                "adlib": adlib_text,
                "rawSyllabi": raw_syllabi,
                "adlibSyllabi": adlib_syllabi,
                "agent": agent if agent in ["v1", "v2", "v3"] else "v1",
                "side": "left" if agent == "v2" else "right",
                "isSimultaneous": False,
                "laneIndex": 1 if agent == "v2" else 0,
            })

        cls._mark_simultaneous_and_lanes(lines)
        return {"meta": meta, "lines": lines}

    # ─── 2. LyricsPlus JSON Parser ───────────────────────────────────────────
    @classmethod
    def parse_lyricsplus(cls, json_str: str) -> Dict[str, Any]:
        data = json.loads(json_str)
        meta = {
            "source": "lyricsplus",
            "schemaVersion": 2,
            "timingType": data.get("type", "Word"),
            "title": data.get("title", ""),
            "artist": data.get("artist", ""),
        }
        lines: List[Dict[str, Any]] = []

        lyrics_list = data.get("lyrics", [])
        for item in lyrics_list:
            line_time_ms = item.get("time", 0)
            line_dur_ms = item.get("duration", 0)
            line_start = line_time_ms / 1000.0
            line_end = (line_time_ms + line_dur_ms) / 1000.0 if line_dur_ms > 0 else line_start + 2.5
            singer = item.get("element", {}).get("singer", "v1")

            raw_syllabi: List[Dict[str, Any]] = []
            adlib_syllabi: List[Dict[str, Any]] = []

            for syl in item.get("syllabus", []):
                s_ms = syl.get("time", line_time_ms)
                s_dur = syl.get("duration", 200)
                s_text = syl.get("text", "")
                is_bg = syl.get("isBackground", False) or syl.get("role") == "x-bg" or syl.get("bg", False)

                syl_dict = {"time": s_ms, "duration": s_dur, "text": s_text}
                if is_bg:
                    adlib_syllabi.append(syl_dict)
                else:
                    raw_syllabi.append(syl_dict)

            full_text = item.get("text", "")
            if raw_syllabi:
                main_text = "".join(s["text"] for s in raw_syllabi).strip()
            else:
                main_text, _ = _extract_adlib_from_text(full_text)

            if adlib_syllabi:
                adlib_text = "".join(s["text"] for s in adlib_syllabi).strip()
            else:
                _, adlib_text = _extract_adlib_from_text(full_text)

            lines.append({
                "id": str(len(lines)),
                "start": round(line_start, 3),
                "end": round(line_end, 3),
                "text": main_text or full_text,
                "adlib": adlib_text,
                "rawSyllabi": raw_syllabi,
                "adlibSyllabi": adlib_syllabi,
                "agent": singer if singer in ["v1", "v2", "v3"] else "v1",
                "side": "left" if singer == "v2" else "right",
                "isSimultaneous": False,
                "laneIndex": 1 if singer == "v2" else 0,
            })

        cls._mark_simultaneous_and_lanes(lines)
        return {"meta": meta, "lines": lines}

    # ─── 3. Enhanced LRC (A2 Word-Synced) Parser ─────────────────────────────
    @classmethod
    def parse_enhanced_lrc(cls, lrc_text: str) -> Dict[str, Any]:
        meta = {"source": "enhanced-lrc", "schemaVersion": 2, "timingType": "Word"}
        timed_raw = []

        for raw_line in lrc_text.splitlines():
            line = raw_line.strip()
            if not line:
                continue

            # Header match
            hm = re.match(r"^\[([a-zA-Z_]+):(.+)\]$", line)
            if hm and not re.match(r"^\d", hm.group(1)):
                meta[hm.group(1).lower()] = hm.group(2).strip()
                continue

            # Multi-timestamp line match
            stamps = re.findall(r"\[(\d{1,3}:\d{2}(?:\.\d{2,3})?)\]", line)
            if stamps:
                rest = re.sub(r"\[\d{1,3}:\d{2}(?:\.\d{2,3})?\]", "", line).strip()
                for st in stamps:
                    t = _time_to_seconds(st)
                    timed_raw.append({"ts": t, "rest": rest})

        timed_raw.sort(key=lambda x: x["ts"])
        lines: List[Dict[str, Any]] = []

        for i, item in enumerate(timed_raw):
            ts = item["ts"]
            rest = item["rest"]
            next_ts = timed_raw[i + 1]["ts"] if i + 1 < len(timed_raw) else ts + 3.0

            # Extract word tags: <00:40.01>word
            word_matches = list(re.finditer(r"<(\d{1,3}:\d{2}(?:\.\d{2,3})?)>([^<\[]*)", rest))
            raw_syllabi = []
            adlib_syllabi = []
            in_adlib = False

            if word_matches:
                for j, wm in enumerate(word_matches):
                    w_start = _time_to_seconds(wm.group(1))
                    w_text = wm.group(2)
                    if not w_text:
                        continue

                    # Next word start or line end
                    if j + 1 < len(word_matches):
                        w_next = _time_to_seconds(word_matches[j + 1].group(1))
                        w_dur = max(0.05, w_next - w_start)
                    else:
                        w_dur = max(0.1, next_ts - w_start)

                    # Check parenthesis adlib state
                    if "(" in w_text:
                        in_adlib = True
                    syl = {
                        "time": _sec_to_ms(w_start),
                        "duration": _sec_to_ms(w_dur),
                        "text": w_text.replace("(", "").replace(")", ""),
                    }
                    if in_adlib:
                        adlib_syllabi.append(syl)
                    else:
                        raw_syllabi.append(syl)

                    if ")" in w_text:
                        in_adlib = False

            main_text = "".join(s["text"] for s in raw_syllabi).strip()
            adlib_text = "".join(s["text"] for s in adlib_syllabi).strip() if adlib_syllabi else None

            if not main_text:
                plain_clean = re.sub(r"<[^>]+>", "", rest).strip()
                main_text, adlib_text = _extract_adlib_from_text(plain_clean)

            lines.append({
                "id": str(len(lines)),
                "start": round(ts, 3),
                "end": round(next_ts, 3),
                "text": main_text,
                "adlib": adlib_text,
                "rawSyllabi": raw_syllabi,
                "adlibSyllabi": adlib_syllabi,
                "agent": "v1",
                "side": "right",
                "isSimultaneous": False,
                "laneIndex": 0,
            })

        cls._mark_simultaneous_and_lanes(lines)
        return {"meta": meta, "lines": lines}

    # ─── 4. Standard Line-Synced LRC Parser ──────────────────────────────────
    @classmethod
    def parse_standard_lrc(cls, lrc_text: str) -> Dict[str, Any]:
        meta = {"source": "lrc", "schemaVersion": 2, "timingType": "Line"}
        timed_raw = []

        for raw_line in lrc_text.splitlines():
            line = raw_line.strip()
            if not line:
                continue

            hm = re.match(r"^\[([a-zA-Z_]+):(.+)\]$", line)
            if hm and not re.match(r"^\d", hm.group(1)):
                meta[hm.group(1).lower()] = hm.group(2).strip()
                continue

            stamps = re.findall(r"\[(\d{1,3}:\d{2}(?:\.\d{2,3})?)\]", line)
            if stamps:
                rest = re.sub(r"\[\d{1,3}:\d{2}(?:\.\d{2,3})?\]", "", line).strip()
                for st in stamps:
                    timed_raw.append({"ts": _time_to_seconds(st), "text": rest})

        timed_raw.sort(key=lambda x: x["ts"])
        lines: List[Dict[str, Any]] = []

        for i, item in enumerate(timed_raw):
            ts = item["ts"]
            raw_text = item["text"]
            next_ts = timed_raw[i + 1]["ts"] if i + 1 < len(timed_raw) else ts + 3.0
            main_text, adlib_text = _extract_adlib_from_text(raw_text)

            lines.append({
                "id": str(len(lines)),
                "start": round(ts, 3),
                "end": round(next_ts, 3),
                "text": main_text,
                "adlib": adlib_text,
                "rawSyllabi": [],
                "adlibSyllabi": [],
                "agent": "v1",
                "side": "right",
                "isSimultaneous": False,
                "laneIndex": 0,
            })

        cls._mark_simultaneous_and_lanes(lines)
        return {"meta": meta, "lines": lines}

    # ─── 5. WebVTT (.vtt) Parser ─────────────────────────────────────────────
    @classmethod
    def parse_vtt(cls, vtt_text: str) -> Dict[str, Any]:
        meta = {"source": "vtt", "schemaVersion": 2, "timingType": "Line"}
        lines: List[Dict[str, Any]] = []

        blocks = re.split(r"\n\s*\n", vtt_text.replace("\r\n", "\n"))
        for block in blocks:
            lines_in_block = [b.strip() for b in block.split("\n") if b.strip()]
            for j, lb in enumerate(lines_in_block):
                tm = re.match(r"(\d{2}:)?\d{2}:\d{2}[.,]\d{3}\s+-->\s+(\d{2}:)?\d{2}:\d{2}[.,]\d{3}", lb)
                if tm:
                    t_parts = lb.split("-->")
                    start_s = _time_to_seconds(t_parts[0])
                    end_s = _time_to_seconds(t_parts[1].split()[0])
                    cue_text = " ".join(lines_in_block[j + 1 :])

                    # Check voice tag <v SingerName>
                    vm = re.search(r"<v\s+([^>]+)>", cue_text)
                    agent = "v2" if vm and "2" in vm.group(1) else "v1"
                    clean_cue = re.sub(r"<[^>]+>", "", cue_text).strip()
                    main_text, adlib_text = _extract_adlib_from_text(clean_cue)

                    lines.append({
                        "id": str(len(lines)),
                        "start": round(start_s, 3),
                        "end": round(end_s, 3),
                        "text": main_text,
                        "adlib": adlib_text,
                        "rawSyllabi": [],
                        "adlibSyllabi": [],
                        "agent": agent,
                        "side": "left" if agent == "v2" else "right",
                        "isSimultaneous": False,
                        "laneIndex": 1 if agent == "v2" else 0,
                    })
                    break

        cls._mark_simultaneous_and_lanes(lines)
        return {"meta": meta, "lines": lines}

    # ─── 6. SubRip (.srt) Parser ─────────────────────────────────────────────
    @classmethod
    def parse_srt(cls, srt_text: str) -> Dict[str, Any]:
        meta = {"source": "srt", "schemaVersion": 2, "timingType": "Line"}
        lines: List[Dict[str, Any]] = []

        blocks = re.split(r"\n\s*\n", srt_text.replace("\r\n", "\n"))
        for block in blocks:
            lines_in_block = [b.strip() for b in block.split("\n") if b.strip()]
            for j, lb in enumerate(lines_in_block):
                if "-->" in lb:
                    t_parts = lb.split("-->")
                    start_s = _time_to_seconds(t_parts[0])
                    end_s = _time_to_seconds(t_parts[1].split()[0])
                    cue_text = " ".join(lines_in_block[j + 1 :])
                    clean_text = re.sub(r"<[^>]+>", "", cue_text).strip()
                    main_text, adlib_text = _extract_adlib_from_text(clean_text)

                    lines.append({
                        "id": str(len(lines)),
                        "start": round(start_s, 3),
                        "end": round(end_s, 3),
                        "text": main_text,
                        "adlib": adlib_text,
                        "rawSyllabi": [],
                        "adlibSyllabi": [],
                        "agent": "v1",
                        "side": "right",
                        "isSimultaneous": False,
                        "laneIndex": 0,
                    })
                    break

        cls._mark_simultaneous_and_lanes(lines)
        return {"meta": meta, "lines": lines}

    # ─── 7. QQ Music QRC Parser ──────────────────────────────────────────────
    @classmethod
    def parse_qrc(cls, qrc_text: str) -> Dict[str, Any]:
        meta = {"source": "qrc", "schemaVersion": 2, "timingType": "Word"}
        lines: List[Dict[str, Any]] = []

        # Find LyricContent strings with [line_time,line_dur](word_time,word_dur)word
        matches = re.finditer(r"\[(\d+),(\d+)\](.*)", qrc_text)
        for m in matches:
            l_start_ms = int(m.group(1))
            l_dur_ms = int(m.group(2))
            rest = m.group(3)

            raw_syllabi = []
            adlib_syllabi = []
            word_matches = re.finditer(r"\((\d+),(\d+)\)([^(]+)", rest)

            for wm in word_matches:
                w_start_ms = int(wm.group(1))
                w_dur_ms = int(wm.group(2))
                w_text = wm.group(3)

                syl = {"time": w_start_ms, "duration": w_dur_ms, "text": w_text}
                if "(" in w_text or ")" in w_text:
                    adlib_syllabi.append(syl)
                else:
                    raw_syllabi.append(syl)

            main_text = "".join(s["text"] for s in raw_syllabi).strip()
            adlib_text = "".join(s["text"] for s in adlib_syllabi).strip() if adlib_syllabi else None

            lines.append({
                "id": str(len(lines)),
                "start": round(l_start_ms / 1000.0, 3),
                "end": round((l_start_ms + l_dur_ms) / 1000.0, 3),
                "text": main_text or re.sub(r"\(\d+,\d+\)", "", rest).strip(),
                "adlib": adlib_text,
                "rawSyllabi": raw_syllabi,
                "adlibSyllabi": adlib_syllabi,
                "agent": "v1",
                "side": "right",
                "isSimultaneous": False,
                "laneIndex": 0,
            })

        cls._mark_simultaneous_and_lanes(lines)
        return {"meta": meta, "lines": lines}

    # ─── 8. Kugou KRC Parser ─────────────────────────────────────────────────
    @classmethod
    def parse_krc(cls, krc_text: str) -> Dict[str, Any]:
        meta = {"source": "krc", "schemaVersion": 2, "timingType": "Word"}
        lines: List[Dict[str, Any]] = []

        # [40013,1833]<0,262,0>Take <262,100,0>off
        line_matches = re.finditer(r"\[(\d+),(\d+)\](.*)", krc_text)
        for lm in line_matches:
            l_start_ms = int(lm.group(1))
            l_dur_ms = int(lm.group(2))
            rest = lm.group(3)

            raw_syllabi = []
            word_matches = re.finditer(r"<(\d+),(\d+),\d+>([^<]+)", rest)
            for wm in word_matches:
                offset_ms = int(wm.group(1))
                dur_ms = int(wm.group(2))
                w_text = wm.group(3)
                raw_syllabi.append({
                    "time": l_start_ms + offset_ms,
                    "duration": dur_ms,
                    "text": w_text,
                })

            plain = "".join(s["text"] for s in raw_syllabi).strip()
            main_text, adlib_text = _extract_adlib_from_text(plain)

            lines.append({
                "id": str(len(lines)),
                "start": round(l_start_ms / 1000.0, 3),
                "end": round((l_start_ms + l_dur_ms) / 1000.0, 3),
                "text": main_text,
                "adlib": adlib_text,
                "rawSyllabi": raw_syllabi,
                "adlibSyllabi": [],
                "agent": "v1",
                "side": "right",
                "isSimultaneous": False,
                "laneIndex": 0,
            })

        cls._mark_simultaneous_and_lanes(lines)
        return {"meta": meta, "lines": lines}

    # ─── 9. UltraStar Karaoke TXT Parser ─────────────────────────────────────
    @classmethod
    def parse_ultrastar(cls, txt_text: str) -> Dict[str, Any]:
        meta = {"source": "ultrastar", "schemaVersion": 2, "timingType": "Word"}
        bpm = 200.0
        gap_ms = 0

        for line in txt_text.splitlines():
            line = line.strip()
            if line.startswith("#BPM:"):
                try:
                    bpm = float(line.replace("#BPM:", "").replace(",", "."))
                except ValueError:
                    pass
            elif line.startswith("#GAP:"):
                try:
                    gap_ms = int(line.replace("#GAP:", ""))
                except ValueError:
                    pass
            elif line.startswith("#TITLE:"):
                meta["title"] = line.replace("#TITLE:", "").strip()
            elif line.startswith("#ARTIST:"):
                meta["artist"] = line.replace("#ARTIST:", "").strip()

        # Beat to ms conversion: beat_duration_ms = (60000 / (bpm * 4))
        beat_ms = (60000.0 / (bpm * 4.0)) if bpm > 0 else 60.0

        lines: List[Dict[str, Any]] = []
        cur_line_syls: List[Dict[str, Any]] = []

        for raw_line in txt_text.splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue

            if line.startswith("-"):  # Line break
                if cur_line_syls:
                    l_start = cur_line_syls[0]["time"] / 1000.0
                    last_syl = cur_line_syls[-1]
                    l_end = (last_syl["time"] + last_syl["duration"]) / 1000.0
                    l_text = "".join(s["text"] for s in cur_line_syls).strip()
                    main_text, adlib_text = _extract_adlib_from_text(l_text)

                    lines.append({
                        "id": str(len(lines)),
                        "start": round(l_start, 3),
                        "end": round(l_end, 3),
                        "text": main_text,
                        "adlib": adlib_text,
                        "rawSyllabi": cur_line_syls,
                        "adlibSyllabi": [],
                        "agent": "v1",
                        "side": "right",
                        "isSimultaneous": False,
                        "laneIndex": 0,
                    })
                    cur_line_syls = []
            elif line.startswith(":") or line.startswith("*") or line.startswith("F"):
                parts = line.split(maxsplit=4)
                if len(parts) >= 5:
                    start_beat = int(parts[1])
                    dur_beat = int(parts[2])
                    s_text = parts[4]
                    s_time_ms = int(round(gap_ms + start_beat * beat_ms))
                    s_dur_ms = int(round(dur_beat * beat_ms))
                    cur_line_syls.append({
                        "time": s_time_ms,
                        "duration": max(1, s_dur_ms),
                        "text": s_text,
                    })

        if cur_line_syls:
            l_start = cur_line_syls[0]["time"] / 1000.0
            last_syl = cur_line_syls[-1]
            l_end = (last_syl["time"] + last_syl["duration"]) / 1000.0
            l_text = "".join(s["text"] for s in cur_line_syls).strip()
            main_text, adlib_text = _extract_adlib_from_text(l_text)
            lines.append({
                "id": str(len(lines)),
                "start": round(l_start, 3),
                "end": round(l_end, 3),
                "text": main_text,
                "adlib": adlib_text,
                "rawSyllabi": cur_line_syls,
                "adlibSyllabi": [],
                "agent": "v1",
                "side": "right",
                "isSimultaneous": False,
                "laneIndex": 0,
            })

        cls._mark_simultaneous_and_lanes(lines)
        return {"meta": meta, "lines": lines}

    # ─── 10. Plain Text Parser ───────────────────────────────────────────────
    @classmethod
    def parse_plain_text(cls, text: str) -> Dict[str, Any]:
        meta = {"source": "plain", "schemaVersion": 2, "timingType": "Line"}
        lines: List[Dict[str, Any]] = []

        raw_lines = [l.strip() for l in text.splitlines() if l.strip()]
        for l in raw_lines:
            # Skip section headers like [Verse 1] if desired or treat as plain lines
            if re.match(r"^\[(Verse|Chorus|Bridge|Outro|Intro|Hook)[^\]]*\]$", l, re.IGNORECASE):
                continue
            main_text, adlib_text = _extract_adlib_from_text(l)
            lines.append({
                "id": str(len(lines)),
                "start": 0.0,
                "end": 0.0,
                "text": main_text,
                "adlib": adlib_text,
                "rawSyllabi": [],
                "adlibSyllabi": [],
                "agent": "v1",
                "side": "right",
                "isSimultaneous": False,
                "laneIndex": 0,
            })

        return {"meta": meta, "lines": lines}

    # ─── 11. Embedded Audio Metadata Tag Parser ──────────────────────────────
    @classmethod
    def parse_embedded_audio_tags(cls, file_path: str) -> Optional[Dict[str, Any]]:
        """Extract USLT/SYLT, Vorbis LYRICS, or MP4 ©lyr using mutagen."""
        try:
            import mutagen
            audio = mutagen.File(file_path)
            if not audio:
                return None

            # ID3 USLT / SYLT
            if hasattr(audio, "tags") and audio.tags:
                for key in audio.tags.keys():
                    if key.startswith("USLT"):
                        uslt = audio.tags[key]
                        return cls.parse(uslt.text, filename="embedded.txt")
                    if key.startswith("SYLT"):
                        sylt = audio.tags[key]
                        # SYLT format: list of (text, timestamp_ms)
                        lines = []
                        for txt, ts_ms in sylt.text:
                            lines.append(f"[{ts_ms // 60000:02d}:{(ts_ms % 60000) / 1000.0:05.2f}]{txt}")
                        return cls.parse_standard_lrc("\n".join(lines))

            # Vorbis Comments (FLAC / OGG / Opus)
            for k in ["lyrics", "unsyncedlyrics", "syncedlyrics"]:
                if k in audio:
                    return cls.parse(audio[k][0], filename="embedded.lrc")

            # MP4 / M4A (©lyr)
            if "©lyr" in audio:
                return cls.parse(audio["©lyr"][0], filename="embedded.txt")

        except Exception:
            pass
        return None

    # ─── Helper: Overlap & Lane Assignment ───────────────────────────────────
    @staticmethod
    def _mark_simultaneous_and_lanes(lines: List[Dict[str, Any]]):
        """Mark overlapping lines and assign conflict-free visual lanes."""
        lines.sort(key=lambda x: x["start"])

        # Lane tracking: stores end time of currently active block in each lane
        lane_ends: List[float] = [0.0]

        for i, line in enumerate(lines):
            start = line["start"]
            end = line["end"]

            # Check overlap with previous line
            if i > 0 and start < lines[i - 1]["end"] - 0.05:
                line["isSimultaneous"] = True

            # Assign lane
            assigned_lane = 0
            found_lane = False
            for lane_idx, l_end in enumerate(lane_ends):
                if start >= l_end - 0.05:
                    lane_ends[lane_idx] = end
                    assigned_lane = lane_idx
                    found_lane = True
                    break

            if not found_lane:
                lane_ends.append(end)
                assigned_lane = len(lane_ends) - 1

            line["laneIndex"] = assigned_lane

            # Automatically propagate assigned lane to all raw syllables of this line
            for syl in line.get("rawSyllabi", []):
                if syl.get("lane") is None or syl.get("lane") == 0:
                    syl["lane"] = assigned_lane
