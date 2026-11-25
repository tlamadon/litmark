"""The summarizing skill: how this reader wants papers summarized.

A summary is written to a recipe. The recipe used to be fixed in the code; it
is now a file of the project — `skills/summary.md` — that says, in the
reader's own terms, what a summary of a paper should be: how long, in what
order, what to stress, what to leave out. The agent follows it every time it
summarizes, and it is *learned*: when the reader says in conversation how they
want summaries, or corrects one in a way that would hold for the next paper
too, the agent writes that down here, and the next summary is written that way.

It is ordinary project content — Markdown that can be read and edited by hand,
versioned like a note, synced with the rest — so what was learned is never
out of sight, and never out of the reader's hands.

There is one skill for now. It is kept under a name so that others (a profile
for a job-market read, another for a referee report) can sit beside it.
"""

from __future__ import annotations

from .errors import InvalidInput
from .workspace import Workspace, atomic_write_text, revision_of

SUMMARY = "summary"
SKILLS_DIR = "skills"
# It is put in front of the agent whole, every time: short enough to follow.
MAX_SKILL_CHARS = 8000

DEFAULT_SUMMARY_SKILL = """\
# How to summarize a paper

Write roughly 150–250 words of Markdown, covering:

- The research question.
- Data and method, including the identification strategy where relevant.
- The main findings.
- The main assumptions or limitations, distinguishing what the paper itself
  states from your own assessment.
"""


def skill_path(workspace: Workspace, name: str = SUMMARY):
    if name != SUMMARY:
        raise InvalidInput(f"There is no skill named {name!r}; the one there is, is {SUMMARY!r}.")
    return workspace.root / SKILLS_DIR / f"{name}.md"


def read_skill(workspace: Workspace, name: str = SUMMARY) -> dict[str, object]:
    """The skill as it stands: the reader's, or the one every project starts with."""
    path = skill_path(workspace, name)
    customised = path.is_file()
    text = path.read_text("utf-8") if customised else DEFAULT_SUMMARY_SKILL
    return {
        "name": name,
        "text": text,
        "revision": revision_of(text),
        # False while it is still what every project starts with.
        "customised": customised and text != DEFAULT_SUMMARY_SKILL,
    }


def write_skill(
    workspace: Workspace, text: str, *, expected_revision: str | None, name: str = SUMMARY
) -> tuple[str, str]:
    """Version-checked write. Returns ``(new_revision, previous_revision)``.

    The skill a project starts with is put on disk before the first change to
    it, so that change — like every later one — has something to be undone to.
    """
    cleaned = text.strip("\n")
    if not cleaned.strip():
        raise InvalidInput(
            "The skill cannot be empty: it is what says how a paper is summarized."
        )
    if len(cleaned) > MAX_SKILL_CHARS:
        raise InvalidInput(
            f"The skill is {len(cleaned)} characters; it is read in full before every "
            f"summary, so it is kept under {MAX_SKILL_CHARS}. Say the same in fewer words."
        )
    path = skill_path(workspace, name)
    if not path.is_file():
        path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_text(path, DEFAULT_SUMMARY_SKILL)
    revision, previous = workspace.write_versioned(
        path, cleaned + "\n", expected_revision=expected_revision, snapshot_reason="skill"
    )
    return revision, previous or revision_of(DEFAULT_SUMMARY_SKILL)
