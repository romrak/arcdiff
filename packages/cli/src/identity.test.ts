import { describe, it, expect } from 'vitest'
import type { Model } from '@arcdiff/model'
import { buildEdges, elementsForFile, type ParsedDef, type ParsedFile } from '@arcdiff/extract'
import { deriveSignals, diffModels } from '@arcdiff/diff'

/**
 * Element identity is the only key the whole diff rests on: `diffModels` builds
 * `new Map(elements.map(e => [e.id, e]))` for both sides, so two elements
 * sharing an id make one of them invisible and turn the OTHER one's fields into
 * a fabricated change. A `@property` getter and its `@x.setter` share a
 * qualname, which is the case that actually occurs in real code. These tests
 * pin the end-to-end consequence, not just the id string.
 */

const FILE = 'acme/core/cache.py'

function def(over: Partial<ParsedDef> & Pick<ParsedDef, 'qualname' | 'line'>): ParsedDef {
  return {
    type: 'function', endLine: over.line + 1, decoratorStart: null, bases: [], decorators: [],
    isAbstract: false, ...over,
  }
}

const CACHE = def({ qualname: 'Cache', type: 'class', line: 1, endLine: 30 })
const GETTER = def({
  qualname: 'Cache.enabled', line: 3, decorators: ['property'],
  signature: '(self) -> bool',
})
const SETTER = def({
  qualname: 'Cache.enabled', line: 7, decorators: ['enabled.setter'],
  signature: '(self, value: bool) -> None',
})

function model(ref: string, defs: ParsedDef[]): Model {
  const parsed: ParsedFile = { defs, imports: [], lineCount: 30 }
  const elements = elementsForFile(FILE, parsed)
  return { ref, extractedAt: '2026-09-20T00:00:00.000Z', elements, edges: buildEdges(elements, [], []) }
}

describe('property accessor identity', () => {
  it('gives a getter and its setter distinct ids', () => {
    const { elements } = model('head', [CACHE, GETTER, SETTER])
    const ids = elements.map(e => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('keeps the bare id on the getter and suffixes only the setter', () => {
    const ids = model('head', [CACHE, GETTER, SETTER]).elements.map(e => e.id)
    expect(ids).toContain('acme.core.cache.Cache.enabled')
    expect(ids).toContain('acme.core.cache.Cache.enabled.setter')
  })

  it('does NOT report signature-changed when a setter is added to an existing property', () => {
    const base = model('base', [CACHE, GETTER])
    const head = model('head', [CACHE, GETTER, SETTER])
    const signals = deriveSignals(diffModels(base, head), base, head)
    expect(signals.filter(s => s.kind === 'signature-changed')).toEqual([])
  })

  it('reports the added setter as a new member of the existing class', () => {
    const base = model('base', [CACHE, GETTER])
    const head = model('head', [CACHE, GETTER, SETTER])
    const signals = deriveSignals(diffModels(base, head), base, head)
    expect(signals.some(s =>
      s.kind === 'new-member' && s.elementId === 'acme.core.cache.Cache.enabled.setter',
    )).toBe(true)
  })

  it('still reports signature-changed when the GETTER signature really changes', () => {
    const base = model('base', [CACHE, GETTER, SETTER])
    const widened = def({ ...GETTER, signature: '(self) -> bool | None' })
    const head = model('head', [CACHE, widened, SETTER])
    const signals = deriveSignals(diffModels(base, head), base, head)
    expect(signals.map(s => [s.kind, s.elementId])).toContainEqual(
      ['signature-changed', 'acme.core.cache.Cache.enabled'],
    )
  })

  it('reports signature-changed on the SETTER when only the setter changes', () => {
    const base = model('base', [CACHE, GETTER, SETTER])
    const retyped = def({ ...SETTER, signature: '(self, value: bool | None) -> None' })
    const head = model('head', [CACHE, GETTER, retyped])
    const signals = deriveSignals(diffModels(base, head), base, head)
    expect(signals.map(s => [s.kind, s.elementId])).toContainEqual(
      ['signature-changed', 'acme.core.cache.Cache.enabled.setter'],
    )
  })
})
