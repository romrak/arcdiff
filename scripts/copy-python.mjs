// Runs as the root "postbuild" script, right after `tsc -b`.
//
// `tsc` only ever emits from `.ts` sources — it does not copy non-TS assets.
// `packages/extract/src/python/parse.ts` resolves `parse.py` relative to its
// own compiled module's URL (see parse.ts), so the built CLI needs a real
// copy of `parse.py` sitting next to the built `parse.js`, not just the one
// under `src/`. The fixtures under `src/python/fixtures/` are test-only and
// are deliberately NOT copied — nothing under `dist/` reads them.
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const src = join(repoRoot, 'packages/extract/src/python/parse.py')
const destDir = join(repoRoot, 'packages/extract/dist/python')
const dest = join(destDir, 'parse.py')

mkdirSync(destDir, { recursive: true })
copyFileSync(src, dest)
process.stdout.write(`copy-python: ${src} -> ${dest}\n`)

// tsc does not preserve or set executable bits, so the linked `arcdiff`
// binary comes out of every build unrunnable despite having a shebang.
const bin = new URL('../packages/cli/dist/index.js', import.meta.url)
chmodSync(bin, 0o755)
