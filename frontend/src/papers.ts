/**
 * The papers of the library, as the text on screen needs to know them.
 *
 * A note names a paper with a link written out in its Markdown —
 * `[Olley & Pakes (1996)](paper:doc-002)` — which is what the agent and
 * sessions elsewhere are asked to write. Showing such a link takes knowing
 * whether the paper is still there, and what it is called.
 */

export interface KnownPaper {
  documentId: string
  title: string
}

/** What of a paper's record is needed here: a `DocumentRecord` has it. */
export interface PaperRecord {
  document_id: string
  display_title: string
  label: string | null
}

/** A paper by the name it goes by: its authors and year, or failing those its title. */
export function nameOf(record: PaperRecord | undefined | null): string | null {
  return record ? (record.label ?? record.display_title) : null
}

const listed = new WeakMap<readonly PaperRecord[], KnownPaper[]>()

/**
 * The library as papers a link may name. The same list is returned for the
 * same records, so what depends on it is not redone at every render.
 */
export function papersOf(records: readonly PaperRecord[]): KnownPaper[] {
  let papers = listed.get(records)
  if (!papers) {
    papers = records.map((record) => ({
      documentId: record.document_id,
      title: record.display_title,
    }))
    listed.set(records, papers)
  }
  return papers
}
