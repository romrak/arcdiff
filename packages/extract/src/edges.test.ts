import { describe, it, expect } from 'vitest'
import type { Element } from '@arcdiff/model'
import { buildEdges, type FileImports } from './edges.js'
import { filePackage, moduleIdFor } from './fqn.js'
import type { ResolvedBase } from './classify.js'

function el(id: string, kind: Element['kind'], parent: string | null): Element {
  return { id, kind, name: id.split('.').pop()!, parent,
           package: 'app', file: 'app/m.py', range: [1, 9], lang: 'python' }
}

const elements: Element[] = [
  el('app.m', 'module', null),
  el('app.m.Iface', 'interface', 'app.m'),
  el('app.m.Base', 'class', 'app.m'),
  el('app.m.Impl', 'class', 'app.m'),
  el('app.m.Impl.run', 'method', 'app.m.Impl'),
]

describe('buildEdges', () => {
  it('emits a contains edge from parent to child', () => {
    const edges = buildEdges(elements, [], [])
    expect(edges).toContainEqual({ from: 'app.m', to: 'app.m.Impl', kind: 'contains' })
    expect(edges).toContainEqual({ from: 'app.m.Impl', to: 'app.m.Impl.run', kind: 'contains' })
  })

  // Built generically off `e.parent` — a field owner needs no dedicated code
  // path, exactly like a method's.
  it('emits a contains edge from a class to its field, with no special-casing', () => {
    const withField = [...elements, el('app.m.Impl.count', 'field', 'app.m.Impl')]
    const edges = buildEdges(withField, [], [])
    expect(edges).toContainEqual({ from: 'app.m.Impl', to: 'app.m.Impl.count', kind: 'contains' })
  })

  it('labels a base that resolves to an interface as implements', () => {
    const bases: ResolvedBase[] = [{ fromId: 'app.m.Impl', toId: 'app.m.Iface', text: 'Iface' }]
    expect(buildEdges(elements, bases, []))
      .toContainEqual({ from: 'app.m.Impl', to: 'app.m.Iface', kind: 'implements' })
  })

  it('labels a base that resolves to a class as extends', () => {
    const bases: ResolvedBase[] = [{ fromId: 'app.m.Impl', toId: 'app.m.Base', text: 'Base' }]
    expect(buildEdges(elements, bases, []))
      .toContainEqual({ from: 'app.m.Impl', to: 'app.m.Base', kind: 'extends' })
  })

  it('drops a base that resolved outside the repo', () => {
    const bases: ResolvedBase[] = [{ fromId: 'app.m.Impl', toId: null, text: 'ABC' }]
    const edges = buildEdges(elements, bases, [])
    expect(edges.some(e => e.kind === 'extends' || e.kind === 'implements')).toBe(false)
  })

  it('drops a base whose target is not in the element set', () => {
    const bases: ResolvedBase[] = [{ fromId: 'app.m.Impl', toId: 'app.gone.X', text: 'X' }]
    const edges = buildEdges(elements, bases, [])
    expect(edges.some(e => e.to === 'app.gone.X')).toBe(false)
  })

  it('emits an imports edge between modules for an absolute from-import', () => {
    const els = [...elements, el('app.other', 'module', null)]
    const imports: FileImports[] = [
      { moduleId: 'app.m', packageFqn: 'app', imports: [{ module: 'app.other', level: 0, names: ['Thing'] }] },
    ]
    expect(buildEdges(els, [], imports))
      .toContainEqual({ from: 'app.m', to: 'app.other', kind: 'imports' })
  })

  it('resolves a from-import that names a submodule', () => {
    const els = [...elements, el('app.other.sub', 'module', null)]
    const imports: FileImports[] = [
      { moduleId: 'app.m', packageFqn: 'app', imports: [{ module: 'app.other', level: 0, names: ['sub'] }] },
    ]
    expect(buildEdges(els, [], imports))
      .toContainEqual({ from: 'app.m', to: 'app.other.sub', kind: 'imports' })
  })

  it('resolves a relative import against the importing package', () => {
    const els = [el('app.pkg.a', 'module', null), el('app.pkg.b', 'module', null)]
    const imports: FileImports[] = [
      { moduleId: 'app.pkg.a', packageFqn: 'app.pkg', imports: [{ module: null, level: 1, names: ['b'] }] },
    ]
    expect(buildEdges(els, [], imports))
      .toContainEqual({ from: 'app.pkg.a', to: 'app.pkg.b', kind: 'imports' })
  })

  it('drops a third-party import with no element in the model', () => {
    const imports: FileImports[] = [
      { moduleId: 'app.m', packageFqn: 'app', imports: [{ module: 'pydantic', level: 0, names: ['BaseModel'] }] },
    ]
    expect(buildEdges(elements, [], imports).some(e => e.kind === 'imports')).toBe(false)
  })

  it('does not emit a self-import edge', () => {
    const imports: FileImports[] = [
      { moduleId: 'app.m', packageFqn: 'app', imports: [{ module: 'app', level: 0, names: ['m'] }] },
    ]
    expect(buildEdges(elements, [], imports).some(e => e.from === e.to)).toBe(false)
  })

  it('deduplicates repeated edges', () => {
    const bases: ResolvedBase[] = [
      { fromId: 'app.m.Impl', toId: 'app.m.Iface', text: 'Iface' },
      { fromId: 'app.m.Impl', toId: 'app.m.Iface', text: 'Iface' },
    ]
    const found = buildEdges(elements, bases, [])
      .filter(e => e.kind === 'implements')
    expect(found).toHaveLength(1)
  })

  it('returns edges in deterministic order', () => {
    const a = JSON.stringify(buildEdges(elements, [], []))
    const b = JSON.stringify(buildEdges(elements, [], []))
    expect(a).toBe(b)
  })

  // The importing module's own package, not the module id minus a segment: inside
  // app/pkg/__init__.py the module FQN IS the package, so dropping a segment
  // resolves `from . import b` one level too high.
  it('resolves a relative import inside a package __init__ against the package itself', () => {
    const els = [el('app.pkg', 'module', null), el('app.pkg.b', 'module', null)]
    const imports: FileImports[] = [
      { moduleId: 'app.pkg', packageFqn: 'app.pkg',
        imports: [{ module: null, level: 1, names: ['b'] }] },
    ]
    expect(buildEdges(els, [], imports))
      .toContainEqual({ from: 'app.pkg', to: 'app.pkg.b', kind: 'imports' })
  })

  it('resolves a dotted relative import inside a package __init__', () => {
    const els = [el('app.pkg', 'module', null), el('app.pkg.mod', 'module', null)]
    const imports: FileImports[] = [
      { moduleId: 'app.pkg', packageFqn: 'app.pkg',
        imports: [{ module: 'mod', level: 1, names: ['X'] }] },
    ]
    expect(buildEdges(els, [], imports))
      .toContainEqual({ from: 'app.pkg', to: 'app.pkg.mod', kind: 'imports' })
  })

  it('resolves a relative import in a top-level module without a leading dot', () => {
    const els = [el('a', 'module', null), el('b', 'module', null)]
    const imports: FileImports[] = [
      { moduleId: 'a', packageFqn: '', imports: [{ module: null, level: 1, names: ['b'] }] },
    ]
    expect(buildEdges(els, [], imports))
      .toContainEqual({ from: 'a', to: 'b', kind: 'imports' })
  })

  // A root __init__.py's module FQN is '' but its ELEMENT id is '__init__'.
  // Built from fileToModuleFqn, this emitted {from: '', to: 'svc'}: an edge out
  // of an element that does not exist, with only the `to` side ever checked.
  it('hangs a root __init__.py import edge off the module element that exists', () => {
    const els = [el('__init__', 'module', null), el('svc', 'module', null)]
    const imports: FileImports[] = [{
      moduleId: moduleIdFor('__init__.py'),
      packageFqn: filePackage('__init__.py'),
      imports: [{ module: null, level: 0, names: ['svc'] }],
    }]
    expect(buildEdges(els, [], imports))
      .toContainEqual({ from: '__init__', to: 'svc', kind: 'imports' })
  })

  it('refuses an import whose own module has no element, rather than dangling', () => {
    const els = [el('svc', 'module', null)]
    const imports: FileImports[] = [
      { moduleId: '', packageFqn: '', imports: [{ module: null, level: 0, names: ['svc'] }] },
    ]
    expect(() => buildEdges(els, [], imports)).toThrow(/no module element to hang off/)
  })
})
