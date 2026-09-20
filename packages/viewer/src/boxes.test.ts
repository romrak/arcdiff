import { describe, expect, it } from 'vitest'
import type { Element } from '@arcdiff/model'
import type { BoxNode, ChangeState } from '@arcdiff/view-model'
import {
  ROW_CAP, childrenByBox, memberRows, planBoxes, rollUpStates, type BoxTree,
} from './boxes.js'

// Hand-built trees, not the big pip fixture: every invariant below turns on
// a shape (a fold chain, a package with nothing visible under it) that is
// easier to construct directly than to locate in 124 real changed elements.

function box(over: Partial<BoxNode> & { id: string }): BoxNode {
  return { kind: 'module', label: over.id, parentBox: null, element: null, ...over }
}

function tree(...nodes: BoxNode[]): BoxTree {
  return new Map(nodes.map(n => [n.id, n]))
}

function element(over: Partial<Element> & { id: string; kind: Element['kind'] }): Element {
  return {
    name: over.id, parent: null, package: 'p',
    file: 'f.py', range: [1, 1], lang: 'python', ...over,
  }
}

describe('planBoxes', () => {
  describe('folding', () => {
    it('takes a folded box and its subtree off the canvas, rolling them onto the nearest unfolded ancestor', () => {
      const t = tree(
        box({ id: 'P', kind: 'package', parentBox: null }),
        box({ id: 'M', kind: 'module', parentBox: 'P' }),
        box({ id: 'C', kind: 'class', parentBox: 'M' }),
      )
      // M is folded, so its child C is folded too (isFolded cascades), and both
      // leave `rendered`. Only the root P — the nearest UNfolded ancestor —
      // survives, and renderedBoxOf must roll C's content onto it.
      const plan = planBoxes(t, new Set(['C']), new Set(['M']), 'member')
      expect(plan.rendered).toEqual(new Set(['P']))
      expect(plan.renderedBoxOf('C')).toBe('P')
    })
  })

  describe('root-never-folded invariant (boxes.ts:167-174)', () => {
    it('keeps a root box rendered even when the root itself is in collapsed', () => {
      const t = tree(box({ id: 'M', kind: 'module', parentBox: null }))
      const plan = planBoxes(t, new Set(['M']), new Set(['M']), 'member')
      // If the `parent !== null` guard in isFolded were dropped, this would fold
      // M away with no surviving ancestor to carry an undo affordance — boxes
      // vanishing with no way back, per the code's own comment.
      expect(plan.rendered.has('M')).toBe(true)
    })
  })

  describe('foldedChildren (boxes.ts:214-226)', () => {
    it('counts only the topmost fold in a chain, not every folded descendant', () => {
      const t = tree(
        box({ id: 'P', kind: 'package', parentBox: null }),
        box({ id: 'A', kind: 'module', parentBox: 'P' }),
        box({ id: 'B', kind: 'class', parentBox: 'A' }),
      )
      // Both A and B are folded. Only A's fold is undoable from a RENDERED
      // parent (P); B's fold sits inside A, which is itself off-screen, so B's
      // undo isn't reachable from anywhere and must not be counted twice on P.
      const plan = planBoxes(t, new Set(['B']), new Set(['A', 'B']), 'member')
      expect(plan.foldedChildren.get('P')).toBe(1)
      expect(plan.foldedChildren.get('A')).toBeUndefined()
    })
  })

  describe('detail level vs DETAIL_LEVELS (boxes.ts:60-83)', () => {
    const t = tree(
      box({ id: 'P', kind: 'package', parentBox: null }),
      box({ id: 'M', kind: 'module', parentBox: 'P' }),
      box({ id: 'C', kind: 'class', parentBox: 'M' }),
    )

    it('does not treat a class as too deep at the default "member" level', () => {
      // The regression `DETAIL_LEVELS.indexOf(...)` would reintroduce: with
      // DETAIL_LEVELS shortened to ['package', 'member'], `member` would score 1
      // instead of 3, KIND_LEVEL.class (2) would exceed it, and every class
      // would silently vanish from the default view. LEVEL_ORDINAL is not
      // exported, so this — planBoxes's actual output — is the only surface
      // that can pin it.
      const plan = planBoxes(t, new Set(['C']), new Set(), 'member')
      expect(plan.rendered.has('C')).toBe(true)
      expect(plan.showsMembers('C')).toBe(true)
    })

    it('drops a class as too deep at the coarser "package" level', () => {
      const plan = planBoxes(t, new Set(['C']), new Set(), 'package')
      expect(plan.rendered.has('C')).toBe(false)
      expect(plan.rendered.has('P')).toBe(true)
    })

    it('renders every box at or above the level, not just ancestors of the working set', () => {
      // Q has nothing visible under it at all. Without the "zoomed out: the
      // codebase itself" sweep (boxes.ts:204-209), only P (an ancestor of the
      // visible C) would render, and Collapse-all would show the packages that
      // happen to contain a change instead of the whole codebase skeleton.
      const withQ = tree(...[...t.values()], box({ id: 'Q', kind: 'package', parentBox: null }))
      const plan = planBoxes(withQ, new Set(['C']), new Set(), 'package')
      expect(plan.rendered.has('Q')).toBe(true)
    })
  })

  describe('renderedBoxOf requires visible membership, not just rendered (documented gap, boxes.ts:229)', () => {
    it('returns null for a box that is on screen only as an ancestor of a visible element', () => {
      // Pins CURRENT behaviour deliberately — this is the edge case named in
      // the fix-wave brief, not a bug to fix here. Concretely: expanding
      // `subs` on a changed class can pull in a subclass whose MODULE renders
      // as an ancestor (because the subclass is visible) without the module
      // itself ever being added to `visible`. A later `importers` expansion
      // reached from that subclass has no visible id to attach its edges to,
      // so it silently drops every importer edge into the module — even
      // though the module's box is right there on screen.
      const t = tree(
        box({ id: 'P', kind: 'package', parentBox: null }),
        box({ id: 'M', kind: 'module', parentBox: 'P' }),
        box({ id: 'C', kind: 'class', parentBox: 'M' }),
      )
      const plan = planBoxes(t, new Set(['C']), new Set(), 'member')
      expect(plan.rendered.has('M')).toBe(true)
      expect(plan.renderedBoxOf('M')).toBeNull()
    })
  })
})

describe('memberRows (boxes.ts:266-291)', () => {
  it('never cuts a changed member, even when it sorts past the cap', () => {
    const owner = 'C'
    const nodes: BoxNode[] = []
    for (let i = 0; i <= ROW_CAP; i++) {
      const id = `m${String(i).padStart(2, '0')}`
      nodes.push(box({ id, kind: 'method', parentBox: owner, element: element({ id, kind: 'method', parent: owner }) }))
    }
    // ROW_CAP + 1 members, so the cap bites. The changed one sorts LAST by
    // compareIds — the exact shape that would hide it under a naive
    // `all.slice(0, ROW_CAP)`.
    const changedId = nodes[nodes.length - 1]!.id
    const children = childrenByBox(tree(...nodes)).get(owner)!
    const states = new Map<string, ChangeState>([[changedId, 'direct']])

    const capped = memberRows(children, states, false)
    expect(capped.rows).toHaveLength(ROW_CAP)
    expect(capped.hidden).toBe(1)
    expect(capped.rows.some(r => r.id === changedId)).toBe(true)

    // `hidden` reports what the cap WOULD hide, not what is hidden right now:
    // it must stay 1 once expanded, or the row that undoes the expansion
    // (the "N more" affordance) disappears the moment it is clicked.
    const expanded = memberRows(children, states, true)
    expect(expanded.rows).toHaveLength(ROW_CAP + 1)
    expect(expanded.hidden).toBe(1)
  })
})

describe('rollUpStates (boxes.ts:43-58)', () => {
  it('propagates a member state up through every box ancestor, box ids only', () => {
    const t = tree(
      box({ id: 'P', kind: 'package', parentBox: null }),
      box({ id: 'M', kind: 'module', parentBox: 'P' }),
      box({ id: 'C', kind: 'class', parentBox: 'M' }),
      box({ id: 'C.meth', kind: 'method', parentBox: 'C' }),
    )
    const out = rollUpStates(t, new Map([['C.meth', 'direct']]))
    expect(out.get('C')).toBe('direct')
    expect(out.get('M')).toBe('direct')
    expect(out.get('P')).toBe('direct')
    // The member is a row inside its box, never a box of its own — rollUpStates
    // marks CONTAINERS, so the member's own id must not appear in the output.
    expect(out.has('C.meth')).toBe(false)
  })

  it('lets a later "direct" upgrade an ancestor already marked "contains", both insertion orders', () => {
    const t = tree(
      box({ id: 'C', kind: 'class', parentBox: null }),
      box({ id: 'C.a', kind: 'method', parentBox: 'C' }),
      box({ id: 'C.b', kind: 'method', parentBox: 'C' }),
    )
    // This test would pass under a broken "last write wins" implementation
    // too, in the order below — the second case is the one that actually
    // discriminates it, by putting `direct` first and confirming a later
    // `contains` cannot downgrade it.
    const containsThenDirect = rollUpStates(t, new Map([['C.a', 'contains'], ['C.b', 'direct']]))
    expect(containsThenDirect.get('C')).toBe('direct')

    const directThenContains = rollUpStates(t, new Map([['C.b', 'direct'], ['C.a', 'contains']]))
    expect(directThenContains.get('C')).toBe('direct')
  })
})
