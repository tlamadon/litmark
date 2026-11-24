"""Git for the text of a project, driven by the application.

Notes, summaries, the reference registry and each paper's metadata are small
text files; git is how they are versioned and how they reach another machine.
The user is not asked to commit: the application commits what changed, brings
in what the remote has, and publishes — on a timer and when asked.

The rules it keeps:

- It only ever acts on a repository whose top level *is* the project directory.
  A project that merely sits inside some other repository is left alone, so
  this can never commit into a codebase that happens to contain it.
- Local work is committed before anything is fetched, so nothing uncommitted is
  ever in the way of, or at risk from, incoming changes.
- Incoming changes are replayed under local commits (a rebase). When the two
  sides changed the same lines it stops, puts everything back as it was,
  publishes the local commits to a side branch so they exist somewhere other
  than this disk, and waits to be told which side to keep.
- Nothing runs through a shell, and network commands run with prompting off, so
  a missing credential fails in seconds instead of waiting on a prompt no one
  can see.
"""

from __future__ import annotations

import base64
import logging
import os
import re
import socket
import subprocess
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .errors import WorkspaceError
from .workspace import atomic_write_text, utcnow

log = logging.getLogger(__name__)

LOCAL_TIMEOUT = 30
NETWORK_TIMEOUT = 120
DEFAULT_BRANCH = "main"
REMOTE = "origin"
UNMERGED_PREFIX = "litmark-unmerged"
TOKEN_ENV = "LITMARK_GIT_TOKEN"

# Prompting off: without this a push needing credentials blocks on a terminal
# prompt that a browser user, or a container, will never see.
NON_INTERACTIVE = {
    "GIT_TERMINAL_PROMPT": "0",
    "GIT_ASKPASS": "",
    "SSH_ASKPASS": "",
    "SSH_ASKPASS_REQUIRE": "never",
}

IGNORE_HEADER = "# Litmark: kept out of git."
IGNORE_ALWAYS = (
    "# Operational state and extracted text are rebuilt, not versioned.",
    ".research/",
    "documents/*/pages.json",
)
IGNORE_STORED = (
    "# Papers live in the project's storage, addressed by the hash in metadata.json.",
    "documents/*/original.pdf",
)


class GitError(WorkspaceError):
    """A git command failed; the message is meant to be shown to the user."""

    code = "git_failed"
    status_code = 502


class GitSync:
    """Commit, fetch, replay, publish — for one project directory."""

    def __init__(
        self,
        root: Path,
        settings: dict[str, Any] | None = None,
        *,
        papers_in_storage: bool = False,
    ) -> None:
        self.root = root
        table = (settings or {}).get("git")
        self.settings: dict[str, Any] = dict(table) if isinstance(table, dict) else {}
        self.papers_in_storage = papers_in_storage
        self._lock = threading.Lock()
        self._has_identity: bool | None = None
        self._last: dict[str, Any] = {"synced_at": None, "error": None, "conflict": None}
        # Asked for lines to add to a commit's message, when one is about to be
        # made: the application's account of who wrote what is in it.
        self.annotate: Callable[[], str] | None = None

    # ------------------------------------------------------------ plumbing

    def _env(self, *, network: bool) -> dict[str, str]:
        env = dict(os.environ)
        # Configuration by environment: nothing is written to the repository's
        # config, and a token never appears on a command line or in a file.
        config: list[tuple[str, str]] = [
            # A mounted volume often belongs to another user than the process.
            ("safe.directory", str(self.root)),
            ("core.quotepath", "false"),
        ]
        if self._has_identity is None:
            self._has_identity = self._configured("user.email", env)
        if not self._has_identity:
            env.setdefault("GIT_AUTHOR_NAME", str(self.settings.get("author_name") or "Litmark"))
            env.setdefault(
                "GIT_AUTHOR_EMAIL", str(self.settings.get("author_email") or "litmark@localhost")
            )
            env.setdefault("GIT_COMMITTER_NAME", env["GIT_AUTHOR_NAME"])
            env.setdefault("GIT_COMMITTER_EMAIL", env["GIT_AUTHOR_EMAIL"])
        if network:
            env.update(NON_INTERACTIVE)
            env.setdefault("GIT_SSH_COMMAND", "ssh -oBatchMode=yes -oStrictHostKeyChecking=accept-new")
            token = env.get(TOKEN_ENV)
            if token:
                basic = base64.b64encode(f"x-access-token:{token}".encode()).decode()
                config.append(("http.extraHeader", f"Authorization: Basic {basic}"))
        env["GIT_CONFIG_COUNT"] = str(len(config))
        for index, (key, value) in enumerate(config):
            env[f"GIT_CONFIG_KEY_{index}"] = key
            env[f"GIT_CONFIG_VALUE_{index}"] = value
        return env

    def _configured(self, key: str, env: dict[str, str]) -> bool:
        if key == "user.email" and env.get("GIT_AUTHOR_EMAIL"):
            return True
        try:
            result = subprocess.run(  # noqa: S603 - argv list, no shell
                ["git", "config", "--get", key],
                cwd=self.root,
                capture_output=True,
                text=True,
                timeout=LOCAL_TIMEOUT,
            )
        except (OSError, subprocess.TimeoutExpired):
            return False
        return result.returncode == 0 and bool(result.stdout.strip())

    def _run(
        self,
        *args: str,
        network: bool = False,
        check: bool = True,
        cwd: Path | None = None,
    ) -> subprocess.CompletedProcess[str]:
        timeout = NETWORK_TIMEOUT if network else LOCAL_TIMEOUT
        try:
            result = subprocess.run(  # noqa: S603 - argv list, no shell
                ["git", *args],
                cwd=cwd or self.root,
                capture_output=True,
                text=True,
                timeout=timeout,
                env=self._env(network=network),
            )
        except FileNotFoundError as exc:
            raise GitError("git is not installed, or not on PATH.") from exc
        except subprocess.TimeoutExpired as exc:
            raise GitError(
                f"git {args[0]} did not finish in {timeout}s. If the remote needs a "
                f"credential, set {TOKEN_ENV} or mount an SSH key."
            ) from exc
        if check and result.returncode != 0:
            raise GitError(_message(result))
        return result

    # --------------------------------------------------------------- state

    def is_repository(self) -> bool:
        """True only when the project directory is itself the repository."""
        return (self.root / ".git").exists()

    def availability(self) -> tuple[bool, str | None]:
        if not self.is_repository():
            inside = None
            try:
                found = subprocess.run(  # noqa: S603
                    ["git", "rev-parse", "--show-toplevel"],
                    cwd=self.root,
                    capture_output=True,
                    text=True,
                    timeout=LOCAL_TIMEOUT,
                )
                if found.returncode == 0:
                    inside = found.stdout.strip()
            except (OSError, subprocess.TimeoutExpired):
                return False, "git is not installed."
            if inside:
                return False, (
                    f"This project sits inside another repository ({inside}); "
                    "its history is left to you."
                )
            return False, "This project is not a git repository yet."
        if self.settings.get("auto_sync") is False:
            return True, "Automatic sync is turned off in project.toml."
        return True, None

    @property
    def automatic(self) -> bool:
        return self.is_repository() and self.settings.get("auto_sync") is not False

    @property
    def branch(self) -> str:
        configured = str(self.settings.get("branch") or "").strip()
        if configured:
            return configured
        if self.is_repository():
            current = self._run("symbolic-ref", "--short", "-q", "HEAD", check=False).stdout.strip()
            if current:
                return current
        return DEFAULT_BRANCH

    def remote_url(self) -> str | None:
        if not self.is_repository():
            return None
        url = self._run("remote", "get-url", REMOTE, check=False).stdout.strip()
        return url or None

    def changes(self) -> list[tuple[str, str]]:
        """Uncommitted paths as ``(state, path)``: what the next commit would hold."""
        result = self._run("status", "--porcelain=v1", "-z", "--untracked-files=all")
        entries = [entry for entry in result.stdout.split("\0") if entry]
        out: list[tuple[str, str]] = []
        skip = False
        for entry in entries:
            if skip:  # The old name of a rename follows its new one.
                skip = False
                continue
            code, path = entry[:2], entry[3:]
            if "R" in code or "C" in code:
                skip = True
            state = "added" if "?" in code or "A" in code else "deleted" if "D" in code else "edited"
            out.append((state, path))
        return out

    def _counts(self) -> tuple[int, int]:
        """Commits here that the remote lacks, and the reverse, as last fetched."""
        tracking = f"{REMOTE}/{self.branch}"
        if self._run("rev-parse", "--verify", "-q", tracking, check=False).returncode != 0:
            head = self._run("rev-list", "--count", "HEAD", check=False)
            return (int(head.stdout.strip() or 0) if head.returncode == 0 else 0), 0
        result = self._run("rev-list", "--left-right", "--count", f"HEAD...{tracking}", check=False)
        if result.returncode != 0:
            return 0, 0
        ahead, behind = (result.stdout.split() + ["0", "0"])[:2]
        return int(ahead), int(behind)

    def status(self) -> dict[str, Any]:
        """Where the text stands, without touching the network."""
        usable, reason = self.availability()
        if not self.is_repository():
            return {"enabled": False, "state": "off", "message": reason}
        try:
            dirty = self.changes()
            ahead, behind = self._counts()
            remote = self.remote_url()
            head = self._run("log", "-1", "--format=%h%x00%s%x00%cI", check=False).stdout.strip()
        except GitError as exc:
            return {"enabled": True, "state": "error", "message": exc.message}
        sha, subject, when = (head.split("\0") + ["", "", ""])[:3]
        conflict = self._last.get("conflict")
        error = self._last.get("error")
        if conflict:
            state, message = "conflict", conflict["message"]
        elif error:
            state, message = "error", error
        elif dirty:
            state, message = "dirty", f"{len(dirty)} change{'s' if len(dirty) != 1 else ''} to save"
        elif remote and ahead:
            state, message = "ahead", f"{ahead} commit{'s' if ahead != 1 else ''} to publish"
        elif remote and behind:
            state, message = "behind", f"{behind} commit{'s' if behind != 1 else ''} to bring in"
        elif not remote:
            state, message = "local", "Saved in git here; no remote to publish to"
        else:
            state, message = "synced", "Up to date"
        return {
            "enabled": usable,
            "automatic": self.automatic,
            "state": state,
            "message": message if reason is None or state in {"conflict", "error"} else reason,
            "branch": self.branch,
            "remote": _without_credentials(remote),
            "dirty": len(dirty),
            "ahead": ahead,
            "behind": behind,
            "conflict": conflict,
            "last_commit": {"sha": sha, "subject": subject, "committed_at": when} if sha else None,
            "synced_at": self._last.get("synced_at"),
        }

    # --------------------------------------------------------------- setup

    def ensure_ignore(self) -> bool:
        """Keep rebuildable and stored files out of git. True when the file changed."""
        path = self.root / ".gitignore"
        current = path.read_text("utf-8") if path.is_file() else ""
        present = {line.strip() for line in current.splitlines()}
        wanted = list(IGNORE_ALWAYS) + (list(IGNORE_STORED) if self.papers_in_storage else [])
        missing = [line for line in wanted if not line.startswith("#") and line not in present]
        if not missing:
            return False
        block = [IGNORE_HEADER] if IGNORE_HEADER not in present else []
        pending_comment = ""
        for line in wanted:
            # A comment travels with the rule it explains.
            if line.startswith("#"):
                pending_comment = line
                continue
            if line in missing:
                block.extend([pending_comment, line])
        text = current
        if text and not text.endswith("\n"):
            text += "\n"
        if text:
            text += "\n"
        atomic_write_text(path, text + "\n".join(block) + "\n")
        return True

    def init(self, remote: str | None = None) -> None:
        """Make the project a repository, with a first commit of what is there."""
        if not self.is_repository():
            self._run("init", "--initial-branch", self.branch)
        if remote:
            if self.remote_url():
                self._run("remote", "set-url", REMOTE, remote)
            else:
                self._run("remote", "add", REMOTE, remote)
        self.ensure_ignore()
        self.commit()

    # -------------------------------------------------------------- commit

    def commit(self, message: str | None = None) -> str | None:
        """Commit everything that changed. None when nothing had."""
        self.ensure_ignore()
        changed = self.changes()
        if not changed:
            return None
        self._run("add", "-A")
        if self._run("diff", "--cached", "--quiet", check=False).returncode == 0:
            return None
        text = message or describe_changes(changed)
        if self.annotate is not None:
            try:
                extra = self.annotate().strip()
            except Exception:  # noqa: BLE001 - the commit matters more than its footnote
                log.exception("Could not annotate the commit")
                extra = ""
            if extra:
                text = f"{text.rstrip()}\n\n{extra}\n"
        self._run("commit", "-m", text)
        return self._run("rev-parse", "--short", "HEAD").stdout.strip()

    # ---------------------------------------------------------------- sync

    def sync(self) -> dict[str, Any]:
        """Commit, bring in the remote's work, publish. One at a time."""
        if not self.is_repository():
            raise GitError(self.availability()[1] or "This project is not a git repository.")
        with self._lock:
            report: dict[str, Any] = {"committed": None, "pulled": [], "pushed": False}
            try:
                self._abandon_stale_operation()
                report["committed"] = self.commit()
                if self.remote_url():
                    self._exchange(report)
                self._last.update(error=None, synced_at=utcnow())
                if not report.get("conflict"):
                    self._last["conflict"] = None
            except GitError as exc:
                self._last["error"] = exc.message
                raise
            return report

    def _abandon_stale_operation(self) -> None:
        """A rebase or merge left half-done by a crash is put back, not built on."""
        git_dir = self.root / ".git"
        if (git_dir / "rebase-merge").exists() or (git_dir / "rebase-apply").exists():
            self._run("rebase", "--abort", check=False)
        if (git_dir / "MERGE_HEAD").exists():
            self._run("merge", "--abort", check=False)

    def _exchange(self, report: dict[str, Any]) -> None:
        branch = self.branch
        tracking = f"{REMOTE}/{branch}"
        fetched = self._run("fetch", "--prune", REMOTE, network=True, check=False)
        if fetched.returncode != 0:
            raise GitError(f"Could not reach the remote: {_message(fetched)}")

        remote_has_branch = (
            self._run("rev-parse", "--verify", "-q", tracking, check=False).returncode == 0
        )
        has_commits = self._run("rev-parse", "--verify", "-q", "HEAD", check=False).returncode == 0
        if remote_has_branch and has_commits:
            ahead, behind = self._counts()
            if behind:
                before = self._run("rev-parse", "HEAD").stdout.strip()
                replay = self._run("rebase", tracking, check=False)
                if replay.returncode != 0:
                    files = self._unmerged()
                    self._run("rebase", "--abort", check=False)
                    report["conflict"] = self._set_aside(files)
                    return
                after = self._run("rev-parse", "HEAD").stdout.strip()
                diff = self._run("diff", "--name-only", "-z", before, after).stdout
                report["pulled"] = [path for path in diff.split("\0") if path]
        elif remote_has_branch and not has_commits:
            self._run("reset", "--hard", tracking)
            listed = self._run("ls-files", "-z").stdout
            report["pulled"] = [path for path in listed.split("\0") if path]

        ahead, _ = self._counts()
        if ahead or not remote_has_branch:
            pushed = self._run(
                "push", "--set-upstream", REMOTE, f"HEAD:refs/heads/{branch}",
                network=True, check=False,
            )
            if pushed.returncode != 0:
                # Someone published in between; the next round brings it in.
                raise GitError(f"Could not publish: {_message(pushed)}")
            self._run("fetch", REMOTE, branch, network=True, check=False)
            report["pushed"] = True

    def _unmerged(self) -> list[str]:
        listed = self._run("diff", "--name-only", "--diff-filter=U", "-z", check=False).stdout
        return sorted({path for path in listed.split("\0") if path})

    def _set_aside(self, files: list[str]) -> dict[str, Any]:
        """Record a conflict, and get the local commits off this disk."""
        side = f"{UNMERGED_PREFIX}/{_slug(socket.gethostname())}"
        saved = self._run(
            "push", "--force", REMOTE, f"HEAD:refs/heads/{side}", network=True, check=False
        )
        named = ", ".join(files[:5]) + (f" and {len(files) - 5} more" if len(files) > 5 else "")
        conflict = {
            "files": files,
            "side_branch": side if saved.returncode == 0 else None,
            "message": (
                f"This copy and the remote both changed {named or 'the same files'}. "
                "Nothing was lost and nothing was overwritten — choose which side to keep."
            ),
        }
        self._last["conflict"] = conflict
        return conflict

    def resolve(self, keep: str) -> dict[str, Any]:
        """Settle a conflict by keeping one side's version of the contested lines.

        ``keep`` is ``"mine"`` or ``"theirs"``. Either way both histories are
        kept: this is a merge, so the side not chosen is still in the log.
        """
        if keep not in {"mine", "theirs"}:
            raise GitError("Choose which side to keep: mine or theirs.")
        with self._lock:
            self._abandon_stale_operation()
            self.commit()
            tracking = f"{REMOTE}/{self.branch}"
            self._run("fetch", REMOTE, network=True)
            before = self._run("rev-parse", "HEAD").stdout.strip()
            side = "ours" if keep == "mine" else "theirs"
            label = "this copy" if keep == "mine" else "the remote"
            merged = self._run(
                "merge", "--no-edit", "-X", side,
                "-m", f"Merge the remote's changes, keeping {label} where they conflict",
                tracking, check=False,
            )
            if merged.returncode != 0:
                # What a line-level preference cannot settle: one side deleted
                # a file the other edited. Take the chosen side's whole file.
                for path in self._unmerged():
                    taken = self._run("checkout", f"--{side}", "--", path, check=False)
                    if taken.returncode != 0:
                        self._run("rm", "-q", "--", path, check=False)
                self._run("add", "-A")
                self._run("commit", "--no-edit")
            after = self._run("rev-parse", "HEAD").stdout.strip()
            diff = self._run("diff", "--name-only", "-z", before, after).stdout
            pushed = self._run(
                "push", "--set-upstream", REMOTE, f"HEAD:refs/heads/{self.branch}",
                network=True, check=False,
            )
            if pushed.returncode != 0:
                self._last["error"] = f"Could not publish: {_message(pushed)}"
                raise GitError(self._last["error"])
            self._run("fetch", REMOTE, self.branch, network=True, check=False)
            conflict = self._last.get("conflict") or {}
            if conflict.get("side_branch"):
                self._run(
                    "push", REMOTE, "--delete", conflict["side_branch"], network=True, check=False
                )
            self._last.update(conflict=None, error=None, synced_at=utcnow())
            return {
                "committed": None,
                "pulled": [path for path in diff.split("\0") if path],
                "pushed": True,
                "kept": keep,
            }


# ------------------------------------------------------------------ cloning


def clone(url: str, target: Path, *, branch: str | None = None) -> None:
    """Fetch a project from its remote into a new directory."""
    if target.exists() and any(target.iterdir()):
        raise GitError(f"{target} already exists and is not empty.")
    target.parent.mkdir(parents=True, exist_ok=True)
    helper = GitSync(target.parent)
    args = ["clone", "--origin", REMOTE]
    if branch:
        args += ["--branch", branch]
    result = helper._run(*args, url, str(target), network=True, check=False, cwd=target.parent)
    if result.returncode != 0:
        raise GitError(f"Could not clone {_without_credentials(url)}: {_message(result)}")


# ----------------------------------------------------------------- messages


def _message(result: subprocess.CompletedProcess[str]) -> str:
    """The most useful thing git said, with any credential in a URL removed."""
    text = (result.stderr or "").strip() or (result.stdout or "").strip()
    return _without_credentials(text) or f"git exited with status {result.returncode}."


def _without_credentials(text: str | None) -> str | None:
    """`https://user:token@host/…` as `https://host/…`: tokens stay out of sight."""
    if not text:
        return text
    return re.sub(r"(https?://)[^/@\s]+@", r"\1", text)


def _slug(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-") or "machine"


def _thing(path: str) -> tuple[str, str] | None:
    """What a path is, in the project's terms: ``(kind, name)``."""
    parts = path.split("/")
    if parts[0] == "notes" and path.endswith(".md"):
        return "note", parts[-1][: -len(".md")]
    if parts[0] == "documents" and len(parts) >= 3:
        if parts[2] == "summary.md":
            return "summary", parts[1]
        if parts[2] in {"metadata.json", "original.pdf"}:
            return "paper", parts[1]
        return None
    if path == "references.json":
        return "references", "references"
    if path == "references.bib":
        return "bibliography", "bibliography"
    if path == "project.toml":
        return "settings", "settings"
    return "file", path


def describe_changes(changed: list[tuple[str, str]]) -> str:
    """A commit message that says what happened, in the project's terms."""
    seen: dict[tuple[str, str], str] = {}
    for state, path in changed:
        thing = _thing(path)
        if thing is None:
            continue
        # A paper's files are added together; "added" is the news, not "edited".
        if seen.get(thing) != "added":
            seen[thing] = state
    # A paper arrives with its summary; saying so twice says nothing more.
    for (kind, name), state in list(seen.items()):
        if kind == "summary" and state == "added" and seen.get(("paper", name)) == "added":
            del seen[(kind, name)]
    if not seen:
        return "Update project files"

    groups: dict[tuple[str, str], list[str]] = {}
    for (kind, name), state in seen.items():
        groups.setdefault((state, kind), []).append(name)

    verbs = {"added": "Add", "edited": "Update", "deleted": "Remove"}
    plural = {
        "note": "notes", "summary": "summaries", "paper": "papers", "file": "files",
        "references": "references", "bibliography": "bibliography", "settings": "settings",
    }
    phrases: list[str] = []
    for (state, kind), names in sorted(groups.items(), key=lambda item: (item[0][0] != "added", item[0])):
        if kind in {"references", "bibliography", "settings"}:
            phrases.append(f"{verbs[state].lower()} {plural[kind]}")
        elif len(names) == 1:
            phrases.append(f"{verbs[state].lower()} {kind} {names[0]}")
        else:
            phrases.append(f"{verbs[state].lower()} {len(names)} {plural[kind]}")
    subject = "; ".join(phrases)
    subject = subject[0].upper() + subject[1:]
    if len(subject) > 72:
        subject = subject[:71].rstrip() + "…"
    body = "\n".join(f"{state}: {path}" for state, path in sorted(changed)[:60])
    return f"{subject}\n\n{body}\n"
