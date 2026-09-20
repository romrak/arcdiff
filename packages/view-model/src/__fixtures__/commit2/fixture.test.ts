import { describe, expect, it } from 'vitest'
import base from './base.model.json' with { type: 'json' }
import delta from './delta.json' with { type: 'json' }
import head from './head.model.json' with { type: 'json' }

// The first fixture has 79 modified, 44 added and exactly ONE removed element
// — a single method on a surviving class. This fixture is the other shape on
// purpose: pip commit f9366da68 ("Remove setup.py develop code path") deletes
// `pip/_internal/operations/install/editable_legacy.py` outright, so a whole
// module and every element in it disappears, and nothing is added anywhere.
//
// Unlike a synthetic model, head here is a real, populated codebase (296
// elements) that simply has nothing left of the deleted module. That matters:
// a base-vs-head sibling bug cannot hide behind an empty head model.
describe('second fixture (f9366da68): a deleted module', () => {
  it('removes six elements and adds none', () => {
    expect(delta.delta.elements).toHaveLength(15)
    const byChange = delta.delta.elements.reduce<Record<string, number>>(
      (acc, c) => ({ ...acc, [c.change]: (acc[c.change] ?? 0) + 1 }), {},
    )
    expect(byChange).toEqual({ modified: 9, removed: 6 })
  })

  it('removes a whole module together with every element inside it', () => {
    const mod = 'pip._internal.operations.install.editable_legacy'
    const ids = delta.delta.elements.filter(c => c.change === 'removed').map(c => c.id)
    expect(ids).toContain(mod)
    expect(ids).toContain(`${mod}.install_editable`)
    expect(ids).toContain(`${mod}.logger`)

    // Everything the base model held for that module is accounted for in the
    // delta — a removal that reported the module but not its members would
    // leave orphans the canvas cannot place.
    const inBase = base.elements.filter(e => e.id === mod || e.id.startsWith(`${mod}.`))
    expect(inBase).toHaveLength(3)
    for (const e of inBase) expect(ids).toContain(e.id)
  })

  it('also removes members from modules that survive', () => {
    // Not just the deleted file: the commit drops three now-unreachable
    // functions from files that still exist, which is what stops this fixture
    // from only ever exercising the whole-file path.
    const ids = delta.delta.elements.filter(c => c.change === 'removed').map(c => c.id)
    expect(ids).toContain('pip._internal.utils.setuptools_build.make_setuptools_develop_args')
    expect(ids).toContain('pip._internal.wheel_builder._should_build')
    expect(ids).toContain('pip._internal.wheel_builder.should_build_for_install_command')
  })

  it('produces no signals — nothing new exists for the new-* signals to fire on', () => {
    expect(delta.signals).toHaveLength(0)
  })

  it('leaves nothing of the deleted module in head, though head is otherwise populated', () => {
    expect(head.elements.length).toBeGreaterThan(0)
    const mod = 'pip._internal.operations.install.editable_legacy'
    expect(head.elements.some(e => e.id === mod || e.id.startsWith(`${mod}.`))).toBe(false)
    // Every removed id must be resolvable in base, or attribution cannot
    // reach for its line range.
    const ids = new Set(base.elements.map(e => e.id))
    for (const change of delta.delta.elements) {
      if (change.change === 'removed') expect(ids.has(change.id)).toBe(true)
    }
  })
})
