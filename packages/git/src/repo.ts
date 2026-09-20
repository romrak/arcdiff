import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const run = promisify(execFile)
const MAX = 64 * 1024 * 1024

/**
 * Run git inside `repoRoot` and return its stdout. Exported because `pr.ts`
 * needs the identical invocation — same `-C` anchoring, same buffer ceiling —
 * and a second private copy there would drift from this one.
 */
export async function gitStdout(repoRoot: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', repoRoot, ...args], { maxBuffer: MAX })
  return stdout
}

export async function resolveRef(repoRoot: string, ref: string): Promise<string> {
  return (await gitStdout(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`])).trim()
}

/**
 * Translates one `--exclude` glob into a RegExp matched against a
 * subdir-relative path. Supports `*` (any run of non-`/` characters), a
 * trailing double-star not followed by a slash (any run of characters,
 * including `/` — e.g. the wildcard at the end of `tests` + double-star),
 * and a leading double-star immediately followed by a slash (zero or more
 * whole path segments, so a pattern like double-star-slash-`test_*.py`
 * matches a top-level file too, not only a nested one).
 */
function globToRegExp(glob: string): RegExp {
  let re = ''
  let i = 0
  while (i < glob.length) {
    if (glob.startsWith('**/', i)) {
      re += '(?:.*/)?'
      i += 3
    } else if (glob.startsWith('**', i)) {
      re += '.*'
      i += 2
    } else if (glob[i] === '*') {
      re += '[^/]*'
      i += 1
    } else {
      const c = glob[i]!
      re += /[.\\+^$[\]|(){}?]/.test(c) ? `\\${c}` : c
      i += 1
    }
  }
  return new RegExp(`^${re}$`)
}

function matchesAnyGlob(path: string, globs: string[]): boolean {
  return globs.some(g => globToRegExp(g).test(path))
}

/**
 * .py paths under `subdir` at `ref`, returned relative to `subdir`.
 * `excludeGlobs` is applied here, at listing time, so an excluded path never
 * reaches extraction and never enters the model — not just filtered out of
 * the final view.
 */
export async function listPythonFiles(
  repoRoot: string, ref: string, subdir: string, excludeGlobs: string[] = [],
): Promise<string[]> {
  const out = await gitStdout(repoRoot, ['ls-tree', '-r', '--name-only', ref, '--', subdir])
  const prefix = subdir.endsWith('/') ? subdir : `${subdir}/`
  return out.split('\n')
    .filter(p => p.endsWith('.py'))
    .map(p => (p.startsWith(prefix) ? p.slice(prefix.length) : p))
    .filter(p => p.length > 0)
    .filter(p => !matchesAnyGlob(p, excludeGlobs))
}

/** Unified diff with zero context by default, paths relative to `subdir`. */
export async function diffText(
  repoRoot: string, base: string, head: string, subdir: string,
  /** Context lines. 0 keeps hunks tight for the engine; the viewer wants 3. */
  context = 0,
  /**
   * Narrow the diff to one path, repo-relative. MUST stay separate from
   * `subdir`: --relative strips a DIRECTORY prefix, so passing a file path
   * there makes git emit `+++ b/` with an empty filename, and every parsed
   * hunk then carries `file: ''` and matches no element. Verified against
   * the reference codebase on 2026-09-20.
   */
  pathspec?: string,
): Promise<string> {
  return gitStdout(repoRoot, [
    '-c', 'core.quotepath=false',
    'diff', `--unified=${context}`, '--no-color', `--relative=${subdir}`,
    base, head, '--', pathspec ?? subdir,
  ])
}

/** Create a detached worktree at `ref`, run `fn`, always remove the worktree. */
export async function withWorktree<T>(
  repoRoot: string, ref: string, fn: (wtPath: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'arcdiff-wt-'))
  const wt = join(dir, 'tree')
  try {
    await gitStdout(repoRoot, ['worktree', 'add', '-q', '--detach', wt, ref])
    try {
      return await fn(wt)
    } finally {
      try { await gitStdout(repoRoot, ['worktree', 'remove', '--force', wt]) } catch { /* best effort */ }
    }
  } finally {
    try { await rm(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

/**
 * Let pyright resolve third-party imports from the MAIN checkout's venv while
 * reading sources from a worktree that has no venv of its own.
 */
export async function writePyrightConfig(dir: string, venvHostDir: string): Promise<void> {
  const cfg = { venvPath: venvHostDir, venv: '.venv', typeCheckingMode: 'off' }
  await writeFile(join(dir, 'pyrightconfig.json'), JSON.stringify(cfg, null, 2), 'utf8')
}
