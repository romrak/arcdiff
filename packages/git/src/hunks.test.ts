import { describe, it, expect } from 'vitest'
import { parseUnifiedDiff, overlaps, parseChangedLines } from './hunks.js'

describe('parseUnifiedDiff', () => {
  it('reads the new-side start and length from a hunk header', () => {
    const d = [
      'diff --git a/app/m.py b/app/m.py',
      'index 111..222 100644',
      '--- a/app/m.py',
      '+++ b/app/m.py',
      '@@ -10,3 +12,5 @@',
    ].join('\n')
    expect(parseUnifiedDiff(d)).toEqual([{ file: 'app/m.py', newStart: 12, newEnd: 16 }])
  })

  it('treats an omitted length as 1', () => {
    const d = ['--- a/app/m.py', '+++ b/app/m.py', '@@ -10 +12 @@'].join('\n')
    expect(parseUnifiedDiff(d)).toEqual([{ file: 'app/m.py', newStart: 12, newEnd: 12 }])
  })

  it('handles a pure deletion, where new-side length is 0', () => {
    const d = ['--- a/app/m.py', '+++ b/app/m.py', '@@ -10,4 +9,0 @@'].join('\n')
    expect(parseUnifiedDiff(d)).toEqual([{ file: 'app/m.py', newStart: 9, newEnd: 9 }])
  })

  it('attributes hunks to the right file across several files', () => {
    const d = [
      '--- a/app/a.py', '+++ b/app/a.py', '@@ -1,2 +1,3 @@',
      '--- a/app/b.py', '+++ b/app/b.py', '@@ -5,1 +6,2 @@',
    ].join('\n')
    expect(parseUnifiedDiff(d)).toEqual([
      { file: 'app/a.py', newStart: 1, newEnd: 3 },
      { file: 'app/b.py', newStart: 6, newEnd: 7 },
    ])
  })

  it('ignores a section header after the closing @@', () => {
    const d = ['--- a/app/m.py', '+++ b/app/m.py', '@@ -10,3 +12,5 @@ def run(self):'].join('\n')
    expect(parseUnifiedDiff(d)[0]).toMatchObject({ newStart: 12, newEnd: 16 })
  })

  it('skips a deleted file, whose new side is /dev/null', () => {
    const d = ['--- a/app/gone.py', '+++ /dev/null', '@@ -1,5 +0,0 @@'].join('\n')
    expect(parseUnifiedDiff(d)).toEqual([])
  })

  it('returns an empty array for empty input', () => {
    expect(parseUnifiedDiff('')).toEqual([])
  })
})

describe('overlaps', () => {
  const h = { file: 'app/m.py', newStart: 10, newEnd: 20 }
  it('is true when the element contains the hunk', () => {
    expect(overlaps([1, 100], h)).toBe(true)
  })
  it('is true when they partially intersect at the top', () => {
    expect(overlaps([1, 12], h)).toBe(true)
  })
  it('is true when they touch on a single line', () => {
    expect(overlaps([20, 30], h)).toBe(true)
  })
  it('is false when the element ends before the hunk', () => {
    expect(overlaps([1, 9], h)).toBe(false)
  })
  it('is false when the element starts after the hunk', () => {
    expect(overlaps([21, 30], h)).toBe(false)
  })
})

const diff = (body: string): string => body.replace(/^\n/, '')

describe('parseChangedLines', () => {
  it('ignores context lines so -U3 does not reach into a neighbour', () => {
    const text = diff(`
diff --git a/m.py b/m.py
--- a/m.py
+++ b/m.py
@@ -8,7 +8,7 @@ class Thing:
     c1
     c2
     c3
-    old
+    new
     c4
     c5
     c6
`)
    const [f] = parseChangedLines(text)
    // Line 11 only. NOT 8-14, which the @@ header spans.
    expect(f!.head).toEqual([{ start: 11, end: 11 }])
    expect(f!.base).toEqual([{ start: 11, end: 11 }])
  })

  it('merges adjacent changed lines into one span', () => {
    const text = diff(`
diff --git a/m.py b/m.py
--- a/m.py
+++ b/m.py
@@ -1,0 +2,3 @@
+a
+b
+c
`)
    expect(parseChangedLines(text)[0]!.head).toEqual([{ start: 2, end: 4 }])
  })

  it('anchors a pure deletion on the head side', () => {
    const text = diff(`
diff --git a/m.py b/m.py
--- a/m.py
+++ b/m.py
@@ -10,2 +9,0 @@
-gone
-also
`)
    const [f] = parseChangedLines(text)
    expect(f!.base).toEqual([{ start: 10, end: 11 }])
    // No head line exists, so anchor where the text used to sit. Git's
    // `+9,0` already means "after new line 9" — 9 is the anchor, not 8.
    expect(f!.head).toEqual([{ start: 9, end: 9 }])
  })

  it('anchors a pure deletion identically at -U0 and -U3', () => {
    // Deleting old lines 10-11 from a 14-line file, rendered at both widths
    // by real `git diff`. Git's `+9,0` already means "after new line 9", so
    // both widths must anchor head at 9 — not 8, which double-subtracts when
    // no body line advances newLine past the header's own value. This is the
    // test that would have caught the earlier -U0-only anchor bug.
    const u0 = diff(`
diff --git a/m.py b/m.py
--- a/m.py
+++ b/m.py
@@ -10,2 +9,0 @@ l9
-l10
-l11
`)
    const u3 = diff(`
diff --git a/m.py b/m.py
--- a/m.py
+++ b/m.py
@@ -7,8 +7,6 @@ l6
 l7
 l8
 l9
-l10
-l11
 l12
 l13
 l14
`)
    const [f0] = parseChangedLines(u0)
    const [f3] = parseChangedLines(u3)
    expect(f0!.head).toEqual([{ start: 9, end: 9 }])
    expect(f0!.head).toEqual(f3!.head)
    expect(f0!.base).toEqual(f3!.base)
  })

  it('does not anchor a deletion that a + line replaces', () => {
    const text = diff(`
diff --git a/m.py b/m.py
--- a/m.py
+++ b/m.py
@@ -100,3 +100,3 @@ class Thing:
     ctx
-    old
+    new
`)
    const [f] = parseChangedLines(text)
    // 101 only. NOT 100 — that line is unchanged and may belong to a
    // different element, which on the real fixture flips a class from
    // 'contains' to 'direct'.
    expect(f!.head).toEqual([{ start: 101, end: 101 }])
    expect(f!.base).toEqual([{ start: 101, end: 101 }])
  })

  it('still anchors a deletion at the end of a hunk with earlier additions', () => {
    const text = diff(`
diff --git a/m.py b/m.py
--- a/m.py
+++ b/m.py
@@ -10,2 +10,2 @@
+added
 ctx
-gone
`)
    const [f] = parseChangedLines(text)
    // Trace: '+added' -> head 10, newLine 11. ' ctx' -> oldLine 11, newLine 12.
    // '-gone' -> base 11, pending. flush -> head anchor max(1, 12-1) = 11.
    // An earlier '+' does NOT excuse a later, unrelated deletion: the context
    // line settles the run before the '-' begins.
    expect(f!.head).toEqual([{ start: 10, end: 11 }])
    expect(f!.base).toEqual([{ start: 11, end: 11 }])
  })

  it('does not mistake a removed line of dashes for a file header', () => {
    const text = diff(`
diff --git a/m.py b/m.py
--- a/m.py
+++ b/m.py
@@ -1,2 +1,2 @@
--- not a header
+++ also not a header
`)
    const files = parseChangedLines(text)
    expect(files).toHaveLength(1)
    expect(files[0]!.file).toBe('m.py')
    expect(files[0]!.head).toEqual([{ start: 1, end: 1 }])
    expect(files[0]!.base).toEqual([{ start: 1, end: 1 }])
  })

  it('uses the old path for a deleted file', () => {
    const text = diff(`
diff --git a/gone.py b/gone.py
--- a/gone.py
+++ /dev/null
@@ -1,1 +0,0 @@
-x
`)
    expect(parseChangedLines(text)[0]!.file).toBe('gone.py')
  })
})
