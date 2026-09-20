import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const SCRIPT = fileURLToPath(new URL('./parse.py', import.meta.url))

export interface ParsedBase { text: string; line: number; character: number }

export interface ParsedDef {
  qualname: string
  type: 'class' | 'function' | 'field'
  line: number
  endLine: number
  /** 1-based line of the first decorator, or null when there are none. */
  decoratorStart: number | null
  bases: ParsedBase[]
  decorators: string[]
  signature?: string
  isAbstract: boolean
}

export interface ParsedImport {
  module: string | null
  level: number
  names: string[]
}

export interface ParsedFile {
  defs: ParsedDef[]
  imports: ParsedImport[]
  lineCount: number
}

/**
 * Structural facts from Python's own `ast`. Base positions come back in
 * 0-based LSP coordinates so they can be handed straight to textDocument/definition.
 *
 * `python` selects the interpreter to run the parse under (default `python3`).
 * The target codebase's own syntax may require a newer interpreter than
 * whatever `python3` resolves to on the machine running arcdiff — callers
 * that know the target's `requires-python` should pass the matching binary.
 */
export async function parsePythonFile(absPath: string, python = 'python3'): Promise<ParsedFile> {
  let stdout: string
  try {
    ;({ stdout } = await run(python, [SCRIPT, absPath], { maxBuffer: 32 * 1024 * 1024 }))
  } catch (err) {
    const e = err as { stdout?: string }
    if (e.stdout) {
      const parsed = JSON.parse(e.stdout) as { error?: string }
      if (parsed.error) throw new Error(parsed.error)
    }
    throw err
  }
  const raw = JSON.parse(stdout) as {
    defs: (Omit<ParsedDef, 'signature'> & { signature: string | null })[]
    imports: ParsedImport[]
    lineCount: number
  }
  return {
    defs: raw.defs.map(d => ({ ...d, signature: d.signature ?? undefined })),
    imports: raw.imports,
    lineCount: raw.lineCount,
  }
}

/**
 * The (major, minor) version of the given interpreter, e.g. `[3, 14]`.
 * Rejects with a message naming the interpreter if it cannot be run at all
 * (e.g. ENOENT for a `--python` flag that doesn't resolve on this machine),
 * so that case surfaces as a clear configuration error rather than a
 * confusing downstream parse failure.
 */
export async function pythonVersion(python = 'python3'): Promise<[number, number]> {
  let stdout: string
  try {
    ;({ stdout } = await run(python, ['-c', 'import sys; print(sys.version_info[0], sys.version_info[1])']))
  } catch (err) {
    const e = err as { code?: string; message?: string }
    if (e.code === 'ENOENT') {
      throw new Error(`python interpreter not found: ${python}`)
    }
    throw err
  }
  const [major, minor] = stdout.trim().split(/\s+/).map(Number)
  return [major!, minor!]
}
