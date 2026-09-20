import { describe, it, expect, beforeAll } from 'vitest'
import { fileURLToPath } from 'node:url'
import { parsePythonFile, pythonVersion, type ParsedFile } from './parse.js'

const FIXTURE = fileURLToPath(new URL('./fixtures/sample.py', import.meta.url))
const SIGNATURES_FIXTURE = fileURLToPath(new URL('./fixtures/signatures.py', import.meta.url))
let parsed: ParsedFile
beforeAll(async () => { parsed = await parsePythonFile(FIXTURE) })

const def = (q: string) => parsed.defs.find(d => d.qualname === q)

const interpreterAvailable = async (python: string) => {
  try {
    await pythonVersion(python)
    return true
  } catch {
    return false
  }
}
// Resolved at collection time (top-level await) so `it.skipIf` below sees a
// real boolean rather than a promise.
const HAS_PY314 = await interpreterAvailable('python3.14')
const HAS_PY311 = await interpreterAvailable('python3.11')

describe('parsePythonFile', () => {
  it('finds top-level classes and functions', () => {
    expect(def('Greeter')?.type).toBe('class')
    expect(def('top_level')?.type).toBe('function')
  })

  it('qualifies methods under their class', () => {
    expect(def('Greeter.hello')?.type).toBe('function')
  })

  it('qualifies a nested class under its outer class', () => {
    expect(def('LoudGreeter.Inner')?.type).toBe('class')
  })

  it('records base-class text', () => {
    expect(def('LoudGreeter')?.bases.map(b => b.text)).toEqual(['Greeter', 'thing.Mixin'])
  })

  it('gives base positions in 0-based LSP coordinates', () => {
    const b = def('LoudGreeter')!.bases[0]!
    // `class LoudGreeter(Greeter, ...)` is on source line 20 (1-based).
    expect(b.line).toBe(19)
    expect(b.character).toBe('class LoudGreeter('.length)
  })

  it('points a dotted base at its final name token, not the first', () => {
    // `thing.Mixin`: textDocument/definition must be asked about `Mixin`.
    // Asking about `thing` answers with the MODULE, which is not a definition site.
    const b = def('LoudGreeter')!.bases[1]!
    expect(b.text).toBe('thing.Mixin')
    expect(b.line).toBe(19)
    expect(b.character).toBe('class LoudGreeter(Greeter, thing.'.length)
  })

  it('marks @abstractmethod members abstract', () => {
    expect(def('Greeter.hello')?.isAbstract).toBe(true)
    expect(def('Greeter.wave')?.isAbstract).toBe(true)
  })

  it('does not mark an undecorated method abstract', () => {
    expect(def('Greeter.helper')?.isAbstract).toBe(false)
  })

  it('detects an async method as abstract too', () => {
    expect(def('Greeter.wave')?.type).toBe('function')
    expect(def('Greeter.wave')?.isAbstract).toBe(true)
  })

  it('normalizes a signature including varargs, kwonly, a default and return type', () => {
    // `b=2` is a real default in the fixture; the signature must show it
    // (previously dropped — see fix-round-2 in task-8-report.md).
    expect(def('top_level')?.signature).toBe('(a, b=2, *args, c, **kwargs) -> bool')
  })

  it('records inclusive 1-based line ranges', () => {
    const g = def('Greeter')!
    expect(g.line).toBe(7)
    expect(g.endLine).toBeGreaterThanOrEqual(17)
  })

  it('records absolute from-imports with their names', () => {
    const imp = parsed.imports.find(i => i.module === 'acme.core')
    expect(imp).toMatchObject({ level: 0, names: ['thing'] })
  })

  it('records a relative import with its level and null module', () => {
    const rel = parsed.imports.find(i => i.level === 1)
    expect(rel).toMatchObject({ module: null, names: ['sibling'] })
  })

  it('records a plain import', () => {
    expect(parsed.imports.some(i => i.module === null && i.names.includes('os') && i.level === 0))
      .toBe(true)
  })

  it('rejects a file with a syntax error', async () => {
    const bad = fileURLToPath(new URL('./fixtures/broken.py', import.meta.url))
    const { writeFile, rm } = await import('node:fs/promises')
    await writeFile(bad, 'class Oops(:\n')
    await expect(parsePythonFile(bad)).rejects.toThrow(/syntax/i)
    await rm(bad)
  })

  it.skipIf(!HAS_PY314 || !HAS_PY311)(
    'honours an explicitly passed interpreter (opposite results on the same fixture)',
    async () => {
      // `except A, B:` without parens (PEP 758) is a syntax error before
      // 3.14 and valid from 3.14. If the interpreter parameter were ignored
      // (always running the process's own `python3`), these two calls could
      // not both come out this way on the same machine.
      const newSyntax = fileURLToPath(new URL('./fixtures/py314-except.py', import.meta.url))
      const under314 = await parsePythonFile(newSyntax, 'python3.14')
      expect(under314.defs.find(d => d.qualname === 'handle')?.type).toBe('function')
      await expect(parsePythonFile(newSyntax, 'python3.11')).rejects.toThrow(/syntax/i)
    }
  )

  it('rejects (or accepts) the PEP 758 except-without-parens syntax based on the default interpreter\'s own version', async () => {
    // Asserts against whatever `python3` actually resolves to on the machine
    // running the suite, rather than assuming it predates 3.14.
    const newSyntax = fileURLToPath(new URL('./fixtures/py314-except.py', import.meta.url))
    const [major, minor] = await pythonVersion()
    if (major > 3 || (major === 3 && minor >= 14)) {
      const result = await parsePythonFile(newSyntax)
      expect(result.defs.find(d => d.qualname === 'handle')?.type).toBe('function')
    } else {
      await expect(parsePythonFile(newSyntax)).rejects.toThrow(/syntax/i)
    }
  })
})

describe('signature rendering (annotations, defaults, positional-only)', () => {
  let sigs: ParsedFile
  beforeAll(async () => { sigs = await parsePythonFile(SIGNATURES_FIXTURE) })
  const sig = (q: string) => sigs.defs.find(d => d.qualname === q)?.signature

  it('renders an annotated parameter and return type', () => {
    expect(sig('annotated')).toBe('(a: int, b: str) -> bool')
  })

  it('renders an unannotated default', () => {
    expect(sig('with_default')).toBe('(a, b: int = 5)')
  })

  it('renders the positional-only "/" marker', () => {
    expect(sig('positional_only')).toBe('(a, b, /, c)')
  })

  it('gives two signatures differing only in annotation different signature strings', () => {
    expect(sig('variant_int')).not.toBe(sig('variant_str'))
    expect(sig('variant_int')).toBe('(x: int)')
    expect(sig('variant_str')).toBe('(x: str)')
  })
})

describe('lineCount', () => {
  it('reports the exact line count of a known fixture', async () => {
    // fixtures/sample.py has 29 lines (verified with `wc -l` / splitlines()).
    expect(parsed.lineCount).toBe(29)
  })

  it('reports the same count with or without a trailing newline', async () => {
    const noTrailing = fileURLToPath(new URL('./fixtures/no-trailing-newline.py', import.meta.url))
    const withTrailing = fileURLToPath(new URL('./fixtures/with-trailing-newline.py', import.meta.url))
    const a = await parsePythonFile(noTrailing)
    const b = await parsePythonFile(withTrailing)
    expect(a.lineCount).toBe(2)
    expect(b.lineCount).toBe(2)
  })

  it('reports 0 for an empty file', async () => {
    const empty = fileURLToPath(new URL('./fixtures/empty.py', import.meta.url))
    const result = await parsePythonFile(empty)
    expect(result.lineCount).toBe(0)
  })
})

const DECORATORS_FIXTURE = fileURLToPath(new URL('./fixtures/decorators.py', import.meta.url))

describe('decoratorStart', () => {
  let decorated: ParsedFile
  beforeAll(async () => { decorated = await parsePythonFile(DECORATORS_FIXTURE) })
  const d = (q: string) => decorated.defs.find(x => x.qualname === q)

  it('records the FIRST decorator line without moving `line`', () => {
    // `line` must stay on the `class` keyword: buildDefIndex keys on it and
    // LSP answers base lookups with the name-token line.
    expect(d('Widget')!.line).toBe(6)
    expect(d('Widget')!.decoratorStart).toBe(4)
  })

  it('records a method decorator', () => {
    expect(d('Widget.size')!.line).toBe(10)
    expect(d('Widget.size')!.decoratorStart).toBe(9)
  })

  it('is null when the element has no decorators', () => {
    expect(d('Plain')!.decoratorStart).toBeNull()
  })
})

const FIELDS_FIXTURE = fileURLToPath(new URL('./fixtures/fields.py', import.meta.url))

describe('field extraction', () => {
  let fields: ParsedFile
  beforeAll(async () => { fields = await parsePythonFile(FIELDS_FIXTURE) })
  const f = (q: string) => fields.defs.find(x => x.qualname === q)

  it('emits annotated class attributes with their annotation as the signature', () => {
    expect(f('Widget.name')!.type).toBe('field')
    expect(f('Widget.name')!.signature).toBe('str')
    expect(f('Widget.count')!.signature).toBe('int')
  })

  it('emits a bare assignment with no signature at all', () => {
    // No annotation means a retyped bare constant is bodyChanged and never
    // signature-changed. That is intended, not a gap.
    // Falsy, not a specific value: parse.py emits JSON null while ParsedDef
    // declares `signature?: string`, exactly as it already does for classes.
    expect(f('Widget.registry')!.type).toBe('field')
    expect(f('Widget.registry')!.signature).toBeFalsy()
  })

  it('does not emit a function-local assignment as a field', () => {
    // A method renders as a row inside its class's box, never as a box of
    // its own, so a local would never be rendered by anything -- and a local
    // reassigned more than once has no decorator to disambiguate it the way
    // a property accessor does, which is a real, unfixable id collision on
    // the reference codebase. Field emission is suppressed inside a function
    // body; walk() still RECURSES into it (see the next test).
    expect(f('Widget.render.local')).toBeUndefined()
  })

  it('does not emit an ANNOTATED function-local assignment as a field either', () => {
    // The suppression gate sits before both the AnnAssign and the Assign
    // branch. Only the bare-assignment half was pinned above; this covers
    // the annotated half of the same gate.
    expect(f('Widget.render.local_annotated')).toBeUndefined()
  })

  it('still finds a nested def inside a function body', () => {
    // Suppressing field emission inside a function must not regress into
    // "stop recursing into function bodies" -- a closure is still a def.
    expect(f('Widget.render.helper')!.type).toBe('function')
  })

  it('resets the suppression for a class declared inside a function', () => {
    // The `in_function` flag must reset to false on entering a ClassDef, not
    // just fail to propagate further: a class nested in a function is a
    // fresh scope whose own attributes are class fields, not locals. Checked
    // for both the AnnAssign and the Assign branch.
    expect(f('factory.Inner.attr')!.type).toBe('field')
    expect(f('factory.Inner.attr')!.signature).toBe('str')
    expect(f('factory.Inner.plain')!.type).toBe('field')
  })

  it('emits module-level constants', () => {
    expect(f('TIMEOUT')!.type).toBe('field')
    expect(f('NAMES')!.type).toBe('field')
  })

  it('ignores tuple targets, which are not named member declarations', () => {
    expect(f('Widget.a')).toBeUndefined()
    expect(f('Widget.b')).toBeUndefined()
  })

  it('leaves functions alone', () => {
    expect(f('Widget.render')!.type).toBe('function')
  })
})

describe('pythonVersion', () => {
  it('returns a plausible major/minor pair for python3', async () => {
    const [major, minor] = await pythonVersion('python3')
    expect(major).toBe(3)
    expect(typeof minor).toBe('number')
    expect(Number.isInteger(minor)).toBe(true)
  })

  it('rejects on a nonexistent interpreter, naming it in the message', async () => {
    await expect(pythonVersion('python3-does-not-exist')).rejects.toThrow(/python3-does-not-exist/)
  })
})
