# X Task Panel Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the Lighthouse task panel visible after a reservation while X renders variant DOM and the reserved task reaches the extension cache late.

**Architecture:** Reuse the existing focused-panel reconciler and background task snapshot. Make action-row discovery tolerant of X DOM variants, add a focused-route host recovery timer, and keep the task component in a bounded loading window until the reserved task arrives or an actionable timeout appears.

**Tech Stack:** TypeScript, React 19, WXT, Chrome MV3 messaging, Vitest, happy-dom

---

### Task 1: Recover the focused panel host across X DOM variants

**Files:**
- Modify: `src/entrypoints/content.ts`
- Test: `src/entrypoints/__tests__/task-verification-panel-host.test.ts`

- [ ] **Step 1: Write failing action-row and recovery tests**

Add a fixture whose action buttons share a container without `role="group"` and assert that `scanTimeline()` mounts `.lhdao-inline-task`. Add a timer test that removes the host while the route remains `/status/<id>`, advances the focused recovery interval, and asserts that the same host is reattached.

```ts
it('mounts beside X action buttons when role=group is absent', async () => {
  document.body.innerHTML =
    '<article><a href="/user/status/123456"><time>Now</time></a><div data-controls><button data-testid="reply">Reply</button><button data-testid="like">Like</button></div></article>'
  await act(async () => scanTimeline())
  expect(panel()?.textContent).toContain('评论')
})

it('restores a detached host while the focused route stays open', async () => {
  vi.useFakeTimers()
  await act(async () => scanTimeline())
  const host = document.querySelector('.lhdao-inline-task')!
  host.remove()
  await act(async () => vi.advanceTimersByTime(2_000))
  expect(document.querySelector('.lhdao-inline-task')).toBe(host)
})
```

- [ ] **Step 2: Run the focused host tests and verify RED**

Run:

```bash
pnpm test src/entrypoints/__tests__/task-verification-panel-host.test.ts
```

Expected: the role-less action-row case fails because the current reconciler requires `[role="group"]`; the timer case fails because no focused host recovery interval exists.

- [ ] **Step 3: Add minimal action-row discovery and host recovery**

In `content.ts`, add a helper that stays within the focused article:

```ts
function findTweetActionRow(article: Element): Element | null {
  const groups = article.querySelectorAll('[role="group"]')
  for (const group of groups) {
    if (group.querySelector('[data-testid="reply"], [data-testid="retweet"], [data-testid="unretweet"], [data-testid="like"], [data-testid="unlike"]')) {
      return group
    }
  }
  const buttons = [...article.querySelectorAll('[data-testid="reply"], [data-testid="retweet"], [data-testid="unretweet"], [data-testid="like"], [data-testid="unlike"]')]
  if (buttons.length === 0) return null
  let row: Element | null = buttons[0].parentElement
  while (row && row !== article && !buttons.every((button) => row?.contains(button))) {
    row = row.parentElement
  }
  return row === article ? buttons[0].parentElement : row
}
```

Use the helper in `reconcileFocalTaskHost()`. In content-script startup, add a 2-second interval that calls `scheduleScan()` only when a detail route is active and the focused host is missing or detached. Clear the interval when the content script context is invalidated.

- [ ] **Step 4: Run the focused host tests and verify GREEN**

Run:

```bash
pnpm test src/entrypoints/__tests__/task-verification-panel-host.test.ts
```

Expected: all focused host tests pass.

- [ ] **Step 5: Commit Task 1**

```bash
git add -- src/entrypoints/content.ts src/entrypoints/__tests__/task-verification-panel-host.test.ts
git commit -m "fix: recover X task panel host"
```

### Task 2: Wait for late reserved-task synchronization

**Files:**
- Modify: `src/components/sidebar/CurrentTaskSection.tsx`
- Test: `src/components/sidebar/__tests__/CurrentTaskSection.test.tsx`

- [ ] **Step 1: Write failing late-arrival and timeout tests**

Use fake timers with an initially empty snapshot. Assert that the panel still shows a synchronization state after 2.6 seconds, performs another `force-sync` at 7 seconds, renders the task when it arrives at 15 seconds, and shows a retryable “未同步到已接任务” state when the final empty snapshot completes.

```ts
it('keeps syncing until a reserved task arrives after the old retry window', async () => {
  vi.useFakeTimers()
  const reservedTask = { ...rows[0], reserved: true }
  rows = []
  await render()
  await act(async () => vi.advanceTimersByTime(7_000))
  expect(container.textContent).toContain('正在同步已接任务')
  rows = [reservedTask]
  await act(async () => vi.advanceTimersByTime(8_000))
  expect(container.textContent).toContain('评论')
})

it('shows a retry action after the reserved task arrival window expires', async () => {
  vi.useFakeTimers()
  rows = []
  await render()
  await act(async () => vi.advanceTimersByTime(15_000))
  expect(container.textContent).toContain('未同步到已接任务')
  expect(container.textContent).toContain('重新同步')
})
```

- [ ] **Step 2: Run the task-section tests and verify RED**

Run:

```bash
pnpm test src/components/sidebar/__tests__/CurrentTaskSection.test.tsx
```

Expected: tests fail because the current component marks an empty ready snapshot as final and stops retries after 2.6 seconds.

- [ ] **Step 3: Implement the bounded task-arrival window**

Replace the old `[400, 1200, 2600]` cache-read timers with force-sync attempts at `[1_000, 3_000, 7_000, 15_000]`. Keep `status='loading'` for empty snapshots until the last attempt. Add a distinct `missing` status after the final empty result and render:

```tsx
<section className="lh-cur-sec">
  <div className="lh-cur-card lh-cur-guide" role="status">
    未同步到已接任务
    <button type="button" className="lh-cur-btn on" onClick={retry}>
      重新同步
    </button>
  </div>
</section>
```

Change the loading copy to “正在同步已接任务”. A manual retry increments `reloadVersion`, which starts a fresh bounded window. Cleanup cancels every timer on account or route changes and unmount.

- [ ] **Step 4: Run the task-section tests and verify GREEN**

Run:

```bash
pnpm test src/components/sidebar/__tests__/CurrentTaskSection.test.tsx
```

Expected: all task-section tests pass, including existing RPC-error and account-change cases.

- [ ] **Step 5: Commit Task 2**

```bash
git add -- src/components/sidebar/CurrentTaskSection.tsx src/components/sidebar/__tests__/CurrentTaskSection.test.tsx
git commit -m "fix: wait for reserved X task sync"
```

### Task 3: Verify and publish to dev

**Files:**
- Modify only if verification exposes a defect in the scoped changes.

- [ ] **Step 1: Run focused regression tests**

```bash
pnpm test src/entrypoints/__tests__/task-verification-panel-host.test.ts src/components/sidebar/__tests__/CurrentTaskSection.test.tsx src/lib/__tests__/guide-state.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 2: Run full static and behavioral verification**

```bash
pnpm typecheck
pnpm test
pnpm lint
git diff --check origin/dev...HEAD
```

Expected: every command exits with status 0.

- [ ] **Step 3: Build and verify all browser manifests**

```bash
pnpm build
pnpm build:edge
pnpm build:firefox
pnpm verify:manifests
```

Expected: Chrome, Edge, and Firefox MV3 builds succeed and manifests pass verification.

- [ ] **Step 4: Rebase on the latest remote dev and rerun focused checks**

```bash
git fetch origin dev
git rebase origin/dev
pnpm test src/entrypoints/__tests__/task-verification-panel-host.test.ts src/components/sidebar/__tests__/CurrentTaskSection.test.tsx
```

Expected: rebase succeeds without unrelated changes and focused tests remain green.

- [ ] **Step 5: Push without force and verify the remote SHA**

```bash
git push origin HEAD:dev
test "$(git rev-parse HEAD)" = "$(git ls-remote origin refs/heads/dev | cut -f1)"
```

Expected: push succeeds and the remote `dev` SHA exactly matches local `HEAD`.
