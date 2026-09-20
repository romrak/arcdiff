import { describe, expect, it } from 'vitest'
import type { ElementChange, Model } from '@arcdiff/model'
import { parseChangedLines } from '@arcdiff/git/hunks'
import { attributeChanges } from '../../attribution.js'
import delta from './delta.json' with { type: 'json' }
import base from './base.model.json' with { type: 'json' }
import head from './head.model.json' with { type: 'json' }
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

// Same idiom as ../../attribution.test.ts's fixtureDiffs(), pointed at this
// fixture's own diff directory rather than the first fixture's.
const fixtureDiffs = (): ReturnType<typeof parseChangedLines> => {
  const dir = fileURLToPath(new URL('./diff/', import.meta.url))
  return readdirSync(dir).flatMap(f => parseChangedLines(readFileSync(join(dir, f), 'utf8')))
}

// attribution.test.ts's "attributes a REMOVED element from the base side"
// case is synthetic — a hand-built two-element model whose head is empty. This
// is the same claim against a real extraction, with a head model that is fully
// populated (296 elements) and simply no longer contains the deleted module.
describe('attributeChanges on the second fixture (real removed elements)', () => {
  const states = attributeChanges(
    delta.delta.elements as unknown as ElementChange[],
    base as unknown as Model,
    head as unknown as Model,
    fixtureDiffs(),
  )

  // LOAD-BEARING: this is the test that discriminates base- from head-sourced
  // siblings. editable_legacy.py is gone in head, so if the sibling set were
  // read from HEAD nothing would be "narrower" than the module and it would
  // come out 'direct' instead of 'contains'.
  //
  // The mechanism is coarser than "each container's own lines are covered by
  // a narrower sibling": git collapses the whole-file deletion into ONE base
  // hunk span, {1,48}, covering the module's entire attribution range.
  // attributeChanges's `own = covering.filter(s => !narrower.some(overlap))`
  // disqualifies a span in its ENTIRETY the moment any narrower sibling
  // overlaps any part of it — so the module is demoted even for lines 1-12
  // (imports and the module docstring, before `logger` at line 13), which no
  // sibling touches at all. This span-level all-or-nothing exclusion is a
  // deliberate tradeoff: per-line exclusion would spuriously flip a container
  // to 'direct' on any of its own lines a narrower sibling's range does not
  // technically enclose, such as a trailing blank line. A maximal
  // whole-file-deletion shape is simply what exposes its coarseness.
  it('demotes the deleted module to contains — a narrower sibling disqualifies the whole span', () => {
    expect(states.get('pip._internal.operations.install.editable_legacy')).toBe('contains')
  })

  // CORROBORATING, not discriminating: both members are the narrowest
  // elements present, so they have no narrower sibling under EITHER a base-
  // or a head-sourced read — this would pass even with the bug above.
  it('marks the deleted module\'s own members direct — nothing narrower claims their lines', () => {
    const mod = 'pip._internal.operations.install.editable_legacy'
    expect(states.get(`${mod}.install_editable`)).toBe('direct')
    expect(states.get(`${mod}.logger`)).toBe('direct')
  })

  // The same rule on a file that SURVIVES, where head is not empty for the
  // enclosing module either — so base-sourced ranges are doing real work
  // rather than being the only ranges available.
  it('attributes a removed function inside a surviving module from the base ranges', () => {
    expect(states.get('pip._internal.wheel_builder._should_build')).toBe('direct')
    expect(states.get('pip._internal.wheel_builder.should_build_for_install_command')).toBe('direct')
    // wheel_builder itself also has changed lines of its own (the base spans
    // reach past the removed functions), so it is not demoted.
    expect(states.get('pip._internal.wheel_builder')).toBe('direct')
  })

  // The container rule again, on a modified-only file: InstallCommand's only
  // changed lines belong to its `run` method, so the class is contains-only
  // while the module — which has a changed import line above the class —
  // keeps a change of its own.
  it('demotes a class whose only changed lines belong to a method', () => {
    expect(states.get('pip._internal.commands.install.InstallCommand')).toBe('contains')
    expect(states.get('pip._internal.commands.install.InstallCommand.run')).toBe('direct')
    expect(states.get('pip._internal.commands.install')).toBe('direct')
  })
})
