import type { Element, Model } from '@arcdiff/model'
import { compareIds } from '@arcdiff/model'

export type Relation = 'subs' | 'supers' | 'importers' | 'imports' | 'peers'
export const RELATIONS: readonly Relation[] = ['subs', 'supers', 'importers', 'imports', 'peers']

export interface RelationIndex {
  /** The module an element lives in; a module is its own. Null if unknown. */
  moduleOf(id: string): string | null
  resolve(id: string, rel: Relation): string[]
  counts(id: string): Record<Relation, number>
}

const EMPTY: readonly string[] = []

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

export function buildRelationIndex(model: Model): RelationIndex {
  const byId = new Map(model.elements.map(e => [e.id, e]))

  const moduleCache = new Map<string, string | null>()
  const moduleOf = (id: string): string | null => {
    const hit = moduleCache.get(id)
    if (hit !== undefined) return hit
    let cur = byId.get(id)
    while (cur !== undefined && cur.kind !== 'module') {
      cur = cur.parent === null ? undefined : byId.get(cur.parent)
    }
    const result = cur?.id ?? null
    moduleCache.set(id, result)
    return result
  }

  const subs = new Map<string, string[]>()
  const supers = new Map<string, string[]>()
  const importers = new Map<string, string[]>()
  const imports = new Map<string, string[]>()

  for (const edge of model.edges) {
    if (edge.kind === 'extends' || edge.kind === 'implements') {
      push(subs, edge.to, edge.from)
      push(supers, edge.from, edge.to)
    } else if (edge.kind === 'imports') {
      push(importers, edge.to, edge.from)
      push(imports, edge.from, edge.to)
    }
  }

  /**
   * Where an element's peers live. A method's or field's peers are its siblings
   * on the owning class; taking them from the package would give one changed
   * method in pip._internal.resolution.resolvelib 166 "peers", which is
   * noise, not context.
   *
   * Duplicated in packages/diff/src/signals.ts (`peerScope` there, used by the
   * `new-peer` signal). Not shared on purpose — introducing a package
   * dependency between `view-model` and `diff` just to share a five-line
   * function is not worth it. Keep the two rules in step by hand: if they
   * drift, the box footer's `≈ peers` count and a `new-peer` signal's
   * `peerCount` would answer different questions about the same element, and
   * nothing would say so.
   */
  const peerScope = (e: Element): { key: string; byParent: boolean } =>
    e.kind === 'method' || e.kind === 'field'
      ? { key: e.parent ?? e.package, byParent: true }
      : { key: e.package, byParent: false }

  const peersByScope = new Map<string, string[]>()
  for (const e of model.elements) {
    const { key, byParent } = peerScope(e)
    push(peersByScope, `${byParent ? 'P' : 'K'}\u0000${key}\u0000${e.kind}`, e.id)
  }
  for (const list of peersByScope.values()) list.sort(compareIds)

  const resolve = (id: string, rel: Relation): string[] => {
    const element = byId.get(id)
    if (element === undefined) return [...EMPTY]
    if (rel === 'subs') return subs.get(id) ?? [...EMPTY]
    if (rel === 'supers') return supers.get(id) ?? [...EMPTY]
    if (rel === 'peers') {
      const { key, byParent } = peerScope(element)
      const all = peersByScope.get(`${byParent ? 'P' : 'K'}\u0000${key}\u0000${element.kind}`)
      return (all ?? EMPTY).filter(other => other !== id)
    }
    // imports are module->module, so an element's importers are its module's.
    const mod = moduleOf(id)
    if (mod === null) return [...EMPTY]
    const list = (rel === 'importers' ? importers : imports).get(mod) ?? EMPTY
    return list.filter(other => other !== mod)
  }

  const counts = (id: string): Record<Relation, number> => ({
    subs: resolve(id, 'subs').length,
    supers: resolve(id, 'supers').length,
    importers: resolve(id, 'importers').length,
    imports: resolve(id, 'imports').length,
    peers: resolve(id, 'peers').length,
  })

  return { moduleOf, resolve, counts }
}
