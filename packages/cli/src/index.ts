#!/usr/bin/env node
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolvePr } from '@arcdiff/git'
import {
  formatStats, runDiff, runExtract, runServe, selectRefs,
  type PullRequestInfo,
} from './run.js'

function flag(argv: string[], name: string, fallback?: string): string {
  const i = argv.indexOf(`--${name}`)
  if (i !== -1 && argv[i + 1] !== undefined) return argv[i + 1]!
  if (fallback !== undefined) return fallback
  throw new Error(`missing required --${name}`)
}

/** The value of `--name <value>`, or undefined when the flag is absent. */
function optional(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`)
  return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1]! : undefined
}

/** Every value passed to a repeatable `--name <value>` flag, in argv order. */
function flags(argv: string[], name: string): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}` && argv[i + 1] !== undefined) out.push(argv[i + 1]!)
  }
  return out
}

function has(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`)
}

const USAGE =
  'usage:\n' +
  '  arcdiff extract --repo <path> --subdir <path> [--ref HEAD] [--python python3]\n' +
  '    [--cache <dir>] [--venv-host <dir>] [--lsp pyright-langserver]\n' +
  '    [--exclude <glob>]... [--allow-parse-failures] [--allow-no-resolved-bases]\n' +
  '  arcdiff diff --repo <path> --subdir <path> (--base <ref> [--head HEAD] | --pr <id>)\n' +
  '    [--remote origin] [--out delta.json]\n' +
  '    [--python python3] [--cache <dir>] [--venv-host <dir>] [--lsp pyright-langserver]\n' +
  '    [--exclude <glob>]... [--allow-parse-failures] [--allow-no-resolved-bases]\n' +
  '  arcdiff serve --repo <path> --subdir <path> (--base <ref> [--head HEAD] | --pr <id>)\n' +
  '    [--port 5173] [--no-open] [--static <dir>] [plus every flag `diff` takes]\n' +
  '\n' +
  '  --pr <id>         A GitHub pull request, instead of --base/--head: 123,\n' +
  '                    #123, owner/repo#123, or the full\n' +
  '                    https://github.com/owner/repo/pull/123 URL. Base is the\n' +
  '                    MERGE BASE, not the base branch tip. Fetches\n' +
  '                    refs/pull/<n>/head from --remote. Needs the `gh` CLI.\n' +
  '  --remote <name>   Remote to identify the repository by and fetch from.\n' +
  '                    Default origin. Only read when --pr is given.\n' +
  '  --exclude <glob>  Repeatable. Matched against subdir-relative .py paths\n' +
  '                    when LISTING files, so excluded paths never enter the\n' +
  "                    model. Common case: --exclude 'tests/**'\n"

/**
 * `--base`/`--head`, or the pair a `--pr` resolves to. Progress goes to
 * stderr as it happens rather than being collected and printed at the end:
 * the fetch it reports can take several seconds on a cold clone, and silence
 * there reads as a hang.
 */
async function resolveRefPair(repoRoot: string, argv: string[]): Promise<{
  base: string
  head: string
  pullRequest?: PullRequestInfo
}> {
  const selection = selectRefs({
    pr: optional(argv, 'pr'),
    base: optional(argv, 'base'),
    head: optional(argv, 'head'),
  })
  if (selection.kind === 'refs') return { base: selection.base, head: selection.head }

  const { baseSha, headSha, pr } = await resolvePr({
    repoRoot,
    input: selection.input,
    remote: optional(argv, 'remote'),
    onProgress: line => process.stderr.write(`arcdiff: ${line}\n`),
  })
  return {
    base: baseSha,
    head: headSha,
    pullRequest: { number: pr.number, title: pr.title, url: pr.url },
  }
}

async function main(): Promise<void> {
  const [cmd, ...argv] = process.argv.slice(2)

  // Checked before any flag() call: flag() throws on a missing required
  // flag, which used to make bare `arcdiff` (or any unknown subcommand) fail
  // with "missing required --repo" instead of printing usage.
  if (cmd !== 'extract' && cmd !== 'diff' && cmd !== 'serve') {
    process.stderr.write(USAGE)
    process.exit(1)
  }

  const repoRoot = resolve(flag(argv, 'repo'))
  const subdir = flag(argv, 'subdir')
  const cacheDir = resolve(flag(argv, 'cache', join(repoRoot, '.arcdiff-cache')))
  const venvHostDir = resolve(flag(argv, 'venv-host', join(repoRoot, subdir)))
  const lspCmd = flag(argv, 'lsp', 'pyright-langserver')
  const lspArgs = ['--stdio']
  const python = flag(argv, 'python', 'python3')
  const excludeGlobs = flags(argv, 'exclude')
  const allowParseFailures = has(argv, 'allow-parse-failures')
  const allowNoResolvedBases = has(argv, 'allow-no-resolved-bases')
  const common = {
    repoRoot, subdir, cacheDir, lspCmd, lspArgs, venvHostDir, python, excludeGlobs,
    allowParseFailures, allowNoResolvedBases,
  }

  if (cmd === 'extract') {
    const result = await runExtract({ ...common, ref: flag(argv, 'ref', 'HEAD') })
    process.stderr.write(`arcdiff: cache ${result.cached ? 'HIT' : 'MISS'}\n`)
    process.stderr.write(formatStats(result.stats))
    process.stdout.write(`${result.path}\n`)
    return
  }

  // diff and serve share this. Resolution happens here rather than inside
  // runDiff because runDiff's contract is a pair of refs, not a pile of
  // flags — it has no business knowing a pull request exists.
  const refs = await resolveRefPair(repoRoot, argv)

  if (cmd === 'serve') {
    // fileURLToPath, not import.meta.dirname — the latter needs Node >= 20.11
    // while package.json only requires >= 20.
    const here = fileURLToPath(new URL('.', import.meta.url))
    const staticDir = flag(argv, 'static', join(here, '..', '..', 'viewer', 'dist'))
    const { port } = await runServe({
      ...common,
      ...refs,
      outPath: join(cacheDir, 'delta.json'),
      port: Number(flag(argv, 'port', '5173')),
      staticDir,
    })
    process.stdout.write(`arcdiff: http://localhost:${port}\n`)
    if (!has(argv, 'no-open')) {
      const opener = process.platform === 'darwin' ? 'open'
        : process.platform === 'win32' ? 'start' : 'xdg-open'
      const { spawn } = await import('node:child_process')
      spawn(opener, [`http://localhost:${port}`], { stdio: 'ignore', detached: true }).unref()
    }
    return   // keep the process alive; the server holds the event loop open
  }

  const result = await runDiff({
    ...common,
    ...refs,
    outPath: resolve(flag(argv, 'out', 'delta.json')),
  })
  process.stderr.write(`arcdiff: [base] cache ${result.baseCached ? 'HIT' : 'MISS'}\n`)
  process.stderr.write(formatStats(result.baseStats, 'base'))
  process.stderr.write(`arcdiff: [head] cache ${result.headCached ? 'HIT' : 'MISS'}\n`)
  process.stderr.write(formatStats(result.headStats, 'head'))
  process.stdout.write(`${result.deltaPath}\n${result.signalCount} signals\n`)
}

main().catch((e: Error) => { process.stderr.write(`${e.message}\n`); process.exit(1) })
