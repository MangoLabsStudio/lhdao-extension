# Plugin Dev Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the local plugin release baseline with remote `dev` without losing any capability already present in either workspace.

**Architecture:** Keep `origin/dev` as the functional superset. Preserve the old dirty checkout as a read-only comparison snapshot, port only the `0.2.2` release intent, and remove the embedded NUL byte without changing the runtime deduplication key.

**Tech Stack:** TypeScript, React 19, WXT MV3, Vitest, Biome, pnpm, Git.

---

### Task 1: Confirm the integration baseline

**Files:**
- Inspect: `package.json`
- Inspect: `src/entrypoints/background.ts`
- Inspect: `src/lib/product-experience-controller.ts`
- Inspect: `src/lib/request-signing.ts`
- Inspect: `scripts/verify-product-manifests.mjs`

- [ ] **Step 1: Confirm the isolated branch still starts at remote dev**

Run:

```bash
git fetch origin dev
git merge-base --is-ancestor origin/dev HEAD
git status --short --branch
```

Expected: the ancestry command exits 0; only the committed design and plan are ahead of `origin/dev`; the worktree has no unstaged product changes.

- [ ] **Step 2: Confirm old-only modules have newer dev equivalents**

Run focused symbol and file comparisons for pairing, request signing, product-experience observation, proof submission, and release manifest validation.

Expected: every old-only runtime function maps to a dev module or is an obsolete compatibility path; no runtime feature requires copying an old monolithic file.

### Task 2: Carry the 0.2.2 release intent forward

**Files:**
- Modify: `scripts/release-workflow-contract.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Change the release contract first**

Update the existing assertion to:

```ts
expect(packageJson.version).toBe('0.2.2')
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm vitest run scripts/release-workflow-contract.test.ts
```

Expected: one failure showing expected `0.2.2`, received `0.2.1`.

- [ ] **Step 3: Apply the minimum production change**

Set only the package version:

```json
"version": "0.2.2"
```

Keep the dev description, Firefox MV3 commands, manifest verification scripts, and dependency versions unchanged.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
pnpm vitest run scripts/release-workflow-contract.test.ts
```

Expected: all release workflow contract tests pass.

### Task 3: Remove the binary byte from TypeScript source

**Files:**
- Create: `scripts/source-hygiene.test.ts`
- Modify: `src/lib/guide-state.ts`

- [ ] **Step 1: Add a failing source-hygiene test**

Create:

```ts
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('source hygiene', () => {
  it('keeps guide-state as plain text source', async () => {
    const source = await readFile(
      resolve(import.meta.dirname, '../src/lib/guide-state.ts'),
      'utf8',
    )
    expect(source).not.toContain('\0')
  })
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm vitest run scripts/source-hygiene.test.ts
```

Expected: one failure because the file contains a literal NUL byte.

- [ ] **Step 3: Preserve behavior with a textual escape**

Replace the literal byte in the deduplication key with the source escape:

```ts
const dedupKey = `${t.campaignId}\0${t.actionType}`
```

At runtime this still separates the two values with NUL, but Git and editors treat the file as text.

- [ ] **Step 4: Run the focused test and guide-state tests**

Run:

```bash
pnpm vitest run scripts/source-hygiene.test.ts src/lib/__tests__/guide-state.test.ts
```

Expected: both test files pass.

### Task 4: Record the confirmed design and validate all capabilities

**Files:**
- Modify: `docs/superpowers/specs/2026-08-03-plugin-dev-consolidation-design.md`

- [ ] **Step 1: Mark the approved design confirmed**

Change the document status to:

```text
状态：已确认
```

- [ ] **Step 2: Run the complete test and static-check suite**

Run:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm test:manifests
```

Expected: every command exits 0 with no failed tests or lint errors.

- [ ] **Step 3: Build all supported browser targets**

Run:

```bash
pnpm build
pnpm build:edge
pnpm build:firefox
```

Expected: Chrome, Edge, and Firefox MV3 builds all exit 0.

- [ ] **Step 4: Review the final diff**

Run:

```bash
git diff --check
git status --short
git diff -- package.json scripts/release-workflow-contract.test.ts scripts/source-hygiene.test.ts src/lib/guide-state.ts docs/superpowers/specs/2026-08-03-plugin-dev-consolidation-design.md
```

Expected: the diff contains only the version contract, version bump, source-hygiene regression test, textual NUL escape, and confirmed design status.

### Task 5: Commit and push dev without force

**Files:**
- Commit only the files listed in Tasks 2–4 and this plan.

- [ ] **Step 1: Recheck remote dev before committing**

Run:

```bash
git fetch origin dev
git merge-base --is-ancestor origin/dev HEAD
```

Expected: exit 0. If remote `dev` moved, merge or rebase normally and repeat Task 4; never force-push.

- [ ] **Step 2: Commit the integration changes**

Run:

```bash
git add package.json scripts/release-workflow-contract.test.ts scripts/source-hygiene.test.ts src/lib/guide-state.ts docs/superpowers/specs/2026-08-03-plugin-dev-consolidation-design.md docs/superpowers/plans/2026-08-03-plugin-dev-consolidation.md
git commit -m "chore: consolidate plugin dev release"
```

Expected: one product integration commit; unrelated files remain unstaged.

- [ ] **Step 3: Push the reviewed commits directly to dev**

Run:

```bash
git push origin HEAD:dev
```

Expected: a fast-forward update succeeds.

- [ ] **Step 4: Prove local and remote point to the same commit**

Run:

```bash
git fetch origin dev
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/dev)"
git status --short --branch
```

Expected: the equality check exits 0 and the isolated worktree is clean.
