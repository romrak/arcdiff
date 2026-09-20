import { describe, it, expect } from 'vitest'
import { fileToModuleFqn, filePackage, moduleIdFor } from './fqn.js'

describe('fileToModuleFqn', () => {
  it('converts a module path to a dotted FQN', () => {
    expect(fileToModuleFqn('app/services/m.py')).toBe('app.services.m')
  })
  it('maps __init__.py to the package itself', () => {
    expect(fileToModuleFqn('app/services/__init__.py')).toBe('app.services')
  })
  it('handles a top-level module', () => {
    expect(fileToModuleFqn('main.py')).toBe('main')
  })
  it('normalizes a leading ./', () => {
    expect(fileToModuleFqn('./app/m.py')).toBe('app.m')
  })
})

describe('filePackage', () => {
  it('returns the containing directory as a dotted package', () => {
    expect(filePackage('app/services/m.py')).toBe('app.services')
  })
  it('returns the package itself for __init__.py', () => {
    expect(filePackage('app/services/__init__.py')).toBe('app.services')
  })
  it('returns an empty string for a top-level module', () => {
    expect(filePackage('main.py')).toBe('')
  })
})

describe('moduleIdFor', () => {
  it('matches fileToModuleFqn for an ordinary module', () => {
    expect(moduleIdFor('app/services/m.py')).toBe('app.services.m')
  })
  it('matches fileToModuleFqn for a package __init__.py', () => {
    expect(moduleIdFor('app/services/__init__.py')).toBe('app.services')
  })
  // The one case the two differ: an element id can never be the empty string,
  // and an import edge built from the FQN would name an element that does not exist.
  it('gives a root __init__.py the __init__ sentinel, not an empty id', () => {
    expect(fileToModuleFqn('__init__.py')).toBe('')
    expect(moduleIdFor('__init__.py')).toBe('__init__')
  })
})
