"""Document ingestion, stored extraction, summaries, and keyword search.

Extraction status and summary status are tracked separately: a summary that
never ran, or failed, must not make a perfectly readable PDF look unavailable.
"""

from __future__ import annotations

import json
import logging
import re
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .errors import InvalidInput, NotFound
from .extraction import (
    EXTRACTION_VERSION,
    DocumentExtraction,
    ExtractionError,
    PageExtraction,
    clean_authors,
    clean_title,
    extract_pdf,
    normalize_text,
    pdf_metadata,
)
from .workspace import Workspace, atomic_write_bytes, atomic_write_text, revision_of, sha256_bytes, utcnow

log = logging.getLogger(__name__)

SCHEMA_VERSION = 1
MAX_TITLE_CHARS = 400
PDF_MAGIC = b"%PDF-"

# Extraction status
PENDING = "pending"
RUNNING = "running"
OK = "ok"
FAILED = "failed"

# Tags
MAX_TAG_CHARS = 60
MAX_TAGS_PER_DOCUMENT = 40
UNTAGGED = "untagged"

# Summary status
NONE = "none"
QUEUED = "queued"
READY = "ready"
UNAVAILABLE = "unavailable"


@dataclass
class Document:
    document_id: str
    sha256: str
    original_filename: str
    byte_size: int
    imported_at: str
    title: str | None = None
    authors: str | None = None
    year: int | None = None
    page_count: int | None = None
    # Labels the user puts on a paper to gather it with others: a field, a
    # year's job market, a candidate. Kept in metadata.json, so they travel.
    tags: list[str] = field(default_factory=list)
    # Who said what the title, authors and year are: `user`, `agent`, or
    # `mcp:<client>`. None while they are only what the PDF file says of itself.
    details_by: str | None = None
    extraction: dict[str, Any] = field(default_factory=dict)
    summary: dict[str, Any] = field(default_factory=dict)

    @property
    def display_title(self) -> str:
        return self.title or Path(self.original_filename).stem or self.document_id

    @property
    def author_surnames(self) -> list[str]:
        return [surname for surname in map(surname_of, author_names(self.authors)) if surname]

    @property
    def label(self) -> str | None:
        """How the paper is spoken of: ``Olley & Pakes (1996)``.

        Unknown without authors — a year alone names nothing, and a title is
        already what ``display_title`` gives.
        """
        surnames = self.author_surnames
        if not surnames:
            return None
        if len(surnames) > 2:
            who = f"{surnames[0]} et al."
        else:
            who = " & ".join(surnames)
        return f"{who} ({self.year})" if self.year else who

    @property
    def readable(self) -> bool:
        """The PDF can always be read once stored, whatever extraction did."""
        return True

    @property
    def searchable(self) -> bool:
        return self.extraction.get("status") == OK and self.extraction.get("quality") != "none"

    def to_json(self) -> dict[str, Any]:
        return {
            "schema_version": SCHEMA_VERSION,
            "document_id": self.document_id,
            "sha256": self.sha256,
            "original_filename": self.original_filename,
            "byte_size": self.byte_size,
            "imported_at": self.imported_at,
            "title": self.title,
            "authors": self.authors,
            "year": self.year,
            "page_count": self.page_count,
            "tags": self.tags,
            "details_by": self.details_by,
            "extraction": self.extraction,
            "summary": self.summary,
        }

    def api_json(self, *, summary_text: str | None = None) -> dict[str, Any]:
        payload = self.to_json()
        payload.pop("schema_version", None)
        payload["display_title"] = self.display_title
        payload["label"] = self.label
        payload["searchable"] = self.searchable
        if summary_text is not None:
            payload["summary_text"] = summary_text
            payload["summary_revision"] = revision_of(summary_text)
        return payload

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> Document:
        title, authors = data.get("title"), data.get("authors")
        if not data.get("details_by"):
            # Still only what the file says of itself, so cleaned on the way in
            # as well as at import: a project holds papers imported before a
            # kind of junk was recognised. What someone set is left as set.
            title, authors = clean_title(title), clean_authors(authors)
        return cls(
            document_id=data["document_id"],
            sha256=data["sha256"],
            original_filename=data.get("original_filename", "document.pdf"),
            byte_size=int(data.get("byte_size", 0)),
            imported_at=data.get("imported_at", ""),
            title=title,
            authors=authors,
            year=data.get("year"),
            page_count=data.get("page_count"),
            tags=[str(tag) for tag in data.get("tags") or []],
            details_by=data.get("details_by") or None,
            extraction=data.get("extraction") or {},
            summary=data.get("summary") or {},
        )


@dataclass
class SearchHit:
    document_id: str
    document_title: str
    page_number: int
    page_label: str | None
    snippet: str
    quote: str
    score: float

    def to_json(self) -> dict[str, Any]:
        return {
            "document_id": self.document_id,
            "document_title": self.document_title,
            "page_number": self.page_number,
            "page_label": self.page_label,
            "snippet": self.snippet,
            "quote": self.quote,
            "score": round(self.score, 4),
        }


class DocumentStore:
    def __init__(self, workspace: Workspace, *, max_upload_bytes: int = 64 * 1024 * 1024) -> None:
        self._workspace = workspace
        self._lock = threading.RLock()
        self._extraction_cache: dict[str, tuple[float, DocumentExtraction]] = {}
        self.max_upload_bytes = max_upload_bytes
        # Set when the project has storage: fetches a paper's extracted text
        # that this machine does not have yet. Returns whether it is here now.
        self.fetch_pages: Callable[[str], bool] | None = None
        # Papers storage had no text for, so a search does not ask again for
        # each of them on every query. Cleared whenever the project syncs.
        self._no_pages: set[str] = set()

    # ---------------------------------------------------------------- paths

    def dir_for(self, document_id: str) -> Path:
        return self._workspace.document_dir(document_id)

    def pdf_path(self, document_id: str) -> Path:
        return self.dir_for(document_id) / "original.pdf"

    def metadata_path(self, document_id: str) -> Path:
        return self.dir_for(document_id) / "metadata.json"

    def pages_path(self, document_id: str) -> Path:
        return self.dir_for(document_id) / "pages.json"

    def summary_path(self, document_id: str) -> Path:
        return self.dir_for(document_id) / "summary.md"

    # ----------------------------------------------------------- read model

    def list(self) -> list[Document]:
        documents: list[Document] = []
        root = self._workspace.documents_dir
        if not root.is_dir():
            return documents
        for entry in sorted(root.iterdir()):
            if not entry.is_dir():
                continue
            metadata = entry / "metadata.json"
            if not metadata.is_file():
                continue
            try:
                documents.append(Document.from_json(json.loads(metadata.read_text("utf-8"))))
            except (json.JSONDecodeError, KeyError) as exc:
                log.warning("Skipping unreadable metadata at %s: %s", metadata, exc)
        return documents

    def get(self, document_id: str) -> Document:
        path = self._workspace.resolve_inside(self.metadata_path(document_id))
        if not path.is_file():
            raise NotFound(f"No document {document_id!r}.", document_id=document_id)
        return Document.from_json(json.loads(path.read_text("utf-8")))

    def find_by_hash(self, sha256: str) -> Document | None:
        for document in self.list():
            if document.sha256 == sha256:
                return document
        return None

    def save(self, document: Document) -> Document:
        atomic_write_text(
            self.metadata_path(document.document_id),
            json.dumps(document.to_json(), indent=2, ensure_ascii=False) + "\n",
        )
        return document

    def update(self, document_id: str, change: Callable[[Document], None]) -> Document:
        """Read a paper's metadata, change it, and write it back, as one step.

        Several things write this file — extraction in a worker thread, the
        summary's status from the agent's loop, the user's tags from a request
        — and each changes its own part. Done as separate reads and writes, a
        slow writer puts back what it read and erases what a quicker one wrote
        meanwhile. Every change to stored metadata goes through here.
        """
        with self._lock:
            document = self.get(document_id)
            change(document)
            return self.save(document)

    # ----------------------------------------------------------------- tags

    def all_tags(self) -> list[dict[str, Any]]:
        """Every tag in use, with how many papers carry it."""
        counts: dict[str, int] = {}
        for document in self.list():
            for tag in document.tags:
                counts[tag] = counts.get(tag, 0) + 1
        return [
            {"tag": tag, "count": counts[tag]} for tag in sorted(counts, key=tag_sort_key)
        ]

    def set_tags(self, document_id: str, tags: list[str]) -> Document:
        """Replace a paper's tags with exactly these."""
        with self._lock:
            known = [entry["tag"] for entry in self.all_tags()]
            document = self.get(document_id)
            document.tags = normalize_tags(tags, known=known)
            return self.save(document)

    def set_details(
        self,
        document_id: str,
        *,
        title: str | None = None,
        authors: list[str] | str | None = None,
        year: int | None = None,
        by: str,
    ) -> tuple[Document, bool]:
        """Say what a paper is: its title, who wrote it, and when.

        What the PDF's own metadata gives is often missing or wrong — the date
        the file was made rather than the paper's, a word processor's file
        path for a title. Whatever is passed replaces it; what is left out
        stays. Returns the paper, and whether anything changed.
        """
        with self._lock:
            document = self.get(document_id)
            before = (document.title, document.authors, document.year)
            if title is not None:
                cleaned = " ".join(str(title).split())
                if not cleaned or len(cleaned) > MAX_TITLE_CHARS:
                    raise InvalidInput(
                        f"A title is between 1 and {MAX_TITLE_CHARS} characters."
                    )
                document.title = cleaned
            if authors is not None:
                names = author_names(authors) if isinstance(authors, str) else [
                    " ".join(str(name).split()) for name in authors
                ]
                names = [name for name in names if name]
                if not names or any(len(name) > 120 for name in names) or len(names) > 60:
                    raise InvalidInput(
                        "Authors are given as full names, one each: "
                        '["G. Steven Olley", "Ariel Pakes"].'
                    )
                document.authors = " and ".join(names)
            if year is not None:
                try:
                    number = int(year)
                except (TypeError, ValueError):
                    raise InvalidInput(f"{year!r} is not a year.") from None
                if not 1400 <= number <= 2200:
                    raise InvalidInput(f"{number} is not a year a paper could be from.")
                document.year = number
            changed = (document.title, document.authors, document.year) != before
            if not changed and document.details_by:
                return document, False
            # Said by someone now, even where they only confirmed the file.
            document.details_by = by
            return self.save(document), changed

    def tag(
        self,
        document_ids: list[str],
        *,
        add: list[str] | None = None,
        remove: list[str] | None = None,
    ) -> list[Document]:
        """Add tags to, and remove tags from, several papers at once.

        Returns the papers that actually changed.
        """
        with self._lock:
            known = [entry["tag"] for entry in self.all_tags()]
            adding = normalize_tags(add or [], known=known)
            removing = {tag.casefold() for tag in normalize_tags(remove or [], known=known)}
            documents = [self.get(document_id) for document_id in dict.fromkeys(document_ids)]
            changed: list[Document] = []
            for document in documents:
                kept = [tag for tag in document.tags if tag.casefold() not in removing]
                wanted = normalize_tags([*kept, *adding], known=known)
                if wanted != document.tags:
                    document.tags = wanted
                    changed.append(self.save(document))
            return changed

    def with_tags(self, tags: list[str] | None) -> set[str] | None:
        """IDs of the papers carrying every one of these tags; None for no filter."""
        wanted = [tag.casefold() for tag in normalize_tags(tags or [])]
        if not wanted:
            return None
        return {
            document.document_id
            for document in self.list()
            if all(tag in {own.casefold() for own in document.tags} for tag in wanted)
        }

    def next_id(self) -> str:
        with self._lock:
            index = 1
            while (self._workspace.documents_dir / f"doc-{index:03d}").exists():
                index += 1
            return f"doc-{index:03d}"

    # ------------------------------------------------------------- ingestion

    def import_pdf(self, data: bytes, filename: str) -> tuple[Document, bool]:
        """Store an uploaded PDF. Returns ``(document, is_duplicate)``.

        Identical bytes resolve to the existing document rather than creating
        an accidental second copy.
        """
        if not data:
            raise InvalidInput("The uploaded file is empty.")
        if len(data) > self.max_upload_bytes:
            raise InvalidInput(
                f"{filename} is {len(data) / 1e6:.1f} MB, over the "
                f"{self.max_upload_bytes / 1e6:.0f} MB limit for this project."
            )
        if not data.lstrip()[:5].startswith(PDF_MAGIC):
            raise InvalidInput(
                f"{filename} does not look like a PDF (no %PDF header). "
                "Only PDF import is supported in this version."
            )

        digest = sha256_bytes(data)
        with self._lock:
            existing = self.find_by_hash(digest)
            if existing is not None:
                return existing, True

            document_id = self.next_id()
            directory = self._workspace.resolve_inside(self.dir_for(document_id))
            directory.mkdir(parents=True, exist_ok=True)
            # The original bytes are stored unchanged and never rewritten.
            atomic_write_bytes(directory / "original.pdf", data)

            info = pdf_metadata(directory / "original.pdf")
            document = Document(
                document_id=document_id,
                sha256=digest,
                original_filename=_safe_filename(filename),
                byte_size=len(data),
                imported_at=utcnow(),
                title=info.get("title"),
                authors=info.get("authors"),
                year=info.get("year"),
                page_count=info.get("page_count"),
                extraction={
                    "status": PENDING,
                    "version": EXTRACTION_VERSION,
                    "quality": None,
                    "warnings": [],
                    "error": None,
                    "encrypted": bool(info.get("encrypted")),
                },
                summary={"status": NONE, "error": None, "generated_at": None},
            )
            return self.save(document), False

    def delete(self, document_id: str) -> None:
        import shutil

        directory = self._workspace.resolve_inside(self.dir_for(document_id))
        if not directory.is_dir():
            raise NotFound(f"No document {document_id!r}.", document_id=document_id)
        trash = self._workspace.history_dir / f"deleted-{utcnow().replace(':', '')}-{document_id}"
        shutil.move(str(directory), str(trash))
        self._extraction_cache.pop(document_id, None)

    # ------------------------------------------------------------ extraction

    def run_extraction(self, document_id: str) -> dict[str, Any]:
        """Job handler. Runs in a worker thread; never touches the event loop."""

        def started(document: Document) -> None:
            document.extraction = {**document.extraction, "status": RUNNING, "error": None}

        self.update(document_id, started)

        pdf = self._workspace.resolve_inside(self.pdf_path(document_id))
        try:
            extraction = extract_pdf(pdf)
        except ExtractionError as exc:
            failure = exc

            def failed(document: Document) -> None:
                document.extraction = {
                    **document.extraction,
                    "status": FAILED,
                    "kind": failure.kind,
                    "error": str(failure),
                    "completed_at": utcnow(),
                }
                document.summary = {
                    **document.summary,
                    "status": UNAVAILABLE,
                    "error": "No text could be extracted, so no summary can be written.",
                }

            self.update(document_id, failed)
            return {"status": FAILED, "error": str(exc), "kind": exc.kind}

        atomic_write_text(
            self.pages_path(document_id),
            json.dumps(extraction.to_json(), ensure_ascii=False) + "\n",
        )
        self._extraction_cache.pop(document_id, None)

        def finished(document: Document) -> None:
            document.page_count = extraction.page_count or document.page_count
            if not document.title:
                document.title = _guess_title(extraction)
            document.extraction = {
                "status": OK,
                "version": extraction.extraction_version,
                "quality": extraction.quality,
                "warnings": extraction.warnings,
                "empty_pages": extraction.empty_pages(),
                "error": None,
                "completed_at": utcnow(),
                "encrypted": document.extraction.get("encrypted", False),
            }
            if extraction.quality == "none":
                document.summary = {
                    **document.summary,
                    "status": UNAVAILABLE,
                    "error": "No text could be extracted, so no summary can be written.",
                }

        self.update(document_id, finished)
        return {
            "status": OK,
            "pages": extraction.page_count,
            "quality": extraction.quality,
        }

    def extraction(self, document_id: str) -> DocumentExtraction:
        """Load ``pages.json``, cached by file modification time."""
        path = self._workspace.resolve_inside(self.pages_path(document_id))
        if not path.is_file() and self.fetch_pages and document_id not in self._no_pages:
            try:
                if not self.fetch_pages(document_id):
                    self._no_pages.add(document_id)
            except Exception as exc:  # noqa: BLE001 - reading must not fail on storage
                log.warning("Extracted text of %s could not be fetched: %s", document_id, exc)
                self._no_pages.add(document_id)
        if not path.is_file():
            raise NotFound(
                f"Document {document_id!r} has no extracted text yet.",
                document_id=document_id,
            )
        stamp = path.stat().st_mtime
        cached = self._extraction_cache.get(document_id)
        if cached is not None and cached[0] == stamp:
            return cached[1]
        extraction = DocumentExtraction.from_json(json.loads(path.read_text("utf-8")))
        self._extraction_cache[document_id] = (stamp, extraction)
        return extraction

    def retry_missing_pages(self) -> None:
        """Storage may have caught up: ask again for text it lacked before."""
        self._no_pages.clear()

    def page(self, document_id: str, page_number: int) -> PageExtraction:
        from .references import find_page

        return find_page(self.extraction(document_id), page_number)

    # -------------------------------------------------------------- summary

    def summary_text(self, document_id: str) -> str | None:
        path = self._workspace.resolve_inside(self.summary_path(document_id))
        return path.read_text("utf-8") if path.is_file() else None

    def write_summary(
        self, document_id: str, text: str, *, expected_revision: str | None
    ) -> tuple[str, str | None]:
        self.get(document_id)  # Confirms the document exists.
        return self._workspace.write_versioned(
            self.summary_path(document_id),
            text,
            expected_revision=expected_revision,
            snapshot_reason="summary",
        )

    def set_summary_status(
        self, document_id: str, status: str, *, error: str | None = None
    ) -> Document:
        def change(document: Document) -> None:
            document.summary = {
                **document.summary,
                "status": status,
                "error": error,
                "generated_at": (
                    utcnow() if status == READY else document.summary.get("generated_at")
                ),
            }

        return self.update(document_id, change)

    # --------------------------------------------------------------- search

    def search(
        self,
        query: str,
        *,
        document_ids: list[str] | None = None,
        tags: list[str] | None = None,
        limit: int = 20,
    ) -> list[SearchHit]:
        """Case-insensitive keyword search over extracted page text.

        Keyword search over the extracted text is enough for this application;
        no embedding service or vector database is involved.
        """
        terms = [t for t in re.split(r"\s+", normalize_text(query).text.strip().lower()) if t]
        if not terms:
            return []
        phrase = " ".join(terms)
        tagged = self.with_tags(tags)

        hits: list[SearchHit] = []
        for document in self.list():
            if document_ids and document.document_id not in document_ids:
                continue
            if tagged is not None and document.document_id not in tagged:
                continue
            if not document.searchable:
                continue
            try:
                extraction = self.extraction(document.document_id)
            except NotFound:
                continue
            for page in extraction.pages:
                text = page.text
                if not text:
                    continue
                normalized = normalize_text(text)
                lowered = normalized.lowered
                position = lowered.find(phrase)
                if position >= 0:
                    score = 2.0 + phrase.count(" ")
                    matched = len(phrase)
                else:
                    present = [t for t in terms if t in lowered]
                    if len(present) < max(1, len(terms) // 2):
                        continue
                    position = lowered.find(present[0])
                    matched = len(present[0])
                    score = len(present) / len(terms)
                raw_start = normalized.offsets[position]
                raw_end = normalized.offsets[min(position + matched, len(normalized.offsets)) - 1] + 1
                hits.append(
                    SearchHit(
                        document_id=document.document_id,
                        document_title=document.display_title,
                        page_number=page.page_number,
                        page_label=page.page_label,
                        snippet=_snippet(text, raw_start, raw_end),
                        quote=text[raw_start:raw_end],
                        score=score,
                    )
                )
        hits.sort(key=lambda hit: (-hit.score, hit.document_id, hit.page_number))
        return hits[:limit]


def tag_sort_key(tag: str) -> tuple[str, str]:
    """Grouped tags (`field:labor`) sort by group, then by value; case aside."""
    group, colon, value = tag.partition(":")
    if not colon:
        return ("", tag.casefold())  # Plain tags first, among themselves.
    return (group.casefold(), value.casefold())


def normalize_tags(tags: list[str], *, known: list[str] | None = None) -> list[str]:
    """Tags as they are stored: tidy, unique whatever their case, and in order.

    A tag is a short free label. One with a colon is read as `group:value`
    (`field:labor`, `jmp:2026`, `author:Card`), which is only a convention —
    the interface gathers such tags under their group. A tag typed in a
    different case than one already in the project takes the existing spelling,
    so `Labor` and `labor` do not become two collections.
    """
    spelling = {tag.casefold(): tag for tag in known or []}
    seen: dict[str, str] = {}
    for raw in tags:
        if not isinstance(raw, str):
            raise InvalidInput("A tag is a piece of text.")
        tag = " ".join(raw.replace("\x00", " ").split()).lstrip("#").strip()
        # `field : labor` and `field:labor` are the same tag.
        tag = re.sub(r"\s*:\s*", ":", tag).strip(":").strip()
        if not tag:
            continue
        if "," in tag:
            raise InvalidInput(f"A tag cannot contain a comma: {tag!r}.")
        if len(tag) > MAX_TAG_CHARS:
            raise InvalidInput(f"A tag is at most {MAX_TAG_CHARS} characters: {tag[:30]!r}…")
        if tag.casefold() == UNTAGGED:
            raise InvalidInput(f"{UNTAGGED!r} is how papers without tags are listed.")
        seen.setdefault(tag.casefold(), spelling.get(tag.casefold(), tag))
    if len(seen) > MAX_TAGS_PER_DOCUMENT:
        raise InvalidInput(f"A paper carries at most {MAX_TAGS_PER_DOCUMENT} tags.")
    return sorted(seen.values(), key=tag_sort_key)


_AUTHOR_SPLIT_RE = re.compile(r"\s+and\s+|;|&")
# Lower-case words that belong to the surname that follows: `van der Klaauw`.
_PARTICLES = {"de", "del", "della", "der", "den", "di", "da", "dos", "du", "la", "le", "van", "von", "ter"}


def author_names(raw: str | None) -> list[str]:
    """The names in an author string, which is free text.

    It may use "and", semicolons or commas — and a comma is ambiguous,
    separating a list in "Alice Researcher, Bob Coauthor" but one surname-first
    name in "Researcher, Alice". The parts are split on a comma only when
    every part looks like a whole name.
    """
    parts = [" ".join(part.split()) for part in _AUTHOR_SPLIT_RE.split(raw or "")]
    parts = [part for part in parts if part]
    if len(parts) == 1 and "," in parts[0]:
        chunks = [chunk.strip() for chunk in parts[0].split(",") if chunk.strip()]
        if len(chunks) > 1 and all(len(chunk.split()) > 1 for chunk in chunks):
            parts = chunks
    return parts


def surname_of(name: str) -> str:
    """`Pakes` of "Ariel Pakes" and of "Pakes, Ariel"; `De Loecker` of "Jan De Loecker"."""
    head = name.split(",")[0] if "," in name else name
    tokens = head.replace(".", ". ").split()
    if not tokens:
        return ""
    if "," in name:
        return " ".join(tokens)
    start = len(tokens) - 1
    while start > 0 and tokens[start - 1].lower() in _PARTICLES:
        start -= 1
    return " ".join(tokens[start:])


def _snippet(text: str, start: int, end: int, *, window: int = 110) -> str:
    left = max(0, start - window)
    right = min(len(text), end + window)
    prefix = "…" if left > 0 else ""
    suffix = "…" if right < len(text) else ""
    return prefix + " ".join(text[left:right].split()) + suffix


def _guess_title(extraction: DocumentExtraction) -> str | None:
    """Fall back to the largest text near the top of the first page."""
    if not extraction.pages:
        return None
    first = extraction.pages[0]
    for line in first.lines[:6]:
        candidate = line.text.strip()
        if 8 <= len(candidate) <= 200 and not candidate.lower().startswith(("http", "doi")):
            return candidate
    return None


def _safe_filename(filename: str) -> str:
    name = Path(filename or "document.pdf").name
    return name[:200] or "document.pdf"
