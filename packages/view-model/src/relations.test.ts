import { describe, expect, it } from 'vitest'
import { compareIds } from '@arcdiff/model'
import type { Model } from '@arcdiff/model'
import { buildRelationIndex } from './relations.js'
import head from './__fixtures__/head.model.json' with { type: 'json' }

describe('buildRelationIndex', () => {
  const index = buildRelationIndex(head as unknown as Model)
  const cls = 'pip._internal.req.req_install.InstallRequirement'
  const method = `${cls}.install`

  it('resolves importers through the owning module, since imports are module-level', () => {
    expect(index.moduleOf(method)).toBe('pip._internal.req.req_install')
    expect(index.counts(method).importers).toBe(index.counts(cls).importers)
    // Non-zero, or the assertion above holds vacuously.
    expect(index.counts(cls).importers).toBeGreaterThan(0)
  })

  it('gives a method its class siblings as peers, not the package', () => {
    const peers = index.resolve(method, 'peers')
    expect(peers.length).toBeGreaterThan(0)
    expect(peers.every(id => id.startsWith(`${cls}.`))).toBe(true)
    expect(peers).not.toContain(method)
    // The bug this guards: peers keyed on package + kind would make this
    // method report every method in pip._internal.req as a peer.
    expect(peers.length).toBeLessThan(100)
  })

  it('scopes a field to its owning class too', () => {
    // NOTE: relations.ts still RETURNS parent-scoped peers for a field; it is
    // the viewer that hides the peers affordance on methods and fields,
    // because their siblings are already rows in the same box. Do not make
    // resolve() return [] here — the data is correct, the UI just omits it.
    // Pick deterministically: a field whose OWNER HAS SIBLING FIELDS. Taking
    // the first field with a parent could land on an only child, and then
    // every assertion below passes vacuously.
    const fieldsByOwner = new Map<string, string[]>()
    for (const e of head.elements) {
      if (e.kind !== 'field' || e.parent === null) continue
      const list = fieldsByOwner.get(e.parent)
      if (list) list.push(e.id)
      else fieldsByOwner.set(e.parent, [e.id])
    }
    const owner = [...fieldsByOwner.entries()]
      .filter(([, ids]) => ids.length >= 2)
      .sort(([a], [b]) => compareIds(a, b))[0]
    expect(owner, 'fixture must contain a class with >=2 fields').toBeDefined()
    const [ownerId, ids] = owner!

    const peers = index.resolve(ids[0]!, 'peers')
    expect(peers.length).toBe(ids.length - 1)
    expect(peers.every(id => id.startsWith(`${ownerId}.`))).toBe(true)
  })

  it('reports zero counts rather than throwing for an unknown id', () => {
    expect(index.counts('nope.not.here').subs).toBe(0)
  })

  it('separates sub and super directions', () => {
    // Deterministically pick an interface that HAS a subclass. Taking the
    // first interface of any kind would land on one with none — the fixture
    // has four such — and the loop below would then assert nothing at all.
    const iface = head.elements
      .filter(e => e.kind === 'interface')
      .sort((a, b) => compareIds(a.id, b.id))
      .find(e => index.resolve(e.id, 'subs').length > 0)
    expect(iface, 'fixture must contain an interface with a subclass').toBeDefined()

    const subs = index.resolve(iface!.id, 'subs')
    expect(subs.length).toBeGreaterThan(0)
    for (const sub of subs) {
      expect(index.resolve(sub, 'supers')).toContain(iface!.id)
    }
  })
})
