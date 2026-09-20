import { describe, it, expect, afterEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { LspClient } from './client.js'

const FAKE = fileURLToPath(new URL('./fake-server.mjs', import.meta.url))
let client: LspClient | undefined
afterEach(async () => { await client?.stop(); client = undefined })

async function start() {
  client = await LspClient.start('node', [FAKE], 'file:///tmp/fake')
  return client
}

describe('LspClient', () => {
  it('completes initialize and exposes the capability map', async () => {
    const c = await start()
    expect(c.capabilities).toEqual({
      documentSymbol: true, definition: true, references: true,
      workspaceSymbol: true, callHierarchy: false,
    })
  })

  it('normalizes an object-valued provider to true', async () => {
    const c = await start()
    expect(c.capabilities.definition).toBe(true)
  })

  it('reports an absent provider as false rather than undefined', async () => {
    const c = await start()
    expect(c.capabilities.callHierarchy).toBe(false)
  })

  it('round-trips a request and its result', async () => {
    const c = await start()
    await expect(c.request('echo', { a: 1 })).resolves.toEqual({ a: 1 })
  })

  it('rejects when the server returns an error', async () => {
    const c = await start()
    await expect(c.request('boom', {})).rejects.toThrow('exploded')
  })

  it('matches responses to requests by id when they arrive out of order', async () => {
    const c = await start()
    const [slow, fast] = await Promise.all([
      c.request<string>('slow', {}),
      c.request<{ n: number }>('echo', { n: 2 }),
    ])
    expect(slow).toBe('late')
    expect(fast).toEqual({ n: 2 })
  })

  it('ignores server-initiated notifications', async () => {
    const c = await start()
    await new Promise(r => setTimeout(r, 20))
    await expect(c.request('echo', { ok: true })).resolves.toEqual({ ok: true })
  })

  it('handles two messages arriving in a single chunk', async () => {
    const c = await start()
    const results = await Promise.all([
      c.request('echo', { i: 1 }), c.request('echo', { i: 2 }), c.request('echo', { i: 3 }),
    ])
    expect(results).toEqual([{ i: 1 }, { i: 2 }, { i: 3 }])
  })

  it('stop() resolves and is safe to call twice', async () => {
    const c = await start()
    await c.stop()
    await expect(c.stop()).resolves.toBeUndefined()
    client = undefined
  })

  it('ignores a server-to-client request even when its id collides with a pending client request', async () => {
    const c = await start()
    await expect(c.request('serverRequest', {})).resolves.toBe('real')
  })

  it('rejects with a message naming the command when spawn fails', async () => {
    await expect(LspClient.start('this-command-does-not-exist-xyz', [], 'file:///tmp/x'))
      .rejects.toThrow(/this-command-does-not-exist-xyz/)
  })

  it('rejects a pending request when the server exits before responding', async () => {
    const c = await start()
    await expect(c.request('exitNow', {})).rejects.toThrow(/exit/i)
  }, 2000)
})
