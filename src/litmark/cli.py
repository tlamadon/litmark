"""Command line entry point.

Two kinds of command share it. `init`, `clone`, `serve`, `sync` and `doctor`
act on a project directory on this machine. The rest (`recall`, `add`,
`append`, … — see :mod:`client`) ask a server that is already running, from
wherever you are, with the token it was started with.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import threading
import webbrowser
from pathlib import Path

from .errors import WorkspaceError
from .workspace import Workspace

DEFAULT_PORT = 8765
PASSWORD_ENV = "LITMARK_PASSWORD"
# Loopback by default; `--host` widens it for a proxy or port-forward, and an
# SSH tunnel remains the recommended way to reach it from another machine.
HOST = "127.0.0.1"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="litmark",
        description=(
            "A local research workspace: import papers, read cited summaries, write "
            "sourced Markdown notes, and chat with a coding agent."
        ),
        epilog=(
            "init, clone, sync, serve and doctor act on a project directory here. "
            "The other commands ask a running server, wherever it is: set "
            "LITMARK_URL to its address and LITMARK_MCP_TOKEN to the token it was "
            "started with."
        ),
    )
    parser.add_argument("--verbose", "-v", action="store_true", help="Log debug output.")
    sub = parser.add_subparsers(dest="command", required=True)

    init = sub.add_parser("init", help="Create a new project directory.")
    init.add_argument("path", type=Path, help="Where to create the project.")
    init.add_argument("--name", help="Project name (defaults to the directory name).")
    init.add_argument(
        "--git",
        action="store_true",
        help="Version the project's text with git, committed for you as you work.",
    )
    init.add_argument(
        "--git-remote",
        metavar="URL",
        help="A remote to publish the text to and fetch it from. Implies --git.",
    )
    _add_storage_arguments(init)

    clone = sub.add_parser(
        "clone", help="Fetch an existing project from its git remote."
    )
    clone.add_argument("url", help="The project's git remote.")
    clone.add_argument("path", type=Path, help="Where to put it.")
    clone.add_argument("--branch", help="The branch to follow (the remote's default otherwise).")
    clone.add_argument(
        "--or-init",
        action="store_true",
        help="If the remote is empty, create a new project there instead of failing.",
    )
    _add_storage_arguments(clone)

    sync = sub.add_parser(
        "sync",
        help="Commit and exchange the text with git; exchange papers with storage.",
    )
    sync.add_argument("path", type=Path, nargs="?", default=Path.cwd())
    sync.add_argument(
        "--git-remote",
        metavar="URL",
        help="Set the remote first, making the project a repository if it is not one.",
    )
    sync.add_argument(
        "--all-papers",
        action="store_true",
        help="Fetch every PDF now, rather than each when it is first opened.",
    )
    sync.add_argument(
        "--keep",
        choices=("mine", "theirs"),
        help="Settle a conflict with the remote by keeping one side.",
    )

    serve = sub.add_parser("serve", help="Serve an existing project in the browser.")
    serve.add_argument("path", type=Path, nargs="?", default=Path.cwd())
    serve.add_argument("--port", type=int, default=DEFAULT_PORT)
    serve.add_argument(
        "--host",
        default=HOST,
        help=(
            "Interface to bind. Defaults to 127.0.0.1. Use 0.0.0.0 to reach the "
            "server through a reverse proxy or port-forward."
        ),
    )
    serve.add_argument(
        "--allow-host",
        action="append",
        default=[],
        metavar="HOSTNAME",
        help=(
            "Accept this hostname in the Host header, for use behind a proxy. "
            "Repeatable. Pass '*' to accept any hostname."
        ),
    )
    serve.add_argument("--open", action="store_true", help="Open a browser window.")
    serve.add_argument("--reload", action="store_true", help="Reload on code changes (dev).")
    serve.add_argument(
        "--backend",
        choices=("claude", "fake"),
        help="Agent backend. 'fake' is for tests and offline UI work.",
    )
    serve.add_argument(
        "--dev-origin",
        help="Additionally accept this origin, for the Vite dev server (dev only).",
    )

    doctor = sub.add_parser("doctor", help="Check the workspace, sync, and agent setup.")
    doctor.add_argument("path", type=Path, nargs="?", default=Path.cwd())

    from .client import add_commands

    add_commands(sub)
    return parser


def _add_storage_arguments(parser: argparse.ArgumentParser) -> None:
    group = parser.add_argument_group(
        "paper storage",
        "Where the PDFs live when they are not on this machine. Credentials are "
        "read from the environment (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY), "
        "never from the project.",
    )
    group.add_argument("--s3-bucket", metavar="NAME", help="Keep papers in this S3 bucket.")
    group.add_argument("--s3-prefix", metavar="PATH", help="Under this prefix in the bucket.")
    group.add_argument(
        "--s3-endpoint",
        metavar="URL",
        help="For S3-compatible services (R2, B2, MinIO); unset for AWS.",
    )
    group.add_argument("--s3-region", metavar="NAME")
    group.add_argument(
        "--storage-dir",
        metavar="PATH",
        help="Keep papers in a directory instead: a mounted volume, a synced folder.",
    )


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
    )
    try:
        if args.command == "init":
            return cmd_init(args)
        if args.command == "clone":
            return cmd_clone(args)
        if args.command == "sync":
            return cmd_sync(args)
        if args.command == "serve":
            return cmd_serve(args)
        if args.command == "doctor":
            return cmd_doctor(args)
        from .client import COMMANDS, run

        if args.command in COMMANDS:
            return run(args)
    except WorkspaceError as exc:
        print(f"error: {exc.message}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130
    return 2


def _storage_table(args: argparse.Namespace) -> dict[str, str]:
    """The storage the command line asked for, falling back to the environment."""
    from .storage import storage_settings

    if getattr(args, "storage_dir", None):
        return {"backend": "directory", "path": str(args.storage_dir)}
    if getattr(args, "s3_bucket", None):
        table = {"backend": "s3", "bucket": args.s3_bucket}
        for key, value in (
            ("prefix", args.s3_prefix),
            ("endpoint_url", args.s3_endpoint),
            ("region", args.s3_region),
        ):
            if value:
                table[key] = value
        return table
    # A container starting empty names its bucket in the environment; written
    # into the project, the next clone knows it without being told.
    return {key: str(value) for key, value in storage_settings({}).items()}


def cmd_init(args: argparse.Namespace) -> int:
    from .gitsync import GitSync
    from .storage import storage_toml

    table = _storage_table(args)
    workspace = Workspace.initialize(
        args.path, name=args.name, extra_settings=storage_toml(table) if table else ""
    )
    print(f"Created project at {workspace.root}")
    print(f"  {workspace.notes_dir.relative_to(workspace.root)}/welcome.md")
    if table:
        where = table.get("bucket") or table.get("path")
        print(f"  papers are stored in {table['backend']}: {where}")
    if args.git or args.git_remote:
        git = GitSync(workspace.root, workspace.settings(), papers_in_storage=bool(table))
        git.init(args.git_remote)
        print("  text is versioned with git" + (f", remote {args.git_remote}" if args.git_remote else ""))
    print()
    print("Next:")
    print(f"  litmark serve {args.path} --open")
    return 0


def cmd_clone(args: argparse.Namespace) -> int:
    from .gitsync import clone

    clone(args.url, args.path, branch=args.branch)
    workspace = Workspace(args.path)
    if not workspace.exists() and args.or_init and _is_empty_clone(args.path):
        # A remote with nothing in it yet: this is where the project begins.
        from .gitsync import GitSync
        from .storage import storage_toml

        table = _storage_table(args)
        workspace = Workspace.initialize(
            args.path, extra_settings=storage_toml(table) if table else ""
        )
        GitSync(workspace.root, workspace.settings(), papers_in_storage=bool(table)).init(args.url)
        print(f"The remote was empty; created a new project at {workspace.root}")
        if table:
            print(f"  papers are stored in {table['backend']}: {table.get('bucket') or table.get('path')}")
        return 0
    if not workspace.exists():
        print(
            f"error: {args.path} was cloned, but it is not a Litmark project "
            "(no project.toml).",
            file=sys.stderr,
        )
        return 1
    workspace.open()
    print(f"Cloned project to {workspace.root}")
    print("  papers are fetched from the project's storage as they are opened")
    print()
    print("Next:")
    print(f"  litmark serve {args.path} --open")
    return 0


def _is_empty_clone(path: Path) -> bool:
    """A clone of a remote that has no commits: nothing but the `.git` directory."""
    return (path / ".git").exists() and not [
        entry for entry in path.iterdir() if entry.name != ".git"
    ]


def cmd_sync(args: argparse.Namespace) -> int:
    """One round of sync, to completion: for a terminal, a cron job, a hook."""
    import time

    from .services import open_services

    services = open_services(args.path)
    try:
        if args.git_remote:
            services.git.init(args.git_remote)
        if args.all_papers:
            services.papers.prefetch = True

        result = services.sync_now(resolve=args.keep)
        git = result["git"]
        storage = result["storage"]
        print(f"text: {git['message']}")
        if git.get("remote"):
            print(f"  remote: {git['remote']} ({git.get('branch')})")
        if result["pulled"]:
            print(f"  brought in {len(result['pulled'])} changed file(s)")
        if storage["enabled"]:
            # The transfers were queued as jobs; with no server running, run
            # them here and wait.
            _run_jobs(services)
            after = services.papers.status()
            print(f"papers: {storage['where']}")
            print(f"  {after['pdfs_here']} of {after['documents']} PDFs on this machine")
        elif storage.get("problem"):
            print(f"papers: {storage['problem']}")
        else:
            print("papers: no storage configured; PDFs stay on this machine")
        for problem in result["problems"]:
            print(f"error: {problem}", file=sys.stderr)
        if git.get("state") == "conflict":
            print("  settle it with: litmark sync --keep mine   (or: --keep theirs)", file=sys.stderr)
        failed = services.db.query("SELECT kind, error FROM jobs WHERE status = 'failed'")
        for row in failed[-5:]:
            print(f"error: {row['kind']}: {row['error']}", file=sys.stderr)
        time.sleep(0)  # Nothing is left running; the database closes below.
        return 1 if result["problems"] or git.get("state") == "conflict" else 0
    finally:
        services.jobs.shutdown()
        services.db.close()


def _run_jobs(services: object) -> None:
    """Run queued jobs to completion on a loop of our own."""
    import asyncio

    async def drain() -> None:
        services.bind_loop(asyncio.get_running_loop())  # type: ignore[attr-defined]
        services.jobs.recover()  # type: ignore[attr-defined]
        for _ in range(200):
            await services.jobs.drain(timeout=600)  # type: ignore[attr-defined]
            await asyncio.sleep(0.05)
            pending = services.db.query(  # type: ignore[attr-defined]
                "SELECT id FROM jobs WHERE status IN ('queued', 'running')"
            )
            if not pending:
                return

    asyncio.run(drain())


def cmd_serve(args: argparse.Namespace) -> int:
    import uvicorn

    from .api.access import access_from_environment
    from .api.app import create_app, static_root
    from .mcpserver import MCP_PATH, TOKEN_ENV, check_token, require_library
    from .services import open_services

    services = open_services(args.path, backend_name=args.backend)

    allowed_hosts = set(args.allow_host)
    loopback = args.host in {"127.0.0.1", "localhost", "::1"}
    if not loopback and not allowed_hosts:
        # Binding beyond loopback is a deliberate act, usually for a proxy whose
        # public hostname this process cannot know. Rejecting every Host header
        # would make that setup fail confusingly, so widen the check and say so.
        allowed_hosts = {"*"}
    # From the environment only: a password on a command line is in every
    # process listing.
    password = os.environ.get(PASSWORD_ENV) or None
    # Likewise the token that lets sessions elsewhere use the project over MCP.
    mcp_token = os.environ.get(TOKEN_ENV) or None
    if mcp_token:
        mcp_token = check_token(mcp_token)
        require_library()
    # Cloudflare Access in front of /mcp, for connectors that sign in with
    # OAuth: the team and the application's audience. Not secrets, but read
    # from the environment like the rest of the MCP settings.
    access = access_from_environment()
    if access:
        require_library()
    app = create_app(
        services,
        dev_origin=args.dev_origin,
        allowed_hosts=allowed_hosts,
        password=password,
        mcp_token=mcp_token,
        access=access,
    )

    display_host = "127.0.0.1" if args.host == "0.0.0.0" else args.host
    url = f"http://{display_host}:{args.port}/"
    availability = services.agent_availability()

    print(f"Litmark — {services.workspace.root}")
    print(f"  {url}")
    if not loopback:
        print(f"  bound to {args.host}:{args.port} — reachable beyond this machine.")
        if password:
            print(f"  a password is required ({PASSWORD_ENV}); serve it behind TLS.")
        else:
            print("  the session credential in the served page is the only access control:")
            print("  anyone who can reach this address can use it, agent included.")
            print(f"  set {PASSWORD_ENV}, or keep it on a private network or an SSH tunnel.")
    if allowed_hosts and allowed_hosts != {"*"}:
        print(f"  additional accepted hostnames: {', '.join(sorted(allowed_hosts))}")
    if static_root() is None:
        print("  warning: browser assets are not built; run `npm --prefix frontend run build`")
    storage = services.papers.status()
    if storage["enabled"]:
        print(f"  papers: {storage['where']}")
    elif storage["problem"]:
        print(f"  papers: storage is not usable — {storage['problem']}")
    usable, reason = services.git.availability()
    if services.git.automatic:
        remote = services.git.status().get("remote")
        print(f"  text: committed to git as you work" + (f", synced with {remote}" if remote else ""))
    elif reason and usable:
        print(f"  text: {reason}")
    if mcp_token or access:
        print(f"  mcp: {url.rstrip('/')}{MCP_PATH} — other sessions may read and write here,")
        if mcp_token:
            print(f"       with the token in {TOKEN_ENV} as a bearer credential.")
        if access:
            print(f"       through Cloudflare Access ({access.team_domain}), by its signed assertion.")
    if availability.ready:
        print(f"  agent: {availability.backend} ready")
    else:
        print(f"  agent: not configured — {availability.message}")
        print("  notes and PDFs work regardless; summaries and chat need an agent.")
    print("  Ctrl-C to stop.")
    # stdout is block-buffered when redirected to a file or a supervisor, which
    # would otherwise swallow this banner until the process exits.
    sys.stdout.flush()

    if args.open:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()

    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        log_level="debug" if args.verbose else "warning",
        access_log=False,
    )
    return 0


def cmd_doctor(args: argparse.Namespace) -> int:
    from .api.app import static_root
    from .services import open_services

    print(f"python: {sys.version.split()[0]}")

    assets = static_root()
    print(f"browser assets: {'found at ' + str(assets) if assets else 'MISSING (not built)'}")

    workspace = Workspace(args.path)
    if not workspace.exists():
        print(f"project: not a project directory ({workspace.root})")
        print("  run: litmark init <path>")
        return 1
    print(f"project: {workspace.root}")

    services = open_services(args.path)
    try:
        documents = services.documents.list()
        pending = [
            document.document_id
            for document in documents
            if document.extraction.get("status") not in ("ok", "failed")
        ]
        failed = [
            document.document_id
            for document in documents
            if document.extraction.get("status") == "failed"
        ]
        print(f"documents: {len(documents)} imported, {len(pending)} awaiting extraction")
        if failed:
            print(f"  extraction failed: {', '.join(failed)}")
        print(f"notes: {len(services.workspace.list_notes())}")
        print(f"references: {len(services.references.all())}")

        storage = services.papers.status()
        if storage["enabled"]:
            print(f"paper storage: {storage['backend']} — {storage['where']}")
            try:
                services.papers.store.check()  # type: ignore[union-attr]
                print("  reachable: yes")
            except WorkspaceError as exc:
                print(f"  reachable: no — {exc.message}")
            print(f"  PDFs on this machine: {storage['pdfs_here']} of {storage['documents']}")
        elif storage["problem"]:
            print(f"paper storage: MISCONFIGURED — {storage['problem']}")
        else:
            print("paper storage: none (PDFs stay on this machine)")

        git = services.git.status()
        if git.get("state") == "off":
            print(f"git: off — {git.get('message')}")
        else:
            print(f"git: {git.get('message')}")
            print(f"  branch: {git.get('branch')}; remote: {git.get('remote') or 'none'}")
            print(f"  automatic: {'yes' if git.get('automatic') else 'no'}")

        availability = services.agent_availability()
        print(f"agent backend: {availability.backend}")
        print(f"  installed: {'yes' if availability.installed else 'no'}")
        print(f"  authenticated: {'yes' if availability.authenticated else 'no'}")
        print(f"  {availability.message}")
        if availability.detail:
            print(f"  {availability.detail}")
        # Credentials are never printed, only reported as present or absent.
        return 0 if availability.ready and assets else 1
    finally:
        services.db.close()


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
