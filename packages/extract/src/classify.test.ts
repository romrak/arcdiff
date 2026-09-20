import { describe, it, expect } from 'vitest'
import type { Element } from '@arcdiff/model'
import { classifyInterfaces, type ResolvedBase } from './classify.js'

function cls(id: string): Element {
  return { id, kind: 'class', name: id.split('.').pop()!, parent: 'app.m',
           package: 'app', file: 'app/m.py', range: [1, 9], lang: 'python' }
}
function method(parent: string, name: string, isAbstract: boolean): Element {
  return { id: `${parent}.${name}`, kind: 'method', name, parent,
           package: 'app', file: 'app/m.py', range: [2, 3], lang: 'python',
           ...(isAbstract ? { abstract: true } : {}) }
}
const kindOf = (els: Element[], id: string) => els.find(e => e.id === id)?.kind

describe('classifyInterfaces', () => {
  it('classifies a class with an ABC base as an interface', () => {
    const els = [cls('app.m.A')]
    const bases: ResolvedBase[] = [{ fromId: 'app.m.A', toId: null, text: 'ABC' }]
    expect(kindOf(classifyInterfaces(els, bases), 'app.m.A')).toBe('interface')
  })

  it('classifies a class with a Protocol base as an interface', () => {
    const els = [cls('app.m.A')]
    const bases: ResolvedBase[] = [{ fromId: 'app.m.A', toId: null, text: 'Protocol' }]
    expect(kindOf(classifyInterfaces(els, bases), 'app.m.A')).toBe('interface')
  })

  it('accepts a dotted spelling like abc.ABC', () => {
    const els = [cls('app.m.A')]
    const bases: ResolvedBase[] = [{ fromId: 'app.m.A', toId: null, text: 'abc.ABC' }]
    expect(kindOf(classifyInterfaces(els, bases), 'app.m.A')).toBe('interface')
  })

  it('classifies a class with at least one abstract member as an interface', () => {
    const els = [cls('app.m.A'), method('app.m.A', 'run', true)]
    expect(kindOf(classifyInterfaces(els, []), 'app.m.A')).toBe('interface')
  })

  it('leaves a plain class alone', () => {
    const els = [cls('app.m.A'), method('app.m.A', 'run', false)]
    expect(kindOf(classifyInterfaces(els, []), 'app.m.A')).toBe('class')
  })

  it('does not reclassify a non-class element that has an abstract child', () => {
    const els: Element[] = [
      { ...cls('app.m'), kind: 'module', parent: null },
      method('app.m', 'run', true),
    ]
    expect(kindOf(classifyInterfaces(els, []), 'app.m')).toBe('module')
  })

  it('classifies a class whose base resolves to a known interface', () => {
    const base = cls('app.m.Iface')
    const derived = cls('app.m.Sub')
    const els = [base, method('app.m.Iface', 'run', true), derived]
    const bases: ResolvedBase[] = [{ fromId: 'app.m.Sub', toId: 'app.m.Iface', text: 'Iface' }]
    // Sub inherits from an interface but defines nothing abstract: still a class.
    expect(kindOf(classifyInterfaces(els, bases), 'app.m.Sub')).toBe('class')
    expect(kindOf(classifyInterfaces(els, bases), 'app.m.Iface')).toBe('interface')
  })

  it('does not match a user class merely NAMED ABC when it resolves elsewhere', () => {
    const els = [cls('app.m.A'), cls('app.other.ABC')]
    const bases: ResolvedBase[] = [
      { fromId: 'app.m.A', toId: 'app.other.ABC', text: 'ABC' },
    ]
    expect(kindOf(classifyInterfaces(els, bases), 'app.m.A')).toBe('class')
  })

  it('does not mutate the input array', () => {
    const els = [cls('app.m.A'), method('app.m.A', 'run', true)]
    classifyInterfaces(els, [])
    expect(els[0]!.kind).toBe('class')
  })

  it('returns elements in the order given', () => {
    const els = [cls('app.m.Z'), cls('app.m.A')]
    expect(classifyInterfaces(els, []).map(e => e.id)).toEqual(['app.m.Z', 'app.m.A'])
  })
})
