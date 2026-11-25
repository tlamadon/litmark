"""Wiring: one object that owns the whole project's runtime state.

Kept deliberately small — it constructs the per-domain modules, registers job
handlers, and performs restart recovery. One server process serves one project.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import secrets
import threading
import time
import urllib.parse
from pathlib import Path
from typing import Any

from .agent.base import AgentBackend, Availability
from .agent.claude_sdk import ClaudeAgentBackend
from .agent.fake import FakeBackend
from .agent.runner import DEFAULT_PARALLEL_RUNS, AgentRunner
from . import downloads
from .agent.tools import AGENT, ProjectTools
from .bibliography import Bibliography, build_bibliography
from .db import Database
from .documents import DocumentStore, normalize_tags
from .downloads import Permissions
from .errors import InvalidInput, WorkspaceError
from .events import (
    DOCUMENT_UPDATED,
    FILE_CHANGED,
    PERMISSION_REQUESTED,
    PERMISSION_RESOLVED,
    SETTINGS_UPDATED,
    SYNC_UPDATED,
    EventBus,
)
from .gitsync import GitError, GitSync
from .jobs import JobQueue
from .papersync import PaperSync
from .references import ReferenceStore, citations_by_reference
from .storage import BlobStore, StorageMisconfigured, open_store, storage_settings
from .workspace import Workspace, atomic_write_text

log = logging.getLogger(__name__)

EXTRACT_JOB = "extract_document"
STORE_JOB = "store_document"
FETCH_JOB = "fetch_document"

# How often the background sync looks at the project, how long edits must have
# settled before they are committed, and how often the remote is asked for news
# when nothing here has changed.
SYNC_TICK_SECONDS = 20.0
SYNC_QUIET_SECONDS = 45.0
SYNC_FETCH_SECONDS = 300.0


class Services:
    def __init__(self, workspace: Workspace, *, backend_name: str | None = None) -> None:
        self.workspace = workspace
        settings = workspace.settings()
        ingestion = settings.get("ingestion") or {}
        agent_settings = settings.get("agent") or {}

        self.db = Database(workspace.db_path)
        self.bus = EventBus(self.db)
        self.jobs = JobQueue(self.db, self.bus)
        self.documents = DocumentStore(
            workspace,
            max_upload_bytes=int(float(ingestion.get("max_upload_mb", 64)) * 1024 * 1024),
        )
        self.references = ReferenceStore(workspace)

        # Papers go to storage, text goes to git. Neither is required, and a
        # project whose storage is misdescribed still opens: its notes are here.
        store: BlobStore | None = None
        problem: str | None = None
        try:
            store = open_store(settings, workspace.root)
        except StorageMisconfigured as exc:
            problem = exc.message
        self.papers = PaperSync(
            workspace,
            self.documents,
            store,
            problem=problem,
            prefetch=bool(storage_settings(settings).get("prefetch")),
        )
        if self.papers.enabled:
            self.documents.fetch_pages = self.papers.ensure_pages
        self.git = GitSync(workspace.root, settings, papers_in_storage=self.papers.enabled)
        self.git.annotate = self._outside_edits
        git_settings = settings.get("git") if isinstance(settings.get("git"), dict) else {}
        self._sync_quiet = float(git_settings.get("quiet_seconds", SYNC_QUIET_SECONDS))
        self._sync_fetch = float(git_settings.get("fetch_seconds", SYNC_FETCH_SECONDS))
        self._sync_lock = threading.Lock()
        self._sync_task: asyncio.Task[None] | None = None
        self._sync_running = False
        self._last_exchange = 0.0
        self.tools = ProjectTools(workspace, self.documents, self.references, self.db)
        self.tools.on_documents_changed = self.announce_documents
        self.tools.on_external_change = self._announce_change
        self.tools.downloader = self._download_paper
        self.permissions = Permissions()
        self.auto_summary = bool(agent_settings.get("auto_summary", True))

        self.backend_name = backend_name or str(agent_settings.get("backend", "claude"))
        self._agent_settings = agent_settings
        self.backend: AgentBackend = self._build_backend(self.backend_name)
        self.runner = AgentRunner(
            db=self.db,
            bus=self.bus,
            workspace=workspace,
            documents=self.documents,
            backend=self.backend,
            max_parallel=int(agent_settings.get("max_parallel_runs", DEFAULT_PARALLEL_RUNS)),
        )

        # A per-process credential so an unrelated website cannot drive the API,
        # even though the server listens on loopback.
        self.session_token = secrets.token_urlsafe(32)
        self.jobs.register(EXTRACT_JOB, self._extract_document)
        self.jobs.register(STORE_JOB, self._store_document)
        self.jobs.register(FETCH_JOB, self._fetch_document)

    def _build_backend(self, name: str) -> AgentBackend:
        if name == "fake":
            return FakeBackend(self.tools)
        # `[agent] model` and `effort` in project.toml choose what answers;
        # unset, the adapter's defaults stand.
        model = self._agent_settings.get("model")
        effort = self._agent_settings.get("effort")
        return ClaudeAgentBackend(
            self.tools,
            cwd=str(self.workspace.root),
            model=str(model) if model else None,
            effort=str(effort) if effort else None,
        )

    # ------------------------------------------------------------ lifecycle

    def bind_loop(self, loop: Any) -> None:
        self.bus.bind_loop(loop)
        self.jobs.bind_loop(loop)

    def recover(self) -> dict[str, int]:
        """Requeue interrupted jobs and mark unfinished runs."""
        return {
            "jobs": self.jobs.recover(),
            "runs": self.runner.recover(),
        }

    async def shutdown(self) -> None:
        if self._sync_task is not None:
            self._sync_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._sync_task
            self._sync_task = None
        await self.runner.stop()
        self.jobs.shutdown()
        self.db.close()

    # ---------------------------------------------------------------- jobs

    def announce_documents(self, document_ids: list[str]) -> None:
        """Tell every open window that these papers' details changed."""
        if document_ids:
            self.bus.publish(DOCUMENT_UPDATED, {"document_ids": document_ids})

    def _announce_change(self, change: dict[str, Any]) -> None:
        """An edit from outside this application's own runs: show it everywhere."""
        self.bus.publish(FILE_CHANGED, change)

    def import_paper(
        self,
        data: bytes,
        filename: str,
        *,
        tags: list[str] | None = None,
        summarize: bool = True,
        origin: str,
    ) -> dict[str, Any]:
        """Take in a PDF sent by a session elsewhere, and record who sent it."""
        wanted = normalize_tags(tags or [])
        document, duplicate = self.documents.import_pdf(data, filename)
        document_id = document.document_id
        if wanted:
            self.documents.tag([document_id], add=wanted)
        if not duplicate:
            self.tools.record_document_change(
                document_id, origin=origin, summary=f"Imported {document.original_filename}"
            )
            self.enqueue_extraction(document_id, summarize=summarize)
        self.announce_documents([document_id])
        return {"document_id": document_id, "duplicate": duplicate}

    # ------------------------------------------------------------ downloads

    def download_mode(self) -> str:
        """Whether the agent may fetch papers from the web: always, ask, never."""
        return downloads.mode_of(self.workspace.settings())

    def set_download_mode(self, mode: str) -> str:
        if mode not in downloads.MODES:
            raise InvalidInput(f"Downloads are one of: {', '.join(downloads.MODES)}.")
        self.workspace.set_setting("agent", "downloads", mode)
        self.bus.publish(SETTINGS_UPDATED, {"downloads": mode})
        return mode

    def answer_permission(self, request_id: str, answer: str) -> bool:
        if answer not in downloads.ANSWERS:
            raise InvalidInput(f"An answer is one of: {', '.join(downloads.ANSWERS)}.")
        return self.permissions.answer(request_id, answer)

    def _download_paper(self, url: str, tags: list[str], run_id: str | None) -> dict[str, Any]:
        """Fetch a paper for one of the agent's runs, as far as the reader allows.

        Runs on the tool's own thread, and in `ask` mode stays there until the
        reader has answered in the conversation.
        """

        def refused(code: str, message: str) -> dict[str, Any]:
            return {"ok": False, "error": code, "message": message}

        mode = self.download_mode()
        if mode == downloads.NEVER:
            return refused(
                "downloads_off",
                "The reader has turned downloads off. Tell them so; they can import "
                "the PDF themselves, or allow downloads beside the chat box.",
            )
        run = (
            self.db.query_one("SELECT conversation_id, kind FROM runs WHERE id = ?", (run_id,))
            if run_id
            else None
        )
        # Only in a conversation, where the reader is: background work reads
        # papers, and a paper's text must never be what sets off a download.
        if run is None or run["kind"] != "chat":
            return refused(
                "downloads_unavailable",
                "Papers are downloaded only in a conversation with the reader.",
            )
        target = downloads.normalize(url)
        host = urllib.parse.urlsplit(target).hostname or ""

        if mode == downloads.ASK:
            assert run_id is not None
            scope = {"conversation_id": run["conversation_id"], "run_id": run_id}
            request_id = self.permissions.open(run_id, target)
            self.bus.publish(
                PERMISSION_REQUESTED,
                {"request_id": request_id, "action": "download", "url": target, "host": host},
                **scope,
            )
            answer = self.permissions.wait(request_id)
            if answer == downloads.ALLOW_ALWAYS:
                self.set_download_mode(downloads.ALWAYS)
            self.bus.publish(
                PERMISSION_RESOLVED, {"request_id": request_id, "answer": answer}, **scope
            )
            if answer == downloads.DENY:
                return refused(
                    "download_declined",
                    "The reader declined this download. Do not try it again, by this "
                    "address or another, unless they ask.",
                )
            if answer not in (downloads.ALLOW, downloads.ALLOW_ALWAYS):
                return refused(
                    "download_unanswered",
                    "The reader did not answer, so nothing was downloaded. Say that "
                    "the download is waiting on them, and carry on with the rest.",
                )

        fetched = downloads.fetch_pdf(target, max_bytes=self.documents.max_upload_bytes)
        imported = self.import_paper(fetched.data, fetched.filename, tags=tags, origin=AGENT)
        return {
            "ok": True,
            **imported,
            "url": fetched.url,
            "filename": fetched.filename,
            "note": (
                "Already in the library."
                if imported["duplicate"]
                else "Imported. Its text is being extracted; read_pages answers once that is done."
            ),
        }

    def _outside_edits(self) -> str:
        """For a commit message: which sessions elsewhere wrote what is in it.

        The record of edits lives in this machine's database; the commit is what
        travels with the project, so the attribution is written there too.
        """
        since = int(self.db.get_meta("attributed_through", "0") or 0)
        rows = self.db.query(
            "SELECT rowid, origin, target_kind, target_id FROM changes "
            "WHERE rowid > ? AND origin LIKE 'mcp:%' ORDER BY rowid",
            (since,),
        )
        latest = self.db.query_one("SELECT COALESCE(MAX(rowid), 0) AS seq FROM changes")
        self.db.set_meta("attributed_through", str(latest["seq"] if latest else since))
        by_origin: dict[str, list[str]] = {}
        for item in rows:
            target = f"{item['target_kind']} {item['target_id']}"
            targets = by_origin.setdefault(str(item["origin"]), [])
            if target not in targets:
                targets.append(target)
        return "\n".join(
            f"Edited over MCP by {origin.removeprefix('mcp:')}: {', '.join(targets)}"
            for origin, targets in by_origin.items()
        )

    def enqueue_extraction(self, document_id: str, *, summarize: bool = True) -> str:
        return self.jobs.enqueue(
            EXTRACT_JOB, {"document_id": document_id, "summarize": summarize}
        )

    def _extract_document(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Job handler; runs in a worker thread, off the web event loop."""
        document_id = str(payload["document_id"])
        # A paper this machine knows only by its metadata is fetched first.
        self.papers.ensure_pdf(document_id)
        result = self.documents.run_extraction(document_id)
        self.documents.retry_missing_pages()
        document = self.documents.get(document_id)
        self.bus.publish(
            DOCUMENT_UPDATED,
            {"document_id": document_id, "document": document.api_json()},
        )
        if self.papers.enabled:
            # Whatever extraction made of it, the paper itself is worth keeping.
            self.jobs.enqueue(STORE_JOB, {"document_id": document_id})
        wanted = payload.get("summarize", True) and self.auto_summary
        if result.get("status") == "ok" and wanted:
            try:
                self.runner.queue_summary(document_id)
            except Exception as exc:  # noqa: BLE001 - a summary failure is not fatal
                log.info("Automatic summary for %s not queued: %s", document_id, exc)
        return result

    def _store_document(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Job handler: send a paper, and its extracted text, to storage."""
        sent = self.papers.push(str(payload["document_id"]))
        return {"sent": sent}

    def _fetch_document(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Job handler: bring a paper's text, or the paper, from storage."""
        document_id = str(payload["document_id"])
        what = str(payload.get("what") or "pages")
        if what == "pdf":
            self.papers.ensure_pdf(document_id)
        elif not self.papers.ensure_pages(document_id):
            return {"fetched": False}
        self.documents.retry_missing_pages()
        self.bus.publish(
            DOCUMENT_UPDATED,
            {"document_id": document_id, "document": self.documents.get(document_id).api_json()},
        )
        return {"fetched": True, "what": what}

    # ---------------------------------------------------------------- sync

    def sync_papers(self) -> dict[str, int]:
        """Queue whatever each paper needs, from one look at storage."""
        if not self.papers.enabled:
            return {}
        try:
            plan = self.papers.plan()
        except WorkspaceError as exc:
            self.papers.note(error=exc.message)
            raise
        self.documents.retry_missing_pages()
        for document_id in plan["push"]:
            self.jobs.enqueue(STORE_JOB, {"document_id": document_id})
        for document_id in plan["pages"]:
            self.jobs.enqueue(FETCH_JOB, {"document_id": document_id, "what": "pages"})
        for document_id in plan["pdf"]:
            self.jobs.enqueue(FETCH_JOB, {"document_id": document_id, "what": "pdf"})
        for document_id in plan["extract"]:
            # Read again here; the summary, if there is one, came through git.
            self.enqueue_extraction(document_id, summarize=False)
        self.papers.note()
        return {kind: len(ids) for kind, ids in plan.items()}

    def sync_now(self, *, resolve: str | None = None) -> dict[str, Any]:
        """Text through git, then papers through storage. Blocking; call off the loop.

        Git goes first: what it brings in is how this machine learns of papers
        imported elsewhere, and so of what to fetch.
        """
        with self._sync_lock:
            self._sync_running = True
            pulled: list[str] = []
            problems: list[str] = []
            try:
                if self.git.is_repository():
                    try:
                        report = self.git.resolve(resolve) if resolve else self.git.sync()
                        pulled = list(report.get("pulled") or [])
                    except GitError as exc:
                        problems.append(exc.message)
                    self._last_exchange = time.monotonic()
                if self.papers.enabled:
                    try:
                        self.sync_papers()
                    except WorkspaceError as exc:
                        problems.append(exc.message)
            finally:
                self._sync_running = False
            status = self.sync_status()
            # Live only: where things stand is asked for afresh on every load.
            self.bus.publish_transient(SYNC_UPDATED, {"status": status, "pulled": pulled})
            return {**status, "pulled": pulled, "problems": problems}

    def sync_status(self) -> dict[str, Any]:
        return {
            "git": self.git.status(),
            "storage": self.papers.status(),
            "running": self._sync_running,
        }

    def start_sync(self) -> None:
        """Keep the project in step with its remote and its storage, unasked."""
        if self._sync_task is not None or not (self.git.automatic or self.papers.enabled):
            return
        self._sync_task = asyncio.ensure_future(self._sync_loop())

    async def _sync_loop(self) -> None:
        loop = asyncio.get_running_loop()
        first = True
        while True:
            try:
                if first or await loop.run_in_executor(None, self._sync_due):
                    await loop.run_in_executor(None, self.sync_now)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - the next round tries again
                log.exception("Background sync failed")
            first = False
            await asyncio.sleep(SYNC_TICK_SECONDS)

    def _sync_due(self) -> bool:
        """Whether there is settled work to save, or news worth asking for."""
        if not self.git.automatic:
            return False
        waited = time.monotonic() - self._last_exchange
        try:
            changed = self.git.changes()
            status = self.git.status()
        except GitError:
            return waited >= self._sync_fetch
        if status.get("state") == "conflict":
            return False  # Waiting on a decision, not on a timer.
        if changed:
            # Not in the middle of a sentence: wait until the edits have settled.
            newest = 0.0
            for _, path in changed:
                with contextlib.suppress(OSError):
                    newest = max(newest, (self.workspace.root / path).stat().st_mtime)
            return time.time() - newest >= self._sync_quiet
        if status.get("ahead") and status.get("remote"):
            return True
        return bool(status.get("remote")) and waited >= self._sync_fetch

    # -------------------------------------------------------- bibliography

    def bibliography(self, *, cited_only: bool = False) -> Bibliography:
        """Build the BibTeX view of the project's documents and references."""
        return build_bibliography(
            self.documents.list(),
            self.references.all(),
            citations_by_reference(self.workspace, self.documents),
            cited_only=cited_only,
        )

    def write_bibliography(self, *, cited_only: bool = False) -> dict[str, Any]:
        """Write ``references.bib`` into the project directory.

        The generated text is deterministic, so regenerating an unchanged
        bibliography rewrites nothing. When it has changed, any previous file —
        including one edited by hand — is snapshotted first.
        """
        bibliography = self.bibliography(cited_only=cited_only)
        text = bibliography.to_bibtex()
        path = self.workspace.resolve_inside(self.workspace.bibliography_file)
        current = path.read_text("utf-8") if path.is_file() else None
        changed = current != text
        if changed:
            if current is not None:
                self.workspace.snapshot(path, reason="bibliography")
            atomic_write_text(path, text)
        return {
            "path": path.name,
            "entries": len(bibliography.entries),
            "written": changed,
            "warnings": bibliography.warnings,
        }

    # -------------------------------------------------------------- status

    def agent_availability(self) -> Availability:
        return self.backend.availability()

    def project_state(self) -> dict[str, Any]:
        settings = self.workspace.settings()
        documents = []
        for document in self.documents.list():
            summary = self.documents.summary_text(document.document_id)
            documents.append(document.api_json(summary_text=summary))
        return {
            "project": {
                "name": settings.get("name", self.workspace.root.name),
                "root": str(self.workspace.root),
                "schema_version": settings.get("schema_version", 1),
            },
            "agent": self.agent_availability().to_json(),
            "settings": {"downloads": downloads.mode_of(settings)},
            "documents": documents,
            "tags": self.documents.all_tags(),
            "notes": [note.to_json(include_text=False) for note in self.workspace.list_notes()],
            "conversations": self.runner.list_conversations(),
            "latest_seq": self.db.latest_seq(),
        }


def open_services(root: Path, *, backend_name: str | None = None) -> Services:
    workspace = Workspace(root).open()
    return Services(workspace, backend_name=backend_name)
