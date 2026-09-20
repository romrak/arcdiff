import { describe, expect, it } from 'vitest'
import { resolveDiffPath } from './handlers.js'

describe('resolveDiffPath', () => {
  const known = new Set(['app/a.py', 'app/b.py'])

  it('joins subdir and file for a known path', () => {
    expect(resolveDiffPath('services/web-api', 'app/a.py', known))
      .toBe('services/web-api/app/a.py')
  })

  it('rejects a path the model does not know', () => {
    expect(() => resolveDiffPath('services/web-api', 'app/c.py', known))
      .toThrow(/unknown file/)
  })

  it('rejects traversal even when it would resolve inside the repo', () => {
    expect(() => resolveDiffPath('services/web-api', '../../etc/passwd', known))
      .toThrow(/unknown file/)
  })
})

// A file deleted between base and head has no head-model entry. `knownFiles`
// unions both models specifically so that this file is still diffable — a
// head-only allow-list would 404 exactly the diff a reviewer most wants.
describe('resolveDiffPath with a base-only (deleted) file', () => {
  it('accepts a file present only in the base model set', () => {
    const known = new Set(['app/a.py', 'app/removed.py'])
    expect(resolveDiffPath('services/web-api', 'app/removed.py', known))
      .toBe('services/web-api/app/removed.py')
  })
})
