import { describe, it, expect } from 'vitest'
import type { Edge, Element, Model } from '@arcdiff/model'
import { diffModels } from './diff.js'
import { deriveSignals, type Signal } from './signals.js'

function iface(id: string): Element {
  return { id, kind: 'interface', name: id.split('.').pop()!, parent: null,
           package: 'app.i', file: 'app/i.py', range: [1, 9], lang: 'python' }
}
function cls(id: string): Element {
  return { id, kind: 'class', name: id.split('.').pop()!, parent: null,
           package: 'app.s', file: 'app/s.py', range: [1, 9], lang: 'python' }
}
function method(parent: string, name: string, isAbstract = false): Element {
  return { id: `${parent}.${name}`, kind: 'method', name, parent,
           package: parent.startsWith('app.i') ? 'app.i' : 'app.s',
           file: parent.startsWith('app.i') ? 'app/i.py' : 'app/s.py',
           range: [2, 3], lang: 'python', abstract: isAbstract,
           signature: '(self) -> None' }
}
const model = (ref: string, elements: Element[], edges: Edge[] = []): Model =>
  ({ ref, extractedAt: 'T', elements, edges })

const impl: Edge = { from: 'app.s.Impl', to: 'app.i.Greeter', kind: 'implements' }
const contracts = (s: Signal[]) => s.filter(x => x.kind === 'unimplemented-contract')

describe('unimplemented-contract', () => {
  it('fires when the interface gains an abstract method the implementer lacks', () => {
    const base = model('b',
      [iface('app.i.Greeter'), method('app.i.Greeter', 'hello', true),
       cls('app.s.Impl'), method('app.s.Impl', 'hello')], [impl])
    const head = model('h',
      [iface('app.i.Greeter'), method('app.i.Greeter', 'hello', true),
       method('app.i.Greeter', 'goodbye', true),
       cls('app.s.Impl'), method('app.s.Impl', 'hello')], [impl])
    const s = contracts(deriveSignals(diffModels(base, head), base, head))
    expect(s).toHaveLength(1)
    expect(s[0]).toMatchObject({ elementId: 'app.s.Impl', relatedId: 'app.i.Greeter' })
    expect(s[0]!.detail).toContain('goodbye')
  })

  it('does NOT fire when the implementer defines the new method', () => {
    const head = model('h',
      [iface('app.i.Greeter'), method('app.i.Greeter', 'goodbye', true),
       cls('app.s.Impl'), method('app.s.Impl', 'goodbye')], [impl])
    const base = model('b',
      [iface('app.i.Greeter'), cls('app.s.Impl')], [impl])
    expect(contracts(deriveSignals(diffModels(base, head), base, head))).toHaveLength(0)
  })

  it('fires for an implementer that WAS edited but still lacks the method — a change check would miss this', () => {
    const base = model('b',
      [iface('app.i.Greeter'), cls('app.s.Impl'),
       method('app.s.Impl', 'unrelated')], [impl])
    const head = model('h',
      [iface('app.i.Greeter'), method('app.i.Greeter', 'goodbye', true),
       cls('app.s.Impl'),
       { ...method('app.s.Impl', 'unrelated'), signature: '(self, extra: int) -> None' }], [impl])
    const s = contracts(deriveSignals(diffModels(base, head), base, head))
    expect(s).toHaveLength(1)
    expect(s[0]!.elementId).toBe('app.s.Impl')
  })

  it('does NOT fire for an unedited implementer that already had the method — a change check would falsely flag this', () => {
    const base = model('b',
      [iface('app.i.Greeter'), cls('app.s.Impl'),
       method('app.s.Impl', 'goodbye')], [impl])
    const head = model('h',
      [iface('app.i.Greeter'), method('app.i.Greeter', 'goodbye', true),
       cls('app.s.Impl'), method('app.s.Impl', 'goodbye')], [impl])
    expect(contracts(deriveSignals(diffModels(base, head), base, head))).toHaveLength(0)
  })

  it('ignores a NON-abstract method added to the interface', () => {
    const base = model('b', [iface('app.i.Greeter'), cls('app.s.Impl')], [impl])
    const head = model('h',
      [iface('app.i.Greeter'), method('app.i.Greeter', 'helper', false),
       cls('app.s.Impl')], [impl])
    expect(contracts(deriveSignals(diffModels(base, head), base, head))).toHaveLength(0)
  })

  it('does not treat the implementer\'s own abstract member as satisfying the contract', () => {
    const base = model('b', [iface('app.i.Greeter'), cls('app.s.Impl')], [impl])
    const head = model('h',
      [iface('app.i.Greeter'), method('app.i.Greeter', 'goodbye', true),
       cls('app.s.Impl'), method('app.s.Impl', 'goodbye', true)], [impl])
    const s = contracts(deriveSignals(diffModels(base, head), base, head))
    expect(s).toHaveLength(1)
  })

  it('reports every implementer that lacks the method', () => {
    const edges: Edge[] = [
      impl, { from: 'app.s.Other', to: 'app.i.Greeter', kind: 'implements' },
    ]
    const base = model('b',
      [iface('app.i.Greeter'), cls('app.s.Impl'), cls('app.s.Other')], edges)
    const head = model('h',
      [iface('app.i.Greeter'), method('app.i.Greeter', 'goodbye', true),
       cls('app.s.Impl'), cls('app.s.Other'),
       method('app.s.Other', 'goodbye')], edges)
    const s = contracts(deriveSignals(diffModels(base, head), base, head))
    expect(s.map(x => x.elementId)).toEqual(['app.s.Impl'])
  })

  it('follows an implements edge added in the same change', () => {
    const base = model('b', [iface('app.i.Greeter')], [])
    const head = model('h',
      [iface('app.i.Greeter'), method('app.i.Greeter', 'goodbye', true),
       cls('app.s.Impl')], [impl])
    const s = contracts(deriveSignals(diffModels(base, head), base, head))
    expect(s).toHaveLength(1)
  })

  it('finds a method inherited from a concrete base class through an extends edge', () => {
    const edges: Edge[] = [
      impl, { from: 'app.s.Impl', to: 'app.s.Mixin', kind: 'extends' },
    ]
    const base = model('b',
      [iface('app.i.Greeter'), cls('app.s.Impl'), cls('app.s.Mixin'),
       method('app.s.Mixin', 'goodbye')], edges)
    const head = model('h',
      [iface('app.i.Greeter'), method('app.i.Greeter', 'goodbye', true),
       cls('app.s.Impl'), cls('app.s.Mixin'), method('app.s.Mixin', 'goodbye')], edges)
    expect(contracts(deriveSignals(diffModels(base, head), base, head))).toHaveLength(0)
  })

  it('fires when an existing interface method flips from concrete to abstract', () => {
    const base = model('b',
      [iface('app.i.Greeter'), method('app.i.Greeter', 'goodbye', false),
       cls('app.s.Impl')], [impl])
    const head = model('h',
      [iface('app.i.Greeter'), method('app.i.Greeter', 'goodbye', true),
       cls('app.s.Impl')], [impl])
    const s = contracts(deriveSignals(diffModels(base, head), base, head))
    expect(s).toHaveLength(1)
    expect(s[0]!.elementId).toBe('app.s.Impl')
  })

  it('follows a transitive implements/extends chain and does not flag an intermediate interface', () => {
    const edges: Edge[] = [
      { from: 'app.s.Impl', to: 'app.i.Sub', kind: 'implements' },
      { from: 'app.i.Sub', to: 'app.i.Greeter', kind: 'extends' },
    ]
    const base = model('b',
      [iface('app.i.Greeter'), iface('app.i.Sub'), cls('app.s.Impl')], edges)
    const head = model('h',
      [iface('app.i.Greeter'), method('app.i.Greeter', 'goodbye', true),
       iface('app.i.Sub'), cls('app.s.Impl')], edges)
    const s = contracts(deriveSignals(diffModels(base, head), base, head))
    expect(s.map(x => x.elementId)).toEqual(['app.s.Impl'])
  })

  it('does not double-report a duplicate implements edge to the same interface', () => {
    const edges: Edge[] = [impl, { ...impl }]
    const base = model('b', [iface('app.i.Greeter'), cls('app.s.Impl')], edges)
    const head = model('h',
      [iface('app.i.Greeter'), method('app.i.Greeter', 'goodbye', true),
       cls('app.s.Impl')], edges)
    const s = contracts(deriveSignals(diffModels(base, head), base, head))
    expect(s).toHaveLength(1)
  })
})
