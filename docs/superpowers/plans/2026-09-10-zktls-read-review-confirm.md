# zkTLS Read Review Confirm Implementation Plan

> Execute with subagent-driven-development, TDD and independent review. Approved spec: `../specs/2026-09-10-zktls-read-review-confirm-design.md`.

**Goal:** Show locally captured data before explicit, single-use proof confirmation.

**Architecture:** Keep the existing signed connector and backend proof queue. Add a bounded current-tab response observer and an in-memory review gate before offscreen proving. The authenticated start-session response supplies the expected wallet; raw samples never enter the public page bridge or durable storage.

**Tech Stack:** WXT, TypeScript, React, Chrome debugger, existing capture/redaction primitives, NestJS GraphQL.

## Tasks

- [x] Backend trusted context: extend `ProductZkTlsSessionPackage` with nullable `reviewWalletAddress`. Resolve from the authenticated actor/session wallet used for final verification, not request variables. Update plugin operation allowlist fixtures and tests. No public signed-config payload changes or Verifier protocol changes.
- [x] Local review model: add `src/lib/zktls/review.ts` with an immutable preview snapshot and a single pending gate. Confirm only an exact review ID, once, before expiry. Cancel on task/session/tab/permission changes. No storage or page messages contain samples.
- [x] Current-tab observer: reuse capture binding, JSON decoding limits, redaction and pipeline semantics; return exact captured request plus corresponding response preview. Start listening without navigation or replay. Detach only the debugger owned by this observer. Fail visibly on unavailable response or conflicting request.
- [x] Runtime integration: add internal tab/review callbacks to `ZkTlsRunRequest`. Product V4 requests read the authorized tab, invoke review callback, recheck ticket/tab/permissions, and only then call `ensureOffscreen`/worker. Missing callback on a product review path must fail closed. Preserve legacy paths.
- [x] Controller/background: propagate trusted wallet and tab ID to runtime; invalidate ephemeral review on session mutation and authentication changes. Only popup-origin messages may read/confirm/cancel previews. Read-again cancels old consent and starts a new read, preserving completed conditions.
- [x] Popup: show source, time, account comparison, response/amount status and masked details; expose read-again and explicit confirm actions. Never label a preview as verified. Maintain existing Lighthouse compact visual style and independent per-condition queue state.
- [x] Verification: red/green tests for no proof before consent, wrong/unknown wallet blocked, single-use consent, stale snapshot invalidation, duplicate requests, response errors, private fields hidden, and multiple connectors. Run extension full suite/typecheck/Biome and backend scoped tests. Independent spec then quality review.
- [x] Package: build Beta with explicit endpoint/profile values, verify manifest and emitted endpoints. Do not push, deploy or publish a campaign unless requested. Report browser E2E separately from local checks.

## Runnable checks

Extension: `node node_modules/vitest/vitest.mjs run`; `node node_modules/typescript/bin/tsc --noEmit`; `node node_modules/@biomejs/biome/bin/biome check <changed-files>`.

Review tests must assert an untouched worker mock before confirmation, exact original request on one accepted confirmation, no subsequent start after cancellation/expiry, and separate observed/expected wallet fields. Browser tests must use the already authorized logged-in Nado tab; a restricted or logged-out page is not a successful preview.

## Verification record (2026-09-10)

- Extension: 68 files, 1506 tests passed; TypeScript and scoped Biome checks passed.
- Backend: 3 suites, 276 tests passed; TypeScript passed.
- Independent review found and fixed concurrent response replacement, duplicate reads, cancellation/attachment cleanup, redirected-body association, public-page confirmation bypass, owner/session expiry and preview dispatch expiry.
- Beta build and manifest endpoint read-back passed. Package: `/Users/kkruis/Desktop/project/builds/lhdao-extension-0.3.0-beta-read-review-20260910-1806.zip`; SHA256 `67fb669c757fd5c83cbafe6b5351fac635583e54841f77c64d18dcf394d50cf7`.
- No push, deployment, campaign publication or funds mutation. Matching backend schema/allowlist deployment is required before installing the package for Beta E2E. Nado browser E2E is pending; the pre-existing MPC accept_preprocessing timeout is outside this change and remains unverified.
