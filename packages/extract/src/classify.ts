import type { Element } from '@arcdiff/model'

export interface ResolvedBase {
  fromId: string
  /** Element id the base resolved to, or null when it resolved outside the repo. */
  toId: string | null
  /** Source text of the base expression, e.g. "ABC" or "abc.ABC". */
  text: string
}

const STRUCTURAL_BASES = new Set(['ABC', 'Protocol'])

function lastSegment(text: string): string {
  const head = text.split('[')[0]!
  return head.split('.').pop()!.trim()
}

/**
 * Flip kind 'class' -> 'interface' per the spec rule:
 *   a base is ABC or Protocol, OR the class declares >=1 @abstractmethod member.
 * A base that resolved to a repo element is NOT treated as ABC/Protocol even if
 * it is spelled that way — a user class named ABC is a normal class.
 * Returns a new array; does not mutate its input.
 */
export function classifyInterfaces(
  elements: Element[],
  bases: ResolvedBase[],
): Element[] {
  const abstractOwners = new Set<string>()
  for (const e of elements) {
    if (e.abstract === true && e.parent) abstractOwners.add(e.parent)
  }

  const structuralOwners = new Set<string>()
  for (const b of bases) {
    if (b.toId !== null) continue // resolved in-repo: a real class, not stdlib ABC
    if (STRUCTURAL_BASES.has(lastSegment(b.text))) structuralOwners.add(b.fromId)
  }

  return elements.map(e => {
    if (e.kind !== 'class') return e
    if (structuralOwners.has(e.id) || abstractOwners.has(e.id)) {
      return { ...e, kind: 'interface' as const }
    }
    return e
  })
}
