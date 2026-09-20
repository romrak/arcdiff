import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { MODEL_SCHEMA_VERSION, type Delta, type Model } from '@arcdiff/model'
import {
  LspClient, extractModel, pythonVersion,
  type ExtractResult, type LspCapabilities, type ParseFailure,
} from '@arcdiff/extract'
import { annotateBodyChanges, deriveSignals, diffModels, type Signal } from '@arcdiff/diff'
import {
  diffText, listPythonFiles, parseUnifiedDiff, resolveRef,
  withWorktree, writePyrightConfig,
} from '@arcdiff/git'
import { createServer } from '@arcdiff/server'

export function cacheKeyFor(sha: string, subdir: string): string {
  return `${sha}-${subdir.replace(/\//g, '_')}`
}

export function modelCachePath(cacheDir: string, sha: string, subdir: string): string {
  return join(cacheDir, `model-${cacheKeyFor(sha, subdir)}.json`)
}

/**
 * Sidecar next to the model file, holding everything Amendment A16 requires
 * the CLI to print but that a cache HIT has no other way to recover: the
 * interpreter used, parse counts and base-resolution counters. Kept separate
 * from the model file itself so `modelCachePath`'s file stays a pure `Model`
 * and `runDiff`'s `JSON.parse(...) as Model` cast stays honest.
 */
export function statsCachePath(cacheDir: string, sha: string, subdir: string): string {
  return join(cacheDir, `model-${cacheKeyFor(sha, subdir)}.stats.json`)
}

/**
 * Filesystem-safe tag for an interpreter name/path. Amendment A10 exists
 * because the interpreter changes the output (a fifth of a real codebase's
 * files can vanish under the wrong one) — so it must be part of what keys
 * the cache, or a model extracted under one interpreter gets silently served
 * for a request naming a different one. Kept OUT of `cacheKeyFor` /
 * `modelCachePath` / `statsCachePath` themselves: those three are locked to
 * the brief's literal (sha, subdir) shape and tests.
 */
export function pythonTag(python: string): string {
  return python.replace(/[^A-Za-z0-9_.-]+/g, '_')
}

/**
 * Filesystem-safe tag for a set of `--exclude` globs. Folded into the cache
 * path for the same reason `pythonTag` is: the flag changes which files are
 * even listed, so it changes the resulting model, and a request with a
 * different `excludeGlobs` must not be served a cache entry built without
 * it (or with a different set). Sorted so flag order doesn't matter. Empty
 * input (the overwhelmingly common case, and every pre-existing call site)
 * produces an empty string, so cache paths for callers that never pass
 * `excludeGlobs` are byte-identical to before this existed.
 */
export function excludeTag(excludeGlobs: string[]): string {
  if (excludeGlobs.length === 0) return ''
  const sorted = [...excludeGlobs].sort().join(',')
  return `-ex_${sorted.replace(/[^A-Za-z0-9_.-]+/g, '_')}`
}

/**
 * `model-s<schema>-<sha>-<subdir>-<interpreter>[-ex_<globs>]`. The schema
 * version leads, so a cache directory written under a different element-id
 * rule can never be served against a model built under this one: a stale hit
 * there reads as every element removed and every element added, with nothing
 * to distinguish it from a real rewrite. See `MODEL_SCHEMA_VERSION`.
 */
function cacheBaseName(
  sha: string, subdir: string, python: string, excludeGlobs: string[],
): string {
  return `model-s${MODEL_SCHEMA_VERSION}-${cacheKeyFor(sha, subdir)}` +
    `-${pythonTag(python)}${excludeTag(excludeGlobs)}`
}

export function modelCachePathForPython(
  cacheDir: string, sha: string, subdir: string, python: string, excludeGlobs: string[] = [],
): string {
  return join(cacheDir, `${cacheBaseName(sha, subdir, python, excludeGlobs)}.json`)
}

export function statsCachePathForPython(
  cacheDir: string, sha: string, subdir: string, python: string, excludeGlobs: string[] = [],
): string {
  return join(cacheDir, `${cacheBaseName(sha, subdir, python, excludeGlobs)}.stats.json`)
}

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true } catch { return false }
}

/**
 * Amendment A16: the counters `extractModel` returns instead of throwing.
 * Persisted alongside the model and printed by the CLI on every run —
 * extract, diff, and a cache hit alike — so the counters are an actual
 * signal and not a number nobody reads.
 */
export interface ExtractStats {
  python: string
  pythonVersion: [number, number]
  filesParsed: number
  filesFailed: number
  failures: ParseFailure[]
  basesAttempted: number
  basesResolved: number
  basesExternal: number
  basesNotDefinition: number
  basesNotAnalysed: number
  basesUnresolved: number
  basesRequestFailed: number
  noBasesResolved: boolean
  /**
   * What the language server advertised at initialize. Persisted because a
   * cache HIT never starts a server, so this sidecar is the only place a
   * warm-run consumer can read it from.
   */
  capabilities?: LspCapabilities
}

function buildStats(python: string, r: ExtractResult): ExtractStats {
  return {
    python,
    pythonVersion: r.pythonVersion,
    filesParsed: r.filesParsed,
    filesFailed: r.filesFailed,
    failures: r.failures,
    basesAttempted: r.basesAttempted,
    basesResolved: r.basesResolved,
    basesExternal: r.basesExternal,
    basesNotDefinition: r.basesNotDefinition,
    basesNotAnalysed: r.basesNotAnalysed,
    basesUnresolved: r.basesUnresolved,
    basesRequestFailed: r.basesRequestFailed,
    noBasesResolved: r.noBasesResolved,
    capabilities: r.capabilities,
  }
}

/** `path (reason)` per failed file — the reason is the point. */
export function formatFailures(failures: ParseFailure[]): string {
  return failures.map(f => `${f.file} (${f.reason})`).join('; ')
}

/** Human-readable rendering of `ExtractStats`, one call per printed block. */
export function formatStats(stats: ExtractStats, label?: string): string {
  const tag = label !== undefined ? `[${label}] ` : ''
  const [major, minor] = stats.pythonVersion
  const failedSuffix = stats.filesFailed > 0 ? `: ${formatFailures(stats.failures)}` : ''
  return (
    `${tag}arcdiff: interpreter ${stats.python} (Python ${major}.${minor})\n` +
    `${tag}arcdiff: files parsed ${stats.filesParsed}, failed ${stats.filesFailed}${failedSuffix}\n` +
    `${tag}arcdiff: bases attempted ${stats.basesAttempted}, resolved ${stats.basesResolved}, ` +
    `external ${stats.basesExternal}, not-a-definition ${stats.basesNotDefinition}, ` +
    `not-analysed ${stats.basesNotAnalysed}, ` +
    `unresolved ${stats.basesUnresolved} (request-failed ${stats.basesRequestFailed})` +
    (stats.noBasesResolved ? ' (WARNING: none resolved in-repo)' : '') + '\n'
  )
}

/**
 * Reads a PEP 621 `requires-python` value out of raw TOML text via a targeted
 * regex rather than a full TOML parser — the field is always a single quoted
 * string on its own line, and pulling in a TOML dependency for one field
 * isn't worth it here.
 */
export function extractRequiresPython(pyprojectText: string): string | undefined {
  const m = pyprojectText.match(/^\s*requires-python\s*=\s*["']([^"']+)["']/m)
  return m?.[1]
}

/**
 * Minimal PEP 440-ish comparator for `requires-python`, scoped to what that
 * field actually uses in practice: comma-separated `>=`, `>`, `<=`, `<`,
 * `==`, `!=` clauses against a major.minor version (e.g. ">=3.14" or
 * ">=3.9,<4"). An unrecognised clause is treated as satisfied rather than
 * blocking the run on a spec this function doesn't understand.
 */
export function satisfiesRequiresPython(version: [number, number], spec: string): boolean {
  const clauses = spec.split(',').map(c => c.trim()).filter(c => c.length > 0)
  const [vMajor, vMinor] = version
  return clauses.every(clause => {
    const m = clause.match(/^(>=|<=|==|!=|>|<)\s*(\d+)(?:\.(\d+))?/)
    if (!m) return true
    const op = m[1]!
    const major = Number(m[2])
    const minor = m[3] !== undefined ? Number(m[3]) : 0
    const cmp = vMajor !== major ? vMajor - major : vMinor - minor
    switch (op) {
      case '>=': return cmp >= 0
      case '>': return cmp > 0
      case '<=': return cmp <= 0
      case '<': return cmp < 0
      case '==': return vMajor === major && (m[3] === undefined || vMinor === minor)
      case '!=': return !(vMajor === major && (m[3] === undefined || vMinor === minor))
      default: return true
    }
  })
}

/**
 * Amendment A10 preflight: the interpreter is part of the contract, not an
 * implementation detail. Runs inside the worktree, before `writePyrightConfig`
 * and before an LSP process is even spawned, so a mismatch fails fast. A
 * missing pyproject.toml or a missing/unrecognised `requires-python` passes —
 * this only refuses a KNOWN mismatch, it never invents a requirement.
 */
async function preflightRequiresPython(root: string, python: string): Promise<[number, number]> {
  const version = await pythonVersion(python)
  const pyprojectPath = join(root, 'pyproject.toml')
  if (!(await exists(pyprojectPath))) return version
  const spec = extractRequiresPython(await readFile(pyprojectPath, 'utf8'))
  if (spec === undefined) return version
  if (!satisfiesRequiresPython(version, spec)) {
    throw new Error(
      `arcdiff: interpreter '${python}' is Python ${version[0]}.${version[1]}, but ` +
      `${pyprojectPath} declares requires-python = "${spec}". Pass --python with an ` +
      'interpreter that satisfies it (e.g. --python python3.14).',
    )
  }
  return version
}

function parseFailureError(python: string, stats: ExtractStats): Error {
  const total = stats.filesParsed + stats.filesFailed
  return new Error(
    `arcdiff: ${stats.filesFailed} of ${total} files failed to parse under ${python} ` +
    `(Python ${stats.pythonVersion.join('.')}): ${formatFailures(stats.failures)}. A model built ` +
    'from a partial parse is not a model — pass --allow-parse-failures to proceed anyway.',
  )
}

function staleCacheError(path: string, stats: ExtractStats): Error {
  return new Error(
    `arcdiff: cached model at ${path} was extracted with ${stats.filesFailed} file(s) failing ` +
    `to parse under ${stats.python} (Python ${stats.pythonVersion.join('.')}): ` +
    `${formatFailures(stats.failures)}. Delete the cache to re-extract, or pass ` +
    '--allow-parse-failures to use it anyway.',
  )
}

/**
 * The cache-hit twin of `extractModel`'s end-of-run guard. `allowNoResolvedBases`
 * is meant to be a per-run escape hatch, but the model it produces is cached
 * like any other, so without this check one run with the flag makes every later
 * run inherit a model carrying no inheritance at all — permanently, and with
 * the guard never firing again. Names the sidecar rather than the analysis root
 * because a cache hit never builds a worktree, so no root exists to name.
 */
function staleNoBasesError(path: string, stats: ExtractStats): Error {
  return new Error(
    `arcdiff: cached model at ${path} was extracted with 0 of ${stats.basesAttempted} ` +
    `base classes resolved to an element in-repo (external=${stats.basesExternal}, ` +
    `not-a-definition=${stats.basesNotDefinition}, not-analysed=${stats.basesNotAnalysed}, ` +
    `unresolved=${stats.basesUnresolved}). ` +
    'It carries no inheritance at all while otherwise looking healthy. Delete the cache ' +
    'to re-extract, or pass allowNoResolvedBases to use it anyway.',
  )
}

/**
 * A cache hit requires BOTH files: a model with no stats sidecar (e.g. from
 * before this sidecar existed) is treated as a miss, not a hit — otherwise a
 * `filesFailed > 0` model could be served forever with no way to re-apply the
 * gate below. The path is also keyed on `python`: a model extracted under one
 * interpreter must not be served for a request naming a different one — see
 * `pythonTag`'s docstring. Exported so this behaviour is directly testable
 * without spinning up a real worktree/LSP.
 */
export async function readCachedStats(
  cacheDir: string, sha: string, subdir: string, python: string, excludeGlobs: string[] = [],
): Promise<{ path: string; stats: ExtractStats } | null> {
  const path = modelCachePathForPython(cacheDir, sha, subdir, python, excludeGlobs)
  const statsPath = statsCachePathForPython(cacheDir, sha, subdir, python, excludeGlobs)
  if (!(await exists(path)) || !(await exists(statsPath))) return null
  const stats = JSON.parse(await readFile(statsPath, 'utf8')) as ExtractStats
  return { path, stats }
}

/**
 * An empty file list produces an empty model that every downstream guard
 * waves through: `basesAttempted` is 0, so neither the canary nor the
 * all-external check fires, and the empty model is written, cached, and
 * diffed to 0 changes and 0 signals forever. A mistyped `--subdir` is the
 * ordinary way to get there. Thrown BEFORE the worktree and the language
 * server, so a typo costs a second rather than a full extraction.
 */
function emptyFileListError(
  repoRoot: string, subdir: string, sha: string, excludeGlobs: string[],
): Error {
  const excludes = excludeGlobs.length > 0
    ? ` after applying --exclude ${excludeGlobs.map(g => `'${g}'`).join(' ')}`
    : ''
  return new Error(
    `arcdiff: no Python files at ${sha.slice(0, 10)} under '${subdir}' in ${repoRoot}` +
    `${excludes}. Check --subdir: an empty model passes every later guard and ` +
    'diffs to 0 changes and 0 signals.',
  )
}

export interface ExtractCliOptions {
  repoRoot: string
  subdir: string
  ref: string
  cacheDir: string
  lspCmd: string
  lspArgs: string[]
  /** Directory holding the .venv pyright should use for third-party imports. */
  venvHostDir: string
  /** Interpreter to run parse.py under. Default 'python3'. See Amendment A10. */
  python?: string
  /** Proceed even when some files failed to parse, instead of failing loudly. */
  allowParseFailures?: boolean
  /** Passed through to extractModel's own guard against a misconfigured import root. */
  allowNoResolvedBases?: boolean
  /**
   * Glob patterns (repeatable on the CLI) excluded when LISTING files, so a
   * matched path never reaches extraction and never enters the model.
   */
  excludeGlobs?: string[]
}

export interface ExtractRunResult {
  path: string
  stats: ExtractStats
  cached: boolean
}

export async function runExtract(o: ExtractCliOptions): Promise<ExtractRunResult> {
  const sha = await resolveRef(o.repoRoot, o.ref)
  await mkdir(o.cacheDir, { recursive: true })
  const python = o.python ?? 'python3'
  const excludeGlobs = o.excludeGlobs ?? []

  const cached = await readCachedStats(o.cacheDir, sha, o.subdir, python, excludeGlobs)
  if (cached !== null) {
    if (cached.stats.filesFailed > 0 && !o.allowParseFailures) {
      throw staleCacheError(cached.path, cached.stats)
    }
    if (cached.stats.noBasesResolved && o.allowNoResolvedBases !== true) {
      throw staleNoBasesError(cached.path, cached.stats)
    }
    return { path: cached.path, stats: cached.stats, cached: true }
  }

  const files = await listPythonFiles(o.repoRoot, sha, o.subdir, excludeGlobs)
  if (files.length === 0) throw emptyFileListError(o.repoRoot, o.subdir, sha, excludeGlobs)

  const { model, stats } = await withWorktree(o.repoRoot, sha, async wt => {
    // extractModel now checks containment against both the resolved AND
    // unresolved spelling of the root internally (fix for the symlinked-worktree
    // bug found on this CLI's first real run — see Task 13 report), so this no
    // longer needs to pre-resolve the path itself.
    const root = join(wt, o.subdir)
    await preflightRequiresPython(root, python)
    await writePyrightConfig(root, o.venvHostDir)
    const client = await LspClient.start(o.lspCmd, o.lspArgs, pathToFileURL(root).href)
    try {
      const result = await extractModel({
        root, ref: sha, files, client, python,
        allowNoResolvedBases: o.allowNoResolvedBases,
      })
      return { model: result.model, stats: buildStats(python, result) }
    } finally {
      await client.stop()
    }
  })

  if (stats.filesFailed > 0 && !o.allowParseFailures) {
    throw parseFailureError(python, stats)
  }

  const out = modelCachePathForPython(o.cacheDir, sha, o.subdir, python, excludeGlobs)
  const statsPath = statsCachePathForPython(o.cacheDir, sha, o.subdir, python, excludeGlobs)
  await writeFile(out, JSON.stringify(model, null, 2), 'utf8')
  await writeFile(statsPath, JSON.stringify(stats, null, 2), 'utf8')
  return { path: out, stats, cached: false }
}

/**
 * What `delta.json` carries beside the delta itself. Everything here is
 * something a renderer cannot reconstruct from the delta: the drill-down is
 * `git diff <base> <head> -- <subdir>` run from `repoRoot`, and the spec's
 * "hide affordances the server cannot support" needs the capabilities the
 * language server advertised — which `LspClient.start` probes and, until now,
 * discarded.
 */
export interface DeltaSource {
  repoRoot: string
  subdir: string
  base: { ref: string; modelPath: string }
  head: { ref: string; modelPath: string }
  /** null when no sidecar recorded them, never a guess. */
  capabilities: LspCapabilities | null
}

/** The `delta.json` document. `delta` and `signals` keep their existing shape. */
export interface DeltaDocument {
  delta: Delta
  signals: Signal[]
  source: DeltaSource
}

export function buildDeltaDocument(o: {
  delta: Delta
  signals: Signal[]
  repoRoot: string
  subdir: string
  baseRef: string
  headRef: string
  baseModelPath: string
  headModelPath: string
  capabilities: LspCapabilities | undefined
}): DeltaDocument {
  return {
    delta: o.delta,
    signals: o.signals,
    source: {
      repoRoot: o.repoRoot,
      subdir: o.subdir,
      base: { ref: o.baseRef, modelPath: o.baseModelPath },
      head: { ref: o.headRef, modelPath: o.headModelPath },
      capabilities: o.capabilities ?? null,
    },
  }
}

export interface DiffCliOptions extends Omit<ExtractCliOptions, 'ref'> {
  base: string
  head: string
  outPath: string
}

export interface DiffRunResult {
  deltaPath: string
  signalCount: number
  baseStats: ExtractStats
  headStats: ExtractStats
  baseCached: boolean
  headCached: boolean
}

export async function runDiff(o: DiffCliOptions): Promise<DiffRunResult> {
  const baseSha = await resolveRef(o.repoRoot, o.base)
  const headSha = await resolveRef(o.repoRoot, o.head)

  const baseResult = await runExtract({ ...o, ref: baseSha })
  const headResult = await runExtract({ ...o, ref: headSha })

  const baseModel = JSON.parse(await readFile(baseResult.path, 'utf8')) as Model
  const headModel = JSON.parse(await readFile(headResult.path, 'utf8')) as Model

  const hunks = parseUnifiedDiff(
    await diffText(o.repoRoot, baseSha, headSha, o.subdir),
  )
  const delta = annotateBodyChanges(diffModels(baseModel, headModel), baseModel, headModel, hunks)
  const signals = deriveSignals(delta, baseModel, headModel)

  const doc = buildDeltaDocument({
    delta, signals,
    repoRoot: o.repoRoot, subdir: o.subdir,
    baseRef: baseSha, headRef: headSha,
    baseModelPath: baseResult.path, headModelPath: headResult.path,
    // Both models come from the same --lsp, so either sidecar answers; head is
    // the one a renderer is describing.
    capabilities: headResult.stats.capabilities,
  })
  await writeFile(o.outPath, JSON.stringify(doc, null, 2), 'utf8')
  return {
    deltaPath: o.outPath,
    signalCount: signals.length,
    baseStats: baseResult.stats,
    headStats: headResult.stats,
    baseCached: baseResult.cached,
    headCached: headResult.cached,
  }
}

export interface RunServeResult { port: number; close: () => Promise<void> }

/**
 * Extract as needed, write the delta to a temp file, then serve it. The viewer
 * reads the cached models straight off disk via source.*.modelPath, so nothing
 * is re-extracted for the browser.
 */
export async function runServe(
  opts: Parameters<typeof runDiff>[0] & { port: number; staticDir?: string },
): Promise<RunServeResult> {
  const result = await runDiff(opts)
  const server = await createServer({ deltaPath: result.deltaPath, staticDir: opts.staticDir })
  const port = await new Promise<number>((resolve, reject) => {
    // Without this, a port already in use (5173 is both arcdiff's and Vite's
    // default) crashes with an unhandled exception instead of a message.
    server.once('error', (err: NodeJS.ErrnoException) => {
      reject(err.code === 'EADDRINUSE'
        ? new Error(`arcdiff: port ${opts.port} is already in use — pass --port <n>`)
        : err)
    })
    server.listen(opts.port, () => {
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : opts.port)
    })
  })
  return {
    port,
    close: () => new Promise<void>(resolve => server.close(() => { resolve() })),
  }
}
