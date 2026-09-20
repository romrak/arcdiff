import { expect, test, type Page } from '@playwright/test'

/**
 * `data-layout` is three-valued: `busy`, `idle`, `error`. Waiting for `idle`
 * alone turns a real layout failure into a 30s timeout that says "expected
 * idle" and names no cause; waiting for `idle` OR `error` first, then
 * asserting `idle`, fails immediately with whatever `layout failed: …` text
 * the canvas reports instead. `idle` also guarantees React Flow's own store
 * has ingested exactly the current node ids (compared by id signature, not
 * count — see Canvas.tsx), so every `[data-box]`/`[data-state]` assertion
 * that follows is safe to make without its own extra wait.
 */
async function waitForIdleLayout(page: Page): Promise<void> {
  const canvas = page.locator('[data-pane="canvas"]')
  await expect(canvas).toHaveAttribute('data-layout', /^(idle|error)$/, { timeout: 120_000 })
  await expect(canvas).toHaveAttribute('data-layout', 'idle', { timeout: 1_000 })
}

/**
 * The minimap is a fixed overlay pinned to the bottom-right of the viewport,
 * painted above the canvas. Any box that lays out underneath it is
 * unclickable by a real mouse too, but that is a property of the MINIMAP, not
 * of the box — so hiding it here removes an obstruction rather than bypassing
 * hit-testing. Every click below still goes through the browser's real
 * hit-testing on the element itself; none of them force.
 */
async function openCanvas(page: Page): Promise<void> {
  await page.goto('/')
  await page.addStyleTag({ content: '.react-flow__minimap{display:none!important}' })
  await waitForIdleLayout(page)
}

test('shows the delta split and drills into a changed member', async ({ page }) => {
  await openCanvas(page)

  // `[data-state]`, never `[data-stat="boxes"]`: the stat reports the PLANNED
  // count and legitimately leads the DOM during layout. Measured 2026-09-20
  // against pip 790ae56bb.
  await expect(page.locator('[data-state="direct"]')).toHaveCount(17)
  await expect(page.locator('[data-state="contains"]')).toHaveCount(18)

  // A count moving proves nothing about WHICH boxes appeared — it would pass
  // even if the wrong importer showed up and a different box vanished. This
  // module is one of the importers `cmdoptions` resolves, and it is on the
  // canvas only once the badge is clicked.
  const importer = '[data-box="pip._internal.commands.freeze"]'
  await expect(page.locator(importer)).toHaveCount(0)
  await page.locator('[data-box="pip._internal.cli.cmdoptions"]')
    .locator('[data-relation="importers"]').click()
  await waitForIdleLayout(page)
  await expect(page.locator(importer)).toHaveCount(1)

  // The added field that the whole commit is about.
  await page.locator('[data-member="pip._internal.cli.cmdoptions.only_deps"]').click()
  await expect(page.locator('[data-pane="diff"]')).toContainText('+only_deps: Callable[..., Option]')
})

test('scopes the diff pane to the selected element, not the whole file', async ({ page }) => {
  await openCanvas(page)

  // Both members live in commands/install.py and the file has two separate
  // hunks — one in add_options, one in run. Selecting either must show only
  // the hunk overlapping ITS OWN attribution range. A pane that dumped the
  // whole file would pass a content check against either string alone, so
  // each assertion is paired with its negative.
  const pane = page.locator('[data-pane="diff"]')

  await page.locator('[data-member="pip._internal.commands.install.InstallCommand.add_options"]').click()
  await expect(pane).toContainText('self.cmd_opts.add_option(cmdoptions.only_deps())')
  await expect(pane).not.toContainText('check_only_deps_option_does_not_conflict(options)')

  await page.locator('[data-member="pip._internal.commands.install.InstallCommand.run"]').click()
  await expect(pane).toContainText('check_only_deps_option_does_not_conflict(options)')
  await expect(pane).not.toContainText('self.cmd_opts.add_option(cmdoptions.only_deps())')
})

test('collapse all reduces the canvas to packages', async ({ page }) => {
  await openCanvas(page)

  await page.getByRole('button', { name: 'Collapse all' }).click()
  await waitForIdleLayout(page)

  // Every package in the WHOLE head model, not just the ones holding a
  // changed element — that is what zooming out is for. The count includes
  // ancestor-only packages that buildBoxTree synthesizes and that hold no
  // element of their own. Measured 2026-09-20 against pip.
  await expect(page.locator('[data-box][data-kind="package"]')).toHaveCount(21)

  // A count alone cannot tell 21 packages rolled up correctly from 21
  // packages where `rollUpStates` regressed to an empty map. 8 is the number
  // of packages that actually contain a changed element somewhere in their
  // subtree — a DIFFERENT set from the 17/18 split above, which marks the
  // changed elements themselves rather than their package ancestors.
  await expect(page.locator('[data-rollup]')).toHaveCount(8)
})
