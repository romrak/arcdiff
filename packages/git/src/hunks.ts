export interface Hunk {
  /** Repo-relative path on the NEW side. */
  file: string
  /** 1-based first line on the new side. */
  newStart: number
  /** 1-based last line on the new side, inclusive. */
  newEnd: number
}

const NEW_FILE = /^\+\+\+ (?:b\/)?(.+)$/
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/

/**
 * Parse a unified diff, keeping only NEW-side line numbers, because element
 * ranges in a head Model are new-side coordinates.
 * Run `git diff --unified=0` upstream to keep hunks tight to real edits.
 */
export function parseUnifiedDiff(diffText: string): Hunk[] {
  const out: Hunk[] = []
  let file: string | null = null

  for (const line of diffText.split('\n')) {
    const f = NEW_FILE.exec(line)
    if (f) {
      const path = f[1]!
      // A deleted file has /dev/null on the new side: it has no new-side lines.
      file = path === '/dev/null' ? null : path
      continue
    }
    const h = HUNK.exec(line)
    if (h && file) {
      const newStart = Number(h[1])
      const len = h[2] === undefined ? 1 : Number(h[2])
      // A zero-length new side means a pure deletion at this point: collapse
      // to the single anchor line so overlap tests still work.
      const newEnd = len === 0 ? newStart : newStart + len - 1
      out.push({ file, newStart, newEnd })
    }
  }
  return out
}

/** Inclusive overlap between a 1-based element range and a hunk's new-side span. */
export function overlaps(range: [number, number], h: Hunk): boolean {
  return range[0] <= h.newEnd && h.newStart <= range[1]
}

/** 1-based inclusive line span. */
export interface LineSpan { start: number; end: number }

export interface FileChangedLines {
  /** New-side repo-relative path; the old-side path when the file was deleted. */
  file: string
  /** Head-side lines added or modified, plus one anchor line per deletion. */
  head: LineSpan[]
  /** Base-side lines removed or modified. */
  base: LineSpan[]
}

const GIT_HEADER = /^diff --git /
const OLD_PATH = /^--- (?:a\/)?(.+)$/
const NEW_PATH = /^\+\+\+ (?:b\/)?(.+)$/
const HUNK_BOTH = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

function toSpans(lines: ReadonlySet<number>): LineSpan[] {
  const out: LineSpan[] = []
  for (const line of [...lines].sort((a, b) => a - b)) {
    const last = out[out.length - 1]
    if (last !== undefined && last.end === line - 1) last.end = line
    else out.push({ start: line, end: line })
  }
  return out
}

/**
 * Changed lines from hunk BODIES, so the result is independent of the context
 * width the diff was produced with — including the pure-deletion anchor,
 * which git's zero-length `+start,0` header convention already places AFTER
 * new-side line `start`. Only subtract one from `newLine` when a context or
 * `+` line actually advanced it past that header value; otherwise the header
 * value itself is already the anchor, and subtracting again double-counts
 * (verified against real `-U0` vs `-U3` output for the same edit).
 *
 * `parseUnifiedDiff` reads `@@` headers, which is correct only at --unified=0.
 * The viewer renders -U3 for readability, and a -U3 header spans three context
 * lines on each side — enough to cross a method boundary and mark the
 * neighbouring element falsely changed.
 */
export function parseChangedLines(diffText: string): FileChangedLines[] {
  const out: FileChangedLines[] = []
  let oldPath: string | null = null
  let headLines = new Set<number>()
  let baseLines = new Set<number>()
  let file: string | null = null
  let inBody = false
  let oldLine = 0
  let newLine = 0
  // True once a context or '+' line has advanced newLine past the hunk
  // header's value, i.e. the header's own new-side number is no longer the
  // anchor and settling must step back one line.
  let headAdvanced = false
  // A '-' run that is followed by '+' lines is a MODIFICATION: the '+' lines
  // already carry the head side, so anchoring the deletion as well would mark
  // the line BEFORE the edit as changed. That falsely gives an enclosing class
  // an own hunk just outside its changed method's range, flipping it from
  // 'contains' to 'direct'. So the anchor is deferred until we know the run
  // was a pure deletion.
  let pendingDeletion = false

  const settleDeletion = (): void => {
    if (!pendingDeletion) return
    headLines.add(Math.max(1, headAdvanced ? newLine - 1 : newLine))
    pendingDeletion = false
  }

  const flush = (): void => {
    settleDeletion()
    if (file !== null && (headLines.size > 0 || baseLines.size > 0)) {
      out.push({ file, head: toSpans(headLines), base: toSpans(baseLines) })
    }
    headLines = new Set()
    baseLines = new Set()
  }

  for (const raw of diffText.split('\n')) {
    // A removed line whose text starts with "--" renders as "--- ...", which is
    // indistinguishable from a file header outside of position. Headers only
    // ever appear before the first @@ of a file, so track that.
    if (GIT_HEADER.test(raw)) { flush(); file = null; oldPath = null; inBody = false; continue }

    if (!inBody) {
      const o = OLD_PATH.exec(raw)
      if (o) { oldPath = o[1]!; continue }
      const n = NEW_PATH.exec(raw)
      if (n) {
        const newPath = n[1]!
        file = newPath === '/dev/null' ? (oldPath === '/dev/null' ? null : oldPath) : newPath
        continue
      }
    }

    const h = HUNK_BOTH.exec(raw)
    if (h) {
      settleDeletion()
      inBody = true
      oldLine = Number(h[1])
      newLine = Number(h[2])
      headAdvanced = false
      continue
    }
    if (!inBody || file === null) continue

    const tag = raw[0]
    if (tag === ' ' || raw === '') { settleDeletion(); oldLine++; newLine++; headAdvanced = true }
    else if (tag === '+') {
      // The '+' carries the head side for any deletion it replaces.
      pendingDeletion = false
      headLines.add(newLine)
      newLine++
      headAdvanced = true
    } else if (tag === '-') {
      baseLines.add(oldLine)
      oldLine++
      // Anchored only if nothing replaces it — see pendingDeletion.
      pendingDeletion = true
    }
    // '\ No newline at end of file' and anything else advances nothing.
  }
  flush()
  return out
}

/** Inclusive overlap between a 1-based element range and a changed-line span. */
export function spanOverlaps(range: [number, number], s: LineSpan): boolean {
  return range[0] <= s.end && s.start <= range[1]
}
