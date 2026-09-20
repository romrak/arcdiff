import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parsePrRef, parseRemoteUrl, resolvePr,
  type PrInfo, type PrLookup, type Project,
} from './pr.js'

const run = promisify(execFile)

describe('parsePrRef', () => {
  it('reads a bare number, with or without the hash', () => {
    expect(parsePrRef('123')).toEqual({ number: 123 })
    expect(parsePrRef('#123')).toEqual({ number: 123 })
    expect(parsePrRef('  123  ')).toEqual({ number: 123 })
  })

  it('reads owner/repo#number', () => {
    expect(parsePrRef('acme/widgets#7'))
      .toEqual({ number: 7, project: { owner: 'acme', repo: 'widgets' } })
  })

  it('reads a pull-request URL', () => {
    expect(parsePrRef('https://github.com/acme/widgets/pull/7'))
      .toEqual({ number: 7, project: { owner: 'acme', repo: 'widgets' } })
  })

  it('reads a URL with the tail a browser leaves on a copied address', () => {
    // These are what you actually get from the address bar mid-review, so
    // rejecting them would make the feature fail on its most common input.
    for (const tail of ['/files', '/commits', '/files#diff-abc123', '?w=1']) {
      expect(parsePrRef(`https://github.com/acme/widgets/pull/7${tail}`))
        .toEqual({ number: 7, project: { owner: 'acme', repo: 'widgets' } })
    }
  })

  it('accepts the www host', () => {
    expect(parsePrRef('https://www.github.com/acme/widgets/pull/7').number).toBe(7)
  })

  it('sees past userinfo and a port to the real host', () => {
    // Without this the host group captures 'user@github.com' and the URL is
    // turned away as if it were on some other site.
    for (const url of [
      'https://user@github.com/acme/widgets/pull/7',
      'https://github.com:443/acme/widgets/pull/7',
    ]) {
      expect(parsePrRef(url), url)
        .toEqual({ number: 7, project: { owner: 'acme', repo: 'widgets' } })
    }
  })

  it('does not accept a github.com path segment on another host', () => {
    expect(() => parsePrRef('https://evil.example/github.com/acme/widgets/pull/7'))
      .toThrow(/not a GitHub pull-request URL/)
  })

  it('names the host when a pull URL is not on github.com', () => {
    expect(() => parsePrRef('https://github.acme.com/acme/widgets/pull/7'))
      .toThrow(/github\.acme\.com/)
  })

  it('rejects a GitLab merge-request URL as a URL, not as gibberish', () => {
    expect(() => parsePrRef('https://gitlab.com/acme/widgets/-/merge_requests/7'))
      .toThrow(/not a GitHub pull-request URL/)
  })

  it('treats owner/repo.git#n as the same project as owner/repo', () => {
    expect(parsePrRef('acme/widgets.git#7'))
      .toEqual({ number: 7, project: { owner: 'acme', repo: 'widgets' } })
  })

  it('reads a URL whose scheme is upper-case', () => {
    // The guard that routes a string into URL handling is case-insensitive,
    // so a case-sensitive pattern behind it turns HTTPS:// away as malformed.
    expect(parsePrRef('HTTPS://github.com/acme/widgets/pull/7'))
      .toEqual({ number: 7, project: { owner: 'acme', repo: 'widgets' } })
  })

  it('rejects a number that cannot be a pull request', () => {
    expect(() => parsePrRef('0')).toThrow(/1 or more/)
  })

  it('rejects input it cannot read at all', () => {
    for (const bad of ['', 'main', 'abc', 'acme/widgets', '12.3']) {
      expect(() => parsePrRef(bad), bad).toThrow(/cannot read/)
    }
  })
})

describe('parseRemoteUrl', () => {
  it('reads every spelling git accepts for a GitHub remote', () => {
    const expected = { host: 'github.com', owner: 'acme', repo: 'widgets' }
    for (const url of [
      'https://github.com/acme/widgets.git',
      'https://github.com/acme/widgets',
      'https://github.com/acme/widgets/',
      'https://user@github.com/acme/widgets.git',
      'git@github.com:acme/widgets.git',
      'ssh://git@github.com/acme/widgets.git',
      'ssh://git@github.com:22/acme/widgets.git',
      'git://github.com/acme/widgets.git',
    ]) {
      expect(parseRemoteUrl(url), url).toEqual(expected)
    }
  })

  it('does not mistake a scheme for a host', () => {
    // The scp-like branch would read 'https' as the host if it ran first.
    expect(parseRemoteUrl('https://github.com/acme/widgets')?.host).toBe('github.com')
  })

  it('returns null for a remote that names no project', () => {
    for (const url of [
      '/srv/mirrors/widgets.git', '../sibling', 'github.com', '',
      // A Windows path: the scp-like shape would otherwise read the drive
      // letter as the host and the last two segments as owner/repo.
      'C:/repos/widgets',
    ]) {
      expect(parseRemoteUrl(url), url).toBeNull()
    }
  })
})

// --- resolvePr, against real local repositories -----------------------------
// No network: `refs/pull/<n>/head` is an ordinary ref, and git fetches from a
// filesystem path exactly as it does from a URL.

const scratchDirs: string[] = []

async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  scratchDirs.push(dir)
  return dir
}

afterAll(async () => {
  for (const dir of scratchDirs) await rm(dir, { recursive: true, force: true })
})

function git(repo: string) {
  return async (...args: string[]): Promise<string> =>
    (await run('git', ['-C', repo, ...args])).stdout.trim()
}

/**
 * An upstream whose base branch has moved on since the pull request forked,
 * and whose pull-request commit is reachable ONLY through `refs/pull/7/head` —
 * the branch is deleted, which is what a fork's PR looks like from the base
 * repository's side.
 */
interface Upstream {
  path: string
  forkPoint: string
  prHead: string
  mainTip: string
}

let upstream: Upstream

beforeAll(async () => {
  const path = await scratch('arcdiff-pr-upstream-')
  const g = git(path)
  await g('init', '-q', '-b', 'main')
  await g('config', 'user.email', 't@t')
  await g('config', 'user.name', 'T')
  await g('config', 'commit.gpgsign', 'false')

  await writeFile(join(path, 'a.py'), 'class A:\n    pass\n', 'utf8')
  await g('add', '-A'); await g('commit', '-q', '-m', 'fork point')
  const forkPoint = await g('rev-parse', 'HEAD')

  await g('checkout', '-q', '-b', 'contributor')
  await writeFile(join(path, 'a.py'), 'class A:\n    def run(self):\n        pass\n', 'utf8')
  await g('add', '-A'); await g('commit', '-q', '-m', 'the pull request')
  const prHead = await g('rev-parse', 'HEAD')
  await g('update-ref', 'refs/pull/7/head', prHead)

  await g('checkout', '-q', 'main')
  await g('branch', '-D', 'contributor')

  for (const n of [1, 2]) {
    await writeFile(join(path, `drift${n}.py`), `X = ${n}\n`, 'utf8')
    await g('add', '-A'); await g('commit', '-q', '-m', `drift ${n}`)
  }
  const mainTip = await g('rev-parse', 'HEAD')

  upstream = { path, forkPoint, prHead, mainTip }
})

/**
 * A repo with `origin` pointing at the upstream. When `originUrl` is given it
 * is what `remote.origin.url` literally holds, and `insteadOf` sends the
 * actual fetch to the upstream path — which is how a bare `--pr 7` can be
 * exercised at all, since deriving owner/repo requires a URL that names one.
 */
async function localRepo(originUrl?: string, extraUrl?: string): Promise<string> {
  const path = await scratch('arcdiff-pr-local-')
  const g = git(path)
  await g('init', '-q', '-b', 'main')
  await g('config', 'user.email', 't@t')
  await g('config', 'user.name', 'T')
  await g('remote', 'add', 'origin', originUrl ?? upstream.path)
  if (originUrl !== undefined) {
    await g('config', `url.${upstream.path}.insteadOf`, originUrl)
  }
  if (extraUrl !== undefined) await g('remote', 'set-url', '--add', 'origin', extraUrl)
  return path
}

function lookupReturning(overrides: Partial<PrInfo> = {}): {
  lookup: PrLookup
  calls: Array<Project & { number: number }>
} {
  const calls: Array<Project & { number: number }> = []
  const lookup: PrLookup = async target => {
    calls.push(target)
    return {
      number: target.number,
      title: 'Add a run method',
      url: `https://github.com/${target.owner}/${target.repo}/pull/${target.number}`,
      state: 'OPEN',
      baseRefName: 'main',
      headRefOid: upstream.prHead,
      isCrossRepository: true,
      ...overrides,
    }
  }
  return { lookup, calls }
}

async function filesChanged(repo: string, a: string, b: string): Promise<string[]> {
  return (await git(repo)('diff', '--name-only', a, b)).split('\n').filter(Boolean).sort()
}

describe('resolvePr', () => {
  it('resolves the base to the merge base, not the base branch tip', async () => {
    const repo = await localRepo()
    const { lookup } = lookupReturning()

    const { baseSha, headSha } = await resolvePr({
      repoRoot: repo, input: 'https://github.com/acme/widgets/pull/7', lookup,
    })

    expect(headSha).toBe(upstream.prHead)
    expect(baseSha).toBe(upstream.forkPoint)
    expect(baseSha).not.toBe(upstream.mainTip)
  })

  it('keeps the diff to the pull request instead of the drift behind it', async () => {
    // The consequence of the line above, stated as the thing a reviewer sees.
    // Measured on pypa/pip#13535: against the base branch tip, 83 source files
    // change and 6562 lines are deleted — the upstream commits, read backwards.
    // Against the merge base, one file.
    const repo = await localRepo()
    const { lookup } = lookupReturning()
    const { baseSha, headSha } = await resolvePr({
      repoRoot: repo, input: 'https://github.com/acme/widgets/pull/7', lookup,
    })

    expect(await filesChanged(repo, baseSha, headSha)).toEqual(['a.py'])
    expect(await filesChanged(repo, upstream.mainTip, headSha))
      .toEqual(['a.py', 'drift1.py', 'drift2.py'])
  })

  it('reaches a pull request whose branch no longer exists anywhere', async () => {
    // `contributor` was deleted upstream, so refs/pull/7/head is the only way
    // to the commit — the ordinary case for a pull request opened from a fork.
    const repo = await localRepo()
    const { lookup } = lookupReturning()
    const { headSha } = await resolvePr({
      repoRoot: repo, input: 'https://github.com/acme/widgets/pull/7', lookup,
    })
    expect(await git(repo)('cat-file', '-t', headSha)).toBe('commit')
    expect(headSha).toBe(upstream.prHead)
  })

  it('derives owner/repo from the remote when given a bare number', async () => {
    const repo = await localRepo('https://github.com/acme/widgets.git')
    const { lookup, calls } = lookupReturning()

    const { baseSha } = await resolvePr({ repoRoot: repo, input: '7', lookup })

    expect(calls).toEqual([{ owner: 'acme', repo: 'widgets', number: 7 }])
    expect(baseSha).toBe(upstream.forkPoint)
  })

  it('refuses a bare number when the remote names no project', async () => {
    const repo = await localRepo()
    const { lookup, calls } = lookupReturning()
    await expect(resolvePr({ repoRoot: repo, input: '7', lookup }))
      .rejects.toThrow(/names no owner\/repo/)
    expect(calls).toEqual([])
  })

  it('refuses a remote that is not on github.com, however --pr is spelled', async () => {
    // Checking this only for a bare number left owner/repo#n and the full URL
    // through: owner and repo would match a GitHub Enterprise remote exactly,
    // and gh would then read github.com's pull request while the fetch pulled
    // the head from the enterprise host. Two projects, one ordinary diff.
    const repo = await localRepo('https://github.acme.com/acme/widgets.git')
    for (const input of ['7', 'acme/widgets#7', 'https://github.com/acme/widgets/pull/7']) {
      const { lookup, calls } = lookupReturning()
      await expect(resolvePr({ repoRoot: repo, input, lookup }), input)
        .rejects.toThrow(/not github\.com/)
      expect(calls, input).toEqual([])
    }
  })

  it('identifies the project from the remote url that fetch actually dials', async () => {
    // `git remote set-url --add` leaves remote.<name>.url multi-valued, and
    // `git config --get` returns the LAST value while fetch uses the FIRST.
    // Reading the last one asks gh for the mirror's pull request #7 — a
    // different project — while fetching the head from this one.
    const repo = await localRepo(
      'https://github.com/acme/widgets.git',
      'https://github.com/mirror/widgets.git',
    )
    const { lookup, calls } = lookupReturning()

    const { baseSha } = await resolvePr({ repoRoot: repo, input: '7', lookup })

    expect(calls).toEqual([{ owner: 'acme', repo: 'widgets', number: 7 }])
    expect(baseSha).toBe(upstream.forkPoint)
  })

  it('points at --remote when the pull request lives on a sibling remote', async () => {
    // Cloning your own fork is the common shape: origin is me/widgets and the
    // pull request is on acme/widgets under another remote. Telling the user
    // to re-clone would be the wrong fix.
    const repo = await localRepo('https://github.com/me/widgets.git')
    const { lookup } = lookupReturning()
    await expect(resolvePr({
      repoRoot: repo, input: 'https://github.com/acme/widgets/pull/7', lookup,
    })).rejects.toThrow(/--remote <name>/)
  })

  it('refuses a URL naming a different repository than the remote', async () => {
    // Pull-request numbers are per-repository: #7 of another project resolves
    // here to some unrelated pair of commits, and the run would look normal.
    const repo = await localRepo('https://github.com/acme/widgets.git')
    const { lookup, calls } = lookupReturning()
    await expect(resolvePr({
      repoRoot: repo, input: 'https://github.com/other/thing/pull/7', lookup,
    })).rejects.toThrow(/other\/thing.*acme\/widgets/s)
    expect(calls).toEqual([])
  })

  it('accepts a URL whose case differs from the remote', async () => {
    const repo = await localRepo('https://github.com/ACME/Widgets.git')
    const { lookup } = lookupReturning()
    await expect(resolvePr({
      repoRoot: repo, input: 'https://github.com/acme/widgets/pull/7', lookup,
    })).resolves.toMatchObject({ baseSha: upstream.forkPoint })
  })

  it('names the remote when there is no such remote', async () => {
    const repo = await localRepo()
    const { lookup } = lookupReturning()
    await expect(resolvePr({
      repoRoot: repo, input: 'https://github.com/acme/widgets/pull/7',
      remote: 'upstream', lookup,
    })).rejects.toThrow(/could not read remote 'upstream'/)
  })

  it('refuses a shallow clone rather than silently using the base branch tip', async () => {
    // A depth-1 clone reaches the pull request but not back to the fork point,
    // so merge-base finds nothing. Falling back to the tip would produce the
    // 408-element diff this feature exists to avoid, and it would look normal.
    const path = await scratch('arcdiff-pr-shallow-')
    const g = git(path)
    await g('init', '-q', '-b', 'main')
    await g('config', 'user.email', 't@t')
    await g('config', 'user.name', 'T')
    await g('remote', 'add', 'origin', upstream.path)
    await g('fetch', '-q', '--depth', '1', 'origin', 'main')

    const { lookup } = lookupReturning()
    await expect(resolvePr({
      repoRoot: path, input: 'https://github.com/acme/widgets/pull/7', lookup,
    })).rejects.toThrow(/no merge base.*unshallow/s)
  })

  it('reports the fetched head when the pull request moved under it', async () => {
    // The lookup and the fetch are two round trips; a push between them leaves
    // headRefOid stale. The fetched ref is what exists, so it wins — silently
    // reporting the stale one would disagree with the PR page.
    const repo = await localRepo()
    const { lookup } = lookupReturning({ headRefOid: upstream.forkPoint })
    const lines: string[] = []

    const { headSha } = await resolvePr({
      repoRoot: repo, input: 'https://github.com/acme/widgets/pull/7',
      lookup, onProgress: l => lines.push(l),
    })

    expect(headSha).toBe(upstream.prHead)
    expect(lines.some(l => l.includes('head moved during resolution'))).toBe(true)
  })

  it('says nothing about a moved head when nothing moved', async () => {
    const repo = await localRepo()
    const { lookup } = lookupReturning()
    const lines: string[] = []
    await resolvePr({
      repoRoot: repo, input: 'https://github.com/acme/widgets/pull/7',
      lookup, onProgress: l => lines.push(l),
    })
    expect(lines.some(l => l.includes('head moved'))).toBe(false)
    expect(lines.some(l => l.includes('#7 "Add a run method"'))).toBe(true)
  })

  it('reports the base branch a fetch could not reach', async () => {
    const repo = await localRepo()
    const { lookup } = lookupReturning({ baseRefName: 'no-such-branch' })
    await expect(resolvePr({
      repoRoot: repo, input: 'https://github.com/acme/widgets/pull/7', lookup,
    })).rejects.toThrow(/no-such-branch/)
  })
})
