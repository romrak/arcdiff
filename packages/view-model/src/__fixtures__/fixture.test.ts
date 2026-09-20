import { describe, expect, it } from 'vitest'
import base from './base.model.json' with { type: 'json' }
import delta from './delta.json' with { type: 'json' }
import head from './head.model.json' with { type: 'json' }

// The fixture is a pruned extraction of pip, `bfaabbcc0..f451950e6` — twelve
// commits of ordinary development between 2026-07-06 and 2026-07-17. See
// README.md ("Regenerating the fixtures") for the exact command.
describe('committed fixture', () => {
  it('has the 124 changed elements the view-model tests are written against', () => {
    expect(delta.delta.elements).toHaveLength(124)
    expect(delta.signals).toHaveLength(54)
  })

  it('covers all four change shapes, including a new implementation of an existing interface', () => {
    const byChange = delta.delta.elements.reduce<Record<string, number>>(
      (acc, c) => ({ ...acc, [c.change]: (acc[c.change] ?? 0) + 1 }), {},
    )
    expect(byChange).toEqual({ modified: 79, added: 44, removed: 1 })

    // VenvBuildEnvironment is a new class implementing the existing
    // BuildEnvironment interface — the one delta shape the engine's
    // `new-implementation` signal exists for.
    const added = delta.delta.elements.filter(c => c.change === 'added').map(c => c.id)
    expect(added).toContain('pip._internal.build_env.venv.VenvBuildEnvironment')
    expect(added).toContain('pip._internal.build_env.venv')
    expect(delta.signals.some(s => s.kind === 'new-implementation')).toBe(true)

    // A removed member on a surviving class, so the removed-element path has
    // a subject in this fixture too (the second fixture covers a whole file).
    const removed = delta.delta.elements.filter(c => c.change === 'removed').map(c => c.id)
    expect(removed).toEqual(['pip._internal.network.auth.KeyRingCliProvider._get_password'])
  })

  it('carries the structure the relation and tree tests depend on', () => {
    // Regenerating the fixture is allowed; regenerating it into something
    // these tests cannot exercise is not. If a number below changes, the
    // ENGINE changed — confirm that deliberately rather than editing the
    // expectation. Measured 2026-09-20.
    expect(base.elements).toHaveLength(1214)
    expect(head.elements).toHaveLength(1257)

    // relations.test.ts picks an interface that HAS a subclass; without one
    // its sub/super case would pass vacuously.
    const interfaces = head.elements.filter(e => e.kind === 'interface')
    expect(interfaces).toHaveLength(9)
    const withSubs = interfaces.filter(iface => head.edges.some(
      e => (e.kind === 'extends' || e.kind === 'implements') && e.to === iface.id,
    ))
    expect(withSubs.length).toBeGreaterThanOrEqual(3)

    // relations.test.ts's peer case needs an owner with sibling fields.
    const fieldsPerOwner = new Map<string, number>()
    for (const e of head.elements) {
      if (e.kind !== 'field' || e.parent === null) continue
      fieldsPerOwner.set(e.parent, (fieldsPerOwner.get(e.parent) ?? 0) + 1)
    }
    expect([...fieldsPerOwner.values()].filter(n => n >= 2).length).toBe(51)

    // The importers case. pip spells its internal imports absolutely
    // (`from pip._internal.x import y`), which is why the extraction is
    // rooted at `src/` rather than `src/pip` — see README.md.
    const importers = head.edges.filter(
      e => e.kind === 'imports' && e.to === 'pip._internal.exceptions',
    )
    expect(importers).toHaveLength(61)

    // tree.test.ts needs real package nesting, not a flat layout.
    const packages = new Set(head.elements.map(e => e.package))
    expect(packages.size).toBe(21)
    expect(packages).toContain('pip._internal.resolution.resolvelib')

    // Attribution resolves every delta element, so every id must be present.
    const ids = new Set([...base.elements, ...head.elements].map(e => e.id))
    for (const change of delta.delta.elements) expect(ids.has(change.id)).toBe(true)

    // decoratorStart must survive pruning — attributionRange is built on it.
    expect(head.elements.filter(e => e.decoratorStart !== undefined)).toHaveLength(187)
  })
})
