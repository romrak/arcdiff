import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

/**
 * `tsc` does not copy non-TS assets, and `parsePythonFile` (parse.ts)
 * resolves `parse.py` relative to its own compiled module's URL — so a build
 * that emits `parse.js` into `dist/python/` without also copying `parse.py`
 * alongside it ships a CLI that runs fine in every test (which imports the
 * source directly) and then dies with a missing-file error the moment a
 * real, installed `arcdiff` actually tries to parse a file.
 *
 * Skipped — loudly, not silently — when `dist/python/parse.js` itself is
 * absent, i.e. before any build has run, so `vitest run` on a fresh checkout
 * (or before `npm run build`) stays green. Once a build HAS produced
 * `parse.js`, a missing `parse.py` next to it is a real regression and this
 * must fail, not skip.
 */
const here = dirname(fileURLToPath(import.meta.url))
const distDir = join(here, '..', '..', 'dist', 'python')
const distParseJs = join(distDir, 'parse.js')
const distParsePy = join(distDir, 'parse.py')

const built = existsSync(distParseJs)
if (!built) {
  process.stderr.write(
    '\n*** arcdiff: SKIPPING the parse.py build-output check ***\n' +
    `  - ${distParseJs} does not exist (no build output — run \`npm run build\` first)\n`,
  )
}

describe('build output', () => {
  it.skipIf(!built)(
    `copies parse.py alongside the built parse.js${built ? '' : ' [SKIPPED: not built]'}`,
    () => {
      expect(existsSync(distParsePy)).toBe(true)
    },
  )
})
