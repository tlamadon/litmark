"""Papers through storage, text through git.

The storage backends are exercised through their real clients: the directory
store on a real directory, the S3 store through boto3 against an emulator. The
git layer runs real git against a bare repository standing in for the remote.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
from pathlib import Path

import pytest
from conftest import upload, wait_for_extraction
from fastapi.testclient import TestClient

from litmark import cli
from litmark.api.app import TOKEN_HEADER, create_app
from litmark.errors import NotFound
from litmark.gitsync import GitError, GitSync, _without_credentials, clone, describe_changes
from litmark.services import Services
from litmark.storage import (
    DirectoryStore,
    S3Store,
    StorageError,
    StorageMisconfigured,
    open_store,
    pages_key,
    pdf_key,
    sha256_file,
    storage_settings,
)
from litmark.workspace import Workspace

boto3 = pytest.importorskip("boto3")
moto = pytest.importorskip("moto")


@pytest.fixture(autouse=True)
def no_ambient_git_identity(monkeypatch, tmp_path):
    """As on a fresh container: no user-level git config, no AWS profile."""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(tmp_path / "no-gitconfig"))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    for name in ("GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"):
        monkeypatch.delenv(name, raising=False)
    for name in list(os.environ):
        if name.startswith(("AWS_", "LITMARK_S3_")):
            monkeypatch.delenv(name, raising=False)


def git(cwd: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args], cwd=cwd, capture_output=True, text=True, check=True,
        env={**os.environ, "GIT_AUTHOR_NAME": "T", "GIT_AUTHOR_EMAIL": "t@example.com",
             "GIT_COMMITTER_NAME": "T", "GIT_COMMITTER_EMAIL": "t@example.com"},
    )
    return result.stdout.strip()


def settle_jobs(services: Services, timeout: float = 30.0) -> None:
    """Run every queued job (extraction, transfers) to completion."""

    async def drain() -> None:
        services.bind_loop(asyncio.get_running_loop())
        services.jobs.recover()
        deadline = asyncio.get_running_loop().time() + timeout
        while asyncio.get_running_loop().time() < deadline:
            await services.jobs.drain(timeout=timeout)
            await asyncio.sleep(0.02)
            if not services.db.query("SELECT id FROM jobs WHERE status IN ('queued', 'running')"):
                return
        raise AssertionError("Jobs did not settle")

    asyncio.run(drain())


def project_with(tmp_path: Path, name: str, extra: str = "") -> Workspace:
    return Workspace.initialize(tmp_path / name, extra_settings=extra)


def use_directory_store(tmp_path: Path) -> str:
    return f'[storage]\nbackend = "directory"\npath = "{tmp_path / "blobs"}"\n'


# ------------------------------------------------------------------ storage


def test_the_directory_store_keeps_and_returns_bytes(tmp_path):
    store = DirectoryStore(tmp_path / "blobs")
    source = tmp_path / "paper.pdf"
    source.write_bytes(b"%PDF-1.4 the bytes of a paper")

    assert store.exists("pdf/abc.pdf") is False
    assert store.put_file("pdf/abc.pdf", source) is True
    # Named by content: an object that exists is never sent again.
    assert store.put_file("pdf/abc.pdf", source) is False
    assert store.keys() == ["pdf/abc.pdf"]

    target = tmp_path / "elsewhere" / "paper.pdf"
    assert store.get_file("pdf/abc.pdf", target) is True
    assert target.read_bytes() == source.read_bytes()
    assert store.get_file("pdf/missing.pdf", tmp_path / "nothing.pdf") is False
    assert not (tmp_path / "nothing.pdf").exists()
    assert not list(tmp_path.rglob("*.part")), "a scratch file was left behind"


def test_extracted_text_is_stored_compressed_and_comes_back_whole(tmp_path):
    store = DirectoryStore(tmp_path / "blobs")
    pages = tmp_path / "pages.json"
    pages.write_text(json.dumps({"pages": [{"text": "mobility " * 4000}]}), "utf-8")

    assert store.put_gzipped("pages/abc.v1.json.gz", pages) is True
    stored = tmp_path / "blobs" / "pages" / "abc.v1.json.gz"
    assert stored.stat().st_size < pages.stat().st_size / 10

    back = tmp_path / "back.json"
    assert store.get_gunzipped("pages/abc.v1.json.gz", back) is True
    assert back.read_text("utf-8") == pages.read_text("utf-8")


@pytest.fixture
def s3(monkeypatch):
    """An emulated S3, reached through the real boto3 client."""
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
    with moto.mock_aws():
        client = boto3.client("s3", region_name="us-east-1")
        client.create_bucket(Bucket="papers")
        yield client


def test_the_s3_store_keeps_and_returns_bytes_under_its_prefix(tmp_path, s3):
    store = S3Store("papers", prefix="/library/")
    source = tmp_path / "paper.pdf"
    source.write_bytes(b"%PDF-1.4 " + b"x" * 200_000)

    assert store.exists(pdf_key("abc")) is False
    assert store.put_file(pdf_key("abc"), source) is True
    assert store.put_file(pdf_key("abc"), source) is False
    assert store.exists(pdf_key("abc")) is True
    # In the bucket it sits under the prefix; to the application it does not.
    listed = [item["Key"] for item in s3.list_objects_v2(Bucket="papers")["Contents"]]
    assert listed == ["library/pdf/abc.pdf"]
    assert store.keys() == ["pdf/abc.pdf"]
    assert store.keys("pages/") == []

    target = tmp_path / "back.pdf"
    assert store.get_file(pdf_key("abc"), target) is True
    assert sha256_file(target) == sha256_file(source)
    assert store.get_file(pdf_key("nothing"), tmp_path / "no.pdf") is False
    assert not (tmp_path / "no.pdf").exists()
    assert store.describe() == "s3://papers/library"
    store.check()


def test_a_bucket_that_is_not_there_is_reported_as_such(tmp_path, s3):
    store = S3Store("no-such-bucket")
    with pytest.raises(StorageMisconfigured) as raised:
        store.check()
    assert "no-such-bucket" in raised.value.message


def test_an_unreachable_store_fails_as_worth_retrying(tmp_path, monkeypatch):
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
    from botocore.config import Config

    client = boto3.client(
        "s3",
        endpoint_url="http://127.0.0.1:9",  # Nothing listens on the discard port.
        config=Config(connect_timeout=1, read_timeout=1, retries={"max_attempts": 1}),
    )
    store = S3Store("papers", endpoint_url="http://127.0.0.1:9", client=client)
    with pytest.raises(StorageError) as raised:
        store.exists(pdf_key("abc"))
    assert raised.value.retryable is True
    assert "http://127.0.0.1:9" in raised.value.message


def test_storage_is_read_from_the_project_or_failing_that_the_environment(tmp_path, monkeypatch):
    assert open_store({}, tmp_path) is None
    store = open_store(
        {"storage": {"backend": "s3", "bucket": "b", "prefix": "p", "endpoint_url": "https://r2"}},
        tmp_path,
    )
    assert isinstance(store, S3Store)
    assert (store.bucket, store.prefix, store.endpoint_url) == ("b", "p", "https://r2")
    relative = open_store({"storage": {"backend": "directory", "path": "blobs"}}, tmp_path)
    assert isinstance(relative, DirectoryStore) and relative.root == tmp_path / "blobs"

    monkeypatch.setenv("LITMARK_S3_BUCKET", "from-env")
    monkeypatch.setenv("LITMARK_S3_ENDPOINT", "https://minio.internal")
    assert storage_settings({}) == {
        "backend": "s3", "bucket": "from-env", "endpoint_url": "https://minio.internal",
    }
    # What the project says wins over what the environment says.
    assert storage_settings({"storage": {"backend": "s3", "bucket": "mine"}})["bucket"] == "mine"

    with pytest.raises(StorageMisconfigured):
        open_store({"storage": {"backend": "s3"}}, tmp_path)
    with pytest.raises(StorageMisconfigured):
        open_store({"storage": {"backend": "ftp"}}, tmp_path)


def test_a_project_with_misdescribed_storage_still_opens(tmp_path):
    workspace = project_with(tmp_path, "p", '[storage]\nbackend = "ftp"\n')
    services = Services(workspace, backend_name="fake")
    try:
        status = services.sync_status()["storage"]
        assert status["enabled"] is False
        assert "ftp" in status["problem"]
        assert [note.note_id for note in services.workspace.list_notes()] == ["welcome"]
    finally:
        services.db.close()


# ------------------------------------------------------- papers and storage


def test_an_imported_paper_reaches_storage_with_its_text(tmp_path, paper_one):
    workspace = project_with(tmp_path, "a", use_directory_store(tmp_path))
    services = Services(workspace, backend_name="fake")
    try:
        document, _ = services.documents.import_pdf(paper_one, "paper.pdf")
        services.enqueue_extraction(document.document_id, summarize=False)
        settle_jobs(services)

        stored = services.papers.store.keys()
        version = services.documents.get(document.document_id).extraction["version"]
        assert stored == [
            pages_key(document.sha256, version),
            pdf_key(document.sha256),
        ]
        # Nothing more to send or fetch.
        assert services.papers.plan() == {"push": [], "pages": [], "pdf": [], "extract": []}
    finally:
        services.db.close()


def copy_text_only(source: Workspace, target_root: Path) -> Workspace:
    """What git carries to another machine: everything but PDFs and extracted text."""
    import shutil

    shutil.copytree(
        source.root,
        target_root,
        ignore=shutil.ignore_patterns("original.pdf", "pages.json", ".research"),
    )
    return Workspace(target_root).open()


def test_another_machine_gets_the_text_at_once_and_the_pdf_when_opened(tmp_path, paper_one):
    first = Services(project_with(tmp_path, "a", use_directory_store(tmp_path)), backend_name="fake")
    try:
        document, _ = first.documents.import_pdf(paper_one, "paper.pdf")
        first.enqueue_extraction(document.document_id, summarize=False)
        settle_jobs(first)
    finally:
        first.db.close()

    second = Services(copy_text_only(first.workspace, tmp_path / "b"), backend_name="fake")
    document_id = document.document_id
    try:
        assert not second.papers.has_pdf(document_id) and not second.papers.has_pages(document_id)
        assert second.papers.plan()["pages"] == [document_id]
        second.sync_papers()
        settle_jobs(second)

        # Searchable and readable by the agent without the PDF ever arriving.
        assert second.papers.has_pages(document_id) and not second.papers.has_pdf(document_id)
        hits = second.documents.search("mobility restriction")
        assert hits and hits[0].document_id == document_id

        # Opening the paper fetches it, checked against its hash.
        app = create_app(second)
        with TestClient(app, base_url="http://127.0.0.1:8765") as client:
            client.headers.update({TOKEN_HEADER: second.session_token})
            response = client.get(f"/api/documents/{document_id}/pdf")
            assert response.status_code == 200, response.text
            assert response.content == paper_one
        assert sha256_file(second.documents.pdf_path(document_id)) == document.sha256
    finally:
        second.db.close()


def test_text_is_fetched_when_first_asked_for_even_before_a_sync(tmp_path, paper_one):
    first = Services(project_with(tmp_path, "a", use_directory_store(tmp_path)), backend_name="fake")
    try:
        document, _ = first.documents.import_pdf(paper_one, "paper.pdf")
        first.enqueue_extraction(document.document_id, summarize=False)
        settle_jobs(first)
    finally:
        first.db.close()

    second = Services(copy_text_only(first.workspace, tmp_path / "b"), backend_name="fake")
    try:
        # The agent's read tool goes straight to the text; it arrives on demand.
        result = second.tools.read_pages(document.document_id, [2])
        assert "Assumption 2" in result["pages"][0]["text"]
    finally:
        second.db.close()


def test_a_copy_that_does_not_match_its_hash_is_not_kept(tmp_path, paper_one):
    first = Services(project_with(tmp_path, "a", use_directory_store(tmp_path)), backend_name="fake")
    try:
        document, _ = first.documents.import_pdf(paper_one, "paper.pdf")
        first.papers.push(document.document_id)
    finally:
        first.db.close()
    (tmp_path / "blobs" / "pdf" / f"{document.sha256}.pdf").write_bytes(b"%PDF-1.4 something else")

    second = Services(copy_text_only(first.workspace, tmp_path / "b"), backend_name="fake")
    try:
        with pytest.raises(StorageError) as raised:
            second.papers.ensure_pdf(document.document_id)
        assert "does not match" in raised.value.message
        assert not second.papers.has_pdf(document.document_id)
    finally:
        second.db.close()


def test_a_paper_that_is_nowhere_says_where_it_looked(tmp_path, paper_one):
    first = Services(project_with(tmp_path, "a", use_directory_store(tmp_path)), backend_name="fake")
    try:
        document, _ = first.documents.import_pdf(paper_one, "paper.pdf")  # never pushed
    finally:
        first.db.close()
    second = Services(copy_text_only(first.workspace, tmp_path / "b"), backend_name="fake")
    try:
        with pytest.raises(NotFound) as raised:
            second.papers.ensure_pdf(document.document_id)
        assert "has not synced yet" in raised.value.message
    finally:
        second.db.close()


def test_text_that_was_never_stored_is_extracted_again_without_a_new_summary(tmp_path, paper_one):
    first = Services(project_with(tmp_path, "a", use_directory_store(tmp_path)), backend_name="fake")
    try:
        document, _ = first.documents.import_pdf(paper_one, "paper.pdf")
        first.documents.run_extraction(document.document_id)
        first.papers.push(document.document_id)
    finally:
        first.db.close()
    # The paper is in storage; its extracted text was lost from it.
    for blob in (tmp_path / "blobs" / "pages").iterdir():
        blob.unlink()

    second = Services(copy_text_only(first.workspace, tmp_path / "b"), backend_name="fake")
    try:
        assert second.papers.plan()["extract"] == [document.document_id]
        second.sync_papers()
        settle_jobs(second)
        assert second.papers.has_pages(document.document_id)
        assert second.papers.has_pdf(document.document_id)
        # And it put the text back for the next machine.
        assert any(key.startswith("pages/") for key in second.papers.store.keys())
        assert second.db.query("SELECT id FROM runs") == [], "a summary was queued"
    finally:
        second.db.close()


def test_papers_travel_through_s3(tmp_path, paper_one, s3, monkeypatch):
    """The same journey as above, with the S3 backend doing the carrying."""
    settings = '[storage]\nbackend = "s3"\nbucket = "papers"\nprefix = "lib"\n'
    first = Services(project_with(tmp_path, "a", settings), backend_name="fake")
    try:
        document, _ = first.documents.import_pdf(paper_one, "paper.pdf")
        first.documents.run_extraction(document.document_id)
        assert first.papers.push(document.document_id) == {"pdf": True, "pages": True}
        assert first.papers.push(document.document_id) == {"pdf": False, "pages": False}
    finally:
        first.db.close()
    keys = sorted(item["Key"] for item in s3.list_objects_v2(Bucket="papers")["Contents"])
    assert keys[1] == f"lib/pdf/{document.sha256}.pdf" and keys[0].startswith("lib/pages/")

    second = Services(copy_text_only(first.workspace, tmp_path / "b"), backend_name="fake")
    try:
        assert second.papers.ensure_pages(document.document_id) is True
        assert second.documents.search("mobility restriction")
        path = second.papers.ensure_pdf(document.document_id)
        assert path.read_bytes() == paper_one
    finally:
        second.db.close()


# ---------------------------------------------------------------------- git


def test_a_project_becomes_a_repository_with_its_large_files_left_out(tmp_path, paper_one):
    workspace = project_with(tmp_path, "p", use_directory_store(tmp_path))
    services = Services(workspace, backend_name="fake")
    try:
        document, _ = services.documents.import_pdf(paper_one, "paper.pdf")
        services.documents.run_extraction(document.document_id)
        assert services.git.is_repository() is False
        assert services.sync_status()["git"]["state"] == "off"

        services.git.init()
        tracked = git(workspace.root, "ls-files").splitlines()
        assert ".gitignore" in tracked and "project.toml" in tracked
        assert "notes/welcome.md" in tracked and "references.json" in tracked
        assert f"documents/{document.document_id}/metadata.json" in tracked
        assert not [path for path in tracked if path.endswith(("original.pdf", "pages.json"))]
        assert not [path for path in tracked if path.startswith(".research")]
        # Committed with a stand-in identity: this machine has none configured.
        assert git(workspace.root, "log", "-1", "--format=%an <%ae>") == "Litmark <litmark@localhost>"
        assert services.git.status()["state"] == "local"
    finally:
        services.db.close()


def test_without_storage_the_papers_stay_in_git(tmp_path, paper_one):
    """With nowhere else for a PDF to go, leaving it out of git would lose it."""
    workspace = project_with(tmp_path, "p")
    services = Services(workspace, backend_name="fake")
    try:
        document, _ = services.documents.import_pdf(paper_one, "paper.pdf")
        services.git.init()
        tracked = git(workspace.root, "ls-files").splitlines()
        assert f"documents/{document.document_id}/original.pdf" in tracked
    finally:
        services.db.close()


def test_a_project_inside_another_repository_is_left_alone(tmp_path):
    outer = tmp_path / "codebase"
    outer.mkdir()
    git(outer, "init", "-b", "main")
    (outer / "README").write_text("someone's code\n")
    git(outer, "add", "-A")
    git(outer, "commit", "-m", "theirs")

    workspace = Workspace.initialize(outer / "my-research")
    sync = GitSync(workspace.root, workspace.settings())
    assert sync.is_repository() is False and sync.automatic is False
    usable, reason = sync.availability()
    assert usable is False and "inside another repository" in (reason or "")
    with pytest.raises(GitError):
        sync.sync()
    assert git(outer, "log", "--format=%s") == "theirs"
    assert "my-research" in git(outer, "status", "--porcelain")


def test_commit_messages_say_what_happened_in_the_projects_terms():
    assert describe_changes([("edited", "notes/findings.md")]).splitlines()[0] == (
        "Update note findings"
    )
    message = describe_changes(
        [
            ("added", "documents/doc-003/metadata.json"),
            ("added", "documents/doc-003/summary.md"),
            ("added", "documents/doc-004/metadata.json"),
            ("edited", "notes/a.md"),
            ("edited", "notes/b.md"),
            ("edited", "references.json"),
            ("deleted", "notes/old.md"),
        ]
    )
    subject = message.splitlines()[0]
    assert subject.startswith("Add 2 papers")
    assert "update 2 notes" in subject and "remove note old" in subject
    assert "update references" in subject
    assert "added: documents/doc-003/metadata.json" in message


def test_a_token_in_a_remote_url_is_never_shown():
    assert _without_credentials("https://me:ghp_secret@github.com/me/r.git") == (
        "https://github.com/me/r.git"
    )
    assert _without_credentials("git@github.com:me/r.git") == "git@github.com:me/r.git"


def test_a_token_is_passed_to_git_without_being_written_down(tmp_path, monkeypatch):
    workspace = project_with(tmp_path, "p")
    sync = GitSync(workspace.root, workspace.settings())
    sync.init("https://example.invalid/me/r.git")
    monkeypatch.setenv("LITMARK_GIT_TOKEN", "ghp_secret")

    env = sync._env(network=True)
    values = [env[key] for key in env if key.startswith("GIT_CONFIG_VALUE_")]
    assert any(value.startswith("Authorization: Basic ") for value in values)
    assert env["GIT_TERMINAL_PROMPT"] == "0"
    # Local commands are not given it, and it is not in the repository's config.
    local = sync._env(network=False)
    assert not any("Authorization" in local[key] for key in local if key.startswith("GIT_CONFIG_VALUE_"))
    assert "ghp_secret" not in (workspace.root / ".git" / "config").read_text()
    assert "Authorization" not in (workspace.root / ".git" / "config").read_text()


@pytest.fixture
def remote(tmp_path) -> Path:
    path = tmp_path / "remote.git"
    subprocess.run(["git", "init", "--bare", "-b", "main", str(path)], check=True, capture_output=True)
    return path


def two_copies(tmp_path: Path, remote: Path) -> tuple[GitSync, GitSync]:
    first = project_with(tmp_path, "a")
    one = GitSync(first.root, first.settings())
    one.init(str(remote))
    one.sync()
    clone(str(remote), tmp_path / "b")
    second = Workspace(tmp_path / "b").open()
    return one, GitSync(second.root, second.settings())


def test_work_on_one_machine_reaches_the_other(tmp_path, remote):
    one, two = two_copies(tmp_path, remote)
    assert (two.root / "notes" / "welcome.md").is_file()
    assert two.status()["state"] == "synced"

    (one.root / "notes" / "findings.md").write_text("# Findings\n\nFirst.\n")
    report = one.sync()
    assert report["committed"] and report["pushed"] and report["pulled"] == []
    assert git(one.root, "log", "-1", "--format=%s") == "Add note findings"

    report = two.sync()
    assert report["pulled"] == ["notes/findings.md"] and report["committed"] is None
    assert (two.root / "notes" / "findings.md").read_text() == "# Findings\n\nFirst.\n"
    assert two.status()["state"] == "synced"


def test_different_notes_edited_on_both_machines_both_survive(tmp_path, remote):
    one, two = two_copies(tmp_path, remote)
    (one.root / "notes" / "one.md").write_text("# One\n")
    (two.root / "notes" / "two.md").write_text("# Two\n")
    one.sync()
    report = two.sync()
    assert report["committed"] and report["pushed"]
    assert report["pulled"] == ["notes/one.md"]
    one.sync()
    for copy in (one, two):
        assert (copy.root / "notes" / "one.md").is_file()
        assert (copy.root / "notes" / "two.md").is_file()
    # Replayed, not merged: one line of history.
    assert "Merge" not in git(two.root, "log", "--format=%s")


def conflicted(tmp_path: Path, remote: Path) -> tuple[GitSync, GitSync]:
    one, two = two_copies(tmp_path, remote)
    (one.root / "notes" / "welcome.md").write_text("# Welcome\n\nWritten on one.\n")
    (two.root / "notes" / "welcome.md").write_text("# Welcome\n\nWritten on two.\n")
    (two.root / "notes" / "only-two.md").write_text("# Only on two\n")
    one.sync()
    return one, two


def test_a_conflict_stops_overwrites_nothing_and_gets_the_work_off_the_disk(tmp_path, remote):
    _, two = conflicted(tmp_path, remote)
    report = two.sync()

    conflict = report["conflict"]
    assert conflict["files"] == ["notes/welcome.md"]
    # This copy is exactly as it was: its own text, no markers, nothing half-done.
    assert (two.root / "notes" / "welcome.md").read_text() == "# Welcome\n\nWritten on two.\n"
    assert not (two.root / ".git" / "rebase-merge").exists()
    assert git(two.root, "status", "--porcelain") == ""
    status = two.status()
    assert status["state"] == "conflict" and "both changed notes/welcome.md" in status["message"]
    # The local commits exist on the remote, on a branch of their own.
    branches = git(remote, "branch", "--format=%(refname:short)").splitlines()
    assert conflict["side_branch"] in branches and conflict["side_branch"].startswith("litmark-unmerged/")
    assert "Written on one." in git(remote, "show", "main:notes/welcome.md")

    # Asked again without a decision, it says the same and still changes nothing.
    assert two.sync()["conflict"]["files"] == ["notes/welcome.md"]
    assert (two.root / "notes" / "welcome.md").read_text() == "# Welcome\n\nWritten on two.\n"


@pytest.mark.parametrize(("keep", "winner"), [("mine", "two"), ("theirs", "one")])
def test_a_conflict_is_settled_by_keeping_one_side(tmp_path, remote, keep, winner):
    one, two = conflicted(tmp_path, remote)
    side = two.sync()["conflict"]["side_branch"]

    report = two.resolve(keep)
    assert report["pushed"] is True
    text = (two.root / "notes" / "welcome.md").read_text()
    assert text == f"# Welcome\n\nWritten on {winner}.\n"
    # What did not conflict is kept from both sides, whichever was chosen.
    assert (two.root / "notes" / "only-two.md").is_file()
    assert two.status()["state"] == "synced"
    # Both histories are in the log; the side branch has done its job.
    log = git(two.root, "log", "--format=%s")
    assert "Merge the remote's changes" in log
    assert side not in git(remote, "branch", "--format=%(refname:short)").splitlines()

    one.sync()
    assert (one.root / "notes" / "welcome.md").read_text() == text
    assert (one.root / "notes" / "only-two.md").is_file()


def test_an_unreachable_remote_is_an_error_that_keeps_the_local_commit(tmp_path):
    workspace = project_with(tmp_path, "p")
    sync = GitSync(workspace.root, workspace.settings())
    sync.init(str(tmp_path / "nowhere.git"))
    (workspace.root / "notes" / "n.md").write_text("# N\n")
    with pytest.raises(GitError) as raised:
        sync.sync()
    assert "Could not reach the remote" in raised.value.message
    assert git(workspace.root, "log", "-1", "--format=%s") == "Add note n"
    assert sync.status()["state"] == "error"


# -------------------------------------------------------------- end to end


def test_a_project_moves_to_another_machine_whole(tmp_path, remote, paper_one):
    """Text by git, papers by storage: a clone ends up with a working project."""
    first = Services(project_with(tmp_path, "a", use_directory_store(tmp_path)), backend_name="fake")
    try:
        first.git.init(str(remote))
        document, _ = first.documents.import_pdf(paper_one, "paper.pdf")
        first.enqueue_extraction(document.document_id, summarize=False)
        settle_jobs(first)
        first.documents.write_summary(document.document_id, "## Summary\n\nShort.\n", expected_revision=None)
        first.workspace.create_note(title="Findings", text="# Findings\n\nOn mobility.\n")

        result = first.sync_now()
        assert result["problems"] == [] and result["git"]["state"] == "synced"
        settle_jobs(first)
        tracked = git(first.workspace.root, "ls-files").splitlines()
        assert not [path for path in tracked if path.endswith(("original.pdf", "pages.json"))]
    finally:
        first.db.close()

    clone(str(remote), tmp_path / "b")
    second = Services(Workspace(tmp_path / "b").open(), backend_name="fake")
    try:
        assert second.papers.enabled, "the clone did not learn where the papers are"
        result = second.sync_now()
        assert result["problems"] == []
        settle_jobs(second)

        titles = {note.title for note in second.workspace.list_notes()}
        assert "Findings" in titles
        (listed,) = second.documents.list()
        assert listed.sha256 == document.sha256
        assert second.documents.summary_text(listed.document_id) == "## Summary\n\nShort.\n"
        assert second.documents.search("mobility restriction")
        assert second.papers.ensure_pdf(listed.document_id).read_bytes() == paper_one
        # Fetching changed nothing git cares about: no commit to make.
        assert second.git.changes() == []
    finally:
        second.db.close()


def test_what_arrives_from_the_remote_is_announced_to_the_browser(tmp_path, remote):
    one, two = two_copies(tmp_path, remote)
    (one.root / "notes" / "news.md").write_text("# News\n")
    one.sync()

    services = Services(Workspace(two.root).open(), backend_name="fake")
    seen: list[dict] = []
    services.bus._fanout = seen.append  # type: ignore[method-assign]
    try:
        result = services.sync_now()
        assert result["pulled"] == ["notes/news.md"]
        (event,) = [e for e in seen if e["type"] == "sync_updated"]
        assert event["pulled"] == ["notes/news.md"] and event["transient"] is True
        assert event["status"]["git"]["state"] == "synced"
    finally:
        services.db.close()


def test_edits_are_committed_once_they_have_settled(tmp_path, remote):
    workspace = project_with(tmp_path, "p")
    services = Services(workspace, backend_name="fake")
    try:
        services.git.init(str(remote))
        services.sync_now()
        assert services._sync_due() is False  # Nothing changed, nothing to fetch yet.

        note = workspace.root / "notes" / "draft.md"
        note.write_text("# Draft\n")
        assert services._sync_due() is False, "committed in the middle of a sentence"
        old = note.stat().st_mtime - 120
        os.utime(note, (old, old))
        assert services._sync_due() is True

        services.sync_now()
        assert services._sync_due() is False
        services._last_exchange -= 10_000  # Long enough ago to ask the remote for news.
        assert services._sync_due() is True
    finally:
        services.db.close()


# ---------------------------------------------------------------------- CLI


def test_the_command_line_sets_up_syncs_and_clones_a_project(tmp_path, remote, paper_one, capsys):
    blobs = tmp_path / "blobs"
    assert cli.main(
        ["init", str(tmp_path / "a"), "--git-remote", str(remote), "--storage-dir", str(blobs)]
    ) == 0
    assert 'backend = "directory"' in (tmp_path / "a" / "project.toml").read_text()

    services = Services(Workspace(tmp_path / "a").open(), backend_name="fake")
    try:
        document, _ = services.documents.import_pdf(paper_one, "paper.pdf")
        services.documents.run_extraction(document.document_id)
    finally:
        services.db.close()

    assert cli.main(["sync", str(tmp_path / "a")]) == 0
    out = capsys.readouterr().out
    assert "text: Up to date" in out and "1 of 1 PDFs on this machine" in out
    assert (blobs / "pdf" / f"{document.sha256}.pdf").is_file()

    assert cli.main(["clone", str(remote), str(tmp_path / "b")]) == 0
    assert cli.main(["sync", str(tmp_path / "b")]) == 0
    assert "0 of 1 PDFs on this machine" in capsys.readouterr().out
    assert (tmp_path / "b" / "documents" / document.document_id / "pages.json").is_file()

    assert cli.main(["sync", str(tmp_path / "b"), "--all-papers"]) == 0
    assert "1 of 1 PDFs on this machine" in capsys.readouterr().out
    assert cli.main(["doctor", str(tmp_path / "b")]) in (0, 1)
    report = capsys.readouterr().out
    assert "paper storage: directory" in report and "reachable: yes" in report
    assert "git: Up to date" in report


def test_cloning_something_that_is_not_a_project_says_so(tmp_path, remote, capsys):
    work = tmp_path / "work"
    work.mkdir()
    git(work, "init", "-b", "main")
    (work / "README").write_text("not a project\n")
    git(work, "add", "-A")
    git(work, "commit", "-m", "x")
    git(work, "push", str(remote), "main")
    assert cli.main(["clone", str(remote), str(tmp_path / "c")]) == 1
    assert "not a Litmark project" in capsys.readouterr().err


def test_an_empty_remote_is_where_a_new_project_begins(tmp_path, remote, monkeypatch, capsys):
    """A container's first start: nothing to clone yet, so the project is made there."""
    monkeypatch.setenv("LITMARK_S3_BUCKET", "papers")
    monkeypatch.setenv("LITMARK_S3_ENDPOINT", "https://r2.example")
    assert cli.main(["clone", str(remote), str(tmp_path / "p"), "--or-init"]) == 0
    assert "The remote was empty" in capsys.readouterr().out

    settings = Workspace(tmp_path / "p").settings()
    assert settings["storage"] == {
        "backend": "s3", "bucket": "papers", "endpoint_url": "https://r2.example",
    }
    sync = GitSync(tmp_path / "p", settings, papers_in_storage=True)
    assert sync.remote_url() == str(remote)
    assert "documents/*/original.pdf" in (tmp_path / "p" / ".gitignore").read_text()
    sync.sync()
    assert "project.toml" in git(remote, "ls-tree", "-r", "--name-only", "main").splitlines()

    # The next start finds a project there and clones it, bucket and all.
    assert cli.main(["clone", str(remote), str(tmp_path / "q"), "--or-init"]) == 0
    assert "Cloned project" in capsys.readouterr().out
    assert Workspace(tmp_path / "q").settings()["storage"]["bucket"] == "papers"


def test_the_token_reaches_an_https_remote_as_a_header(tmp_path, monkeypatch):
    """Sent on the wire to the remote, by environment — and only on network commands."""
    import base64
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    seen: list[str | None] = []

    class Remote(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 - the handler's own naming
            seen.append(self.headers.get("Authorization"))
            self.send_response(404)
            self.end_headers()

        def log_message(self, *args: object) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Remote)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        workspace = project_with(tmp_path, "p")
        sync = GitSync(workspace.root, workspace.settings())
        sync.init(f"http://127.0.0.1:{server.server_port}/me/research.git")
        monkeypatch.setenv("LITMARK_GIT_TOKEN", "ghp_secret")
        with pytest.raises(GitError) as raised:
            sync.sync()
    finally:
        server.shutdown()

    expected = "Basic " + base64.b64encode(b"x-access-token:ghp_secret").decode()
    assert seen and all(header == expected for header in seen), seen
    assert "ghp_secret" not in raised.value.message and expected not in raised.value.message
