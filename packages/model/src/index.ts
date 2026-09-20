/**
 * The version of everything a cached model file encodes: the `Element` shape
 * AND the rule that builds element ids. BUMP IT whenever either changes.
 *
 * It exists because the id rule changed three times while this engine was
 * being built, and the extraction cache was keyed only on
 * (sha, subdir, interpreter, excludes). A cache directory written by an older
 * arcdiff was therefore served forever against a new-rule model, which reads
 * every element as added+removed — silently, and with no way to notice.
 *
 * 2: `@x.setter` / `@x.deleter` no longer share their getter's id.
 * 3: class and module-level assignments are extracted as `kind: 'field'`,
 *    and every element carries `decoratorStart`.
 */
export const MODEL_SCHEMA_VERSION = 3

export type ElementKind =
  | 'package' | 'module' | 'class' | 'interface'
  | 'function' | 'method' | 'field'

export type EdgeKind = 'contains' | 'extends' | 'implements' | 'imports'

export type Lang = 'python' | 'kotlin' | 'typescript'

export interface Element {
  /** Fully-qualified path, e.g. acme.core.storage.Backend */
  id: string
  kind: ElementKind
  name: string
  /** Immediate lexical container — the MODULE for a top-level class. */
  parent: string | null
  /** Enclosing directory package — acme.core.storage. Finds peers. */
  package: string
  /** Repo-relative path. */
  file: string
  /** 1-based inclusive [start, end] line. The join key to git hunks. */
  range: [number, number]
  /**
   * 1-based line of the element's FIRST decorator, when it has any.
   *
   * Deliberately NOT folded into `range`: buildDefIndex keys on range[0] and
   * LSP answers base-class lookups with the name-token line, so widening
   * range[0] would move the key off the line the server reports and silently
   * drop the inheritance edge of EVERY decorated class in the corpus. The
   * A18 canary would not catch it: that only proves the server resolves
   * something, and undecorated classes keep resolving fine.
   */
  decoratorStart?: number
  abstract?: boolean
  /** Normalized params and return, e.g. "(self, x: int) -> str" */
  signature?: string
  lang: Lang
}

export interface Edge {
  from: string
  to: string
  kind: EdgeKind
}

export interface Model {
  ref: string
  extractedAt: string
  elements: Element[]
  edges: Edge[]
}

export type ChangeKind = 'added' | 'removed' | 'modified'

/** Element fields whose change makes an element 'modified'. */
export const COMPARED_FIELDS = [
  'kind', 'parent', 'package', 'abstract', 'signature',
] as const
export type ComparedField = (typeof COMPARED_FIELDS)[number]

export interface ElementChange {
  id: string
  change: ChangeKind
  before?: Element
  after?: Element
  /** Which COMPARED_FIELDS differ. Only set when change === 'modified'. */
  fields?: ComparedField[]
  /** From git hunks, not from LSP. */
  bodyChanged?: boolean
}

export interface EdgeChange {
  edge: Edge
  change: 'added' | 'removed'
}

export interface Delta {
  base: string
  head: string
  elements: ElementChange[]
  edges: EdgeChange[]
}

/**
 * Pure ordinal string comparison. Locale-independent, unlike localeCompare.
 * Guarantees byte-identical diffs across different ICU configurations.
 */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Every ancestor package of `pkg`, most specific first.
 * 'acme.core.storage' -> ['acme.core.storage', 'acme.core', 'acme']
 * This is the zoom axis: peers at level N share ancestor N.
 */
export function packageAncestors(pkg: string): string[] {
  if (pkg === '') return []
  const parts = pkg.split('.')
  const out: string[] = []
  for (let i = parts.length; i > 0; i--) out.push(parts.slice(0, i).join('.'))
  return out
}
