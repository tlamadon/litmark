"""PDF text and character geometry extraction, and the text normalization
used to match a quotation back to the characters that produced it.

Coordinate contract
-------------------
Stored rectangles are ``[x0, y0, x1, y1]`` in ``[0, 1]``, relative to the
*visible* page — that is, after the page's native rotation and crop box have
been applied — with the origin at the top-left. This is the
``displayed-cropbox-normalized-top-left`` space named in ``references.json``.

pdfplumber applies ``/Rotate`` to character coordinates but reports them
relative to the media box, so the crop box offset is applied here explicitly.
PDF.js builds its viewport from the same visible box, which makes the
conversion in the browser a plain multiply by viewport width/height. CSS pixel
values are never stored.
"""

from __future__ import annotations

import logging
import re
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

EXTRACTION_VERSION = "1"
SCHEMA_VERSION = 1

# Ligatures and typographic characters that must not defeat a quote match.
_REPLACEMENTS: dict[str, str] = {
    "ﬀ": "ff",
    "ﬁ": "fi",
    "ﬂ": "fl",
    "ﬃ": "ffi",
    "ﬄ": "ffl",
    "ﬅ": "st",
    "ﬆ": "st",
    "‘": "'",
    "’": "'",
    "‚": "'",
    "‛": "'",
    "“": '"',
    "”": '"',
    "„": '"',
    "′": "'",
    "″": '"',
    "‐": "-",
    "‑": "-",
    "‒": "-",
    "–": "-",
    "—": "-",
    "―": "-",
    "−": "-",
    " ": " ",
    " ": " ",
    " ": " ",
    " ": " ",
    " ": " ",
    "﻿": "",
    "­": "",  # soft hyphen
    "​": "",
}

_WHITESPACE = re.compile(r"\s")


@dataclass
class Line:
    text: str
    # One rectangle per character in ``text`` (normalized, top-left origin).
    boxes: list[list[float]]

    def to_json(self) -> dict[str, Any]:
        return {
            "text": self.text,
            "boxes": [[round(v, 5) for v in box] for box in self.boxes],
        }

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> Line:
        return cls(text=data["text"], boxes=[list(map(float, b)) for b in data["boxes"]])


@dataclass
class PageExtraction:
    page_number: int  # one-based physical PDF page position
    width: float  # visible box width, in PDF points
    height: float
    rotation: int
    lines: list[Line] = field(default_factory=list)
    page_label: str | None = None
    warnings: list[str] = field(default_factory=list)
    # False when the page's glyphs run sideways relative to the displayed page;
    # rectangle merging needs to know which axis a line advances along.
    upright: bool = True

    @property
    def text(self) -> str:
        return "\n".join(line.text for line in self.lines)

    @property
    def char_count(self) -> int:
        return sum(len(line.text) for line in self.lines)

    def boxes(self) -> list[list[float] | None]:
        """Rectangles aligned 1:1 with ``text``; ``None`` for the newlines."""
        out: list[list[float] | None] = []
        for index, line in enumerate(self.lines):
            if index:
                out.append(None)
            out.extend(line.boxes)
        return out

    def to_json(self) -> dict[str, Any]:
        return {
            "page_number": self.page_number,
            "page_label": self.page_label,
            "width": round(self.width, 3),
            "height": round(self.height, 3),
            "rotation": self.rotation,
            "upright": self.upright,
            "warnings": self.warnings,
            "lines": [line.to_json() for line in self.lines],
        }

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> PageExtraction:
        return cls(
            page_number=int(data["page_number"]),
            page_label=data.get("page_label"),
            width=float(data["width"]),
            height=float(data["height"]),
            rotation=int(data.get("rotation", 0)),
            upright=bool(data.get("upright", True)),
            warnings=list(data.get("warnings", [])),
            lines=[Line.from_json(line) for line in data.get("lines", [])],
        )


@dataclass
class DocumentExtraction:
    pages: list[PageExtraction]
    warnings: list[str] = field(default_factory=list)
    extraction_version: str = EXTRACTION_VERSION

    @property
    def page_count(self) -> int:
        return len(self.pages)

    @property
    def quality(self) -> str:
        """``ok``, ``partial``, or ``none`` — surfaced next to any summary."""
        if not self.pages:
            return "none"
        empty = sum(1 for page in self.pages if page.char_count == 0)
        if empty == len(self.pages):
            return "none"
        return "partial" if empty else "ok"

    def empty_pages(self) -> list[int]:
        return [page.page_number for page in self.pages if page.char_count == 0]

    def to_json(self) -> dict[str, Any]:
        return {
            "schema_version": SCHEMA_VERSION,
            "extraction_version": self.extraction_version,
            "quality": self.quality,
            "warnings": self.warnings,
            "empty_pages": self.empty_pages(),
            "pages": [page.to_json() for page in self.pages],
        }

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> DocumentExtraction:
        return cls(
            pages=[PageExtraction.from_json(p) for p in data.get("pages", [])],
            warnings=list(data.get("warnings", [])),
            extraction_version=str(data.get("extraction_version", "0")),
        )


class ExtractionError(Exception):
    """Extraction could not run at all (encrypted, malformed, unreadable)."""

    def __init__(self, message: str, *, kind: str = "unreadable") -> None:
        super().__init__(message)
        self.kind = kind


# ------------------------------------------------------------------ geometry


def _raw_box(page: Any, name: str) -> tuple[float, float, float, float] | None:
    """A page box in raw PDF user space (bottom-left origin, unrotated)."""
    source = getattr(page, "page_obj", None)
    values = getattr(source, name, None) if source is not None else None
    if values is None:
        return None
    try:
        x0, y0, x1, y1 = (float(v) for v in values)
    except (TypeError, ValueError):
        return None
    return (min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))


def _rotate_box(
    box: tuple[float, float, float, float], rotation: int, width: float, height: float
) -> tuple[float, float, float, float]:
    """Apply a page's display rotation in top-left coordinate space.

    These transforms were derived from pdfplumber's own rotated character
    coordinates. Its ``page.cropbox`` does **not** follow the same convention at
    180° and 270°, which is why the crop box is rotated here rather than read
    back from pdfplumber.
    """
    x0, y0, x1, y1 = box
    if rotation == 90:
        rotated = (height - y1, x0, height - y0, x1)
    elif rotation == 180:
        rotated = (width - x1, height - y1, width - x0, height - y0)
    elif rotation == 270:
        rotated = (y0, width - x1, y1, width - x0)
    else:
        rotated = box
    return (
        min(rotated[0], rotated[2]),
        min(rotated[1], rotated[3]),
        max(rotated[0], rotated[2]),
        max(rotated[1], rotated[3]),
    )


def _visible_box(page: Any) -> tuple[float, float, float, float]:
    """The displayed box — crop ∩ media, rotated — in the chars' own space.

    PDF.js builds its viewport from the same visible box, which is what makes
    the browser-side conversion a plain multiply by viewport width and height.
    """
    fallback = tuple(float(v) for v in page.bbox)
    media = _raw_box(page, "mediabox")
    if media is None:
        return fallback  # type: ignore[return-value]
    crop = _raw_box(page, "cropbox") or media

    # Intersect in user space, then convert to an unrotated top-left box whose
    # origin is the media box corner — the origin pdfplumber uses for chars.
    x0 = max(media[0], crop[0])
    y0 = max(media[1], crop[1])
    x1 = min(media[2], crop[2])
    y1 = min(media[3], crop[3])
    if x1 - x0 <= 1 or y1 - y0 <= 1:
        x0, y0, x1, y1 = media

    width = media[2] - media[0]
    height = media[3] - media[1]
    unrotated = (x0 - media[0], media[3] - y1, x1 - media[0], media[3] - y0)
    return _rotate_box(unrotated, int(getattr(page, "rotation", 0) or 0) % 360, width, height)


def _normalize_box(
    char: dict[str, Any], box: tuple[float, float, float, float]
) -> list[float]:
    width = box[2] - box[0]
    height = box[3] - box[1]
    x0 = (float(char["x0"]) - box[0]) / width
    x1 = (float(char["x1"]) - box[0]) / width
    y0 = (float(char["top"]) - box[1]) / height
    y1 = (float(char["bottom"]) - box[1]) / height
    return [
        _clamp(min(x0, x1)),
        _clamp(min(y0, y1)),
        _clamp(max(x0, x1)),
        _clamp(max(y0, y1)),
    ]


def _clamp(value: float) -> float:
    return 0.0 if value < 0.0 else 1.0 if value > 1.0 else value


# --------------------------------------------------------------- line layout


_STREAM = "_stream_index"


def _cluster_lines(chars: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """Group characters into visual lines, in the document's own writing order.

    Which line a glyph belongs to is a geometric question, answered by
    proximity on the cross-line axis. The *order* of glyphs within a line, and
    of the lines themselves, comes from PDF content-stream order instead:
    geometry cannot distinguish "MARKER" from "REKRAM" on a page that displays
    upside down, and stream order is the document's actual writing order.

    Upright text is clustered on ``top``; a page whose glyphs are not upright
    (a rotated page whose content was not rotated with it) runs sideways on
    screen and is clustered on ``x0`` instead.
    """
    if not chars:
        return []
    upright = _page_is_upright(chars)

    if upright:
        key = "top"
        sizes = [float(c.get("size") or 0) for c in chars]
    else:
        key = "x0"
        sizes = [float(c.get("width") or c.get("size") or 0) for c in chars]
    median_size = sorted(sizes)[len(sizes) // 2] if sizes else 10.0
    tolerance = max(1.0, median_size * 0.5)

    indexed = [dict(char, **{_STREAM: index}) for index, char in enumerate(chars)]
    groups: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    anchor = 0.0
    for char in sorted(indexed, key=lambda c: float(c[key])):
        if current and abs(float(char[key]) - anchor) > tolerance:
            groups.append(current)
            current = []
        if not current:
            anchor = float(char[key])
        current.append(char)
    if current:
        groups.append(current)

    for group in groups:
        group.sort(key=lambda c: c[_STREAM])
    groups.sort(key=lambda group: _median_stream(group))
    return groups


def _page_is_upright(chars: list[dict[str, Any]]) -> bool:
    return sum(1 for c in chars if c.get("upright", True)) >= len(chars) / 2


def _median_stream(group: list[dict[str, Any]]) -> float:
    indices = sorted(int(c[_STREAM]) for c in group)
    return float(indices[len(indices) // 2])


def _build_line(
    chars: list[dict[str, Any]], box: tuple[float, float, float, float], *, upright: bool
) -> Line | None:
    """Assemble one line's text and per-character rectangles.

    Word breaks arrive two ways: as an explicit space glyph, or as a horizontal
    gap with no glyph at all. Both must produce exactly one space in the text,
    and that space needs a rectangle of its own so every text index maps to
    geometry.
    """
    text_parts: list[str] = []
    boxes: list[list[float]] = []
    previous: dict[str, Any] | None = None
    pending_space: dict[str, Any] | None = None

    for char in chars:
        raw = char.get("text") or ""
        if not raw or _WHITESPACE.fullmatch(raw):
            if pending_space is None:
                pending_space = char
            previous = char
            continue

        if previous is not None and pending_space is None:
            gap, region = _separation(previous, char, upright=upright)
            # Roughly half a space advance: wide enough to ignore kerning inside
            # a word, narrow enough to catch a space that has no glyph.
            if gap > max(0.35, float(char.get("size") or 10.0) * 0.14) and region:
                if text_parts and text_parts[-1] != " ":
                    text_parts.append(" ")
                    boxes.append(
                        _gap_box(previous, char, region, box, upright=upright)
                    )

        if pending_space is not None:
            if text_parts and text_parts[-1] != " ":
                text_parts.append(" ")
                boxes.append(_normalize_box(pending_space, box))
            pending_space = None

        normalized = _normalize_box(char, box)
        for offset, character in enumerate(raw):
            text_parts.append(character)
            boxes.append(_split_box(normalized, offset, len(raw)))
        previous = char

    # Trim leading and trailing spaces, keeping text and boxes aligned.
    start, end = 0, len(text_parts)
    while start < end and text_parts[start] == " ":
        start += 1
    while end > start and text_parts[end - 1] == " ":
        end -= 1
    if start >= end:
        return None
    return Line(text="".join(text_parts[start:end]), boxes=boxes[start:end])


def _split_box(box: list[float], offset: int, total: int) -> list[float]:
    """Share one glyph's rectangle across the characters it decomposes into."""
    if total <= 1:
        return list(box)
    width = (box[2] - box[0]) / total
    return [box[0] + width * offset, box[1], box[0] + width * (offset + 1), box[3]]


def _separation(
    previous: dict[str, Any], char: dict[str, Any], *, upright: bool
) -> tuple[float, tuple[float, float] | None]:
    """The empty distance between two glyphs, whichever way the text advances.

    Reading direction can be right-to-left or bottom-to-top on a rotated or
    upside-down page, so the gap is measured without assuming a sign.
    """
    lo, hi = ("x0", "x1") if upright else ("top", "bottom")
    a_lo, a_hi = float(previous[lo]), float(previous[hi])
    b_lo, b_hi = float(char[lo]), float(char[hi])
    if b_lo >= a_hi:
        return b_lo - a_hi, (a_hi, b_lo)
    if a_lo >= b_hi:
        return a_lo - b_hi, (b_hi, a_lo)
    return 0.0, None


def _gap_box(
    previous: dict[str, Any],
    char: dict[str, Any],
    region: tuple[float, float],
    box: tuple[float, float, float, float],
    *,
    upright: bool,
) -> list[float]:
    """A rectangle covering an inter-word space, so it too has geometry."""
    synthetic = dict(char)
    if upright:
        synthetic["x0"], synthetic["x1"] = region
        synthetic["top"] = min(float(previous["top"]), float(char["top"]))
        synthetic["bottom"] = max(float(previous["bottom"]), float(char["bottom"]))
    else:
        synthetic["top"], synthetic["bottom"] = region
        synthetic["x0"] = min(float(previous["x0"]), float(char["x0"]))
        synthetic["x1"] = max(float(previous["x1"]), float(char["x1"]))
    return _normalize_box(synthetic, box)


# ---------------------------------------------------------------- extraction


def extract_pdf(path: Path) -> DocumentExtraction:
    """Extract page text and character geometry. CPU-heavy; run off the loop."""
    import pdfplumber
    from pdfminer.pdfdocument import PDFPasswordIncorrect

    warnings: list[str] = []
    labels = _page_labels(path)

    try:
        pdf_context = pdfplumber.open(str(path))
    except PDFPasswordIncorrect as exc:
        raise ExtractionError(
            "This PDF is encrypted and cannot be opened without its password. "
            "The original file is stored and can still be downloaded.",
            kind="encrypted",
        ) from exc
    except Exception as exc:  # noqa: BLE001 - surfaced verbatim to the user
        raise ExtractionError(
            f"This PDF could not be parsed: {type(exc).__name__}: {exc}",
            kind="malformed",
        ) from exc

    pages: list[PageExtraction] = []
    with pdf_context as pdf:
        for index, page in enumerate(pdf.pages, start=1):
            pages.append(_extract_page(page, index, labels))
        if not pages:
            warnings.append("The PDF reports no pages.")

    empty = [p.page_number for p in pages if p.char_count == 0]
    if empty and len(empty) == len(pages):
        warnings.append(
            "No text could be extracted from any page. This PDF is probably a scan; "
            "it can be read but not searched, summarized, or cited by quotation."
        )
    elif empty:
        warnings.append(
            f"No text could be extracted from {len(empty)} of {len(pages)} pages "
            f"(pages {', '.join(str(p) for p in empty[:10])}"
            f"{'…' if len(empty) > 10 else ''})."
        )
    return DocumentExtraction(pages=pages, warnings=warnings)


def _extract_page(page: Any, number: int, labels: dict[int, str]) -> PageExtraction:
    box = _visible_box(page)
    extraction = PageExtraction(
        page_number=number,
        width=box[2] - box[0],
        height=box[3] - box[1],
        rotation=int(getattr(page, "rotation", 0) or 0),
        page_label=labels.get(number),
    )
    try:
        chars = list(page.chars)
    except Exception as exc:  # noqa: BLE001 - one bad page must not stop the rest
        extraction.warnings.append(f"Page text could not be read: {type(exc).__name__}: {exc}")
        return extraction

    if not chars:
        has_image = bool(getattr(page, "images", None))
        extraction.warnings.append(
            "No extractable text on this page; it appears to be an image."
            if has_image
            else "No extractable text on this page; it appears to be blank."
        )
        return extraction

    upright = _page_is_upright(chars)
    extraction.upright = upright
    if not upright:
        extraction.warnings.append(
            "This page's glyphs are not upright — its text runs sideways relative "
            "to the displayed page."
        )
    for group in _cluster_lines(chars):
        line = _build_line(group, box, upright=upright)
        if line is not None:
            extraction.lines.append(line)
    try:
        page.flush_cache()
    except Exception:  # noqa: BLE001 - cache clearing is best-effort
        pass
    return extraction


def _page_labels(path: Path) -> dict[int, str]:
    """Printed page labels ("iv", "S3"), which differ from physical positions."""
    try:
        from pypdf import PdfReader

        reader = PdfReader(str(path))
        labels = list(reader.page_labels)
    except Exception:  # noqa: BLE001 - labels are optional metadata
        return {}
    return {
        index: label
        for index, label in enumerate(labels, start=1)
        if label and label != str(index)
    }


_PLACEHOLDER_TITLES = {
    "untitled",
    "unknown",
    "document",
    "no title",
    "title",
    "pdf document",
}


_PLACEHOLDER_AUTHORS = {
    "anonymous",
    "unknown",
    "author",
    "authors",
    "unspecified",
    "none",
    "user",
    "owner",
    "administrator",
}


# An organisation in the author field is whoever produced the file — a
# publisher, a working-paper series, the institution whose software it was.
_ORGANISATION_RE = re.compile(
    r"\b(center|centre|university|institute|department|bureau|office|bank|press|"
    r"publishing|publishers?|association|society|journal|studies|research|library|"
    r"inc|ltd|llc|elsevier|springer|wiley|jstor|nber)\b",
    re.IGNORECASE,
)


def clean_authors(raw: str | None) -> str | None:
    """Reject the placeholder authors PDF producers write by default.

    Same reasoning as ``clean_title``, and it matters most in the generated
    bibliography: an entry crediting "anonymous" is worse than one that plainly
    says the author is unknown.
    """
    authors = " ".join((raw or "").split())
    if not authors or authors.lower() in _PLACEHOLDER_AUTHORS:
        return None
    if _ORGANISATION_RE.search(authors):
        return None
    return authors


# What a word processor left behind as a title: where the file was on the
# author's disk (`K:\\MEMOS\\DISCUSS\\92-2\\CES92-2.FNL`, `/home/x/paper.dvi`), or
# the bare name of the file it was made from (`CES92-2.FNL`).
_PATH_TITLE_RE = re.compile(r"\\|^[A-Za-z]:[\\/]|^/\S*/\S*$")
_FILE_TITLE_RE = re.compile(r"^\S+\.[A-Za-z][A-Za-z0-9]{1,3}$")


def clean_title(raw: str | None) -> str | None:
    """Reject the placeholder titles that PDF producers write by default.

    ``/Title`` is frequently "untitled", a converter artefact, or the source
    filename. Treating those as the real title is worse than treating the
    title as unknown, because it hides the heading on the first page.
    """
    title = (raw or "").strip()
    # "Microsoft Word - paper_final.doc" and similar converter artefacts.
    title = re.sub(r"^(Microsoft Word|Microsoft PowerPoint)\s*-\s*", "", title)
    title = re.sub(r"\.(docx?|pdf|tex|pptx?|rtf)$", "", title, flags=re.IGNORECASE)
    title = title.strip()
    if not title or title.lower() in _PLACEHOLDER_TITLES:
        return None
    # A bare filename tells the reader nothing the filename field does not.
    if re.fullmatch(r"[\w.\-]+", title) and "_" in title:
        return None
    if _PATH_TITLE_RE.search(title) or _FILE_TITLE_RE.fullmatch(title):
        return None
    return title


def pdf_metadata(path: Path) -> dict[str, Any]:
    """Title/author/year and encryption status, treating gaps as unknown."""
    info: dict[str, Any] = {
        "title": None,
        "authors": None,
        "year": None,
        "page_count": None,
        "encrypted": False,
    }
    try:
        from pypdf import PdfReader

        reader = PdfReader(str(path))
        info["encrypted"] = bool(reader.is_encrypted)
        try:
            info["page_count"] = len(reader.pages)
        except Exception:  # noqa: BLE001 - encrypted files refuse page access
            info["page_count"] = None
        meta = reader.metadata or {}
        info["title"] = clean_title(str(meta.get("/Title") or ""))
        info["authors"] = clean_authors(str(meta.get("/Author") or ""))
        raw_date = str(meta.get("/CreationDate") or "")
        match = re.search(r"(19|20)\d{2}", raw_date)
        if match:
            info["year"] = int(match.group(0))
    except Exception as exc:  # noqa: BLE001 - metadata is best-effort
        log.debug("Metadata read failed for %s: %s", path, exc)
    return info


# ------------------------------------------------------------- normalization


@dataclass
class Normalized:
    """Normalized text plus an index map back to the original characters."""

    text: str
    # ``offsets[i]`` is the index in the source string that produced ``text[i]``.
    offsets: list[int]

    @property
    def lowered(self) -> str:
        return self.text.lower()


def normalize_text(source: str) -> Normalized:
    """Fold ligatures, typographic punctuation, line-break hyphenation, and
    whitespace runs, keeping an offset back to every source character.

    Matching a quotation has to survive the difference between how a PDF
    encodes text and how a person retypes or copies it; the offset map is what
    lets a match on the folded text recover exact character geometry.
    """
    out: list[str] = []
    offsets: list[int] = []
    index = 0
    length = len(source)
    pending_space = False

    while index < length:
        char = source[index]

        # Hyphenation at a line break: "moti-\nvation" reads as one word.
        if char in "-‐‑­" and _is_line_break_hyphen(source, index):
            index = _skip_line_break(source, index + 1)
            continue

        replacement = _REPLACEMENTS.get(char)
        if replacement is None:
            decomposed = unicodedata.normalize("NFKC", char)
            replacement = decomposed if decomposed.isprintable() or decomposed.isspace() else ""

        if replacement == "":
            index += 1
            continue

        if replacement.isspace() or _WHITESPACE.fullmatch(char):
            pending_space = bool(out)
            index += 1
            continue

        if pending_space:
            out.append(" ")
            offsets.append(index)
            pending_space = False
        for piece in replacement:
            out.append(piece)
            offsets.append(index)
        index += 1

    return Normalized(text="".join(out), offsets=offsets)


def _is_line_break_hyphen(source: str, index: int) -> bool:
    if index + 1 >= len(source):
        return False
    if index == 0 or not source[index - 1].isalpha():
        return False
    cursor = index + 1
    saw_break = False
    while cursor < len(source) and source[cursor].isspace():
        if source[cursor] == "\n":
            saw_break = True
        cursor += 1
    return saw_break and cursor < len(source) and source[cursor].isalpha()


def _skip_line_break(source: str, index: int) -> int:
    while index < len(source) and source[index].isspace():
        index += 1
    return index


def normalize_query(text: str) -> str:
    """Normalize a quotation supplied by a person or an agent."""
    return normalize_text(text).text.strip()
