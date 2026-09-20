import { compareIds, type Element } from '@arcdiff/model'
import type { BoxNode, ChangeState } from '@arcdiff/view-model'

/** Kinds that render as a row inside their owner's box rather than as a box. */
export function isMemberKind(kind: BoxNode['kind']): boolean {
  return kind === 'method' || kind === 'field'
}

/** At most this many member rows before the `… N more` row appears. */
export const ROW_CAP = 12

export type BoxTree = ReadonlyMap<string, BoxNode>

/** Children of each box, in compareIds order. Built once per model. */
export function childrenByBox(tree: BoxTree): Map<string, BoxNode[]> {
  const out = new Map<string, BoxNode[]>()
  for (const node of tree.values()) {
    if (node.parentBox === null) continue
    const list = out.get(node.parentBox)
    if (list) list.push(node)
    else out.set(node.parentBox, [node])
  }
  for (const list of out.values()) list.sort((a, b) => compareIds(a.id, b.id))
  return out
}

/** The box a changed element appears in: a member shows as a row on its owner. */
export function displayBoxOf(tree: BoxTree, id: string): string | null {
  const node = tree.get(id)
  if (node === undefined) return null
  return isMemberKind(node.kind) ? node.parentBox : node.id
}

/**
 * The strongest change state anywhere in each box's subtree, including the box
 * itself. A `direct` descendant beats a `contains` one.
 *
 * This is NOT the `●`/`◐` marker, which belongs only to an element that is
 * itself in the delta — the Playwright smoke test counts those, so only as
 * many nodes as there are changed elements with a box may carry one. This is
 * the "something in here changed" tint that makes the collapsed
 * whole-codebase view worth looking at.
 */
export function rollUpStates(
  tree: BoxTree, states: ReadonlyMap<string, ChangeState>,
): Map<string, ChangeState> {
  const out = new Map<string, ChangeState>()
  const mark = (boxId: string, state: ChangeState): void => {
    if (state === 'direct' || !out.has(boxId)) out.set(boxId, state)
  }
  for (const [id, state] of states) {
    let cursor = displayBoxOf(tree, id)
    while (cursor !== null) {
      mark(cursor, state)
      cursor = tree.get(cursor)?.parentBox ?? null
    }
  }
  return out
}

/**
 * The ordinal scale for the zoom axis, coarse to fine. Kinds map onto this
 * through KIND_LEVEL, and it does NOT change when the selectable levels do —
 * which is the whole point of keeping it separate from DETAIL_LEVELS. Deriving
 * the scale from the selectable list (`DETAIL_LEVELS.indexOf`) makes dropping
 * a level silently renumber the rest: with `['package', 'member']` the default
 * would score 1, every class, method and field would count as too deep, and
 * the default view would collapse to a handful of modules looking like a
 * rendering bug rather than arithmetic.
 */
const LEVEL_ORDINAL = { package: 0, module: 1, class: 2, member: 3 } as const
export type DetailLevel = keyof typeof LEVEL_ORDINAL

/**
 * The levels a reviewer can actually pick. `member` — the default — shows the
 * working set in full; anything coarser is a view of the WHOLE codebase at
 * that granularity.
 *
 * `module` and `class` are omitted deliberately, not forgotten. Against pip
 * — a small codebase by the standards this is meant for — `class` is 784
 * boxes and `module` is 162, and both grow with the codebase rather than
 * with the change. Neither was ever a requirement. Re-adding one is a
 * one-line change here — but measure the render first.
 */
export const DETAIL_LEVELS = ['package', 'member'] as const satisfies readonly DetailLevel[]

/** Which detail level a kind belongs to, on the same 0-3 scale. */
const KIND_LEVEL: Record<BoxNode['kind'], number> = {
  package: 0, module: 1, class: 2, interface: 2, function: 2, method: 3, field: 3,
}

export interface RenderPlan {
  /** Box ids that render, ancestors included. */
  rendered: ReadonlySet<string>
  /**
   * The box an element is drawn in, following folds and the detail level up to
   * the nearest rendered ancestor. Null for anything outside the working set,
   * so an edge is drawn only between two elements the reviewer actually pulled
   * onto the canvas.
   *
   * Without that restriction, dropping to `package` rolls all 866 structural
   * edges of the codebase onto the package boxes — measured against pip: 158
   * package-to-package edges, which lays out as a hairball at 10% zoom and
   * says nothing. The reviewer asked to see the changed elements and whatever
   * they expanded; a coarser level answers the same question at coarser
   * granularity.
   *
   * The restriction is `visible`, not `rendered` — an id can be on screen as
   * someone else's ancestor without itself being addressable here. Expanding
   * `subs` on a changed class can pull in a subclass whose module renders as
   * an ancestor box (because the subclass is visible) without the module ever
   * being added to `visible` itself; a later `importers` expansion reached
   * from that subclass then has no visible id to attach the module's importer
   * edges to, and they are silently dropped. Documented and pinned by a test,
   * not fixed — see `boxes.test.ts`.
   */
  renderedBoxOf(id: string): string | null
  /** Whether a box draws its member rows, or the level has taken them away. */
  showsMembers(id: string): boolean
  /**
   * Direct children of each rendered box that are folded into it AND would
   * otherwise be on screen. A fold hidden behind the detail level is not
   * counted: at `package` every module is gone anyway, so reporting folds
   * there would claim the fold is doing work it is not.
   */
  foldedChildren: ReadonlyMap<string, number>
}

/**
 * Which boxes are on screen, from two controls that answer different questions.
 *
 * **`collapsed` folds a box INTO ITS PARENT.** The box and its subtree leave
 * the canvas and their content is represented by the nearest ancestor that is
 * not itself folded. This is the "I have seen this one, get it out of my way"
 * gesture. Nothing is lost and it is not a one-way door: the surviving parent
 * carries a `⊞N` affordance that undoes the topmost fold, and Reset view
 * clears the set (along with `detail`, below).
 *
 * The alternative — a collapsed box keeps its own box and merely hides its
 * children — is a different gesture, and it cannot serve as the bulk control:
 * packages nest, so applying it to every package hides the nested ones and
 * leaves five root boxes.
 *
 * **`detail` is the zoom axis**, coarse to fine, and it is the bulk control.
 * A level draws no box below itself, which is what yields "every package,
 * nothing inside".
 *
 * One rule the level needs beyond filtering: a level coarser than `member`
 * renders every box at or above it, not just the ancestors of the working set.
 * Filtering alone would leave only the packages that happen to contain a
 * changed element — 8 of pip's 21, measured against the commit the viewer
 * e2e drives — rather than the whole codebase. Zooming out is what turns a
 * working-set view into a whole-codebase view.
 */
export function planBoxes(
  tree: BoxTree,
  visible: ReadonlySet<string>,
  collapsed: ReadonlySet<string>,
  detail: DetailLevel,
): RenderPlan {
  const maxLevel = LEVEL_ORDINAL[detail]
  const parentOf = (id: string): string | null => tree.get(id)?.parentBox ?? null
  const levelOf = (id: string): number => {
    const kind = tree.get(id)?.kind
    return kind === undefined ? KIND_LEVEL.field : KIND_LEVEL[kind]
  }
  /** Below the current detail level, so not drawn at all. */
  const tooDeep = (id: string): boolean => levelOf(id) > maxLevel

  const foldedCache = new Map<string, boolean>()
  /**
   * True when the box, or anything containing it, is folded away.
   *
   * A ROOT is never folded, whatever `collapsed` says. The undo for a fold
   * lives on the surviving parent, and a root has none — folding one would
   * take it and its whole subtree off the canvas with no affordance anywhere
   * to bring it back. The UI also withholds the control (see `foldable`), but
   * the invariant belongs here, where the semantics are.
   */
  const isFolded = (id: string): boolean => {
    const hit = foldedCache.get(id)
    if (hit !== undefined) return hit
    const parent = parentOf(id)
    const folded = parent !== null && (collapsed.has(id) || isFolded(parent))
    foldedCache.set(id, folded)
    return folded
  }

  /**
   * Every box the working set and the detail level ask for, IGNORING folds.
   * Folds are applied afterwards, which is what lets `foldedChildren` tell a
   * fold that is hiding something from one that is hiding nothing.
   *
   * Nothing extra is needed to keep a fold's undo reachable: the host that
   * carries it is an ancestor of the folded box, and reaching a box reaches
   * all of its ancestors.
   */
  const reachable = new Set<string>()
  const reach = (id: string | null): void => {
    let cursor = id
    while (cursor !== null && !reachable.has(cursor)) {
      reachable.add(cursor)
      cursor = parentOf(cursor)
    }
  }

  // The working set: every visible element, in its own box or as a row.
  for (const id of visible) {
    // The box tree is built from the HEAD model, so a REMOVED element has no
    // box at all. Skipping it loses a marker; falling back to the raw id would
    // put something the tree cannot describe into `rendered`, and the canvas
    // dereferences every rendered id.
    const box = displayBoxOf(tree, id)
    if (box === null) continue
    reach(box)
  }
  // Zoomed out: the codebase itself, at this granularity.
  if (maxLevel < LEVEL_ORDINAL.member) {
    for (const node of tree.values()) {
      if (KIND_LEVEL[node.kind] <= maxLevel) reach(node.id)
    }
  }

  const rendered = new Set<string>()
  for (const id of reachable) if (!tooDeep(id) && !isFolded(id)) rendered.add(id)

  const foldedChildren = new Map<string, number>()
  for (const id of collapsed) {
    if (!tree.has(id)) continue
    // A fold is only worth announcing when it is actually hiding something:
    // not below the detail level, and something that would have been drawn.
    // Counting unconditionally lets a package read `⊞20` and then unfold to
    // far fewer boxes.
    if (tooDeep(id) || !reachable.has(id)) continue
    const parent = parentOf(id)
    // Only the topmost fold in a chain is one a rendered parent can undo.
    if (parent === null || !rendered.has(parent)) continue
    foldedChildren.set(parent, (foldedChildren.get(parent) ?? 0) + 1)
  }

  const renderedBoxOf = (id: string): string | null => {
    if (!visible.has(id)) return null
    const start = displayBoxOf(tree, id)
    if (start === null) return null
    if (rendered.has(start)) return start
    // On screen somewhere, just not at this granularity: roll it up.
    let cursor = parentOf(start)
    while (cursor !== null) {
      if (rendered.has(cursor)) return cursor
      cursor = parentOf(cursor)
    }
    return null
  }

  return {
    rendered,
    renderedBoxOf,
    showsMembers: () => maxLevel >= LEVEL_ORDINAL.member,
    foldedChildren,
  }
}

export interface MemberRow {
  id: string
  label: string
  /** Set only when this member is itself in the delta. */
  state?: ChangeState
}

/**
 * The member rows for a box: its `method` and `field` children in compareIds
 * order, capped at ROW_CAP.
 *
 * Changed members are never cut. A 44-member class whose one changed method
 * sorts past the cap would otherwise hide the single row the reviewer opened
 * the tool for — and the smoke test clicks exactly such a row without
 * expanding anything first.
 */
export function memberRows(
  children: readonly BoxNode[],
  states: ReadonlyMap<string, ChangeState>,
  expanded: boolean,
): { rows: MemberRow[]; hidden: number } {
  // `hidden` is what the cap WOULD hide, not what is hidden right now:
  // reporting 0 once expanded takes away the row that is the only way back.
  const members = children.filter(c => isMemberKind(c.kind))
  const all: MemberRow[] = members.map(c => {
    const state = states.get(c.id)
    return {
      id: c.id,
      label: memberLabel(c.element, c.label),
      ...(state === undefined ? {} : { state }),
    }
  })
  if (all.length <= ROW_CAP) return { rows: all, hidden: 0 }

  const keep = new Set(all.filter(r => r.state !== undefined).map(r => r.id))
  for (const row of all) {
    if (keep.size >= ROW_CAP) break
    keep.add(row.id)
  }
  const capped = all.filter(r => keep.has(r.id))
  return { rows: expanded ? all : capped, hidden: all.length - capped.length }
}

function memberLabel(element: Element | null, fallback: string): string {
  if (element === null) return fallback
  if (element.kind === 'method' || element.kind === 'function') {
    return `${element.name}${element.signature ?? '()'}`
  }
  return element.signature === undefined
    ? element.name
    : `${element.name}: ${element.signature}`
}
