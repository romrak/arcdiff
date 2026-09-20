import { describe, expect, it } from 'vitest'
import type { Element, ElementChange, Model } from '@arcdiff/model'
import { parseChangedLines } from '@arcdiff/git/hunks'
import { attributeChanges, attributionRange } from './attribution.js'
import delta from './__fixtures__/delta.json' with { type: 'json' }
import base from './__fixtures__/base.model.json' with { type: 'json' }
import head from './__fixtures__/head.model.json' with { type: 'json' }
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

// fileURLToPath, not import.meta.dirname: the latter needs Node >= 20.11 and
// package.json only requires >= 20. This is the idiom parse.test.ts already uses.
const fixtureDiffs = (): ReturnType<typeof parseChangedLines> => {
  const dir = fileURLToPath(new URL('./__fixtures__/diff/', import.meta.url))
  return readdirSync(dir).flatMap(f => parseChangedLines(readFileSync(join(dir, f), 'utf8')))
}

describe('attributionRange', () => {
  // A partial literal, not a cast to `never`: this pins that only `range`
  // and `decoratorStart` are read, so a future field cannot quietly become
  // load-bearing without this test being updated.
  const el = (over: Partial<Element>): Element => ({
    id: 'x', kind: 'method', name: 'x', parent: null, package: 'p',
    file: 'f.py', range: [1, 1], lang: 'python', ...over,
  })
  it('reaches up to the first decorator without moving the end', () => {
    expect(attributionRange(el({ range: [2675, 2699], decoratorStart: 2674 })))
      .toEqual([2674, 2699])
  })
  it('is the plain range when undecorated', () => {
    expect(attributionRange(el({ range: [10, 20] }))).toEqual([10, 20])
  })
})

describe('attributeChanges on the real fixture', () => {
  // `as unknown as T`, not `as never`. `as never` satisfies every parameter
  // and would keep compiling even if the signature changed shape; this states
  // exactly what the JSON is being trusted to be.
  const states = attributeChanges(
    delta.delta.elements as unknown as ElementChange[],
    base as unknown as Model,
    head as unknown as Model,
    fixtureDiffs(),
  )

  // A canary, not a specification: it fails loudly if attribution shifts
  // wholesale. The three cases below are the ones that state a RULE, and each
  // was hand-checked against the hunks in the named .diff file before being
  // pinned here. Measured 2026-09-20 against the committed fixture.
  it('splits the 124 changed elements 97 direct / 27 contains', () => {
    const values = [...states.values()]
    expect(values).toHaveLength(124)
    expect(values.filter(v => v === 'direct')).toHaveLength(97)
    expect(values.filter(v => v === 'contains')).toHaveLength(27)
  })

  it('keeps a container direct when it has its own change AND a changed child', () => {
    // The case ruling A15 would hide, in build_env/virtual.py. The file has
    // three changed head spans: {5}, {32-34} and {38}.
    //   VirtualBuildEnvironment spans [29,139]; its first member starts at 37.
    //   So {32-34} lies inside the class and inside NO narrower element — the
    //   class changed in its own right — while {38} belongs to __init__
    //   [37,91]. A15 would report only the method and silently drop the
    //   class-level edit.
    const cls = 'pip._internal.build_env.virtual.VirtualBuildEnvironment'
    expect(states.get(cls)).toBe('direct')
    expect(states.get(`${cls}.__init__`)).toBe('direct')
    // {5} is above the class entirely, so the module owns a span of its own.
    expect(states.get('pip._internal.build_env.virtual')).toBe('direct')
  })

  it('demotes a container whose only changed lines belong to a child', () => {
    // The mirror case, in build_env/noop.py — changed head spans {3} and {18}.
    // NoOpBuildEnvironment spans [14,42] and covers only {18}, which its
    // __init__ [17,18] also covers, so the class owns nothing of its own.
    const cls = 'pip._internal.build_env.noop.NoOpBuildEnvironment'
    expect(states.get(cls)).toBe('contains')
    expect(states.get(`${cls}.__init__`)).toBe('direct')
    // {3} is outside the class, so the module still has a change of its own.
    expect(states.get('pip._internal.build_env.noop')).toBe('direct')
  })

  it('gives the decorator line to the method, not its class', () => {
    // metadata/base.py changed head spans are {161} and {167}.
    // editable_project_location is a decorated property: range [162,180] with
    // decoratorStart 161, so attributionRange widens it to [161,180].
    //
    // This is the discriminating assertion for decoratorStart. Line 161 IS
    // the decorator. Without the widening the method would still be direct
    // (it owns {167}), but 161 would belong to no narrower element and
    // BaseDistribution — which spans [100,581] — would flip to 'direct'.
    const iface = 'pip._internal.metadata.base.BaseDistribution'
    expect(states.get(iface)).toBe('contains')
    expect(states.get(`${iface}.editable_project_location`)).toBe('direct')
  })
})

describe('attributeChanges short-circuits', () => {
  // These two rules bypass the hunk check entirely, so they need their own
  // cases — on the real fixture they happen to agree with own-hunk
  // attribution, which would let a broken short-circuit pass unnoticed.
  const element = {
    id: 'm.C.f', kind: 'method' as const, name: 'f', parent: 'm.C',
    package: 'p', file: 'm.py', range: [10, 20] as [number, number],
    lang: 'python' as const,
  }
  const empty = { ref: 'r', extractedAt: 'T', elements: [element], edges: [] }

  it('marks a compared-field change direct even with no overlapping hunk', () => {
    const states = attributeChanges(
      [{ id: 'm.C.f', change: 'modified', before: element, after: element,
         fields: ['signature'] }],
      empty, empty,
      [{ file: 'm.py', head: [{ start: 900, end: 900 }], base: [] }],
    )
    expect(states.get('m.C.f')).toBe('direct')
  })

  it('marks an added element direct with no hunks at all', () => {
    const states = attributeChanges(
      [{ id: 'm.C.f', change: 'added', after: element }], empty, empty, [],
    )
    expect(states.get('m.C.f')).toBe('direct')
  })

  it('attributes a REMOVED element from the base side, not head', () => {
    // Discriminating on purpose: if the sibling set came from HEAD (empty here)
    // nothing would be "narrower" and the class would wrongly be 'direct'.
    // Likewise head has no line 14-16 at all.
    const cls = {
      id: 'm.C', kind: 'class' as const, name: 'C', parent: 'm', package: 'p',
      file: 'm.py', range: [10, 20] as [number, number], lang: 'python' as const,
    }
    const method = { ...cls, id: 'm.C.f', kind: 'method' as const, name: 'f',
      parent: 'm.C', range: [14, 16] as [number, number] }
    const base = { ref: 'b', extractedAt: 'T', elements: [cls, method], edges: [] }
    const head = { ref: 'h', extractedAt: 'T', elements: [], edges: [] }

    const states = attributeChanges(
      [{ id: 'm.C', change: 'removed', before: cls },
       { id: 'm.C.f', change: 'removed', before: method }] as unknown as ElementChange[],
      base as unknown as Model, head as unknown as Model,
      [{ file: 'm.py', base: [{ start: 14, end: 16 }], head: [{ start: 9, end: 9 }] }],
    )
    expect(states.get('m.C')).toBe('contains')
    expect(states.get('m.C.f')).toBe('direct')

    const own = attributeChanges(
      [{ id: 'm.C', change: 'removed', before: cls }] as unknown as ElementChange[],
      base as unknown as Model, head as unknown as Model,
      [{ file: 'm.py', base: [{ start: 11, end: 12 }], head: [] }],
    )
    expect(own.get('m.C')).toBe('direct')
  })

  it('falls through to contains when nothing claims the element', () => {
    const states = attributeChanges(
      [{ id: 'm.C.f', change: 'modified', before: element, after: element, fields: [] }],
      empty, empty,
      [{ file: 'm.py', head: [{ start: 900, end: 900 }], base: [] }],
    )
    expect(states.get('m.C.f')).toBe('contains')
  })
})
