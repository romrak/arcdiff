import { describe, expect, it } from 'vitest'
import { expand, toggleExpansion } from './expansion.js'
import type { RelationIndex } from './relations.js'

/** A hand-built index: A and B both import M; C imports nothing. */
const index: RelationIndex = {
  moduleOf: id => id,
  resolve: (id, rel) =>
    rel === 'importers' && (id === 'A' || id === 'B') ? ['M'] :
    rel === 'peers' && id === 'A' ? ['P1', 'P2'] : [],
  counts: () => ({ subs: 0, supers: 0, importers: 0, imports: 0, peers: 0 }),
}
const changed = new Set(['A', 'B'])

describe('expand', () => {
  it('shows only changed elements when nothing is loaded', () => {
    expect([...expand(index, changed, new Map()).visible].sort()).toEqual(['A', 'B'])
  })

  it('keeps a shared neighbour when only one of its claimants closes', () => {
    let loaded = toggleExpansion(new Map(), 'A', 'importers')
    loaded = toggleExpansion(loaded, 'B', 'importers')
    expect(expand(index, changed, loaded).visible.has('M')).toBe(true)
    expect([...expand(index, changed, loaded).provenance.get('M')!].sort())
      .toEqual(['A:importers', 'B:importers'])

    loaded = toggleExpansion(loaded, 'A', 'importers')   // close A
    const after = expand(index, changed, loaded)
    expect(after.visible.has('M')).toBe(true)             // B still claims it
    expect([...after.provenance.get('M')!]).toEqual(['B:importers'])

    loaded = toggleExpansion(loaded, 'B', 'importers')   // close B
    expect(expand(index, changed, loaded).visible.has('M')).toBe(false)
  })

  it('keeps a changed element visible after the expansion that reached it closes', () => {
    // `resolve` reaches the CHANGED element A from B, so A appears both as a
    // seed and as an expansion result. Closing that expansion must not drop it.
    const reaching: RelationIndex = { ...index, resolve: () => ['A'] }
    let loaded = toggleExpansion(new Map(), 'B', 'peers')

    const open = expand(reaching, changed, loaded)
    expect(open.visible.has('A')).toBe(true)
    expect([...open.provenance.get('A')!]).toEqual(['B:peers'])

    loaded = toggleExpansion(loaded, 'B', 'peers')   // close it
    const closed = expand(reaching, changed, loaded)
    expect(closed.visible.has('A')).toBe(true)        // still visible: it is changed
    expect([...closed.provenance.get('A')!]).toEqual([])  // but nothing claims it
  })

  it('toggles a relation on and off without touching its siblings', () => {
    let loaded = toggleExpansion(new Map(), 'A', 'peers')
    loaded = toggleExpansion(loaded, 'A', 'importers')
    expect([...loaded.get('A')!].sort()).toEqual(['importers', 'peers'])
    loaded = toggleExpansion(loaded, 'A', 'peers')
    expect([...loaded.get('A')!]).toEqual(['importers'])
  })
})
