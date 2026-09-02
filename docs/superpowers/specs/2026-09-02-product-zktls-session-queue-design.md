# Product zkTLS Session Queue MVP Design

## Problem

The Beta diagnostic reaches `evidence-accepted` but never reaches
`proof-session-requested`. The page watcher, rule evaluation, evidence bridge,
and background acceptance have succeeded. The controller-wide `zkTlsFlight`
can still belong to an older session or an older submitted-rule poll. In that
case, `drainZkTlsQueue()` records no waiting state and refuses to start the
current session's queue.

## Goal

Make the queue session-aware. A stale session must not silently block the
current session. Within one session, proofs remain serial.

After `evidence-accepted`, diagnostics must show one of these next states:

- `proof-session-requested`: the controller is requesting a signed proof
  session.
- `proof-queue-waiting`: the current session is waiting for its existing queue
  flight to yield.
- `proof-session-failed`: the signed proof-session request failed.

## Non-goals

- Do not run TLSNotary proofs in parallel.
- Do not change Nado rules, request matching, signed connectors, Backend,
  Verifier, or the proof protocol.
- Do not cancel an active TLSNotary operation inside the offscreen worker. If
  the runtime is genuinely busy, return its existing safe failure instead of
  hiding the condition in the controller queue.
- Do not add a general job scheduler, retry framework, or new dependency.

## Design

### Session-owned queue flight

Store the active controller flight as `{ sessionId, promise, drainRequested }`
instead of one unscoped Promise and one global drain flag.
`drainZkTlsQueue(sessionId)` reuses a flight only when its `sessionId` matches.

When a different session submits evidence, the controller starts a new flight.
The old flight may settle later, but it cannot clear the new flight because the
cleanup step compares flight identity.

### Session-scoped mutations

Pass the owning `sessionId` into `runZkTlsQueue`. Before each loop, require the
stored session to have that exact ID. Existing `mutateZkTlsSession(sessionId, …)`
checks protect every later write. A stale flight exits without changing the
current session.

### Yield to new queued work

Within the same session, new evidence marks that session's flight for another
pass and records `proof-queue-waiting`. A submitted-rule polling loop checks
the flight flag at its next safe boundary and yields. The next pass selects
queued or interrupted proving work before it resumes an older submitted poll.

This keeps one proof active at a time while preventing a bounded progress poll
from hiding new work for its full retry budget.

### Error handling

The queue never invents a success state. Backend session errors continue to
produce `proof-session-failed`. Runtime busy, expiry, capture, and prover errors
continue through the existing safe diagnostic path. Credential-like values
remain redacted.

## Tests

Add focused controller regressions that prove:

1. An unresolved flight from session A does not prevent session B from reaching
   `proof-session-requested`.
2. A stale flight cannot mutate session B after it settles.
3. New queued work in the same session records `proof-queue-waiting` and yields
   an older submitted poll.
4. Two rules in one session still call `proveZkTls` serially.
5. Existing retry, progress, diagnostics-disabled, and privacy tests remain
   green.

Run the focused controller tests, the full extension suite, type checking,
Biome on touched files, and the Beta Chrome build.
