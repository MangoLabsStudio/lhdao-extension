# zkTLS Ticket Clock Skew Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Beta zkTLS tickets tolerate at most five seconds of positive issuer clock skew while preserving strict expiry.

**Architecture:** Change the shared `assertTicketAvailable` boundary so signed-config loading, runtime validation, and the offscreen worker inherit one rule. Keep ticket signatures, lifetime, expiry, replay protection, backend behavior, and Verifier behavior unchanged.

**Tech Stack:** TypeScript, Vitest, Web Crypto, WXT Chrome MV3

---

### Task 1: Lock and fix the shared ticket-time boundary

**Files:**
- Modify: `src/lib/zktls/signed-config.ts:223-231`
- Test: `src/lib/__tests__/zktls.test.ts:1387-1401`

- [ ] **Step 1: Write the failing boundary test**

Add a test that uses the existing signed `ticket` fixture:

```ts
test('allows five seconds of issuer clock skew but keeps expiry strict', () => {
  expect(() =>
    assertTicketAvailable(ticket, '2026-08-14T23:59:55.000Z'),
  ).not.toThrow()
  expect(() =>
    assertTicketAvailable(ticket, '2026-08-14T23:59:54.999Z'),
  ).toThrow('ticket is unavailable')
  expect(() =>
    assertTicketAvailable(ticket, ticket.expires_at),
  ).toThrow('ticket is unavailable')
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm exec vitest run src/lib/__tests__/zktls.test.ts
```

Expected: the five-second acceptance assertion fails because the current code rejects every time before `issued_at`.

- [ ] **Step 3: Implement the shared five-second allowance**

Add one local constant and change only the lower-bound comparison:

```ts
const TICKET_ISSUED_AT_CLOCK_SKEW_MS = 5_000

export function assertTicketAvailable(ticket: Ticket, now: string): void {
  const current = isoTime(now, 'now')
  if (
    current + TICKET_ISSUED_AT_CLOCK_SKEW_MS <
      Date.parse(ticket.issued_at) ||
    current >= Date.parse(ticket.expires_at)
  )
    fail('ticket is unavailable.')
}
```

- [ ] **Step 4: Run focused and full verification**

Run:

```bash
pnpm exec vitest run src/lib/__tests__/zktls.test.ts
pnpm test
pnpm run typecheck
pnpm exec biome check src/lib/zktls/signed-config.ts src/lib/__tests__/zktls.test.ts
pnpm run build
git diff --check
```

Expected: all commands exit zero. The Chrome MV3 build may print only the repository's existing Vite/WXT deprecation warnings.

- [ ] **Step 5: Commit the code and test**

```bash
git add src/lib/zktls/signed-config.ts src/lib/__tests__/zktls.test.ts
git commit -m "fix(extension): tolerate zkTLS issuer clock skew"
```

### Task 2: Rebuild and rerun the Beta browser proof

**Files:**
- Generated: `.output/chrome-mv3/`

- [ ] **Step 1: Rebuild with the verified Beta profile**

Use the existing Beta GraphQL, web, signed-config, Verifier `/session`, profile ID, and signing public JWK values. Set `WXT_ZKTLS_ENABLED=true`, run the Chrome production build, and confirm the compiled worker contains the enabled profile and the V4 Verifier WebSocket endpoint.

- [ ] **Step 2: Reload the unpacked extension**

Reload `.output/chrome-mv3` from `chrome://extensions`, refresh the test page, and resend the buyer's Product Check task if the content script was replaced.

- [ ] **Step 3: Verify the live component boundaries**

Click `重试证明` once. Confirm, in order:

1. Backend creates one fresh account-binding session.
2. Chrome opens `/session` on `lighthouse-zktls-verifier-v4`.
3. Verifier registers the signed V4 ticket.
4. The backend session leaves `pending`, or logs a later proof-stage error that identifies the next boundary.

Do not claim the complete Product Check passed unless the popup and backend both show the completed rule.
