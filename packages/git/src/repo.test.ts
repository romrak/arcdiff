import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, chmod } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { resolveRef, listPythonFiles, diffText, withWorktree, writePyrightConfig } from './repo.js'

const run = promisify(execFile)
let repo: string
let baseSha: string
let headSha: string

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), 'arcdiff-repo-'))
  const git = (...a: string[]) => run('git', ['-C', repo, ...a])
  await git('init', '-q')
  await git('config', 'user.email', 't@t')
  await git('config', 'user.name', 'T')
  await mkdir(join(repo, 'svc/app'), { recursive: true })
  await writeFile(join(repo, 'svc/app/a.py'), 'class A:\n    pass\n')
  await writeFile(join(repo, 'svc/README.md'), 'not python\n')
  await git('add', '-A'); await git('commit', '-q', '-m', 'base')
  baseSha = (await git('rev-parse', 'HEAD')).stdout.trim()
  await writeFile(join(repo, 'svc/app/a.py'), 'class A:\n    def run(self):\n        pass\n')
  await writeFile(join(repo, 'svc/app/b.py'), 'class B:\n    pass\n')
  await git('add', '-A'); await git('commit', '-q', '-m', 'head')
  headSha = (await git('rev-parse', 'HEAD')).stdout.trim()
})
afterAll(async () => { await rm(repo, { recursive: true, force: true }) })

describe('resolveRef', () => {
  it('expands HEAD to a full 40-char sha', async () => {
    const sha = await resolveRef(repo, 'HEAD')
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
    expect(sha).toBe(headSha)
  })
  it('rejects an unknown ref', async () => {
    await expect(resolveRef(repo, 'no-such-ref')).rejects.toThrow()
  })
})

describe('listPythonFiles', () => {
  it('lists .py files at a ref, relative to the subdir', async () => {
    expect((await listPythonFiles(repo, headSha, 'svc')).sort())
      .toEqual(['app/a.py', 'app/b.py'])
  })
  it('excludes non-python files', async () => {
    expect(await listPythonFiles(repo, headSha, 'svc')).not.toContain('README.md')
  })
  it('reflects the ref, not the working tree', async () => {
    expect(await listPythonFiles(repo, baseSha, 'svc')).toEqual(['app/a.py'])
  })
})

describe('listPythonFiles with excludeGlobs', () => {
  it('excludes a matching path at listing time, so it never enters the model', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arcdiff-repo-exclude-'))
    try {
      const git = (...a: string[]) => run('git', ['-C', dir, ...a])
      await git('init', '-q')
      await git('config', 'user.email', 't@t')
      await git('config', 'user.name', 'T')
      await mkdir(join(dir, 'svc/app'), { recursive: true })
      await mkdir(join(dir, 'svc/tests'), { recursive: true })
      await writeFile(join(dir, 'svc/app/a.py'), 'class A:\n    pass\n')
      await writeFile(join(dir, 'svc/tests/test_a.py'), 'def test_a(): pass\n')
      await git('add', '-A')
      await git('commit', '-q', '-m', 'init')
      const sha = (await git('rev-parse', 'HEAD')).stdout.trim()

      expect((await listPythonFiles(dir, sha, 'svc')).sort())
        .toEqual(['app/a.py', 'tests/test_a.py'])
      expect(await listPythonFiles(dir, sha, 'svc', ['tests/**']))
        .toEqual(['app/a.py'])
    } finally {
      // maxRetries: a freshly-exited `git commit` can still hold .git files
      // open for a moment on macOS, which otherwise races this cleanup as
      // ENOTEMPTY (see the identical comment on the cache-guard test in
      // packages/cli/src/run.test.ts).
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })

  it('matches a leading **/ against a top-level file too, not only a nested one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arcdiff-repo-exclude-'))
    try {
      const git = (...a: string[]) => run('git', ['-C', dir, ...a])
      await git('init', '-q')
      await git('config', 'user.email', 't@t')
      await git('config', 'user.name', 'T')
      await mkdir(join(dir, 'svc/nested'), { recursive: true })
      await writeFile(join(dir, 'svc/test_top.py'), 'def test_top(): pass\n')
      await writeFile(join(dir, 'svc/nested/test_deep.py'), 'def test_deep(): pass\n')
      await writeFile(join(dir, 'svc/nested/keep.py'), 'class Keep:\n    pass\n')
      await git('add', '-A')
      await git('commit', '-q', '-m', 'init')
      const sha = (await git('rev-parse', 'HEAD')).stdout.trim()

      expect(await listPythonFiles(dir, sha, 'svc', ['**/test_*.py']))
        .toEqual(['nested/keep.py'])
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })
})

describe('diffText', () => {
  it('returns a unified diff with subdir-relative paths', async () => {
    const d = await diffText(repo, baseSha, headSha, 'svc')
    expect(d).toContain('+++ b/app/a.py')
    expect(d).not.toContain('svc/app/a.py')
  })
  it('uses zero context so hunks stay tight', async () => {
    const d = await diffText(repo, baseSha, headSha, 'svc')
    expect(d).toMatch(/@@ -\d+(,\d+)? \+\d+(,\d+)? @@/)
  })
})

describe('withWorktree', () => {
  it('materializes the ref and exposes its content', async () => {
    const seen = await withWorktree(repo, baseSha, async wt => {
      return readFile(join(wt, 'svc/app/a.py'), 'utf8')
    })
    expect(seen).toBe('class A:\n    pass\n')
  })

  it('removes the worktree afterwards', async () => {
    let captured = ''
    await withWorktree(repo, baseSha, async wt => { captured = wt })
    const { stdout } = await run('git', ['-C', repo, 'worktree', 'list'])
    expect(stdout).not.toContain(captured)
  })

  it('removes the worktree even when the callback throws', async () => {
    let captured = ''
    await expect(withWorktree(repo, baseSha, async wt => {
      captured = wt; throw new Error('boom')
    })).rejects.toThrow('boom')
    const { stdout } = await run('git', ['-C', repo, 'worktree', 'list'])
    expect(stdout).not.toContain(captured)
  })

  it('propagates the callback error even when the cleanup rm also fails', async () => {
    let dir = ''
    await expect(withWorktree(repo, baseSha, async wt => {
      dir = dirname(wt)
      // Strip write permission from the temp dir's parent so the final
      // rm(dir, { recursive: true }) cannot unlink the worktree entry and
      // itself throws — the callback's own error must still win.
      await chmod(dir, 0o500)
      throw new Error('boom-xyz')
    })).rejects.toThrow('boom-xyz')
    // Restore permissions and finish the cleanup our implementation could
    // not, so this test doesn't leak an unremovable temp directory.
    await chmod(dir, 0o700)
    await rm(dir, { recursive: true, force: true })
  })

  it('removes its temp directory when git worktree add itself fails', async () => {
    // withWorktree mkdtemps under os.tmpdir(), so point that at a private
    // directory for the duration. Scanning the SHARED system tmpdir instead
    // races every other test file: vitest runs them in parallel workers, and
    // any arcdiff-wt-* a neighbour is legitimately using right now reads as a
    // directory this call leaked. That is a real flake, seen in CI-style full
    // runs and never when this file runs alone.
    const sandbox = await mkdtemp(join(tmpdir(), 'arcdiff-wtsandbox-'))
    const previous = process.env.TMPDIR
    process.env.TMPDIR = sandbox
    try {
      await expect(withWorktree(repo, 'no-such-ref', async wt => wt)).rejects.toThrow()
      expect(await readdir(sandbox)).toEqual([])
    } finally {
      if (previous === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previous
      await rm(sandbox, { recursive: true, force: true })
    }
  })
})

describe('writePyrightConfig', () => {
  it('points venvPath at the host venv directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arcdiff-cfg-'))
    await writePyrightConfig(dir, '/host/project')
    const cfg = JSON.parse(await readFile(join(dir, 'pyrightconfig.json'), 'utf8'))
    expect(cfg).toMatchObject({ venvPath: '/host/project', venv: '.venv' })
    await rm(dir, { recursive: true, force: true })
  })
})
