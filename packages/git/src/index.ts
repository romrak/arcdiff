export {
  parseUnifiedDiff, overlaps, parseChangedLines, spanOverlaps,
  type Hunk, type LineSpan, type FileChangedLines,
} from './hunks.js'
export {
  resolveRef, listPythonFiles, diffText, withWorktree, writePyrightConfig,
} from './repo.js'
// Node-only, like repo.js above: pr.js imports node:child_process at module
// scope. Browser code must not reach these — and one stray VALUE import of
// this bare barrel is all it takes, which is how node:child_process reached a
// viewer bundle once already. The pure diff parsing lives behind './hunks' for
// exactly that reason; nothing here belongs beside it.
export {
  parsePrRef, parseRemoteUrl, resolvePr, ghLookup,
  type PrRef, type PrInfo, type PrLookup, type ResolvePrOptions, type ResolvedPr,
} from './pr.js'
