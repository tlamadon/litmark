"""Ink on a paper: what is drawn is kept, and the paper itself is never touched.

Strokes are saved with the same version check as a note, so two windows on one
paper cannot quietly lose each other's. The copy with the ink on it is checked
where it matters — that a stroke lands on the page where it was drawn, on a
page that is rotated or cropped as on a plain one — both in the annotation's
own coordinates and in a rendering of the exported file.
"""

from __future__ import annotations

import hashlib
import io
import json
import threading

import pytest
from conftest import make_pdf, rotate_and_crop, upload, wait_for_extraction

from litmark.errors import InvalidInput
from litmark.extraction import extract_pdf
from litmark.gitsync import describe_changes
from litmark.ink import HIGHLIGHTER_OPACITY, annotated_pdf, validate_strokes
from litmark.references import COORDINATE_SPACE, locate_quote

# The geometry fixture of tests/test_geometry.py: one word, and an asymmetric crop.
CROP = (60.0, 150.0, 520.0, 690.0)
MARKER = "MARKER"
MARKER_AT = (100.0, 650.0)


def stroke(suffix: str = "1", **changes) -> dict:
    return {
        "id": f"ink-0000000{suffix}",
        "page": 1,
        "tool": "pen",
        "color": "#1f4fd8",
        "width": 0.0025,
        "points": [[0.1, 0.2], [0.3, 0.25], [0.5, 0.2]],
        **changes,
    }


def mark(suffix: str = "9", **changes) -> dict:
    """Text marked with the text highlighter: two lines of it, and what they say."""
    return {
        "id": f"ink-0000000{suffix}",
        "page": 1,
        "tool": "text",
        "color": "#ffd60a",
        "rects": [[0.1, 0.2, 0.9, 0.22], [0.1, 0.23, 0.4, 0.25]],
        "text": "what the two lines say",
        **changes,
    }


def import_paper(client, data: bytes) -> str:
    document_id = upload(client, "paper.pdf", data)["imported"][0]["document"]["document_id"]
    wait_for_extraction(client, document_id)
    return document_id


def save(client, document_id: str, strokes: list[dict], revision: str | None):
    return client.put(
        f"/api/documents/{document_id}/ink",
        json={"strokes": strokes, "expected_revision": revision},
    )


# ------------------------------------------------------------------ keeping


def test_ink_is_saved_and_read_back(services, client, paper_one):
    document_id = import_paper(client, paper_one)
    empty = client.get(f"/api/documents/{document_id}/ink").json()
    assert empty == {"document_id": document_id, "revision": None, "strokes": []}

    marker = stroke("2", tool="highlighter", color="#FFD60A", width=0.022, page=2)
    saved = save(client, document_id, [stroke(), marker], None)
    assert saved.status_code == 200, saved.text
    revision = saved.json()["revision"]

    read = client.get(f"/api/documents/{document_id}/ink").json()
    assert read["revision"] == revision
    assert [item["id"] for item in read["strokes"]] == ["ink-00000001", "ink-00000002"]
    assert read["strokes"][0] == stroke()
    assert read["strokes"][1]["color"] == "#ffd60a"

    # An ordinary file of the project, in the coordinates references use, and
    # pinned to the PDF it was drawn on. One stroke to a line.
    path = services.documents.dir_for(document_id) / "ink.json"
    stored = json.loads(path.read_text("utf-8"))
    assert stored["version"] == 1
    assert stored["coordinate_space"] == COORDINATE_SPACE
    assert stored["document_sha256"] == services.documents.get(document_id).sha256
    assert sum(line.lstrip().startswith('{"id"') for line in path.read_text().splitlines()) == 2


def test_marked_text_is_kept_with_the_strokes_and_says_what_it_marks(services, client, paper_one):
    document_id = import_paper(client, paper_one)
    # As a hand leaves it: a line given right to left, one past the edge of
    # the page, a colour in capitals.
    drawn = mark(color="#FFD60A", rects=[[0.9, 0.22, 0.1, 0.2], [0.1, 0.23, 1.4, 0.2512345]])
    saved = save(client, document_id, [stroke(), drawn], None)
    assert saved.status_code == 200, saved.text

    pen, kept = client.get(f"/api/documents/{document_id}/ink").json()["strokes"]
    assert pen == stroke()
    assert kept == mark(rects=[[0.1, 0.2, 0.9, 0.22], [0.1, 0.23, 1.0, 0.2512]])
    # A mark is its rectangles and its words: it has no width, and no points.
    assert set(kept) == {"id", "page", "tool", "color", "rects", "text"}
    # The words are in the file, where a diff of it shows them.
    path = services.documents.dir_for(document_id) / "ink.json"
    assert '"text":"what the two lines say"' in path.read_text("utf-8")


@pytest.mark.parametrize(
    "bad",
    [
        {"rects": []},
        {"rects": None},
        {"rects": [[0.1, 0.2, 0.3]]},
        {"rects": [[0.1, 0.2, 0.3, "a"]]},
        {"rects": "0.1,0.2,0.3,0.4"},
        # On the page it has no size: it marks nothing.
        {"rects": [[0.3, 0.2, 0.3, 0.4]]},
        {"rects": [[1.2, 0.2, 1.6, 0.4]]},
        {"text": 7},
        {"text": "x" * 10_001},
        {"color": "yellow"},
        {"page": 3},
    ],
)
def test_what_is_not_marked_text_is_refused(client, paper_one, bad):
    document_id = import_paper(client, paper_one)
    response = save(client, document_id, [mark(**bad)], None)
    assert response.status_code == 422, response.text
    assert client.get(f"/api/documents/{document_id}/ink").json()["strokes"] == []


def test_a_line_of_no_size_is_left_out_of_a_mark_that_has_others():
    (kept,) = validate_strokes([mark(rects=[[0.1, 0.2, 0.9, 0.22], [0.5, 0.3, 0.5, 0.3]])], 2)
    assert kept["rects"] == [[0.1, 0.2, 0.9, 0.22]]
    # What it says may be left unsaid; it is then nothing, not missing.
    unsaid = mark()
    del unsaid["text"]
    assert validate_strokes([unsaid], 2)[0]["text"] == ""


def test_saving_ink_floods_neither_the_history_nor_the_record_of_edits(services, client, paper_one):
    document_id = import_paper(client, paper_one)
    changes = len(client.get("/api/changes").json()["changes"])
    revision = None
    for count in range(1, 6):
        strokes = [stroke(str(index)) for index in range(count)]
        revision = save(client, document_id, strokes, revision).json()["revision"]
    assert list(services.workspace.iter_history(f"documents/{document_id}/ink.json")) == []
    assert len(client.get("/api/changes").json()["changes"]) == changes


def test_a_save_tells_other_windows_which_revision_the_ink_is_at(services, client, paper_one):
    document_id = import_paper(client, paper_one)
    before = services.db.latest_seq()
    revision = save(client, document_id, [stroke()], None).json()["revision"]
    events = [e for e in services.db.events_since(before) if e["type"] == "ink_updated"]
    assert [(e["document_id"], e["revision"]) for e in events] == [(document_id, revision)]
    # Nothing else about the paper changed, and nothing says it did.
    assert not [e for e in services.db.events_since(before) if e["type"] == "document_updated"]


def test_a_stale_save_is_refused_and_no_stroke_is_lost(client, paper_one):
    document_id = import_paper(client, paper_one)
    base = save(client, document_id, [stroke("1")], None).json()["revision"]

    # Two windows on the paper, each with a stroke of its own on what both read.
    desk = save(client, document_id, [stroke("1"), stroke("2")], base)
    assert desk.status_code == 200
    tablet = save(client, document_id, [stroke("1"), stroke("3")], base)
    assert tablet.status_code == 409
    error = tablet.json()["error"]
    assert error["code"] == "revision_conflict"
    assert error["actual_revision"] == desk.json()["revision"]
    # The file is not sent back: the window reads the strokes again instead.
    assert error.get("current_text") is None and error.get("proposed_text") is None

    # Which is what it does: its own stroke goes on what the other saved.
    theirs = client.get(f"/api/documents/{document_id}/ink").json()
    assert [item["id"] for item in theirs["strokes"]] == ["ink-00000001", "ink-00000002"]
    again = save(client, document_id, [*theirs["strokes"], stroke("3")], theirs["revision"])
    assert again.status_code == 200
    kept = client.get(f"/api/documents/{document_id}/ink").json()["strokes"]
    assert [item["id"] for item in kept] == ["ink-00000001", "ink-00000002", "ink-00000003"]


def test_of_many_saves_at_once_on_one_revision_exactly_one_is_taken(client, paper_one):
    document_id = import_paper(client, paper_one)
    base = save(client, document_id, [stroke("0")], None).json()["revision"]
    statuses: list[int] = []
    start = threading.Barrier(8)

    def one(index: int) -> None:
        start.wait()
        response = save(client, document_id, [stroke("0"), stroke(str(index + 1))], base)
        statuses.append(response.status_code)

    threads = [threading.Thread(target=one, args=(index,)) for index in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sorted(statuses) == [200] + [409] * 7
    assert len(client.get(f"/api/documents/{document_id}/ink").json()["strokes"]) == 2


def test_a_first_save_is_refused_when_another_window_drew_first(client, paper_one):
    document_id = import_paper(client, paper_one)
    assert save(client, document_id, [stroke("1")], None).status_code == 200
    assert save(client, document_id, [stroke("2")], None).status_code == 409


@pytest.mark.parametrize(
    "bad",
    [
        {"tool": "eraser"},
        {"tool": "crayon"},
        {"color": "blue"},
        {"color": "#12345"},
        {"page": 0},
        {"page": 3},  # the paper has two
        {"page": "1"},
        {"points": []},
        {"points": [[0.1]]},
        {"points": [[0.1, "a"]]},
        {"points": "0.1,0.2"},
        {"width": 0},
        {"width": 0.5},
        {"width": None},
        {"id": "stroke-1"},
        {"id": "ink-../../x"},
    ],
)
def test_what_is_not_a_stroke_is_refused(client, paper_one, bad):
    document_id = import_paper(client, paper_one)
    response = save(client, document_id, [stroke(**bad)], None)
    assert response.status_code == 422, response.text
    assert client.get(f"/api/documents/{document_id}/ink").json()["strokes"] == []


def test_strokes_are_checked_as_a_whole_and_kept_on_the_page():
    with pytest.raises(InvalidInput, match="Two strokes"):
        validate_strokes([stroke(), stroke()], 2)
    with pytest.raises(InvalidInput):
        validate_strokes({"strokes": []}, 2)
    with pytest.raises(InvalidInput):
        validate_strokes([stroke(points=[[float("nan"), 0.5]])], 2)
    # A line drawn past the edge of the page ends at the edge, to four places.
    (kept,) = validate_strokes([stroke(points=[[-0.2, 0.123456], [1.7, 1.0]])], 2)
    assert kept["points"] == [[0.0, 0.1235], [1.0, 1.0]]


def test_ink_that_cannot_be_read_is_said_not_taken_for_none(services, client, paper_one):
    document_id = import_paper(client, paper_one)
    path = services.documents.dir_for(document_id) / "ink.json"
    path.write_text("<<<<<<< ours\n{}\n", encoding="utf-8")
    response = client.get(f"/api/documents/{document_id}/ink")
    assert response.status_code == 422
    assert "could not be read" in response.json()["error"]["message"]


def test_there_is_no_ink_on_a_paper_that_is_not_there(client):
    assert client.get("/api/documents/doc-999/ink").status_code == 404
    assert save(client, "doc-999", [stroke()], None).status_code == 404
    assert client.get("/api/documents/doc-999/pdf/annotated").status_code == 404


# ------------------------------------------------------------- taking away


def test_the_stored_paper_is_the_same_bytes_after_drawing_and_exporting(
    services, client, paper_one
):
    document_id = import_paper(client, paper_one)
    path = services.documents.pdf_path(document_id)
    sha256 = services.documents.get(document_id).sha256
    assert hashlib.sha256(path.read_bytes()).hexdigest() == sha256

    marker = stroke("2", tool="highlighter", color="#ffd60a", width=0.022)
    assert save(client, document_id, [stroke(), marker], None).status_code == 200
    exported = client.get(f"/api/documents/{document_id}/pdf/annotated")
    assert exported.status_code == 200
    assert exported.headers["content-type"] == "application/pdf"
    assert exported.headers["content-disposition"].startswith("attachment; ")
    assert "(annotated).pdf" in exported.headers["content-disposition"]
    assert exported.headers["cache-control"] == "no-store"
    assert exported.content != paper_one

    assert path.read_bytes() == paper_one
    assert hashlib.sha256(path.read_bytes()).hexdigest() == sha256
    assert services.documents.get(document_id).sha256 == sha256
    assert client.get(f"/api/documents/{document_id}/pdf").content == paper_one


def _annotations(data: bytes, page: int = 0) -> list:
    from pypdf import PdfReader

    return [item.get_object() for item in PdfReader(io.BytesIO(data)).pages[page]["/Annots"]]


def test_each_stroke_is_an_annotation_another_reader_can_draw(paper_one):
    marker = stroke("2", tool="highlighter", color="#ffd60a", width=0.022)
    exported = annotated_pdf(paper_one, [stroke(), marker, stroke("3", page=2)])
    # Highlighter under pen, as on screen.
    first_page = _annotations(exported)
    assert [str(item["/NM"]) for item in first_page] == ["ink-00000002", "ink-00000001"]
    assert len(_annotations(exported, 1)) == 1

    for annotation in first_page:
        assert annotation["/Subtype"] == "/Ink"
        assert len(annotation["/InkList"][0]) == 6
        # An appearance of its own: Preview, among others, draws nothing without.
        form = annotation["/AP"]["/N"].get_object()
        assert form["/Subtype"] == "/Form"
        assert [float(v) for v in form["/BBox"]] == [float(v) for v in annotation["/Rect"]]
        assert b" c\n" in form.get_data() and form.get_data().rstrip().endswith(b"S\nQ")

    highlighter, pen = first_page
    state = highlighter["/AP"]["/N"].get_object()["/Resources"]["/ExtGState"]["/Marker"]
    assert state["/BM"] == "/Multiply"
    assert float(state["/CA"]) == pytest.approx(HIGHLIGHTER_OPACITY)
    assert "/Resources" not in pen["/AP"]["/N"].get_object()
    assert [round(float(v), 2) for v in pen["/C"]] == [0.12, 0.31, 0.85]
    # 0.0025 of a 612pt page.
    assert float(pen["/BS"]["/W"]) == pytest.approx(1.53, abs=0.01)


def test_marked_text_is_a_highlight_another_reader_knows_as_one(paper_one):
    exported = annotated_pdf(paper_one, [stroke(), mark()])
    # Under the pen's lines, as on screen.
    highlight, pen = _annotations(exported)
    assert pen["/Subtype"] == "/Ink"
    assert highlight["/Subtype"] == "/Highlight"
    assert str(highlight["/NM"]) == "ink-00000009"
    assert str(highlight["/Contents"]) == "what the two lines say"
    assert [round(float(v), 2) for v in highlight["/C"]] == [1.0, 0.84, 0.04]
    assert float(highlight["/CA"]) == pytest.approx(HIGHLIGHTER_OPACITY)

    # Eight numbers to a line: its corners, top-left, top-right, bottom-left,
    # bottom-right. The page is 612 by 792 points, and its top is at 792.
    quads = [float(v) for v in highlight["/QuadPoints"]]
    assert len(quads) == 16
    assert quads[:8] == pytest.approx(
        [61.2, 633.6, 550.8, 633.6, 61.2, 617.76, 550.8, 617.76], abs=0.01
    )
    rect = [float(v) for v in highlight["/Rect"]]
    assert rect == pytest.approx([61.2, 594.0, 550.8, 633.6], abs=0.01)

    # An appearance of its own, filled and let through as a highlighter's is.
    form = highlight["/AP"]["/N"].get_object()
    assert [float(v) for v in form["/BBox"]] == rect
    drawn = form.get_data()
    assert drawn.count(b" h\n") == 2 and drawn.rstrip().endswith(b"f\nQ")
    state = form["/Resources"]["/ExtGState"]["/Marker"]
    assert state["/BM"] == "/Multiply"
    assert float(state["/ca"]) == pytest.approx(HIGHLIGHTER_OPACITY)


def test_a_stroke_on_a_page_the_file_does_not_have_is_left_out(paper_one):
    exported = annotated_pdf(paper_one, [stroke(page=9)])
    from pypdf import PdfReader

    assert all("/Annots" not in page for page in PdfReader(io.BytesIO(exported)).pages)


def _marker_pdf(**placing) -> bytes:
    data = make_pdf([[(*MARKER_AT, MARKER)]])
    return rotate_and_crop(data, **placing) if placing else data


def _marker_rect(tmp_path, data: bytes) -> list[float]:
    """Where the word is on the page as displayed: what a reader would draw over."""
    path = tmp_path / "marker.pdf"
    path.write_bytes(data)
    match = locate_quote(extract_pdf(path).pages[0], MARKER)
    assert match.ok and len(match.rects) == 1, match.message
    return match.rects[0]


PLACINGS = [
    pytest.param({}, id="plain"),
    pytest.param({"crop": CROP}, id="cropped"),
    pytest.param({"rotate": 90}, id="rotated-90"),
    pytest.param({"rotate": 90, "crop": CROP}, id="rotated-90-cropped"),
    pytest.param({"rotate": 180, "crop": CROP}, id="rotated-180-cropped"),
    pytest.param({"rotate": 270, "crop": CROP}, id="rotated-270-cropped"),
]


@pytest.mark.parametrize("placing", PLACINGS)
def test_a_stroke_over_a_word_is_exported_over_that_word(tmp_path, placing):
    """Through a word on the displayed page, and back to where the word was set.

    Rotating or cropping a page changes where the word is displayed, not where
    it is in the PDF's own coordinates — (100, 650), as it was drawn. So on
    every fixture the annotation must come out around that same place.
    """
    from reportlab.pdfbase.pdfmetrics import stringWidth

    data = _marker_pdf(**placing)
    x0, y0, x1, y1 = _marker_rect(tmp_path, data)
    width = 0.002
    exported = annotated_pdf(data, [stroke(width=width, points=[[x0, y0], [x1, y1]])])
    (annotation,) = _annotations(exported)
    rect = [float(value) for value in annotation["/Rect"]]

    left, baseline = MARKER_AT
    right = left + stringWidth(MARKER, "Helvetica", 11)
    # The rectangle reaches half the line's width, and a point, past the stroke.
    assert rect[0] == pytest.approx(left, abs=4), rect
    assert rect[2] == pytest.approx(right, abs=4), rect
    assert baseline - 6 < rect[1] < baseline + 1, rect
    assert baseline + 7 < rect[3] < baseline + 14, rect

    # The stroke's two ends, in the order drawn, are two opposite corners of it.
    ink = [float(value) for value in annotation["/InkList"][0]]
    assert sorted([ink[0], ink[2]]) == pytest.approx([rect[0] + 2, rect[2] - 2], abs=1.5)
    assert sorted([ink[1], ink[3]]) == pytest.approx([rect[1] + 2, rect[3] - 2], abs=1.5)


@pytest.mark.parametrize("placing", PLACINGS)
def test_text_marked_on_a_word_is_exported_on_that_word(tmp_path, placing):
    """Rotated or cropped, the word is where it was set, and so is its mark."""
    pdfium = pytest.importorskip("pypdfium2")
    from reportlab.pdfbase.pdfmetrics import stringWidth

    data = _marker_pdf(**placing)
    word = _marker_rect(tmp_path, data)
    exported = annotated_pdf(data, [mark(color="#00c000", rects=[word], text=MARKER)])
    (annotation,) = _annotations(exported)
    rect = [float(value) for value in annotation["/Rect"]]

    left, baseline = MARKER_AT
    right = left + stringWidth(MARKER, "Helvetica", 11)
    assert rect[0] == pytest.approx(left, abs=2), rect
    assert rect[2] == pytest.approx(right, abs=2), rect
    assert baseline - 5 < rect[1] < baseline + 1, rect
    assert baseline + 6 < rect[3] < baseline + 13, rect

    # And the picture: green over the word as it is displayed, and nowhere else.
    page = pdfium.PdfDocument(exported)[0]
    image = page.render(scale=2, may_draw_forms=False).to_pil().convert("RGB")
    pixels = image.load()
    found = [
        (x, y)
        for y in range(image.height)
        for x in range(image.width)
        if pixels[x, y][1] > pixels[x, y][0] + 40 and pixels[x, y][1] > pixels[x, y][2] + 40
    ]
    assert found, "no mark was drawn at all"
    shown = [
        min(x for x, _ in found) / image.width,
        min(y for _, y in found) / image.height,
        (max(x for x, _ in found) + 1) / image.width,
        (max(y for _, y in found) + 1) / image.height,
    ]
    assert shown == pytest.approx(word, abs=0.012)


@pytest.mark.parametrize("placing", PLACINGS)
def test_the_exported_copy_shows_the_ink_where_it_was_drawn(tmp_path, placing):
    """Not the numbers in the file but the picture: render the copy, find the ink."""
    pdfium = pytest.importorskip("pypdfium2")

    data = _marker_pdf(**placing)
    x0, y0, x1, y1 = _marker_rect(tmp_path, data)
    # Underline the word in red, and box an arbitrary corner of the page in green.
    under = stroke("1", color="#ff0000", width=0.004, points=[[x0, y1], [x1, y1]])
    corner = stroke(
        "2",
        color="#00c000",
        width=0.004,
        points=[[0.7, 0.8], [0.9, 0.8], [0.9, 0.9], [0.7, 0.9], [0.7, 0.8]],
    )
    exported = annotated_pdf(data, [under, corner])

    page = pdfium.PdfDocument(exported)[0]
    image = page.render(scale=2, may_draw_forms=False).to_pil().convert("RGB")
    pixels = image.load()

    def extent(is_ink) -> list[float]:
        found = [
            (x, y)
            for y in range(image.height)
            for x in range(image.width)
            if is_ink(pixels[x, y])
        ]
        assert found, "no ink of that colour was drawn at all"
        return [
            min(x for x, _ in found) / image.width,
            min(y for _, y in found) / image.height,
            (max(x for x, _ in found) + 1) / image.width,
            (max(y for _, y in found) + 1) / image.height,
        ]

    red = extent(lambda p: p[0] > 200 and p[1] < 60 and p[2] < 60)
    assert red[0] == pytest.approx(x0, abs=0.012) and red[2] == pytest.approx(x1, abs=0.012)
    assert (red[1] + red[3]) / 2 == pytest.approx(y1, abs=0.006)
    green = extent(lambda p: p[1] > 150 and p[0] < 60 and p[2] < 60)
    assert green == pytest.approx([0.7, 0.8, 0.9, 0.9], abs=0.012)

    # And the page under it is the page: the word is still set where it was.
    original = pdfium.PdfDocument(data)[0].render(scale=2).to_pil().convert("RGB")
    assert original.size == image.size


# --------------------------------------------------------------------- git


def test_a_commit_says_annotations_were_made_and_on_which_paper():
    assert describe_changes([("added", "documents/doc-003/ink.json")]).splitlines()[0] == (
        "Add annotations on doc-003"
    )
    assert describe_changes([("edited", "documents/doc-003/ink.json")]).splitlines()[0] == (
        "Update annotations on doc-003"
    )
    message = describe_changes(
        [
            ("edited", "documents/doc-003/ink.json"),
            ("edited", "documents/doc-004/ink.json"),
            ("edited", "notes/findings.md"),
        ]
    )
    subject = message.splitlines()[0]
    assert "update annotations on 2 papers" in subject.lower()
    assert "update note findings" in subject.lower()
    assert "edited: documents/doc-003/ink.json" in message
