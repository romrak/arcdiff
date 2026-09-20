import {
  COMPARED_FIELDS, compareIds,
  type ComparedField, type Delta, type Edge,
  type EdgeChange, type Element, type ElementChange, type Model,
} from '@arcdiff/model'

export function edgeKey(e: Edge): string {
  return `${e.from}|${e.to}|${e.kind}`
}

function changedFields(a: Element, b: Element): ComparedField[] {
  const out: ComparedField[] = []
  for (const f of COMPARED_FIELDS) {
    if (a[f] !== b[f]) out.push(f)
  }
  return out
}

/**
 * Pure structural diff of two models. No I/O.
 * `bodyChanged` is NOT set here — it needs git and is applied by annotateBodyChanges.
 */
export function diffModels(base: Model, head: Model): Delta {
  const baseById = new Map(base.elements.map(e => [e.id, e]))
  const headById = new Map(head.elements.map(e => [e.id, e]))

  const elements: ElementChange[] = []

  for (const [id, after] of headById) {
    const before = baseById.get(id)
    if (!before) {
      elements.push({ id, change: 'added', after })
      continue
    }
    const fields = changedFields(before, after)
    if (fields.length > 0) {
      elements.push({ id, change: 'modified', before, after, fields })
    }
  }
  for (const [id, before] of baseById) {
    if (!headById.has(id)) elements.push({ id, change: 'removed', before })
  }

  const baseEdges = new Map(base.edges.map(e => [edgeKey(e), e]))
  const headEdges = new Map(head.edges.map(e => [edgeKey(e), e]))
  const edges: EdgeChange[] = []
  for (const [k, edge] of headEdges) {
    if (!baseEdges.has(k)) edges.push({ edge, change: 'added' })
  }
  for (const [k, edge] of baseEdges) {
    if (!headEdges.has(k)) edges.push({ edge, change: 'removed' })
  }

  elements.sort((a, b) => compareIds(a.id, b.id))
  edges.sort((a, b) => compareIds(edgeKey(a.edge), edgeKey(b.edge)))

  return { base: base.ref, head: head.ref, elements, edges }
}
