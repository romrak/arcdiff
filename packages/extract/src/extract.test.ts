import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Element } from '@arcdiff/model'
import {
  buildDefIndex, extractModel, resolveBaseTarget,
  type ExtractClient, type LspLocation,
} from './extract.js'

function el(id: string, kind: Element['kind'], file: string, startLine: number): Element {
  return { id, kind, name: id.split('.').pop()!, parent: null,
           package: 'app', file, range: [startLine, startLine + 4], lang: 'python' }
}

const elements: Element[] = [
  el('app.m', 'module', 'app/m.py', 1),
  el('app.m.Base', 'class', 'app/m.py', 10),
  el('app.m.Outer', 'class', 'app/m.py', 20),
  el('app.m.Outer.Inner', 'class', 'app/m.py', 22),
  el('app.m.helper', 'function', 'app/m.py', 40),
  el('app.m.Base.run', 'method', 'app/m.py', 12),
]

const ROOTS = ['/repo']
const index = buildDefIndex(elements)
/** The files that were actually parsed into the model above. */
const ANALYSED = new Set(['app/m.py'])

/** A Location: uri + range. */
function loc(path: string, line0: number): LspLocation {
  return { uri: `file://${path}`, range: { start: { line: line0, character: 6 }, end: { line: line0, character: 20 } } }
}

describe('buildDefIndex', () => {
  it('indexes classes, functions and methods by file and start line', () => {
    expect(index.get('app/m.py:10')).toEqual({ id: 'app.m.Base', kind: 'class' })
    expect(index.get('app/m.py:40')).toEqual({ id: 'app.m.helper', kind: 'function' })
    expect(index.get('app/m.py:12')).toEqual({ id: 'app.m.Base.run', kind: 'method' })
  })

  it('does not index modules, which are not definition sites', () => {
    expect(index.get('app/m.py:1')).toBeUndefined()
  })
})

describe('resolveBaseTarget', () => {
  it('reports no-definition when the server returned nothing', () => {
    expect(resolveBaseTarget([], ROOTS, index, ANALYSED)).toEqual({ id: null, reason: 'no-definition' })
  })

  it('reports external for a target outside the analysis root', () => {
    expect(resolveBaseTarget([loc('/usr/lib/python3.14/abc.py', 9)], ROOTS, index, ANALYSED))
      .toEqual({ id: null, reason: 'external' })
  })

  it('does not treat a sibling directory sharing the root prefix as in-root', () => {
    expect(resolveBaseTarget([loc('/repo-other/app/m.py', 9)], ROOTS, index, ANALYSED))
      .toEqual({ id: null, reason: 'external' })
  })

  it('resolves an in-root definition line to its element id', () => {
    // LSP line is 0-based, element ranges are 1-based: line 9 is element line 10.
    expect(resolveBaseTarget([loc('/repo/app/m.py', 9)], ROOTS, index, ANALYSED))
      .toEqual({ id: 'app.m.Base', reason: 'resolved' })
  })

  it('resolves a base declared inside another class to its nested id', () => {
    expect(resolveBaseTarget([loc('/repo/app/m.py', 21)], ROOTS, index, ANALYSED))
      .toEqual({ id: 'app.m.Outer.Inner', reason: 'resolved' })
  })

  // pyright indexes the whole worktree, so a base defined in a file --exclude
  // kept out of the model still resolves IN-ROOT. Counting that as position
  // drift corrupts the one counter VALIDATION.md calls load-bearing.
  it('reports not-analysed for an in-root target in a file that was never parsed', () => {
    expect(resolveBaseTarget([loc('/repo/tests/helpers.py', 9)], ROOTS, index, ANALYSED))
      .toEqual({ id: null, reason: 'not-analysed' })
  })

  it('reports not-a-definition when the position is in-root but not a def start', () => {
    expect(resolveBaseTarget([loc('/repo/app/m.py', 30)], ROOTS, index, ANALYSED))
      .toEqual({ id: null, reason: 'not-a-definition' })
  })

  it('accepts a LocationLink and uses its selection range, not its full range', () => {
    // targetRange starts at the decorator; targetSelectionRange is the name token.
    const link: LspLocation = {
      targetUri: 'file:///repo/app/m.py',
      targetRange: { start: { line: 8, character: 0 }, end: { line: 14, character: 0 } },
      targetSelectionRange: { start: { line: 9, character: 6 }, end: { line: 9, character: 10 } },
    }
    expect(resolveBaseTarget([link], ROOTS, index, ANALYSED))
      .toEqual({ id: 'app.m.Base', reason: 'resolved' })
  })

  it('decodes a percent-escaped path', () => {
    const escaped: LspLocation = {
      uri: 'file:///repo/app/m.py'.replace('/app/', '/a%70p/'),
      range: { start: { line: 9, character: 6 }, end: { line: 9, character: 10 } },
    }
    expect(resolveBaseTarget([escaped], ROOTS, index, ANALYSED))
      .toEqual({ id: 'app.m.Base', reason: 'resolved' })
  })

  it('accepts several locations that agree on one id', () => {
    expect(resolveBaseTarget([loc('/repo/app/m.py', 9), loc('/repo/app/m.py', 9)], ROOTS, index, ANALYSED))
      .toEqual({ id: 'app.m.Base', reason: 'resolved' })
  })

  it('reports ambiguous when locations disagree', () => {
    expect(resolveBaseTarget([loc('/repo/app/m.py', 9), loc('/repo/app/m.py', 19)], ROOTS, index, ANALYSED))
      .toEqual({ id: null, reason: 'ambiguous' })
  })

  it('accepts a target under an unresolved alias of the root', () => {
    // The server echoes rootUri's spelling: a client started on /var/... reports
    // /var/... even though the root realpaths to /private/var/...
    expect(resolveBaseTarget([loc('/var/repo/app/m.py', 9)], ['/private/var/repo', '/var/repo'], index, ANALYSED))
      .toEqual({ id: 'app.m.Base', reason: 'resolved' })
  })

  it('reports not-a-type when the target is a definition but not a class', () => {
    // `class Foo(make_base())` lands on the factory's def; an extends edge into
    // a function is not a thing.
    expect(resolveBaseTarget([loc('/repo/app/m.py', 39)], ROOTS, index, ANALYSED))
      .toEqual({ id: null, reason: 'not-a-type' })
  })

  it('reports no-definition for a location carrying no range', () => {
    expect(resolveBaseTarget([{ uri: 'file:///repo/app/m.py' }], ROOTS, index, ANALYSED))
      .toEqual({ id: null, reason: 'no-definition' })
  })
})


// extractModel drives a structural slice of LspClient, so the whole resolution
// loop and every guard in it can be exercised without a live language server.
describe('extractModel', () => {
  let dir: string
  let realDir: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'arcdiff-extract-'))
    realDir = realpathSync(dir)
    await writeFile(join(dir, 'm.py'), 'class Base:\n    pass\n\n\nclass Impl(Base):\n    pass\n', 'utf8')
    // Two base sites, so one can fail while the run carries on.
    await writeFile(
      join(dir, 'two.py'),
      'class Base:\n    pass\n\n\nclass Impl(Base):\n    pass\n\n\nclass Second(Base):\n    pass\n',
      'utf8',
    )
    // A @property and its @x.setter share a qualname — the collision that made
    // adding a setter report a signature change on the getter.
    await writeFile(
      join(dir, 'prop.py'),
      'class Agent:\n'
      + '    @property\n'
      + '    def flag(self) -> bool:\n'
      + '        return self._f\n'
      + '\n'
      + '    @flag.setter\n'
      + '    def flag(self, value: bool) -> None:\n'
      + '        self._f = value\n',
      'utf8',
    )
    // Same name defined twice in the same scope: a genuine ambiguity with no
    // decorator to disambiguate it, so it must be refused rather than shadowed.
    await writeFile(
      join(dir, 'dup.py'),
      'def f() -> int:\n    return 1\n\n\ndef f() -> str:\n    return "x"\n',
      'utf8',
    )
  })

  afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

  const CAPS = {
    documentSymbol: false, definition: true, references: false,
    workspaceSymbol: false, callHierarchy: false,
  }

  function stub(answer: LspLocation[] | null): ExtractClient {
    return {
      capabilities: CAPS,
      terminated: false,
      didOpen: () => {},
      request: <T,>(method: string): Promise<T> =>
        Promise.resolve((method === 'textDocument/definition' ? answer : null) as T),
    }
  }

  /** `class Base:` is source line 1, so LSP line 0. Built from the REAL dir. */
  /** Answers definition requests in order; an Error entry is thrown, not returned. */
  function stubSeq(answers: (LspLocation[] | null | Error)[], terminated = false): ExtractClient {
    let n = 0
    return {
      capabilities: CAPS,
      terminated,
      didOpen: () => {},
      request: <T,>(method: string): Promise<T> => {
        if (method !== 'textDocument/definition') return Promise.resolve(null as T)
        const a = answers[n++]
        if (a instanceof Error) return Promise.reject(a)
        return Promise.resolve(a as T)
      },
    }
  }

  const inRoot = (file = 'm.py'): LspLocation => ({
    uri: pathToFileURL(join(realDir, file)).href,
    range: { start: { line: 0, character: 6 }, end: { line: 0, character: 10 } },
  })

  const external: LspLocation = {
    uri: 'file:///usr/lib/python3.14/abc.py',
    range: { start: { line: 8, character: 6 }, end: { line: 8, character: 9 } },
  }

  it('resolves an in-root base and labels it extends', async () => {
    const r = await extractModel({ root: dir, ref: 'abc', files: ['m.py'], client: stub([inRoot()]) })
    expect(r.basesAttempted).toBe(1)
    expect(r.basesResolved).toBe(1)
    expect(r.noBasesResolved).toBe(false)
    expect(r.filesParsed).toBe(1)
    expect(r.failures).toEqual([])
    expect(r.model.edges).toContainEqual({ from: 'm.Impl', to: 'm.Base', kind: 'extends' })
  })

  it('throws when every base resolved outside the root', async () => {
    await expect(extractModel({ root: dir, ref: 'abc', files: ['m.py'], client: stub([external]) }))
      .rejects.toThrow(/0 of 1 base classes resolved/)
  })

  it('downgrades that to a flag when allowNoResolvedBases is set', async () => {
    const r = await extractModel({
      root: dir, ref: 'abc', files: ['m.py'], client: stub([external]),
      allowNoResolvedBases: true,
    })
    expect(r.noBasesResolved).toBe(true)
    expect(r.basesExternal).toBe(1)
    expect(r.model.edges.some(e => e.kind === 'extends')).toBe(false)
  })

  it('throws when the server returns no location at all', async () => {
    await expect(extractModel({ root: dir, ref: 'abc', files: ['m.py'], client: stub(null) }))
      .rejects.toThrow(/returned no location/)
  })

  it('counts a failed definition request and keeps going', async () => {
    const r = await extractModel({
      root: dir, ref: 'abc', files: ['two.py'],
      client: stubSeq([new Error('InvalidParams: position out of range'), [inRoot('two.py')]]),
    })
    expect(r.basesAttempted).toBe(2)
    expect(r.basesRequestFailed).toBe(1)
    expect(r.basesResolved).toBe(1)
    expect(r.model.edges).toContainEqual({ from: 'two.Second', to: 'two.Base', kind: 'extends' })
  })

  it('does not abort on an answer carrying an unusable uri', async () => {
    const bad: LspLocation = {
      uri: ':://not a uri',
      range: { start: { line: 0, character: 6 }, end: { line: 0, character: 10 } },
    }
    const r = await extractModel({
      root: dir, ref: 'abc', files: ['two.py'],
      client: stubSeq([[bad], [inRoot('two.py')]]),
    })
    expect(r.basesRequestFailed).toBe(1)
    expect(r.basesResolved).toBe(1)
  })

  it('gives a property getter and its setter distinct ids', async () => {
    const r = await extractModel({ root: dir, ref: 'abc', files: ['prop.py'], client: stub(null) })
    const ids = r.model.elements.map(e => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('prop.Agent.flag')
    expect(ids).toContain('prop.Agent.flag.setter')
  })

  it('refuses a model whose element ids are not unique, naming the offenders', async () => {
    await expect(extractModel({ root: dir, ref: 'abc', files: ['dup.py'], client: stub(null) }))
      .rejects.toThrow(/element id\(s\) are not unique[\s\S]*dup\.f[\s\S]*dup\.py:1-2[\s\S]*dup\.py:5-6/)
  })

  // @typing.overload stacks and if TYPE_CHECKING redefinitions hard-fail this
  // assertion by design, so for those users this message IS the documentation.
  // It has to carry the likely cause and a way forward, not just the mechanism.
  it('names the likely cause and a remedy, not only the mechanism', async () => {
    const err = await extractModel({
      root: dir, ref: 'abc', files: ['dup.py'], client: stub(null),
    }).then(() => null, (e: Error) => e)
    const message = err?.message ?? ''
    expect(message).toMatch(/@typing\.overload/)
    expect(message).toMatch(/TYPE_CHECKING/)
    expect(message).toMatch(/--exclude/)
    expect(message).toMatch(/known gap/)
    // The remedy is not free, and saying so is the point.
    expect(message).toMatch(/absent from the model/)
  })

  it('records WHY a file failed to parse, not just that it did', async () => {
    await writeFile(join(dir, 'broken.py'), 'def f(:\n    pass\n', 'utf8')
    const r = await extractModel({ root: dir, ref: 'abc', files: ['broken.py'], client: stub(null) })
    expect(r.filesFailed).toBe(1)
    expect(r.failures).toHaveLength(1)
    expect(r.failures[0]?.file).toBe('broken.py')
    expect(r.failures[0]?.reason).toMatch(/syntax error/)
  })

  it('reports the capabilities the server actually advertised', async () => {
    const r = await extractModel({ root: dir, ref: 'abc', files: ['m.py'], client: stub([inRoot()]) })
    expect(r.capabilities).toEqual(CAPS)
  })

  it('rethrows a request failure when the client reports it is terminated', async () => {
    await expect(extractModel({
      root: dir, ref: 'abc', files: ['two.py'],
      client: stubSeq([new Error('pyright-langserver exited (code=1) while pending')], true),
    })).rejects.toThrow(/exited \(code=1\)/)
  })
})
