import type { Relation, RelationIndex } from './relations.js'

/** `${elementId}:${relation}` — one expansion the reviewer asked for. */
export type ExpansionKey = string

export type Loaded = ReadonlyMap<string, ReadonlySet<Relation>>

export interface Expanded {
  visible: ReadonlySet<string>
  /**
   * Which expansions claim each visible element. A changed element that no
   * expansion reached has an EMPTY set — but a changed element that some
   * expansion also reached carries that expansion's key, which is why
   * `visible` is computed as `changed ∪ reached` rather than from provenance.
   * Never read this to decide whether an element is changed.
   */
  provenance: ReadonlyMap<string, ReadonlySet<ExpansionKey>>
}

/**
 * The working set: every changed element, plus everything the reviewer's
 * expansions pulled in, each tagged with who pulled it.
 *
 * Provenance is what makes unloading safe. Expanding importers on A and on B
 * may both reach module M; closing A must leave M on screen because B still
 * claims it. Recomputing from `loaded` each time — rather than mutating a
 * visible set — makes that correct by construction.
 */
export function expand(
  index: RelationIndex,
  changed: ReadonlySet<string>,
  loaded: Loaded,
): Expanded {
  const visible = new Set<string>(changed)
  const provenance = new Map<string, Set<ExpansionKey>>()

  for (const [id, relations] of loaded) {
    for (const rel of relations) {
      const key: ExpansionKey = `${id}:${rel}`
      for (const found of index.resolve(id, rel)) {
        visible.add(found)
        const claims = provenance.get(found)
        if (claims) claims.add(key)
        else provenance.set(found, new Set([key]))
      }
    }
  }

  // A changed element is unconditional; it must never be dropped because an
  // expansion that happened to reach it was closed.
  for (const id of changed) if (!provenance.has(id)) provenance.set(id, new Set())

  return { visible, provenance }
}

/** Add a relation to an element's loaded set, or remove it if already there. */
export function toggleExpansion(
  loaded: Loaded, id: string, rel: Relation,
): Map<string, Set<Relation>> {
  const next = new Map<string, Set<Relation>>()
  for (const [key, value] of loaded) next.set(key, new Set(value))

  const current = next.get(id)
  if (current === undefined) { next.set(id, new Set([rel])); return next }
  if (current.has(rel)) current.delete(rel)
  else current.add(rel)
  if (current.size === 0) next.delete(id)
  return next
}
