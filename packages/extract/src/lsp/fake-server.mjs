// Minimal LSP server over stdio for client tests.
let buf = Buffer.alloc(0)
process.stdin.on('data', chunk => {
  buf = Buffer.concat([buf, chunk])
  for (;;) {
    const sep = buf.indexOf('\r\n\r\n')
    if (sep === -1) return
    const header = buf.subarray(0, sep).toString()
    const m = /content-length: (\d+)/i.exec(header)
    if (!m) return
    const len = Number(m[1])
    if (buf.length < sep + 4 + len) return
    const body = JSON.parse(buf.subarray(sep + 4, sep + 4 + len).toString())
    buf = buf.subarray(sep + 4 + len)
    handle(body)
  }
})
function send(msg) {
  const b = Buffer.from(JSON.stringify(msg))
  process.stdout.write(`Content-Length: ${b.length}\r\n\r\n`)
  process.stdout.write(b)
}
function handle(msg) {
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {
      documentSymbolProvider: true,
      definitionProvider: { workDoneProgress: true },
      referencesProvider: true,
      workspaceSymbolProvider: true,
      // callHierarchyProvider deliberately absent, like kotlin-language-server
    } } })
    return
  }
  if (msg.method === 'echo') { send({ jsonrpc: '2.0', id: msg.id, result: msg.params }); return }
  if (msg.method === 'boom') {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'exploded' } })
    return
  }
  if (msg.method === 'slow') {
    setTimeout(() => send({ jsonrpc: '2.0', id: msg.id, result: 'late' }), 30)
    return
  }
  if (msg.method === 'shutdown') { send({ jsonrpc: '2.0', id: msg.id, result: null }); return }
  if (msg.method === 'serverRequest') {
    // Simulate a server-to-client request whose id collides with this request's id
    // (both sides number their own requests from 1) before the real response arrives.
    send({ jsonrpc: '2.0', id: msg.id, method: 'client/registerCapability', params: {} })
    setTimeout(() => send({ jsonrpc: '2.0', id: msg.id, result: 'real' }), 10)
    return
  }
  if (msg.method === 'exitNow') { process.exit(7) }
}
// Emit an unsolicited notification to prove the client ignores non-responses.
setTimeout(() => send({ jsonrpc: '2.0', method: 'window/logMessage',
                        params: { type: 3, message: 'hello' } }), 5)
