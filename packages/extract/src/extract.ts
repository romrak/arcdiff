import { readFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { isAbsolute, join, relative } from 'node:path'
import { compareIds, type Element, type ElementKind, type Model } from '@arcdiff/model'
import type { LspCapabilities, LspClient } from './lsp/client.js'
import { parsePythonFile, pythonVersion, type ParsedFile } from './python/parse.js'
import { elementsForFile } from './python/symbols.js'
import { moduleIdFor, filePackage } from './fqn.js'
import { classifyInterfaces, type ResolvedBase } from './classify.js'
import { buildEdges, type FileImports } from './edges.js'

interface LspPosition { line: number; character: number }
interface LspRange { start: LspPosition; end: LspPosition }

/**
 * textDocument/definition answers with either a Location (`uri` + `range`) or a
 * LocationLink (`targetUri` + `targetRange` + `targetSelectionRange`).
 */
export interface LspLocation {
  uri?: string
  range?: LspRange
  targetUri?: string
  targetRange?: LspRange
  targetSelectionRange?: LspRange
}

/** A definition site: which element starts there, and what kind it is. */
export interface DefEntry { id: string; kind: ElementKind }

/** "<repo-relative file>:<1-based start line>" -> the element defined there. */
export type DefIndex = Map<string, DefEntry>

export type BaseResolution =
  | { id: string; reason: 'resolved' }
  | {
      id: null
      reason:
        | 'no-definition' | 'external' | 'not-analysed'
        | 'not-a-definition' | 'not-a-type' | 'ambiguous'
    }

/** A file that could not be parsed, and the interpreter's own reason. */
export interface ParseFailure {
  /** Repo-relative path. */
  file: string
  /** e.g. `syntax error: invalid syntax (broken.py, line 1)`. */
  reason: string
}

/**
 * The slice of LspClient extractModel drives. Structural on purpose: LspClient's
 * constructor is private, so a nominal type would leave the whole resolution
 * loop — and every guard in it — impossible to test without a live server.
 */
export type ExtractClient = Pick<LspClient, 'didOpen' | 'request' | 'capabilities' | 'terminated'>

export interface ExtractOptions {
  /** Absolute path to the analysis root, e.g. .../pip/src */
  root: string
  /** Ref label recorded on the model — a commit SHA. */
  ref: string
  /** Repo-relative .py paths to analyse. */
  files: string[]
  client: ExtractClient
  /**
   * Interpreter to run parse.py under. Default 'python3'. The target's own
   * `requires-python` governs: an older interpreter fails to parse newer syntax,
   * and those files are then missing from BOTH models being compared, so the
   * delta looks clean while a fifth of the graph is absent.
   */
  python?: string
  /**
   * Permit a run in which no base class resolved in-repo. Default false: that
   * is normally a misconfigured language-server import root, which yields a
   * model with NO inheritance that otherwise looks healthy. Set it only for a
   * codebase whose bases genuinely all come from outside the root.
   */
  allowNoResolvedBases?: boolean
}

export interface ExtractResult {
  model: Model
  /** Base-class sites a textDocument/definition request was issued for. */
  basesAttempted: number
  /**
   * Of those, the ones that landed on a definition line inside the root. Counted
   * at resolution time; every such id comes from the element index, so the
   * post-classification existence check is a no-op safety net, not a second filter.
   */
  basesResolved: number
  /** Resolved to a file outside the root — stdlib, site-packages, a .pyi stub. */
  basesExternal: number
  /**
   * Landed inside the root but not on a definition line. A base spelled as an
   * alias — `Base = declarative_base()`, a functional Enum — lands on its
   * assignment, so a nonzero count is normal; a count that dwarfs
   * `basesResolved` means positions have drifted.
   */
  basesNotDefinition: number
  /**
   * Landed inside the root, in a file that was never parsed into the model.
   * That is usually the `--exclude` case — pyright indexes the whole worktree,
   * so a base defined in an excluded file resolves in-root and misses the
   * definition index for a reason that has nothing to do with drift — but it
   * also covers a file that FAILED to parse, which only reaches here under
   * `--allow-parse-failures`. Either way the miss is not drift, so it is
   * bucketed away from `basesNotDefinition`, the signal VALIDATION.md relies on.
   */
  basesNotAnalysed: number
  /**
   * Everything else: no definition returned, an ambiguous one, or one that
   * landed on a definition that is not a class (`class Foo(make_base())`).
   */
  basesUnresolved: number
  /**
   * Definition requests that failed on their own merits — a rejected request
   * that did not kill the server, or an answer carrying an unusable URI. A
   * subset of `basesUnresolved`, not a separate bucket. A dead server is not
   * counted here: that aborts the run.
   */
  basesRequestFailed: number
  /**
   * True when bases were attempted and none resolved in-repo. Only ever true
   * when `allowNoResolvedBases` was set — otherwise extraction throws.
   */
  noBasesResolved: boolean
  filesParsed: number
  filesFailed: number
  /**
   * Files that failed to parse, each with the interpreter's own message.
   * Never silently dropped, and never reduced to a bare path: the centrepiece
   * finding of this whole plan was a silent interpreter mismatch, which is
   * exactly what the message distinguishes from an ordinary syntax error.
   */
  failures: ParseFailure[]
  /** (major, minor) of the interpreter the parse actually ran under. */
  pythonVersion: [number, number]
  /** What the language server advertised at initialize. Carried so a consumer
   * can hide affordances the server cannot support; a cache hit never starts a
   * server, so this is the only place it can come from. */
  capabilities: LspCapabilities
}

/** At most this many colliding ids are named before the message is truncated. */
const MAX_REPORTED_DUPLICATES = 10

/**
 * Element ids are the ONLY key `diffModels` matches base against head on, so a
 * duplicate does not merely lose an element: the survivor shadows its twin in
 * both models, and the two shadows are then compared field by field. Adding a
 * `@x.setter` to an existing property that way reports `signature-changed` on a
 * signature nobody touched, and a real change to the getter is invisible.
 *
 * Fifteen task reviews missed 117 such collisions because nothing ever asserted
 * uniqueness. This is that assertion — loud, and naming the offenders.
 */
export function assertUniqueIds(elements: Element[]): void {
  const byId = new Map<string, Element[]>()
  for (const e of elements) {
    const list = byId.get(e.id)
    if (list) list.push(e)
    else byId.set(e.id, [e])
  }
  const dups = [...byId.values()].filter(l => l.length > 1)
  if (dups.length === 0) return
  const describe = (e: Element): string =>
    `    ${e.file}:${e.range[0]}-${e.range[1]} (${e.kind}${e.signature === undefined ? '' : ` ${e.signature}`})`
  const shown = dups.slice(0, MAX_REPORTED_DUPLICATES)
    .map(l => `  ${l[0]!.id}\n${l.map(describe).join('\n')}`).join('\n')
  const more = dups.length > MAX_REPORTED_DUPLICATES
    ? `\n  ... and ${dups.length - MAX_REPORTED_DUPLICATES} more`
    : ''
  throw new Error(
    `arcdiff: ${dups.length} element id(s) are not unique among ${elements.length} elements. ` +
    'The id is the only key the diff matches on, so a duplicate shadows its twin in BOTH ' +
    'models and reports the survivor\'s fields as a change that never happened:\n' +
    `${shown}${more}\n` +
    'Most likely cause: several defs sharing one qualname with nothing to tell them ' +
    'apart — a @typing.overload stack, or a def redefined under if TYPE_CHECKING. ' +
    'That is a known gap in the id rule arcdiff uses, not a bug in the code above: ' +
    'property accessors are disambiguated by their decorator, these are not. ' +
    'To proceed now, --exclude the file(s) named above, at the cost of every element ' +
    'in them being absent from the model.',
  )
}

/** Definition sites keyed by position, so a target line maps to a canonical id. */
export function buildDefIndex(elements: Element[]): DefIndex {
  const index: DefIndex = new Map()
  for (const e of elements) {
    if (e.kind === 'class' || e.kind === 'interface' || e.kind === 'function' || e.kind === 'method') {
      index.set(`${e.file}:${e.range[0]}`, { id: e.id, kind: e.kind })
    }
  }
  return index
}

/**
 * The element a textDocument/definition answer names, or null with a reason.
 * Looking the target position up in the element index — rather than rebuilding
 * an FQN from the base's source text — is what makes a base declared inside
 * another class resolve to `mod.Outer.Inner` instead of the non-existent
 * `mod.Inner`. A target outside the root resolves to null on purpose:
 * classifyInterfaces recognises ABC/Protocol precisely when toId is null.
 */
function relativeToRoot(targetPath: string, roots: readonly string[]): string | null {
  for (const root of roots) {
    const rel = relative(root, targetPath)
    if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) return rel
  }
  return null
}

export function resolveBaseTarget(
  locations: LspLocation[],
  roots: readonly string[],
  defIndex: DefIndex,
  /** Repo-relative paths actually parsed into the model. Required, not defaulted:
   * a permissive default would silently re-merge the two buckets. */
  analysedFiles: ReadonlySet<string>,
): BaseResolution {
  let found: string | null = null
  for (const loc of locations) {
    const uri = loc.uri ?? loc.targetUri
    // targetSelectionRange is the name token; targetRange spans the whole symbol
    // and starts at the decorator for a decorated class, which would miss the index.
    const range = loc.range ?? loc.targetSelectionRange
    if (uri === undefined || range === undefined) return { id: null, reason: 'no-definition' }
    const targetPath = decodeURIComponent(new URL(uri).pathname)
    const rel = relativeToRoot(targetPath, roots)
    if (rel === null) return { id: null, reason: 'external' }
    // LSP lines are 0-based; element ranges are 1-based.
    const entry = defIndex.get(`${rel}:${range.start.line + 1}`)
    if (entry === undefined) {
      return { id: null, reason: analysedFiles.has(rel) ? 'not-a-definition' : 'not-analysed' }
    }
    // A base can only be a type. `class Foo(make_base())` resolves onto the
    // factory's `def`, and an extends edge into a function is not a thing.
    if (entry.kind !== 'class' && entry.kind !== 'interface') {
      return { id: null, reason: 'not-a-type' }
    }
    if (found !== null && found !== entry.id) return { id: null, reason: 'ambiguous' }
    found = entry.id
  }
  return found === null ? { id: null, reason: 'no-definition' } : { id: found, reason: 'resolved' }
}

/** How many leading base sites may return nothing before extraction is declared broken. */
const CANARY_PROBES = 5

function canaryFailure(root: string, probes: number): Error {
  return new Error(
    `arcdiff: textDocument/definition returned no location for any of the first ${probes} ` +
    `base-class sites under ${root}. The language server is not resolving imports — ` +
    `emitting a model now would silently report no inheritance at all.`,
  )
}

/**
 * Parse every file, resolve every base class through the language server and
 * assemble the model. Classification runs before edge labelling: an edge into an
 * 'interface' is 'implements', into a 'class' it is 'extends'.
 */
export async function extractModel(opts: ExtractOptions): Promise<ExtractResult> {
  const { root, ref, files, client } = opts
  const python = opts.python ?? 'python3'
  const version = await pythonVersion(python)
  // Containment is checked against both spellings of the root. A symlinked root
  // (a macOS worktree under /var, which is really /private/var) fails a literal
  // comparison; but the language server echoes paths in whatever form its
  // rootUri was given, so a client started on the unresolved path fails a
  // realpath'd comparison. Either alone silently makes every base external.
  const roots = [...new Set([realpathSync(root), root])]

  const parsedByFile = new Map<string, ParsedFile>()
  let elements: Element[] = []
  const fileImports: FileImports[] = []
  const failures: ParseFailure[] = []

  for (const rel of files) {
    const abs = join(root, rel)
    let parsed: ParsedFile
    try {
      parsed = await parsePythonFile(abs, python)
    } catch (err) {
      // Reported WITH its reason, never swallowed: a dropped file corrupts the
      // delta, and 'which file' without 'why' cannot tell a syntax error from
      // an interpreter too old for the syntax.
      failures.push({ file: rel, reason: err instanceof Error ? err.message : String(err) })
      continue
    }
    parsedByFile.set(rel, parsed)
    elements = elements.concat(elementsForFile(rel, parsed))
    fileImports.push({
      moduleId: moduleIdFor(rel),
      packageFqn: filePackage(rel),
      imports: parsed.imports,
    })
  }

  // Before anything consumes an id: buildDefIndex, annotateBodyChanges and
  // deriveSignals all inherit an ambiguous id silently.
  assertUniqueIds(elements)

  const defIndex = buildDefIndex(elements)
  const analysedFiles: ReadonlySet<string> = new Set(parsedByFile.keys())

  const bases: ResolvedBase[] = []
  let basesAttempted = 0
  let basesResolved = 0
  let basesExternal = 0
  let basesNotDefinition = 0
  let basesNotAnalysed = 0
  let basesRequestFailed = 0
  let canaryProbes = 0
  let canaryPassed = false

  for (const [rel, parsed] of parsedByFile) {
    const classDefs = parsed.defs.filter(d => d.type === 'class' && d.bases.length > 0)
    if (classDefs.length === 0) continue
    const abs = join(root, rel)
    const uri = pathToFileURL(abs).href
    client.didOpen(uri, 'python', await readFile(abs, 'utf8'))
    // documentSymbol confirms the server has indexed the file before we ask
    // it to resolve anything inside it.
    if (client.capabilities.documentSymbol) {
      await client.request('textDocument/documentSymbol', { textDocument: { uri } })
    }

    for (const d of classDefs) {
      // The owner id comes from the same index as every target, so it is exactly
      // the id elementsForFile emitted — no second copy of the id-building rule.
      const fromId = defIndex.get(`${rel}:${d.line}`)?.id
      if (fromId === undefined) {
        throw new Error(`arcdiff: no element indexed for class ${d.qualname} at ${rel}:${d.line}`)
      }
      for (const b of d.bases) {
        basesAttempted++
        // A null RESULT is a legitimate "no definition here". A REJECTION is
        // either a dead server — fatal, because every later request is pointless
        // and swallowing it would emit a model with near-empty inheritance — or
        // this one position being unacceptable, which should cost one base and
        // not 1300 files of work. `terminated` is the discriminator: it is set
        // only by a spawn error or a process exit, never by an error response.
        // An out-of-range position (a non-ASCII prefix makes parse.py's UTF-8
        // column exceed the server's UTF-16 one) and a malformed URI in the
        // answer both land here.
        let resolution: BaseResolution
        try {
          const res = await client.request<LspLocation[] | LspLocation | null>(
            'textDocument/definition',
            { textDocument: { uri }, position: { line: b.line, character: b.character } },
          )
          const locations = res == null ? [] : Array.isArray(res) ? res : [res]
          resolution = resolveBaseTarget(locations, roots, defIndex, analysedFiles)
        } catch (err) {
          if (client.terminated) throw err
          basesRequestFailed++
          resolution = { id: null, reason: 'no-definition' }
        }
        if (resolution.reason === 'resolved') basesResolved++
        else if (resolution.reason === 'external') basesExternal++
        else if (resolution.reason === 'not-a-definition') basesNotDefinition++
        else if (resolution.reason === 'not-analysed') basesNotAnalysed++

        // Canary: prove the server resolves SOMETHING before trusting the run.
        // A location is enough — a first base of `ABC` legitimately lands in
        // typeshed and yields a null id. Several probes, because a healthy run
        // still has a small floor of sites the server cannot resolve.
        if (!canaryPassed && canaryProbes < CANARY_PROBES) {
          canaryProbes++
          if (resolution.reason !== 'no-definition') canaryPassed = true
          else if (canaryProbes === CANARY_PROBES) throw canaryFailure(root, canaryProbes)
        }

        bases.push({ fromId, toId: resolution.id, text: b.text })
      }
    }
  }

  if (basesAttempted > 0 && !canaryPassed) throw canaryFailure(root, canaryProbes)

  // The canary only proves the server answers SOMETHING, and it is satisfied by
  // an external answer: pyright resolves stdlib from its bundled typeshed and
  // third-party from site-packages, neither of which depends on rootUri. So a
  // workspace with a broken import root still answers `ABC` and `BaseModel`
  // while every first-party base returns null. classifyInterfaces is text-based
  // and would still label interfaces correctly, leaving a model that looks
  // healthy and carries no inheritance at all. Only a whole-run zero is
  // unambiguous enough to throw on.
  const noBasesResolved = basesAttempted > 0 && basesResolved === 0
  if (noBasesResolved && opts.allowNoResolvedBases !== true) {
    throw new Error(
      `arcdiff: 0 of ${basesAttempted} base classes resolved to an element under ${root} ` +
      `(external=${basesExternal}, not-a-definition=${basesNotDefinition}, ` +
      `not-analysed=${basesNotAnalysed}, unresolved=` +
      `${basesAttempted - basesExternal - basesNotDefinition - basesNotAnalysed}). The language ` +
      `server's import root is probably misconfigured: the model would carry no ` +
      `inheritance at all while otherwise looking healthy. Pass allowNoResolvedBases ` +
      `if this codebase genuinely derives everything from outside the root.`,
    )
  }

  // Classification must precede edge labelling.
  elements = classifyInterfaces(elements, bases)
  const ids = new Set(elements.map(e => e.id))
  const checkedBases = bases.map(b =>
    b.toId !== null && ids.has(b.toId) ? b : { ...b, toId: null },
  )
  const edges = buildEdges(elements, checkedBases, fileImports)

  elements.sort((a, b) => compareIds(a.id, b.id))
  return {
    model: { ref, extractedAt: new Date().toISOString(), elements, edges },
    basesAttempted,
    basesResolved,
    basesExternal,
    basesNotDefinition,
    basesNotAnalysed,
    basesUnresolved:
      basesAttempted - basesResolved - basesExternal - basesNotDefinition - basesNotAnalysed,
    basesRequestFailed,
    noBasesResolved,
    filesParsed: parsedByFile.size,
    filesFailed: failures.length,
    failures,
    pythonVersion: version,
    capabilities: client.capabilities,
  }
}
