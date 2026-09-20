import type { Delta, ElementChange, Model } from '@arcdiff/model'
import { compareIds } from '@arcdiff/model'
// '@arcdiff/git/hunks', NOT '@arcdiff/git': the bare barrel also re-exports
// repo.js, which imports node:child_process at module scope. This value
// import was the only reason the whole @arcdiff/diff package dragged Node
// builtins into a browser bundle two packages downstream (packages/viewer) —
// see that package's comments on the same rule, and @arcdiff/git's own
// `./hunks` subpath export, which exists for exactly this.
import { overlaps, type Hunk } from '@arcdiff/git/hunks'

/**
 * Add `bodyChanged` using git hunks intersected with head element ranges.
 * Structure comes from LSP and cannot see a body edit; this is the other half.
 * Returns a new Delta; does not mutate its input.
 *
 * `base` is needed for the changes synthesised here: a body-only change is
 * structurally identical, which made it tempting to use the head element for
 * both sides — and that put head line ranges on the `before` side.
 */
export function annotateBodyChanges(delta: Delta, base: Model, head: Model, hunks: Hunk[]): Delta {
  const byFile = new Map<string, Hunk[]>()
  for (const h of hunks) {
    const list = byFile.get(h.file)
    if (list) list.push(h)
    else byFile.set(h.file, [h])
  }

  const touched = (file: string, range: [number, number]): boolean => {
    const list = byFile.get(file)
    if (!list) return false
    return list.some(h => overlaps(range, h))
  }

  const existing = new Map(delta.elements.map(c => [c.id, { ...c }]))
  const baseById = new Map(base.elements.map(e => [e.id, e]))

  for (const el of head.elements) {
    if (!touched(el.file, el.range)) continue
    const prior = existing.get(el.id)
    if (prior) {
      // 'added' already implies new text; only annotate elements that persisted.
      if (prior.change === 'modified') prior.bodyChanged = true
      continue
    }
    // Structurally identical, so the base element differs only in its range —
    // which is exactly the field `before` is read for.
    existing.set(el.id, {
      id: el.id, change: 'modified', before: baseById.get(el.id) ?? el, after: el,
      fields: [], bodyChanged: true,
    } satisfies ElementChange)
  }

  const elements = [...existing.values()].sort((a, b) => compareIds(a.id, b.id))
  return { ...delta, elements }
}
