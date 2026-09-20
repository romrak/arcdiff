import { useEffect, useMemo, useState } from 'react'
import type { Element } from '@arcdiff/model'
// Type-only, and it MUST stay type-only. `@arcdiff/diff`'s main barrel is
// clean again (body.ts's stray value import of the full `@arcdiff/git`
// barrel — which drags in node:child_process — is fixed), but that barrel
// was pure "by convention" until one value import broke it, undetected until
// something tried to bundle it two packages downstream. `import type` is
// erased outright regardless of whether the barrel is currently clean, so
// this stays type-only rather than depending on that staying true. Any VALUE
// needed from `@arcdiff/diff` goes through a narrow subpath instead — see
// `PEER_COUNT_THRESHOLD` below, and `@arcdiff/git/hunks` for the precedent.
import type { Signal } from '@arcdiff/diff'
import { PEER_COUNT_THRESHOLD } from '@arcdiff/diff/signals'
// '@arcdiff/git/hunks', NOT '@arcdiff/git': the bare barrel re-exports
// repo.js, which imports node:child_process at module scope and breaks the
// browser bundle. See api.ts for the same rule.
import { parseChangedLines, spanOverlaps, type LineSpan } from '@arcdiff/git/hunks'
import { attributionRange } from '@arcdiff/view-model'
import type { ViewerData } from './api.js'
import type { View } from './App.js'

interface DiffLine { tag: '+' | '-' | ' '; text: string }

interface DiffHunk {
  oldStart: number
  oldEnd: number
  newStart: number
  newEnd: number
  lines: DiffLine[]
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * Every `@@`-delimited hunk in a single-file unified diff, keeping the real
 * line content. `parseChangedLines` throws content away to keep only changed
 * line NUMBERS, which is enough for attribution but not for rendering — this
 * walks the same diff text a second time and keeps what it dropped.
 */
function parseDiffHunks(diffText: string): DiffHunk[] {
  const out: DiffHunk[] = []
  let current: DiffHunk | null = null
  for (const raw of diffText.split('\n')) {
    const h = HUNK_HEADER.exec(raw)
    if (h !== null) {
      const oldStart = Number(h[1])
      const oldLen = h[2] === undefined ? 1 : Number(h[2])
      const newStart = Number(h[3])
      const newLen = h[4] === undefined ? 1 : Number(h[4])
      current = {
        oldStart, oldEnd: oldLen === 0 ? oldStart : oldStart + oldLen - 1,
        newStart, newEnd: newLen === 0 ? newStart : newStart + newLen - 1,
        lines: [],
      }
      out.push(current)
      continue
    }
    const tag = raw[0]
    if (current !== null && (tag === '+' || tag === '-' || tag === ' ')) {
      current.lines.push({ tag, text: raw.slice(1) })
    }
    // Anything else — "\ No newline at end of file", the trailing '' the
    // final split produces, text before the first hunk — is not a line the
    // diff itself carries, so it renders nothing.
  }
  return out
}

/**
 * Hunks whose own span — new-side normally, old-side for a `removed`
 * element, since it only ever existed on the base side — overlaps at least
 * one of the changed-line spans `attributionRange` already qualified.
 */
function overlappingHunks(
  hunks: readonly DiffHunk[], spans: readonly LineSpan[], removed: boolean,
): DiffHunk[] {
  return hunks.filter(h => {
    const range: [number, number] = removed ? [h.oldStart, h.oldEnd] : [h.newStart, h.newEnd]
    return spans.some(s => spanOverlaps(range, s))
  })
}

/**
 * A `new-peer` signal's `detail` bakes in `formatPeerCount`'s capped text
 * ("900+"), which is not wrong so much as incomplete: `peerCount` (934) is
 * the real number, kept on the signal for exactly this — see its doc comment
 * in `@arcdiff/diff`. Compared directly against the same threshold
 * `formatPeerCount` caps at, imported from `@arcdiff/diff/signals` — no
 * regex over `detail`'s rendered prose, and no dependence on its exact
 * wording. States the real count outright rather than an overage:
 * `formatPeerCount` itself isn't exported, so there is no way to recover
 * what its capped form showed, and exporting it just to compute a delta
 * isn't worth a second export.
 */
function peerOverflow(signal: Signal): string | null {
  if (signal.peerCount === undefined || signal.peerCount <= PEER_COUNT_THRESHOLD) return null
  return `(exactly ${signal.peerCount})`
}

export function DiffPane({ selected, view, data }: {
  selected: string | null
  view: View
  data: ViewerData
}) {
  const change = selected === null
    ? undefined
    : data.doc.delta.elements.find(c => c.id === selected)
  const removed = change?.change === 'removed'
  // A removed element exists only on the base side. Everything else — an
  // element that changed, and the far more common case of one that did not —
  // is read from the box tree, which already indexes every head element and
  // is null for a synthesized package box, so clicking one falls through to
  // "no details" rather than a crash.
  const element: Element | undefined = selected === null
    ? undefined
    : removed ? change?.before : (change?.after ?? (view.tree.get(selected)?.element ?? undefined))

  const signals = selected === null
    ? []
    : data.doc.signals.filter(s => s.elementId === selected || s.relatedId === selected)

  const [diff, setDiff] = useState<{ file: string; text: string } | null>(null)
  useEffect(() => {
    const file = element?.file
    if (file === undefined) return
    let cancelled = false
    fetch(`/api/diff?file=${encodeURIComponent(file)}`)
      // A 404 — the file is unknown to the server, which should not happen
      // since `knownFiles` unions base and head — reads the same as a file
      // with no diff at all: no hunks, "no text change in this element".
      .then(res => (res.ok ? res.text() : Promise.resolve('')))
      .then(text => { if (!cancelled) setDiff({ file, text }) })
      .catch(() => { if (!cancelled) setDiff({ file, text: '' }) })
    return () => { cancelled = true }
  }, [element?.file])

  // `diff` lags a fresh selection by a render or more, however long the fetch
  // takes. The file it was fetched for is the tell, not a separate flag: it
  // can only equal the current element's file once the right response has
  // landed, which is also the only moment rendering its hunks is correct
  // rather than stale.
  const ready = diff !== null && element !== undefined && diff.file === element.file

  const hunks = useMemo(() => {
    if (!ready || element === undefined || diff === null) return []
    const changedLines = parseChangedLines(diff.text).find(f => f.file === element.file)
    const spans = (removed ? changedLines?.base : changedLines?.head) ?? []
    const mine = attributionRange(element)
    const qualifying = spans.filter(s => spanOverlaps(mine, s))
    // No changed line falls inside this element at all: it changed only
    // through a compared field (a signature edit with no text to show), or
    // this is an unmodified element clicked out of curiosity. Either way,
    // that is a fact worth stating, not a blank pane.
    if (qualifying.length === 0) return []
    return overlappingHunks(parseDiffHunks(diff.text), qualifying, removed)
  }, [ready, diff, element, removed])

  if (selected === null) {
    return (
      <aside className="pane" data-pane="diff">
        <p>Select an element.</p>
      </aside>
    )
  }

  if (element === undefined) {
    return (
      <aside className="pane" data-pane="diff">
        <p>No details for this selection.</p>
      </aside>
    )
  }

  return (
    <aside className="pane" data-pane="diff">
      <header className="pane__header">
        <div className="pane__kind">{element.kind}{removed ? ' · removed' : ''}</div>
        <div className="pane__name">{element.name}</div>
        <div className="pane__fqid">{element.id}</div>
        {element.signature !== undefined && (
          <div className="pane__signature">{element.signature}</div>
        )}
      </header>

      {signals.length > 0 && (
        <section className="pane__signals">
          <h3>Signals</h3>
          <ul>
            {signals.map((signal, i) => {
              const overflow = peerOverflow(signal)
              return (
                <li key={i}>
                  {signal.detail}
                  {overflow !== null && <span className="pane__overflow"> {overflow}</span>}
                </li>
              )
            })}
          </ul>
        </section>
      )}

      <section className="pane__diff">
        <h3>Diff</h3>
        {!ready && <p>Loading…</p>}
        {ready && hunks.length === 0 && <p>No text change in this element.</p>}
        {ready && hunks.map((hunk, i) => (
          <pre key={i} className="pane__hunk">
            {hunk.lines.map((line, j) => {
              const kind = line.tag === '+' ? 'add' : line.tag === '-' ? 'del' : 'ctx'
              return (
                <div key={j} className={`pane__line pane__line--${kind}`}>
                  {line.tag}{line.text}
                </div>
              )
            })}
          </pre>
        ))}
      </section>
    </aside>
  )
}
