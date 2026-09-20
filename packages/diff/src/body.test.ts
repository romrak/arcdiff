import { describe, it, expect } from 'vitest'
import type { Element, Model } from '@arcdiff/model'
import type { Hunk } from '@arcdiff/git'
import { diffModels } from './diff.js'
import { annotateBodyChanges } from './body.js'

function el(id: string, range: [number, number], over: Partial<Element> = {}): Element {
  return {
    id, kind: 'method', name: id.split('.').pop()!,
    parent: 'app.m.A', package: 'app', file: 'app/m.py',
    range, lang: 'python', ...over,
  }
}
const model = (ref: string, elements: Element[]): Model =>
  ({ ref, extractedAt: 'T', elements, edges: [] })

describe('annotateBodyChanges', () => {
  it('marks a structurally identical element whose lines a hunk touches', () => {
    const head = model('h', [el('app.m.A.run', [10, 20])])
    const hunks: Hunk[] = [{ file: 'app/m.py', newStart: 14, newEnd: 15 }]
    const b = model('b', head.elements)
    const d = annotateBodyChanges(diffModels(b, head), b, head, hunks)
    expect(d.elements).toHaveLength(1)
    expect(d.elements[0]!).toMatchObject({
      id: 'app.m.A.run', change: 'modified', bodyChanged: true, fields: [],
    })
  })

  it('leaves an untouched element out of the delta entirely', () => {
    const head = model('h', [el('app.m.A.run', [10, 20])])
    const hunks: Hunk[] = [{ file: 'app/m.py', newStart: 40, newEnd: 41 }]
    const b = model('b', head.elements)
    const d = annotateBodyChanges(diffModels(b, head), b, head, hunks)
    expect(d.elements).toHaveLength(0)
  })

  it('does not match a hunk in a different file at the same lines', () => {
    const head = model('h', [el('app.m.A.run', [10, 20])])
    const hunks: Hunk[] = [{ file: 'app/other.py', newStart: 14, newEnd: 15 }]
    const b = model('b', head.elements)
    const d = annotateBodyChanges(diffModels(b, head), b, head, hunks)
    expect(d.elements).toHaveLength(0)
  })

  it('sets bodyChanged on an element already modified structurally, without losing fields', () => {
    const base = model('b', [el('app.m.A.run', [10, 20], { signature: '(self)' })])
    const head = model('h', [el('app.m.A.run', [10, 20], { signature: '(self, x)' })])
    const hunks: Hunk[] = [{ file: 'app/m.py', newStart: 10, newEnd: 11 }]
    const d = annotateBodyChanges(diffModels(base, head), base, head, hunks)
    expect(d.elements).toHaveLength(1)
    expect(d.elements[0]!).toMatchObject({ fields: ['signature'], bodyChanged: true })
  })

  it('never sets bodyChanged on a removed element, which has no head range', () => {
    const base = model('b', [el('app.m.A.gone', [10, 20])])
    const head = model('h', [])
    const hunks: Hunk[] = [{ file: 'app/m.py', newStart: 10, newEnd: 20 }]
    const d = annotateBodyChanges(diffModels(base, head), base, head, hunks)
    expect(d.elements[0]!).toMatchObject({ change: 'removed' })
    expect(d.elements[0]!.bodyChanged).toBeUndefined()
  })

  it('does not mutate the delta it was given', () => {
    const head = model('h', [el('app.m.A.run', [10, 20])])
    const b = model('b', head.elements)
    const original = diffModels(b, head)
    annotateBodyChanges(original, b, head, [{ file: 'app/m.py', newStart: 14, newEnd: 15 }])
    expect(original.elements).toHaveLength(0)
  })

  it('keeps output sorted by id', () => {
    const head = model('h', [el('app.m.A.z', [1, 5]), el('app.m.A.a', [10, 15])])
    const hunks: Hunk[] = [
      { file: 'app/m.py', newStart: 2, newEnd: 2 },
      { file: 'app/m.py', newStart: 11, newEnd: 11 },
    ]
    const b = model('b', head.elements)
    const d = annotateBodyChanges(diffModels(b, head), b, head, hunks)
    expect(d.elements.map(e => e.id)).toEqual(['app.m.A.a', 'app.m.A.z'])
  })

  // A body-only change is structurally identical, so it was synthesised with
  // `before: el` taken from the HEAD model — which made the `before` side carry
  // head line ranges. `before` has to be the base element.
  it('takes the before side from the BASE model, not the head one', () => {
    const base = model('b', [el('app.m.A.run', [10, 20])])
    const head = model('h', [el('app.m.A.run', [30, 41])])
    const hunks: Hunk[] = [{ file: 'app/m.py', newStart: 31, newEnd: 32 }]
    const d = annotateBodyChanges(diffModels(base, head), base, head, hunks)
    expect(d.elements[0]!.before?.range).toEqual([10, 20])
    expect(d.elements[0]!.after?.range).toEqual([30, 41])
  })
})
