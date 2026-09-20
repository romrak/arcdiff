import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Background, Controls, MiniMap, Panel, ReactFlow, ReactFlowProvider,
  type Edge, type Node, useReactFlow, useStore,
} from '@xyflow/react'
import { compareIds } from '@arcdiff/model'
import { RELATIONS, aggregateEdges, measureBox, type Relation } from '@arcdiff/view-model'
import type { View } from './App.js'
import {
  DETAIL_LEVELS, childrenByBox, isMemberKind, memberRows, planBoxes, rollUpStates,
  type DetailLevel,
} from './boxes.js'
import { BoxActionsContext, UmlBox, type BoxData } from './UmlBox.js'

const nodeTypes = { uml: UmlBox }

/** Characters a label is allowed to contribute before it stops widening a box. */
const LABEL_CAP = 52

interface ElkNode {
  id: string
  width?: number
  height?: number
  x?: number
  y?: number
  children?: ElkNode[]
  layoutOptions?: Record<string, string>
}

interface ElkGraph extends ElkNode {
  edges: { id: string; sources: string[]; targets: string[] }[]
}

interface Geometry { x: number; y: number; width: number; height: number }

export interface CanvasProps {
  view: View
  collapsed: ReadonlySet<string>
  detail: DetailLevel
  selected: string | null
  onToggleRelation(id: string, relation: Relation): void
  onToggleCollapse(id: string): void
  onUnfold(ids: readonly string[]): void
  onSelect(id: string | null): void
  onExpandHop(ids: readonly string[]): void
  onSetDetail(detail: DetailLevel): void
  onReset(): void
}

export function Canvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  )
}

function CanvasInner({
  view, collapsed, detail, selected, onToggleRelation, onToggleCollapse,
  onUnfold, onSelect, onExpandHop, onSetDetail, onReset,
}: CanvasProps) {
  const [expandedRows, setExpandedRows] = useState<ReadonlySet<string>>(new Set())
  const [geometry, setGeometry] = useState<ReadonlyMap<string, Geometry>>(new Map())
  /** The structural key the current `geometry` was laid out for. */
  const [laidOutKey, setLaidOutKey] = useState<string | null>(null)
  const [layoutError, setLayoutError] = useState<string | null>(null)
  const { fitBounds } = useReactFlow()
  /**
   * WHICH nodes React Flow has actually taken, not how many. It ingests the
   * `nodes` prop into its own store and renders from THAT, one round behind,
   * so this is the only honest measure of what is on the canvas right now —
   * and a count would match by coincidence whenever a new set happens to be
   * the same size as the one it replaces, which is exactly the render this
   * needs to catch.
   */
  const renderedIds = useStore(state => state.nodes.map(node => node.id).join('\u0000'))

  const children = useMemo(() => childrenByBox(view.tree), [view.tree])
  const rollups = useMemo(() => rollUpStates(view.tree, view.states), [view.tree, view.states])
  const plan = useMemo(
    () => planBoxes(view.tree, view.visible, collapsed, detail),
    [view.tree, view.visible, collapsed, detail],
  )

  /**
   * Everything that decides a box's size or the graph's shape, and nothing
   * that does not. Hover and selection are deliberately absent: they must
   * never cost a relayout, which is why the footer's space is reserved
   * whether or not the footer is currently shown.
   */
  const boxes = useMemo(() => {
    const ids = [...plan.rendered].sort(compareIds)
    return ids.map(id => {
      const node = view.tree.get(id)!
      const kids = children.get(id) ?? []
      const rowsExpanded = expandedRows.has(id)
      const measured = memberRows(kids, view.states, rowsExpanded)
      const showsMembers = plan.showsMembers(id)
      const rows = showsMembers ? measured.rows : []
      const hidden = showsMembers ? measured.hidden : 0
      const counts = node.element === null ? null : view.index.counts(id)
      const hasFooter = counts !== null && RELATIONS.some(r => counts[r] > 0)
      const folded = plan.foldedChildren.get(id) ?? 0
      const childBoxes = kids.filter(c => !isMemberKind(c.kind) && plan.rendered.has(c.id))
      const rowCount = rows.length + (hidden > 0 ? 1 : 0)
      const longest = Math.min(LABEL_CAP, Math.max(
        node.label.length + node.kind.length + 6,
        ...rows.map(r => r.label.length + 4),
        hidden > 0 ? 18 : 0,
        hasFooter ? 34 : 0,
      ))
      const size = measureBox(rowCount, longest, hasFooter)
      const data: BoxData = {
        boxId: id,
        kind: node.kind,
        label: node.label,
        ...(view.states.has(id) ? { state: view.states.get(id)! } : {}),
        ...(rollups.has(id) ? { rollup: rollups.get(id)! } : {}),
        rows,
        hiddenRows: hidden,
        rowsExpanded,
        counts,
        loadedRelations: [...(view.loaded.get(id) ?? [])],
        foldedChildren: folded,
        // Offered only where it means "zoom out one level" AND something
        // survives to carry the undo. A ROOT has no parent to hold a `⊞`, so
        // folding one would erase it and its whole subtree with no way back
        // short of Reset view; `planBoxes` refuses to fold a root regardless,
        // so a control here would be inert as well as destructive.
        foldable: (childBoxes.length > 0 || folded > 0) && node.parentBox !== null,
        stripHeight: size.height,
      }
      return { id, parentId: node.parentBox, childBoxes: childBoxes.length, size, data }
    })
  }, [plan, view.tree, view.states, view.index, view.loaded, children, rollups,
      expandedRows, collapsed])

  const edges = useMemo(() => {
    // `contains` is drawn by nesting, so drawing it as well would put an
    // arrow from every box to every box inside it.
    const structural = view.edges.filter(e => e.kind !== 'contains')
    return aggregateEdges(structural, plan.renderedBoxOf)
  }, [view.edges, plan])

  const structuralKey = useMemo(() => {
    const parts = boxes.map(b => `${b.id}|${b.size.width}x${b.size.height}|${b.childBoxes}`)
    return `${parts.join('\n')}\n--\n${edges.map(e => `${e.from}>${e.to}`).join(',')}`
  }, [boxes, edges])

  // Pan and zoom never reach this effect: `structuralKey` is built only from
  // what is on screen and how big it is.
  const workerRef = useRef<Worker | null>(null)
  useEffect(() => {
    const worker = new Worker(new URL('./elk.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = worker
    return () => { worker.terminate(); workerRef.current = null }
  }, [])

  const boxesRef = useRef(boxes)
  boxesRef.current = boxes
  useEffect(() => {
    const worker = workerRef.current
    if (worker === null) return
    const current = boxesRef.current
    // An empty canvas needs no layout — but it does need the same bookkeeping
    // as one, or a failure from the previous key would sit over it forever
    // with nothing left that could clear it.
    if (current.length === 0) {
      setGeometry(new Map())
      setLaidOutKey(structuralKey)
      setLayoutError(null)
      return
    }

    const elkById = new Map<string, ElkNode>()
    for (const box of current) {
      const leaf = box.childBoxes === 0
      elkById.set(box.id, {
        id: box.id,
        ...(leaf ? { width: box.size.width, height: box.size.height } : {}),
        ...(leaf ? {} : {
          layoutOptions: {
            // Reserve the header-and-rows strip; without it ELK lays children
            // over the box's own title.
            'elk.padding':
              `[top=${box.size.height + 8},left=10,bottom=10,right=10]`,
            'elk.nodeSize.constraints': 'MINIMUM_SIZE',
            'elk.nodeSize.minimum': `(${box.size.width},${box.size.height + 20})`,
          },
        }),
      })
    }
    const roots: ElkNode[] = []
    for (const box of current) {
      const node = elkById.get(box.id)!
      const parent = box.parentId === null ? undefined : elkById.get(box.parentId)
      if (parent === undefined) roots.push(node)
      else (parent.children ??= []).push(node)
    }

    const graph: ElkGraph = {
      id: 'root',
      children: roots,
      edges: edges.map((e, i) => ({ id: `e${i}`, sources: [e.from], targets: [e.to] })),
    }

    let cancelled = false
    const key = structuralKey
    // A failure belongs to the key that produced it, so every new key clears
    // it — on this path and on the empty one above, which between them cover
    // every way this effect can run.
    setLayoutError(null)
    const onMessage = (event: MessageEvent) => {
      if (cancelled) return
      const reply = event.data as { key?: string; error?: string; layout?: ElkNode }
      // A reply for a graph the canvas has already moved past. Applying it
      // would set `laidOutKey` to a key nobody is waiting on any more and
      // report `idle` over stale geometry while the real layout is still
      // running — which is exactly the lie `data-layout` exists to prevent.
      // `cancelled` covers unmount; it does not cover supersession.
      if (reply.key !== key) return
      const failure = reply.error
      if (failure !== undefined) { setLayoutError(failure); setLaidOutKey(key); return }
      setLayoutError(null)
      const out = new Map<string, Geometry>()
      const walk = (node: ElkNode): void => {
        if (node.id !== 'root') {
          out.set(node.id, {
            x: node.x ?? 0, y: node.y ?? 0,
            width: node.width ?? 120, height: node.height ?? 28,
          })
        }
        for (const child of node.children ?? []) walk(child)
      }
      if (reply.layout !== undefined) walk(reply.layout)
      setGeometry(out)
      setLaidOutKey(key)
    }
    worker.addEventListener('message', onMessage)
    worker.postMessage({ key, graph })
    return () => { cancelled = true; worker.removeEventListener('message', onMessage) }
    // `boxes` is read through a ref: its contents change on hover-free
    // re-renders too, and only `structuralKey` should trigger a layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structuralKey])

  /**
   * `fitView` fits what React Flow has MEASURED, so calling it right after a
   * layout fits either the previous graph or a set of nodes whose size is not
   * known yet — both of which leave the canvas parked in a corner. ELK already
   * handed us exact bounds, so fit those instead and skip the measurement race
   * entirely. Only root-level geometry is absolute; children are relative to
   * their parent, so the union is taken over roots.
   */
  const rootIds = useMemo(
    () => boxes.filter(b => b.parentId === null || !plan.rendered.has(b.parentId))
      .map(b => b.id),
    [boxes, plan],
  )
  useEffect(() => {
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity
    for (const id of rootIds) {
      const geo = geometry.get(id)
      if (geo === undefined) continue
      x0 = Math.min(x0, geo.x); y0 = Math.min(y0, geo.y)
      x1 = Math.max(x1, geo.x + geo.width); y1 = Math.max(y1, geo.y + geo.height)
    }
    if (x0 === Infinity) return
    const bounds = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }

    // Retried on a short schedule rather than issued once. React Flow drops a
    // fit whose pan-zoom instance is not in its store yet, and that instance
    // lands in a layout effect of a descendant — i.e. possibly after this
    // effect, on the very commit that first puts nodes on the canvas. The fit
    // is idempotent, so repeating it is cheaper than racing it.
    //
    // Timers, NOT requestAnimationFrame: a tab that is backgrounded or
    // occluded — which includes how a test driver usually runs one — never
    // fires an animation frame, so an rAF-scheduled fit simply never happens
    // and the canvas sits in its top-left corner.
    const timers = [0, 60, 200].map(delay =>
      window.setTimeout(() => { fitBounds(bounds, { duration: 0 }) }, delay))
    return () => { for (const timer of timers) window.clearTimeout(timer) }
  }, [geometry, rootIds, fitBounds])

  const nodes: Node[] = useMemo(() => {
    const depth = (id: string): number => {
      let d = 0
      let cursor = view.tree.get(id)?.parentBox ?? null
      while (cursor !== null) { d++; cursor = view.tree.get(cursor)?.parentBox ?? null }
      return d
    }
    // Only boxes the last layout placed. During a relayout the previous
    // geometry keeps the canvas steady instead of stacking every new box at
    // the origin, and a child is never emitted before its parent exists.
    // React Flow also requires a parent to appear before its children.
    return boxes
      .filter(b => geometry.has(b.id))
      .sort((a, b) => depth(a.id) - depth(b.id) || compareIds(a.id, b.id))
      .map(box => {
        const geo = geometry.get(box.id)
        const width = geo?.width ?? box.size.width
        const height = geo?.height ?? box.size.height
        return {
          id: box.id,
          type: 'uml',
          position: { x: geo?.x ?? 0, y: geo?.y ?? 0 },
          // Both: `style` paints the box, `width`/`height` tell React Flow the
          // size before its ResizeObserver has measured anything. Without the
          // latter, a fit right after a layout fits unmeasured nodes.
          width,
          height,
          style: { width, height },
          data: box.data,
          ...(box.parentId !== null && geometry.has(box.parentId)
            ? { parentId: box.parentId }
            : {}),
          zIndex: 0,
          // `selectable: false` would make React Flow put `pointer-events:
          // none` on the node wrapper — it only enables them for a node that
          // is selectable, draggable, connectable or has a flow-level mouse
          // handler. The box would then be inert to a real pointer: no hover,
          // no clickable relation badges, no clickable member rows. (A
          // scripted `element.click()` still works, which is exactly how this
          // hides from anything but a real mouse.) Selection itself never
          // fires, because the box stops the click first.
          selectable: true,
          draggable: false,
          connectable: false,
        } satisfies Node
      })
  }, [boxes, geometry, view.tree])

  const flowEdges: Edge[] = useMemo(
    () => edges
      .filter(e => geometry.has(e.from) && geometry.has(e.to))
      .map(e => ({
        id: `${e.from}->${e.to}`,
        source: e.from,
        target: e.to,
        ...(e.count > 1 ? { label: String(e.count) } : {}),
        className: 'arc',
        // React Flow otherwise draws an invisible 20px-wide companion path
        // per edge to widen its click target. Nothing here listens for an
        // edge click, so that path is pure obstruction: it is painted over
        // the boxes and swallows clicks aimed at the member rows underneath,
        // which is the one gesture this canvas exists for.
        interactionWidth: 0,
      })),
    [edges, geometry],
  )

  const actions = useMemo(() => ({
    selected,
    onSelect,
    onToggleRelation,
    onToggleRows: (id: string) => {
      setExpandedRows(prev => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    },
    onFold: onToggleCollapse,
    // `childrenByBox` is already built, so the direct children are a map
    // lookup rather than a scan of all ~10k tree nodes per click.
    onUnfoldChildren: (id: string) => {
      onUnfold((children.get(id) ?? []).map(child => child.id))
    },
  }), [selected, onSelect, onToggleRelation, onToggleCollapse, onUnfold, children])

  const expectedIds = useMemo(() => nodes.map(node => node.id).join('\u0000'), [nodes])

  /**
   * Whether what is on screen is what is currently being asked for.
   *
   * Three terms, each closing a hole that was measured rather than imagined:
   *
   * 1. The structural key, not an in-flight flag, so it flips to `busy` in the
   *    same render that changes the graph, before any effect runs.
   * 2. `laidOutKey` can only be set by a reply carrying the key it was asked
   *    for. An unkeyed reply for a layout the canvas had already abandoned
   *    would stamp its own key in and announce `idle` over that abandoned
   *    layout's geometry while the real one was still computing.
   * 3. The node-id signature, because React Flow renders from its own store
   *    and ingests the prop a round later. Before this term Collapse all
   *    announced `idle` while the DOM still held 11 of its eventual 88 boxes.
   *    Comparing ids rather than counts matters: on the render a new set
   *    lands, the store still holds the previous one, and a count would match
   *    by coincidence whenever the two are the same size.
   *
   * What `idle` therefore promises: the geometry was computed for the key
   * being asked for now, React Flow holds exactly the nodes we handed it, and
   * that key's layout did not fail (a failure reports `error`, not `idle`).
   *
   * What it does NOT promise, stated rather than written around: that every
   * box the plan wants is on screen. `nodes` drops any box the layout did not
   * place, so an ELK result missing a node would go out as a canvas one box
   * short, reported as `idle`. Never observed. Gating on the pre-filter set
   * instead would turn one missing node into a permanent `busy`, which is a
   * worse failure than a rare silent one.
   */
  const settled = laidOutKey === structuralKey && renderedIds === expectedIds

  return (
    <div
      className="canvas"
      data-pane="canvas"
      data-layout={layoutError !== null ? 'error' : settled ? 'idle' : 'busy'}
    >
      <BoxActionsContext.Provider value={actions}>
        <ReactFlow
          nodes={nodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          minZoom={0.02}
          maxZoom={3}
          proOptions={{ hideAttribution: true }}
          onPaneClick={() => { onSelect(null) }}
        >
          <Background gap={24} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable />
          <Panel position="top-left">
            <div className="toolbar">
              <button
                type="button"
                onClick={() => { onExpandHop([...plan.rendered]) }}
              >
                Expand all visible by 1 hop
              </button>
              <button type="button" onClick={() => { onSetDetail('package') }}>
                Collapse all
              </button>
              <button type="button" onClick={onReset}>Reset view</button>
              <label className="toolbar__level">
                detail
                <select
                  value={detail}
                  data-detail={detail}
                  onChange={e => { onSetDetail(e.target.value as DetailLevel) }}
                >
                  {DETAIL_LEVELS.map(level => (
                    <option key={level} value={level}>{level}</option>
                  ))}
                </select>
              </label>
              <span className="toolbar__stat" data-stat="boxes">{boxes.length} boxes</span>
              <span className="toolbar__stat" data-stat="edges">{flowEdges.length} edges</span>
              {!settled && <span className="toolbar__stat">laying out…</span>}
              {layoutError !== null && (
                <span className="toolbar__stat toolbar__stat--error">
                  layout failed: {layoutError}
                </span>
              )}
            </div>
          </Panel>
        </ReactFlow>
      </BoxActionsContext.Provider>
    </div>
  )
}
