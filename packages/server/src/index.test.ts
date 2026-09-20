import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from './index.js'

/** A delta.json + model.json pair minimal enough for createServer to load. */
async function buildFixture(): Promise<{ dir: string; modelPath: string; deltaPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'arcdiff-server-test-'))
  const modelPath = join(dir, 'model.json')
  await writeFile(
    modelPath,
    JSON.stringify({ ref: 'x', extractedAt: '', elements: [], edges: [] }),
    'utf8',
  )
  const deltaPath = join(dir, 'delta.json')
  await writeFile(
    deltaPath,
    JSON.stringify({
      delta: { base: 'b', head: 'h', elements: [], edges: [] },
      signals: [],
      source: {
        repoRoot: dir,
        subdir: 'app',
        base: { ref: 'b', modelPath },
        head: { ref: 'h', modelPath },
        capabilities: null,
      },
    }),
    'utf8',
  )
  return { dir, modelPath, deltaPath }
}

async function listen(server: Server): Promise<number> {
  return new Promise<number>(resolve => {
    server.listen(0, () => {
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : 0)
    })
  })
}

async function close(server: Server): Promise<void> {
  await new Promise<void>(resolve => server.close(() => { resolve() }))
}

describe('createServer with a missing staticDir', () => {
  let dir: string | undefined

  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  })

  /**
   * The original static-file fallback fell through to
   * `createReadStream(join(root, 'index.html')).pipe(res)` unconditionally when
   * neither the requested file nor index.html existed — the exact state
   * `packages/viewer/dist` is in before Task 12 builds it. `.pipe()` attaches
   * no error listener to the source, so the ENOENT surfaced as an unhandled
   * 'error' event: an uncaught exception that kills the process, not a 404. A
   * test asserting only the first response's status code would pass against
   * that broken version too (a crash mid-response can still look like a 404
   * to the first fetch) — the actual regression check is that the SECOND
   * request still gets answered.
   */
  it('answers 404 for / without crashing, and stays alive for the next request', async () => {
    const fixture = await buildFixture()
    dir = fixture.dir

    const server = await createServer({
      deltaPath: fixture.deltaPath,
      staticDir: join(dir, 'nonexistent-viewer-dist'),
    })
    const port = await listen(server)
    try {
      const first = await fetch(`http://localhost:${port}/`)
      expect(first.status).toBe(404)

      // The actual point: the process must still be up to answer this.
      const second = await fetch(`http://localhost:${port}/api/delta`)
      expect(second.status).toBe(200)
    } finally {
      await close(server)
    }
  })
})

describe('createServer when a model file disappears after startup', () => {
  let dir: string | undefined

  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  })

  /**
   * `createServer` reads both model files once, up front, to build
   * `knownFiles` — so a cache directory cleared mid-run is a real scenario,
   * not a hypothetical: the file exists at startup and is gone by the time a
   * later `/api/model/*` request tries to stream it. This is the TOCTOU gap a
   * stat-then-open check can't close, which is what `pipeOrFail`'s stream
   * error handler is for. Deleting only after `createServer` resolves (i.e.
   * after the startup read) is what makes this exercise the read failure
   * specifically, not the startup read.
   */
  it('answers 500 for the missing side and stays alive for the next request', async () => {
    const fixture = await buildFixture()
    dir = fixture.dir

    const server = await createServer({ deltaPath: fixture.deltaPath })
    await unlink(fixture.modelPath)
    const port = await listen(server)
    try {
      const res = await fetch(`http://localhost:${port}/api/model/base`)
      expect(res.status).toBe(500)
      // A 500 whose body is well-formed JSON, not a 200 with the error text
      // masquerading as the promised model — the point of deferring writeHead
      // to the stream's 'open' event.
      expect(await res.json()).toEqual({ error: 'read failed' })

      const second = await fetch(`http://localhost:${port}/api/delta`)
      expect(second.status).toBe(200)
    } finally {
      await close(server)
    }
  })
})
