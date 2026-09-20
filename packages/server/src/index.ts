import { createServer as createHttpServer, type Server } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, relative, resolve as resolvePath } from 'node:path'
import { makeApiHandler, pipeOrFail, readDelta } from './handlers.js'

export interface ServerOptions {
  deltaPath: string
  /** Built viewer assets. Omit to run API-only, which is what tests do. */
  staticDir?: string
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then(s => s.isFile(), () => false)
}

export async function createServer(opts: ServerOptions): Promise<Server> {
  const doc = await readDelta(opts.deltaPath)

  // Known files come from BOTH models, not just head. A file deleted between
  // the two refs has no head entry, so a head-only set would 404 the one diff
  // a reviewer most wants to read.
  const fileSet = async (modelPath: string): Promise<string[]> => {
    const model = JSON.parse(await readFile(modelPath, 'utf8')) as { elements: { file: string }[] }
    return model.elements.map(e => e.file)
  }
  const knownFiles = new Set([
    ...await fileSet(doc.source.base.modelPath),
    ...await fileSet(doc.source.head.modelPath),
  ])
  const api = makeApiHandler(doc, knownFiles)

  return createHttpServer((req, res) => {
    void (async () => {
      try {
        if (await api(req, res)) return
        if (opts.staticDir === undefined) { res.writeHead(404); res.end(); return }
        const root = resolvePath(opts.staticDir)
        const url = new URL(req.url ?? '/', 'http://localhost')
        const requested = decodeURIComponent(url.pathname)
        const target = resolvePath(root, `.${requested === '/' ? '/index.html' : requested}`)
        // Containment by resolved path, not by string-stripping "../". Decode
        // first, or %2e%2e slips past a check done on the raw pathname.
        const outside = relative(root, target).startsWith('..')
        const exists = !outside && await isFile(target)
        // Fall back to index.html for client-side routing, but only if it's
        // actually there — packages/viewer/dist may not exist yet (built by a
        // later task). This stat check narrows the window but doesn't close
        // it (TOCTOU: the file can vanish between here and the read), which
        // is what pipeOrFail's error handler is for.
        const fallback = join(root, 'index.html')
        const file = exists ? target : await isFile(fallback) ? fallback : null
        if (file === null) { res.writeHead(404); res.end(); return }
        pipeOrFail(res, file, TYPES[extname(file)] ?? 'application/octet-stream')
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: (e as Error).message }))
      }
    })()
  })
}

export { resolveDiffPath, type DeltaDocument } from './handlers.js'
