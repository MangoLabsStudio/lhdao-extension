# zkTLS Beta Local Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in, local-only zkTLS proof diagnostics to the unpacked Lighthouse Beta extension without exposing credentials or changing proof behavior.

**Architecture:** Extend the existing compile-time zkTLS profile with a Beta-only `debug` boolean. A small diagnostic module sanitizes structured values and HTTP transcripts before writing to the offscreen worker console. Existing V4 response validation accepts an optional stage observer so the worker can report framing, gzip, JSON, reveal, and failure stages without duplicating validation.

**Tech Stack:** TypeScript, WXT, WebExtension offscreen worker, Vitest, Biome

---

### Task 1: Compile-time Beta debug gate

**Files:**
- Modify: `scripts/zktls-profile.mjs`
- Modify: `scripts/zktls-profile.test.ts`
- Modify: `src/lib/zktls/profile.ts`

- [ ] **Step 1: Write failing profile tests**

Add cases that expect `debug: true` only when `WXT_ZKTLS_DEBUG` is exactly
`true`, zkTLS is enabled, and the API endpoint is
`https://service.lhdaobeta.top/graphql`. Add production, disabled, and missing
flag cases that expect `debug: false`.

```ts
expect(
  buildZkTlsProfile({
    env: { WXT_ZKTLS_ENABLED: 'true', WXT_ZKTLS_DEBUG: 'true' },
    endpointPolicy: betaEndpointPolicy,
    existingApiEndpoint: betaEndpointPolicy.apiEndpoint,
  }).debug,
).toBe(true)
```

- [ ] **Step 2: Run the profile test and verify RED**

Run:

```bash
./node_modules/.bin/vitest run scripts/zktls-profile.test.ts
```

Expected: FAIL because the profile has no `debug` property.

- [ ] **Step 3: Add the minimal profile field**

Return this field from `buildZkTlsProfile`:

```js
debug:
  env.WXT_ZKTLS_DEBUG === 'true' &&
  env.WXT_ZKTLS_ENABLED === 'true' &&
  endpointPolicy.apiEndpoint === 'https://service.lhdaobeta.top/graphql',
```

Add `debug: boolean` to `ZkTlsProfile` and set the source fallback to `false`.

- [ ] **Step 4: Run the profile test and verify GREEN**

Run the command from Step 2. Expected: all tests pass.

- [ ] **Step 5: Commit the gate**

```bash
git add scripts/zktls-profile.mjs scripts/zktls-profile.test.ts src/lib/zktls/profile.ts
git commit -m "feat(zktls): gate Beta proof diagnostics"
```

### Task 2: Credential-safe local diagnostic writer

**Files:**
- Create: `src/lib/zktls/debug.ts`
- Create: `src/lib/__tests__/zktls-debug.test.ts`

- [ ] **Step 1: Write failing sanitizer tests**

Cover disabled output, enabled stage order, nested credentials, request and
response bodies, HTTP `Cookie`, `Set-Cookie`, `Authorization`, plugin tokens,
captured secret headers, `Error` name/message/stack, accessors, byte arrays, and
a logger that throws.

```ts
expect(
  sanitizeZkTlsDebugValue({
    body: { events: [{ amount: '193.425611' }] },
    headers: { cookie: 'session=secret', 'x-nado-client-type': 'nado' },
  }),
).toEqual({
  body: { events: [{ amount: '193.425611' }] },
  headers: {
    cookie: { present: true, length: 14 },
    'x-nado-client-type': 'nado',
  },
})
```

- [ ] **Step 2: Run the diagnostic test and verify RED**

Run:

```bash
./node_modules/.bin/vitest run src/lib/__tests__/zktls-debug.test.ts
```

Expected: FAIL because `src/lib/zktls/debug.ts` does not exist.

- [ ] **Step 3: Implement the smallest sanitizer and writer**

Export:

```ts
export function sanitizeZkTlsDebugValue(value: unknown): unknown
export function redactZkTlsHttpTranscript(bytes: Uint8Array): string
export function createZkTlsDebugTrace(input: {
  enabled: boolean
  correlationId: string
  write?: (...values: unknown[]) => void
}): {
  stage(name: string, details?: unknown): void
  fail(name: string, error: unknown, secretValues?: readonly string[]): void
}
```

Use own property descriptors so accessors are reported as `[accessor]` without
execution. Redact sensitive keys case-insensitively. Parse only the HTTP header
block when redacting raw transcripts; preserve the body and public headers.
Wrap the writer call in `try/catch` so diagnostics cannot affect proof flow.

- [ ] **Step 4: Run the diagnostic test and verify GREEN**

Run the command from Step 2. Expected: all tests pass.

- [ ] **Step 5: Commit the writer**

```bash
git add src/lib/zktls/debug.ts src/lib/__tests__/zktls-debug.test.ts
git commit -m "feat(zktls): add credential-safe proof traces"
```

### Task 3: Observe the existing V4 response stages

**Files:**
- Modify: `src/lib/zktls/v4-disclosure.ts`
- Modify: `src/lib/__tests__/zktls-v4-disclosure.test.ts`

- [ ] **Step 1: Write failing stage observer tests**

Pass an observer to `v4ResponseDisclosureRanges` and assert that a valid
chunked gzip response reports these stages in order:

```ts
expect(stages).toEqual([
  'response-framing-decoded',
  'gzip-decoded',
  'strict-json-checked',
])
```

Add a corrupt gzip case that reports framing but never reports JSON success.
Assert that the observer receives byte counts and decoded public JSON, and
that an observer exception does not fail validation.

- [ ] **Step 2: Run the focused disclosure test and verify RED**

Run:

```bash
./node_modules/.bin/vitest run src/lib/__tests__/zktls-v4-disclosure.test.ts
```

Expected: FAIL because the validator does not accept an observer.

- [ ] **Step 3: Add an optional non-authoritative observer**

Add this optional third argument:

```ts
type V4ResponseDiagnostic = (
  stage: 'response-framing-decoded' | 'gzip-decoded' | 'strict-json-checked',
  details: unknown,
) => void
```

Invoke it after each existing successful validation step. Guard every callback
with `try/catch`. Do not change parsing, caps, zeroing, return ranges, or errors.

- [ ] **Step 4: Run the disclosure test and verify GREEN**

Run the command from Step 2. Expected: all tests pass.

- [ ] **Step 5: Commit the observer**

```bash
git add src/lib/zktls/v4-disclosure.ts src/lib/__tests__/zktls-v4-disclosure.test.ts
git commit -m "feat(zktls): observe V4 response validation stages"
```

### Task 4: Trace the offscreen proof lifecycle

**Files:**
- Modify: `src/entrypoints/zktls-offscreen/worker.ts`
- Modify: `src/lib/__tests__/zktls.test.ts`

- [ ] **Step 1: Write failing worker-flow tests**

Use the existing exported proof helpers and injected fakes to assert the trace
contains captured request, config check, registration, proxy request, raw
transcripts, V4 response stages, reveal submission, completion, and failure.
Assert public request and response JSON remain visible while cookie,
authorization, set-cookie, and captured secret values do not appear anywhere
in serialized log arguments.

- [ ] **Step 2: Run the focused worker tests and verify RED**

Run:

```bash
./node_modules/.bin/vitest run src/lib/__tests__/zktls.test.ts
```

Expected: new trace assertions fail because the worker emits no diagnostics.

- [ ] **Step 3: Add trace calls around existing operations**

Create one trace per message with `ZKTLS_PROFILE.debug` and the existing
correlation ID. Record only completed stages. Pass the response observer from
Task 3 into `transcriptRevealRanges`. In the existing error path, log the last
stage, sanitized exception, and sanitized captured request before returning the
unchanged public `PROVER_FAILED` result.

Do not change the proof request, signed config, captured request, disclosure
ranges, completion wait, zeroing, or public result.

- [ ] **Step 4: Run worker and privacy tests and verify GREEN**

Run:

```bash
./node_modules/.bin/vitest run \
  src/lib/__tests__/zktls.test.ts \
  src/lib/__tests__/product-experience-privacy.test.ts \
  src/entrypoints/__tests__/zktls-offscreen-main.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit the lifecycle trace**

```bash
git add src/entrypoints/zktls-offscreen/worker.ts src/lib/__tests__/zktls.test.ts
git commit -m "feat(zktls): trace Beta proof failures locally"
```

### Task 5: Verify and build the diagnostic Beta package

**Files:**
- Verify only: all changed files
- Build output: `.output/chrome-mv3/`

- [ ] **Step 1: Run focused and full tests**

```bash
./node_modules/.bin/vitest run \
  scripts/zktls-profile.test.ts \
  src/lib/__tests__/zktls-debug.test.ts \
  src/lib/__tests__/zktls-v4-disclosure.test.ts \
  src/lib/__tests__/zktls.test.ts \
  src/lib/__tests__/product-experience-privacy.test.ts \
  src/entrypoints/__tests__/zktls-offscreen-main.test.ts
pnpm test
```

Expected: all tests pass.

- [ ] **Step 2: Run static gates**

```bash
pnpm run typecheck
./node_modules/.bin/biome check \
  scripts/zktls-profile.mjs \
  scripts/zktls-profile.test.ts \
  src/lib/zktls/profile.ts \
  src/lib/zktls/debug.ts \
  src/lib/zktls/v4-disclosure.ts \
  src/entrypoints/zktls-offscreen/worker.ts \
  src/lib/__tests__/zktls-debug.test.ts \
  src/lib/__tests__/zktls-v4-disclosure.test.ts \
  src/lib/__tests__/zktls.test.ts
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 3: Build the unpacked Beta diagnostic extension**

Use the same Beta zkTLS profile values as the current verified Beta build and
add only `WXT_ZKTLS_DEBUG=true`:

```bash
WXT_API_ENDPOINT=https://service.lhdaobeta.top/graphql \
WXT_WEB_ENDPOINT=https://app.lhdaobeta.top \
WXT_ZKTLS_ENABLED=true \
WXT_ZKTLS_DEBUG=true \
WXT_ZKTLS_API_ENDPOINT="$BETA_ZKTLS_API_ENDPOINT" \
WXT_ZKTLS_VERIFIER_ENDPOINT="$BETA_ZKTLS_VERIFIER_ENDPOINT" \
WXT_ZKTLS_VERIFIER_PROFILE_ID="$BETA_ZKTLS_VERIFIER_PROFILE_ID" \
WXT_ZKTLS_PUBLIC_KEYS="$BETA_ZKTLS_PUBLIC_KEYS" \
pnpm run build
```

Expected: `.output/chrome-mv3/manifest.json` targets Lighthouse Beta and the
compiled worker contains the diagnostic prefix. Do not print secret profile
values.

- [ ] **Step 4: Verify the production build excludes active diagnostics**

Build without `WXT_ZKTLS_DEBUG`. Search the generated worker and confirm the
diagnostic writer cannot run. Confirm production endpoint and manifest checks
still pass.

- [ ] **Step 5: Commit any test-only build contract updates**

If no tracked file changes remain, skip this commit. Otherwise:

```bash
git add scripts src
git commit -m "test(zktls): verify Beta diagnostic builds"
```

- [ ] **Step 6: Hand off the unpacked folder**

Report the absolute `.output/chrome-mv3` path. Ask the user to reload that
folder, open the offscreen worker DevTools console, and run one Nado proof. Do
not push or deploy unless the user asks separately.
