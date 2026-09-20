import type { Element, ElementKind } from '@arcdiff/model'
import { compareIds, packageAncestors } from '@arcdiff/model'

/**
 * Package box ids are namespaced because `kind: 'package'` is never extracted
 * and a package name is usually ALSO a module id — every directory with an
 * __init__.py. In pip that is all 22 of them. An un-prefixed package box
 * would silently shadow its own __init__ module.
 */
export const PACKAGE_PREFIX = 'pkg:'

export function packageBoxId(pkg: string): string { return `${PACKAGE_PREFIX}${pkg}` }

export interface BoxNode {
  id: string
  kind: ElementKind
  label: string
  /** Containing box id, or null at the root. */
  parentBox: string | null
  /** Null for a synthesized package box. */
  element: Element | null
}

export function buildBoxTree(elements: readonly Element[]): Map<string, BoxNode> {
  const tree = new Map<string, BoxNode>()

  // Synthesize a box per package segment, most general first.
  // Sort with compareIds. Do NOT "improve" this to localeCompare: it is
  // ICU-dependent, so box order — and therefore layout — would differ between
  // machines and between CI and a laptop. compareIds is plain ordinal and
  // reproducible. This is a hard convention across the repo, not a preference.
  const packages = new Set<string>()
  for (const e of elements) for (const p of packageAncestors(e.package)) packages.add(p)
  for (const pkg of [...packages].sort(compareIds)) {
    const parts = pkg.split('.')
    tree.set(packageBoxId(pkg), {
      id: packageBoxId(pkg),
      kind: 'package',
      label: parts[parts.length - 1]!,
      parentBox: parts.length > 1 ? packageBoxId(parts.slice(0, -1).join('.')) : null,
      element: null,
    })
  }

  for (const e of elements) {
    tree.set(e.id, {
      id: e.id,
      kind: e.kind,
      label: e.name,
      // A module's `parent` is null by design — it is parented by its package.
      parentBox: e.parent ?? packageBoxId(e.package),
      element: e,
    })
  }

  return tree
}
