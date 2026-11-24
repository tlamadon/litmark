"""Keeping a project's papers in step with its storage.

Git carries each paper's ``metadata.json`` — its title, its hash — to every
copy of the project. The bytes follow through here: a paper imported on this
machine is sent to storage, and a paper this machine only knows by its metadata
is fetched when it is wanted.

What is fetched, and when:

- **Extracted text** for every paper, as soon as the project opens. Search and
  the agent's reading work across the whole library, so they need all of it;
  it is small, and fetching it is far cheaper than extracting again.
- **The PDF** when someone opens the paper, or when the text is not in storage
  and has to be extracted afresh. A library of a few hundred papers need not
  be downloaded to read three of them; ``prefetch`` asks for all of it anyway.

Every download is checked against the hash it was asked for by.
"""

from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Any

from .documents import OK, DocumentStore
from .errors import NotFound
from .extraction import EXTRACTION_VERSION
from .storage import BlobStore, StorageError, pages_key, pdf_key, sha256_file
from .workspace import Workspace, utcnow

log = logging.getLogger(__name__)


class PaperSync:
    def __init__(
        self,
        workspace: Workspace,
        documents: DocumentStore,
        store: BlobStore | None,
        *,
        problem: str | None = None,
        prefetch: bool = False,
    ) -> None:
        self._workspace = workspace
        self._documents = documents
        self.store = store
        self.prefetch = prefetch
        # Why there is no store, when the settings asked for one.
        self.problem = problem
        self._fetching: dict[str, threading.Lock] = {}
        self._guard = threading.Lock()
        self._last: dict[str, Any] = {"synced_at": None, "error": None}

    @property
    def enabled(self) -> bool:
        return self.store is not None

    # ------------------------------------------------------------- locally

    def has_pdf(self, document_id: str) -> bool:
        return self._documents.pdf_path(document_id).is_file()

    def has_pages(self, document_id: str) -> bool:
        return self._documents.pages_path(document_id).is_file()

    def _lock_for(self, document_id: str) -> threading.Lock:
        with self._guard:
            return self._fetching.setdefault(document_id, threading.Lock())

    # ---------------------------------------------------------------- send

    def push(self, document_id: str) -> dict[str, bool]:
        """Send what this machine has of a paper and storage does not."""
        sent = {"pdf": False, "pages": False}
        if self.store is None:
            return sent
        document = self._documents.get(document_id)
        pdf = self._documents.pdf_path(document_id)
        if pdf.is_file():
            sent["pdf"] = self.store.put_file(pdf_key(document.sha256), pdf)
        pages = self._documents.pages_path(document_id)
        if pages.is_file() and document.extraction.get("status") == OK:
            version = document.extraction.get("version") or EXTRACTION_VERSION
            sent["pages"] = self.store.put_gzipped(pages_key(document.sha256, version), pages)
        return sent

    # --------------------------------------------------------------- fetch

    def ensure_pdf(self, document_id: str) -> Path:
        """The paper's PDF on this machine, fetched if it was not here."""
        document = self._documents.get(document_id)
        path = self._workspace.resolve_inside(self._documents.pdf_path(document_id))
        if path.is_file():
            return path
        if self.store is None:
            raise NotFound(
                f"The PDF of {document.display_title!r} is not on this machine, and "
                "the project has no storage to fetch it from."
                + (f" ({self.problem})" if self.problem else ""),
                document_id=document_id,
            )
        with self._lock_for(document_id):
            if path.is_file():  # Another request fetched it while this one waited.
                return path
            if not self.store.get_file(pdf_key(document.sha256), path):
                raise NotFound(
                    f"The PDF of {document.display_title!r} is neither on this machine "
                    f"nor in {self.store.describe()}. It was imported somewhere that "
                    "has not synced yet.",
                    document_id=document_id,
                )
            actual = sha256_file(path)
            if actual != document.sha256:
                path.unlink(missing_ok=True)
                raise StorageError(
                    f"The copy of {document.display_title!r} in {self.store.describe()} "
                    "does not match its recorded hash, so it was not kept."
                )
        return path

    def ensure_pages(self, document_id: str) -> bool:
        """Fetch a paper's extracted text. False when storage has none to give."""
        if self.has_pages(document_id):
            return True
        if self.store is None:
            return False
        document = self._documents.get(document_id)
        if document.extraction.get("status") != OK:
            return False
        version = document.extraction.get("version") or EXTRACTION_VERSION
        path = self._workspace.resolve_inside(self._documents.pages_path(document_id))
        with self._lock_for(document_id):
            if path.is_file():
                return True
            return self.store.get_gunzipped(pages_key(document.sha256, version), path)

    # ------------------------------------------------------------ the plan

    def plan(self) -> dict[str, list[str]]:
        """What each paper needs, from one listing of storage."""
        needs: dict[str, list[str]] = {"push": [], "pages": [], "pdf": [], "extract": []}
        if self.store is None:
            return needs
        stored = set(self.store.keys())
        for document in self._documents.list():
            document_id = document.document_id
            extracted = document.extraction.get("status") == OK
            version = document.extraction.get("version") or EXTRACTION_VERSION
            remote_pdf = pdf_key(document.sha256) in stored
            remote_pages = pages_key(document.sha256, version) in stored
            local_pdf = self.has_pdf(document_id)
            local_pages = self.has_pages(document_id)

            if (local_pdf and not remote_pdf) or (local_pages and extracted and not remote_pages):
                needs["push"].append(document_id)
            if extracted and not local_pages:
                if remote_pages:
                    needs["pages"].append(document_id)
                elif local_pdf or remote_pdf:
                    # The text was never stored: read the paper again.
                    needs["extract"].append(document_id)
            if not local_pdf and remote_pdf and self.prefetch:
                needs["pdf"].append(document_id)
        return needs

    def note(self, *, error: str | None = None) -> None:
        self._last = {"synced_at": utcnow() if error is None else self._last["synced_at"], "error": error}

    def status(self) -> dict[str, Any]:
        """What is here, without touching the network."""
        documents = self._documents.list()
        return {
            "enabled": self.enabled,
            "backend": self.store.name if self.store else None,
            "where": self.store.describe() if self.store else None,
            "problem": self.problem,
            "prefetch": self.prefetch,
            "documents": len(documents),
            "pdfs_here": sum(1 for d in documents if self.has_pdf(d.document_id)),
            "synced_at": self._last["synced_at"],
            "error": self._last["error"],
        }
