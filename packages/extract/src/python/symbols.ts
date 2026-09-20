import type { Element, ElementKind } from '@arcdiff/model'
import { moduleIdFor, filePackage } from '../fqn.js'
import type { ParsedFile } from './parse.js'

/**
 * `@x.setter`, `@x.deleter` and `@x.getter` reuse the property's own name, so
 * an accessor carries the SAME qualname as the `@property` it belongs to — on
 * the reference codebase that is 117 collisions across 15 files. The role is
 * read off the decorator rather than from declaration order: an ordinal would
 * move when the accessors are reordered, and an id that differs between base
 * and head reads as removed+added. The `@property` def keeps the bare id, so
 * only the accessor's id is new; a property that never grows an accessor is
 * unaffected.
 *
 * `getter` is here for `@x.getter`, which overrides an inherited property's
 * read side — not for `@property` itself, which IS the bare id.
 */
function accessorRole(decorators: string[]): string | null {
  for (const d of decorators) {
    const m = /^[A-Za-z_][A-Za-z0-9_.]*\.(setter|deleter|getter)$/.exec(d)
    if (m) return m[1]!
  }
  return null
}

/**
 * Build the element tree for one file. Classes are emitted as kind 'class';
 * the interface reclassification pass (classifyInterfaces) runs later, because
 * it needs the whole model to resolve ABC/Protocol bases.
 */
export function elementsForFile(relPath: string, parsed: ParsedFile): Element[] {
  const moduleId = moduleIdFor(relPath)
  const pkg = filePackage(relPath)
  const out: Element[] = []

  out.push({
    id: moduleId,
    kind: 'module',
    name: moduleId.split('.').pop() ?? moduleId,
    parent: null,
    package: pkg,
    file: relPath,
    range: [1, Math.max(parsed.lineCount, 1)],
    lang: 'python',
  })

  const classQualnames = new Set(
    parsed.defs.filter(d => d.type === 'class').map(d => d.qualname),
  )

  // Parent ids are looked up, not rebuilt from the qualname, so a def nested
  // inside an accessor inherits the accessor's disambiguated id instead of
  // colliding with the same-named def nested inside the getter. parse.py walks
  // depth-first and emits a parent before its children, so the entry is always
  // present by the time a child needs it.
  const idByQualname = new Map<string, string>()

  for (const d of parsed.defs) {
    const segments = d.qualname.split('.')
    const parentQual = segments.slice(0, -1).join('.')
    const parentId = parentQual === ''
      ? moduleId
      : (idByQualname.get(parentQual) ?? `${moduleId}.${parentQual}`)
    const name = segments[segments.length - 1]!
    const role = accessorRole(d.decorators)
    const defId = role === null ? `${parentId}.${name}` : `${parentId}.${name}.${role}`
    idByQualname.set(d.qualname, defId)

    let kind: ElementKind
    if (d.type === 'class') kind = 'class'
    else if (d.type === 'field') kind = 'field'
    else kind = classQualnames.has(parentQual) ? 'method' : 'function'

    const el: Element = {
      id: defId,
      kind,
      name,
      parent: parentId,
      package: pkg,
      file: relPath,
      range: [d.line, d.endLine],
      lang: 'python',
    }
    if (d.isAbstract) el.abstract = true
    if (d.signature !== undefined) el.signature = d.signature
    if (d.decoratorStart !== null) el.decoratorStart = d.decoratorStart
    out.push(el)
  }

  return out
}
