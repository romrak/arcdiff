import { describe, it, expect } from 'vitest'
import type { Element, Model } from '@arcdiff/model'
import { diffModels, edgeKey } from './diff.js'

function el(id: string, over: Partial<Element> = {}): Element {
  return {
    id, kind: 'class', name: id.split('.').pop()!,
    parent: 'app.m', package: 'app', file: 'app/m.py',
    range: [1, 5], lang: 'python', ...over,
  }
}
function model(ref: string, elements: Element[], edges: Model['edges'] = []): Model {
  return { ref, extractedAt: '2026-09-20T00:00:00Z', elements, edges }
}

describe('diffModels', () => {
  it('reports an element present only in head as added', () => {
    const d = diffModels(model('b', []), model('h', [el('app.m.A')]))
    expect(d.elements).toHaveLength(1)
    expect(d.elements[0]!).toMatchObject({ id: 'app.m.A', change: 'added' })
    expect(d.elements[0]!.after?.id).toBe('app.m.A')
    expect(d.elements[0]!.before).toBeUndefined()
  })

  it('reports an element present only in base as removed', () => {
    const d = diffModels(model('b', [el('app.m.A')]), model('h', []))
    expect(d.elements[0]!).toMatchObject({ id: 'app.m.A', change: 'removed' })
    expect(d.elements[0]!.before?.id).toBe('app.m.A')
  })

  it('reports no change for an identical element', () => {
    const d = diffModels(model('b', [el('app.m.A')]), model('h', [el('app.m.A')]))
    expect(d.elements).toHaveLength(0)
  })

  it('ignores range and file drift — they are not compared fields', () => {
    const d = diffModels(
      model('b', [el('app.m.A', { range: [1, 5], file: 'app/m.py' })]),
      model('h', [el('app.m.A', { range: [80, 92], file: 'app/m.py' })]),
    )
    expect(d.elements).toHaveLength(0)
  })

  it('reports a changed signature as modified and names the field', () => {
    const d = diffModels(
      model('b', [el('app.m.A.run', { kind: 'method', signature: '(self) -> None' })]),
      model('h', [el('app.m.A.run', { kind: 'method', signature: '(self, x: int) -> None' })]),
    )
    expect(d.elements[0]!).toMatchObject({ change: 'modified', fields: ['signature'] })
  })

  it('reports several differing fields at once', () => {
    const d = diffModels(
      model('b', [el('app.m.A', { kind: 'class', abstract: false })]),
      model('h', [el('app.m.A', { kind: 'interface', abstract: true })]),
    )
    expect(d.elements[0]!.fields?.sort()).toEqual(['abstract', 'kind'])
  })

  it('detects a moved element via its package field', () => {
    const d = diffModels(
      model('b', [el('app.m.A', { package: 'app.old' })]),
      model('h', [el('app.m.A', { package: 'app.new' })]),
    )
    expect(d.elements[0]!.fields).toEqual(['package'])
  })

  it('diffs edges on the from|to|kind triple', () => {
    const base = model('b', [], [{ from: 'A', to: 'B', kind: 'extends' }])
    const head = model('h', [], [{ from: 'A', to: 'B', kind: 'implements' }])
    const d = diffModels(base, head)
    expect(d.edges).toHaveLength(2)
    expect(d.edges.find(e => e.change === 'removed')?.edge.kind).toBe('extends')
    expect(d.edges.find(e => e.change === 'added')?.edge.kind).toBe('implements')
  })

  it('carries base and head refs onto the delta', () => {
    const d = diffModels(model('sha-base', []), model('sha-head', []))
    expect(d).toMatchObject({ base: 'sha-base', head: 'sha-head' })
  })

  it('produces deterministic output ordering', () => {
    const b = model('b', [el('app.m.Z'), el('app.m.A')])
    const h = model('h', [])
    const once = JSON.stringify(diffModels(b, h))
    const twice = JSON.stringify(diffModels(b, h))
    expect(once).toBe(twice)
    expect(diffModels(b, h).elements.map(e => e.id)).toEqual(['app.m.A', 'app.m.Z'])
  })

  it('uses ordinal (not locale-collated) comparison for element ids', () => {
    const b = model('b', [el('app.m.B'), el('app.m.a')])
    const h = model('h', [])
    const ids = diffModels(b, h).elements.map(e => e.id)
    expect(ids).toEqual(['app.m.B', 'app.m.a'])
  })
})

describe('edgeKey', () => {
  it('joins the triple with a pipe', () => {
    expect(edgeKey({ from: 'A', to: 'B', kind: 'extends' })).toBe('A|B|extends')
  })
})
