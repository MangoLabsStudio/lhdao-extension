# Discovery Credential Redaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show local business identifiers while masking credentials in discovery samples.

**Architecture:** The extension filters raw samples before they cross into the page. The frontend mirrors the filter to reject unsafe extension responses. Both sides use the same key classification and preserve existing unknown-value safeguards.

**Tech Stack:** TypeScript, Vitest, WXT, Next.js

---

### Task 1: Extension credential filter

**Files:**
- Modify: `src/lib/zktls/discovery/redaction.ts`
- Test: `src/lib/__tests__/zktls-discovery.test.ts`

- [ ] **Step 1: Write the failing tests**

Add expectations that `wallet`, `walletAddress`, `accountId`, and `id` values
remain visible, while cookie, authorization, token, API key, password, secret,
signature, private key, HMAC, session, CSRF, and credential values equal
`[REDACTED]`. Include an echoed token under an ordinary key.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm vitest run src/lib/__tests__/zktls-discovery.test.ts`

Expected: FAIL because identifiers still equal `[REDACTED]`.

- [ ] **Step 3: Implement the minimal filter change**

Narrow `sensitiveKey` to credential names and add a small identifier-key check
before generic dynamic-value masking. Check known secret values first.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm vitest run src/lib/__tests__/zktls-discovery.test.ts`

Expected: PASS.

### Task 2: Frontend trust-boundary mirror

**Files:**
- Modify: `src/features/product-report/extension/discovery-redaction.ts`
- Test: `src/features/product-report/extension/discovery-contract.spec.ts`

- [ ] **Step 1: Write the failing contract tests**

Add a response containing visible wallet and account identifiers and require the
contract to accept it. Retain rejection tests for raw credential values.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node_modules/.bin/vitest run src/features/product-report/extension/discovery-contract.spec.ts`

Expected: FAIL because the frontend still classifies identifiers as secrets.

- [ ] **Step 3: Mirror the extension filter**

Apply the same credential and identifier classification in
`discovery-redaction.ts`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node_modules/.bin/vitest run src/features/product-report/extension/discovery-contract.spec.ts`

Expected: PASS.

### Task 3: Regression verification

**Files:**
- Verify only

- [ ] **Step 1: Run extension tests, typecheck, and Beta dev build**

Run the repository's full Vitest suite, TypeScript check, and Beta dev build.

- [ ] **Step 2: Run frontend focused suites and typecheck**

Run the discovery model, contract, and workbench suites, then TypeScript.

- [ ] **Step 3: Inspect diffs and confirm scope**

Confirm that backend and verifier remain unchanged and that no discovery sample
is persisted or uploaded.
