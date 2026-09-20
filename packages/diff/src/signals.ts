import { compareIds } from '@arcdiff/model'
import type { Delta, Element, Model } from '@arcdiff/model'

export type SignalKind =
  | 'new-interface'
  | 'new-implementation'
  | 'new-member'
  | 'signature-changed'
  | 'unimplemented-contract'
  | 'new-peer'

export interface Signal {
  kind: SignalKind
  elementId: string
  relatedId?: string
  detail: string
  /**
   * The exact peer count for a `new-peer` signal. `detail` renders this
   * through `formatPeerCount`, which is lossy above `PEER_COUNT_THRESHOLD`
   * (53 renders as "50+") — this field is where the real number survives
   * into `delta.json` for a future consumer that wants it, e.g. a renderer
   * doing its own "…N more" affordance. Unset for every other signal kind.
   */
  peerCount?: number
}

/**
 * Above this, an exact peer count stops being useful information — a real
 * pipeline run against pip has 53 fields in `pip._internal.cli.cmdoptions`,
 * and "New field alongside 53 existing" tells a reader nothing except that
 * there are a lot of command-line options. Below it, the exact count is
 * small enough to be worth reading as-is.
 *
 * Exported (via the `./signals` subpath — see this package's package.json,
 * NOT the barrel, which pulls in Node builtins two hops away through
 * body.ts) so a consumer that already has the exact `peerCount` off the
 * signal, such as the viewer's side pane, can compare against the same
 * number `formatPeerCount` used, instead of scraping it back out of
 * `detail`'s rendered prose.
 */
export const PEER_COUNT_THRESHOLD = 20

/**
 * Exact count up to `PEER_COUNT_THRESHOLD`; above it, an order-of-magnitude
 * form ("900+") that keeps a crowded package's peer count readable instead
 * of dumping a raw number like 53 into the signal text.
 */
function formatPeerCount(count: number): string {
  if (count <= PEER_COUNT_THRESHOLD) return String(count)
  const magnitude = 10 ** Math.floor(Math.log10(count))
  const rounded = Math.floor(count / magnitude) * magnitude
  return `${rounded}+`
}

export function deriveSignals(delta: Delta, base: Model, head: Model): Signal[] {
  const out: Signal[] = []
  const baseById = new Map(base.elements.map(e => [e.id, e]))
  const headById = new Map(head.elements.map(e => [e.id, e]))
  const addedIds = new Set(
    delta.elements.filter(c => c.change === 'added').map(c => c.id),
  )

  // Where an element's peers live. A method's or field's peers are its siblings
  // on the owning class — NOT every member in the package, which for one changed
  // method in pip._internal.resolution.resolvelib would mean 166 "peers" and
  // tell a reviewer nothing.
  //
  // Duplicated in packages/view-model/src/relations.ts (`peerScope` there, used
  // by the box footer's `≈ peers` count). Not shared on purpose — see that
  // file's comment for why. Keep the two rules in step by hand: if they drift,
  // a `new-peer` signal's `peerCount` and the footer's peer count would answer
  // different questions about the same element, and nothing would say so.
  function peerScope(e: Element): string {
    return e.kind === 'method' || e.kind === 'field' ? (e.parent ?? e.package) : e.package
  }

  // Peer index over BASE: scope + kind -> count.
  const peerKey = (scope: string, kind: Element['kind']) => `${scope}\u0000${kind}`
  const basePeers = new Map<string, number>()
  for (const e of base.elements) {
    const k = peerKey(peerScope(e), e.kind)
    basePeers.set(k, (basePeers.get(k) ?? 0) + 1)
  }

  for (const change of delta.elements) {
    // 1. new interface
    if (change.change === 'added' && change.after?.kind === 'interface') {
      out.push({
        kind: 'new-interface',
        elementId: change.id,
        detail: `New interface ${change.after.name}`,
      })
    }

    // 3. new member — parent existed in base
    if (change.change === 'added' && change.after?.parent) {
      const parentId = change.after.parent
      if (baseById.has(parentId)) {
        out.push({
          kind: 'new-member',
          elementId: change.id,
          relatedId: parentId,
          detail: `${change.after.name} added to existing ${baseById.get(parentId)!.name}`,
        })
      }
    }

    // 4. signature changed
    if (change.change === 'modified' && change.fields?.includes('signature')) {
      out.push({
        kind: 'signature-changed',
        elementId: change.id,
        detail: `Signature changed: ${change.before?.signature ?? '(none)'} -> ${change.after?.signature ?? '(none)'}`,
      })
    }

    // 6. new peer — scope + kind already populated in base
    if (change.change === 'added' && change.after) {
      const scope = peerScope(change.after)
      const count = basePeers.get(peerKey(scope, change.after.kind)) ?? 0
      if (count > 0) {
        out.push({
          kind: 'new-peer',
          elementId: change.id,
          relatedId: scope,
          detail: `New ${change.after.kind} alongside ${formatPeerCount(count)} existing in ${scope}`,
          peerCount: count,
        })
      }
    }
  }

  // 2. new implementation — added implements edge into an interface that pre-existed
  for (const ec of delta.edges) {
    if (ec.change !== 'added' || ec.edge.kind !== 'implements') continue
    const target = baseById.get(ec.edge.to)
    if (!target || target.kind !== 'interface') continue
    if (addedIds.has(ec.edge.to)) continue
    const impl = headById.get(ec.edge.from)
    out.push({
      kind: 'new-implementation',
      elementId: ec.edge.from,
      relatedId: ec.edge.to,
      detail: `${impl?.name ?? ec.edge.from} now implements ${target.name}`,
    })
  }

  // 5. unimplemented contract.
  // Predicate: an interface gained an abstract method M, and an implementer has
  // no CONCRETE member named M reachable in HEAD. This is a member-set lookup on
  // head, NOT a check for whether the implementer changed.
  const headMembersByOwner = new Map<string, Element[]>()
  for (const e of head.elements) {
    if (!e.parent) continue
    const list = headMembersByOwner.get(e.parent)
    if (list) list.push(e)
    else headMembersByOwner.set(e.parent, [e])
  }

  /** Concrete member names on `ownerId`, following extends/implements upward. */
  const concreteMembers = (ownerId: string): Set<string> => {
    const names = new Set<string>()
    const seen = new Set<string>()
    const stack = [ownerId]
    while (stack.length > 0) {
      const cur = stack.pop()!
      if (seen.has(cur)) continue
      seen.add(cur)
      for (const m of headMembersByOwner.get(cur) ?? []) {
        if (m.abstract !== true) names.add(m.name)
      }
      for (const edge of head.edges) {
        if (edge.from === cur && (edge.kind === 'extends' || edge.kind === 'implements')) {
          stack.push(edge.to)
        }
      }
    }
    return names
  }

  const newAbstractByInterface = new Map<string, Element[]>()
  for (const change of delta.elements) {
    const becameAbstract = change.change === 'added'
      || (change.change === 'modified' && change.fields?.includes('abstract'))
    if (!becameAbstract) continue
    const m = change.after
    if (!m || m.abstract !== true || !m.parent) continue
    const owner = headById.get(m.parent)
    if (!owner || owner.kind !== 'interface') continue
    const list = newAbstractByInterface.get(m.parent)
    if (list) list.push(m)
    else newAbstractByInterface.set(m.parent, [m])
  }

  /** Every element whose extends/implements chain reaches `interfaceId`, transitively. */
  const transitiveImplementers = (interfaceId: string): Set<string> => {
    const found = new Set<string>()
    const seen = new Set<string>()
    const stack = [interfaceId]
    while (stack.length > 0) {
      const cur = stack.pop()!
      if (seen.has(cur)) continue
      seen.add(cur)
      for (const edge of head.edges) {
        if (edge.to === cur && (edge.kind === 'extends' || edge.kind === 'implements')) {
          found.add(edge.from)
          stack.push(edge.from)
        }
      }
    }
    return found
  }

  for (const [interfaceId, newMethods] of newAbstractByInterface) {
    const iface = headById.get(interfaceId)!
    for (const implId of transitiveImplementers(interfaceId)) {
      const implElement = headById.get(implId)
      if (!implElement || implElement.kind !== 'class') continue
      const have = concreteMembers(implId)
      const missing = newMethods.filter(m => !have.has(m.name)).map(m => m.name)
      if (missing.length === 0) continue
      out.push({
        kind: 'unimplemented-contract',
        elementId: implId,
        relatedId: interfaceId,
        detail: `${implElement.name} does not implement ${iface.name}: ${missing.join(', ')}`,
      })
    }
  }

  out.sort((a, b) =>
    compareIds(a.kind, b.kind) || compareIds(a.elementId, b.elementId))
  return out
}
