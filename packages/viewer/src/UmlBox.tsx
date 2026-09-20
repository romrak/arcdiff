import { createContext, useContext } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { ElementKind } from '@arcdiff/model'
import { RELATIONS, type ChangeState, type Relation } from '@arcdiff/view-model'
import type { MemberRow } from './boxes.js'

/** `●` is a change of this element's own; `◐` is a change somewhere inside it. */
const MARKER: Record<ChangeState, string> = { direct: '●', contains: '◐' }

const GLYPH: Record<Relation, string> = {
  subs: '↑', supers: '↓', importers: '←', imports: '→', peers: '≈',
}

export interface BoxData extends Record<string, unknown> {
  boxId: string
  kind: ElementKind
  label: string
  /** Set only when this element is itself in the delta. */
  state?: ChangeState
  /** Something in this box's subtree changed. Not the `●`/`◐` marker. */
  rollup?: ChangeState
  rows: MemberRow[]
  /** How many rows the 12-row cap hides, whether or not it is lifted. */
  hiddenRows: number
  rowsExpanded: boolean
  /** Null on a package box, which has no relations of its own. */
  counts: Record<Relation, number> | null
  loadedRelations: Relation[]
  /** How many of this box's direct children are folded into it. */
  foldedChildren: number
  foldable: boolean
  /** Height of the header-and-rows strip; the rest holds child boxes. */
  stripHeight: number
}

export interface BoxActions {
  selected: string | null
  onSelect(id: string): void
  onToggleRelation(id: string, relation: Relation): void
  onToggleRows(id: string): void
  /** Fold this box into its parent. */
  onFold(id: string): void
  /** Bring this box's directly folded children back. */
  onUnfoldChildren(id: string): void
}

export const BoxActionsContext = createContext<BoxActions>({
  selected: null,
  onSelect: () => {},
  onToggleRelation: () => {},
  onToggleRows: () => {},
  onFold: () => {},
  onUnfoldChildren: () => {},
})

export function UmlBox({ data }: NodeProps & { data: BoxData }) {
  const actions = useContext(BoxActionsContext)
  const isSelected = actions.selected === data.boxId
  const loaded = new Set(data.loadedRelations)
  const hasRelations = data.counts !== null && RELATIONS.some(r => (data.counts?.[r] ?? 0) > 0)

  const stop = (run: () => void) => (event: { stopPropagation(): void }) => {
    event.stopPropagation()
    run()
  }

  return (
    <div
      className={`uml uml--${data.kind}${isSelected ? ' is-selected' : ''}`}
      data-box={data.boxId}
      data-kind={data.kind}
      {...(data.state === undefined ? {} : { 'data-state': data.state })}
      {...(data.rollup === undefined || data.state !== undefined
        ? {}
        : { 'data-rollup': data.rollup })}
      onClick={stop(() => { actions.onSelect(data.boxId) })}
    >
      <Handle type="target" position={Position.Top} className="uml__port" />
      <div className="uml__header" style={{ height: 28 }}>
        {data.foldable && (
          <button
            type="button"
            className="uml__fold"
            data-collapse={data.boxId}
            aria-expanded={data.foldedChildren === 0}
            title={data.foldedChildren > 0 ? 'Unfold contents' : 'Fold into parent'}
            onClick={stop(() => {
              // A folded box is gone, so the affordance that brings it back
              // lives on the parent — which means the parent must unfold its
              // CHILDREN. Folding itself would swallow the only control that
              // can undo the fold.
              if (data.foldedChildren > 0) actions.onUnfoldChildren(data.boxId)
              else actions.onFold(data.boxId)
            })}
          >
            {data.foldedChildren > 0 ? `⊞${data.foldedChildren}` : '⊟'}
          </button>
        )}
        <span className="uml__name">
          {data.kind === 'interface' && <em className="uml__stereo">«interface»&nbsp;</em>}
          {data.label}
        </span>
        <span className="uml__kind">{data.kind}</span>
        {data.state !== undefined && (
          <span className={`uml__marker uml__marker--${data.state}`}>{MARKER[data.state]}</span>
        )}
      </div>

      {(data.rows.length > 0 || data.hiddenRows > 0) && (
        <div className="uml__members">
          {data.rows.map(row => (
            <div
              key={row.id}
              className={`uml__row${row.state === undefined ? '' : ' is-changed'}${
                actions.selected === row.id ? ' is-selected' : ''}`}
              data-member={row.id}
              {...(row.state === undefined ? {} : { 'data-state': row.state })}
              title={row.label}
              onClick={stop(() => { actions.onSelect(row.id) })}
            >
              <span className="uml__rowmark">
                {row.state === undefined ? '' : MARKER[row.state]}
              </span>
              <span className="uml__rowlabel">{row.label}</span>
            </div>
          ))}
          {data.hiddenRows > 0 && (
            <div
              className="uml__row uml__row--more"
              data-more={data.boxId}
              onClick={stop(() => { actions.onToggleRows(data.boxId) })}
            >
              <span className="uml__rowmark" />
              <span className="uml__rowlabel">
                {data.rowsExpanded ? '… fewer' : `… ${data.hiddenRows} more`}
              </span>
            </div>
          )}
        </div>
      )}

      {data.counts !== null && hasRelations && (
        <div className="uml__strip" style={{ top: data.stripHeight - 34 }}>
          <span className="uml__dot" aria-hidden="true" />
          <div className="uml__footer">
            {RELATIONS.map(relation => {
              const count = data.counts?.[relation] ?? 0
              return (
                <button
                  type="button"
                  key={relation}
                  className={`uml__rel${count === 0 ? ' is-zero' : ''}${
                    loaded.has(relation) ? ' is-loaded' : ''}`}
                  data-relation={relation}
                  data-count={count}
                  title={`${relation}: ${count}`}
                  onClick={stop(() => { actions.onToggleRelation(data.boxId, relation) })}
                >
                  {GLYPH[relation]}{count}
                </button>
              )
            })}
          </div>
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className="uml__port" />
    </div>
  )
}
