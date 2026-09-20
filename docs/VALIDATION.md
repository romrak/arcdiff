# arcdiff validation

Measured numbers, not claims. Everything below was produced by running the
committed code against a public codebase and recording what came out.

## Environment

| | |
|---|---|
| Date | 2026-09-20 |
| Machine | macOS 26.6.2, arm64 |
| Node | v25.8.0 |
| Interpreter | `python3.14` — Python 3.14 |
| Language server | `pyright-langserver` (pyright 1.1.411) |
| Reference codebase | [pip](https://github.com/pypa/pip), analysis root `src/` |
| Range | `bfaabbcc0..f451950e6` — twelve commits, 2026-07-06 to 2026-07-17 |

pip is a useful subject for three reasons: it vendors its dependencies, so
pyright resolves the whole tree with no virtualenv; its packages nest four deep,
so the package-level view has something to show; and it contains real `ABC` and
`Protocol` hierarchies with in-repo implementers, so inheritance edges are not
all external.

## Command

```bash
arcdiff diff --repo ~/src/pip --subdir src \
  --base bfaabbcc0 --head f451950e6 --python python3.14 \
  --exclude 'pip/_vendor/**' --exclude 'pip/_internal/main.py'
```

Both exclusions are explained under **Known gaps**.

## Extraction

| Measure | Base `bfaabbcc0` | Head `f451950e6` |
|---|---|---|
| Files parsed | 154 | 155 |
| Files failed | 0 | 0 |
| Base sites attempted | 177 | 186 |
| … resolved in-repo | 117 | 126 |
| … external (stdlib, site-packages, stubs) | 46 | 46 |
| … landed in-repo but not on a definition | 1 | 1 |
| … landed in a file that was not analysed | 13 | 13 |
| … unresolved | 0 | 0 |
| … definition request failed | 0 | 0 |

**Zero unresolved** is the number that matters: every base class expression
either resolved to a definition or was correctly identified as external. The 13
"not analysed" are bases that resolve into `pip/_vendor`, which `--exclude`
keeps out of the model by design. The single "not a definition" is one base
expression whose definition site is not a `class` statement.

## Model

| Measure | Base `bfaabbcc0` | Head `f451950e6` |
|---|---|---|
| Elements | 2527 | 2570 |
| — module | 154 | 155 |
| — class | 233 | 242 |
| — interface | 11 | 11 |
| — method | 1055 | 1071 |
| — function | 518 | 525 |
| — field | 556 | 566 |
| Edges | 3205 | 3265 |
| — contains | 2373 | 2415 |
| — imports | 715 | 724 |
| — extends | 105 | 113 |
| — implements | 12 | 13 |

Packages: 22, nested up to `pip._internal.resolution.resolvelib`. Every one of
the 22 is also a module id, because every directory has an `__init__.py` —
which is why package box ids carry a `pkg:` prefix.

## Delta and signals

| Measure | Value |
|---|---|
| Element changes | 124 (79 modified, 44 added, 1 removed) |
| — modified, body only | 73 |
| — modified, signature changed | 6 |
| — added | 44 (17 method, 10 field, 9 class, 7 function, 1 module) |
| Edge changes | 62 (61 added, 1 removed) |
| Signals | 54 |
| — `new-peer` | 25 |
| — `new-member` | 22 |
| — `signature-changed` | 6 |
| — `new-implementation` | 1 |

The single `new-implementation` is the signal worth the whole exercise:
`VenvBuildEnvironment`, a new class in a new module, implements the existing
`BuildEnvironment` interface. A third implementer of that interface now exists
where there were two — a fact no text diff states anywhere.

## Timings

| Run | Wall time |
|---|---|
| Cold extraction, one ref (155 files) | 4.9 s |
| Cold diff, two refs, empty cache | 9.6 s |
| Cached diff, two refs, warm cache | 0.2 s |

Extraction is dominated by pyright answering one `textDocument/definition`
request per base class expression. It scales with the number of base sites, not
with the size of the change.

## Determinism

Two consecutive `diff` runs over the same refs produce byte-identical
`delta.json`, verified with `cmp`. Element and edge ordering is fixed by
`compareIds` rather than by traversal order.

Model files are *not* byte-comparable across runs — see **Known gaps**.

## Fixtures

Both committed fixtures are pruned extractions of pip. `scripts/prune-fixture.mjs`
keeps every element in a touched file, one import hop as bare module nodes, and
the inheritance closure of every kept type.

| | `__fixtures__/` | `__fixtures__/commit2/` |
|---|---|---|
| Range | `bfaabbcc0..f451950e6` | `0a0c8780d..f9366da68` |
| Elements, base / head | 1214 / 1257 | 302 / 296 |
| Element changes | 124 | 15 (9 modified, 6 removed) |
| Signals | 54 | 0 |
| Interfaces in head | 9, five with a subclass | — |

The second fixture is the opposite shape on purpose: `f9366da68` ("Remove
setup.py develop code path") deletes
`pip/_internal/operations/install/editable_legacy.py` outright and adds nothing
anywhere. It is what exercises the removed-element path, where every line range
and every sibling set has to come from the *base* model because head no longer
holds the file.

Note that its head model is a real, populated codebase of 296 elements rather
than an empty one. That matters: a bug reading sibling sets from head instead of
base cannot hide behind an empty model.

### The span-exclusion tradeoff

The second fixture is what exposes a deliberate coarseness in attribution.

`git diff` collapses a whole-file deletion into ONE hunk span — `{1,48}` here —
covering the deleted module's entire attribution range. In `attributeChanges`,
`own = covering.filter(s => !narrower.some(overlap))` disqualifies a span in its
**entirety** the moment any narrower sibling overlaps any part of it; it does not
subtract only the overlapping lines. So the module is demoted to `contains` even
for lines 1–12 — imports and the module docstring, before the first member at
line 13 — which no sibling touches at all.

This is a tradeoff, not a bug. Per-line exclusion (splitting a span at every
narrower sibling's boundary) would spuriously flip a container to `direct` on any
of its own lines that a narrower sibling's range does not technically enclose — a
trailing blank line still inside a claimed span, say. Span-level all-or-nothing
exclusion avoids that at the cost of the coarseness above. The maximal shape of a
whole-file deletion is simply what makes the cost visible. Do not "fix" it without
re-litigating the choice.

## Automated coverage

351 tests across 30 files, all passing. The view-model and viewer tests run
against the committed fixtures and need no checkout. Two suites are opt-in
because they drive the real pipeline against a real repository:

- `packages/cli/src/e2e.test.ts` reference block — `ARCDIFF_E2E_REF=1` plus
  `ARCDIFF_REF_REPO`. Asserts properties, never counts, because the upstream
  repo moves: every file parses, bases resolve in-repo, and nearly every in-root
  base lands on a definition line.
- `packages/viewer/e2e/viewer.spec.ts` — Playwright against a live
  `arcdiff serve`, with `ARCDIFF_REF_REPO` set.

The viewer e2e deliberately drives a *narrower* commit (`790ae56bb`, 35 changed
elements) than the fixtures. At the 83-box canvas the wider range produces, a
member row is under a pixel tall at fit-view zoom and a click aimed at one row
lands on its neighbour — see **Known gaps**.

## Known gaps

- **`extractedAt` defeats byte-comparison of models.** Delta output is stable,
  but two independently extracted models of the same ref never compare equal as
  bytes. Anything diffing model files directly must strip the field first.

- **A same-name redefinition in one scope is a hard failure.** `extractModel`
  refuses a model whose element ids are not unique, naming the offenders.
  `@property` plus `@x.setter`/`@x.deleter`/`@x.getter` are disambiguated by role
  and do not trip it, but a `@typing.overload` stack or a `def` redefined under
  `if TYPE_CHECKING:` would — several defs share one qualname with nothing to
  tell them apart. Refusing is deliberate: a duplicate id shadows its twin in
  BOTH models and reports the survivor's fields as a change that never happened.
  Until those defs are given a role of their own, the affected file has to be
  `--exclude`d.

  A module and a member can collide the same way. pip has exactly one:
  `pip._internal.main` is both `main.py` and a function in `__init__.py`, hence
  the `--exclude pip/_internal/main.py` above.

- **A removed element has no box on the canvas.** The box tree is built from the
  head model, so a removed element is present in `delta.json` and in the
  attribution map but has nowhere to be drawn. Of the 124 changed elements here,
  123 carry a marker on the canvas and the one removed method does not.

- **The whole-codebase view is dense.** Structurally correct, but the working-set
  view of this range is 83 boxes laid out as a wide ribbon, and at the zoom
  `fitView` picks, member rows are too small to hit. The `package` level — 21
  boxes for pip, 8 of them tinted for the range the e2e drives — is the usable
  way to look at a whole codebase.

- **Cache filenames embed every `--exclude` glob.** A long exclude list produces a
  filename that exceeds the filesystem limit and the run fails with
  `ENAMETOOLONG`.

- **The analysis root is load-bearing and easy to get wrong.** Module ids are
  formed relative to `--subdir`, so it must be the directory that makes import
  statements resolvable. Rooting pip at `src/pip` rather than `src/` leaves the
  modules intact but collapses the import graph from 739 edges to 35, and in-repo
  base resolution from 127 to 46. Nothing warns you; the model just comes out
  thin.
