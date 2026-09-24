# zkTLS Proof Failure Code Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve and display a safe zkTLS proof failure code so Beta browser testing can identify the failed stage without exposing request data or secrets.

**Architecture:** Add a closed failure-code type and sanitizer at the Product Experience controller boundary. Store only that safe code in the temporary extension session, project it to the popup-only controller state, and render it on retryable proof failures. Keep the public page bridge unchanged because its projector already selects an exact field set.

**Tech Stack:** TypeScript, React 19, Vitest, WXT, Chrome MV3

---

### Task 1: Preserve safe failure codes

**Files:**
- Modify: `src/lib/product-experience-controller.ts`
- Test: `src/lib/__tests__/product-experience-controller.test.ts`

- [ ] **Step 1: Write the failing controller tests**

Add tests that return `PROVER_TIMEOUT` and an unknown runtime code from
`proveZkTls`. Assert the retryable controller state contains
`zkTlsFailureCode: 'PROVER_TIMEOUT'` or `ZKTLS_UNKNOWN_FAILURE`. Trigger a retry
that returns `submitted` and assert the stored session and public controller
state clear the code.

- [ ] **Step 2: Run the controller tests and verify RED**

Run:

```bash
pnpm exec vitest run src/lib/__tests__/product-experience-controller.test.ts
```

Expected: the new assertions fail because `zkTlsFailureCode` does not exist.

- [ ] **Step 3: Add the minimal controller implementation**

Define the closed type:

```ts
export type ProductZkTlsFailureCode =
  | 'ZKTLS_CAPTURE_FAILED'
  | 'ZKTLS_SETUP_FAILED'
  | 'PROVER_BUSY'
  | 'PROVER_FAILED'
  | 'PROVER_TIMEOUT'
  | 'REQUEST_NOT_CAPTURED'
  | 'UNSUPPORTED_CONNECTOR'
  | 'ZKTLS_BUSY'
  | 'ZKTLS_UNKNOWN_FAILURE'
```

Add `zkTlsFailureCode` to the temporary session and popup controller state.
Sanitize runtime strings through a `Set<ProductZkTlsFailureCode>`, store the
allowlisted value on `VERIFICATION_FAILED`, and use
`ZKTLS_UNKNOWN_FAILURE` otherwise. Clear the field when work starts, submits,
finishes, expires, or enters authorization handling. Do not add the field to
`asPublicSource`.

- [ ] **Step 4: Run the controller tests and verify GREEN**

Run the command from Step 2. Expected: all controller tests pass.

### Task 2: Display the safe code in Product Check

**Files:**
- Modify: `src/components/product-experience/ProductExperienceCard.tsx`
- Test: `src/entrypoints/popup/App.test.tsx`

- [ ] **Step 1: Write the failing popup tests**

Render a retryable `VERIFICATION_FAILED` state with
`zkTlsFailureCode: 'PROVER_TIMEOUT'`. Assert the card contains
`错误码：PROVER_TIMEOUT`. Render an authorization state and a retryable failure
without a code; assert neither exposes a diagnostic line.

- [ ] **Step 2: Run the popup tests and verify RED**

Run:

```bash
pnpm exec vitest run src/entrypoints/popup/App.test.tsx
```

Expected: the diagnostic text assertion fails.

- [ ] **Step 3: Add the minimal card rendering**

Under the retryable failure detail, render the safe code only when
`state.error === 'VERIFICATION_FAILED'` and `state.zkTlsFailureCode` exists:

```tsx
<p data-testid="zktls-failure-code">错误码：{state.zkTlsFailureCode}</p>
```

Use the card's existing muted monospace styles. Do not add raw-error details or
an expandable section.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run both test files. Expected: all tests pass.

### Task 3: Verify and build Beta

**Files:**
- No production files beyond Tasks 1 and 2.

- [ ] **Step 1: Run complete gates**

```bash
pnpm test
pnpm run typecheck
pnpm exec biome check src/lib/product-experience-controller.ts src/lib/__tests__/product-experience-controller.test.ts src/components/product-experience/ProductExperienceCard.tsx src/entrypoints/popup/App.test.tsx
git diff --check
```

Expected: all commands exit zero.

- [ ] **Step 2: Build the explicit Beta extension**

Run the repository's existing Beta build command/environment used by the
current unpacked extension. Verify the built manifest contains Beta Lighthouse
hosts and excludes the production GraphQL endpoint.

- [ ] **Step 3: Commit the implementation**

```bash
git add src/lib/product-experience-controller.ts src/lib/__tests__/product-experience-controller.test.ts src/components/product-experience/ProductExperienceCard.tsx src/entrypoints/popup/App.test.tsx docs/superpowers/plans/2026-08-30-zktls-proof-failure-code.md
git commit -m "fix(zktls): show safe proof failure codes"
```
