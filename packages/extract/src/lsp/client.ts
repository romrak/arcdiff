import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'

/** spawn(..., { stdio: ['pipe', 'pipe', 'ignore'] }) yields this shape. */
type LspProcess = ChildProcessByStdio<Writable, Readable, null>

export interface LspCapabilities {
  documentSymbol: boolean
  definition: boolean
  references: boolean
  workspaceSymbol: boolean
  callHierarchy: boolean
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}

/** A provider capability may be `true` or an options object; both mean supported. */
function supported(v: unknown): boolean {
  return v === true || (typeof v === 'object' && v !== null)
}

export class LspClient {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private buf = Buffer.alloc(0)
  private stopped = false
  private terminationError: Error | undefined

  private constructor(
    private readonly proc: LspProcess,
    public readonly capabilities: LspCapabilities,
  ) {}

  static async start(cmd: string, args: string[], rootUri: string): Promise<LspClient> {
    const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'] })
    // Build the instance first so its reader is attached before initialize replies.
    const self = new LspClient(proc, {
      documentSymbol: false, definition: false, references: false,
      workspaceSymbol: false, callHierarchy: false,
    })
    proc.stdout.on('data', (c: Buffer) => self.onData(c))
    // Without these, a spawn failure (e.g. ENOENT) crashes the process instead of
    // rejecting, and a server that dies mid-session leaves every pending request hanging.
    proc.on('error', (err) => {
      self.failAllPending(new Error(`failed to start ${cmd}: ${err.message}`))
    })
    proc.on('exit', (code, signal) => {
      self.failAllPending(
        new Error(`${cmd} exited (code=${code}, signal=${signal}) while requests were pending`),
      )
    })

    const result = await self.request<{ capabilities: Record<string, unknown> }>(
      'initialize',
      {
        processId: process.pid,
        rootUri,
        capabilities: {},
        workspaceFolders: [{ uri: rootUri, name: 'root' }],
      },
    )
    const c = result.capabilities
    const caps: LspCapabilities = {
      documentSymbol: supported(c['documentSymbolProvider']),
      definition: supported(c['definitionProvider']),
      references: supported(c['referencesProvider']),
      workspaceSymbol: supported(c['workspaceSymbolProvider']),
      callHierarchy: supported(c['callHierarchyProvider']),
    }
    Object.assign(self.capabilities, caps)
    self.notify('initialized', {})
    return self
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk])
    for (;;) {
      const sep = this.buf.indexOf('\r\n\r\n')
      if (sep === -1) return
      const header = this.buf.subarray(0, sep).toString('ascii')
      const m = /content-length: *(\d+)/i.exec(header)
      if (!m) { this.buf = this.buf.subarray(sep + 4); continue }
      const len = Number(m[1])
      if (this.buf.length < sep + 4 + len) return
      const body = this.buf.subarray(sep + 4, sep + 4 + len).toString('utf8')
      this.buf = this.buf.subarray(sep + 4 + len)
      this.dispatch(body)
    }
  }

  private dispatch(body: string): void {
    let msg: { id?: number; method?: string; result?: unknown; error?: { message: string } }
    try { msg = JSON.parse(body) } catch { return }
    // A server-to-client request (e.g. client/registerCapability) also carries a numeric
    // id — from the server's own counter, which can collide with ours — plus a method.
    // Only a message without a method is a response to one of our requests.
    if (typeof msg.method === 'string') return
    if (typeof msg.id !== 'number') return
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    if (msg.error) p.reject(new Error(msg.error.message))
    else p.resolve(msg.result)
  }

  /**
   * True once the server process is unusable — set by a spawn error or an exit,
   * never by an error RESPONSE. Lets a caller tell a request that failed on its
   * own merits (one bad position) from one that failed because there is no
   * longer a server, and so whether retrying the next request is pointless.
   */
  get terminated(): boolean {
    return this.terminationError !== undefined
  }

  /** Fails every in-flight request once the server process is unusable (spawn error or exit). */
  private failAllPending(err: Error): void {
    if (this.terminationError) return
    this.terminationError = err
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
  }

  private write(msg: unknown): void {
    const b = Buffer.from(JSON.stringify(msg), 'utf8')
    this.proc.stdin.write(`Content-Length: ${b.length}\r\n\r\n`)
    this.proc.stdin.write(b)
  }

  request<T>(method: string, params: unknown): Promise<T> {
    if (this.terminationError) return Promise.reject(this.terminationError)
    const id = this.nextId++
    const p = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    })
    this.write({ jsonrpc: '2.0', id, method, params })
    return p
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  didOpen(uri: string, languageId: string, text: string): void {
    this.notify('textDocument/didOpen', {
      textDocument: { uri, languageId, version: 1, text },
    })
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    try { await this.request('shutdown', null) } catch { /* server may already be gone */ }
    this.proc.kill()
  }
}
