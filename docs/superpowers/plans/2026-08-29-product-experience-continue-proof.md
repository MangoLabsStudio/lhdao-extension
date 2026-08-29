# Product Experience Continue Proof Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user explicitly continue an incomplete zkTLS rule after the backend reports `PARTIAL` or exposes its next connector as `PENDING`.

**Architecture:** Reuse the popup's existing `start-product-experience` action. Add only an incomplete-progress action predicate and label; the existing controller will recheck the active tab, reinject the watcher, and accept new evidence through the current guarded path.

**Tech Stack:** React 19, TypeScript, WXT Chrome MV3, Vitest, Biome

---

### Task 1: Render and execute the continue action

**Files:**
- Modify: `src/components/product-experience/ProductExperienceCard.tsx`
- Test: `src/entrypoints/popup/App.test.tsx`

- [ ] **Step 1: Write the failing popup tests**

Add a test that renders an observing state with backend `PARTIAL` progress,
clicks `继续证明`, and asserts that the existing start request is sent once:

```tsx
it('continues a backend PARTIAL proof through the existing start action', async () => {
  const harness = await renderPopup(
    productState('observing', {
      totalRuleCount: 1,
      zkTlsProgress: [
        {
          ruleId: 'gzip-proof',
          title: '验证 gzip 响应',
          status: 'PARTIAL',
          current: true,
          target: true,
          unit: null,
        },
      ],
    }),
  )

  const button = findButton(harness.container, '继续证明')
  await act(async () => button.click())

  await vi.waitFor(() => {
    expect(
      harness.requests.filter(
        (request) =>
          request &&
          typeof request === 'object' &&
          'type' in request &&
          request.type === 'start-product-experience',
      ),
    ).toEqual([{ type: 'start-product-experience' }])
  })
  expect(harness.container.textContent).not.toContain('重试证明')
})
```

Add a second test that renders the next connector as `PENDING`, clicks
`继续证明`, and asserts that the existing start request is sent once:

```tsx
it('continues a backend PENDING next-stage proof through the existing start action', async () => {
  const harness = await renderPopup(
    productState('observing', {
      zkTlsProgress: [
        {
          ruleId: 'gzip-proof',
          title: '验证 gzip 响应',
          status: 'PENDING',
          current: null,
          target: true,
          unit: null,
        },
      ],
    }),
  )

  const button = findButton(harness.container, '继续证明')
  await act(async () => button.click())
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm exec vitest run src/entrypoints/popup/App.test.tsx
```

Expected: the partial-state test fails because `继续证明` is not rendered;
the existing popup tests remain green.

- [ ] **Step 3: Add the minimal partial-action predicate**

In `ProductExperienceCard.tsx`, add:

```tsx
function isContinuableIncompleteProofState(
  state: ProductExperienceControllerState,
): boolean {
  return (
    state.status === 'observing' &&
    state.error === null &&
    state.currentOriginAllowed &&
    state.zkTlsProgress?.some(
      (entry) => entry.status === 'PARTIAL' || entry.status === 'PENDING',
    ) === true
  )
}
```

Keep authorization and retry actions first, then return the new label:

```tsx
if (isRetryableProofState(state)) return '重试证明'
if (isContinuableIncompleteProofState(state)) return '继续证明'
if (status === 'ready') return '开始验证'
```

Do not add a new callback or message. The button continues to call `onStart`,
which already sends `start-product-experience`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
pnpm exec vitest run src/entrypoints/popup/App.test.tsx
```

Expected: all popup tests pass, including the new partial and pending cases.

- [ ] **Step 5: Commit the behavior change**

```bash
git add src/components/product-experience/ProductExperienceCard.tsx \
  src/entrypoints/popup/App.test.tsx
git commit -m "fix(extension): continue partial zkTLS proofs"
```

### Task 2: Verify the extension and rebuild Chrome MV3

**Files:**
- Verify: `src/components/product-experience/ProductExperienceCard.tsx`
- Verify: `src/entrypoints/popup/App.test.tsx`

- [ ] **Step 1: Run Product Experience regression tests**

Run:

```bash
pnpm exec vitest run \
  src/entrypoints/popup/App.test.tsx \
  src/lib/__tests__/product-experience-controller.test.ts \
  src/lib/__tests__/product-experience-watcher.test.ts
```

Expected: all three files pass.

- [ ] **Step 2: Run full static and test gates**

Run:

```bash
pnpm test
pnpm run typecheck
pnpm exec biome check \
  src/components/product-experience/ProductExperienceCard.tsx \
  src/entrypoints/popup/App.test.tsx
git diff --check
```

Expected: all tests, type checking, formatting, and whitespace checks pass.

- [ ] **Step 3: Build the unpacked Chrome extension**

Run:

```bash
pnpm run build
```

Expected: the Chrome MV3 build succeeds at `.output/chrome-mv3` with only
the repository's existing Vite/WXT deprecation warnings.

- [ ] **Step 4: Verify the clean handoff**

Run:

```bash
git status --short --branch
git log -3 --oneline
```

Expected: the worktree is clean and the design, plan, and implementation
commits are visible. Reload `.output/chrome-mv3` in Chrome before resuming the
live two-stage proof.
