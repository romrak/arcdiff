import { describe, expect, it } from 'vitest'
import type { Element } from '@arcdiff/model'
import { buildBoxTree, packageBoxId, PACKAGE_PREFIX } from './tree.js'
import head from './__fixtures__/head.model.json' with { type: 'json' }

describe('buildBoxTree', () => {
  const tree = buildBoxTree(head.elements as unknown as Element[])

  it('namespaces package boxes so they cannot collide with module ids', () => {
    // A package name and a module name can be the same dotted string whenever
    // the directory has an __init__.py — which is most of them. Pinned on
    // req_install because it is in the touched set and therefore guaranteed to
    // survive fixture pruning; an __init__ module may not be.
    const mod = 'pip._internal.req.req_install'
    expect(tree.get(mod)!.kind).toBe('module')
    expect(packageBoxId('pip._internal.req'))
      .toBe(`${PACKAGE_PREFIX}pip._internal.req`)
    expect(tree.get(`${PACKAGE_PREFIX}pip._internal.req`)!.kind).toBe('package')
    // The two ids must be distinct even though a package and a module can
    // share a dotted name.
    expect(packageBoxId('pip._internal.req')).not.toBe('pip._internal.req')
  })

  it('nests packages inside their parent package, up to a root with no parent', () => {
    expect(tree.get(`${PACKAGE_PREFIX}pip._internal.req`)!.parentBox)
      .toBe(`${PACKAGE_PREFIX}pip._internal`)
    expect(tree.get(`${PACKAGE_PREFIX}pip._internal`)!.parentBox)
      .toBe(`${PACKAGE_PREFIX}pip`)
    expect(tree.get(`${PACKAGE_PREFIX}pip`)!.parentBox).toBeNull()
  })

  // Do NOT assert a package COUNT here. The pruned fixture's package boxes are
  // a subset of the full model's, and the figure quoted in docs/VALIDATION.md
  // belongs to the FULL extraction, not this fixture.

  it('parents a module by its package, since module.parent is null', () => {
    const mod = head.elements.find(e => e.kind === 'module')!
    expect(mod.parent).toBeNull()
    expect(tree.get(mod.id)!.parentBox).toBe(packageBoxId(mod.package))
  })

  it('parents a member by its lexical owner', () => {
    const member = head.elements.find(e => e.kind === 'method')!
    expect(tree.get(member.id)!.parentBox).toBe(member.parent)
  })
})
