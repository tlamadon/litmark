"""Ink on a paper's pages: what was drawn with the pen and the highlighter.

One file per paper, ``documents/<id>/ink.json``, kept in git with the notes.
A stroke is a line through points in the same coordinates as a reference's
rectangles — fractions of the page as it is displayed, origin top-left — so
it sits where it was drawn at any zoom, and on any machine.

The stored PDF is never written to: it is addressed by its hash, and every
reference pins that hash. A copy with the ink on it is built when asked for,
as ``/Ink`` annotations, which other PDF applications show, and can move or
remove.
"""

from __future__ import annotations

import io
import json
import math
import re
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .documents import DocumentStore
from .errors import InvalidInput, RevisionConflict
from .references import COORDINATE_SPACE
from .workspace import Workspace, revision_of

SCHEMA_VERSION = 1
FILENAME = "ink.json"

PEN = "pen"
HIGHLIGHTER = "highlighter"
TOOLS = (PEN, HIGHLIGHTER)

# Far more than a hand puts on a paper; what they stop is a request that is
# not ink at all from being written into the project.
MAX_STROKES = 20_000
MAX_POINTS = 5_000
# A stroke's width, as a fraction of the page's width.
MAX_WIDTH = 0.1

# How a highlighter stroke lets the text under it show: here and in the viewer.
HIGHLIGHTER_OPACITY = 0.4
# How far from a point of a stroke the line starts to bend toward the next one,
# as a fraction of the page's width: `CORNER` in `frontend/src/pdf/ink.ts`.
CORNER = 0.003

_ID_RE = re.compile(r"^ink-[0-9a-z]{8,40}$")
_COLOR_RE = re.compile(r"^#[0-9a-f]{6}$")


@dataclass(frozen=True)
class Ink:
    """A paper's strokes, and the revision of the file they were read from."""

    document_id: str
    revision: str | None
    strokes: list[dict[str, Any]]

    def to_json(self) -> dict[str, Any]:
        return {
            "document_id": self.document_id,
            "revision": self.revision,
            "strokes": self.strokes,
        }


class InkStore:
    def __init__(self, workspace: Workspace, documents: DocumentStore) -> None:
        self._workspace = workspace
        self._documents = documents

    def path(self, document_id: str) -> Path:
        return self._documents.dir_for(document_id) / FILENAME

    def read(self, document_id: str) -> Ink:
        """The strokes on a paper; none, and no revision, where nothing was drawn."""
        document = self._documents.get(document_id)
        path = self._workspace.resolve_inside(self.path(document_id))
        if not path.is_file():
            return Ink(document_id, None, [])
        text = path.read_text(encoding="utf-8")
        try:
            payload = json.loads(text)
            raw = payload["strokes"]
        except (json.JSONDecodeError, KeyError, TypeError) as exc:
            # Said, rather than read as empty: the next save would then replace
            # a file that a merge or an editor damaged, and whatever is in it.
            raise InvalidInput(
                f"The ink on {document.display_title!r} could not be read: "
                f"{FILENAME} is not what Litmark wrote.",
                document_id=document_id,
            ) from exc
        return Ink(document_id, revision_of(text), validate_strokes(raw, document.page_count))

    def write(
        self,
        document_id: str,
        strokes: Sequence[Any],
        *,
        expected_revision: str | None,
    ) -> str:
        """Replace a paper's strokes, if they are still as the writer read them.

        Returns the new revision. No snapshot is kept in ``.research/history/``
        and no row in the record of edits: ink is saved every few strokes, and
        git holds its history.
        """
        document = self._documents.get(document_id)
        clean = validate_strokes(strokes, document.page_count)
        text = serialize(document.sha256, clean)
        try:
            revision, _previous = self._workspace.write_versioned(
                self.path(document_id),
                text,
                expected_revision=expected_revision,
                snapshot=False,
            )
        except RevisionConflict as conflict:
            # Without the two texts a note's conflict carries: the writer reads
            # the strokes again and replays its own, it does not compare files.
            raise RevisionConflict(
                "The ink on this paper changed since it was read.",
                expected_revision=expected_revision,
                actual_revision=conflict.details.get("actual_revision"),  # type: ignore[arg-type]
            ) from None
        return revision

    def annotated_pdf(self, document_id: str, pdf_path: Path) -> bytes:
        """A copy of the paper with its ink on it. The file at ``pdf_path`` is only read."""
        return annotated_pdf(pdf_path.read_bytes(), self.read(document_id).strokes)


# ------------------------------------------------------------ validation


def validate_strokes(raw: Any, page_count: int | None = None) -> list[dict[str, Any]]:
    """Strokes as they are stored: checked, clamped to the page, rounded."""
    if not isinstance(raw, list):
        raise InvalidInput("Ink is a list of strokes.")
    if len(raw) > MAX_STROKES:
        raise InvalidInput(f"More than {MAX_STROKES} strokes on one paper.")
    strokes: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, item in enumerate(raw):
        stroke = _validate_stroke(item, index, page_count)
        if stroke["id"] in seen:
            raise InvalidInput(f"Two strokes are called {stroke['id']!r}.")
        seen.add(stroke["id"])
        strokes.append(stroke)
    return strokes


def _validate_stroke(item: Any, index: int, page_count: int | None) -> dict[str, Any]:
    where = f"Stroke {index + 1}"
    if not isinstance(item, dict):
        raise InvalidInput(f"{where} is not a stroke.")
    stroke_id = item.get("id")
    if not isinstance(stroke_id, str) or not _ID_RE.match(stroke_id):
        raise InvalidInput(f"{where} has no usable id.")
    page = item.get("page")
    if not isinstance(page, int) or isinstance(page, bool) or page < 1:
        raise InvalidInput(f"{where} is on no page.")
    if page_count and page > page_count:
        raise InvalidInput(f"{where} is on page {page} of a paper of {page_count}.")
    tool = item.get("tool")
    if tool not in TOOLS:
        raise InvalidInput(f"{where} was drawn with neither a pen nor a highlighter.")
    color = item.get("color")
    if not isinstance(color, str) or not _COLOR_RE.match(color.lower()):
        raise InvalidInput(f"{where} has a colour that is not #rrggbb.")
    width = _number(item.get("width"))
    if width is None or not 0 < width <= MAX_WIDTH:
        raise InvalidInput(f"{where} has no usable width.")
    points = item.get("points")
    if not isinstance(points, list) or not points:
        raise InvalidInput(f"{where} has no points.")
    if len(points) > MAX_POINTS:
        raise InvalidInput(f"{where} has more than {MAX_POINTS} points.")
    clean: list[list[float]] = []
    for point in points:
        if not isinstance(point, (list, tuple)) or len(point) != 2:
            raise InvalidInput(f"{where} has a point that is not [x, y].")
        x, y = _number(point[0]), _number(point[1])
        if x is None or y is None:
            raise InvalidInput(f"{where} has a point that is not [x, y].")
        clean.append([_unit(x), _unit(y)])
    return {
        "id": stroke_id,
        "page": page,
        "tool": tool,
        "color": color.lower(),
        "width": round(width, 5),
        "points": clean,
    }


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def _unit(value: float) -> float:
    """Inside the page, to the ten-thousandth: a twelfth of a pixel on a wide screen."""
    return round(min(1.0, max(0.0, value)), 4)


def serialize(document_sha256: str, strokes: Sequence[dict[str, Any]]) -> str:
    """The file's text: one stroke to a line, so a diff shows the strokes that changed."""
    head = json.dumps(
        {
            "version": SCHEMA_VERSION,
            "coordinate_space": COORDINATE_SPACE,
            "document_sha256": document_sha256,
        },
        indent=2,
    )
    lines = ",\n".join(
        "    " + json.dumps(stroke, separators=(",", ":"), ensure_ascii=True) for stroke in strokes
    )
    body = f"[\n{lines}\n  ]" if strokes else "[]"
    return f'{head[:-2]},\n  "strokes": {body}\n}}\n'


# ---------------------------------------------------------------- export


def annotated_pdf(data: bytes, strokes: Sequence[dict[str, Any]]) -> bytes:
    """The PDF in ``data`` with one ``/Ink`` annotation for each stroke.

    Annotations rather than marks drawn into the page: another application
    shows them, and can still move or delete them. Each carries an appearance
    stream, without which several readers — Preview among them — show nothing.
    """
    from pypdf import PdfReader, PdfWriter
    from pypdf.errors import PyPdfError

    try:
        writer = PdfWriter(clone_from=PdfReader(io.BytesIO(data)))
        by_page: dict[int, list[dict[str, Any]]] = {}
        for stroke in strokes:
            by_page.setdefault(int(stroke["page"]), []).append(stroke)
        for number, on_page in sorted(by_page.items()):
            if number > len(writer.pages):
                continue  # Drawn on a page this file does not have: nowhere to put it.
            page = writer.pages[number - 1]
            placing = _Placing.of(page)
            # Highlighter first, so that pen lines lie over it as they do on screen.
            for stroke in sorted(on_page, key=lambda item: item["tool"] != HIGHLIGHTER):
                writer.add_annotation(number - 1, _ink_annotation(writer, stroke, placing))
        out = io.BytesIO()
        writer.write(out)
    except PyPdfError as exc:
        raise InvalidInput(f"A copy with the ink on it could not be made: {exc}") from exc
    return out.getvalue()


@dataclass(frozen=True)
class _Placing:
    """Where the displayed page lies in the PDF's own coordinates.

    The way back from a stored point: the inverse of ``_visible_box`` and
    ``_rotate_box`` in ``extraction.py``, which take text from user space
    (origin bottom-left, before the page's rotation) to fractions of the page
    as displayed (crop box ∩ media box, rotated, origin top-left).
    """

    x0: float
    y0: float
    x1: float
    y1: float
    rotation: int

    @classmethod
    def of(cls, page: Any) -> _Placing:
        media = _box(page.mediabox)
        crop = _box(page.cropbox)
        x0, y0 = max(media[0], crop[0]), max(media[1], crop[1])
        x1, y1 = min(media[2], crop[2]), min(media[3], crop[3])
        if x1 - x0 <= 1 or y1 - y0 <= 1:
            x0, y0, x1, y1 = media
        return cls(x0, y0, x1, y1, int(page.rotation or 0) % 360)

    @property
    def displayed_width(self) -> float:
        """The width the page is shown at, in points: what a stroke's width is a fraction of."""
        sideways = self.rotation in (90, 270)
        return (self.y1 - self.y0) if sideways else (self.x1 - self.x0)

    def to_user_space(self, u: float, v: float) -> tuple[float, float]:
        width, height = self.x1 - self.x0, self.y1 - self.y0
        if self.rotation == 90:
            return self.x0 + v * width, self.y0 + u * height
        if self.rotation == 180:
            return self.x1 - u * width, self.y0 + v * height
        if self.rotation == 270:
            return self.x1 - v * width, self.y1 - u * height
        return self.x0 + u * width, self.y1 - v * height


def _box(values: Any) -> tuple[float, float, float, float]:
    x0, y0, x1, y1 = (float(value) for value in values)
    return (min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))


def _ink_annotation(writer: Any, stroke: dict[str, Any], placing: _Placing) -> Any:
    from pypdf.generic import (
        ArrayObject,
        DecodedStreamObject,
        DictionaryObject,
        FloatObject,
        NameObject,
        NumberObject,
        TextStringObject,
    )

    def numbers(values: Sequence[float]) -> ArrayObject:
        return ArrayObject(FloatObject(round(value, 2)) for value in values)

    points = [placing.to_user_space(x, y) for x, y in stroke["points"]]
    width = max(0.1, float(stroke["width"]) * placing.displayed_width)
    reach = width / 2 + 1
    rect = [
        min(x for x, _ in points) - reach,
        min(y for _, y in points) - reach,
        max(x for x, _ in points) + reach,
        max(y for _, y in points) + reach,
    ]
    red, green, blue = (int(stroke["color"][i : i + 2], 16) / 255 for i in (1, 3, 5))
    marker = stroke["tool"] == HIGHLIGHTER

    # The appearance is drawn in the page's own coordinates: its box is the
    # annotation's rectangle, so nothing is scaled or moved on the way.
    content = [f"{red:.3f} {green:.3f} {blue:.3f} RG", f"{width:.2f} w", "1 J", "1 j"]
    if marker:
        content.insert(0, "/Marker gs")
    content.append(_path_operators(points, CORNER * placing.displayed_width))
    content.append("S")
    form = DecodedStreamObject()
    form.set_data(("q\n" + "\n".join(content) + "\nQ\n").encode("ascii"))
    form.update(
        {
            NameObject("/Type"): NameObject("/XObject"),
            NameObject("/Subtype"): NameObject("/Form"),
            NameObject("/BBox"): numbers(rect),
        }
    )
    if marker:
        state = DictionaryObject(
            {
                NameObject("/Type"): NameObject("/ExtGState"),
                NameObject("/CA"): FloatObject(HIGHLIGHTER_OPACITY),
                NameObject("/ca"): FloatObject(HIGHLIGHTER_OPACITY),
                # Darkens the paper and leaves the letters black, as ink on paper does.
                NameObject("/BM"): NameObject("/Multiply"),
            }
        )
        form[NameObject("/Resources")] = DictionaryObject(
            {NameObject("/ExtGState"): DictionaryObject({NameObject("/Marker"): state})}
        )

    annotation = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Annot"),
            NameObject("/Subtype"): NameObject("/Ink"),
            NameObject("/NM"): TextStringObject(stroke["id"]),
            NameObject("/Rect"): numbers(rect),
            NameObject("/InkList"): ArrayObject(
                [numbers([value for point in points for value in point])]
            ),
            NameObject("/C"): numbers([red, green, blue]),
            NameObject("/BS"): DictionaryObject(
                {
                    NameObject("/Type"): NameObject("/Border"),
                    NameObject("/W"): FloatObject(round(width, 2)),
                    NameObject("/S"): NameObject("/S"),
                }
            ),
            # Printed with the page.
            NameObject("/F"): NumberObject(4),
            # A stream has to be an object of its own in the file; pypdf has no
            # public way to make it one ahead of the annotation that names it.
            NameObject("/AP"): DictionaryObject({NameObject("/N"): writer._add_object(form)}),
        }
    )
    if marker:
        # For an application that draws the stroke itself instead of using
        # the appearance given.
        annotation[NameObject("/CA")] = FloatObject(HIGHLIGHTER_OPACITY)
        annotation[NameObject("/BM")] = NameObject("/Multiply")
    return annotation


def _path_operators(points: Sequence[tuple[float, float]], reach: float) -> str:
    """The stroke as the viewer draws it: straight between its points, each rounded off.

    The same construction as ``strokePath`` in ``frontend/src/pdf/ink.ts`` —
    the line bends past each point from ``reach`` before it to ``reach`` after,
    or from halfway where the points are closer than that — with each
    quadratic curve written as the cubic one PDF has.
    """

    def toward(a: tuple[float, float], b: tuple[float, float]) -> tuple[float, float]:
        length = math.hypot(b[0] - a[0], b[1] - a[1])
        part = 0.0 if length == 0 else min(0.5, reach / length)
        return (a[0] + (b[0] - a[0]) * part, a[1] + (b[1] - a[1]) * part)

    first, last = points[0], points[-1]
    parts = [f"{first[0]:.2f} {first[1]:.2f} m"]
    # With fewer than three points there is nothing to bend past. A single
    # point is a line of no length, which round caps make a dot.
    at = first
    for index in range(1, len(points) - 1):
        bend = points[index]
        enter = toward(bend, points[index - 1])
        leave = toward(bend, points[index + 1])
        if (round(enter[0], 2), round(enter[1], 2)) != (round(at[0], 2), round(at[1], 2)):
            parts.append(f"{enter[0]:.2f} {enter[1]:.2f} l")
        one = (enter[0] + (bend[0] - enter[0]) * 2 / 3, enter[1] + (bend[1] - enter[1]) * 2 / 3)
        two = (leave[0] + (bend[0] - leave[0]) * 2 / 3, leave[1] + (bend[1] - leave[1]) * 2 / 3)
        parts.append(
            f"{one[0]:.2f} {one[1]:.2f} {two[0]:.2f} {two[1]:.2f} {leave[0]:.2f} {leave[1]:.2f} c"
        )
        at = leave
    parts.append(f"{last[0]:.2f} {last[1]:.2f} l")
    return "\n".join(parts)
