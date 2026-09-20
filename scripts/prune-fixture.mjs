#!/usr/bin/env node
// Shrink two real models plus their delta to something committable, keeping
// every element in a touched file and every element in a 1-hop module.
// Usage: node scripts/prune-fixture.mjs <delta.json> <outDir>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const [deltaPath, outDir] = process.argv.slice(2)
const doc = JSON.parse(readFileSync(deltaPath, 'utf8'))
const base = JSON.parse(readFileSync(doc.source.base.modelPath, 'utf8'))
const head = JSON.parse(readFileSync(doc.source.head.modelPath, 'utf8'))

const touchedFiles = new Set(
  doc.delta.elements.map(c => (c.after ?? c.before).file),
)

function prune(model) {
  // Build the id index ONCE. Rebuilding it per moduleOf() call is O(n^2) and
  // the head model is 10,163 elements — that is ~100M map inserts and the
  // script appears to hang.
  const byId = new Map(model.elements.map(e => [e.id, e]))
  const moduleCache = new Map()
  const moduleOf = id => {
    const hit = moduleCache.get(id)
    if (hit !== undefined) return hit
    let cur = byId.get(id)
    while (cur && cur.kind !== 'module') cur = cur.parent ? byId.get(cur.parent) : undefined
    const result = cur?.id ?? null
    moduleCache.set(id, result)
    return result
  }

  const keep = new Set()

  // 1. Every element in a touched file, in FULL detail. Attribution needs all
  //    of them: it decides "directly changed" by asking whether a NARROWER
  //    element in the same file also covers the hunk.
  for (const e of model.elements) if (touchedFiles.has(e.file)) keep.add(e.id)

  // 2. One import hop, as a module NODE only — not the module's members.
  //    Relation tests need the importer to exist as a graph node; nothing
  //    needs its methods. Keeping members here is what made an early version
  //    3,215 elements and 1.78 MB per side.
  const touchedModules = new Set([...keep].map(moduleOf))
  for (const edge of model.edges) {
    if (edge.kind !== 'imports') continue
    if (touchedModules.has(edge.from) && byId.has(edge.to)) keep.add(edge.to)
    if (touchedModules.has(edge.to) && byId.has(edge.from)) keep.add(edge.from)
  }

  // 3. The inheritance closure of every kept type, in both directions, plus
  //    those types' members and modules. Without this the fixture contains
  //    ZERO interfaces and the sub/super relation test has no subject.
  const seed = [...keep].filter(id => {
    const e = byId.get(id)
    return e && (e.kind === 'class' || e.kind === 'interface')
  })
  const types = new Set(seed)
  const stack = [...seed]
  while (stack.length > 0) {
    const cur = stack.pop()
    for (const edge of model.edges) {
      if (edge.kind !== 'extends' && edge.kind !== 'implements') continue
      const other = edge.from === cur ? edge.to : edge.to === cur ? edge.from : null
      if (other !== null && byId.has(other) && !types.has(other)) {
        types.add(other)
        stack.push(other)
      }
    }
  }
  for (const t of types) {
    keep.add(t)
    const m = moduleOf(t)
    if (m) keep.add(m)
  }
  for (const e of model.elements) if (e.parent && types.has(e.parent)) keep.add(e.id)

  return {
    ref: model.ref,
    extractedAt: model.extractedAt,
    elements: model.elements.filter(e => keep.has(e.id)),
    edges: model.edges.filter(e => keep.has(e.from) && keep.has(e.to)),
  }
}

mkdirSync(join(outDir, 'diff'), { recursive: true })
// Prune each model ONCE and reuse — the summary at the bottom used to call
// prune() again, doubling the work on a 10k-element model.
const prunedBase = prune(base)
const prunedHead = prune(head)
writeFileSync(join(outDir, 'base.model.json'), JSON.stringify(prunedBase))
writeFileSync(join(outDir, 'head.model.json'), JSON.stringify(prunedHead))
writeFileSync(join(outDir, 'delta.json'), JSON.stringify(doc, null, 2))

// One -U3 diff per touched file, so server-less tests have real input.
for (const file of touchedFiles) {
  const text = execFileSync('git', [
    '-C', doc.source.repoRoot, 'diff', '--unified=3', '--no-color',
    `--relative=${doc.source.subdir}`,
    doc.source.base.ref, doc.source.head.ref, '--', `${doc.source.subdir}/${file}`,
  ], { encoding: 'utf8', maxBuffer: 1e8 })
  writeFileSync(join(outDir, 'diff', file.replace(/\//g, '__') + '.diff'), text)
}

const n = m => `${m.elements.length} elements / ${m.edges.length} edges`
console.log('base', n(prunedBase), '· head', n(prunedHead),
            '·', touchedFiles.size, 'diffs')
