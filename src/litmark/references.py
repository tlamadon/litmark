"""The project reference registry and the quotation-to-geometry resolver.

A reference records *where* a passage is, never whether it supports a claim.
When a quotation cannot be located uniquely the resolver says so — it never
highlights an arbitrary region.
"""

from __future__ import annotations

import json
import re
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .errors import InvalidInput, NotFound
from .extraction import DocumentExtraction, PageExtraction, normalize_text
from .workspace import Workspace, atomic_write_text, utcnow

SCHEMA_VERSION = 1
COORDINATE_SPACE = "displayed-cropbox-normalized-top-left"

RESOLVED = "resolved"
AMBIGUOUS = "ambiguous"
NOT_FOUND = "not_found"
PAGE_ONLY = "page_only"
MISSING_SOURCE = "missing_source"

_REF_ID_RE = re.compile(r"^ref-[0-9a-z][0-9a-z-]{0,30}$")
_SOURCE_LINK_RE = re.compile(r"\]\(source:([A-Za-z0-9][A-Za-z0-9\-]*)\)")
_PAPER_LINK_RE = re.compile(r"\]\(paper:([A-Za-z0-9][A-Za-z0-9\-]*)\)")
_NOTE_LINK_RE = re.compile(r"\]\(note:([A-Za-z0-9][A-Za-z0-9_\-]*)\)")


@dataclass
class Reference:
    reference_id: str
    document_id: str
    document_sha256: str
    page_number: int
    status: str
    page_label: str | None = None
    quote: str | None = None
    prefix: str | None = None
    suffix: str | None = None
    rects: list[list[float]] = field(default_factory=list)
    coordinate_space: str = COORDINATE_SPACE
    note: str | None = None
    created_at: str = ""

    def to_json(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "document_id": self.document_id,
            "document_sha256": self.document_sha256,
            "page_number": self.page_number,
            "status": self.status,
            "coordinate_space": self.coordinate_space,
            "created_at": self.created_at,
        }
        for key in ("page_label", "quote", "prefix", "suffix", "note"):
            value = getattr(self, key)
            if value:
                payload[key] = value
        if self.rects:
            payload["rects"] = [[round(v, 5) for v in rect] for rect in self.rects]
        return payload

    @classmethod
    def from_json(cls, reference_id: str, data: dict[str, Any]) -> Reference:
        return cls(
            reference_id=reference_id,
            document_id=data["document_id"],
            document_sha256=data.get("document_sha256", ""),
            page_number=int(data["page_number"]),
            status=data.get("status", RESOLVED),
            page_label=data.get("page_label"),
            quote=data.get("quote"),
            prefix=data.get("prefix"),
            suffix=data.get("suffix"),
            rects=[list(map(float, r)) for r in data.get("rects", [])],
            coordinate_space=data.get("coordinate_space", COORDINATE_SPACE),
            note=data.get("note"),
            created_at=data.get("created_at", ""),
        )

    def api_json(self) -> dict[str, Any]:
        return {"reference_id": self.reference_id, **self.to_json()}


@dataclass
class Match:
    """The outcome of locating a quotation on a page."""

    status: str
    rects: list[list[float]] = field(default_factory=list)
    quote: str | None = None
    message: str | None = None
    candidates: list[dict[str, Any]] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.status == RESOLVED


class ReferenceStore:
    """``references.json``, read and written atomically under a lock."""

    def __init__(self, workspace: Workspace) -> None:
        self._workspace = workspace
        self._lock = threading.RLock()

    @property
    def path(self) -> Path:
        return self._workspace.references_file

    def _load_raw(self) -> dict[str, Any]:
        if not self.path.is_file():
            return {"schema_version": SCHEMA_VERSION, "references": {}}
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise InvalidInput(
                f"{self.path.name} is not valid JSON ({exc}); "
                "fix or remove the file to continue."
            ) from exc
        data.setdefault("schema_version", SCHEMA_VERSION)
        data.setdefault("references", {})
        return data

    def all(self) -> dict[str, Reference]:
        raw = self._load_raw()
        return {
            ref_id: Reference.from_json(ref_id, payload)
            for ref_id, payload in raw["references"].items()
        }

    def get(self, reference_id: str) -> Reference:
        raw = self._load_raw()
        payload = raw["references"].get(reference_id)
        if payload is None:
            raise NotFound(f"No reference {reference_id!r} in the registry.", reference_id=reference_id)
        return Reference.from_json(reference_id, payload)

    def exists(self, reference_id: str) -> bool:
        return reference_id in self._load_raw()["references"]

    def put(self, reference: Reference) -> Reference:
        if not _REF_ID_RE.match(reference.reference_id):
            raise InvalidInput(
                f"Invalid reference ID {reference.reference_id!r}; "
                "expected a value like 'ref-001'."
            )
        with self._lock:
            raw = self._load_raw()
            if not reference.created_at:
                reference.created_at = utcnow()
            raw["references"][reference.reference_id] = reference.to_json()
            self._write(raw)
        return reference

    def allocate_id(self) -> str:
        """Reference IDs are allocated centrally; agents never invent them."""
        with self._lock:
            raw = self._load_raw()
            used = raw["references"].keys()
            index = 1
            while f"ref-{index:03d}" in used:
                index += 1
            return f"ref-{index:03d}"

    def remove(self, reference_id: str) -> None:
        with self._lock:
            raw = self._load_raw()
            if reference_id in raw["references"]:
                del raw["references"][reference_id]
                self._write(raw)

    def mark_missing(self, document_id: str) -> list[str]:
        """Flag references whose document was deleted, keeping them recoverable."""
        with self._lock:
            raw = self._load_raw()
            touched = []
            for ref_id, payload in raw["references"].items():
                if payload.get("document_id") == document_id:
                    payload["status"] = MISSING_SOURCE
                    touched.append(ref_id)
            if touched:
                self._write(raw)
            return touched

    def _write(self, raw: dict[str, Any]) -> None:
        raw["schema_version"] = SCHEMA_VERSION
        atomic_write_text(self.path, json.dumps(raw, indent=2, ensure_ascii=False) + "\n")


# ------------------------------------------------------------------ matching


def locate_quote(
    page: PageExtraction,
    quote: str,
    *,
    prefix: str | None = None,
    suffix: str | None = None,
) -> Match:
    """Find ``quote`` on ``page`` and convert it to normalized rectangles."""
    cleaned = (quote or "").strip()
    if not cleaned:
        return Match(status=NOT_FOUND, message="An empty quotation cannot be located.")

    page_text = page.text
    if not page_text.strip():
        return Match(
            status=NOT_FOUND,
            message=(
                f"No text was extracted from page {page.page_number}, so a quotation "
                "cannot be located on it. A page-only citation is still possible."
            ),
        )

    normalized_page = normalize_text(page_text)
    needle = normalize_text(cleaned).text.strip()
    if not needle:
        return Match(status=NOT_FOUND, message="The quotation contains no matchable text.")

    haystack = normalized_page.lowered
    positions = _find_all(haystack, needle.lower())

    if not positions:
        return Match(
            status=NOT_FOUND,
            message=(
                f"That passage does not appear on page {page.page_number}. "
                "Check the page number, or cite the page without a quotation."
            ),
        )

    if len(positions) > 1:
        narrowed = _disambiguate(haystack, positions, len(needle), prefix, suffix)
        if len(narrowed) != 1:
            return Match(
                status=AMBIGUOUS,
                message=(
                    f"That passage appears {len(positions)} times on page "
                    f"{page.page_number}. Supply surrounding text to identify which one."
                ),
                candidates=[
                    _candidate(normalized_page, page_text, start, len(needle))
                    for start in positions[:5]
                ],
            )
        positions = narrowed

    start = positions[0]
    end = start + len(needle)
    raw_start = normalized_page.offsets[start]
    raw_end = normalized_page.offsets[end - 1] + 1
    rects = rects_for_range(page, raw_start, raw_end)
    if not rects:
        return Match(
            status=NOT_FOUND,
            message="The passage was found in the page text but has no usable geometry.",
        )
    return Match(status=RESOLVED, rects=rects, quote=page_text[raw_start:raw_end])


def _find_all(haystack: str, needle: str) -> list[int]:
    positions: list[int] = []
    start = haystack.find(needle)
    while start != -1:
        positions.append(start)
        start = haystack.find(needle, start + 1)
    return positions


def _disambiguate(
    haystack: str,
    positions: list[int],
    length: int,
    prefix: str | None,
    suffix: str | None,
) -> list[int]:
    """Repeated passages need context; without it the result stays ambiguous."""
    prefix_norm = normalize_text(prefix or "").text.strip().lower()
    suffix_norm = normalize_text(suffix or "").text.strip().lower()
    if not prefix_norm and not suffix_norm:
        return positions

    scored: list[tuple[int, int]] = []
    for start in positions:
        score = 0
        if prefix_norm:
            window = haystack[max(0, start - len(prefix_norm) - 8) : start]
            if window.endswith(prefix_norm) or prefix_norm in window:
                score += 1
        if suffix_norm:
            window = haystack[start + length : start + length + len(suffix_norm) + 8]
            if window.startswith(suffix_norm) or suffix_norm in window:
                score += 1
        scored.append((score, start))
    best = max(score for score, _ in scored)
    if best == 0:
        return positions
    return [start for score, start in scored if score == best]


def _candidate(
    normalized: Any, page_text: str, start: int, length: int
) -> dict[str, Any]:
    raw_start = normalized.offsets[start]
    raw_end = normalized.offsets[start + length - 1] + 1
    return {
        "context": page_text[max(0, raw_start - 60) : min(len(page_text), raw_end + 60)].replace(
            "\n", " "
        ),
        "offset": raw_start,
    }


def rects_for_range(page: PageExtraction, start: int, end: int) -> list[list[float]]:
    """Merge per-character rectangles into one rectangle per visual line.

    A multiline quotation therefore produces one rectangle per line, which is
    what the viewer draws as the highlight.
    """
    boxes = page.boxes()
    selected = [box for box in boxes[start:end] if box is not None]
    if not selected:
        return []

    merged: list[list[float]] = []
    current = list(selected[0])
    for box in selected[1:]:
        if _same_line(current, box, upright=page.upright):
            current = [
                min(current[0], box[0]),
                min(current[1], box[1]),
                max(current[2], box[2]),
                max(current[3], box[3]),
            ]
        else:
            merged.append(current)
            current = list(box)
    merged.append(current)
    return [rect for rect in merged if rect[2] > rect[0] and rect[3] > rect[1]]


def _same_line(a: list[float], b: list[float], *, upright: bool) -> bool:
    """Whether two rectangles sit on the same line of text.

    Glyphs on one line of horizontal text share a vertical span; on a sideways
    page the line advances down the screen instead, so the shared span is
    horizontal. Using the wrong axis either splits every word into one
    rectangle per glyph or merges separate lines into one block.
    """
    low, high = (1, 3) if upright else (0, 2)
    overlap = min(a[high], b[high]) - max(a[low], b[low])
    extent = min(a[high] - a[low], b[high] - b[low])
    return extent > 0 and overlap > extent * 0.5


def find_page(extraction: DocumentExtraction, page_number: int) -> PageExtraction:
    for page in extraction.pages:
        if page.page_number == page_number:
            return page
    raise NotFound(
        f"This document has no page {page_number}; it has {extraction.page_count}.",
        page_number=page_number,
    )


_FENCE_RE = re.compile(r"^\s{0,3}(`{3,}|~{3,})", re.MULTILINE)
_INLINE_CODE_RE = re.compile(r"`[^`\n]*`")


def strip_code(text: str) -> str:
    """Blank out fenced and inline code, preserving offsets.

    A note that documents the citation syntax in a code block must not be
    treated as citing whatever reference the example names — that would colour
    a mark as "cited here" on the strength of a worked example, and the
    welcome note ships with exactly such an example.
    """
    out = list(text)
    fence: str | None = None
    position = 0
    for line in text.splitlines(keepends=True):
        start, end = position, position + len(line)
        position = end
        opening = _FENCE_RE.match(line)
        if fence is None:
            if opening:
                fence = opening.group(1)[0] * 3
                for index in range(start, end):
                    if out[index] != "\n":
                        out[index] = " "
            continue
        # Inside a fence: blank everything, and close on a matching fence.
        for index in range(start, end):
            if out[index] != "\n":
                out[index] = " "
        if opening and opening.group(1)[0] * 3 == fence:
            fence = None
    blanked = "".join(out)
    return _INLINE_CODE_RE.sub(lambda match: " " * len(match.group(0)), blanked)


def source_ids_in_markdown(text: str) -> set[str]:
    """Reference IDs cited by ``source:`` links in a Markdown document.

    Links inside code are ignored: they are documentation, not citations.
    """
    return set(_SOURCE_LINK_RE.findall(strip_code(text)))


def paper_ids_in_markdown(text: str) -> set[str]:
    """Document IDs named by ``paper:`` links: a mention of a paper in the library.

    Where a ``source:`` link cites a passage, this one points at the paper as
    a whole — `[Olley & Pakes (1996)](paper:doc-002)`.
    """
    return set(_PAPER_LINK_RE.findall(strip_code(text)))


def note_ids_in_markdown(text: str) -> set[str]:
    """Note IDs named by ``note:`` links: one note, or a summary, pointing at a note.

    `[the implementation, step by step](note:paired-movers)`.
    """
    return set(_NOTE_LINK_RE.findall(strip_code(text)))


def links_in_markdown(text: str) -> tuple[list[str], list[str]]:
    """Every ``source:`` and every ``paper:`` link, in order and with repeats.

    For counting how much a text leans on something, where the sets above
    only say whether it does.
    """
    plain = strip_code(text)
    return _SOURCE_LINK_RE.findall(plain), _PAPER_LINK_RE.findall(plain)


def citations_by_reference(
    workspace: Workspace, documents: Any
) -> dict[str, list[dict[str, str]]]:
    """Which notes and summaries cite each reference.

    The source panel shows every mark in a document at once, and colours them
    by where they are cited from — the note being edited, somewhere else, or
    nowhere yet. That distinction is only knowable by reading the Markdown, so
    it is computed here rather than stored: the files are the truth, and a
    stored index would go stale the moment someone edits a note by hand.
    """
    citations: dict[str, list[dict[str, str]]] = {}

    def record(reference_id: str, entry: dict[str, str]) -> None:
        citations.setdefault(reference_id, []).append(entry)

    for note in workspace.list_notes():
        for reference_id in source_ids_in_markdown(note.text):
            record(reference_id, {"kind": "note", "id": note.note_id, "title": note.title})

    for document in documents.list():
        text = documents.summary_text(document.document_id)
        if not text:
            continue
        for reference_id in source_ids_in_markdown(text):
            record(
                reference_id,
                {
                    "kind": "summary",
                    "id": document.document_id,
                    "title": f"Summary — {document.display_title}",
                },
            )
    return citations
