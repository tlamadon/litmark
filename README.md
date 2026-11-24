# Litmark

A local research application: import papers, read short cited summaries, write
Markdown notes, inspect the cited PDF passages, and chat with a coding agent
that can search the project and edit its files.

**Import papers → ask questions → write a sourced note → inspect the evidence → refine the note.**

Everything you write stays as ordinary files in a movable project directory:
`notes/*.md`, `documents/<id>/original.pdf`, `references.json`. The application
is a convenient view onto those files, not their owner.

## Install

```bash
python -m pip install litmark          # core reader and editor
python -m pip install 'litmark[claude]'  # plus the agent adapter
```

Requires Python 3.11+. Tested on macOS and Linux. The published wheel contains
the compiled browser assets — **you do not need Node, npm, or a second web
server to run this application.**

With `pipx` or `uv`:

```bash
pipx install litmark
uv tool install litmark
```

## Use

```bash
litmark init ./my-research
litmark serve ./my-research --open
```

`serve` binds to `127.0.0.1`, prints the local URL, and serves exactly one
project per process. Reopening an existing project needs no initialization, and
`init` never overwrites existing material.

### Reaching it through a proxy or port-forward

By default the server binds to loopback *and* rejects any `Host` header that is
not a loopback name. That second check is what stops a malicious page from
using DNS rebinding to talk to your local server — but behind a reverse proxy
or a port-forward the header carries the proxy's hostname, so the check would
reject every real request. Widen it explicitly:

```bash
# Bind beyond loopback; any Host header is then accepted.
litmark serve ./my-research --host 0.0.0.0

# Or name the proxy's hostname and keep the check strict.
litmark serve ./my-research --host 0.0.0.0 --allow-host papers.internal
```

The per-process session credential embedded in the served page remains the
access control in both cases. On an untrusted network prefer an SSH tunnel,
which keeps the default loopback binding intact:

```bash
ssh -N -L 8765:127.0.0.1:8765 you@the-machine
```

Check your environment at any time:

```bash
litmark doctor ./my-research
```

`doctor` reports on the workspace, the optional agent dependency, the runtime
it needs, and whether authentication is configured — without printing secrets.

## Agent configuration

The agent backend is the [Claude Agent SDK for
Python](https://code.claude.com/docs/en/agent-sdk/python), behind a
provider-neutral adapter. Provider credentials and billing are separate from
installing this application; a consumer chat subscription does not by itself
grant SDK access.

The reader and editor work with no agent account at all. Import and text
extraction still run; automatic summaries wait until an agent is configured,
and the interface says so plainly.

The agent sees this project and nothing else. It is given the project's own
tools — search, read pages, resolve a quotation, version-checked edits — and
none of what you have set up for your own Claude Code sessions: no personal MCP
servers, plugins, hooks, skills, or memory. A PDF is untrusted text, so nothing
beyond the project is within the agent's reach; it also keeps the start of
every conversation small.

Optional settings in `project.toml`:

```toml
[agent]
model = "claude-opus-5"   # what answers; the adapter's default when unset
effort = "medium"         # reasoning effort, when the model takes one
max_parallel_runs = 3     # conversations that may be working at once
auto_summary = true       # summarize a paper when it is imported
```

## Conversations

The chat drawer holds as many conversations as you like, and they do not wait
on each other: ask a long question in one, start another, and both work. The
header names the conversation on screen; its menu lists the rest — most recent
first, with a dot on any that is working or has answered since you looked —
and renames, exports, or deletes the current one. A conversation is named for
the first thing asked in it.

Each conversation keeps its own thread with the agent, so coming back to one
next week carries on where it stopped. If the agent's saved session can no
longer be reopened (the project moved, or another machine opened it), the next
reply starts a new one from the transcript kept in the project, and says so.

A turn shows the agent's prose in full and one line per step in plain terms —
*read Mobility Restrictions, pp. 3–5*, *cited p. 12*, *edited note “Findings”*
— and each line opens what it names: the paper at that page, the highlighted
passage, the note. Edits are listed under the turn with an undo. The
**Transcript** tab shows the same turns verbatim, every tool call with its
arguments. Both views are drawn from the run's recorded events, so what a turn
did is still there after a reload.

Summaries of imported papers run as background work in a conversation of their
own, listed at the bottom of the menu, and never in the middle of yours.

## A memory for other sessions (MCP)

A project is also somewhere other Claude sessions can remember things. A
session in a terminal on another machine, talking about a paper, can ask this
project what it already holds, set down what it learns, and send in the paper
itself — and what it writes shows up here, beside the PDF, cited and editable
like anything else.

It is off until the server is started with an access token, taken from the
environment so it is never in a file of the project. It needs the `mcp` extra
(`pip install 'litmark[mcp]'`; the container image has it):

```bash
export LITMARK_MCP_TOKEN="$(openssl rand -hex 32)"
litmark serve ./my-research --host <tailscale-address> --allow-host <its-name>
```

The server then answers MCP at `/mcp` (streamable HTTP), asking for the token
as a bearer credential. To connect Claude Code:

```bash
claude mcp add --transport http litmark http://<its-name>:8765/mcp \
  --header "Authorization: Bearer $LITMARK_MCP_TOKEN"
```

Add `--header "X-Litmark-Client: laptop"` to choose the name its edits are
recorded under; otherwise it is what the client calls itself (`claude-code`).

A session gets the tools the agent inside has, and two ways of using them as a
memory:

- **Learning from earlier work.** `recall` searches notes, summaries and the
  papers' text in one call; `read_note`, `read_summary` and `read_pages` then
  give what it points to in full.
- **Setting something down.** `append_note` adds to the end of a note without
  reading or disturbing the rest, creating the note if need be. `write_note`
  and `patch_note` revise, under the same version check as every other edit.
  `resolve_source` turns a quotation into a citation you can click.
- **Adding a paper.** A tool call carries JSON, not files, so `add_paper`
  answers with a one-time upload address and the session sends the PDF to it
  (`curl -T paper.pdf <address>`). The address expires after fifteen minutes,
  works once, and needs no other credential. The reply names the new paper once
  its text is extracted. A session with no way to make an HTTP request cannot
  add papers; import those in the browser.

**What a session elsewhere did is on the record.** Each of its edits, imports
and tag changes is listed under *Recent edits* with the client's name, set
apart from yours and the built-in agent's, and edits to notes and summaries can
be undone there. The git commit that carries such an edit says so in its
message (`Edited over MCP by claude-code: note reading-log`), so the
attribution travels with the project. A session cannot choose the name it is
recorded under beyond that header, and cannot overwrite an edit it has not
read: a stale write is refused, as it is for everyone.

**The token is the whole of the protection**, and it is sent in the clear over
plain HTTP. Keep the server on a private network (Tailscale, WireGuard) or
behind TLS. Whoever holds the token can read every paper and note and rewrite
them. With `LITMARK_PASSWORD` also set, the browser is still asked for the
password; `/mcp` asks for the token instead.

## Tags

A tag is your own label for gathering papers: a field, a year's job market, a
candidate, a shortlist. Tags are free text — there is nothing to set up before
the first paper can be put in a pile. One written `group:value`
(`field:labor`, `jmp:2026`, `author:Card`) is shown under its group, which is
all the structure there is.

- **Filter.** Every tag in use is a chip above the list of papers, with a
  count. Click one to see only the papers carrying it; click several to narrow
  to papers carrying all of them. *untagged* lists the papers with none.
- **Tag one paper** with **Tag** / **Edit tags** under it, or **all the papers
  listed** with **Tag these N…** — filter to *untagged* after a batch import,
  and one tag gathers the batch.
- **Import into a collection.** PDFs dropped in while a tag filter is on arrive
  already carrying those tags.
- **In chat**, type a tag in the paper picker and **Attach all** to hand the
  agent a whole collection. The agent sees every paper's tags, can list and
  search within a tag (*"which of the jmp:2026 papers use an event study?"*),
  and tags papers when you ask it to (*"tag each by field"*).

Typing a tag in a different case than one already in use takes the existing
spelling, so `Labor` and `labor` do not become two collections. Tags are stored
in each paper's `metadata.json`, so they travel with the project through git,
and they are written to `references.bib` as `keywords`.

## Sync: text in git, papers in storage

A project is two kinds of material, and each travels the way that suits it.

**Text goes through git, and Litmark does the committing.** Notes, summaries,
the reference registry and each paper's `metadata.json` are small files that
merge well. Make the project a repository and Litmark commits what changed once
your edits have settled, brings in what the remote has, and publishes — on its
own, and when you press **Sync now**:

```bash
litmark init ./my-research --git-remote git@github.com:you/research.git
# or, for a project that already exists:
litmark sync ./my-research --git-remote git@github.com:you/research.git
```

Commit messages say what happened in the project's terms (*Add 2 papers;
update note findings*). The top bar shows where things stand. If the same
lines were changed here and elsewhere, nothing is overwritten: your copy stays
exactly as it was, your commits are published to a side branch so they exist
somewhere other than this disk, and you choose which version of the clashing
lines to keep — everything else from both sides is kept either way.

Litmark only ever acts on a repository whose top level *is* the project. A
project that merely sits inside some other repository is left alone.

**Papers go to a store, addressed by their hash.** A PDF is megabytes that
never change, which git handles badly. Name a bucket and the PDFs go there,
under the SHA-256 the project already records for each document:

```bash
litmark init ./my-research --git-remote … \
  --s3-bucket my-papers --s3-prefix research \
  --s3-endpoint https://<account>.r2.cloudflarestorage.com   # omit for AWS
```

```toml
# project.toml — travels with the project, so a clone already knows its bucket
[storage]
backend = "s3"            # or "directory", with `path = "/mnt/papers"`
bucket = "my-papers"
prefix = "research"
endpoint_url = "https://…"   # any S3-compatible service; unset for AWS
prefetch = false          # true fetches every PDF up front
```

Credentials are never in the project: S3 uses the standard chain
(`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` in the environment, a shared
credentials file, or the machine's role). Install the extra with
`pip install 'litmark[s3]'`.

On another machine, `litmark clone <remote> ./my-research` brings the text.
The extracted text of every paper is fetched as soon as the project opens, so
search and the agent work across the whole library at once; each PDF is
fetched the first time it is opened, and checked against its hash. With no
storage configured the PDFs simply stay in git.

`litmark sync [path]` does one round from a terminal; `--all-papers` fetches
every PDF, and `--keep mine|theirs` settles a conflict. `litmark doctor`
reports whether the store is reachable.

Conversations are not synced. They stay on the machine they were held on; the
notes and summaries they produced are files, and travel.

Run one copy at a time, or let each sync before working in the other: document
and reference IDs are handed out in sequence (`doc-004`, `ref-012`), so two
copies that both import papers before syncing will both claim the next number,
and git will report that as a conflict rather than merge it.

## Running it in a container

The image holds the server, the browser assets, the agent runtime and git;
nothing in it is precious, because text is in the remote and papers in the
bucket.

An image is published for every release, for amd64 and arm64:

```bash
docker pull ghcr.io/tlamadon/litmark:latest
```

Releases are versioned MAJOR.MINOR.PATCH, and each is published under tags of
decreasing precision, so a deployment chooses how much it wants to move:

| Tag | What it is |
| --- | --- |
| `1.2.3` | Exactly that release. Never moves. |
| `1.2` | The newest patch of 1.2. |
| `1` | The newest release of major version 1. |
| `latest` | The newest release. |
| `main`, `sha-<commit>` | Unreleased builds of `main`, for trying a change before it is tagged. |

To release, set `__version__` in `src/litmark/__init__.py` (the one place the
version is written), commit, and push a tag of `v` + that version:

```bash
git tag v1.2.3 && git push origin main v1.2.3
```

It is built by `.github/workflows/container.yml`, which runs the tests, then
starts the image and checks that it works (`docker/smoke-test.sh`) before
anything is pushed. To build it yourself instead: `docker build -t litmark .`

```bash
docker run -d --name litmark -p 127.0.0.1:8765:8765 -v litmark-data:/data \
  -e LITMARK_GIT_REMOTE=https://github.com/you/research.git \
  -e LITMARK_GIT_TOKEN=… \
  -e LITMARK_S3_BUCKET=my-papers -e AWS_ACCESS_KEY_ID=… -e AWS_SECRET_ACCESS_KEY=… \
  -e ANTHROPIC_API_KEY=… \
  -e LITMARK_PASSWORD=… \
  ghcr.io/tlamadon/litmark:latest
```

On first start it clones the remote; if the remote is empty it creates the
project there, with the bucket named in the environment written into
`project.toml` so the next clone needs no telling. `docker/compose.example.yaml`
is the same thing as a Compose file.

| Variable | Purpose |
| --- | --- |
| `LITMARK_GIT_REMOTE` | The project's git remote. Without it the text lives only in the volume. |
| `LITMARK_GIT_TOKEN` | A token for an `https` remote. Passed to git by environment, never written to disk. Or mount an SSH key. |
| `LITMARK_S3_BUCKET`, `_PREFIX`, `_ENDPOINT`, `_REGION` | Where papers go, when the project is first created. |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Credentials for the bucket. |
| `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` | The agent's credential. The second is what `claude setup-token` issues, for using a subscription where no browser sign-in is possible. |
| `LITMARK_PASSWORD` | Asked for by the browser before anything is served. |
| `LITMARK_MCP_TOKEN` | Opens `/mcp` to other sessions holding this token. Unset, it is not served. See [A memory for other sessions](#a-memory-for-other-sessions-mcp). |

**Set a password, and put TLS in front.** Without `LITMARK_PASSWORD`, anyone
who can reach the port can read the project and run the agent on your account.
The password is HTTP Basic, so it protects nothing in transit by itself: serve
it through a TLS-terminating proxy, or keep it on a private network
(Tailscale, WireGuard). The example publishes the port on loopback only for
that reason. This is access control for one person, not multi-user hosting.

## Project layout

| Path | Purpose |
| --- | --- |
| `project.toml` | Schema version and non-secret project settings. |
| `documents/<id>/original.pdf` | Original immutable PDF. |
| `documents/<id>/metadata.json` | Identity, hash, filename, title, page count, tags, status. |
| `documents/<id>/pages.json` | Per-page text, character geometry, offset mapping. |
| `documents/<id>/summary.md` | Editable, cited summary. |
| `notes/*.md` | User and agent notes. |
| `references.json` | Versioned source registry. |
| `references.bib` | Generated BibTeX bibliography of the imported documents. |
| `.gitignore` | Written when the project is a repository: keeps `.research/`, extracted text, and stored PDFs out of git. |
| `.research/state.sqlite` | Conversations, events, jobs, run state, change log. |
| `.research/history/` | Previous file contents, for review and undo. |
| `.research/runs/` | Staged agent edits and run diagnostics. |

## Reading and editing

A summary or a note opens for **reading**: fully rendered, with no cursor to
mind. A click does not open the Markdown under it, and a click on a citation
opens the paper at the cited passage. To change the text, **double-click** it
— editing starts with the cursor where you clicked — or press **Edit**.
**Escape**, or **Read**, goes back. A note you have just created opens ready
to be written in, and inserting a reference from the paper switches to editing
by itself, with the cursor after what was inserted.

Editing is live preview over the real Markdown: syntax is revealed around the
cursor and hidden elsewhere, and **Source** shows the whole text raw.

## Citations

A citation is an ordinary Markdown link with an application-specific
destination:

```markdown
The identification argument relies on a mobility restriction.
[Assumption 2, p. 12](source:ref-001)
```

It works in both directions. A citation in a note opens the paper at the
passage; a highlight in the paper, clicked, goes to the sentence that cites it
— in the note that is open, or by opening the note or summary that does. A
passage cited in several places is walked through by clicking it again. The
note is scrolled so the citation is centred, and the cursor stays where it
was: looking up where something is cited does not start an edit.

Citations in a note carry the same colours as the highlights in the paper: the
passage on show is one colour on both sides, and other citations another.

`ref-001` resolves through `references.json`, which records the document, the
immutable PDF content hash, the one-based physical page number, the quoted
passage, and normalized highlight rectangles. Reference resolution validates
*where* a passage is, not whether it supports the claim — you assess that by
reading the evidence.

## Bibliography

**Write .bib** in the sidebar generates `references.bib` in the project
directory, and **Download** fetches the same file without writing it. There is
one entry per imported document — a `.bib` entry is a work, so the page each
reference points at travels in the `\cite[p.~12]{key}` command the export
returns alongside the entries, not in the entry itself.

Entries carry only what the PDF actually supplies. A paper with no author
metadata gets an entry with no `author` field and a warning saying so; nothing
is filled in from general knowledge. The output is deterministic, so exporting
an unchanged bibliography rewrites nothing, and a `.bib` you edited by hand is
copied into `.research/history/` before it is replaced.

## Development

```bash
uv venv && uv pip install -e . --group dev
npm --prefix frontend install
npm --prefix frontend run build      # writes src/litmark/static/
uv run pytest
uv run litmark serve ./my-research --reload
```

`npm run dev` runs the frontend with hot reload against a server started
separately on port 8765.

### Tests

```bash
uv run pytest                     # server and acceptance criteria
uv run pytest --runslow           # plus: build the wheel, install it clean, serve it
npm --prefix frontend test        # renderer unit tests, and the bundle run in a DOM

# Real-browser checks (A2 live preview, A6 highlight geometry under zoom).
# Point it at a project whose open note contains a source: citation.
litmark serve ./my-research &
LITMARK_BASE_URL=http://127.0.0.1:8765/ npm --prefix frontend run test:browser
```

The browser suite drives headless Firefox over Marionette. Headless Chromium is
deliberately not used: under some sandboxes it cannot reach loopback HTTP — it
returns an empty document where `curl` succeeds — so a Chromium suite passes
without having checked anything.

## Scope

v0.1 covers ingestion of text-based PDFs, cited summaries, Markdown live-preview
editing, PDF evidence with highlights, chat with one agent backend, and manual
references. Deferred: OCR, URL downloads, Word/HTML ingestion, Zotero
integration, semantic search, multiple agent providers, arbitrary analysis
execution, multi-user collaboration, full mobile editing, and public hosting.

## License

MIT.
