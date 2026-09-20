import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { gitStdout, resolveRef } from './repo.js'

const run = promisify(execFile)

/** The owner and repository a pull request belongs to. */
export interface Project {
  owner: string
  repo: string
}

/** A pull request as the user spelled it, before anything is resolved. */
export interface PrRef {
  number: number
  /**
   * Set only when the input named it — a URL or `owner/repo#n`. One field
   * rather than two optional ones, because the two are never known apart:
   * separate optionals let the type describe a state that cannot occur and
   * force a non-null assertion at every use.
   */
  project?: Project
}

/** What a lookup has to return for `resolvePr` to do its job. */
export interface PrInfo {
  number: number
  title: string
  url: string
  /** 'OPEN' | 'CLOSED' | 'MERGED' as GitHub spells it. Reported, never acted on. */
  state: string
  baseRefName: string
  headRefOid: string
  isCrossRepository: boolean
}

export type PrLookup = (target: Project & { number: number }) => Promise<PrInfo>

const PULL_URL = /^https?:\/\/(?:[^@/]*@)?(?:www\.)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/
const OWNER_REPO_HASH = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)#(\d+)$/
const BARE_NUMBER = /^#?(\d+)$/

function prNumber(digits: string, input: string): number {
  const n = Number(digits)
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new Error(`arcdiff: '${input}' does not name a pull request (number must be 1 or more)`)
  }
  return n
}

/**
 * `123`, `#123`, `owner/repo#123`, or a full
 * `https://github.com/owner/repo/pull/123` URL — the last one also when it
 * carries the `/files`, `/commits` or `#discussion_r...` tail a browser
 * leaves on a copied address.
 *
 * Pure: it never touches git or the network, so every accepted and rejected
 * spelling is testable without a repo.
 */
export function parsePrRef(input: string): PrRef {
  const s = input.trim()

  if (/^https?:\/\//i.test(s)) {
    const m = PULL_URL.exec(s)
    if (m === null) {
      throw new Error(
        `arcdiff: '${s}' is not a GitHub pull-request URL. Expected ` +
        'https://github.com/<owner>/<repo>/pull/<number>.',
      )
    }
    const [, host, owner, repo, digits] = m
    if (host!.toLowerCase() !== 'github.com') {
      throw new Error(
        `arcdiff: --pr understands github.com only, but '${s}' is on '${host}'. ` +
        'Pass --base and --head instead.',
      )
    }
    return {
      number: prNumber(digits!, s),
      project: { owner: owner!, repo: repo!.replace(/\.git$/, '') },
    }
  }

  const short = OWNER_REPO_HASH.exec(s)
  if (short !== null) {
    return { number: prNumber(short[3]!, s), project: { owner: short[1]!, repo: short[2]! } }
  }

  const bare = BARE_NUMBER.exec(s)
  if (bare !== null) return { number: prNumber(bare[1]!, s) }

  throw new Error(
    `arcdiff: cannot read '${s}' as a pull request. Use a number (123), ` +
    'owner/repo#123, or https://github.com/<owner>/<repo>/pull/123.',
  )
}

/**
 * The owner and repo a remote URL points at, for every spelling git accepts:
 * `https://github.com/o/r.git`, `https://user@github.com/o/r`,
 * `git@github.com:o/r.git`, `ssh://git@github.com:22/o/r.git`, `git://...`.
 * Returns null rather than throwing, so the caller decides what an
 * unrecognisable remote means. The last two path segments are the pair —
 * a scheme URL may carry a port and userinfo, which are stripped.
 */
export function parseRemoteUrl(url: string): (Project & { host: string }) | null {
  const s = url.trim().replace(/\/+$/, '')
  let host: string
  let path: string

  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(s)
  if (scheme !== null) {
    const rest = s.slice(scheme[0].length)
    const slash = rest.indexOf('/')
    if (slash === -1) return null
    host = rest.slice(0, slash).replace(/^[^@]*@/, '').replace(/:\d+$/, '')
    path = rest.slice(slash + 1)
  } else {
    // scp-like `[user@]host:path`, which has no scheme and whose colon is a
    // separator rather than a port. Checked second because `https://o/r`
    // also matches this shape, with 'https' as the host.
    const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(s)
    if (scp === null) return null
    host = scp[1]!
    path = scp[2]!
  }

  // A host with no dot is not a network host, and the scp-like branch happily
  // reads a Windows path that way: `C:/repos/widgets` yields host 'C', owner
  // 'repos', repo 'widgets'. Refusing it here leaves the caller with "this
  // remote names no project", which is true, instead of a confident wrong pair.
  if (!host.includes('.') && host !== 'localhost') return null

  const parts = path.replace(/\.git$/, '').split('/').filter(p => p.length > 0)
  if (parts.length < 2) return null
  return { host, owner: parts[parts.length - 2]!, repo: parts[parts.length - 1]! }
}

const GH_FIELDS = 'number,title,url,state,baseRefName,headRefOid,isCrossRepository'

function ghError(e: unknown, target: string, number: number): Error {
  const err = e as NodeJS.ErrnoException & { stderr?: string }
  if (err.code === 'ENOENT') {
    return new Error(
      'arcdiff: --pr needs the GitHub CLI (`gh`) on PATH, authenticated with ' +
      '`gh auth login`. Install it, or pass --base and --head instead.',
    )
  }
  const detail = (err.stderr ?? err.message ?? '').trim()
  return new Error(`arcdiff: gh could not read ${target}#${number}: ${detail}`)
}

/**
 * The default lookup: `gh pr view`. `-R owner/repo` is always explicit —
 * left to guess from the working directory, gh fails on a repo with two
 * remotes because the disambiguating prompt has no terminal to run in.
 */
export const ghLookup: PrLookup = async ({ owner, repo, number }) => {
  const target = `${owner}/${repo}`
  let stdout: string
  try {
    ;({ stdout } = await run(
      'gh',
      ['pr', 'view', String(number), '-R', target, '--json', GH_FIELDS],
      { maxBuffer: 4 * 1024 * 1024 },
    ))
  } catch (e) {
    throw ghError(e, target, number)
  }
  return JSON.parse(stdout) as PrInfo
}

/** GitHub treats owner and repo case-insensitively; so must any comparison. */
function sameProject(a: Project, b: Project): boolean {
  return a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.repo.toLowerCase() === b.repo.toLowerCase()
}

export interface ResolvePrOptions {
  repoRoot: string
  /** Whatever the user passed to `--pr`. */
  input: string
  /** Remote to read owner/repo from and fetch from. Default 'origin'. */
  remote?: string
  /** Injected in tests; defaults to `ghLookup`. */
  lookup?: PrLookup
  /** One line of human-readable progress, already stripped of any prefix. */
  onProgress?: (line: string) => void
}

export interface ResolvedPr {
  /** The MERGE BASE, computed locally. Never the base branch tip — see below. */
  baseSha: string
  headSha: string
  pr: PrInfo
}

/**
 * `git config --get remote.<name>.url`, deliberately not `git remote get-url`:
 * the latter applies `url.<base>.insteadOf` rewriting, so a user who mirrors
 * github.com through an internal host or a local path would have us identify
 * the repository from the mirror's address instead of its own. The configured
 * URL is the one that names the project; the rewrite only decides what git
 * dials, and `git fetch` applies it either way.
 */
async function remoteUrlOf(repoRoot: string, remote: string): Promise<string> {
  try {
    return (await gitStdout(repoRoot, ['config', '--get', `remote.${remote}.url`])).trim()
  } catch {
    // `git config --get` exits 1 for a missing key and for a repoRoot that is
    // no repository at all, so both are named rather than guessing at one.
    throw new Error(
      `arcdiff: could not read remote '${remote}' from ${repoRoot} — either there ` +
      'is no such remote, or --repo does not point at a git repository. ' +
      'Pass --remote <name>, or pass --base and --head instead of --pr.',
    )
  }
}

/**
 * Turn one pull-request identifier into the two commits arcdiff diffs.
 *
 * Two decisions are load-bearing:
 *
 * The base is `git merge-base`, computed here, and NOT the `baseRefOid` the
 * API reports — that field is the base branch's CURRENT TIP, so a diff
 * against it carries every commit merged into the base since the PR forked,
 * with their direction inverted. Measured on pypa/pip#13535 (87 commits of
 * drift): against the tip, 83 source files changed with 6562 deletions;
 * against the merge base, 1 file and 15.
 *
 * The head comes from `refs/pull/<n>/head` on the base repository, not from
 * the contributor's branch. Most real pull requests are opened from a fork —
 * all three sampled on pypa/pip were — and that ref is the only one reachable
 * through the base repo's remote. It also survives the PR being merged or
 * closed and the fork being deleted.
 *
 * The fetch is the one side effect: it advances `refs/remotes/<remote>/<base>`
 * exactly as an ordinary `git fetch` would, and parks the PR head under
 * `refs/arcdiff/<remote>/pr/<n>`. That private namespace keeps the fetched
 * objects reachable — an unreferenced fetch leaves them only in FETCH_HEAD,
 * where a gc between the fetch and `git worktree add` can drop them — and
 * cannot collide with a remote-tracking ref for a branch actually named `pr`.
 */
export async function resolvePr(o: ResolvePrOptions): Promise<ResolvedPr> {
  const remote = o.remote ?? 'origin'
  const note = o.onProgress ?? (() => {})
  const ref = parsePrRef(o.input)

  const remoteUrl = await remoteUrlOf(o.repoRoot, remote)
  const local = parseRemoteUrl(remoteUrl)

  let project: Project
  if (ref.project !== undefined) {
    project = ref.project
    // Only a remote that names a project can contradict the URL. One spelled
    // as a filesystem path names none, so there is nothing to disagree with
    // and the URL simply stands.
    if (local !== null && !sameProject(local, project)) {
      throw new Error(
        `arcdiff: --pr names ${project.owner}/${project.repo} but the '${remote}' ` +
        `remote is ${local.owner}/${local.repo}. Point --repo at a clone of ` +
        `${project.owner}/${project.repo}: pull request numbers are per-repository, ` +
        'so resolving this one here would diff unrelated commits.',
      )
    }
  } else if (local === null) {
    throw new Error(
      `arcdiff: --pr ${ref.number} is a bare number, and the '${remote}' remote ` +
      `(${remoteUrl}) names no owner/repo to resolve it against. Pass the full ` +
      'https://github.com/<owner>/<repo>/pull/<number> URL instead.',
    )
  } else if (local.host.toLowerCase() !== 'github.com') {
    throw new Error(
      `arcdiff: --pr ${ref.number} is a bare number, but the '${remote}' remote is ` +
      `on '${local.host}', not github.com. --pr understands GitHub only.`,
    )
  } else {
    project = { owner: local.owner, repo: local.repo }
  }

  const pr = await (o.lookup ?? ghLookup)({ ...project, number: ref.number })

  note(`PR #${pr.number} "${pr.title}" (${pr.state.toLowerCase()}${pr.isCrossRepository ? ', from a fork' : ''})`)
  note(`fetching refs/pull/${pr.number}/head and ${pr.baseRefName} from ${remote}`)

  const headRef = `refs/arcdiff/${remote}/pr/${pr.number}`
  const baseRef = `refs/remotes/${remote}/${pr.baseRefName}`
  try {
    await gitStdout(o.repoRoot, [
      'fetch', '--no-tags', '--quiet', remote,
      `+refs/pull/${pr.number}/head:${headRef}`,
      `+refs/heads/${pr.baseRefName}:${baseRef}`,
    ])
  } catch (e) {
    const detail = ((e as { stderr?: string }).stderr ?? (e as Error).message).trim()
    throw new Error(
      `arcdiff: could not fetch pull request ${pr.number} or its base branch ` +
      `'${pr.baseRefName}' from '${remote}': ${detail}`,
    )
  }

  const headSha = await resolveRef(o.repoRoot, headRef)

  // merge-base exits non-zero when the two commits share no ancestor, which
  // here means the history needed to find one is not in this clone: a shallow
  // or single-branch clone reaches the pull request but not back to the fork
  // point. Falling back to the base branch tip is exactly the wrong answer, so
  // this refuses instead, naming the fix.
  let baseSha: string
  try {
    baseSha = (await gitStdout(o.repoRoot, ['merge-base', baseRef, headSha])).trim()
  } catch {
    throw new Error(
      `arcdiff: no merge base between '${pr.baseRefName}' and pull request ` +
      `${pr.number} in ${o.repoRoot}. A shallow or single-branch clone is the ` +
      'usual cause — run `git fetch --unshallow` and try again.',
    )
  }

  // The PR can take a new push between the lookup and the fetch. The fetched
  // ref is what actually exists, so it wins; saying so keeps the printed head
  // from silently disagreeing with the one on the PR page.
  if (headSha !== pr.headRefOid) {
    note(`head moved during resolution — using the fetched ${headSha.slice(0, 10)}`)
  }
  note(`base ${baseSha.slice(0, 10)} (merge-base with ${pr.baseRefName})`)
  note(`head ${headSha.slice(0, 10)}`)

  return { baseSha, headSha, pr }
}
