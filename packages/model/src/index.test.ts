import { describe, it, expect } from 'vitest'
import { packageAncestors, type Model, type Element } from './index.js'

describe('packageAncestors', () => {
  it('returns each ancestor package from most specific to least', () => {
    expect(packageAncestors('acme.core.storage')).toEqual([
      'acme.core.storage',
      'acme.core',
      'acme',
    ])
  })

  it('returns a single-segment package unchanged', () => {
    expect(packageAncestors('app')).toEqual(['app'])
  })

  it('returns an empty array for the empty package', () => {
    expect(packageAncestors('')).toEqual([])
  })
})

describe('Model shape', () => {
  it('accepts a minimal well-formed model', () => {
    const el: Element = {
      id: 'app.services.foo.FooService',
      kind: 'class',
      name: 'FooService',
      parent: 'app.services.foo',
      package: 'app.services',
      file: 'app/services/foo.py',
      range: [1, 10],
      lang: 'python',
    }
    const model: Model = {
      ref: 'abc123',
      extractedAt: '2026-09-20T00:00:00Z',
      elements: [el],
      edges: [],
    }
    expect(model.elements[0]!.id).toBe('app.services.foo.FooService')
  })
})
