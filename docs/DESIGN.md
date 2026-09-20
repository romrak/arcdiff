# arcdiff design

Why the pieces are shaped the way they are. `README.md` covers what the tool does
and how to run it; `VALIDATION.md` records what it measured.

## The premise

A code review answers two questions that live at different altitudes. *What did
this line become?* is a text question, and `git diff` answers it perfectly. *What
did this system become?* is a structural question, and no text diff can answer it,
because the evidence is spread across files the commit never touched: the interface
the new class implements, the callers of the method whose signature moved, the
sibling services a new one now stands beside.

arcdiff answers the second question and hands you straight back to the first. It
does not summarise, score or explain. Every claim it makes is one you can click
into and check against the actual diff.

## Two passes, because neither is sufficient

Structure comes from a Python `ast` walk: modules, classes, methods, functions,
module- and class-level assignments (as `field`), decorators, signatures,
`@abstractmethod` markers. This is fast, exact and entirely local.

What a local pass cannot do is resolve `class Foo(Bar)` when `Bar` was imported
from somewhere else. So a second pass asks pyright, over LSP, for the definition
site of every base class expression, and maps that site back to an element. The
result is that inheritance edges point at *elements*, not at names — which is what
makes "this new class implements that existing interface" a fact the tool can
state rather than a string match.

The cost is one `textDocument/definition` round trip per base expression, and it
is what dominates extraction time. It scales with the number of classes in the
codebase, not with the size of the change.

### Why an element id is a qualname

`diffModels` builds `new Map(elements.map(e => [e.id, e]))` for both sides. The id
is the *only* key the entire diff rests on, so two elements sharing one makes one
of them invisible and turns the other's fields into a change that never happened.

A dotted qualname — `pip._internal.network.auth.KeyRingCliProvider._get_creds` —
is stable across reformatting, readable in a diff, and cheap to compute. It has one
structural weakness: Python lets several definitions share a qualname. A
`@property` and its `@x.setter` are the common case, and they are disambiguated by
role (`….setter`). A `@typing.overload` stack is the uncommon case, and nothing
distinguishes its members at all.

Extraction therefore *refuses* a model with duplicate ids and names the offending
files, rather than letting one definition silently shadow its twin. Refusing is the
design: a wrong answer here is invisible and poisons everything downstream.

`MODEL_SCHEMA_VERSION` exists for the same reason. The id rule changed three times
during development while the extraction cache was keyed only on
`(sha, subdir, interpreter, excludes)` — so a cache written by an older build was
served forever against a new-rule model, which reads every element as added *and*
removed. The version is part of the cache key now.

### Why `decoratorStart` is not folded into `range`

A decorated element's *attribution* range must reach up to its first decorator, or
changing `@staticmethod` to `@classmethod` marks the enclosing class instead of the
method.

The obvious implementation — widen `range[0]` to the decorator line — breaks base
resolution. `buildDefIndex` keys on `range[0]`, and pyright answers a base-class
lookup with the *name token* line. Widening the range moves the key off the line
the server reports, and every decorated class in the corpus silently loses its
`extends`/`implements` edge. The canary would not catch it either: it only proves
the server resolves *something*, and undecorated classes keep resolving fine.

So the decorator line is a separate field, read only by attribution.

## Attribution: `direct` versus `contains`

An element is **`direct`** when a changed line falls inside its attribution range
and inside **no narrower element in the same file**. Otherwise, if a descendant
changed, it is **`contains`**.

The naive alternative — mark every element whose range covers a changed line —
lights up every ancestor of every edit, so a one-line change inside one method
marks the method, its class, its module and every package above it. The marking
then carries no information.

The rejected refinement was "a container is changed only when no child is", which
fails the other way: it hides a container that has both its own change *and* a
changed child, which is exactly what a refactor looks like.

Three further rules, each because the general one gets it wrong:

- An **added** element is `direct` unconditionally. It has no base-side range to
  intersect and its lines are new by definition.
- A change to a **compared field** (`kind`, `parent`, `package`, `abstract`,
  `signature`) is `direct` unconditionally. A signature change may come from an
  edit that git attributes to a different line.
- A **removed** element takes its range *and its sibling set* from the base model.
  Head no longer holds the file, so a head-sourced read finds nothing narrower and
  wrongly promotes every container to `direct`.

The exclusion is span-level, not line-level: a hunk span is disqualified in its
entirety the moment any narrower sibling overlaps any part of it. `VALIDATION.md`
documents where that shows, and why per-line exclusion would be worse.

## Signals

Signals are the observations worth surfacing without being asked. Each is a
mechanical consequence of the model — none is a heuristic.

| Signal | Fires when |
|---|---|
| `new-interface` | An added element classifies as an interface |
| `new-implementation` | An added `extends`/`implements` edge points at an interface |
| `new-member` | An added element's parent already existed in base |
| `signature-changed` | A surviving element's `signature` differs |
| `unimplemented-contract` | An implementer does not define all of its interface's abstract methods |
| `new-peer` | An added element joins existing siblings, with the count |

`unimplemented-contract` is the one that justifies the whole LSP pass. It asks
"does this implementer define every abstract method of its interface, *now*" —
which catches both a new implementer that forgot one and an existing implementer
that an interface change left behind. The evidence lives in files the commit did
not touch, so a text diff structurally cannot produce it.

An element is classified as an **interface** when a base resolves *outside* the
repo to `ABC` or `Protocol`, or when it declares at least one `@abstractmethod`.
The out-of-repo condition matters: a user class that happens to be named `ABC` is
an ordinary class.

### Peer scope

A method's or field's peers are its siblings on the owning class — not every
member of its package. Package-scoped peers put one changed method alongside
hundreds of unrelated ones and tell a reviewer nothing. Above a threshold the count
is rendered as an order of magnitude ("50+"), because an exact count of a crowded
module is not information; the precise number survives in `delta.json` for any
consumer that wants it.

## The canvas

Two controls, answering different questions.

**Collapse** folds a box *into its parent*: the box and its subtree leave the
canvas and are represented by the nearest unfolded ancestor. This is the "I have
seen this one, get it out of my way" gesture. It is not a one-way door — the
surviving parent carries a `⊞N` affordance. A root is never folded whatever the
collapse set says, because the undo lives on the parent and a root has none.

**Detail** is the zoom axis, and it is the bulk control. A level draws no box below
itself, and — the rule that makes it worth having — a level coarser than `member`
renders every box *at or above* it, not just the ancestors of the working set.
Filtering alone would leave only the packages that happen to contain a change;
zooming out is what turns a working-set view into a whole-codebase view, and
showing a new service beside its existing siblings was the point of building this.

The level scale is deliberately kept separate from the list of *selectable* levels.
Deriving the scale from the selectable list makes dropping one silently renumber
the rest, and the default view then collapses to a handful of boxes that look like
a rendering bug rather than arithmetic.

Edges are drawn only between two elements the reviewer actually pulled onto the
canvas. Without that restriction, dropping to `package` rolls every structural edge
in the codebase onto the package boxes and lays out as a hairball that says
nothing.

## What was left out

- **No AI.** Not a technical limitation — the whole point is that the reviewer does
  the reviewing. A generated summary is one more thing to verify.
- **No rename detection.** A rename reads as a remove plus an add. Similarity
  detection is a later addition, not a v1 requirement.
- **No working-tree diffs.** Committed refs only, so every run is reproducible.
- **One language.** The extractor interface is shaped for more — `Lang` already
  admits `kotlin` and `typescript` — but shipping one that works beat shipping
  three that half-work.
