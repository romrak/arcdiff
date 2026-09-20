import { compareIds, type Edge, type Element } from '@arcdiff/model'
import type { ResolvedBase } from './classify.js'
import type { ParsedImport } from './python/parse.js'

export interface FileImports {
  /**
   * The importing file's module ELEMENT id — `moduleIdFor(relPath)`, not
   * `fileToModuleFqn(relPath)`. The two differ for a root `__init__.py`, and
   * using the FQN here is what produced `{from: '', to: 'svc'}`: an edge out of
   * an element that does not exist.
   */
  moduleId: string
  /**
   * The package the importing file lives in — `filePackage(relPath)`. Relative
   * imports resolve against it. Required, not derived from `moduleId`: a
   * package `__init__`'s module id IS its package, so dropping a segment walks
   * one level too high, and the root `__init__` sentinel is not a package at all.
   */
  packageFqn: string
  imports: ParsedImport[]
}

function dotted(parts: string[]): string {
  return parts.filter(s => s !== '').join('.')
}

/** Module FQNs a single import statement could be naming, most general first. */
function importTargets(fi: FileImports, imp: ParsedImport): string[] {
  let baseFqn: string
  if (imp.level === 0) {
    if (imp.module === null) return imp.names // plain `import os`
    baseFqn = imp.module
  } else {
    // Relative: start at the importing file's own package, then walk up the
    // remaining `level - 1` segments.
    const parts = fi.packageFqn.split('.').filter(s => s !== '')
    for (let i = 1; i < imp.level; i++) parts.pop()
    baseFqn = imp.module === null ? dotted(parts) : dotted([...parts, imp.module])
  }
  // `from pkg import name` may name a submodule or a symbol; offer both.
  const out = baseFqn === '' ? [] : [baseFqn]
  for (const n of imp.names) out.push(baseFqn === '' ? n : `${baseFqn}.${n}`)
  return out
}

export function buildEdges(
  elements: Element[],
  bases: ResolvedBase[],
  imports: FileImports[],
): Edge[] {
  const byId = new Map(elements.map(e => [e.id, e]))
  const seen = new Set<string>()
  const out: Edge[] = []

  const push = (e: Edge): void => {
    if (e.from === e.to) return
    const k = `${e.from}|${e.to}|${e.kind}`
    if (seen.has(k)) return
    seen.add(k)
    out.push(e)
  }

  for (const e of elements) {
    if (e.parent && byId.has(e.parent)) {
      push({ from: e.parent, to: e.id, kind: 'contains' })
    }
  }

  for (const b of bases) {
    if (b.toId === null) continue
    const target = byId.get(b.toId)
    if (!target) continue
    push({
      from: b.fromId,
      to: b.toId,
      kind: target.kind === 'interface' ? 'implements' : 'extends',
    })
  }

  for (const fi of imports) {
    // The `to` side was always checked against the element index; the `from`
    // side never was, so a module id built by a second, divergent rule emitted
    // a dangling edge in silence. Both sides are elements or there is no edge.
    if (!byId.has(fi.moduleId)) {
      throw new Error(
        `arcdiff: import edges for module id '${fi.moduleId}' have no module element to ` +
        'hang off. The module id and the element id were built by different rules.',
      )
    }
    for (const imp of fi.imports) {
      for (const candidate of importTargets(fi, imp)) {
        const target = byId.get(candidate)
        if (target && target.kind === 'module') {
          push({ from: fi.moduleId, to: candidate, kind: 'imports' })
        }
      }
    }
  }

  // compareIds, not localeCompare: ordinal and locale-independent, so the same
  // model serialises byte-identically under any ICU configuration.
  out.sort((a, b) =>
    compareIds(a.from, b.from) || compareIds(a.to, b.to) || compareIds(a.kind, b.kind))
  return out
}
