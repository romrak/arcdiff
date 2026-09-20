import { execFile, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Delta, Model } from '@arcdiff/model'
import type { Signal } from '@arcdiff/diff'
import { runDiff, runExtract, type ExtractStats } from './run.js'

/**
 * The only test in the suite that drives the REAL pipeline: a real
 * `pyright-langserver`, a real interpreter, real `git worktree`. Everything
 * else in these packages exercises pure helpers against hand-built inputs,
 * which is why a canary defect and a root-aliasing bug both survived to a
 * human running the CLI. The fixture repo is built in a temp dir rather than
 * pointed at the reference codebase: a four-file repo runs in seconds and is
 * present on every machine.
 */

const run = promisify(execFile)

const PYTHON = 'python3.14'
const LSP_CMD = 'pyright-langserver'
const LSP_ARGS = ['--stdio']

// --- prerequisite probe -----------------------------------------------------
// Synchronous, at module scope, so the skip decision and its reason are known
// before vitest collects anything.
//
// It deliberately does NOT probe NODE_OPTIONS, which is the other way this
// suite can fail on a developer machine. `LspClient.start` spawns the server
// with no `env`, so it inherits NODE_OPTIONS, and with stderr set to 'ignore'
// a server killed by a bad `--require` preload reports only
//   pyright-langserver exited (code=1, signal=null) while requests were pending
// which names neither NODE_OPTIONS nor the missing module. If you see that,
// check `echo $NODE_OPTIONS` before suspecting the fixture.

function onPath(cmd: string): boolean {
  return (process.env.PATH ?? '')
    .split(delimiter)
    .some(d => d !== '' && existsSync(join(d, cmd)))
}

function runnable(cmd: string, args: string[]): boolean {
  const r = spawnSync(cmd, args, { encoding: 'utf8' })
  return r.error === undefined && r.status === 0
}

const missing: string[] = []
if (!onPath(LSP_CMD)) missing.push(`${LSP_CMD} is not on PATH`)
if (!runnable(PYTHON, ['--version'])) missing.push(`${PYTHON} cannot be executed`)

// A checkout of https://github.com/pypa/pip, the same reference codebase the
// viewer e2e and the packages/view-model fixtures use. It needs no
// virtualenv: pip vendors its dependencies, so pyright resolves the whole
// tree from the checkout alone.
//
//   git clone https://github.com/pypa/pip ~/src/pip
//   ARCDIFF_E2E_REF=1 ARCDIFF_REF_REPO=~/src/pip npm test
const REF_REPO = process.env.ARCDIFF_REF_REPO ?? ''
const REF_SUBDIR = process.env.ARCDIFF_REF_SUBDIR ?? 'src'
// `pip._internal.main` is both a module and a function in `__init__.py`, and
// an element id cannot currently tell the two apart — see README, "Known
// limitations". `_vendor` is pip's bundled copy of its dependencies.
const REF_EXCLUDES = ['pip/_vendor/**', 'pip/_internal/main.py']

/**
 * The reference block is validation, not regression: it asserts stable
 * properties of a repository this project does not own, at a hardcoded path,
 * for ~35s of every run. Opt-in via ARCDIFF_E2E_REF=1. The FIXTURE block above
 * is the regression test and always runs — it is the one that would have
 * caught the canary and root-aliasing defects, and it needs nothing but the
 * toolchain.
 */
const REF_OPTED_IN = process.env.ARCDIFF_E2E_REF === '1'
// Reasons the ref block can't run once someone HAS opted in. Kept separate
// from opt-in status itself: "not opted in" is an expected, deliberate skip
// and must never be what ARCDIFF_E2E=required escalates, or every CI job that
// only wants the fixture block's guarantee would be forced to also check out
// the reference repo and pay the ~35s, defeating the point of making it opt-in.
const refMissing: string[] = REF_REPO !== '' && existsSync(join(REF_REPO, REF_SUBDIR))
  ? []
  : [REF_REPO === ''
      ? 'ARCDIFF_REF_REPO is not set (point it at a pip checkout)'
      : `the reference codebase at ${join(REF_REPO, REF_SUBDIR)} is absent`]

const canRun = missing.length === 0
const canRunRef = canRun && REF_OPTED_IN && refMissing.length === 0

/**
 * A silently-skipped integration test is indistinguishable from one that does
 * not exist, and this plan has already paid twice for tests that asserted
 * nothing. Two mitigations: the reason is shouted on stderr and repeated in
 * the describe title, and `ARCDIFF_E2E=required` turns every skip into a hard
 * collection failure — the lever a CI job that DOES have the toolchain should
 * pull, so a broken install cannot masquerade as a green run. This only
 * applies to skips from a missing prerequisite, never to the reference
 * block's own opt-in gate — see the comment on `refMissing` above.
 */
const STRICT = process.env.ARCDIFF_E2E === 'required'

function announce(what: string, reasons: string[]): void {
  if (reasons.length === 0) return
  const msg =
    `\n*** arcdiff e2e: SKIPPING ${what} ***\n` +
    reasons.map(r => `  - ${r}\n`).join('') +
    '  These tests are the only coverage of the real extract pipeline.\n' +
    '  Set ARCDIFF_E2E=required to turn this skip into a failure.\n'
  if (STRICT) throw new Error(msg)
  process.stderr.write(msg)
}

announce('the real-language-server fixture tests', missing)

if (!REF_OPTED_IN) {
  // Deliberate opt-out, not a broken install: shouted so it can't vanish
  // silently, but never fatal, and never escalated by ARCDIFF_E2E=required.
  process.stderr.write(
    '\n*** arcdiff e2e: SKIPPING the reference-codebase test ***\n' +
    '  - ARCDIFF_E2E_REF=1 is not set (opt-in)\n' +
    '  Set ARCDIFF_E2E_REF=1 to run it too (see docs/VALIDATION.md).\n',
  )
} else {
  // Opted in: now a missing prerequisite here is a real gap, and
  // ARCDIFF_E2E=required should treat it exactly like the fixture block's.
  announce('the reference-codebase test', canRun ? refMissing : missing)
}

function why(reasons: string[]): string {
  return reasons.length === 0 ? '' : ` [SKIPPED: ${reasons.join('; ')}]`
}

const refTitleReasons = !canRun ? missing : !REF_OPTED_IN
  ? ['ARCDIFF_E2E_REF=1 is not set (opt-in)']
  : refMissing

// --- fixture repo -----------------------------------------------------------

const SUBDIR = 'svc'

/**
 * Every temp tree this file makes, removed together at the end. A full run
 * otherwise leaves five behind under the OS tmpdir, one of them a ~10MB model
 * of the reference codebase.
 */
const scratchDirs: string[] = []

async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  scratchDirs.push(dir)
  return dir
}

afterAll(async () => {
  for (const dir of scratchDirs) await rm(dir, { recursive: true, force: true })
}, 120_000)

async function write(repo: string, rel: string, body: string): Promise<void> {
  const abs = join(repo, rel)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, body, 'utf8')
}

async function git(repo: string, args: string[]): Promise<void> {
  await run('git', ['-C', repo, ...args])
}

// Identity and signing are forced per-command: a machine with global gpg
// signing or no user.email configured would otherwise fail `git commit`.
async function commitAll(repo: string, message: string): Promise<void> {
  await git(repo, ['add', '-A'])
  await git(repo, [
    '-c', 'user.name=arcdiff test',
    '-c', 'user.email=arcdiff@example.invalid',
    '-c', 'commit.gpgsign=false',
    'commit', '-q', '-m', message,
  ])
}

async function newRepo(prefix: string): Promise<string> {
  const repo = await scratch(prefix)
  await git(repo, ['init', '-q', '-b', 'main'])
  return repo
}

/**
 * Mirrors the reference codebase's shape: the analysis root is the SUBDIR, and
 * first-party imports are spelled relative to it (`app.iface`, not
 * `svc.app.iface`) because that is the import root pyright is given. Bases are
 * chosen to cover all three resolution outcomes at once —
 *   Iface(ABC)   -> external   (typeshed, outside the root)
 *   Impl(Iface)  -> resolved onto an 'interface' -> 'implements'
 *   Child(Base)  -> resolved onto a 'class'      -> 'extends'
 * and nothing spelled as an alias, so `basesNotDefinition` must be 0.
 */
async function buildFixtureRepo(): Promise<string> {
  const repo = await newRepo('arcdiff-e2e-fixture-')
  await write(repo, `${SUBDIR}/app/__init__.py`, '')
  // A @property WITHOUT its setter at base. The setter arrives at HEAD below,
  // which is the case that used to manufacture a signature-changed signal:
  // getter and setter share a qualname, so one id covered both.
  await write(repo, `${SUBDIR}/app/base.py`,
    'class Base:\n' +
    '    def ping(self) -> str:\n' +
    '        return "pong"\n' +
    '\n' +
    '    @property\n' +
    '    def flag(self) -> bool:\n' +
    '        return self._flag\n')
  // Amendment A1's motivating case. The brief's original FQN reconstruction
  // built a target id as `moduleFqn + '.' + lastSegment`, which for this base
  // yields `app.nested.Inner` — an id no element has. Only the (file, line)
  // index gets `app.nested.Outer.Inner`. `Outer.Inner` is also a DOTTED base,
  // so the same fixture covers parse.py pointing at the final name token.
  await write(repo, `${SUBDIR}/app/nested.py`,
    'class Outer:\n' +
    '    class Inner:\n' +
    '        pass\n')
  await write(repo, `${SUBDIR}/app/iface.py`,
    'from abc import ABC, abstractmethod\n' +
    '\n' +
    '\n' +
    'class Iface(ABC):\n' +
    '    @abstractmethod\n' +
    '    def get(self, key: str) -> str:\n' +
    '        raise NotImplementedError\n')
  await write(repo, `${SUBDIR}/app/impl.py`,
    'from app.base import Base\n' +
    'from app.iface import Iface\n' +
    'from app.nested import Outer\n' +
    '\n' +
    '\n' +
    'class Impl(Iface):\n' +
    '    def get(self, key: str) -> str:\n' +
    '        return key\n' +
    '\n' +
    '\n' +
    'class Child(Base):\n' +
    '    def ping(self) -> str:\n' +
    '        return "child"\n' +
    '\n' +
    '\n' +
    'class UsesNested(Outer.Inner):\n' +
    '    pass\n')
  await commitAll(repo, 'base')

  // HEAD grows a setter on the existing property. No new file, no new base
  // site, so every extraction counter is unchanged.
  await write(repo, `${SUBDIR}/app/base.py`,
    'class Base:\n' +
    '    def ping(self) -> str:\n' +
    '        return "pong"\n' +
    '\n' +
    '    @property\n' +
    '    def flag(self) -> bool:\n' +
    '        return self._flag\n' +
    '\n' +
    '    @flag.setter\n' +
    '    def flag(self, value: bool) -> None:\n' +
    '        self._flag = value\n')

  // HEAD adds one method, so the diff half of the pipeline has something real
  // to report without perturbing any of the base-resolution counters.
  await write(repo, `${SUBDIR}/app/impl.py`,
    'from app.base import Base\n' +
    'from app.iface import Iface\n' +
    'from app.nested import Outer\n' +
    '\n' +
    '\n' +
    'class Impl(Iface):\n' +
    '    def get(self, key: str) -> str:\n' +
    '        return key\n' +
    '\n' +
    '    def get_many(self, keys: list[str]) -> list[str]:\n' +
    '        return [self.get(k) for k in keys]\n' +
    '\n' +
    '\n' +
    'class Child(Base):\n' +
    '    def ping(self) -> str:\n' +
    '        return "child"\n' +
    '\n' +
    '\n' +
    'class UsesNested(Outer.Inner):\n' +
    '    pass\n')
  await commitAll(repo, 'head')
  return repo
}

/** A repo whose every base resolves OUTSIDE the root — the guard's trigger. */
async function buildAllExternalRepo(): Promise<string> {
  const repo = await newRepo('arcdiff-e2e-external-')
  await write(repo, `${SUBDIR}/app/__init__.py`, '')
  await write(repo, `${SUBDIR}/app/only.py`,
    'from abc import ABC\n' +
    '\n' +
    '\n' +
    'class Only(ABC):\n' +
    '    pass\n')
  await commitAll(repo, 'only')
  return repo
}

function optionsFor(repo: string, cacheDir: string): {
  repoRoot: string; subdir: string; cacheDir: string
  lspCmd: string; lspArgs: string[]; venvHostDir: string; python: string
} {
  return {
    repoRoot: repo,
    subdir: SUBDIR,
    cacheDir,
    lspCmd: LSP_CMD,
    lspArgs: LSP_ARGS,
    venvHostDir: join(repo, SUBDIR),
    python: PYTHON,
  }
}

/**
 * The stats sidecar, found by extension rather than by calling the path
 * helper: the cache-key scheme is still moving, and this test is about the
 * counters being persisted at all, not about what the file is named.
 */
function readPersistedStats(cacheDir: string): ExtractStats {
  const names = readdirSync(cacheDir).filter(n => n.endsWith('.stats.json'))
  expect(names).toHaveLength(1)
  return JSON.parse(readFileSync(join(cacheDir, names[0]!), 'utf8')) as ExtractStats
}

const TEN_MIN = 600_000

// --- the real pipeline, on a fixture repo -----------------------------------

describe.skipIf(!canRun)(
  `e2e: real ${LSP_CMD} + ${PYTHON} + git on a fixture repo${why(missing)}`,
  () => {
    let stats: ExtractStats
    let model: Model
    let out: {
      delta: Delta
      signals: Signal[]
      source?: {
        repoRoot: string; subdir: string
        base: { ref: string; modelPath: string }
        head: { ref: string; modelPath: string }
        capabilities: Record<string, boolean> | null
      }
    }
    let repoRoot: string

    beforeAll(async () => {
      const repo = await buildFixtureRepo()
      repoRoot = repo
      const cacheDir = join(await scratch('arcdiff-e2e-cache-'), 'cache')

      const extracted = await runExtract({ ...optionsFor(repo, cacheDir), ref: 'HEAD' })
      stats = extracted.stats
      model = JSON.parse(await readFile(extracted.path, 'utf8')) as Model

      const outPath = join(cacheDir, 'delta.json')
      const diffed = await runDiff({
        ...optionsFor(repo, cacheDir), base: 'HEAD~1', head: 'HEAD', outPath,
      })
      out = JSON.parse(await readFile(diffed.deltaPath, 'utf8')) as typeof out
    }, TEN_MIN)

    it('parses every file under the real interpreter', () => {
      expect(stats.failures).toEqual([])
      expect(stats.filesFailed).toBe(0)
      // __init__.py, base.py, nested.py, iface.py, impl.py
      expect(stats.filesParsed).toBe(5)
      expect(stats.pythonVersion[0]).toBe(3)
    })

    it('resolves base classes in-repo and lands every one on a definition', () => {
      // Iface(ABC), Impl(Iface), Child(Base), UsesNested(Outer.Inner)
      expect(stats.basesAttempted).toBe(4)
      expect(stats.basesResolved).toBeGreaterThan(0)
      expect(stats.basesResolved).toBe(3)
      expect(stats.basesExternal).toBe(1) // ABC, from typeshed
      expect(stats.basesNotDefinition).toBe(0)
      expect(stats.noBasesResolved).toBe(false)
    })

    it('classifies an ABC with an abstractmethod as an interface', () => {
      expect(model.elements.find(e => e.id === 'app.iface.Iface')?.kind).toBe('interface')
    })

    it('leaves a plain class classified as a class', () => {
      expect(model.elements.find(e => e.id === 'app.base.Base')?.kind).toBe('class')
    })

    it('labels a class implementing an ABC with implements, not extends', () => {
      expect(model.edges).toContainEqual({
        from: 'app.impl.Impl', to: 'app.iface.Iface', kind: 'implements',
      })
      expect(model.edges).not.toContainEqual({
        from: 'app.impl.Impl', to: 'app.iface.Iface', kind: 'extends',
      })
    })

    it('labels a plain subclass with extends', () => {
      expect(model.edges).toContainEqual({
        from: 'app.impl.Child', to: 'app.base.Base', kind: 'extends',
      })
      expect(model.edges).not.toContainEqual({
        from: 'app.impl.Child', to: 'app.base.Base', kind: 'implements',
      })
    })

    // Amendment A1/A24's motivating case: a base declared inside another
    // class. The naive FQN reconstruction (moduleFqn + '.' + last segment of
    // the base expression) lands on 'app.nested.Inner', an id nothing has —
    // only the (file, line) definition index lands on the real nested id.
    it('resolves a base declared inside another class onto its nested id, not the bare inner name', () => {
      expect(model.elements.some(e => e.id === 'app.nested.Outer.Inner')).toBe(true)
      expect(model.edges).toContainEqual({
        from: 'app.impl.UsesNested', to: 'app.nested.Outer.Inner', kind: 'extends',
      })
      expect(model.edges).not.toContainEqual(
        expect.objectContaining({ from: 'app.impl.UsesNested', to: 'app.nested.Inner' }),
      )
      expect(stats.basesNotDefinition).toBe(0)
    })

    it('diffs the two refs into a delta naming the added method', () => {
      expect(out.delta.base).toMatch(/^[0-9a-f]{40}$/)
      expect(out.delta.head).toMatch(/^[0-9a-f]{40}$/)
      const added = out.delta.elements.find(c => c.id === 'app.impl.Impl.get_many')
      expect(added?.change).toBe('added')
    })

    it('derives a signal for the added member', () => {
      const kinds = out.signals.map(s => s.kind)
      expect(kinds).toContain('new-member')
    })

    it('gives every element in the real model a unique id', () => {
      const ids = model.elements.map(e => e.id)
      expect(new Set(ids).size).toBe(ids.length)
    })

    // The payoff. Adding a @flag.setter to an existing @property used to emit
    // signature-changed on the getter — a change that did not happen, in the
    // one signal VALIDATION.md calls the point of the engine.
    it('reports an added property setter as a new member, not a signature change', () => {
      expect(model.elements.map(e => e.id)).toContain('app.base.Base.flag.setter')
      const added = out.delta.elements.find(c => c.id === 'app.base.Base.flag.setter')
      expect(added?.change).toBe('added')
      expect(out.delta.elements.find(c => c.id === 'app.base.Base.flag')?.fields ?? [])
        .not.toContain('signature')
      expect(out.signals.filter(sig => sig.kind === 'signature-changed')).toEqual([])
    })

    it('carries the drill-down source and the probed capabilities in delta.json', () => {
      expect(out.source?.repoRoot).toBe(repoRoot)
      expect(out.source?.subdir).toBe(SUBDIR)
      expect(out.source?.base.ref).toMatch(/^[0-9a-f]{40}$/)
      expect(out.source?.head.ref).toMatch(/^[0-9a-f]{40}$/)
      expect(out.source?.base.modelPath).toMatch(/\.json$/)
      expect(out.source?.head.modelPath).toMatch(/\.json$/)
      // pyright answers definition requests, so this is not a vacuous null.
      expect(out.source?.capabilities?.definition).toBe(true)
    })

    it('persists the capabilities in the stats sidecar, where a cache hit can read them', () => {
      expect(stats.capabilities?.definition).toBe(true)
    })
  },
)

// --- the end-of-run guard ---------------------------------------------------

describe.skipIf(!canRun)(
  `e2e: the all-external guard, against a real server${why(missing)}`,
  () => {
    let repo: string

    beforeAll(async () => { repo = await buildAllExternalRepo() }, TEN_MIN)

    // A fresh cache dir per case on purpose. `runExtract` serves a cache hit
    // on (sha, subdir) alone and re-applies only the parse-failure gate, so a
    // shared dir would let the permissive run below seed a model that the
    // throwing run then returns happily — the assertion would pass while
    // testing nothing.
    it('throws when not one base resolved inside the root', async () => {
      const cacheDir = join(await scratch('arcdiff-e2e-guard-'), 'cache')
      await expect(
        runExtract({ ...optionsFor(repo, cacheDir), ref: 'HEAD' }),
      ).rejects.toThrow(/0 of 1 base classes resolved/)
    }, TEN_MIN)

    it('proceeds under allowNoResolvedBases and records noBasesResolved', async () => {
      const cacheDir = join(await scratch('arcdiff-e2e-allow-'), 'cache')
      const result = await runExtract({
        ...optionsFor(repo, cacheDir), ref: 'HEAD', allowNoResolvedBases: true,
      })
      expect(result.stats.basesAttempted).toBe(1)
      expect(result.stats.basesResolved).toBe(0)
      expect(result.stats.basesExternal).toBe(1)
      expect(result.stats.noBasesResolved).toBe(true)
      // Persisted too, not just returned: a cache hit reports from the sidecar.
      expect(readPersistedStats(cacheDir).noBasesResolved).toBe(true)
    }, TEN_MIN)
  },
)

// --- the reference codebase -------------------------------------------------

describe.skipIf(!canRunRef)(
  `e2e: the reference codebase at ${REF_SUBDIR}${why(refTitleReasons)}`,
  () => {
    let stats: ExtractStats

    beforeAll(async () => {
      const cacheDir = join(await scratch('arcdiff-e2e-ref-'), 'cache')
      const result = await runExtract({
        repoRoot: REF_REPO,
        subdir: REF_SUBDIR,
        cacheDir,
        lspCmd: LSP_CMD,
        lspArgs: LSP_ARGS,
        venvHostDir: join(REF_REPO, REF_SUBDIR),
        python: PYTHON,
        ref: 'HEAD',
        excludeGlobs: REF_EXCLUDES,
      })
      stats = result.stats
    }, TEN_MIN)

    // Properties only, never counts: this repo moves under us.
    it('parses every Python file in the subdir', () => {
      expect(stats.failures).toEqual([])
      expect(stats.filesFailed).toBe(0)
      expect(stats.filesParsed).toBeGreaterThan(0)
    })

    it('resolves base classes in-repo', () => {
      expect(stats.basesResolved).toBeGreaterThan(0)
      expect(stats.noBasesResolved).toBe(false)
    })

    it('lands nearly every in-root base on a definition line', () => {
      // A fraction, not a count, because this repo moves under us. pip had
      // exactly ONE such base out of 187 attempted when this was measured
      // (2026-09-20) — a base expression whose definition site is not a
      // `class` statement. The defect class this guards against (a def index
      // keyed on the wrong line) pushes the ratio to most of the corpus, not
      // to one or two.
      expect(stats.basesAttempted).toBeGreaterThan(0)
      expect(stats.basesNotDefinition / stats.basesAttempted).toBeLessThan(0.05)
    })
  },
)
