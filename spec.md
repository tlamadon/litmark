# Litmark

Product and implementation specification · Draft v0.1 · 22 September 2026

## 1. Purpose

Build a small research application that runs as a local Python web server and opens in the browser. Users import papers, read short summaries, write Markdown notes, inspect cited PDF passages, and chat with a coding agent that can search the project and edit its files.

The central experience is:

**Import papers → ask questions → write a sourced note → inspect the evidence → refine the note.**

The application is also a teaching example for an agentic research class. Its architecture and files should be understandable enough that students can inspect them, ask a coding agent to extend them, and verify the resulting behavior.

The package and command name is `litmark`, confirmed available on PyPI before the first release.

## 2. Product principles

1. **Markdown is the document.** Human and agent work ultimately produce ordinary, portable `.md` files.
2. **Evidence is one click away.** Source links open the correct PDF page and, where resolved, highlight the exact passage. The reverse holds too: a highlight in the PDF, clicked, goes to the sentence that cites it — in the open note, or by opening the note or summary that does — and clicking again walks through every place it is cited. Going there shows the citation, centred and marked, without moving the cursor or taking the keyboard focus; citations in a note carry the colours of the paper's highlights, the passage on show in one and the rest in another.
3. **The interface stays focused on research.** Present documents, notes, and conversation; expose technical activity only in an expandable detail view.
4. **The agent does real work.** Chat drives a coding-agent runtime with file and search tools, persistent sessions, and observable edits.
5. **Installation is simple.** A Python package contains the server and compiled browser assets.
6. **Work survives restarts.** Documents, summaries, notes, references, and conversations persist in a project directory.

## 3. Distribution and launch

Target Python 3.11 or newer, initially tested on macOS and Linux. Keep paths and process handling portable; Windows support requires its own installation and runtime checks before being advertised.

Intended installation and launch, after publication:

```bash
python -m pip install litmark
litmark init ./my-research
litmark serve ./my-research --open
```

For agent support, provide one optional dependency extra, initially proposed as:

```bash
python -m pip install 'litmark[claude]'
litmark doctor
```

Document virtual-environment installation, plus optional `pipx` or `uv tool` instructions. `doctor` checks the workspace, optional agent dependency, required runtime availability, and authentication configuration without printing secrets. Provider credentials and any provider billing remain separate from installing this application; do not promise that a consumer chat subscription supplies SDK access.

`serve` binds to `127.0.0.1` by default, accepts a port argument, prints the local URL, and optionally opens the browser. One server process serves one project. An existing project can be reopened without initialization or migration-induced data loss. Initialization must never overwrite existing material.

`serve` also accepts `--host` to bind another interface and `--allow-host` to name hostnames accepted in the `Host` header. This exists because loopback binding plus strict host validation makes the application unreachable behind a reverse proxy or an editor port-forward, which is a common way to use a remote workstation: the proxy's hostname is what arrives in the header, so every request is refused. Binding beyond loopback without naming a host widens host checking automatically, since the process cannot know the proxy's public name. The session credential remains the access control in all cases, and an SSH tunnel remains the recommended route on an untrusted network.

The core reader/editor works without an agent account. Import and extraction still work; automatic summaries wait until an agent is configured. Show this state clearly.

**End users do not run npm, build JavaScript, or start another web server.** Frontend development may use Node; published wheels and source distributions include the prebuilt browser assets. The optional agent adapter may carry its own runtime dependencies, which must be documented and checked independently.

## 4. Interface

Design for a laptop browser: quiet typography, readable text widths, resizable panes, and visible saved/working/error states.

| Area | Contents and behavior |
| --- | --- |
| Project sidebar | Documents and Notes sections, search, import button, new-note action, bibliography export; each document shows title, summary preview, and ingestion status. |
| Main editor | The current note or document summary, using Markdown live preview. It opens for reading: rendered, with nothing revealed or made editable by a click, and a click on a citation opens its source. A double-click on the text, or the Edit control, starts editing at that place; Escape or Read returns. A newly created note opens for editing, and inserting a reference switches to editing. *(v0.1 had editing only, so every click placed a cursor and opened the syntax under it — in the way when most use is reading and asking the agent.)* |
| Right source panel | PDF viewer, filename/title, page controls, zoom, search, and evidence highlights. The document scrolls continuously rather than a page at a time, and every registered mark in it is drawn, not only the one just opened. Which pages are rasterised is recomputed from the layout whenever the view moves — pages near the viewport are drawn, drawn pages are kept until far away — so no sequence of scrolls, jumps, and zooms leaves a page in view blank; a page that fails to draw says so and offers to try again. |
| Chat drawer | Several persistent conversations with a menu to switch between them, context attachments, streaming replies, a stop button, and each turn's steps shown one line apiece in the reader's terms. A transcript view shows the same turns verbatim. |

The sidebar, source panel, and chat drawer can collapse. Chat must not permanently shrink the editor and PDF into unreadable columns: the drawer's width is the user's to drag, within a floor and a ceiling of half the window. On narrower windows, the source panel may replace the main view, with an explicit return-to-note action. Full mobile editing is outside the initial scope.

### Markdown live preview

The desired interaction is similar to Obsidian live preview: users type Markdown syntax directly and see it rendered in place.

- `## Heading` displays as a heading; `**text**` appears bold.
- Syntax around the active editing range becomes visible and editable.
- Moving the cursor away hides formatting delimiters again.
- Source links appear as readable labels; editing reveals their Markdown syntax.
- Cmd/Ctrl-click opens a source. Provide a visible “Open source” action for users who do not use the shortcut.
- A plain click on a rendered citation must put the cursor inside it, revealing its Markdown and enabling the visible action. A rendered citation is an atomic range, so without this a plain click lands beside it and the citation reads as dead — the shortcut then becomes the only way in, which is the failure this bullet exists to prevent.
- A Source mode shows the complete Markdown text without presentation decorations.
- Cursor movement, selection, copy/paste, undo, and redo continue to operate on the underlying text.

Support headings, paragraphs, emphasis, lists, block quotations, fenced code, and links. Include inline and display LaTeX math in notes and chat, with source revealed for editing. Invalid or incomplete math must remain editable. Complex table editing can remain source-only initially.

Do not silently substitute a conventional rich-text editor that converts Markdown shortcuts into a separate document format. Markdown source should remain authoritative, including whitespace and syntax outside the user's edits.

### Save behavior

Autosave with a brief debounce, a visible save indicator, and Cmd/Ctrl-S for immediate saving. Preserve the buffer after failed saves. Reload clean buffers when project files change; preserve dirty buffers and surface a conflict when necessary.

## 5. Document ingestion and summaries

Accept one or multiple PDFs through drag-and-drop or a file picker. Start with uploaded, text-based PDFs; URL fetching, other office formats, and OCR are extensions.

For each upload:

1. Validate the input and configurable size limit; assign a stable document ID.
2. Compute a content hash and detect an already-imported identical PDF.
3. Store the original bytes unchanged, retaining the original filename as metadata.
4. Extract page text and text geometry in a background job.
5. Record page count, available title/author/year metadata, and extraction quality warnings.
6. Make the PDF available for reading as soon as it is stored.
7. Queue a short summary when extraction and agent configuration permit it.

Track extraction and summary status separately: a summary failure must not make a readable PDF look unavailable. Expose progress, retry, and a useful error message. Blank, image-only, encrypted, or partly unreadable PDFs must not silently produce confident summaries. Flag affected pages and distinguish partial extraction from a genuinely blank page where possible.

Default summaries are editable Markdown, approximately 150–250 words, covering:

- Research question.
- Data and method, including identification when relevant.
- Main findings.
- Main assumptions or limitations, distinguishing the paper's statements from the agent's assessment.

Use source links for substantive claims. Treat missing metadata as unknown. Avoid filling gaps from general knowledge. If only part of a document was successfully processed, display that limitation with the summary.

The agent can generate or revise a summary in response to chat. Regeneration creates a reviewable revision and preserves manual edits through the same version checks used for notes.

## 6. Sources, citations, and highlights

Use ordinary Markdown links with an application-specific destination:

```markdown
The identification argument relies on a mobility restriction.
[Assumption 2, p. 12](source:ref-001)
```

`ref-001` resolves through a project reference registry. Citation destinations work identically in notes, summaries, and chat. Reusing an existing reference ID is allowed.

Each reference records a document ID, immutable PDF content hash, physical page number, optional printed page label, selected quotation, and zero or more highlight rectangles. Physical page numbers are **one-based PDF page positions**, independent of printed page labels.

Example:

```json
{
  "schema_version": 1,
  "references": {
    "ref-001": {
      "document_id": "doc-001",
      "document_sha256": "<full SHA-256 of original PDF bytes>",
      "page_number": 12,
      "page_label": "10",
      "quote": "<verbatim passage extracted from this page>",
      "prefix": "<optional preceding text>",
      "suffix": "<optional following text>",
      "rects": [[0.12, 0.24, 0.86, 0.27]],
      "coordinate_space": "displayed-cropbox-normalized-top-left",
      "status": "resolved"
    }
  }
}
```

Rectangles use `[x0, y0, x1, y1]` in `[0,1]`, relative to the visible page after its native PDF rotation and crop box have been applied. Conversion to and from the viewer must be explicit; CSS pixels must never be stored. Multiple lines produce multiple rectangles. Additional viewer rotation must transform overlays consistently or be disabled initially.

### Two ways to create a reference

**Human selection:** select text on a single PDF page, then choose “Insert reference” or “Insert quotation and reference.” Insert the link at the last editor position. Multi-page selection is outside v0.1.

The browser sends the selected text with its surrounding context and the server locates it through the same resolver the agent uses, rather than storing geometry measured in the viewer. This keeps one source of truth for coordinates and means a human selection that cannot be matched uniquely reports `ambiguous` or `not_found` exactly as an agent's would, instead of silently recording a rectangle the extraction layer disagrees with.

**Agent selection:** the agent calls a source resolver with document ID, page number, exact quotation, and optional surrounding text. The resolver locates the text and computes geometry. Agents do not invent coordinates or allocate their own unregistered reference IDs.

Normalize whitespace, common ligatures, and line-break hyphenation with an offset mapping back to extracted characters. Repeated passages require contextual disambiguation. If a unique match cannot be established, return `ambiguous` or `not_found`; do not highlight an arbitrary region. A clearly marked page-only citation may be used when precise matching is unavailable.

Reference resolution validates location, not whether the passage actually supports the claim. The user assesses that by reading the evidence.

### Showing every mark

The source panel draws all of a document's resolved references at once, distinguished by where each is cited from: the note currently open, somewhere else in the project, or nowhere yet. Showing only the mark just opened hides what a reader most wants while reading — which passages they have already used, which came from another note, and which they registered but never cited. A key names the colours, each mark carries a tooltip naming its citing notes, and clicking one selects it; colour is never the only carrier of the distinction.

Which notes cite a reference is derived by reading the Markdown, not stored, because the files are the truth and any stored index goes stale the moment a note is edited outside the application. Citations inside fenced or inline code are ignored: a note documenting the citation syntax is showing an example, not citing it — the welcome note ships with exactly such an example.

A page-only citation has no rectangles and so draws no mark; the panel says the passage was not matched rather than highlighting an arbitrary region.

Changing the imported PDF creates a new document version/identity rather than silently moving old references to different bytes. Deleting or relocating a source must produce a recoverable missing-source state.

### Exporting a bibliography

A citation points at a passage; a bibliography lists the works those passages are in. The project exports an ordinary BibTeX file, `references.bib`, with **one entry per imported document** — not one per reference, which would turn every quotation into a separate work. The page belongs in the citation command instead, so the export also returns, for each reference ID, the `\cite[p.~12]{key}` that cites it, using the printed page label when the PDF has one and the physical page number otherwise.

Citation keys are surname, year, and first meaningful title word (`researcher2016mobility`), with a letter suffix when two works would collide. With no author the title word leads instead (`mobility2026`), since a key beginning with a digit reads badly and some tooling dislikes it. Given neither an author nor a year, the document ID is the key: one resting only on a title that was itself guessed from the first line of a PDF is neither stable nor unique.

Entries carry only what the document supplies — author, title, year, and the project-relative path of the original PDF — and use `@misc`, because an imported PDF does not say where it was published. Missing metadata is omitted and reported with the export, never filled in from general knowledge. Producers' placeholder values are treated as missing for the same reason: an entry crediting "anonymous" is worse than one that says the author is unknown, and the title rule in §5 already rejects "untitled". A reference whose document has been deleted produces a warning rather than an entry.

The file is derived but is an ordinary project file, so regeneration must not destroy work: the generated text is deterministic, an unchanged bibliography is not rewritten at all, and a `.bib` edited by hand is snapshotted into the history directory before it is replaced. An export can be narrowed to the works a note or summary actually cites — what a paper's reference list should contain — and covers every imported document by default.

Reference-manager integration (Zotero, CSL styles, venue metadata lookup) remains out of scope; this is a plain file the user can hand to LaTeX or import elsewhere.

## 7. Chat and the coding agent

Chat controls an existing coding-agent runtime through a Python adapter. This is a persistent agent session that can read files, search documents, call source tools, and produce file edits.

Example requests:

- “Summarize this paper's identification argument.”
- “Compare these two papers' assumptions.”
- “Write the comparison into my literature note with source links.”
- “Find evidence for this sentence.”
- “Revise the selected paragraph without changing the rest.”

Each submitted message includes explicit context: active note ID and revision, selected text if any, attached document IDs, and the current source reference/page. Show context chips so users can change the scope. These are starting context, not a claim that the agent has read every attached paper.

Prefer searching and reading relevant pages over placing the entire corpus in each prompt. Keyword search over extracted text is sufficient initially; an embedding service or vector database is not required.

### Runtime behavior

- Stream public assistant text, tool names/status, errors, and changed-file notifications.
- Persist chat history and backend session identifiers across browser reconnects.
- Permit stopping a run; stopping must cancel backend work, not merely hide output.
- Serialize agent runs per conversation, and let conversations run side by side up to a configurable limit (`[agent] max_parallel_runs`, default 3). Safety rests on the version checks every edit already goes through, not on running one thing at a time. Automatic summaries are background work in a conversation of their own, so they share one lane; when lanes are scarce, explicit user requests start ahead of queued summaries. *(v0.1 serialized all runs per project. A long question then held up every other one, and summaries ran inside the user's first conversation, resuming its session.)*
- On server restart, mark unfinished runs interrupted. Resume the conversation if the backend supports it, otherwise start a new backend session with the saved transcript/context and disclose that recovery. The same fallback applies whenever a saved session cannot be reopened — the project directory moved, or another machine opened it.
- Report tool/provider failures honestly; never replace a failed live run with simulated output.
- Keep read-only questions read-only. A request to create or edit a note authorizes that edit; do not require confirmation for every ordinary operation.

### Adapter and tools

Implement one live adapter first. The proposed default is the Claude Agent SDK for Python, behind a small provider-neutral interface. Its exact supported authentication and runtime requirements must be validated during the first integration milestone. A second backend is an extension, not a v0.1 requirement. The SDK provides a Python integration surface and session resumption; see its [official reference](https://code.claude.com/docs/en/agent-sdk/python).

The adapter exposes `start_run`, `cancel_run`, session recovery, and an asynchronous event stream. Normalize events into `text_delta`, `tool_started`, `tool_finished`, `file_proposed`, `file_changed`, `notice`, `error`, and `done`. Give events durable sequence IDs so reconnecting clients can replay without duplicating messages or edits.

The durable events of a run are also how an earlier conversation is drawn again: the browser folds the events it reads back with the same function that folds them live, so a reload shows what each turn did, not only what it said. The one exception to durability is the partial text of a reply as it streams. Those fragments are broadcast but not stored — the finished block replaces them — and each carries its offset in the block, so a browser that missed some shows nothing of that block until it arrives whole rather than text with a hole in it. A block the run never finished is stored as it stood, marked unfinished.

The agent runs hermetically. The runtime is told to load only the project's own tool server and no filesystem settings, so the user's personal MCP servers, plugins, hooks, skills, and memory are not part of a research session. This matters twice over: the agent runs with permission checks bypassed and reads PDFs, which are untrusted text, so nothing beyond the project tools may be within its reach; and those extras otherwise add tens of thousands of tokens to the start of every conversation.

Provide project tools with explicit schemas:

| Tool | Result |
| --- | --- |
| `list_documents` | IDs, metadata, tags, summaries, and availability status; optionally only the documents carrying given tags. |
| `tag_documents` | Tags added to, or removed from, one or more documents. |
| `search_documents` | Matching passages with document IDs and physical page numbers; optionally restricted to documents carrying given tags. |
| `recall` | What the project already holds on a subject, across notes, summaries and page text, with excerpts. |
| `read_pages` | Extracted page text and extraction warnings. |
| `read_note` | Markdown text and current revision/hash. |
| `resolve_source` | A registered reference ID or an explicit matching failure. |
| `write_note` / `patch_note` | A version-checked edit with a persisted change record. |
| `append_note` | Text added at the end of a note (created if absent), without the caller reading it first. |
| `read_summary` / `write_summary` | A document summary and its revision; writes are version-checked like notes. |
| `list_notes` | Note IDs, titles, and revisions. |

`read_summary` and `write_summary` are not optional extras: §5 requires the agent to generate and revise summaries under the same version checks as notes, which it cannot do through the note tools alone. `list_notes` lets the agent find a note the user referred to by name rather than by ID.

Use the agent runtime's tool loop; avoid terminal screen scraping. Configure its available tools explicitly — with the Claude Agent SDK this means the `tools` allowlist, not only `allowed_tools`/`disallowed_tools`, which still let the runtime load its own built-ins such as tool search. Any direct file editing must go through staging and the versioned commit mechanism below. Disable unrestricted shell and unrelated host tools in the initial research mode; running arbitrary analysis code can be added as a separately scoped capability.

## 8. Human and agent editing

Prevent silent overwrites when the user and agent work on the same note.

1. Every read returns the file's content hash as its revision.
2. Editor saves include the expected revision; the server checks it under a write lock and uses an atomic file replacement.
3. Agent edits are prepared against a known base revision, through project tools or in a run-specific staging directory.
4. The server commits an agent edit only if its base still matches. Validate referenced IDs before publishing generated content.
5. On conflict, preserve the proposed edit and the user's version, then show a comparison with explicit choices. Do not implement automatic three-way merging in v0.1.

Edits are saved after a short pause, and at once when the buffer is left for another or the tab is hidden, so what was typed just before switching notes is not lost; a save already under way goes first, so the last one is checked against the revision it produced. A clean editor buffer refreshes when an agent edit lands. A dirty buffer remains intact and is offered conflict resolution. Saving pending user edits before submitting chat helps, but does not replace version checks.

Maintain file snapshots and an edit log for undo. Undo is itself version-checked so it cannot remove later human edits. Cancellation preserves already committed edits, identifies them in the conversation, and discards uncommitted proposals unless retained for review. Arbitrary external editors cannot be made fully transactional; detect their changes and preserve recovery snapshots.

## 9. Project storage

Keep user material as files in a movable project directory. Proposed layout:

| Path | Purpose |
| --- | --- |
| `project.toml` | Schema version and non-secret project settings. |
| `documents/<id>/original.pdf` | Original immutable PDF. |
| `documents/<id>/metadata.json` | Identity, hash, original filename, title, page count, tags, ingestion status. |
| `documents/<id>/pages.json` | Per-page text, character geometry, offset mapping, extraction version/warnings. |
| `documents/<id>/summary.md` | Editable, cited summary. |
| `notes/*.md` | User and agent notes. |
| `references.json` | Versioned source registry. |
| `references.bib` | Generated BibTeX bibliography of the imported documents. |
| `.research/state.sqlite` | Conversations, durable events, jobs, run state, and change log. |
| `.research/history/` | Previous file contents for review and undo. |
| `.research/runs/` | Staged edits and run diagnostics. |

The database stores application state; it is not the sole home of notes or source evidence. Document copies, notes, and references must remain usable outside the app. Export chat transcripts as Markdown or JSON on request. Rebuildable indexes may live in SQLite. Register references before writing links that use them; unused registry entries are harmless after interrupted writes.

### Tags

*(Added after v0.1.)* A document carries zero or more tags: short free-text labels the user assigns to gather papers — by field, by a year's job market, by candidate. There is no schema. A tag containing a colon is read as `group:value`, and the interface gathers such tags under their group; that convention is the only structure.

- Tags are stored, sorted, in `metadata.json`, so they are project text: versioned, synced, and usable outside the application. They appear in the generated bibliography as `keywords`.
- Tags are unique within a document whatever their case, and a tag typed in a different case than one already in the project takes the existing spelling.
- The document list can be narrowed to the documents carrying every selected tag, or to those with none. Tags can be set on one document, added to every listed document at once, and given at import.
- The agent sees tags, can restrict listing and search to them, and changes them only on request.
- Every write to `metadata.json` — extraction status, summary status, tags — is a single read-modify-write under one lock, so concurrent writers cannot erase each other's part.

### Sync between machines

*(Added after v0.1, which kept a project on one machine.)* A project's material is of two kinds, and each is carried the way that suits it.

**Text through git, committed by the application.** Notes, summaries, `references.json`, `references.bib`, `project.toml` and each `metadata.json` are versioned in a repository whose top level is the project directory. The application commits what changed once edits have settled, replays local commits over the remote's, and publishes — on a timer and on request. The user is not asked to commit, and commit messages are generated in the project's terms.

- Act only on a repository whose top level *is* the project. A project inside some other repository is never committed to.
- Commit before fetching, so nothing uncommitted is ever in the way of incoming changes.
- When both sides changed the same lines: stop, restore the working tree exactly as it was, publish the local commits to a side branch so they exist off this disk, and wait for the user to choose a side. The choice is applied as a merge preferring that side for the contested lines only; both histories are kept.
- Network commands never prompt. A token for an `https` remote is passed to git through the environment for the duration of the command and is not written to the repository's configuration.

**Papers through a blob store, addressed by hash.** `original.pdf` is stored under the SHA-256 already recorded in `metadata.json`; extracted `pages.json` is stored compressed under that hash plus the extraction version. Because a name is the hash of its content there is nothing to reconcile: an object is written once and never rewritten, and a download is verified against the name it was requested by. Backends: any S3-compatible service, or a plain directory. Credentials come from the environment, never the project file.

- On opening a project, fetch the extracted text of every paper that lacks it, so search and the agent's reading cover the whole library. If storage has no text for a paper, fetch its PDF and extract again, without regenerating its summary.
- Fetch a PDF when it is first opened (or all of them with `prefetch`).
- With no storage configured, PDFs remain in git rather than being ignored into nonexistence.
- A project whose storage is misdescribed still opens; its notes are local.

Operational state under `.research/` — conversations among it — is not synced. Document and reference IDs are sequential, so two copies that both allocate before syncing collide; this is surfaced as a git conflict, and concurrent use of two copies is not supported.

### Access when served beyond the owner's machine

An optional password (`LITMARK_PASSWORD`, HTTP Basic) is required before anything is served, the page included, since the page carries the session credential. It is single-user access control for a container on a host, to be used behind TLS; multi-user authentication remains out of scope.

### Access by other sessions over MCP

*(Added after v0.1.)* The project doubles as a memory for agent sessions running elsewhere: a session discussing a paper recalls what the project holds and sets down what it learns, and the result is ordinary project content — cited notes and summaries, visible in the interface and synced like the rest. No separate store of "memories" exists.

- The server answers MCP over streamable HTTP at `/mcp`, only when started with `LITMARK_MCP_TOKEN`, which the client presents as a bearer credential. It is stateless and answers in JSON, so a client's connection survives a restart. Host validation applies as everywhere; the browser's password does not, since the two credentials cannot share a header. This is single-user access for a private network; OAuth for hosted clients is out of scope.
- It serves the same project tools as the built-in agent, by name from an explicit list, plus `add_paper`.
- **Attribution.** Every change made this way is recorded with origin `mcp:<client>` — the name from the client's handshake, or an `X-Litmark-Client` header — which the caller cannot set through tool arguments. Such changes are announced to open windows immediately, are undoable like the agent's, and are named in the body of the git commit that carries them, because the change log itself is local state and is not synced. Imports and tag changes are logged too, without an undo.
- **Papers.** A tool call cannot carry a file. `add_paper` issues a single-use upload address, valid for fifteen minutes and held in memory; the session sends the PDF's bytes to it with an HTTP PUT. The address is its own credential. The response waits for extraction (bounded) so one request yields a paper that can be read and cited. Litmark does not fetch papers from the network itself.

## 10. Proposed implementation

| Layer | Proposed choice |
| --- | --- |
| Server | Python, FastAPI, Uvicorn, Pydantic request/data schemas. |
| Frontend | TypeScript with a small component framework, compiled at release time. |
| Editor | CodeMirror 6 with a deliberately limited Markdown live-preview extension. |
| PDF rendering | PDF.js with text selection and an overlay for highlights. |
| PDF extraction | pdfplumber, retaining page text and character geometry. |
| Math | Bundled KaTeX assets. |
| Persistence | Ordinary files plus Python's SQLite interface for operational state. |
| Updates | REST for actions; server-sent events for progress and agent output. |
| Packaging | `pyproject.toml`, console entry point, wheel and source distribution containing compiled frontend assets. |

These are implementation proposals. CodeMirror is an editor foundation; the specified live-preview behavior is custom work and must be prototyped, not assumed to come out of the box. PDF extraction and PDF.js use different geometry representations: include a conversion layer and fixtures for rotation/crop behavior.

Two constraints found while building that layer, recorded because neither is apparent from the libraries' documentation. First, pdfplumber applies a page's `/Rotate` to character coordinates but reports `page.cropbox` under a different convention, and the two disagree at 180° and 270°; the visible box must therefore be derived from the raw media and crop boxes and rotated explicitly, not read back from pdfplumber. Second, reading order cannot be recovered from geometry alone — a page that displays upside down yields text in reverse — so line membership is geometric while the order of glyphs within a line, and of the lines themselves, comes from PDF content-stream order. The rotation fixtures required by A6 should cover all four angles with an asymmetric crop box, since a symmetric one cannot distinguish a correct transform from a mirrored one.

The continuous view renders only the pages near the viewport, keeping correctly-sized placeholders for the rest, so the scrollbar stays honest and memory stays bounded on a long document. Two things to get right: the page indicator must be measured from element rectangles rather than an `IntersectionObserver`'s `intersectionRatio`, because the generous `rootMargin` used to pre-render nearby pages inflates that ratio to 1 for every page near the viewport; and the default zoom should fit the panel width, since a letter page at 100% is wider than a side panel and would clip both the text and its highlights.

FastAPI supports serving bundled static files ([documentation](https://fastapi.tiangolo.com/tutorial/static-files/)). PDF.js supplies browser PDF parsing and rendering ([project](https://mozilla.github.io/pdf.js/)). pdfplumber exposes extracted text and character-level geometry ([documentation](https://github.com/jsvine/pdfplumber)). Use these components rather than implementing a PDF engine. CodeMirror's browser view component is maintained in its [official repository](https://github.com/codemirror/view).

Keep a small Python module for each domain: workspace/files, documents/extraction, references, agent adapter, jobs/events, and HTTP routes. CPU-heavy extraction runs off the web event loop. A single-process job queue with SQLite recovery is enough initially; no Redis, Celery, or separate database server.

Core API resources should cover documents/uploads, page retrieval and PDF bytes, source resolution, notes with revisions, bibliography export, conversations/runs/cancellation, change review/undo, and resumable events. Return validation errors and conflicts explicitly. Avoid an arbitrary-path file API.

### Packaging contract

Build frontend assets in release CI, then include them in both the wheel and source archive. Locate assets through package resources rather than the current directory. Bundle PDF.js worker code, fonts, styles, and math resources; do not fetch them from a CDN at runtime.

Use a `[project.scripts]` entry for the launch command and optional dependencies for the agent adapter, following the [Python packaging guide](https://packaging.python.org/en/latest/guides/writing-pyproject-toml/). Pin and test a compatible release dependency set. Publish dependency licenses with the distribution.

The release gate is installation from the actual built package in a clean environment without a frontend toolchain. Opening notes and PDFs must work offline after installation; agent requests require the configured provider connection.

### Local server boundaries

Validate project-relative paths, including symlinks, before reading or writing. Sanitize rendered Markdown and treat PDF text as evidence, never as application instructions. Keep credentials server-side and out of project files and logs. Use loopback binding, host/origin validation, and a local session credential so unrelated websites cannot command the server. Public hosting and multi-user authentication are outside v0.1; remote use can initially use an SSH tunnel.

## 11. Scope and delivery order

The target application includes ingestion, summaries, live-preview editing, PDF evidence, chat, and manual references. Build it through working increments:

| Milestone | Demonstrable result |
| --- | --- |
| 1. Package and editor | Install a wheel; launch the Python server; edit, save, and reopen a Markdown note with basic live preview. |
| 2. Documents and evidence | Import PDFs; extract/search page text; open page links; resolve and display a quotation highlight. |
| 3. Agent workflow | Connect one real agent backend; stream chat; create cited summaries; write a sourced note with version checks and undo. |
| 4. Complete interaction | Insert references from manual PDF selections; export a BibTeX bibliography; finish math rendering, conflict UX, cancellation/reconnect recovery, and release checks. |

Prototype the live-preview cursor behavior and quote-to-PDF geometry early. For a short class, provide the shell and editor integration as starter code and let students build a complete document-to-agent-to-note workflow. Building the full application from an empty repository is a larger exercise.

Deferred: OCR, document URL downloads, Word/HTML ingestion, Zotero and other reference-manager integration, semantic search, multiple agent providers, arbitrary analysis execution, multi-user collaboration, full mobile editing, complex tables, and multi-user public hosting. Keep extension points small rather than building a plugin framework first.

## 12. Acceptance criteria

| ID | Observable pass condition |
| --- | --- |
| A1 | Install the built wheel in a clean Python environment without Node; the command serves the complete interface, including the PDF worker. |
| A2 | Type Markdown headings, emphasis, quotations, links, and math; rendered appearance changes in place, syntax can be edited, and a source-mode toggle preserves the text. Checked in a real browser, not only in a DOM shim. |
| A3 | Import two text PDFs together; reopen the project and find their originals, metadata, and extracted pages. Importing identical bytes does not create an accidental duplicate. |
| A4 | Generate a short cited summary with a live agent; edit it manually and confirm a later regeneration cannot silently erase the edits. |
| A5 | Ask the agent to compare the papers and write the result into a note. The saved Markdown contains registered citations that open the intended source pages. |
| A6 | Resolve a multiline quotation and inspect the highlight at multiple zoom levels. Include a rotated/cropped PDF fixture and verify coordinates remain aligned. |
| A7 | An ambiguous or absent quotation produces an explicit resolution failure or labeled page-only citation, never a fabricated exact highlight. |
| A8 | Select a PDF passage manually, insert its reference into a note, restart, and return to the same highlighted passage. |
| A9 | Edit a note while an agent prepares a change. Both versions survive; no human text is silently overwritten. Undo cannot remove subsequent edits without conflict handling. |
| A10 | Disconnect/reconnect chat without duplicate messages; stop a running agent task; restart the server and retain transcript and clear interrupted-run state. |
| A11 | Without provider credentials, notes and PDFs remain usable and summaries/chat clearly indicate configuration is needed. |
| A12 | A malformed, encrypted, or scanned PDF reports its processing limitation and leaves other imports usable. |
| A13 | Export a bibliography for the imported papers: one entry per document with a usable key, page locators in the `\cite` commands rather than the entries, omitted-and-reported fields where the PDF supplies no author or year, and a second export that rewrites nothing. |

Use a small deterministic fixture corpus for geometry, references, and conflicts; use a fake adapter only for reproducible UI/event tests. A release still requires at least one actual provider-backed end-to-end run. Test package installation, not just the development server.

A2 and the zoom half of A6 need a browser driving the built assets; serving the right bytes proves nothing about whether the page runs. Two failures found only that way were a citation that could not be opened by plain click, and an event stream whose response withheld its headers until the first keepalive, so the interface showed “Reconnecting…” on an idle project. Note that headless Chromium cannot reach loopback HTTP under some sandboxes — it returns an empty document where `curl` succeeds — which makes a Chromium-based suite pass vacuously; prefer a browser verified to load the page.

The class demonstration is complete when a student can import two papers, read their summaries, ask for a comparison, have the agent write it into a note, inspect the supporting passages, and refine the Markdown themselves.

