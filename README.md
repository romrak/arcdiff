# arcdiff

Structural diff between two git refs: classes, interfaces, methods and the edges
between them, rendered as a UML canvas you click through to the text diff behind
each element. Python today. No AI.

---

## The problem

A text diff tells you which lines moved. It cannot tell you that a new class now
implements an interface three files away, that a method's signature changed under
every one of its callers, or that an abstract method was added to a base class and
one implementer never picked it up. That information exists — it is in the code —
but reading it out of a unified diff means holding the whole architecture in your
head.

arcdiff extracts the structure of both refs, diffs the structures rather than the
text, and shows you the result as a diagram you can drill into. **You do the
review.** Nothing here summarises, scores or explains your code; it only shows you
what changed, at the level you ask for.

## What it looks like

The canvas holds one box per module, class and interface, with methods and fields
as rows inside their owner. Changed elements are marked: `●` for an element whose
own lines changed, `◐` for one that merely contains a change. Click any box or row
and the side pane shows the text diff scoped to exactly that element.

Two controls decide what is on screen:

- **Collapse** folds a box into its parent — "I have looked at this one, get it out
  of my way". The surviving parent grows a `⊞N` affordance that undoes it.
- **Detail** is the zoom axis. `member` shows the working set in full. `package`
  shows *every* package in the codebase, not just the ones that changed, with the
  ones containing a change tinted — which is how you see a new service appear
  beside its existing siblings.

Relation badges on each box (`subs`, `supers`, `importers`, `imports`, `peers`)
pull in one hop at a time, so the graph grows only where you ask it to.

## Requirements

| | |
|---|---|
| Node | >= 20 |
| Python | `python3.14` on PATH (for the AST pass) |
| Language server | `pyright-langserver` on PATH (for base-class resolution) |

## Quickstart

```bash
npm install
npm run build

git clone https://github.com/pypa/pip ~/src/pip

node packages/cli/dist/index.js serve \
  --repo ~/src/pip --subdir src \
  --base 790ae56bb^ --head 790ae56bb \
  --python python3.14 \
  --exclude 'pip/_vendor/**' --exclude 'pip/_internal/main.py'
```

That opens the viewer on a real pip commit. pip is a convenient subject because it
vendors its dependencies, so pyright resolves the whole tree with no virtualenv.

### Choosing `--subdir`

`--subdir` is the analysis root, and **module ids are formed relative to it**. Point
it at the directory that makes import statements resolvable: pip spells its internal
imports `from pip._internal.x import y`, so the root is `src/` — not `src/pip`. Get
this wrong and the modules still extract, but almost no `imports` edges resolve.
Rooting pip at `src/pip` instead of `src/` drops the import graph from 739 edges to
35.

### Subcommands

```
arcdiff extract --repo <path> --subdir <path> [--ref HEAD]
arcdiff diff    --repo <path> --subdir <path> --base <ref> [--head HEAD] [--out delta.json]
arcdiff serve   --repo <path> --subdir <path> --base <ref> [--head HEAD] [--port 5173] [--no-open]
```

`--exclude <glob>` is repeatable and matched against subdir-relative `.py` paths at
listing time, so an excluded file never enters the model.

**Diffing a pull request:** use the merge base, not the base branch tip.
`git merge-base main feature` is the fork point; the branch's current head mixes your
PR with everything merged since. On one real PR that was the difference between 31
signals and 592.

## How it works

```
git refs ──▶ extract ──▶ model ──▶ diff ──▶ delta + signals ──▶ view-model ──▶ viewer
             (ast+lsp)                       (+ git hunks)        (attribution)
```

1. **extract** walks the tree at a ref. A Python `ast` pass gets modules, classes,
   methods, functions, fields, decorators and signatures; pyright resolves each base
   class expression to a definition site so inheritance edges point at real elements
   rather than at names.
2. **diff** compares the two models by element id, then intersects the result with
   `git diff` hunks to add `bodyChanged` — structure alone cannot see an edit that
   changed no declaration.
3. **signals** are the derived observations worth surfacing: `new-interface`,
   `new-implementation`, `new-member`, `signature-changed`, `unimplemented-contract`,
   `new-peer`.
4. **view-model** decides, for each changed element, whether it changed *itself* or
   merely *contains* a change, and builds the box tree, relations and layout input.
5. **viewer** lays it out with elkjs in a worker and renders it with React Flow.

### Packages

| Package | Responsibility |
|---|---|
| `@arcdiff/model` | The element/edge/delta contract. No dependencies. |
| `@arcdiff/git` | Ref resolution, file listing, diff and hunk parsing. |
| `@arcdiff/extract` | The AST pass, the LSP client, and structural extraction. |
| `@arcdiff/diff` | Model diffing, body annotation, signal derivation. |
| `@arcdiff/view-model` | Attribution, box tree, relations, expansion, layout. |
| `@arcdiff/server` | Serves the delta and scoped text diffs over HTTP. |
| `@arcdiff/cli` | `extract` / `diff` / `serve`. |
| `@arcdiff/viewer` | The canvas and diff pane. |

### Attribution

The rule that makes the canvas readable: an element is `direct` only when a changed
line span falls inside its range and inside **no narrower element in the same file**.
A class whose only changed lines belong to one of its methods is `contains`, not
`direct` — otherwise every ancestor of every edit lights up and the marking carries
no information.

A decorated element's attribution range reaches up to its first decorator, so
changing `@staticmethod` to `@classmethod` marks the method rather than its class.

## Known limitations

Stated plainly rather than discovered later.

- **Python only.** The extractor interface is designed for more, but Kotlin, JS and
  TS are not implemented.
- **Committed refs only.** No working-tree diffs, no rename detection — a rename
  reads as a remove plus an add.
- **A removed element has no box**, because the box tree is built from the head
  model. Its change is in `delta.json` but you cannot click it on the canvas.
- **Same-name redefinitions in one scope are a hard failure.** An element id is a
  qualname, so a `@typing.overload` stack or a `def` redefined under
  `if TYPE_CHECKING` collides. `@property` plus `@x.setter` is disambiguated by role
  and is fine. Extraction refuses rather than silently letting one definition shadow
  its twin — it names the offending files, and you `--exclude` them. The same
  applies to a module and a function sharing a name, which is why the quickstart
  excludes `pip/_internal/main.py`: `pip._internal.main` is both.
- **The whole-codebase view is dense.** It is structurally correct, but a few hundred
  boxes lay out as a wide ribbon you have to zoom to read, and at that zoom a member
  row is too small to click reliably. The `package` level is the usable way to look
  at a whole codebase.
- **`extractedAt` defeats byte-comparison of models.** Delta output is stable, but
  two extractions of the same ref never compare equal as bytes; strip the field
  first if you need that.
- **Cache filenames embed every `--exclude` glob**, so a long exclude list can exceed
  the filesystem's name limit.

## Development

```bash
npm test                      # 351 unit and integration tests
npm run build                 # tsc -b across the workspace
npm run typecheck -w @arcdiff/viewer
```

The suite needs no checkout of anything: the view-model tests run against pruned
model fixtures committed under `packages/view-model/src/__fixtures__/`.

Two suites are opt-in because they drive the real pipeline against a real codebase:

```bash
# the extractor, against a pip checkout
ARCDIFF_E2E_REF=1 ARCDIFF_REF_REPO=~/src/pip npm test

# the viewer, end to end
cd packages/viewer && ARCDIFF_REF_REPO=~/src/pip npx playwright test
```

`ARCDIFF_E2E=required` turns any skipped prerequisite into a hard failure — the lever
CI should pull, so a broken toolchain cannot masquerade as a green run.

> If every `node`/`npm`/`npx` command dies with `MODULE_NOT_FOUND` from
> `internal/preload`, check `echo $NODE_OPTIONS`; a stale `--require` breaks every
> invocation and looks like total repo breakage.

### Regenerating the fixtures

The committed fixtures are pruned extractions of [pip](https://github.com/pypa/pip)
(MIT). Two ref pairs:

| Fixture | Range | Shape |
|---|---|---|
| `__fixtures__/` | `bfaabbcc0..f451950e6` | 124 changed elements, 54 signals, 27 files |
| `__fixtures__/commit2/` | `0a0c8780d..f9366da68` | a deleted module; 6 removed, 0 added, 0 signals |

```bash
node packages/cli/dist/index.js diff --repo ~/src/pip --subdir src \
  --base bfaabbcc0 --head f451950e6 --python python3.14 \
  --exclude 'pip/_vendor/**' --exclude 'pip/_internal/main.py' \
  --out /tmp/delta.json

node scripts/prune-fixture.mjs /tmp/delta.json packages/view-model/src/__fixtures__
```

`prune-fixture.mjs` keeps every element in a touched file, one import hop as bare
module nodes, and the inheritance closure of every kept type. After regenerating,
rewrite `source.repoRoot` and `source.*.modelPath` in the emitted `delta.json` to
placeholders — they otherwise record absolute paths from your machine — and
re-measure the counts the fixture tests pin.

## Licence

MIT. See `LICENSE`.

The `__fixtures__` directories contain pruned extractions and `git diff` output from
[pip](https://github.com/pypa/pip), which is MIT-licensed; see `NOTICE`.
