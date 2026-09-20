import { describe, it, expect } from 'vitest'
import { elementsForFile } from './symbols.js'
import type { ParsedFile } from './parse.js'

const parsed: ParsedFile = {
  imports: [],
  lineCount: 21,
  defs: [
    { qualname: 'Greeter', type: 'class', line: 7, endLine: 17, decoratorStart: null, bases: [],
      decorators: [], isAbstract: false },
    { qualname: 'Greeter.hello', type: 'function', line: 8, endLine: 10, decoratorStart: null, bases: [],
      decorators: ['abstractmethod'], signature: '(self) -> str', isAbstract: true },
    { qualname: 'Greeter.Inner', type: 'class', line: 12, endLine: 13, decoratorStart: null, bases: [],
      decorators: [], isAbstract: false },
    { qualname: 'top', type: 'function', line: 20, endLine: 21, decoratorStart: null, bases: [],
      decorators: [], signature: '(a) -> None', isAbstract: false },
  ],
}

describe('elementsForFile', () => {
  const els = elementsForFile('app/services/greet.py', parsed)
  const byId = (id: string) => els.find(e => e.id === id)

  it('emits a module element for the file', () => {
    expect(byId('app.services.greet')).toMatchObject({
      kind: 'module', parent: null, package: 'app.services',
    })
  })

  it('prefixes every def id with the module FQN', () => {
    expect(byId('app.services.greet.Greeter')).toBeDefined()
    expect(byId('app.services.greet.Greeter.hello')).toBeDefined()
  })

  it('parents a top-level class to the module', () => {
    expect(byId('app.services.greet.Greeter')?.parent).toBe('app.services.greet')
  })

  it('parents a method to its class', () => {
    expect(byId('app.services.greet.Greeter.hello')?.parent)
      .toBe('app.services.greet.Greeter')
  })

  it('classifies a function inside a class as a method', () => {
    expect(byId('app.services.greet.Greeter.hello')?.kind).toBe('method')
  })

  it('classifies a function at module level as a function', () => {
    expect(byId('app.services.greet.top')?.kind).toBe('function')
  })

  it('gives every element the same package, from the directory', () => {
    expect(els.every(e => e.package === 'app.services')).toBe(true)
  })

  it('carries the abstract flag through', () => {
    expect(byId('app.services.greet.Greeter.hello')?.abstract).toBe(true)
  })

  it('omits abstract on a non-abstract element rather than setting false', () => {
    expect(byId('app.services.greet.top')?.abstract).toBeUndefined()
  })

  it('carries signature and 1-based inclusive range', () => {
    expect(byId('app.services.greet.top')).toMatchObject({
      signature: '(a) -> None', range: [20, 21],
    })
  })

  it('marks every element as python and records the repo-relative file', () => {
    expect(els.every(e => e.lang === 'python' && e.file === 'app/services/greet.py')).toBe(true)
  })

  it('leaves classes as kind class — interface reclassification is a later pass', () => {
    expect(byId('app.services.greet.Greeter')?.kind).toBe('class')
  })
})

// Widening ParsedDef['type'] to include 'field' adds a third value that a
// two-way `if (class) ... else ...` cannot distinguish from a function: the
// else branch alone would silently label every field 'method' (parent is a
// class) or 'function' (parent is not). This pins the explicit third branch.
describe('elementsForFile with a field', () => {
  it('classifies a field belonging to a class as kind field, not method', () => {
    const withField: ParsedFile = {
      imports: [],
      lineCount: 10,
      defs: [
        { qualname: 'Widget', type: 'class', line: 1, endLine: 8, decoratorStart: null,
          bases: [], decorators: [], isAbstract: false },
        { qualname: 'Widget.count', type: 'field', line: 2, endLine: 2, decoratorStart: null,
          bases: [], decorators: [], signature: 'int', isAbstract: false },
      ],
    }
    const els = elementsForFile('app/m.py', withField)
    const field = els.find(e => e.id === 'app.m.Widget.count')
    expect(field?.kind).toBe('field')
    expect(field?.parent).toBe('app.m.Widget')
  })

  it('classifies a module-level field as kind field, not function', () => {
    const withField: ParsedFile = {
      imports: [],
      lineCount: 5,
      defs: [
        { qualname: 'TIMEOUT', type: 'field', line: 1, endLine: 1, decoratorStart: null,
          bases: [], decorators: [], signature: 'int', isAbstract: false },
      ],
    }
    const els = elementsForFile('app/m.py', withField)
    expect(els.find(e => e.id === 'app.m.TIMEOUT')?.kind).toBe('field')
  })
})

// The wiring line in elementsForFile is only exercised end-to-end by the real
// extraction otherwise, which is not part of the regression suite: a future
// edit to it could silently drop `decoratorStart` and this suite would stay
// green. Pins both directions of the conditional-assignment idiom.
describe('elementsForFile with decoratorStart', () => {
  it('carries decoratorStart onto the Element without moving range[0]', () => {
    const withDecorator: ParsedFile = {
      imports: [],
      lineCount: 50,
      defs: [
        { qualname: 'Widget', type: 'class', line: 45, endLine: 48, decoratorStart: 41,
          bases: [], decorators: ['dataclass'], isAbstract: false },
      ],
    }
    const el = elementsForFile('app/m.py', withDecorator).find(e => e.id === 'app.m.Widget')
    expect(el?.decoratorStart).toBe(41)
    expect(el?.range[0]).toBe(45)
  })

  it('leaves decoratorStart absent, not undefined, when the def has no decorators', () => {
    const withoutDecorator: ParsedFile = {
      imports: [],
      lineCount: 10,
      defs: [
        { qualname: 'Plain', type: 'class', line: 1, endLine: 3, decoratorStart: null,
          bases: [], decorators: [], isAbstract: false },
      ],
    }
    const el = elementsForFile('app/m.py', withoutDecorator).find(e => e.id === 'app.m.Plain')!
    expect('decoratorStart' in el).toBe(false)
  })
})

describe('elementsForFile with no defs', () => {
  it('uses lineCount for module range when file has no defs', () => {
    const noDefs: ParsedFile = { imports: [], defs: [], lineCount: 200 }
    const els = elementsForFile('app/config.py', noDefs)
    expect(els[0]).toMatchObject({
      id: 'app.config', kind: 'module', range: [1, 200],
    })
  })

  it('still spans full file with defs present', () => {
    const withDef: ParsedFile = {
      imports: [],
      lineCount: 100,
      defs: [
        { qualname: 'Foo', type: 'class', line: 5, endLine: 20, decoratorStart: null, bases: [],
          decorators: [], isAbstract: false },
      ],
    }
    const els = elementsForFile('app/m.py', withDef)
    expect(els[0]?.range).toEqual([1, 100])
  })

  it('yields valid range [1, 1] for empty file', () => {
    const empty: ParsedFile = { imports: [], defs: [], lineCount: 0 }
    const els = elementsForFile('app/empty.py', empty)
    expect(els[0]?.range).toEqual([1, 1])
  })
})

describe('elementsForFile with root __init__.py', () => {
  it('produces no id beginning with dot', () => {
    const parsed: ParsedFile = {
      imports: [],
      lineCount: 10,
      defs: [
        { qualname: 'Foo', type: 'class', line: 1, endLine: 5, decoratorStart: null, bases: [],
          decorators: [], isAbstract: false },
      ],
    }
    const els = elementsForFile('__init__.py', parsed)
    expect(els.some(e => e.id.startsWith('.'))).toBe(false)
  })

  it('produces no empty id', () => {
    const parsed: ParsedFile = {
      imports: [],
      lineCount: 10,
      defs: [
        { qualname: 'Bar', type: 'class', line: 1, endLine: 5, decoratorStart: null, bases: [],
          decorators: [], isAbstract: false },
      ],
    }
    const els = elementsForFile('__init__.py', parsed)
    expect(els.some(e => e.id === '')).toBe(false)
  })

  it('has no id collision with a module of the same name', () => {
    const rootInit: ParsedFile = {
      imports: [],
      lineCount: 10,
      defs: [
        { qualname: 'Foo', type: 'class', line: 1, endLine: 5, decoratorStart: null, bases: [],
          decorators: [], isAbstract: false },
      ],
    }
    const module: ParsedFile = {
      imports: [],
      lineCount: 5,
      defs: [],
    }
    const initEls = elementsForFile('__init__.py', rootInit)
    const modEls = elementsForFile('Foo.py', module)
    const allIds = [...initEls, ...modEls].map(e => e.id)
    const uniqueIds = new Set(allIds)
    expect(uniqueIds.size).toBe(allIds.length)
  })

  it('nests methods correctly in root __init__.py', () => {
    const parsed: ParsedFile = {
      imports: [],
      lineCount: 10,
      defs: [
        { qualname: 'Foo', type: 'class', line: 1, endLine: 8, decoratorStart: null, bases: [],
          decorators: [], isAbstract: false },
        { qualname: 'Foo.hello', type: 'function', line: 2, endLine: 5, decoratorStart: null, bases: [],
          decorators: [], isAbstract: false },
      ],
    }
    const els = elementsForFile('__init__.py', parsed)
    const fooEl = els.find(e => e.id === '__init__.Foo')
    const helloEl = els.find(e => e.id === '__init__.Foo.hello')
    expect(fooEl).toBeDefined()
    expect(helloEl?.parent).toBe('__init__.Foo')
  })
})

// A @property getter and its @x.setter carry the SAME qualname. Left alone that
// is one id for two elements, which diffModels resolves by keeping whichever
// came last — in both models — and then reporting the survivor's signature as
// changed. The role comes off the decorator, not declaration order, so
// reordering the accessors does not renumber the id.
describe('elementsForFile with property accessors', () => {
  const withAccessors: ParsedFile = {
    imports: [],
    lineCount: 40,
    defs: [
      { qualname: 'Agent', type: 'class', line: 1, endLine: 20, decoratorStart: null, bases: [],
        decorators: [], isAbstract: false },
      { qualname: 'Agent.flag', type: 'function', line: 3, endLine: 4, decoratorStart: null, bases: [],
        decorators: ['property'], signature: '(self) -> bool', isAbstract: false },
      { qualname: 'Agent.flag', type: 'function', line: 7, endLine: 8, decoratorStart: null, bases: [],
        decorators: ['flag.setter'], signature: '(self, value: bool) -> None', isAbstract: false },
      { qualname: 'Agent.flag', type: 'function', line: 11, endLine: 12, decoratorStart: null, bases: [],
        decorators: ['flag.deleter'], signature: '(self) -> None', isAbstract: false },
    ],
  }

  const els = elementsForFile('app/m.py', withAccessors)

  it('emits one element per accessor with a unique id', () => {
    const ids = els.map(e => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('leaves the getter on the bare id and suffixes the setter and deleter', () => {
    expect(els.map(e => e.id)).toEqual([
      'app.m', 'app.m.Agent', 'app.m.Agent.flag',
      'app.m.Agent.flag.setter', 'app.m.Agent.flag.deleter',
    ])
  })

  it('keeps the Python name and the class parent on every accessor', () => {
    for (const e of els.slice(2)) {
      expect(e.name).toBe('flag')
      expect(e.parent).toBe('app.m.Agent')
    }
  })

  it('keeps each accessor its own signature', () => {
    expect(els.find(e => e.id === 'app.m.Agent.flag')?.signature).toBe('(self) -> bool')
    expect(els.find(e => e.id === 'app.m.Agent.flag.setter')?.signature)
      .toBe('(self, value: bool) -> None')
  })

  // `@x.getter` overrides an inherited property's read side, which collides
  // with the @property def by exactly the same mechanism.
  it('disambiguates an overriding @x.getter from the @property it overrides', () => {
    const overriding: ParsedFile = {
      imports: [],
      lineCount: 20,
      defs: [
        { qualname: 'Sub', type: 'class', line: 1, endLine: 10, decoratorStart: null, bases: [],
          decorators: [], isAbstract: false },
        { qualname: 'Sub.flag', type: 'function', line: 3, endLine: 4, decoratorStart: null, bases: [],
          decorators: ['property'], signature: '(self) -> bool', isAbstract: false },
        { qualname: 'Sub.flag', type: 'function', line: 7, endLine: 8, decoratorStart: null, bases: [],
          decorators: ['flag.getter'], signature: '(self) -> bool | None', isAbstract: false },
      ],
    }
    const ids = elementsForFile('app/m.py', overriding).map(e => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(['app.m', 'app.m.Sub', 'app.m.Sub.flag', 'app.m.Sub.flag.getter'])
  })

  it('is unchanged by the accessors being declared in a different order', () => {
    const [cls, getter, setter, deleter] = withAccessors.defs
    const reordered: ParsedFile = {
      ...withAccessors,
      defs: [cls!, getter!, deleter!, setter!],
    }
    expect(new Set(elementsForFile('app/m.py', reordered).map(e => e.id)))
      .toEqual(new Set(els.map(e => e.id)))
  })

  // A def nested inside a setter would otherwise rebuild its parent from the
  // qualname and land on the GETTER's id, colliding with the same-named def
  // nested inside the getter.
  it('gives a def nested inside an accessor the accessor as its parent', () => {
    const nested: ParsedFile = {
      imports: [],
      lineCount: 40,
      defs: [
        { qualname: 'Agent', type: 'class', line: 1, endLine: 20, decoratorStart: null, bases: [],
          decorators: [], isAbstract: false },
        { qualname: 'Agent.flag', type: 'function', line: 3, endLine: 5, decoratorStart: null, bases: [],
          decorators: ['property'], signature: '(self) -> bool', isAbstract: false },
        { qualname: 'Agent.flag.check', type: 'function', line: 4, endLine: 5, decoratorStart: null, bases: [],
          decorators: [], signature: '() -> bool', isAbstract: false },
        { qualname: 'Agent.flag', type: 'function', line: 7, endLine: 9, decoratorStart: null, bases: [],
          decorators: ['flag.setter'], signature: '(self, value: bool) -> None', isAbstract: false },
        { qualname: 'Agent.flag.check', type: 'function', line: 8, endLine: 9, decoratorStart: null, bases: [],
          decorators: [], signature: '() -> None', isAbstract: false },
      ],
    }
    const ids = elementsForFile('app/m.py', nested).map(e => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('app.m.Agent.flag.check')
    expect(ids).toContain('app.m.Agent.flag.setter.check')
  })
})

