"""REST resources and the resumable event stream.

Validation errors and conflicts are returned explicitly. There is deliberately
no arbitrary-path file API: notes and documents are addressed by ID.
"""

from __future__ import annotations

import json
import re
import unicodedata
import uuid
from typing import Annotated, Any
from urllib.parse import quote

from fastapi import APIRouter, File, Query, Request, Response, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, PlainTextResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from ..agent.base import RunContext
from ..agent.tools import USER, dispatch
from ..documents import QUEUED, normalize_tags
from ..errors import InvalidInput, NotFound, RevisionConflict
from ..events import format_sse
from ..related import related_to_document, related_to_note
from ..skills import read_skill, write_skill
from ..references import (
    PAGE_ONLY,
    RESOLVED,
    Reference,
    citations_by_reference,
    find_page,
    locate_quote,
    rects_for_range,
)
from ..services import Services
from ..workspace import revision_of, utcnow


def services_of(request: Request) -> Services:
    return request.app.state.services  # type: ignore[no-any-return]


# ------------------------------------------------------------------ schemas



_NOT_IN_A_FILENAME = re.compile(r'[\\/:*?"<>|\x00-\x1f]+')


def _download_name(document: Any) -> str:
    """What a paper's PDF is called when it is saved: by its authors, year and title.

    `Olley & Pakes (1996) - The Dynamics of Productivity.pdf`, which says what
    it is in a folder of downloads, where the name it was imported under —
    `w3977.pdf` — does not. A paper nothing is known of keeps that name.
    """
    if not document.title:
        return document.original_filename or f"{document.document_id}.pdf"
    name = f"{document.label} - {document.title}" if document.label else document.title
    name = " ".join(_NOT_IN_A_FILENAME.sub(" ", name).split()).strip(" .")
    return f"{name[:150].rstrip(' .')}.pdf" if name else f"{document.document_id}.pdf"


def _disposition(kind: str, filename: str) -> str:
    """A Content-Disposition header naming a file, whatever is in the name.

    A header holds Latin-1 and the name is quoted, so a title with an accent
    beyond it, or a quotation mark, could not be sent as it is. The name is
    given twice, as browsers expect: plainly, for the ones that read nothing
    else, and in full.
    """
    plain = unicodedata.normalize("NFKD", filename).encode("ascii", "ignore").decode("ascii")
    plain = re.sub(r"[^A-Za-z0-9 ._()&,\-]+", "_", plain).strip(" .") or "paper.pdf"
    return f"{kind}; filename=\"{plain}\"; filename*=UTF-8''{quote(filename, safe='')}"


class NoteCreate(BaseModel):
    title: str = Field(default="Untitled note", max_length=200)
    text: str | None = None


class NoteSave(BaseModel):
    text: str
    expected_revision: str | None = None


class SummarySave(BaseModel):
    text: str
    expected_revision: str | None = None


class InkSave(BaseModel):
    """Every stroke on a paper, as the window holds them after its last change."""

    strokes: list[dict[str, Any]]
    expected_revision: str | None = None


class MessageSend(BaseModel):
    prompt: str
    context: dict[str, Any] | None = None


class ConversationCreate(BaseModel):
    # Unnamed until something is asked in it: the first message is its title.
    title: str | None = Field(default=None, max_length=200)


class ConversationChange(BaseModel):
    """A new name, or put away / brought back; what is left out stays."""

    title: str | None = Field(default=None, max_length=200)
    closed: bool | None = None


class ViewSave(BaseModel):
    # What was on screen with the conversation; the window's own business.
    view: dict[str, Any]


class ManualReference(BaseModel):
    """A reference created from a human PDF selection."""

    document_id: str
    page_number: int
    quote: str | None = None
    prefix: str | None = None
    suffix: str | None = None
    start: int | None = Field(
        default=None, description="Character offset into the page's extracted text."
    )
    end: int | None = None
    allow_page_only: bool = False


class ResolveRequest(BaseModel):
    document_id: str
    page_number: int
    quote: str | None = None
    prefix: str | None = None
    suffix: str | None = None
    allow_page_only: bool = False


class DetailsSet(BaseModel):
    """Whatever is given replaces what is recorded; what is left out stays."""

    title: str | None = None
    authors: str | None = None
    year: int | None = None


class UndoRequest(BaseModel):
    expected_revision: str | None = None


class BibliographyWrite(BaseModel):
    cited_only: bool = False


class TagsSet(BaseModel):
    tags: list[str] = Field(default_factory=list)


class AgentChoice(BaseModel):
    """What answers in a session. Both are given; null is the project's default."""

    model_config = ConfigDict(extra="forbid")

    model: str | None = Field(max_length=100)
    effort: str | None = Field(max_length=40)


class TagsChange(BaseModel):
    """Add and remove tags across several documents at once."""

    document_ids: list[str]
    add: list[str] = Field(default_factory=list)
    remove: list[str] = Field(default_factory=list)


class SettingsChange(BaseModel):
    downloads: str


class PermissionAnswer(BaseModel):
    answer: str


class SyncRequest(BaseModel):
    # Settles a conflict by keeping one side: "mine" or "theirs".
    resolve: str | None = None


def build_router() -> APIRouter:
    router = APIRouter()

    # -------------------------------------------------------------- project

    @router.get("/state")
    async def state(request: Request) -> dict[str, Any]:
        payload = services_of(request).project_state()
        # Whether there is a session to sign out of.
        payload["auth"] = {"password": bool(getattr(request.app.state, "password_enabled", False))}
        return payload

    @router.get("/version")
    async def version(request: Request) -> dict[str, Any]:
        """The version running, and a later one if one has been released."""
        from ..updates import version_status

        return version_status(getattr(request.app.state, "update_check", None))

    @router.get("/doctor")
    async def doctor(request: Request) -> dict[str, Any]:
        services = services_of(request)
        return {
            "project": str(services.workspace.root),
            "agent": services.agent_availability().to_json(),
            "documents": len(services.documents.list()),
            "notes": len(services.workspace.list_notes()),
            "references": len(services.references.all()),
        }

    # ---------------------------------------------------------------- notes

    @router.get("/notes")
    async def list_notes(request: Request) -> dict[str, Any]:
        notes = services_of(request).workspace.list_notes()
        return {"notes": [note.to_json(include_text=False) for note in notes]}

    @router.post("/notes", status_code=201)
    async def create_note(request: Request, body: NoteCreate) -> dict[str, Any]:
        services = services_of(request)
        note = services.workspace.create_note(title=body.title, text=body.text)
        return note.to_json()

    @router.get("/notes/{note_id}")
    async def read_note(request: Request, note_id: str) -> dict[str, Any]:
        return services_of(request).workspace.read_note(note_id).to_json()

    @router.put("/notes/{note_id}")
    async def save_note(request: Request, note_id: str, body: NoteSave) -> dict[str, Any]:
        services = services_of(request)
        exists = services.workspace.note_exists(note_id)
        note = services.workspace.write_note(
            note_id,
            body.text,
            expected_revision=body.expected_revision,
            create=not exists,
            snapshot_reason="user",
        )
        if exists and note.revision == body.expected_revision:
            # The text that was already there: nothing was edited, so there is
            # nothing to record, and no edit to attribute to the user.
            return note.to_json()
        services.db.execute(
            "INSERT INTO changes(id, target_kind, target_id, origin, summary, "
            "base_revision, new_revision, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
            (
                # A change ID must be unique per *edit*, not per resulting
                # content: deriving it from the revision hash made saving a
                # note back to text it previously held collide with the earlier
                # change and fail the write with an integrity error.
                f"chg-{uuid.uuid4().hex[:12]}",
                "note",
                note_id,
                "user",
                "Saved from the editor",
                body.expected_revision,
                note.revision,
                utcnow(),
            ),
        )
        return note.to_json()

    @router.delete("/notes/{note_id}", status_code=204)
    async def delete_note(
        request: Request, note_id: str, expected_revision: str | None = None
    ) -> Response:
        # Recorded like any other edit, with the text kept aside: a deletion
        # is listed under Recent edits and can be undone from there.
        services_of(request).tools.remove_note(
            note_id, expected_revision=expected_revision, origin=USER
        )
        return Response(status_code=204)

    # ------------------------------------------------------------ documents

    @router.post("/documents", status_code=201)
    async def upload_documents(
        request: Request,
        files: Annotated[list[UploadFile], File()],
        tags: Annotated[list[str] | None, Query()] = None,
    ) -> dict[str, Any]:
        services = services_of(request)
        # Checked before anything is stored: a bad tag fails the request, not
        # half of it.
        wanted = normalize_tags(tags or [])
        imported: list[dict[str, Any]] = []
        errors: list[dict[str, Any]] = []
        for upload in files:
            data = await upload.read()
            try:
                document, duplicate = services.documents.import_pdf(
                    data, upload.filename or "document.pdf"
                )
            except InvalidInput as exc:
                errors.append({"filename": upload.filename, "message": exc.message})
                continue
            if wanted:
                # A paper already here is gathered with the others all the same.
                services.documents.tag([document.document_id], add=wanted)
                document = services.documents.get(document.document_id)
            if not duplicate:
                # The PDF is readable immediately; extraction runs in the background.
                services.enqueue_extraction(document.document_id)
            imported.append(
                {
                    "document": document.api_json(
                        summary_text=services.documents.summary_text(document.document_id)
                    ),
                    "duplicate": duplicate,
                }
            )
        return {"imported": imported, "errors": errors}

    @router.get("/documents")
    async def list_documents(request: Request) -> dict[str, Any]:
        services = services_of(request)
        return {
            "documents": [
                document.api_json(
                    summary_text=services.documents.summary_text(document.document_id)
                )
                for document in services.documents.list()
            ]
        }

    @router.get("/documents/{document_id}")
    async def get_document(request: Request, document_id: str) -> dict[str, Any]:
        services = services_of(request)
        document = services.documents.get(document_id)
        return document.api_json(summary_text=services.documents.summary_text(document_id))

    @router.get("/tags")
    async def list_tags(request: Request) -> dict[str, Any]:
        return {"tags": services_of(request).documents.all_tags()}

    @router.post("/documents/tags")
    async def change_tags(request: Request, body: TagsChange) -> dict[str, Any]:
        services = services_of(request)
        changed = services.documents.tag(body.document_ids, add=body.add, remove=body.remove)
        services.announce_documents([document.document_id for document in changed])
        return {
            "changed": [document.document_id for document in changed],
            "tags": services.documents.all_tags(),
        }

    @router.put("/documents/{document_id}/tags")
    async def set_tags(request: Request, document_id: str, body: TagsSet) -> dict[str, Any]:
        services = services_of(request)
        document = services.documents.set_tags(document_id, body.tags)
        services.announce_documents([document_id])
        return document.api_json(summary_text=services.documents.summary_text(document_id))

    # ---------------------------------------------------------------- skill

    @router.get("/skills/summary")
    async def get_skill(request: Request) -> dict[str, Any]:
        """How this reader wants papers summarized."""
        return read_skill(services_of(request).workspace)

    @router.put("/skills/summary")
    async def save_skill(request: Request, body: SummarySave) -> dict[str, Any]:
        """The reader's own hand on it: saved like a note, and on the same record."""
        services = services_of(request)
        services.tools.save_skill(
            body.text, expected_revision=body.expected_revision, origin=USER
        )
        return read_skill(services.workspace)

    @router.put("/documents/{document_id}/details")
    async def set_details(
        request: Request, document_id: str, body: DetailsSet
    ) -> dict[str, Any]:
        """What the paper is — title, authors, year — as the user says it."""
        services = services_of(request)
        document, _ = services.documents.set_details(
            document_id, title=body.title, authors=body.authors, year=body.year, by=USER
        )
        services.announce_documents([document_id])
        return document.api_json(summary_text=services.documents.summary_text(document_id))

    @router.get("/documents/{document_id}/pdf")
    async def get_pdf(request: Request, document_id: str, download: bool = False) -> Response:
        """The paper's PDF: to be shown in the page, or — `download` — kept as a file."""
        services = services_of(request)
        document = services.documents.get(document_id)
        # Here already, or fetched from the project's storage on first opening.
        path = await run_in_threadpool(services.papers.ensure_pdf, document_id)
        disposition = (
            _disposition("attachment", _download_name(document))
            if download
            else _disposition("inline", document.original_filename)
        )
        return Response(
            content=await run_in_threadpool(path.read_bytes),
            media_type="application/pdf",
            headers={
                "content-disposition": disposition,
                "cache-control": "private, max-age=3600",
                "etag": f'"{document.sha256}"',
            },
        )

    @router.get("/documents/{document_id}/pdf/annotated")
    async def get_annotated_pdf(request: Request, document_id: str) -> Response:
        """A copy of the paper with its ink on it, to keep. The stored PDF is not changed."""
        services = services_of(request)
        document = services.documents.get(document_id)
        path = await run_in_threadpool(services.papers.ensure_pdf, document_id)
        data = await run_in_threadpool(services.ink.annotated_pdf, document_id, path)
        name = f"{_download_name(document).removesuffix('.pdf')} (annotated).pdf"
        return Response(
            content=data,
            media_type="application/pdf",
            headers={
                "content-disposition": _disposition("attachment", name),
                # Made from the ink as it is now: the next stroke makes another.
                "cache-control": "no-store",
            },
        )

    @router.get("/documents/{document_id}/ink")
    async def get_ink(request: Request, document_id: str) -> dict[str, Any]:
        """What has been drawn on the paper's pages."""
        return services_of(request).ink.read(document_id).to_json()

    @router.put("/documents/{document_id}/ink")
    async def save_ink(request: Request, document_id: str, body: InkSave) -> dict[str, Any]:
        """Replace the paper's strokes, if they are as this window last read them.

        A window that drew while another did is told so (409) and reads again:
        it puts its own strokes back on what the other saved, and saves that.
        """
        services = services_of(request)
        revision = services.ink.write(
            document_id, body.strokes, expected_revision=body.expected_revision
        )
        # Another window on the same paper — the desk beside the tablet — reads
        # the ink again.
        services.announce_ink(document_id, revision)
        return {"document_id": document_id, "revision": revision}

    @router.get("/documents/{document_id}/pages")
    async def get_pages(
        request: Request,
        document_id: str,
        page: Annotated[list[int] | None, Query()] = None,
    ) -> dict[str, Any]:
        services = services_of(request)
        extraction = await run_in_threadpool(services.documents.extraction, document_id)
        wanted = set(page or [])
        pages = [
            {
                "page_number": p.page_number,
                "page_label": p.page_label,
                "width": p.width,
                "height": p.height,
                "rotation": p.rotation,
                "warnings": p.warnings,
                "text": p.text,
            }
            for p in extraction.pages
            if not wanted or p.page_number in wanted
        ]
        return {
            "document_id": document_id,
            "page_count": extraction.page_count,
            "quality": extraction.quality,
            "warnings": extraction.warnings,
            "pages": pages,
        }

    @router.get("/documents/{document_id}/summary")
    async def get_summary(request: Request, document_id: str) -> dict[str, Any]:
        services = services_of(request)
        document = services.documents.get(document_id)
        text = services.documents.summary_text(document_id)
        return {
            "document_id": document_id,
            "text": text,
            "revision": revision_of(text) if text is not None else None,
            "status": document.summary.get("status"),
            "error": document.summary.get("error"),
            "extraction_quality": document.extraction.get("quality"),
            "extraction_warnings": document.extraction.get("warnings") or [],
        }

    @router.put("/documents/{document_id}/summary")
    async def save_summary(
        request: Request, document_id: str, body: SummarySave
    ) -> dict[str, Any]:
        services = services_of(request)
        revision, _previous = services.documents.write_summary(
            document_id, body.text, expected_revision=body.expected_revision
        )
        services.documents.set_summary_status(document_id, "ready")
        return {"document_id": document_id, "revision": revision}

    @router.post("/documents/{document_id}/extract")
    async def reextract(request: Request, document_id: str) -> dict[str, Any]:
        services = services_of(request)
        services.documents.get(document_id)
        return {"job_id": services.enqueue_extraction(document_id)}

    @router.post("/documents/{document_id}/summarize")
    async def summarize(request: Request, document_id: str) -> dict[str, Any]:
        services = services_of(request)
        run_id = services.runner.queue_summary(document_id)
        if run_id is None:
            document = services.documents.get(document_id)
            return {
                "queued": False,
                "reason": document.summary.get("error")
                or "A summary cannot be generated for this document yet.",
            }
        return {"queued": True, "run_id": run_id, "status": QUEUED}

    @router.delete("/documents/{document_id}", status_code=200)
    async def delete_document(request: Request, document_id: str) -> dict[str, Any]:
        services = services_of(request)
        services.documents.delete(document_id)
        # References survive as a recoverable missing-source state.
        touched = services.references.mark_missing(document_id)
        return {"deleted": document_id, "references_marked_missing": touched}

    # --------------------------------------------------------------- search

    @router.get("/search")
    async def search(
        request: Request,
        q: str,
        document_id: Annotated[list[str] | None, Query()] = None,
        limit: int = 20,
    ) -> dict[str, Any]:
        services = services_of(request)
        hits = services.documents.search(q, document_ids=document_id, limit=limit)
        notes = []
        needle = q.strip().lower()
        if needle:
            for note in services.workspace.list_notes():
                position = note.text.lower().find(needle)
                if position >= 0:
                    notes.append(
                        {
                            "note_id": note.note_id,
                            "title": note.title,
                            "snippet": " ".join(
                                note.text[max(0, position - 80) : position + 120].split()
                            ),
                        }
                    )
        return {"query": q, "passages": [hit.to_json() for hit in hits], "notes": notes}

    @router.get("/related")
    async def related(
        request: Request, note_id: str | None = None, document_id: str | None = None
    ) -> dict[str, Any]:
        """What goes with the note or the paper on screen."""
        services = services_of(request)
        if note_id:
            return related_to_note(
                services.workspace, services.documents, services.references, note_id
            )
        if document_id:
            return related_to_document(
                services.workspace, services.documents, services.references, document_id
            )
        raise InvalidInput("Name a note (note_id) or a paper (document_id).")

    # ----------------------------------------------------------- references

    @router.get("/references")
    async def list_references(
        request: Request, document_id: str | None = None
    ) -> dict[str, Any]:
        """Every reference, with where each one is cited from.

        The source panel draws all of a document's marks at once and colours
        them by origin, so it needs the citing notes alongside the geometry.
        """
        services = services_of(request)
        registry = services.references.all()
        citations = citations_by_reference(services.workspace, services.documents)
        references = [
            {**reference.api_json(), "cited_by": citations.get(reference_id, [])}
            for reference_id, reference in registry.items()
            if document_id is None or reference.document_id == document_id
        ]
        references.sort(key=lambda item: (item["page_number"], item["reference_id"]))
        return {"references": references}

    @router.get("/references/{reference_id}")
    async def get_reference(request: Request, reference_id: str) -> dict[str, Any]:
        services = services_of(request)
        reference = services.references.get(reference_id)
        payload = reference.api_json()
        try:
            document = services.documents.get(reference.document_id)
        except NotFound:
            payload["missing_source"] = True
            payload["message"] = (
                "The cited document is no longer in this project. The reference is "
                "preserved so it can be recovered."
            )
            return payload
        payload["document_title"] = document.display_title
        payload["document_sha256_matches"] = document.sha256 == reference.document_sha256
        if not payload["document_sha256_matches"]:
            payload["message"] = (
                "The stored PDF's bytes differ from the ones this reference was made "
                "against; the highlight may no longer be in the right place."
            )
        return payload

    @router.post("/references", status_code=201)
    async def create_reference(request: Request, body: ManualReference) -> dict[str, Any]:
        """Create a reference from a human PDF selection on one page.

        The browser sends the offsets of the selected characters in the page's
        extracted text; geometry is computed here so CSS pixels are never stored.
        """
        services = services_of(request)
        document = services.documents.get(body.document_id)
        page = find_page(services.documents.extraction(body.document_id), body.page_number)

        rects: list[list[float]] = []
        quote = body.quote
        status = RESOLVED
        message: str | None = None

        if body.start is not None and body.end is not None and body.end > body.start:
            rects = rects_for_range(page, body.start, body.end)
            quote = page.text[body.start : body.end]
        elif quote:
            match = locate_quote(page, quote, prefix=body.prefix, suffix=body.suffix)
            if match.ok:
                rects = match.rects
                quote = match.quote
            elif body.allow_page_only:
                status, message = PAGE_ONLY, match.message
            else:
                return JSONResponse(
                    {"error": {"code": match.status, "message": match.message}},
                    status_code=422,
                )
        elif body.allow_page_only:
            status, message = PAGE_ONLY, "Page-only citation."
        else:
            raise InvalidInput("Supply a selection range, a quotation, or allow_page_only.")

        if not rects and status == RESOLVED:
            status = PAGE_ONLY
            message = "The selection produced no usable geometry; cited the page only."

        reference = Reference(
            reference_id="",  # given by the registry, as it is written
            document_id=body.document_id,
            document_sha256=document.sha256,
            page_number=page.page_number,
            page_label=page.page_label,
            status=status,
            quote=quote,
            prefix=body.prefix,
            suffix=body.suffix,
            rects=rects,
            note=message,
            created_at=utcnow(),
        )
        services.references.add(reference)
        label = f"{document.display_title}, p. {page.page_label or page.page_number}"
        return {
            **reference.api_json(),
            "markdown_link": f"[{label}](source:{reference.reference_id})",
            "message": message,
        }

    @router.post("/references/resolve")
    async def resolve_reference(request: Request, body: ResolveRequest) -> dict[str, Any]:
        services = services_of(request)
        return dispatch(services.tools, "resolve_source", body.model_dump())

    # --------------------------------------------------------- bibliography

    # ``response_model=None``: this route answers with either JSON or the
    # ``.bib`` file itself, which is not one Pydantic response shape.
    @router.get("/bibliography", response_model=None)
    async def get_bibliography(
        request: Request, cited_only: bool = False, format: str = "json"
    ) -> Response | dict[str, Any]:
        """The BibTeX view of the project, as JSON or as the file itself.

        ``cited_only`` narrows it to works a note or summary actually cites.
        """
        services = services_of(request)
        bibliography = services.bibliography(cited_only=cited_only)
        if format == "bibtex":
            return PlainTextResponse(
                bibliography.to_bibtex(),
                media_type="application/x-bibtex; charset=utf-8",
                headers={"content-disposition": 'attachment; filename="references.bib"'},
            )
        return bibliography.api_json()

    @router.post("/bibliography")
    async def write_bibliography(
        request: Request, body: BibliographyWrite
    ) -> dict[str, Any]:
        """Write ``references.bib`` into the project directory."""
        return services_of(request).write_bibliography(cited_only=body.cited_only)

    # ----------------------------------------------------------------- sync

    @router.get("/sync")
    async def sync_status(request: Request) -> dict[str, Any]:
        return await run_in_threadpool(services_of(request).sync_status)

    @router.post("/sync")
    async def sync_now(request: Request, body: SyncRequest | None = None) -> dict[str, Any]:
        services = services_of(request)
        if body is not None and body.resolve not in (None, "mine", "theirs"):
            raise InvalidInput("Choose which side to keep: mine or theirs.")
        resolve = body.resolve if body is not None else None
        return await run_in_threadpool(lambda: services.sync_now(resolve=resolve))

    # -------------------------------------------------------- conversations

    @router.get("/conversations")
    async def list_conversations(request: Request) -> dict[str, Any]:
        return {"conversations": services_of(request).runner.list_conversations()}

    @router.post("/conversations", status_code=201)
    async def create_conversation(
        request: Request, body: ConversationCreate
    ) -> dict[str, Any]:
        services = services_of(request)
        conversation_id = services.runner.create_conversation(body.title)
        return services.runner.conversation(conversation_id)

    @router.get("/conversations/{conversation_id}")
    async def get_conversation(request: Request, conversation_id: str) -> dict[str, Any]:
        return services_of(request).runner.conversation(conversation_id)

    @router.patch("/conversations/{conversation_id}")
    async def change_conversation(
        request: Request, conversation_id: str, body: ConversationChange
    ) -> dict[str, Any]:
        runner = services_of(request).runner
        if body.title is None and body.closed is None:
            raise InvalidInput("Give a title, or say whether the session is closed.")
        changed: dict[str, Any] = {}
        if body.title is not None:
            changed = runner.rename_conversation(conversation_id, body.title)
        if body.closed is not None:
            changed = runner.set_closed(conversation_id, body.closed)
        return changed

    @router.put("/conversations/{conversation_id}/agent")
    async def choose_agent(
        request: Request, conversation_id: str, body: AgentChoice
    ) -> dict[str, Any]:
        """The model and effort this session's next message is answered with."""
        return services_of(request).runner.set_agent_choice(
            conversation_id, body.model, body.effort
        )

    @router.put("/conversations/{conversation_id}/view", status_code=204)
    async def save_view(request: Request, conversation_id: str, body: ViewSave) -> Response:
        """Remember what was on screen with a conversation, to come back to."""
        services_of(request).runner.save_view(conversation_id, body.view)
        return Response(status_code=204)

    @router.delete("/conversations/{conversation_id}")
    async def delete_conversation(request: Request, conversation_id: str) -> dict[str, Any]:
        return services_of(request).runner.delete_conversation(conversation_id)

    @router.get("/conversations/{conversation_id}/export")
    async def export_conversation(
        request: Request, conversation_id: str, format: str = "markdown"
    ) -> Response:
        services = services_of(request)
        if format == "json":
            payload = services.runner.conversation(conversation_id)
            return Response(
                content=json.dumps(payload, indent=2, ensure_ascii=False),
                media_type="application/json",
                headers={
                    "content-disposition": f'attachment; filename="{conversation_id}.json"'
                },
            )
        return PlainTextResponse(
            services.runner.transcript_markdown(conversation_id),
            headers={"content-disposition": f'attachment; filename="{conversation_id}.md"'},
        )

    @router.post("/conversations/{conversation_id}/messages", status_code=202)
    async def send_message(
        request: Request, conversation_id: str, body: MessageSend
    ) -> dict[str, Any]:
        services = services_of(request)
        if services.runner.kind_of(conversation_id) != "chat":
            raise InvalidInput("Background work is read-only; ask in a conversation of your own.")
        return services.runner.submit(
            conversation_id=conversation_id,
            prompt=body.prompt,
            context=RunContext.from_json(body.context),
        )

    @router.post("/runs/{run_id}/cancel")
    async def cancel_run(request: Request, run_id: str) -> dict[str, Any]:
        services = services_of(request)
        # A run waiting on the reader's answer has a tool held open: let it go.
        services.permissions.stop_run(run_id)
        return await services.runner.cancel(run_id)

    # --------------------------------------------- settings and permissions

    @router.get("/settings")
    async def get_settings(request: Request) -> dict[str, Any]:
        return {"downloads": services_of(request).download_mode()}

    @router.put("/settings")
    async def put_settings(request: Request, body: SettingsChange) -> dict[str, Any]:
        return {"downloads": services_of(request).set_download_mode(body.downloads)}

    @router.post("/permissions/{request_id}")
    async def answer_permission(
        request: Request, request_id: str, body: PermissionAnswer
    ) -> dict[str, Any]:
        """The reader's answer to something the agent asked leave to do."""
        if not services_of(request).answer_permission(request_id, body.answer):
            raise NotFound("That request is no longer waiting for an answer.")
        return {"request_id": request_id, "answer": body.answer}

    # -------------------------------------------------------------- changes

    @router.get("/changes")
    async def list_changes(request: Request, limit: int = 50) -> dict[str, Any]:
        rows = services_of(request).db.query(
            "SELECT * FROM changes ORDER BY created_at DESC, rowid DESC LIMIT ?", (limit,)
        )
        return {
            "changes": [
                {
                    "change_id": row["id"],
                    "target_kind": row["target_kind"],
                    "target_id": row["target_id"],
                    "origin": row["origin"],
                    "summary": row["summary"],
                    "base_revision": row["base_revision"],
                    "new_revision": row["new_revision"],
                    "undoable": bool(row["snapshot_path"]) and not row["undone_at"],
                    "undone_at": row["undone_at"],
                    "created_at": row["created_at"],
                }
                for row in rows
            ]
        }

    @router.post("/changes/{change_id}/undo")
    async def undo_change(
        request: Request, change_id: str, body: UndoRequest
    ) -> dict[str, Any]:
        """Undo is itself version-checked, so it cannot remove later edits."""
        services = services_of(request)
        row = services.db.query_one("SELECT * FROM changes WHERE id = ?", (change_id,))
        if row is None:
            raise NotFound(f"No change {change_id!r}.")
        if row["undone_at"]:
            raise InvalidInput("That change has already been undone.")
        if not row["snapshot_path"]:
            raise InvalidInput(
                "This change has no previous content to restore (it created the file)."
            )
        snapshot = services.workspace.resolve_inside(row["snapshot_path"])
        if not snapshot.is_file():
            raise NotFound("The recovery snapshot for this change is missing.")

        previous_text = snapshot.read_text("utf-8")
        expected = body.expected_revision or row["new_revision"]
        if row["target_kind"] == "skill":
            new_revision, _ = write_skill(
                services.workspace, previous_text, expected_revision=expected, name=row["target_id"]
            )
        elif row["target_kind"] == "note":
            note = services.workspace.write_note(
                row["target_id"],
                previous_text,
                expected_revision=expected,
                snapshot_reason="undo",
            )
            new_revision = note.revision
        else:
            new_revision, _ = services.documents.write_summary(
                row["target_id"], previous_text, expected_revision=expected
            )
        services.db.execute(
            "UPDATE changes SET undone_at = ? WHERE id = ?", (utcnow(), change_id)
        )
        return {"change_id": change_id, "revision": new_revision, "undone": True}

    # --------------------------------------------------------------- events

    @router.get("/events")
    async def events(
        request: Request,
        since: int = 0,
        conversation_id: str | None = None,
    ) -> StreamingResponse:
        services = services_of(request)
        last_event_id = request.headers.get("last-event-id")
        if last_event_id and last_event_id.isdigit():
            since = max(since, int(last_event_id))

        async def stream():  # type: ignore[no-untyped-def]
            # Open the response immediately. Without this the headers are not
            # flushed until the first event, so on a quiet project the browser
            # sits in EventSource's CONNECTING state — and shows "Reconnecting…"
            # — until the 15-second keepalive finally arrives.
            yield ": open\n\nretry: 2000\n\n"
            async for event in services.bus.stream(
                since=since, conversation_id=conversation_id
            ):
                if await request.is_disconnected():
                    break
                yield format_sse(event)

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={
                "cache-control": "no-cache, no-transform",
                "connection": "keep-alive",
                "x-accel-buffering": "no",
            },
        )

    return router


__all__ = ["build_router", "RevisionConflict"]
