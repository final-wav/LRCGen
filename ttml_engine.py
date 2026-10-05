"""
Apple Music TTML XML Engine & Validator
Converts Canonical Schema Version 2 to W3C / Apple Music compliant TTML XML,
handles syllable spacing normalization, sub-syllable preservation,
semantic ad-libs (x-bg), multi-singer agents, and Album ZIP export.
"""

import io
import re
import zipfile
import xml.etree.ElementTree as ET
from typing import Dict, List, Any, Optional, Tuple


def normalize_syllable_spacing(syllabi: List[Dict[str, Any]], reference_text: str) -> List[Dict[str, Any]]:
    """
    Reference-Aligned Syllable Normalization Algorithm (Specification Section 4).
    Ensures sub-syllables (e.g. 'so' + 'cial') stay contiguous while attaching
    real trailing whitespace between genuine word boundaries.
    """
    if not syllabi:
        return syllabi or []

    ref = (reference_text or "").strip()
    joined = "".join(s.get("text", "") for s in syllabi)
    if ref and joined == ref:
        return syllabi

    if ref:
        out = []
        search_pos = 0
        matched_count = 0

        for i, syl in enumerate(syllabi):
            raw_text = syl.get("text", "")
            if not raw_text:
                out.append(syl)
                continue

            trimmed = raw_text.strip()
            match_idx = ref.find(trimmed, search_pos)
            if match_idx == -1:
                match_idx = ref.lower().find(trimmed.lower(), search_pos)

            if match_idx == -1:
                trailing = " " if (i < len(syllabi) - 1 and not raw_text.endswith(" ") and not raw_text.endswith("-")) else ""
                out.append({**syl, "text": raw_text + trailing})
                continue

            matched_count += 1
            end_idx = match_idx + len(trimmed)
            search_pos = end_idx

            # Extract actual trailing whitespace from reference text
            trailing_spaces = ""
            while search_pos < len(ref) and ref[search_pos].isspace():
                trailing_spaces += ref[search_pos]
                search_pos += 1

            out.append({
                **syl,
                "text": trimmed + (trailing_spaces or (" " if raw_text.endswith(" ") else ""))
            })

        if matched_count > 0:
            return out

    # Fallback heuristic
    out = []
    for i, syl in enumerate(syllabi):
        raw_text = syl.get("text", "")
        trimmed = raw_text.strip()
        next_syl = syllabi[i + 1] if i + 1 < len(syllabi) else None
        next_text = next_syl.get("text", "").strip() if next_syl else ""
        is_sub = trimmed.endswith("-")
        is_next_punct = bool(re.match(r"^[.,!?:;)]", next_text))
        trailing = " " if (i < len(syllabi) - 1 and not is_sub and not is_next_punct) else ""
        out.append({**syl, "text": trimmed + trailing})

    return out


class TTMLEngine:
    """Serializes Canonical Schema v2 into Apple Music TTML XML and creates Album ZIP packages."""

    @staticmethod
    def _fmt_ts(sec: float) -> str:
        """Format timestamp in seconds (float) or milliseconds to 00:00.000 or raw seconds 40.013."""
        return f"{sec:.3f}"

    @classmethod
    def generate_ttml(
        cls,
        lyrics_data: Dict[str, Any],
        title: Optional[str] = None,
        artist: Optional[str] = None,
        album: Optional[str] = None,
    ) -> str:
        """Generate Apple Music compliant TTML XML from Canonical Schema v2."""
        meta = lyrics_data.get("meta", {})
        lines = lyrics_data.get("lines", [])

        song_title = title or meta.get("title", "Untitled")
        song_artist = artist or meta.get("artist", "Unknown Artist")
        song_album = album or meta.get("album", "")

        for idx in range(1, len(lines)):
            prev_line = lines[idx - 1]
            curr_line = lines[idx]
            if float(curr_line.get("start", 0)) < float(prev_line.get("end", 0)) - 0.05:
                curr_line["isSimultaneous"] = True

        agents = set()
        for line in lines:
            agents.add(line.get("agent", "v1"))
        if not agents:
            agents.add("v1")

        # Root <tt> element
        tt = ET.Element("tt", {
            "xmlns": "http://www.w3.org/ns/ttml",
            "xmlns:ttm": "http://www.w3.org/ns/ttml#metadata",
            "xmlns:lrc": "https://github.com/Steve-Tech/enhanced-lrc",
        })

        # <head><metadata>
        head = ET.SubElement(tt, "head")
        metadata = ET.SubElement(head, "metadata")

        ttm_title = ET.SubElement(metadata, "ttm:title")
        ttm_title.text = song_title

        if song_artist:
            ttm_desc = ET.SubElement(metadata, "ttm:desc")
            ttm_desc.text = f"Artist: {song_artist}"

        for agent in sorted(agents):
            ET.SubElement(metadata, "ttm:agent", {
                "xml:id": agent,
                "type": "person",
            })

        # <body><div>
        body = ET.SubElement(tt, "body")
        div = ET.SubElement(body, "div")

        for idx, line in enumerate(sorted(lines, key=lambda x: x["start"])):
            start_s = float(line.get("start", 0.0))
            end_s = float(line.get("end", start_s + 2.0))
            agent = line.get("agent", "v1")
            line_key = f"L{idx + 1}"

            p = ET.SubElement(div, "p", {
                "begin": cls._fmt_ts(start_s),
                "end": cls._fmt_ts(end_s),
                "lrc:key": line_key,
                "ttm:agent": agent,
            })

            raw_syls = [s for s in line.get("rawSyllabi", [])]
            adlib_syls = [s for s in line.get("adlibSyllabi", [])]
            main_text = line.get("text", "")
            adlib_text = line.get("adlib", "")

            # If any raw_syls have lane == 3 or explicit adlib flag, split them cleanly into background
            lead_syls = [s for s in raw_syls if s.get("lane") != 3]
            extra_bg_syls = [s for s in raw_syls if s.get("lane") == 3]
            combined_adlib_syls = adlib_syls + extra_bg_syls

            # Normalize main syllables spacing against reference text
            if lead_syls:
                norm_raw_syls = normalize_syllable_spacing(lead_syls, main_text)
                for syl in norm_raw_syls:
                    s_begin = syl["time"] / 1000.0
                    s_end = (syl["time"] + syl["duration"]) / 1000.0
                    span = ET.SubElement(p, "span", {
                        "begin": cls._fmt_ts(s_begin),
                        "end": cls._fmt_ts(s_end),
                    })
                    span.text = syl["text"]
            elif main_text:
                # Plain line fallback within line timestamp
                p.text = main_text + (" " if (adlib_text or combined_adlib_syls) else "")

            # If there is an ad-lib / background vocal, add <span ttm:role="x-bg">
            if combined_adlib_syls or adlib_text:
                bg_span = ET.SubElement(p, "span", {"ttm:role": "x-bg"})
                if combined_adlib_syls:
                    combined_adlib_syls.sort(key=lambda s: s.get("time", 0))
                    norm_adlib_syls = normalize_syllable_spacing(combined_adlib_syls, adlib_text or "")
                    for syl in norm_adlib_syls:
                        s_begin = syl["time"] / 1000.0
                        s_end = (syl["time"] + syl["duration"]) / 1000.0
                        s_sub = ET.SubElement(bg_span, "span", {
                            "begin": cls._fmt_ts(s_begin),
                            "end": cls._fmt_ts(s_end),
                        })
                        s_sub.text = syl["text"]
                else:
                    bg_span.text = f"({adlib_text})" if not adlib_text.startswith("(") else adlib_text

        # Serialize to formatted XML string
        xml_bytes = ET.tostring(tt, encoding="utf-8", xml_declaration=True)
        # Pretty print with standard indentation
        import xml.dom.minidom
        dom = xml.dom.minidom.parseString(xml_bytes)
        pretty_xml = dom.toprettyxml(indent="  ", encoding="utf-8").decode("utf-8")

        # Strip redundant empty lines added by minidom
        cleaned_xml = "\n".join([line for line in pretty_xml.splitlines() if line.strip()])
        return cleaned_xml

    @classmethod
    def validate_ttml(cls, ttml_str: str) -> Tuple[bool, List[str]]:
        """Validates TTML XML against schema rules and timing consistency."""
        errors = []
        try:
            root = ET.fromstring(ttml_str)
        except Exception as e:
            return False, [f"XML Parsing Error: {e}"]

        p_elements = root.findall(".//{http://www.w3.org/ns/ttml}p") or root.findall(".//p")
        for i, p in enumerate(p_elements):
            begin = p.get("begin")
            end = p.get("end")
            if not begin or not end:
                errors.append(f"Line {i+1}: Missing 'begin' or 'end' attribute.")
                continue

            try:
                b_val = float(begin.replace("s", ""))
                e_val = float(end.replace("s", ""))
                if b_val < 0 or e_val < 0:
                    errors.append(f"Line {i+1}: Negative timestamp detected ({b_val} -> {e_val}).")
                if e_val < b_val:
                    errors.append(f"Line {i+1}: End time ({e_val}) before begin time ({b_val}).")
            except ValueError:
                errors.append(f"Line {i+1}: Malformed timestamp '{begin}' or '{end}'.")

        return len(errors) == 0, errors

    @classmethod
    def create_album_zip(cls, album_tracks: List[Dict[str, Any]], album_name: str) -> bytes:
        """Packages all TTML files of an album into an in-memory ZIP archive."""
        zip_buf = io.BytesIO()

        with zipfile.ZipFile(zip_buf, "w", zipfile.ZIP_DEFLATED) as zip_file:
            for track in album_tracks:
                track_nr = track.get("trackNumber", 1)
                title = track.get("title") or "Track"
                artist = track.get("artist") or ""
                lyrics_data = track.get("lyrics", {"meta": {}, "lines": []})

                ttml_content = cls.generate_ttml(
                    lyrics_data,
                    title=title,
                    artist=artist,
                    album=album_name,
                )

                safe_artist = re.sub(r'[<>:"/\\|?*]', "_", artist).strip()
                safe_title = re.sub(r'[<>:"/\\|?*]', "_", title).strip()

                if safe_artist:
                    filename = f"{track_nr:02d} - {safe_artist} - {safe_title}.ttml"
                else:
                    filename = f"{track_nr:02d} - {safe_title}.ttml"

                zip_file.writestr(filename, ttml_content.encode("utf-8"))

        return zip_buf.getvalue()
