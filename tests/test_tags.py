"""Tags on documents: the user's own labels for gathering papers.

A field, a year's job market, a candidate — whatever grouping the user has in
mind. Tags live in each paper's metadata.json, so they are ordinary project
text: they travel through git and show up in the bibliography.
"""

from __future__ import annotations

import json

import pytest
from conftest import upload, wait_for_extraction

from litmark.documents import normalize_tags
from litmark.errors import InvalidInput


def import_two(client, paper_one, paper_two) -> tuple[str, str]:
    first = upload(client, "mobility.pdf", paper_one)["imported"][0]["document"]["document_id"]
    second = upload(client, "search.pdf", paper_two)["imported"][0]["document"]["document_id"]
    wait_for_extraction(client, first)
    wait_for_extraction(client, second)
    return first, second


# -------------------------------------------------------------- what a tag is


def test_tags_are_tidied_and_unique_whatever_their_case():
    assert normalize_tags(["  Labor ", "labor", "#jmp-2026", "field : IO", ""]) == [
        "jmp-2026",
        "Labor",
        "field:IO",
    ]
    # Grouped tags sort by group, then value; plain tags come first.
    assert normalize_tags(["jmp:2026", "field:labor", "field:IO", "theory"]) == [
        "theory",
        "field:IO",
        "field:labor",
        "jmp:2026",
    ]


def test_a_tag_takes_the_spelling_already_in_the_project():
    """`Labor` and `labor` must not become two collections."""
    assert normalize_tags(["LABOR", "new one"], known=["Labor", "field:IO"]) == ["Labor", "new one"]


@pytest.mark.parametrize("bad", ["a, b", "x" * 61, "untagged", "Untagged"])
def test_tags_that_cannot_be_stored_are_refused(bad):
    with pytest.raises(InvalidInput):
        normalize_tags([bad])


# ------------------------------------------------------------- over the API


def test_a_paper_is_tagged_and_the_tags_are_written_to_its_metadata(client, services, paper_one):
    document_id = upload(client, "paper.pdf", paper_one)["imported"][0]["document"]["document_id"]
    assert client.get(f"/api/documents/{document_id}").json()["tags"] == []

    response = client.put(
        f"/api/documents/{document_id}/tags", json={"tags": ["jmp:2026", "field:labor", "Card"]}
    )
    assert response.status_code == 200, response.text
    assert response.json()["tags"] == ["Card", "field:labor", "jmp:2026"]

    # In the file, where git and anything else outside the application finds them.
    stored = json.loads(services.documents.metadata_path(document_id).read_text("utf-8"))
    assert stored["tags"] == ["Card", "field:labor", "jmp:2026"]
    state = client.get("/api/state").json()
    assert state["documents"][0]["tags"] == ["Card", "field:labor", "jmp:2026"]
    assert state["tags"] == [
        {"tag": "Card", "count": 1},
        {"tag": "field:labor", "count": 1},
        {"tag": "jmp:2026", "count": 1},
    ]

    cleared = client.put(f"/api/documents/{document_id}/tags", json={"tags": []})
    assert cleared.json()["tags"] == []
    assert client.get("/api/tags").json()["tags"] == []


def test_a_bad_tag_is_refused_and_changes_nothing(client, paper_one):
    document_id = upload(client, "paper.pdf", paper_one)["imported"][0]["document"]["document_id"]
    client.put(f"/api/documents/{document_id}/tags", json={"tags": ["kept"]})
    refused = client.put(f"/api/documents/{document_id}/tags", json={"tags": ["fine", "a, b"]})
    assert refused.status_code == 422, refused.text
    assert "comma" in refused.json()["error"]["message"]
    assert client.get(f"/api/documents/{document_id}").json()["tags"] == ["kept"]
    assert client.put("/api/documents/doc-999/tags", json={"tags": ["x"]}).status_code == 404


def test_several_papers_are_tagged_at_once(client, services, paper_one, paper_two):
    first, second = import_two(client, paper_one, paper_two)
    client.put(f"/api/documents/{first}/tags", json={"tags": ["Labor", "old"]})

    response = client.post(
        "/api/documents/tags",
        json={"document_ids": [first, second], "add": ["jmp:2026", "labor"], "remove": ["OLD"]},
    )
    assert response.status_code == 200, response.text
    assert response.json()["changed"] == [first, second]
    assert services.documents.get(first).tags == ["Labor", "jmp:2026"]
    # The second paper gets the tag in the spelling the project already uses.
    assert services.documents.get(second).tags == ["Labor", "jmp:2026"]
    assert response.json()["tags"] == [{"tag": "Labor", "count": 2}, {"tag": "jmp:2026", "count": 2}]

    # Asking for what is already so changes nothing, and says so.
    again = client.post("/api/documents/tags", json={"document_ids": [first], "add": ["labor"]})
    assert again.json()["changed"] == []


def test_papers_can_be_tagged_as_they_are_imported(client, services, paper_one, paper_two):
    """Forty job-market papers dropped in at once arrive already gathered."""
    response = client.post(
        "/api/documents?tags=jmp:2026&tags=junior",
        files=[
            ("files", ("a.pdf", paper_one, "application/pdf")),
            ("files", ("b.pdf", paper_two, "application/pdf")),
        ],
    )
    assert response.status_code == 201, response.text
    assert [item["document"]["tags"] for item in response.json()["imported"]] == [
        ["junior", "jmp:2026"],
        ["junior", "jmp:2026"],
    ]
    # A paper that was already here joins the collection too.
    again = client.post(
        "/api/documents?tags=field:labor",
        files=[("files", ("a-again.pdf", paper_one, "application/pdf"))],
    ).json()["imported"][0]
    assert again["duplicate"] is True
    assert again["document"]["tags"] == ["junior", "field:labor", "jmp:2026"]

    refused = client.post(
        "/api/documents?tags=a,b", files=[("files", ("c.pdf", paper_two, "application/pdf"))]
    )
    assert refused.status_code == 422


def test_a_change_of_tags_is_announced_to_open_windows(client, services, paper_one):
    document_id = upload(client, "paper.pdf", paper_one)["imported"][0]["document"]["document_id"]
    wait_for_extraction(client, document_id)
    before = services.db.latest_seq()
    client.put(f"/api/documents/{document_id}/tags", json={"tags": ["theory"]})
    events = [e for e in services.db.events_since(before) if e["type"] == "document_updated"]
    assert events and events[-1]["document_ids"] == [document_id]


# ------------------------------------------------ search, the agent, BibTeX


def test_search_can_be_kept_to_the_papers_with_a_tag(client, services, paper_one, paper_two):
    first, second = import_two(client, paper_one, paper_two)
    services.documents.tag([first], add=["jmp:2026", "field:labor"])
    services.documents.tag([second], add=["field:labor"])

    everywhere = {hit.document_id for hit in services.documents.search("mobility")}
    assert everywhere == {first, second}
    assert {h.document_id for h in services.documents.search("mobility", tags=["JMP:2026"])} == {first}
    both = services.documents.search("mobility", tags=["field:labor", "jmp:2026"])
    assert {hit.document_id for hit in both} == {first}
    assert services.documents.search("mobility", tags=["no-such-tag"]) == []


def test_the_agent_sees_tags_filters_by_them_and_sets_them(services, paper_one, paper_two):
    first, _ = services.documents.import_pdf(paper_one, "mobility.pdf")
    second, _ = services.documents.import_pdf(paper_two, "search.pdf")
    for document in (first, second):
        services.documents.run_extraction(document.document_id)
    announced: list[list[str]] = []
    services.tools.on_documents_changed = announced.append

    result = services.tools.tag_documents(
        [first.document_id, second.document_id], add=["field:labor"]
    )
    assert result["ok"] is True and result["changed"] == 2
    services.tools.tag_documents([first.document_id], add=["jmp:2026"], remove=["nothing"])
    assert announced == [[first.document_id, second.document_id], [first.document_id]]

    listed = services.tools.list_documents()
    assert {d["document_id"]: d["tags"] for d in listed["documents"]} == {
        first.document_id: ["field:labor", "jmp:2026"],
        second.document_id: ["field:labor"],
    }
    assert listed["tags_in_use"] == [
        {"tag": "field:labor", "count": 2},
        {"tag": "jmp:2026", "count": 1},
    ]
    only = services.tools.list_documents(tags=["jmp:2026"])
    assert [d["document_id"] for d in only["documents"]] == [first.document_id]
    hits = services.tools.search_documents("mobility", tags=["jmp:2026"])
    assert {match["document_id"] for match in hits["matches"]} == {first.document_id}

    # Through the same door the agent uses, with a tag that cannot be stored.
    from litmark.agent.tools import dispatch

    refused = dispatch(services.tools, "tag_documents", {"document_ids": [first.document_id], "add": ["a, b"]})
    assert refused["ok"] is False and "comma" in refused["message"]


def test_tags_become_keywords_in_the_bibliography(client, services, paper_one):
    document_id = upload(client, "paper.pdf", paper_one)["imported"][0]["document"]["document_id"]
    wait_for_extraction(client, document_id)
    without = client.get("/api/bibliography").json()["bibtex"]
    assert "keywords" not in without

    client.put(f"/api/documents/{document_id}/tags", json={"tags": ["jmp:2026", "field:labor"]})
    bibtex = client.get("/api/bibliography").json()["bibtex"]
    assert "keywords = {field:labor, jmp:2026}" in bibtex


def test_tags_survive_a_restart_and_an_older_project_has_none(tmp_path, paper_one):
    from litmark.services import Services
    from litmark.workspace import Workspace

    workspace = Workspace.initialize(tmp_path / "p")
    services = Services(workspace, backend_name="fake")
    document, _ = services.documents.import_pdf(paper_one, "paper.pdf")
    services.documents.set_tags(document.document_id, ["theory"])
    # A paper imported before tags existed has no `tags` key at all.
    other = workspace.documents_dir / "doc-777"
    other.mkdir()
    old = {k: v for k, v in document.to_json().items() if k != "tags"}
    (other / "metadata.json").write_text(json.dumps({**old, "document_id": "doc-777", "sha256": "0" * 64}))
    services.db.close()

    reopened = Services(Workspace(tmp_path / "p").open(), backend_name="fake")
    try:
        assert reopened.documents.get(document.document_id).tags == ["theory"]
        assert reopened.documents.get("doc-777").tags == []
        assert reopened.documents.all_tags() == [{"tag": "theory", "count": 1}]
    finally:
        reopened.db.close()


def test_tags_set_while_a_paper_is_being_read_are_not_lost(services, paper_one, monkeypatch):
    """Extraction writes the same file; it must not put back what it read earlier."""
    import litmark.documents as documents_module

    document, _ = services.documents.import_pdf(paper_one, "paper.pdf")
    real = documents_module.extract_pdf

    def slow_extract(path):
        # The user tags the paper while its text is still being extracted.
        services.documents.set_tags(document.document_id, ["jmp:2026"])
        return real(path)

    monkeypatch.setattr(documents_module, "extract_pdf", slow_extract)
    services.documents.run_extraction(document.document_id)
    services.documents.set_summary_status(document.document_id, "queued")

    after = services.documents.get(document.document_id)
    assert after.tags == ["jmp:2026"]
    assert after.extraction["status"] == "ok" and after.summary["status"] == "queued"
