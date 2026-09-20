import { describe, it, expect } from 'vitest'
import type { Edge, Element, Model } from '@arcdiff/model'
import { diffModels } from './diff.js'
import { deriveSignals } from './signals.js'

function el(id: string, over: Partial<Element> = {}): Element {
  return {
    id, kind: 'class', name: id.split('.').pop()!,
    parent: null, package: 'app.services', file: 'app/services/m.py',
    range: [1, 5], lang: 'python', ...over,
  }
}
const model = (ref: string, elements: Element[], edges: Edge[] = []): Model =>
  ({ ref, extractedAt: 'T', elements, edges })

const kinds = (s: { kind: string }[]) => s.map(x => x.kind).sort()

describe('deriveSignals', () => {
  it('reports new-interface for an added interface', () => {
    const base = model('b', [])
    const head = model('h', [el('app.i.Greeter', { kind: 'interface' })])
    const s = deriveSignals(diffModels(base, head), base, head)
    expect(s.find(x => x.kind === 'new-interface')?.elementId).toBe('app.i.Greeter')
  })

  it('does not report new-interface for an added plain class', () => {
    const base = model('b', [])
    const head = model('h', [el('app.s.Thing', { kind: 'class' })])
    const s = deriveSignals(diffModels(base, head), base, head)
    expect(kinds(s)).not.toContain('new-interface')
  })

  it('reports new-implementation for an added implements edge into a pre-existing interface', () => {
    const iface = el('app.i.Greeter', { kind: 'interface' })
    const base = model('b', [iface])
    const head = model('h', [iface, el('app.s.Impl')],
      [{ from: 'app.s.Impl', to: 'app.i.Greeter', kind: 'implements' }])
    const s = deriveSignals(diffModels(base, head), base, head)
    const sig = s.find(x => x.kind === 'new-implementation')
    expect(sig).toMatchObject({ elementId: 'app.s.Impl', relatedId: 'app.i.Greeter' })
  })

  it('does not report new-implementation when the interface is also new', () => {
    const base = model('b', [])
    const head = model('h',
      [el('app.i.Greeter', { kind: 'interface' }), el('app.s.Impl')],
      [{ from: 'app.s.Impl', to: 'app.i.Greeter', kind: 'implements' }])
    const s = deriveSignals(diffModels(base, head), base, head)
    expect(kinds(s)).not.toContain('new-implementation')
  })

  it('reports new-member for an added element whose parent already existed', () => {
    const parent = el('app.s.Thing')
    const base = model('b', [parent])
    const head = model('h', [parent, el('app.s.Thing.run', { kind: 'method', parent: 'app.s.Thing' })])
    const s = deriveSignals(diffModels(base, head), base, head)
    expect(s.find(x => x.kind === 'new-member')).toMatchObject({
      elementId: 'app.s.Thing.run', relatedId: 'app.s.Thing',
    })
  })

  it('does not report new-member when the parent is also new', () => {
    const base = model('b', [])
    const head = model('h', [
      el('app.s.Thing'),
      el('app.s.Thing.run', { kind: 'method', parent: 'app.s.Thing' }),
    ])
    const s = deriveSignals(diffModels(base, head), base, head)
    expect(kinds(s)).not.toContain('new-member')
  })

  it('reports signature-changed with both signatures in the detail', () => {
    const base = model('b', [el('app.s.T.run', { kind: 'method', signature: '(self)' })])
    const head = model('h', [el('app.s.T.run', { kind: 'method', signature: '(self, x: int)' })])
    const s = deriveSignals(diffModels(base, head), base, head)
    const sig = s.find(x => x.kind === 'signature-changed')
    expect(sig?.elementId).toBe('app.s.T.run')
    expect(sig?.detail).toContain('(self)')
    expect(sig?.detail).toContain('(self, x: int)')
  })

  it('reports new-peer when the package and kind already had members', () => {
    const existing = el('app.services.AService')
    const base = model('b', [existing])
    const head = model('h', [existing, el('app.services.BService')])
    const s = deriveSignals(diffModels(base, head), base, head)
    const peer = s.find(x => x.kind === 'new-peer')
    expect(peer?.elementId).toBe('app.services.BService')
    expect(peer?.relatedId).toBe('app.services')
    expect(peer?.detail).toContain('1 existing')
  })

  it('caps a large peer count to an order-of-magnitude form instead of the raw number', () => {
    const existing = Array.from({ length: 934 }, (_, i) => el(`app.services.S${i}`))
    const base = model('b', existing)
    const head = model('h', [...existing, el('app.services.NewOne')])
    const s = deriveSignals(diffModels(base, head), base, head)
    const peer = s.find(x => x.kind === 'new-peer')
    expect(peer?.detail).toContain('900+ existing')
    expect(peer?.detail).not.toContain('934')
  })

  it('keeps the exact peer count in peerCount even when detail shows the capped form', () => {
    const existing = Array.from({ length: 934 }, (_, i) => el(`app.services.S${i}`))
    const base = model('b', existing)
    const head = model('h', [...existing, el('app.services.NewOne')])
    const s = deriveSignals(diffModels(base, head), base, head)
    const peer = s.find(x => x.kind === 'new-peer')
    expect(peer?.peerCount).toBe(934)
    expect(peer?.detail).toContain('900+')
  })

  it('does not report new-peer for the first element of its kind in a package', () => {
    const base = model('b', [])
    const head = model('h', [el('app.services.Only')])
    const s = deriveSignals(diffModels(base, head), base, head)
    expect(kinds(s)).not.toContain('new-peer')
  })

  it('counts peers only of the same kind', () => {
    const fn = el('app.services.helper', { kind: 'function' })
    const base = model('b', [fn])
    const head = model('h', [fn, el('app.services.NewClass', { kind: 'class' })])
    const s = deriveSignals(diffModels(base, head), base, head)
    expect(kinds(s)).not.toContain('new-peer')
  })

  it('returns signals sorted by kind then elementId, deterministically', () => {
    const iface = el('app.i.G', { kind: 'interface' })
    const base = model('b', [iface, el('app.services.A')])
    const head = model('h',
      [iface, el('app.services.A'), el('app.services.B'), el('app.i.H', { kind: 'interface' })],
      [{ from: 'app.services.B', to: 'app.i.G', kind: 'implements' }])
    const once = JSON.stringify(deriveSignals(diffModels(base, head), base, head))
    const twice = JSON.stringify(deriveSignals(diffModels(base, head), base, head))
    expect(once).toBe(twice)
  })

  describe('new-peer scoping', () => {
    it('scopes method peers to the owning class, not the package', () => {
      const shared = [
        el('app.services.Service'),
        el('app.services.Service.run', { kind: 'method', parent: 'app.services.Service' }),
        el('app.services.Other'),
        el('app.services.Other.one', { kind: 'method', parent: 'app.services.Other' }),
        el('app.services.Other.two', { kind: 'method', parent: 'app.services.Other' }),
      ]
      const base = model('b', shared)
      const head = model('h', [
        ...shared,
        el('app.services.Service.stop', { kind: 'method', parent: 'app.services.Service' }),
      ])
      const peer = deriveSignals(diffModels(base, head), base, head)
        .find(s => s.kind === 'new-peer' && s.elementId === 'app.services.Service.stop')
      // One sibling on Service — NOT the three methods in the package.
      expect(peer!.peerCount).toBe(1)
      expect(peer!.relatedId).toBe('app.services.Service')
      expect(peer!.detail).toBe('New method alongside 1 existing in app.services.Service')
    })

    it('keeps class peers scoped to the package', () => {
      const shared = [el('app.services.One'), el('app.services.Two')]
      const base = model('b', shared)
      const head = model('h', [...shared, el('app.services.Three')])
      const peer = deriveSignals(diffModels(base, head), base, head)
        .find(s => s.kind === 'new-peer')!
      expect(peer.peerCount).toBe(2)
      expect(peer.relatedId).toBe('app.services')
    })

    it('scopes nested classes to the package, not to their parent', () => {
      const outer = el('app.services.Outer')
      const sibling = el('app.services.Sibling')
      const shared = [outer, sibling, el('app.services.Outer.Inner', { kind: 'class', parent: 'app.services.Outer' })]
      const base = model('b', shared)
      const head = model('h', [...shared, el('app.services.Outer.InnerTwo', { kind: 'class', parent: 'app.services.Outer' })])
      const peer = deriveSignals(diffModels(base, head), base, head)
        .find(s => s.kind === 'new-peer')!
      // Counts the outer and sibling (both in package), not just the one sibling inside the parent.
      expect(peer.peerCount).toBe(3)
      expect(peer.relatedId).toBe('app.services')
    })

    it('scopes field peers to the owning class too', () => {
      const shared = [
        el('app.services.Dto'),
        el('app.services.Dto.a', { kind: 'field', parent: 'app.services.Dto' }),
      ]
      const base = model('b', shared)
      const head = model('h', [
        ...shared, el('app.services.Dto.b', { kind: 'field', parent: 'app.services.Dto' }),
      ])
      const peer = deriveSignals(diffModels(base, head), base, head)
        .find(s => s.kind === 'new-peer' && s.elementId === 'app.services.Dto.b')
      expect(peer!.peerCount).toBe(1)
      expect(peer!.relatedId).toBe('app.services.Dto')
    })
  })
})
