"""Where the large files of a project live when they are not on this machine.

A project has two kinds of material. The text — notes, summaries, the reference
registry, each paper's metadata — is small and merges well, so it travels in
git. The papers themselves do not: a PDF is megabytes of bytes that never
change. Those go to a blob store, addressed by the SHA-256 the project already
records for every document, and are fetched when they are wanted.

Because a blob's name is the hash of its contents, there is nothing to
reconcile: two machines that import the same paper store the same object, an
object once written is never rewritten, and a download can be checked against
its own name.

Two backends are implemented behind one small interface: any S3-compatible
service, and a plain directory (a mounted volume, or a folder another tool
keeps in sync). Credentials are never read from the project: S3 uses the
standard AWS chain — environment variables, a shared credentials file, or the
role of the machine it runs on.
"""

from __future__ import annotations

import abc
import contextlib
import gzip
import hashlib
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any

from .errors import WorkspaceError

PDF_PREFIX = "pdf"
PAGES_PREFIX = "pages"


class StorageError(WorkspaceError):
    """The blob store could not be reached, or refused. Worth trying again."""

    code = "storage_unavailable"
    status_code = 503
    retryable = True


class StorageMisconfigured(WorkspaceError):
    """The settings name a store that cannot be opened as described."""

    code = "storage_misconfigured"
    status_code = 500


def pdf_key(sha256: str) -> str:
    """Where a paper's original bytes are kept."""
    return f"{PDF_PREFIX}/{sha256}.pdf"


def pages_key(sha256: str, extraction_version: int | str) -> str:
    """Where a paper's extracted text is kept.

    Extraction is derived from the PDF, so the key names both: the same paper
    read by a newer extractor is a different object, and an old one is never
    mistaken for current.
    """
    return f"{PAGES_PREFIX}/{sha256}.v{extraction_version}.json.gz"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _temp_beside(path: Path) -> Path:
    """A scratch file on the same filesystem, so the final rename is atomic."""
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".part", dir=path.parent)
    os.close(handle)
    return Path(name)


class BlobStore(abc.ABC):
    """A place to put bytes under a name and get them back."""

    name: str = "unknown"

    @abc.abstractmethod
    def describe(self) -> str:
        """Where this is, for people. Never includes a credential."""

    @abc.abstractmethod
    def exists(self, key: str) -> bool: ...

    @abc.abstractmethod
    def _upload(self, key: str, path: Path) -> None: ...

    @abc.abstractmethod
    def _download(self, key: str, path: Path) -> bool:
        """Write the object to ``path``. False when there is no such object."""

    @abc.abstractmethod
    def keys(self, prefix: str = "") -> list[str]: ...

    def check(self) -> None:
        """Raise unless the store can be reached and read."""
        self.keys(f"{PDF_PREFIX}/__probe__")

    # ------------------------------------------------------------- transfer

    def put_file(self, key: str, path: Path) -> bool:
        """Store a file under ``key``. False when it was already there.

        Names are content hashes, so an object that exists is the same object:
        there is never a reason to send it twice.
        """
        if self.exists(key):
            return False
        self._upload(key, path)
        return True

    def get_file(self, key: str, path: Path) -> bool:
        """Fetch ``key`` into ``path``, whole or not at all. False when absent."""
        scratch = _temp_beside(path)
        try:
            if not self._download(key, scratch):
                return False
            scratch.replace(path)
            return True
        finally:
            with contextlib.suppress(FileNotFoundError):
                scratch.unlink()

    def put_gzipped(self, key: str, path: Path) -> bool:
        """Store a text file compressed. Extracted pages shrink about tenfold."""
        if self.exists(key):
            return False
        scratch = _temp_beside(path)
        try:
            # mtime=0 keeps the bytes the same whenever the content is.
            with path.open("rb") as source, scratch.open("wb") as raw:
                with gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as packed:
                    shutil.copyfileobj(source, packed)
            self._upload(key, scratch)
            return True
        finally:
            with contextlib.suppress(FileNotFoundError):
                scratch.unlink()

    def get_gunzipped(self, key: str, path: Path) -> bool:
        packed = _temp_beside(path)
        plain = _temp_beside(path)
        try:
            if not self._download(key, packed):
                return False
            with gzip.open(packed, "rb") as source, plain.open("wb") as target:
                shutil.copyfileobj(source, target)
            plain.replace(path)
            return True
        except (OSError, EOFError) as exc:
            raise StorageError(f"{key} in {self.describe()} is not readable: {exc}") from exc
        finally:
            for scratch in (packed, plain):
                with contextlib.suppress(FileNotFoundError):
                    scratch.unlink()


class DirectoryStore(BlobStore):
    """Blobs as files under a directory: a mounted volume, a synced folder."""

    name = "directory"

    def __init__(self, root: Path) -> None:
        self.root = root

    def describe(self) -> str:
        return str(self.root)

    def _path(self, key: str) -> Path:
        return self.root.joinpath(*key.split("/"))

    def exists(self, key: str) -> bool:
        try:
            return self._path(key).is_file()
        except OSError as exc:
            raise StorageError(f"{self.describe()} could not be read: {exc}") from exc

    def _upload(self, key: str, path: Path) -> None:
        target = self._path(key)
        try:
            scratch = _temp_beside(target)
            shutil.copyfile(path, scratch)
            scratch.replace(target)
        except OSError as exc:
            raise StorageError(f"{self.describe()} could not be written: {exc}") from exc

    def _download(self, key: str, path: Path) -> bool:
        source = self._path(key)
        try:
            if not source.is_file():
                return False
            shutil.copyfile(source, path)
            return True
        except OSError as exc:
            raise StorageError(f"{self.describe()} could not be read: {exc}") from exc

    def keys(self, prefix: str = "") -> list[str]:
        try:
            if not self.root.is_dir():
                return []
            found = [
                path.relative_to(self.root).as_posix()
                for path in self.root.rglob("*")
                if path.is_file() and not path.name.endswith(".part")
            ]
        except OSError as exc:
            raise StorageError(f"{self.describe()} could not be read: {exc}") from exc
        return sorted(key for key in found if key.startswith(prefix))


class S3Store(BlobStore):
    """Any S3-compatible service: AWS, Cloudflare R2, Backblaze B2, MinIO.

    ``endpoint_url`` is what makes the others work; it is unset for AWS. The
    client is made on first use, so a project that names a bucket still opens
    — and still reads its notes — on a machine with no network.
    """

    name = "s3"

    def __init__(
        self,
        bucket: str,
        *,
        prefix: str = "",
        endpoint_url: str | None = None,
        region: str | None = None,
        client: Any = None,
    ) -> None:
        self.bucket = bucket
        self.prefix = prefix.strip("/")
        self.endpoint_url = endpoint_url or None
        self.region = region or None
        self._client = client

    def describe(self) -> str:
        where = f"s3://{self.bucket}/{self.prefix}".rstrip("/")
        return f"{where} at {self.endpoint_url}" if self.endpoint_url else where

    def _key(self, key: str) -> str:
        return f"{self.prefix}/{key}" if self.prefix else key

    @property
    def client(self) -> Any:
        if self._client is None:
            try:
                import boto3
                from botocore.config import Config
            except ImportError as exc:
                raise StorageMisconfigured(
                    "This project keeps its papers in S3, which needs the storage extra: "
                    "pip install 'litmark[s3]'"
                ) from exc
            self._client = boto3.client(
                "s3",
                endpoint_url=self.endpoint_url,
                region_name=self.region,
                # A store that does not answer should say so in seconds, not
                # hold a page open for minutes.
                config=Config(
                    connect_timeout=10,
                    read_timeout=60,
                    retries={"max_attempts": 3, "mode": "standard"},
                ),
            )
        return self._client

    def _failure(self, action: str, exc: Exception) -> WorkspaceError:
        """One sentence a person can act on, from whatever the SDK raised."""
        code = ""
        response = getattr(exc, "response", None)
        if isinstance(response, dict):
            code = str((response.get("Error") or {}).get("Code") or "")
        kind = type(exc).__name__
        if kind in {"NoCredentialsError", "PartialCredentialsError"}:
            return StorageMisconfigured(
                f"No credentials for {self.describe()}. Set AWS_ACCESS_KEY_ID and "
                "AWS_SECRET_ACCESS_KEY in the environment (never in the project)."
            )
        if code in {"NoSuchBucket", "404"} and action == "reach":
            return StorageMisconfigured(f"There is no bucket {self.bucket!r} at {self.describe()}.")
        if code in {"AccessDenied", "403", "InvalidAccessKeyId", "SignatureDoesNotMatch"}:
            return StorageMisconfigured(
                f"{self.describe()} refused these credentials ({code}). They need to "
                "read, write and list this bucket."
            )
        return StorageError(f"Could not {action} {self.describe()}: {kind}: {exc}")

    def exists(self, key: str) -> bool:
        try:
            self.client.head_object(Bucket=self.bucket, Key=self._key(key))
            return True
        except WorkspaceError:
            raise
        except Exception as exc:  # noqa: BLE001 - the SDK's errors are many
            response = getattr(exc, "response", None)
            if isinstance(response, dict):
                code = str((response.get("Error") or {}).get("Code") or "")
                if code in {"404", "NoSuchKey", "NotFound"}:
                    return False
            raise self._failure("reach", exc) from exc

    def _upload(self, key: str, path: Path) -> None:
        try:
            self.client.upload_file(str(path), self.bucket, self._key(key))
        except WorkspaceError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise self._failure("write to", exc) from exc

    def _download(self, key: str, path: Path) -> bool:
        try:
            self.client.download_file(self.bucket, self._key(key), str(path))
            return True
        except WorkspaceError:
            raise
        except Exception as exc:  # noqa: BLE001
            response = getattr(exc, "response", None)
            if isinstance(response, dict):
                code = str((response.get("Error") or {}).get("Code") or "")
                if code in {"404", "NoSuchKey", "NotFound"}:
                    return False
            raise self._failure("read from", exc) from exc

    def keys(self, prefix: str = "") -> list[str]:
        strip = len(self.prefix) + 1 if self.prefix else 0
        found: list[str] = []
        try:
            paginator = self.client.get_paginator("list_objects_v2")
            for page in paginator.paginate(Bucket=self.bucket, Prefix=self._key(prefix)):
                found.extend(item["Key"][strip:] for item in page.get("Contents") or [])
        except WorkspaceError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise self._failure("reach", exc) from exc
        return sorted(found)


# ---------------------------------------------------------------- settings

ENV_BUCKET = "LITMARK_S3_BUCKET"
ENV_PREFIX = "LITMARK_S3_PREFIX"
ENV_ENDPOINT = "LITMARK_S3_ENDPOINT"
ENV_REGION = "LITMARK_S3_REGION"


def storage_settings(settings: dict[str, Any], environ: dict[str, str] | None = None) -> dict[str, Any]:
    """The ``[storage]`` table, or the environment's stand-in for one.

    The project file is the usual home: it travels with the project, so a
    clone on another machine already knows its bucket. The environment covers
    the case where there is no project yet — a container starting empty.
    """
    table = settings.get("storage")
    if isinstance(table, dict) and table.get("backend"):
        return dict(table)
    environ = os.environ if environ is None else environ  # type: ignore[assignment]
    bucket = environ.get(ENV_BUCKET)
    if not bucket:
        return {}
    found: dict[str, Any] = {"backend": "s3", "bucket": bucket}
    for key, variable in (("prefix", ENV_PREFIX), ("endpoint_url", ENV_ENDPOINT), ("region", ENV_REGION)):
        if environ.get(variable):
            found[key] = environ[variable]
    return found


def open_store(settings: dict[str, Any], root: Path) -> BlobStore | None:
    """The store a project's settings describe, or None when it has none."""
    table = storage_settings(settings)
    backend = str(table.get("backend") or "").lower()
    if not backend or backend == "none":
        return None
    if backend == "s3":
        bucket = str(table.get("bucket") or "").strip()
        if not bucket:
            raise StorageMisconfigured("`[storage] backend = \"s3\"` needs a `bucket`.")
        return S3Store(
            bucket,
            prefix=str(table.get("prefix") or ""),
            endpoint_url=str(table.get("endpoint_url") or "") or None,
            region=str(table.get("region") or "") or None,
        )
    if backend == "directory":
        raw = str(table.get("path") or "").strip()
        if not raw:
            raise StorageMisconfigured("`[storage] backend = \"directory\"` needs a `path`.")
        path = Path(raw).expanduser()
        return DirectoryStore(path if path.is_absolute() else (root / path))
    raise StorageMisconfigured(
        f"Unknown storage backend {backend!r}. Use \"s3\" or \"directory\"."
    )


def storage_toml(table: dict[str, Any]) -> str:
    """The ``[storage]`` table as it is written into a new project file."""
    lines = ["[storage]"]
    for key in ("backend", "bucket", "prefix", "endpoint_url", "region", "path"):
        value = table.get(key)
        if value:
            escaped = str(value).replace("\\", "\\\\").replace('"', '\\"')
            lines.append(f'{key} = "{escaped}"')
    return "\n".join(lines) + "\n"
