import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

/**
 * A source file once shipped in this repo with a raw NUL byte in it. Git
 * classified the whole file as binary, which made it vanish from
 * `git diff`, `git blame`, review tooling, and even `git log -S` — a defect
 * that can hide silently for a long time. `git rev-parse --show-toplevel`
 * anchors this at the real repo root rather than trusting the test runner's
 * cwd, and `*.mjs` is included alongside the brief's original extensions
 * because this task itself added one (scripts/copy-python.mjs) plus the
 * pre-existing packages/extract/src/lsp/fake-server.mjs.
 */
describe('repo hygiene', () => {
  it('contains no NUL bytes in tracked source files', () => {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
    const files = execFileSync(
      'git',
      ['-C', root, 'ls-files', '*.ts', '*.py', '*.json', '*.md', '*.mjs'],
      { encoding: 'utf8' },
    ).split('\n').filter(Boolean)
    const offenders = files.filter(f => readFileSync(join(root, f)).includes(0x00))
    expect(offenders).toEqual([])
  })
})
