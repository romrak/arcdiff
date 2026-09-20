import { describe, it, expect } from 'vitest'
import { cacheKeyFor, modelCachePath } from './run.js'

describe('cacheKeyFor', () => {
  it('keys on the full sha and the analysed subdir', () => {
    expect(cacheKeyFor('abc123', 'services/web-api'))
      .toBe('abc123-services_web-api')
  })
  it('produces a filesystem-safe key with no slashes', () => {
    expect(cacheKeyFor('abc', 'a/b/c')).not.toContain('/')
  })
  it('distinguishes two subdirs at the same sha', () => {
    expect(cacheKeyFor('abc', 'svc/a')).not.toBe(cacheKeyFor('abc', 'svc/b'))
  })
})

describe('modelCachePath', () => {
  it('places the model under the cache dir with a .json extension', () => {
    expect(modelCachePath('/c', 'abc', 'svc')).toBe('/c/model-abc-svc.json')
  })
})

// --- Amendment A10: requires-python preflight -------------------------------
// Not in the brief's test list (that covers only cacheKeyFor/modelCachePath);
// added because satisfiesRequiresPython/extractRequiresPython are new pure
// logic introduced to satisfy Amendment A10 and had no prior coverage.

import { satisfiesRequiresPython, extractRequiresPython, statsCachePath } from './run.js'

describe('extractRequiresPython', () => {
  it('reads a double-quoted requires-python key', () => {
    expect(extractRequiresPython('[project]\nrequires-python = ">=3.14"\n')).toBe('>=3.14')
  })
  it('reads a single-quoted requires-python key', () => {
    expect(extractRequiresPython("requires-python = '>=3.9,<4'\n")).toBe('>=3.9,<4')
  })
  it('returns undefined when the key is absent', () => {
    expect(extractRequiresPython('[project]\nname = "x"\n')).toBeUndefined()
  })
})

describe('satisfiesRequiresPython', () => {
  it('accepts a version at or above a >= floor', () => {
    expect(satisfiesRequiresPython([3, 14], '>=3.14')).toBe(true)
    expect(satisfiesRequiresPython([3, 15], '>=3.14')).toBe(true)
  })
  it('rejects a version below a >= floor', () => {
    expect(satisfiesRequiresPython([3, 11], '>=3.14')).toBe(false)
  })
  it('evaluates every comma-separated clause', () => {
    expect(satisfiesRequiresPython([3, 12], '>=3.9,<4')).toBe(true)
    expect(satisfiesRequiresPython([4, 0], '>=3.9,<4')).toBe(false)
  })
  it('supports ==, !=, > and <=', () => {
    expect(satisfiesRequiresPython([3, 12], '==3.12')).toBe(true)
    expect(satisfiesRequiresPython([3, 11], '==3.12')).toBe(false)
    expect(satisfiesRequiresPython([3, 12], '!=3.12')).toBe(false)
    expect(satisfiesRequiresPython([3, 13], '>3.12')).toBe(true)
    expect(satisfiesRequiresPython([3, 12], '<=3.12')).toBe(true)
  })
  it('treats a spec with no recognisable clauses as satisfied', () => {
    expect(satisfiesRequiresPython([3, 11], '')).toBe(true)
  })
})

describe('statsCachePath', () => {
  it('places the stats sidecar next to the model with a .stats.json extension', () => {
    expect(statsCachePath('/c', 'abc', 'svc')).toBe('/c/model-abc-svc.stats.json')
  })
})

// --- Fix round 1: basesUnresolved missing from output, cache not keyed on
// the interpreter. Added because both slipped past review with no direct
// test on the affected functions.

import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  formatStats, pythonTag, modelCachePathForPython, statsCachePathForPython,
  readCachedStats, type ExtractStats,
} from './run.js'

const baseStats: ExtractStats = {
  python: 'python3',
  pythonVersion: [3, 11],
  filesParsed: 5,
  filesFailed: 0,
  failures: [],
  basesAttempted: 10,
  basesResolved: 6,
  basesExternal: 3,
  basesNotDefinition: 1,
  basesNotAnalysed: 0,
  basesUnresolved: 0,
  basesRequestFailed: 0,
  noBasesResolved: false,
}

describe('formatStats', () => {
  it('prints every base counter, summing to basesAttempted', () => {
    const out = formatStats(baseStats)
    expect(out).toContain('attempted 10')
    expect(out).toContain('resolved 6')
    expect(out).toContain('external 3')
    expect(out).toContain('not-a-definition 1')
    expect(out).toContain('not-analysed 0')
    expect(out).toContain('unresolved 0')
  })

  // A base defined in an --exclude'd file resolves in-root but is not in the
  // model. Counting it as not-a-definition would corrupt the drift signal.
  it('keeps not-analysed out of the not-a-definition drift counter', () => {
    const stats: ExtractStats = {
      ...baseStats, basesAttempted: 14, basesNotDefinition: 1, basesNotAnalysed: 4,
    }
    const out = formatStats(stats)
    expect(out).toContain('not-a-definition 1')
    expect(out).toContain('not-analysed 4')
  })

  it('names the reason a file failed to parse, not just the path', () => {
    const stats: ExtractStats = {
      ...baseStats, filesFailed: 1,
      failures: [{ file: 'app/m.py', reason: 'syntax error: invalid syntax (m.py, line 3)' }],
    }
    const out = formatStats(stats)
    expect(out).toContain('app/m.py')
    expect(out).toContain('syntax error: invalid syntax (m.py, line 3)')
  })
  it('surfaces a nonzero basesUnresolved -- the bucket A16 exists for', () => {
    const stats: ExtractStats = { ...baseStats, basesAttempted: 12, basesUnresolved: 2 }
    expect(formatStats(stats)).toContain('unresolved 2')
  })
  it('handles the zero-attempted case without misleading output', () => {
    const stats: ExtractStats = {
      ...baseStats, basesAttempted: 0, basesResolved: 0, basesExternal: 0,
      basesNotDefinition: 0, basesNotAnalysed: 0, basesUnresolved: 0,
    }
    const out = formatStats(stats)
    expect(out).toContain('attempted 0')
    expect(out).toContain('unresolved 0')
  })
})

describe('pythonTag', () => {
  it('sanitizes a path-like interpreter into a filesystem-safe tag', () => {
    expect(pythonTag('/usr/bin/python3.11')).not.toContain('/')
  })
})

describe('modelCachePathForPython / statsCachePathForPython', () => {
  it('gives different interpreters different cache paths at the same sha/subdir', () => {
    const a = modelCachePathForPython('/c', 'abc', 'svc', 'python3.11')
    const b = modelCachePathForPython('/c', 'abc', 'svc', 'python3.14')
    expect(a).not.toBe(b)
  })
  it('keeps the model and its stats sidecar paired under the same tag', () => {
    const model = modelCachePathForPython('/c', 'abc', 'svc', 'python3.11')
    const stats = statsCachePathForPython('/c', 'abc', 'svc', 'python3.11')
    expect(stats).toBe(model.replace(/\.json$/, '.stats.json'))
  })
})

describe('readCachedStats', () => {
  it('does not serve a model extracted under a different interpreter', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arcdiff-cache-test-'))
    try {
      const path311 = modelCachePathForPython(dir, 'sha1', 'app', 'python3.11')
      const statsPath311 = statsCachePathForPython(dir, 'sha1', 'app', 'python3.11')
      await writeFile(path311, JSON.stringify({ ref: 'sha1', extractedAt: '', elements: [], edges: [] }), 'utf8')
      await writeFile(statsPath311, JSON.stringify({ ...baseStats, python: 'python3.11', pythonVersion: [3, 11] }), 'utf8')

      const hit = await readCachedStats(dir, 'sha1', 'app', 'python3.11')
      expect(hit).not.toBeNull()
      expect(hit?.stats.python).toBe('python3.11')

      // Same sha/subdir, different interpreter: must miss, not serve the 3.11 model.
      const miss = await readCachedStats(dir, 'sha1', 'app', 'python3.14')
      expect(miss).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// --- Task 15: --exclude must be part of the cache key -----------------------
// listPythonFiles now takes excludeGlobs and filters at listing time, so two
// requests at the same (sha, subdir, python) with different excludeGlobs
// produce different file sets and must not share a cache entry — otherwise
// a run with --exclude 'tests/**' would silently serve a model that was
// extracted (or would be extracted) without the exclusion, or vice versa.

import { excludeTag } from './run.js'

describe('excludeTag', () => {
  it('is empty for no excludes, keeping pre-existing cache paths unchanged', () => {
    expect(excludeTag([])).toBe('')
  })
  it('is order-independent', () => {
    expect(excludeTag(['b/**', 'a/**'])).toBe(excludeTag(['a/**', 'b/**']))
  })
  it('distinguishes different exclude sets', () => {
    expect(excludeTag(['tests/**'])).not.toBe(excludeTag(['docs/**']))
    expect(excludeTag(['tests/**'])).not.toBe(excludeTag([]))
  })
})

describe('modelCachePathForPython with excludeGlobs', () => {
  it('gives no-exclude and with-exclude requests different cache paths', () => {
    const bare = modelCachePathForPython('/c', 'abc', 'svc', 'python3')
    const excluded = modelCachePathForPython('/c', 'abc', 'svc', 'python3', ['tests/**'])
    expect(bare).not.toBe(excluded)
  })
})

describe('readCachedStats with excludeGlobs', () => {
  it('does not serve a model extracted with a different exclude set', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arcdiff-cache-exclude-test-'))
    try {
      const barePath = modelCachePathForPython(dir, 'sha1', 'app', 'python3', [])
      const bareStatsPath = statsCachePathForPython(dir, 'sha1', 'app', 'python3', [])
      await writeFile(barePath, JSON.stringify({ ref: 'sha1', extractedAt: '', elements: [], edges: [] }), 'utf8')
      await writeFile(bareStatsPath, JSON.stringify(baseStats), 'utf8')

      const hit = await readCachedStats(dir, 'sha1', 'app', 'python3', [])
      expect(hit).not.toBeNull()

      // Same sha/subdir/python, but with an exclude glob: must miss, not
      // serve the model that was built (or would be built) without it.
      const miss = await readCachedStats(dir, 'sha1', 'app', 'python3', ['tests/**'])
      expect(miss).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// --- Fix round (Task 14): a cache hit must re-apply the no-resolved-bases
// guard, not just the parse-failure one. Without this, a model cached under
// --allow-no-resolved-bases is served forever to a later run that omits the
// flag, and the guard never fires again — see `staleNoBasesError` in run.ts.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { runExtract } from './run.js'

const execFileAsync = promisify(execFile)

/** A one-commit git repo, just enough for `resolveRef('HEAD')` to succeed. */
async function tinyGitRepo(): Promise<{ dir: string; sha: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'arcdiff-guard-repo-'))
  await execFileAsync('git', ['-C', dir, 'init', '-q', '-b', 'main'])
  await writeFile(join(dir, 'x.txt'), '', 'utf8')
  await mkdir(join(dir, 'docs'), { recursive: true })
  await writeFile(join(dir, 'docs', 'readme.md'), '# no python here\n', 'utf8')
  await mkdir(join(dir, 'app'), { recursive: true })
  await writeFile(join(dir, 'app', 'm.py'), 'x = 1\n', 'utf8')
  await execFileAsync('git', ['-C', dir, 'add', '-A'])
  await execFileAsync('git', [
    '-C', dir, '-c', 'user.name=arcdiff test', '-c', 'user.email=arcdiff@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init',
  ])
  const { stdout } = await execFileAsync('git', ['-C', dir, 'rev-parse', 'HEAD'])
  return { dir, sha: stdout.trim() }
}

describe('runExtract cache-hit guard for noBasesResolved', () => {
  it('throws on a cache hit carrying noBasesResolved without the flag, and serves it with the flag', async () => {
    const { dir: repo, sha } = await tinyGitRepo()
    const cacheDir = await mkdtemp(join(tmpdir(), 'arcdiff-guard-cache-'))
    try {
      const python = 'python3'
      const modelPath = modelCachePathForPython(cacheDir, sha, 'app', python)
      const statsPath = statsCachePathForPython(cacheDir, sha, 'app', python)
      await writeFile(
        modelPath,
        JSON.stringify({ ref: sha, extractedAt: '', elements: [], edges: [] }),
        'utf8',
      )
      const cachedStats: ExtractStats = {
        ...baseStats, basesAttempted: 1, basesResolved: 0, basesExternal: 1,
        basesNotDefinition: 0, noBasesResolved: true,
      }
      await writeFile(statsPath, JSON.stringify(cachedStats), 'utf8')

      // lspCmd/venvHostDir are never touched on a cache hit — only exercised
      // if this test starts falsely reporting a miss.
      const opts = {
        repoRoot: repo, subdir: 'app', ref: 'HEAD', cacheDir,
        lspCmd: 'true', lspArgs: [], venvHostDir: repo, python,
      }

      await expect(runExtract(opts)).rejects.toThrow(/0 of 1 base classes resolved/)

      const served = await runExtract({ ...opts, allowNoResolvedBases: true })
      expect(served.cached).toBe(true)
      expect(served.stats.noBasesResolved).toBe(true)
    } finally {
      // maxRetries: a freshly-exited `git commit` can still hold .git files
      // open for a moment on macOS, which otherwise races this cleanup as
      // ENOTEMPTY.
      await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      await rm(cacheDir, { recursive: true, force: true })
    }
  })
})

// --- Final fix wave -------------------------------------------------------

import { MODEL_SCHEMA_VERSION } from '@arcdiff/model'
import { buildDeltaDocument, selectRefs } from './run.js'

describe('cache key schema version', () => {
  it('carries the model schema version, so an id-rule change cannot be served from an old cache', () => {
    expect(modelCachePathForPython('/c', 'abc', 'svc', 'python3'))
      .toContain(`-s${MODEL_SCHEMA_VERSION}`)
    expect(statsCachePathForPython('/c', 'abc', 'svc', 'python3'))
      .toContain(`-s${MODEL_SCHEMA_VERSION}`)
  })

  // The id rule changed three times during this plan. A directory written by
  // an older arcdiff, served against a new-rule model, reads every element as
  // added+removed — silently, forever.
  it('treats a sidecar written under the previous key layout as a MISS, not a hit', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'arcdiff-schema-cache-'))
    try {
      const legacyModel = join(cacheDir, 'model-sha1-app-python3.json')
      const legacyStats = join(cacheDir, 'model-sha1-app-python3.stats.json')
      await writeFile(legacyModel, '{}', 'utf8')
      await writeFile(legacyStats, JSON.stringify(baseStats), 'utf8')
      expect(await readCachedStats(cacheDir, 'sha1', 'app', 'python3')).toBeNull()
    } finally {
      await rm(cacheDir, { recursive: true, force: true })
    }
  })
})

describe('runExtract with a subdir that matches no Python file', () => {
  // listPythonFiles returns [], so basesAttempted is 0 and NEITHER the canary
  // nor the end-of-run guard fires: the empty model is written, cached, and
  // every later diff reports 0 changes and 0 signals. The guard has to come
  // before the worktree, so the run dies on the typo rather than 35 s later.
  it('throws instead of extracting an empty model', async () => {
    const { dir: repo } = await tinyGitRepo()
    const cacheDir = await mkdtemp(join(tmpdir(), 'arcdiff-empty-cache-'))
    try {
      // `docs/` exists and is committed, but holds no .py file at all.
      await expect(runExtract({
        repoRoot: repo, subdir: 'docs', ref: 'HEAD', cacheDir,
        lspCmd: 'true', lspArgs: [], venvHostDir: repo, python: 'python3',
      })).rejects.toThrow(/no Python files/)
    } finally {
      await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      await rm(cacheDir, { recursive: true, force: true })
    }
  })

  it('names the exclude globs when they are what emptied the list', async () => {
    const { dir: repo } = await tinyGitRepo()
    const cacheDir = await mkdtemp(join(tmpdir(), 'arcdiff-excluded-cache-'))
    try {
      await expect(runExtract({
        repoRoot: repo, subdir: 'app', ref: 'HEAD', cacheDir,
        lspCmd: 'true', lspArgs: [], venvHostDir: repo, python: 'python3',
        excludeGlobs: ['**'],
      })).rejects.toThrow(/--exclude/)
    } finally {
      await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      await rm(cacheDir, { recursive: true, force: true })
    }
  })
})

describe('buildDeltaDocument', () => {
  const delta = { base: 'b', head: 'h', elements: [], edges: [] }
  const caps = {
    documentSymbol: true, definition: true, references: false,
    workspaceSymbol: false, callHierarchy: false,
  }
  const doc = buildDeltaDocument({
    delta, signals: [],
    repoRoot: '/repo', subdir: 'services/web-api',
    baseRef: 'b77aa1f', headRef: 'a89e1a3',
    baseModelPath: '/cache/model-b.json', headModelPath: '/cache/model-h.json',
    capabilities: caps,
  })

  it('keeps the existing shape untouched', () => {
    expect(doc.delta).toBe(delta)
    expect(doc.signals).toEqual([])
  })

  // The drill-down is `git diff <base> <head> -- <subdir>`; without these a
  // renderer holding only delta.json cannot run it.
  it('carries enough to run the drill-down git diff from delta.json alone', () => {
    expect(doc.source.repoRoot).toBe('/repo')
    expect(doc.source.subdir).toBe('services/web-api')
    expect(doc.source.base.ref).toBe('b77aa1f')
    expect(doc.source.head.ref).toBe('a89e1a3')
  })

  it('names both model files', () => {
    expect(doc.source.base.modelPath).toBe('/cache/model-b.json')
    expect(doc.source.head.modelPath).toBe('/cache/model-h.json')
  })

  // The spec's "hide affordances the server cannot support" is unimplementable
  // without this: client.ts probes capabilities at initialize and discarded them.
  it('carries the probed language-server capabilities', () => {
    expect(doc.source.capabilities).toEqual(caps)
  })

  it('records null rather than inventing capabilities when none were persisted', () => {
    const d = buildDeltaDocument({
      delta, signals: [], repoRoot: '/repo', subdir: 'app',
      baseRef: 'b', headRef: 'h',
      baseModelPath: '/c/b.json', headModelPath: '/c/h.json',
      capabilities: undefined,
    })
    expect(d.source.capabilities).toBeNull()
  })
})

describe('buildDeltaDocument with a pull request', () => {
  const delta = { base: 'b', head: 'h', elements: [], edges: [] }
  const common = {
    delta, signals: [], repoRoot: '/repo', subdir: 'src',
    baseRef: 'b77aa1f', headRef: 'a89e1a3',
    baseModelPath: '/c/b.json', headModelPath: '/c/h.json',
    capabilities: undefined,
  }

  it('records the pull request the refs came from', () => {
    const d = buildDeltaDocument({
      ...common,
      pullRequest: { number: 7, title: 'Add a run method', url: 'https://x/pull/7' },
    })
    expect(d.source.pullRequest).toEqual({
      number: 7, title: 'Add a run method', url: 'https://x/pull/7',
    })
  })

  // Absent, not null: every reader — the server and the viewer both declare
  // their own structural DeltaDocument — would otherwise have to tell an
  // explicit null apart from a missing key to answer the same question.
  it('writes no key at all for a plain --base/--head run', () => {
    const d = buildDeltaDocument(common)
    expect('pullRequest' in d.source).toBe(false)
  })
})

describe('selectRefs', () => {
  it('defaults head to HEAD when only --base is given', () => {
    expect(selectRefs({ base: 'main' })).toEqual({ kind: 'refs', base: 'main', head: 'HEAD' })
  })

  it('takes both refs when both are given', () => {
    expect(selectRefs({ base: 'main', head: 'topic' }))
      .toEqual({ kind: 'refs', base: 'main', head: 'topic' })
  })

  it('defers to resolvePr when --pr is given alone', () => {
    expect(selectRefs({ pr: '7' })).toEqual({ kind: 'pr', input: '7' })
  })

  // Refused rather than resolved by precedence: whichever flag lost would be
  // the one that changed the answer, and the run would look entirely normal.
  it('refuses --pr together with --base, naming the flag to drop', () => {
    expect(() => selectRefs({ pr: '7', base: 'main' })).toThrow(/--base/)
  })

  it('refuses --pr together with --head', () => {
    expect(() => selectRefs({ pr: '7', head: 'topic' })).toThrow(/--head/)
  })

  it('names both flags when both are given alongside --pr', () => {
    expect(() => selectRefs({ pr: '7', base: 'main', head: 'topic' }))
      .toThrow(/--base and --head/)
  })

  it('points at --pr when neither it nor --base is given', () => {
    expect(() => selectRefs({})).toThrow(/missing required --base \(or pass --pr/)
  })

  it('does not treat a --head-only invocation as complete', () => {
    expect(() => selectRefs({ head: 'topic' })).toThrow(/missing required --base/)
  })
})

// --- Task 11: `arcdiff serve` -----------------------------------------------
// Drives the real pipeline (tinyGitRepo -> runDiff -> a real pyright-langserver)
// so this needs the same generous timeout as the e2e.test.ts fixture tests,
// not vitest's 5s default.

import { createServer as createNetServer } from 'node:net'
import { runServe } from './run.js'

describe('runServe', () => {
  it('serve binds a port and answers /api/delta', async () => {
    const { dir, sha } = await tinyGitRepo()
    const cacheDir = await mkdtemp(join(tmpdir(), 'arcdiff-serve-cache-'))
    try {
      const { port, close } = await runServe({
        repoRoot: dir, subdir: 'app', cacheDir,
        lspCmd: 'pyright-langserver', lspArgs: ['--stdio'],
        venvHostDir: join(dir, 'app'), python: 'python3', excludeGlobs: [],
        allowParseFailures: false, allowNoResolvedBases: true,
        base: sha, head: sha, outPath: join(cacheDir, 'delta.json'),
        port: 0,
      })
      try {
        expect(port).toBeGreaterThan(0)
        const res = await fetch(`http://localhost:${port}/api/delta`)
        expect(res.status).toBe(200)
        expect((await res.json()).delta.elements).toEqual([])
      } finally {
        await close()
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(cacheDir, { recursive: true, force: true })
    }
  }, 60_000)

  it('rejects with a helpful message instead of crashing when the port is already in use', async () => {
    const { dir, sha } = await tinyGitRepo()
    const cacheDir = await mkdtemp(join(tmpdir(), 'arcdiff-serve-portbusy-'))
    const blocker = createNetServer()
    try {
      const port = await new Promise<number>(resolve => {
        blocker.listen(0, () => {
          const address = blocker.address()
          resolve(typeof address === 'object' && address !== null ? address.port : 0)
        })
      })
      await expect(runServe({
        repoRoot: dir, subdir: 'app', cacheDir,
        lspCmd: 'pyright-langserver', lspArgs: ['--stdio'],
        venvHostDir: join(dir, 'app'), python: 'python3', excludeGlobs: [],
        allowParseFailures: false, allowNoResolvedBases: true,
        base: sha, head: sha, outPath: join(cacheDir, 'delta.json'),
        port,
      })).rejects.toThrow(/--port/)
    } finally {
      await new Promise<void>(resolve => blocker.close(() => { resolve() }))
      await rm(dir, { recursive: true, force: true })
      await rm(cacheDir, { recursive: true, force: true })
    }
  }, 60_000)
})
