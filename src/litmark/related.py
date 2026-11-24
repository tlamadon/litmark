"""What goes with a note or a paper: the papers and notes it is tied to.

A note is tied to the papers it cites (`source:` links, each a passage of some
paper) and names (`paper:` links). A paper is tied to the notes that cite or
name it, to the papers its own summary names and the ones whose summaries name
it, and — more loosely — to the papers that share its tags.

All of it is read from the Markdown each time it is asked for, as the marks in
the source panel are: the files are the truth, and an index kept beside them
would be stale the moment a note was edited by hand.
"""

from __future__ import annotations

from typing import Any

from .documents import DocumentStore
from .references import ReferenceStore, links_in_markdown
from .workspace import Workspace

MAX_SAME_TAGS = 8


def papers_in(text: str, registry: dict[str, Any], held: set[str]) -> dict[str, int]:
    """The papers a text is about, and how many times it points at each."""
    counts: dict[str, int] = {}
    cited, named = links_in_markdown(text)
    for reference_id in cited:
        reference = registry.get(reference_id)
        if reference is not None and reference.document_id in held:
            counts[reference.document_id] = counts.get(reference.document_id, 0) + 1
    for document_id in named:
        if document_id in held:
            counts[document_id] = counts.get(document_id, 0) + 1
    return counts


def _ranked(counts: dict[str, int]) -> list[dict[str, Any]]:
    return [
        {"document_id": document_id, "count": count}
        for document_id, count in sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    ]


def related_to_note(
    workspace: Workspace, documents: DocumentStore, references: ReferenceStore, note_id: str
) -> dict[str, Any]:
    note = workspace.read_note(note_id)
    held = {document.document_id for document in documents.list()}
    return {"papers": _ranked(papers_in(note.text, references.all(), held))}


def related_to_document(
    workspace: Workspace, documents: DocumentStore, references: ReferenceStore, document_id: str
) -> dict[str, Any]:
    subject = documents.get(document_id)
    everything = documents.list()
    held = {document.document_id for document in everything}
    registry = references.all()

    notes = []
    for note in workspace.list_notes():
        count = papers_in(note.text, registry, held).get(document_id, 0)
        if count:
            notes.append({"note_id": note.note_id, "title": note.title, "count": count})
    notes.sort(key=lambda item: (-item["count"], item["title"].lower()))

    mentions: dict[str, int] = {}
    mentioned_by: dict[str, int] = {}
    for document in everything:
        text = documents.summary_text(document.document_id)
        if not text:
            continue
        named = papers_in(text, registry, held)
        if document.document_id == document_id:
            mentions = {other: count for other, count in named.items() if other != document_id}
        elif named.get(document_id):
            mentioned_by[document.document_id] = named[document_id]

    own = {tag.casefold() for tag in subject.tags}
    shared: list[tuple[int, str, list[str]]] = []
    if own:
        for document in everything:
            if document.document_id == document_id:
                continue
            common = [tag for tag in document.tags if tag.casefold() in own]
            if common:
                shared.append((len(common), document.document_id, common))
    shared.sort(key=lambda item: (-item[0], item[1]))

    return {
        "notes": notes,
        "mentions": _ranked(mentions),
        "mentioned_by": _ranked(mentioned_by),
        "same_tags": [
            {"document_id": other, "tags": tags} for _, other, tags in shared[:MAX_SAME_TAGS]
        ],
    }
