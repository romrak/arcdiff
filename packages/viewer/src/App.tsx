import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Edge } from '@arcdiff/model'
import {
  RELATIONS, attributeChanges, buildBoxTree, buildRelationIndex, expand, toggleExpansion,
  type BoxNode, type ChangeState, type Expanded, type Loaded, type Relation, type RelationIndex,
} from '@arcdiff/view-model'
import { Canvas } from './Canvas.js'
import type { DetailLevel } from './boxes.js'
import { DiffPane } from './DiffPane.js'
import { loadAll, type ViewerData } from './api.js'

export interface View {
  index: RelationIndex
  changed: ReadonlySet<string>
  visible: ReadonlySet<string>
  provenance: Expanded['provenance']
  states: ReadonlyMap<string, ChangeState>
  tree: ReadonlyMap<string, BoxNode>
  /** Head-side edges, for rolling up onto whatever is on screen. */
  edges: readonly Edge[]
  loaded: Loaded
}

export function App() {
  const [data, setData] = useState<ViewerData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState<Loaded>(new Map<string, Set<Relation>>())
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set<string>())
  const [detail, setDetail] = useState<DetailLevel>('member')
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => {
    void loadAll().then(setData, (e: Error) => { setError(e.message) })
  }, [])

  const view = useMemo<View | null>(() => {
    if (data === null) return null
    const index = buildRelationIndex(data.head)
    const changed = new Set(data.doc.delta.elements.map(c => c.id))
    const { visible, provenance } = expand(index, changed, loaded)
    const states = attributeChanges(
      data.doc.delta.elements, data.base, data.head, data.changedLines,
    )
    return {
      index, changed, visible, provenance, states,
      tree: buildBoxTree(data.head.elements),
      edges: data.head.edges,
      loaded,
    }
  }, [data, loaded])

  const onToggleRelation = useCallback((id: string, relation: Relation) => {
    setLoaded(l => toggleExpansion(l, id, relation))
  }, [])

  const onToggleCollapse = useCallback((id: string) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  /**
   * A folded box is gone from the canvas, so the control that brings it back
   * lives on its parent — which means the parent unfolds its CHILDREN, not
   * itself. The canvas resolves which ids those are; it holds the child index.
   */
  const onUnfold = useCallback((ids: readonly string[]) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      for (const id of ids) next.delete(id)
      return next
    })
  }, [])

  /** The bulk escape hatch: every relation on every box now on screen. */
  const onExpandHop = useCallback((ids: readonly string[]) => {
    setLoaded(previous => {
      let next = previous
      for (const id of ids) {
        // Package boxes are synthesized, not elements; they have no relations.
        if (view === null || (view.tree.get(id)?.element ?? null) === null) continue
        for (const relation of RELATIONS) {
          if (next.get(id)?.has(relation) === true) continue
          next = toggleExpansion(next, id, relation)
        }
      }
      return next
    })
  }, [view])

  /** Undoes both controls: every fold, and the zoom level. */
  const onReset = useCallback(() => {
    setDetail('member')
    setCollapsed(new Set<string>())
  }, [])

  if (error !== null) return <div className="loading loading--error">{error}</div>
  if (data === null || view === null) return <div className="loading">extracting…</div>

  return (
    <div className="app">
      <Canvas
        view={view}
        collapsed={collapsed}
        detail={detail}
        selected={selected}
        onToggleRelation={onToggleRelation}
        onToggleCollapse={onToggleCollapse}
        onUnfold={onUnfold}
        onSelect={setSelected}
        onExpandHop={onExpandHop}
        onSetDetail={setDetail}
        onReset={onReset}
      />
      <DiffPane selected={selected} view={view} data={data} />
    </div>
  )
}
