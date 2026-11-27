"""Project directory layout, safe path handling, and atomic file writes.

Everything the user owns is an ordinary file in a movable project directory.
SQLite under ``.research/`` holds operational state only.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
import threading
import tomllib
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from .errors import InvalidInput, NotFound, PathEscape, ProjectExists, RevisionConflict

SCHEMA_VERSION = 1

PROJECT_FILE = "project.toml"
DOCUMENTS_DIR = "documents"
NOTES_DIR = "notes"
REFERENCES_FILE = "references.json"
BIBLIOGRAPHY_FILE = "references.bib"
STATE_DIR = ".research"
HISTORY_DIR = f"{STATE_DIR}/history"
RUNS_DIR = f"{STATE_DIR}/runs"
DB_FILE = f"{STATE_DIR}/state.sqlite"

_SLUG_RE = re.compile(r"[^a-z0-9]+")


def utcnow() -> str:
    """Timestamps are stored as UTC ISO-8601 strings with a trailing ``Z``."""
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_text(text: str) -> str:
    return sha256_bytes(text.encode("utf-8"))


def revision_of(text: str) -> str:
    """A note's revision is the SHA-256 of its exact UTF-8 bytes."""
    return sha256_text(text)


def slugify(value: str, *, fallback: str = "untitled") -> str:
    slug = _SLUG_RE.sub("-", value.strip().lower()).strip("-")
    return slug[:60] or fallback


@dataclass(frozen=True)
class NoteFile:
    note_id: str
    path: Path
    title: str
    text: str
    revision: str
    modified_at: str

    def to_json(self, *, include_text: bool = True) -> dict[str, object]:
        payload: dict[str, object] = {
            "note_id": self.note_id,
            "title": self.title,
            "revision": self.revision,
            "modified_at": self.modified_at,
        }
        if include_text:
            payload["text"] = self.text
        return payload


def atomic_write_bytes(path: Path, data: bytes) -> None:
    """Write ``data`` to ``path`` via a temporary file and ``os.replace``.

    The directory entry is fsynced too, so a crash leaves either the old file
    or the new one, never a truncated mixture.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-", suffix=path.suffix)
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    dir_fd = os.open(str(path.parent), os.O_RDONLY)
    try:
        os.fsync(dir_fd)
    except OSError:
        # Not every filesystem supports directory fsync; the replace still held.
        pass
    finally:
        os.close(dir_fd)


def atomic_write_text(path: Path, text: str) -> None:
    atomic_write_bytes(path, text.encode("utf-8"))


class Workspace:
    """A single project directory.

    One server process serves one workspace. Write locks are per note path and
    guard the read-check-replace sequence used for version-checked saves.
    """

    def __init__(self, root: Path) -> None:
        self.root = root.expanduser().resolve()
        self._locks: dict[str, threading.RLock] = {}
        self._locks_guard = threading.Lock()

    # ---------------------------------------------------------------- layout

    @property
    def project_file(self) -> Path:
        return self.root / PROJECT_FILE

    @property
    def documents_dir(self) -> Path:
        return self.root / DOCUMENTS_DIR

    @property
    def notes_dir(self) -> Path:
        return self.root / NOTES_DIR

    @property
    def references_file(self) -> Path:
        return self.root / REFERENCES_FILE

    @property
    def bibliography_file(self) -> Path:
        """The generated BibTeX file; regenerated, but an ordinary project file."""
        return self.root / BIBLIOGRAPHY_FILE

    @property
    def state_dir(self) -> Path:
        return self.root / STATE_DIR

    @property
    def history_dir(self) -> Path:
        return self.root / HISTORY_DIR

    @property
    def runs_dir(self) -> Path:
        return self.root / RUNS_DIR

    @property
    def db_path(self) -> Path:
        return self.root / DB_FILE

    def document_dir(self, document_id: str) -> Path:
        return self.documents_dir / self._safe_component(document_id)

    def note_path(self, note_id: str) -> Path:
        return self.notes_dir / f"{self._safe_component(note_id)}.md"

    # ------------------------------------------------------------ lifecycle

    def exists(self) -> bool:
        return self.project_file.is_file()

    @classmethod
    def initialize(
        cls, root: Path, *, name: str | None = None, extra_settings: str = ""
    ) -> Workspace:
        """Create a project directory. Never overwrites existing material."""
        workspace = cls(root)
        if workspace.project_file.exists():
            raise ProjectExists(
                f"{workspace.project_file} already exists; open it with `serve` instead.",
                path=str(workspace.root),
            )
        workspace.root.mkdir(parents=True, exist_ok=True)
        workspace._ensure_dirs()
        project_name = name or workspace.root.name
        atomic_write_text(
            workspace.project_file,
            "# Litmark project settings (no secrets belong here).\n"
            f'schema_version = {SCHEMA_VERSION}\n'
            f'name = "{project_name}"\n'
            f'created_at = "{utcnow()}"\n'
            "\n"
            "[ingestion]\n"
            "max_upload_mb = 64\n"
            "\n"
            "[agent]\n"
            'backend = "claude"\n'
            "auto_summary = true\n"
            # Non-secret settings chosen at creation, such as where papers are stored.
            + (f"\n{extra_settings}" if extra_settings else ""),
        )
        if not workspace.references_file.exists():
            atomic_write_text(
                workspace.references_file,
                '{\n  "schema_version": 1,\n  "references": {}\n}\n',
            )
        welcome = workspace.notes_dir / "welcome.md"
        if not welcome.exists():
            atomic_write_text(welcome, _WELCOME_NOTE)
        return workspace

    def open(self) -> Workspace:
        """Open an existing project, tolerating a directory created by hand."""
        if not self.root.is_dir():
            raise NotFound(f"No such project directory: {self.root}", path=str(self.root))
        if not self.project_file.is_file():
            raise NotFound(
                f"{self.root} is not a Litmark project "
                f"(missing {PROJECT_FILE}). Run `litmark init` first.",
                path=str(self.root),
            )
        self._ensure_dirs()
        if not self.references_file.exists():
            atomic_write_text(
                self.references_file, '{\n  "schema_version": 1,\n  "references": {}\n}\n'
            )
        return self

    def _ensure_dirs(self) -> None:
        for path in (
            self.documents_dir,
            self.notes_dir,
            self.state_dir,
            self.history_dir,
            self.runs_dir,
        ):
            path.mkdir(parents=True, exist_ok=True)
        gitignore = self.state_dir / ".gitignore"
        if not gitignore.exists():
            atomic_write_text(gitignore, "# Operational state; safe to delete when the app is closed.\n*\n")

    def settings(self) -> dict[str, object]:
        if not self.project_file.is_file():
            return {}
        with self.project_file.open("rb") as handle:
            return tomllib.load(handle)

    def set_setting(self, table: str, key: str, value: str) -> None:
        """Set one string setting in project.toml, leaving the rest as written.

        The file is the reader's, with their comments and order, so it is
        edited in place rather than written out again from what was parsed.
        """
        if not re.fullmatch(r"[A-Za-z0-9_]+", table) or not re.fullmatch(r"[A-Za-z0-9_]+", key):
            raise InvalidInput("A setting is named by plain words.")
        line = f"{key} = {json.dumps(value)}"
        with self._lock_for(PROJECT_FILE):
            text = self.project_file.read_text(encoding="utf-8") if self.project_file.is_file() else ""
            lines = text.splitlines()
            header = next(
                (i for i, item in enumerate(lines) if re.fullmatch(rf"\[\s*{table}\s*\]\s*(#.*)?", item.strip())),
                None,
            )
            if header is None:
                if lines and lines[-1].strip():
                    lines.append("")
                lines += [f"[{table}]", line]
            else:
                end = next(
                    (i for i in range(header + 1, len(lines)) if lines[i].lstrip().startswith("[")),
                    len(lines),
                )
                existing = next(
                    (i for i in range(header + 1, end) if re.match(rf"\s*{key}\s*=", lines[i])),
                    None,
                )
                if existing is not None:
                    lines[existing] = line
                else:
                    # After the table's last setting, before the blank lines that close it.
                    at = end
                    while at > header + 1 and not lines[at - 1].strip():
                        at -= 1
                    lines.insert(at, line)
            updated = "\n".join(lines) + "\n"
            tomllib.loads(updated)  # never leave a file that cannot be read
            atomic_write_text(self.project_file, updated)

    # ----------------------------------------------------------- path safety

    @staticmethod
    def _safe_component(value: str) -> str:
        """Reject anything that is not a single, ordinary path component."""
        if not value or value in {".", ".."}:
            raise InvalidInput(f"Invalid identifier: {value!r}")
        if "/" in value or "\\" in value or "\x00" in value:
            raise InvalidInput(f"Invalid identifier: {value!r}")
        if value.startswith("."):
            raise InvalidInput(f"Invalid identifier: {value!r}")
        return value

    def resolve_inside(self, path: Path | str) -> Path:
        """Resolve ``path`` and confirm it stays inside the project directory.

        ``Path.resolve`` follows symlinks, so a link pointing out of the project
        is caught here rather than at read time.
        """
        candidate = Path(path)
        if not candidate.is_absolute():
            candidate = self.root / candidate
        resolved = candidate.resolve()
        root = self.root.resolve()
        if resolved != root and root not in resolved.parents:
            raise PathEscape(
                "Path resolves outside the project directory.",
                path=str(path),
            )
        return resolved

    def _lock_for(self, key: str) -> threading.RLock:
        with self._locks_guard:
            lock = self._locks.get(key)
            if lock is None:
                lock = threading.RLock()
                self._locks[key] = lock
            return lock

    # ---------------------------------------------------------------- notes

    def list_notes(self) -> list[NoteFile]:
        notes: list[NoteFile] = []
        if not self.notes_dir.is_dir():
            return notes
        for path in sorted(self.notes_dir.glob("*.md")):
            if path.is_symlink():
                try:
                    self.resolve_inside(path)
                except PathEscape:
                    continue
            notes.append(self._read_note_path(path))
        return notes

    def note_exists(self, note_id: str) -> bool:
        return self.note_path(note_id).is_file()

    def read_note(self, note_id: str) -> NoteFile:
        path = self.resolve_inside(self.note_path(note_id))
        if not path.is_file():
            raise NotFound(f"No note named {note_id!r}.", note_id=note_id)
        return self._read_note_path(path)

    def _read_note_path(self, path: Path) -> NoteFile:
        text = path.read_text(encoding="utf-8")
        stat = path.stat()
        return NoteFile(
            note_id=path.stem,
            path=path,
            title=note_title(text, fallback=path.stem),
            text=text,
            revision=revision_of(text),
            modified_at=datetime.fromtimestamp(stat.st_mtime, UTC)
            .isoformat(timespec="seconds")
            .replace("+00:00", "Z"),
        )

    def unique_note_id(self, title: str) -> str:
        base = slugify(title, fallback="note")
        candidate = base
        suffix = 2
        while self.note_path(candidate).exists():
            candidate = f"{base}-{suffix}"
            suffix += 1
        return candidate

    def create_note(self, *, title: str, text: str | None = None) -> NoteFile:
        note_id = self.unique_note_id(title)
        body = text if text is not None else f"# {title.strip() or note_id}\n\n"
        path = self.resolve_inside(self.note_path(note_id))
        with self._lock_for(str(path)):
            if path.exists():  # Lost a race; pick a fresh identifier.
                note_id = self.unique_note_id(title)
                path = self.resolve_inside(self.note_path(note_id))
            atomic_write_text(path, body)
        return self._read_note_path(path)

    def write_note(
        self,
        note_id: str,
        text: str,
        *,
        expected_revision: str | None,
        create: bool = False,
        snapshot_reason: str = "edit",
    ) -> NoteFile:
        """Version-checked save.

        ``expected_revision`` is the revision the writer last read. ``None``
        means "must not exist yet". The check and the replace happen under the
        same per-path lock.
        """
        path = self.resolve_inside(self.note_path(note_id))
        with self._lock_for(str(path)):
            current: str | None = None
            current_revision: str | None = None
            if path.is_file():
                current = path.read_text(encoding="utf-8")
                current_revision = revision_of(current)
            elif not create and expected_revision is not None:
                raise NotFound(f"No note named {note_id!r}.", note_id=note_id)

            if current_revision != expected_revision:
                raise RevisionConflict(
                    "This note changed since it was read.",
                    expected_revision=expected_revision,
                    actual_revision=current_revision,
                    current_text=current,
                    proposed_text=text,
                )
            if current is not None and current != text:
                self.snapshot(path, reason=snapshot_reason)
            if current != text:
                # Unchanged text is left as it lies: a rewrite would make the
                # file look edited to everything that goes by its timestamp.
                atomic_write_text(path, text)
            return self._read_note_path(path)

    def delete_note(self, note_id: str, *, expected_revision: str | None = None) -> None:
        path = self.resolve_inside(self.note_path(note_id))
        with self._lock_for(str(path)):
            if not path.is_file():
                raise NotFound(f"No note named {note_id!r}.", note_id=note_id)
            current = path.read_text(encoding="utf-8")
            if expected_revision is not None and revision_of(current) != expected_revision:
                raise RevisionConflict(
                    "This note changed since it was read.",
                    expected_revision=expected_revision,
                    actual_revision=revision_of(current),
                    current_text=current,
                )
            self.snapshot(path, reason="delete")
            path.unlink()

    # --------------------------------------------- generic versioned writes

    def write_versioned(
        self,
        path: Path,
        text: str,
        *,
        expected_revision: str | None,
        snapshot_reason: str = "edit",
        snapshot: bool = True,
    ) -> tuple[str, str | None]:
        """Version-checked write of any project file.

        Returns ``(new_revision, previous_revision)``. Used for note saves and
        for summaries, which follow the same conflict rules.

        ``snapshot=False`` leaves ``.research/history/`` alone, for a file that
        is saved every few seconds while it is worked on — ink on a paper —
        and whose record is the project's git history.
        """
        resolved = self.resolve_inside(path)
        with self._lock_for(str(resolved)):
            current: str | None = None
            current_revision: str | None = None
            if resolved.is_file():
                current = resolved.read_text(encoding="utf-8")
                current_revision = revision_of(current)
            if current_revision != expected_revision:
                raise RevisionConflict(
                    "This file changed since it was read.",
                    expected_revision=expected_revision,
                    actual_revision=current_revision,
                    current_text=current,
                    proposed_text=text,
                )
            if snapshot and current is not None and current != text:
                self.snapshot(resolved, reason=snapshot_reason)
            atomic_write_text(resolved, text)
            return revision_of(text), current_revision

    # -------------------------------------------------------------- history

    def snapshot(self, path: Path, *, reason: str) -> Path:
        """Copy a file into ``.research/history/`` before it is replaced."""
        resolved = self.resolve_inside(path)
        relative = resolved.relative_to(self.root)
        stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
        safe_name = str(relative).replace(os.sep, "__")
        target = self.history_dir / f"{stamp}-{reason}-{safe_name}"
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(resolved, target)
        return target

    def iter_history(self, relative_path: str) -> Iterator[Path]:
        safe_name = relative_path.replace(os.sep, "__")
        yield from sorted(self.history_dir.glob(f"*-{safe_name}"), reverse=True)


def note_title(text: str, *, fallback: str) -> str:
    """The first ATX heading is the display title; otherwise the file stem."""
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            candidate = stripped.lstrip("#").strip()
            if candidate:
                return candidate
        if stripped:
            break
    return fallback


_WELCOME_NOTE = """# Welcome

This is an ordinary Markdown file in `notes/`. Edit it here or in any other
editor — the file on disk is always the authoritative copy.

## Getting started

1. Drag one or more PDFs onto the sidebar to import them.
2. Open a document to read it, and select a passage to insert a reference.
3. Ask the chat agent to summarize or compare papers and write the result here.

A citation is an ordinary Markdown link whose destination names a registered
reference:

```markdown
The identification argument relies on a mobility restriction.
[Assumption 2, p. 12](source:ref-001)
```

Shown as code on purpose: a live example link would point at whichever
reference happens to be allocated `ref-001`, which is not this one. Real
citations are created for you when you insert a reference from a PDF selection,
or when the agent resolves a quotation. Click one and choose "Open source" — or
Cmd/Ctrl-click it — to open the cited page with its passage highlighted.
"""
