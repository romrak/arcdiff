import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig } from '@playwright/test'

/**
 * This suite drives the viewer against a REAL extraction, not the committed
 * fixture — there is nothing else to point `arcdiff serve` at — so it needs a
 * checkout of the reference codebase on disk. That is pip, the same repo and
 * ref pair `packages/cli/src/e2e.test.ts` uses and the same pair the
 * `packages/view-model` fixtures were pruned from.
 *
 *   git clone https://github.com/pypa/pip ~/src/pip
 *   ARCDIFF_REF_REPO=~/src/pip npx playwright test
 *
 * pip needs no virtualenv: it vendors its dependencies, so pyright resolves
 * the whole tree from the checkout alone.
 */
const REF_REPO = process.env.ARCDIFF_REF_REPO ?? ''
const REF_SUBDIR = process.env.ARCDIFF_REF_SUBDIR ?? 'src'

/**
 * Checked here, synchronously, so a missing checkout fails the run
 * immediately with a named cause instead of a `webServer` timeout that reads
 * as a viewer defect rather than an absent reference repo.
 */
if (REF_REPO === '' || !existsSync(join(REF_REPO, REF_SUBDIR))) {
  throw new Error(
    'arcdiff viewer e2e: set ARCDIFF_REF_REPO to a checkout of https://github.com/pypa/pip. ' +
    `Looked for ${REF_REPO === '' ? '<unset>' : join(REF_REPO, REF_SUBDIR)}. ` +
    'This suite runs the real extractor and has no fixture of its own to fall back to.',
  )
}

/**
 * A single pip commit — 790ae56bb, "Add a --only-deps flag for pip install et
 * al." — 35 changed elements across 10 files.
 *
 * NOTE: this is deliberately NOT the wider pair the packages/view-model
 * fixtures were pruned from. That pair puts 83 boxes on the canvas, and at the
 * zoom level fitView then picks, a member row is under a pixel tall — a click
 * aimed at one row lands on its neighbour. That is a real limitation of the
 * canvas at codebase scale (see README, "Known limitations"), not something to
 * paper over with forced clicks that bypass hit-testing, so this suite drives
 * a delta of the size the viewer is actually usable at.
 *
 * `--exclude pip/_vendor/**` keeps pip's vendored dependencies out of the
 * model; `--exclude pip/_internal/main.py` works around a real limitation —
 * `pip._internal.main` is both a module and a function in `__init__.py`, and
 * an element id cannot currently distinguish the two.
 *
 * `--cache` points at a scratch directory, NOT a committed one. It is only a
 * convenience so a machine that already extracted this pair skips redoing it,
 * and it is not durable: `/tmp` can be cleared, and the first run afterwards
 * pays the full cold-extraction cost, which without the generous
 * `webServer.timeout` below reads as a hang rather than a cache miss.
 */
const SERVE_ARGS = [
  '--repo', REF_REPO,
  '--subdir', REF_SUBDIR,
  '--base', '790ae56bb^',
  '--head', '790ae56bb',
  '--python', 'python3.14',
  '--exclude', "'pip/_vendor/**'",
  '--exclude', "'pip/_internal/main.py'",
  '--cache', '/tmp/arcdiff-e2e-cache',
  '--port', '5174',
  '--no-open',
].join(' ')

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: 'http://localhost:5174',
  },
  webServer: {
    // The build has to run first: `--static packages/viewer/dist` serves
    // whatever is already there, stale or missing, and an empty dist reads
    // as a viewer bug rather than a missing build step.
    command:
      'NODE_OPTIONS= npm --workspace @arcdiff/viewer run build && ' +
      `NODE_OPTIONS= node ../cli/dist/index.js serve ${SERVE_ARGS}`,
    url: 'http://localhost:5174/',
    reuseExistingServer: !process.env.CI,
    // First run against a cold cache extracts both refs. The local cache
    // (see above — not committed, not durable) should make this fast on a
    // repeat run, but the timeout stays generous for one that has to
    // rebuild it.
    timeout: 180_000,
  },
})
