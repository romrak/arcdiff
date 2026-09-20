import type { Delta, Model } from '@arcdiff/model'
// Type-only, and it MUST stay type-only. `@arcdiff/diff`'s main barrel is
// clean again (body.ts's stray value import of the full `@arcdiff/git`
// barrel — which drags in node:child_process — is fixed), but that barrel
// was pure "by convention" until one value import broke it, undetected until
// something tried to bundle it two packages downstream. `import type` is
// erased outright regardless of whether the barrel is currently clean, so
// this stays type-only rather than depending on that staying true. Any VALUE
// needed from `@arcdiff/diff` goes through a narrow subpath instead — see
// `PEER_COUNT_THRESHOLD` in DiffPane.tsx, and `@arcdiff/git/hunks` below for
// the precedent.
import type { Signal } from '@arcdiff/diff'
// '@arcdiff/git/hunks', NOT '@arcdiff/git'. The bare barrel re-exports
// repo.js, which imports node:child_process, node:fs/promises and node:os at
// module scope — importing it here drags Node builtins into the browser
// bundle, and Vite fails with an error that points at THIS file rather than
// at the barrel two packages away.
import { parseChangedLines, type FileChangedLines } from '@arcdiff/git/hunks'

/**
 * The delta document as the viewer needs it. `@arcdiff/server` exports a
 * `DeltaDocument` too, but its `delta.elements` is `unknown[]` (the server
 * never inspects them), which `attributeChanges` cannot take. Same wire
 * shape, typed for a consumer.
 */
export interface DeltaDocument {
  delta: Delta
  signals: Signal[]
  source: {
    repoRoot: string
    subdir: string
    base: { ref: string; modelPath: string }
    head: { ref: string; modelPath: string }
    capabilities: Record<string, boolean> | null
  }
}

export interface ViewerData {
  doc: DeltaDocument
  base: Model
  head: Model
  changedLines: FileChangedLines[]
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`${path}: ${res.status} ${res.statusText}`)
  return (await res.json()) as T
}

/**
 * Around 14.6 MB over localhost: two ~7.3 MB models, the delta, and one diff
 * per changed file. A few hundred milliseconds of JSON parsing is expected —
 * this is not the place for streaming or caching cleverness.
 */
export async function loadAll(): Promise<ViewerData> {
  const doc = await getJson<DeltaDocument>('/api/delta')
  const [base, head] = await Promise.all([
    getJson<Model>('/api/model/base'),
    getJson<Model>('/api/model/head'),
  ])

  // Files from BOTH sides of each change: a removed element has no `after`.
  const files = new Set<string>()
  for (const change of doc.delta.elements) {
    const element = change.after ?? change.before
    if (element !== undefined) files.add(element.file)
  }

  const changedLines: FileChangedLines[] = []
  await Promise.all(
    [...files].map(async file => {
      const res = await fetch(`/api/diff?file=${encodeURIComponent(file)}`)
      // The server unions base and head file sets precisely so a file deleted
      // between the refs still resolves here (see packages/server/src/index.ts
      // and docs/VALIDATION.md, "Known gap, corrected") — a 404 is not expected
      // on that path. Handled defensively anyway: it costs attribution for one
      // file, and must not cost the whole load.
      if (!res.ok) return
      changedLines.push(...parseChangedLines(await res.text()))
    }),
  )

  return { doc, base, head, changedLines }
}
