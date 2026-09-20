function normalize(relPath: string): string {
  return relPath.replace(/^\.\//, '').replace(/\\/g, '/')
}

/** app/services/m.py -> app.services.m ; app/services/__init__.py -> app.services */
export function fileToModuleFqn(relPath: string): string {
  const p = normalize(relPath).replace(/\.py$/, '')
  const parts = p.split('/')
  if (parts[parts.length - 1] === '__init__') parts.pop()
  return parts.join('.')
}

/** The containing directory as a dotted package. '' for a top-level module. */
export function filePackage(relPath: string): string {
  const p = normalize(relPath)
  const parts = p.split('/')
  parts.pop()
  return parts.join('.')
}

/**
 * The id of a file's module element — what every element in that file hangs
 * off, and the `from` side of its import edges. Identical to `fileToModuleFqn`
 * except for a root `__init__.py`, whose module FQN is the empty string: an
 * element cannot have an empty id, so it gets the `__init__` sentinel. One
 * definition on purpose. Building it in two places is how extraction came to
 * emit `{from: '', to: 'svc', kind: 'imports'}` — an edge out of an element
 * that does not exist, which only the `to` side was ever checked against.
 */
export function moduleIdFor(relPath: string): string {
  const fqn = fileToModuleFqn(relPath)
  return fqn === '' ? '__init__' : fqn
}
