# Task Verification Panel Remount Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the X task verification panel visible when task data arrives late or X replaces the focused tweet controls.

**Architecture:** Give the focused-tweet panel one lifecycle independent of task-highlight mounts. Reconcile its host during every timeline scan, moving the existing host across X DOM replacements and unmounting it only when the focused tweet changes.

**Tech Stack:** TypeScript, React 19, WXT content scripts, Vitest, happy-dom

---

### Task 1: Stabilize the focused-tweet verification panel

**Files:**
- Create: `src/entrypoints/__tests__/task-verification-panel-host.test.ts`
- Modify: `src/entrypoints/content.ts`

- [x] **Step 1: Write the failing regression tests**

Create a focused content-script test that supplies a matching task, calls
`scanTimeline()`, replaces the action-row DOM, calls `scanTimeline()` again,
and asserts that the same `.lhdao-inline-task` host and React section are
reattached. Add cases for late controls and leaving the detail route.

- [x] **Step 2: Run the test and verify the current code fails**

Run: `pnpm test src/entrypoints/__tests__/task-verification-panel-host.test.ts`

Expected: FAIL because the current panel belongs to the first article mount;
after X replaces its controls, no scan path reattaches the detached host.

- [x] **Step 3: Implement the minimum host reconciliation**

Export `scanTimeline()` and `unmountAll()` for the regression test. Add one
module-level `focalTaskHost`. At the start of every scan, call
`reconcileFocalTaskHost()` to:

```ts
const tweetId = getFocalTweetId()
const article = findLastRenderableArticle(tweetId)
const actionRow = article?.querySelector('[role="group"]')

if (focalTaskHost?.tweetId === tweetId) {
  if (article && actionRow?.parentElement) {
    actionRow.parentElement.insertBefore(focalTaskHost.host, actionRow.nextSibling)
    focalTaskHost.article = article
  } else {
    focalTaskHost.host.remove()
  }
  return
}
```

When the tweet ID changes, unmount the old root and remove its host. Create a
new host only when the focused article and action row exist. Remove the old
inline-card creation from `mountArticle()` so only the reconciler owns it.
Clean up `focalTaskHost` in `unmountAll()`.

- [x] **Step 4: Run the focused tests and verify they pass**

Run: `pnpm test src/entrypoints/__tests__/task-verification-panel-host.test.ts src/lib/__tests__/guide-state.test.ts`

Expected: both files pass with zero failed tests.

- [x] **Step 5: Run repository verification**

Run: `pnpm typecheck`, `pnpm test`,
`pnpm exec biome check src/entrypoints/content.ts src/entrypoints/__tests__/task-verification-panel-host.test.ts`,
and `pnpm build`.

Expected: all commands exit with status 0.

- [x] **Step 6: Review the scoped diff**

Run: `git diff --check -- src/entrypoints/content.ts src/entrypoints/__tests__/task-verification-panel-host.test.ts && git diff -- src/entrypoints/content.ts src/entrypoints/__tests__/task-verification-panel-host.test.ts`

Expected: no whitespace errors; the source diff contains only panel lifecycle
changes and the new regression test.
