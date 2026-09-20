import type { Element, ElementChange, Model } from '@arcdiff/model'
import { spanOverlaps, type FileChangedLines, type LineSpan } from '@arcdiff/git/hunks'

/** Whether an element changed itself, or merely contains something that did. */
export type ChangeState = 'direct' | 'contains'

/**
 * The line span a change may be attributed to. Reaches up over the element's
 * decorators, which sit outside `range` — see Element.decoratorStart for why
 * they are not folded into it.
 */
export function attributionRange(e: Element): [number, number] {
  // The Math.min is redundant against today's Python extractor — decoratorStart
  // is always <= range[0] by AST construction — but nothing enforces that
  // invariant across future language adapters. Without it, a decoratorStart
  // greater than range[0] would silently invert the range into one that
  // matches no line at all.
  const start = e.decoratorStart === undefined ? e.range[0] : Math.min(e.decoratorStart, e.range[0])
  return [start, e.range[1]]
}

function width(r: [number, number]): number { return r[1] - r[0] }

/** Is `inner` a strictly narrower span nested inside `outer`? */
function nestedWithin(inner: [number, number], outer: [number, number]): boolean {
  return inner[0] >= outer[0] && inner[1] <= outer[1] && width(inner) < width(outer)
}

/**
 * Own-hunk attribution. An element is 'direct' when a changed line falls in its
 * range and no NARROWER element in the same file also covers that line.
 *
 * This replaces the earlier rule "a container is changed only when no child
 * is", which hides a container that has both its own change and a changed
 * child. The fixture has exactly that shape in build_env/virtual.py:
 * VirtualBuildEnvironment owns the changed lines 32-34 while also containing
 * a changed `__init__` at line 38 — see attribution.test.ts.
 */
export function attributeChanges(
  changes: readonly ElementChange[],
  base: Model,
  head: Model,
  changedLines: readonly FileChangedLines[],
): Map<string, ChangeState> {
  const linesByFile = new Map(changedLines.map(f => [f.file, f]))

  const byFile = (model: Model): Map<string, Element[]> => {
    const out = new Map<string, Element[]>()
    for (const e of model.elements) {
      const list = out.get(e.file)
      if (list) list.push(e)
      else out.set(e.file, [e])
    }
    return out
  }
  const headByFile = byFile(head)
  const baseByFile = byFile(base)

  const out = new Map<string, ChangeState>()

  for (const change of changes) {
    // A removed element exists only on the base side, so both its line numbers
    // and its sibling set must come from the base model.
    const removed = change.change === 'removed'
    const element = removed ? change.before : change.after
    if (element === undefined) continue

    // An added element, or one whose compared fields differ, changed by
    // definition — there is nothing for a hunk to adjudicate.
    if (change.change === 'added' || (change.fields !== undefined && change.fields.length > 0)) {
      out.set(change.id, 'direct')
      continue
    }

    const spans: LineSpan[] = removed
      ? linesByFile.get(element.file)?.base ?? []
      : linesByFile.get(element.file)?.head ?? []

    const mine = attributionRange(element)
    const covering = spans.filter(s => spanOverlaps(mine, s))
    if (covering.length === 0) { out.set(change.id, 'contains'); continue }

    const siblings = (removed ? baseByFile : headByFile).get(element.file) ?? []
    const narrower = siblings
      .filter(o => o.id !== element.id)
      .map(attributionRange)
      .filter(r => nestedWithin(r, mine))

    const own = covering.filter(s => !narrower.some(r => spanOverlaps(r, s)))
    out.set(change.id, own.length > 0 ? 'direct' : 'contains')
  }

  return out
}
