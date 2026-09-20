import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { diffText } from '@arcdiff/git'

/**
 * The repo-relative path for a diff request. Validated against the model's own
 * file set rather than by string inspection: only a file arcdiff actually
 * extracted can be diffed, so no traversal can reach outside the subdir.
 */
export function resolveDiffPath(
  subdir: string, file: string, known: ReadonlySet<string>,
): string {
  if (!known.has(file)) throw new Error(`unknown file: ${file}`)
  return `${subdir}/${file}`
}

export interface DeltaDocument {
  delta: { base: string; head: string; elements: unknown[]; edges: unknown[] }
  signals: unknown[]
  source: {
    repoRoot: string
    subdir: string
    base: { ref: string; modelPath: string }
    head: { ref: string; modelPath: string }
    capabilities: unknown
  }
}

const json = (res: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(text)
}

/**
 * `createReadStream(path).pipe(res)` alone attaches no error listener to the
 * source, so a read failure (file deleted mid-run, permission change — a
 * stat-then-open check is a TOCTOU gap, not a guarantee) surfaces as an
 * unhandled 'error' event: an uncaught exception that kills the process, not
 * a failed request.
 *
 * The 200 header is written on the stream's 'open' event, not up front: a
 * failure that arrives before the fd is even obtained (the common ENOENT
 * case) must still be able to send a real 500, not a 200 whose body turns out
 * to be `{"error": ...}` instead of the promised content. 'open' fires once
 * the fd exists, strictly before any 'data'; on ENOENT it never fires and
 * 'error' does instead.
 */
export function pipeOrFail(res: ServerResponse, path: string, contentType: string): void {
  const stream = createReadStream(path)
  stream.on('open', () => { res.writeHead(200, { 'content-type': contentType }) })
  stream.on('error', () => {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'read failed' }))
  })
  // .pipe() does not destroy the source when the destination closes early, so
  // an aborted request would hold the fd until the whole file had been read —
  // and /api/model/:side streams ~7.3 MB on the real reference codebase.
  res.on('close', () => { if (!res.writableFinished) stream.destroy() })
  stream.pipe(res)
}

export function makeApiHandler(doc: DeltaDocument, knownFiles: ReadonlySet<string>) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://localhost')

    if (url.pathname === '/api/delta') { json(res, 200, doc); return true }

    if (url.pathname === '/api/model/base' || url.pathname === '/api/model/head') {
      const side = url.pathname.endsWith('base') ? doc.source.base : doc.source.head
      pipeOrFail(res, side.modelPath, 'application/json; charset=utf-8')
      return true
    }

    if (url.pathname === '/api/diff') {
      const file = url.searchParams.get('file')
      if (file === null) { json(res, 400, { error: 'missing file' }); return true }
      try {
        resolveDiffPath(doc.source.subdir, file, knownFiles)
      } catch {
        json(res, 404, { error: `unknown file: ${file}` })
        return true
      }
      // --relative takes the SUBDIR so emitted paths match element.file; the
      // file goes in the pathspec. Passing `subdir/file` to --relative makes
      // git emit `+++ b/` with an empty path — verified, see diffText's doc.
      const text = await diffText(
        doc.source.repoRoot, doc.source.base.ref, doc.source.head.ref,
        doc.source.subdir, 3, `${doc.source.subdir}/${file}`,
      )
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(text)
      return true
    }

    return false
  }
}

export async function readDelta(path: string): Promise<DeltaDocument> {
  return JSON.parse(await readFile(path, 'utf8')) as DeltaDocument
}
